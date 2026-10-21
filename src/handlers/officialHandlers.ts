import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import {
	cleanRecordPayload,
	formatSuiteQLToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import {
	assertNoMcpError,
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
} from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import type { CallOfficialArgs } from "./toolSchemas.js";
import { textResult } from "./types.js";

const logger = createLogger("official-handler");

interface OfficialToolInfo {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: {
		type?: string;
		properties?: Record<
			string,
			{
				type?: string;
				description?: string;
				items?: { type?: string };
			}
		>;
		required?: string[];
	};
	annotations?: {
		title?: string;
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
	};
	_meta?: {
		ui?: {
			resourceUri?: string;
		};
	};
}

/** Set of known mutation / write tools in official SuiteApp */
const MUTATION_TOOLS = new Set(["ns_createrecord", "ns_updaterecord"]);

/**
 * Single authoritative handler for netsuite_call_official gateway.
 *
 * Supports 3 actions:
 * - 'list': Discover all official tools available in the connected NetSuite account.
 * - 'schema': Inspect detailed parameter schema for a specific official tool.
 * - 'call': Execute an official NetSuite native tool with production write protection.
 */
export async function handleCallOfficial(
	args: CallOfficialArgs,
	mcpTools: NetSuiteMCPTools,
	_accountId?: string | undefined,
	isSandbox = true,
): Promise<CallToolResult> {
	const action = args.action || "call";
	const toolName = args.toolName?.trim();

	// -------------------------------------------------------------------------
	// Action: 'list' (Catalog Discovery)
	// -------------------------------------------------------------------------
	if (action === "list" || (!toolName && action !== "schema")) {
		try {
			const rawTools = await mcpTools.fetchTools();
			const tools = (rawTools as OfficialToolInfo[]) || [];

			if (tools.length === 0) {
				return textResult(
					"⚠️ No official tools returned from NetSuite MCP API.",
				);
			}

			const standardTools: OfficialToolInfo[] = [];
			const appTools: OfficialToolInfo[] = [];

			for (const tool of tools) {
				if (tool._meta?.ui) {
					appTools.push(tool);
				} else {
					standardTools.push(tool);
				}
			}

			let md = `## 🏛️ Oracle NetSuite Official Native Tools (${tools.length} Tools Available)\n\n`;
			md +=
				"> 💡 **Usage Rule**: Always prioritize custom `netsuite_*` tools. Use official tools only when custom tools lack the required capability (e.g. `ns_runReport`, `ns_runSavedSearch`) or encounter an unresolvable error.\n\n";

			md += `### 📊 Native NetSuite API Tools (${standardTools.length})\n\n`;
			md += "| Tool Name | Title | Type | Description | Parameters |\n";
			md += "|:---|:---|:---:|:---|:---|\n";

			for (const t of standardTools) {
				const isReadOnly = t.annotations?.readOnlyHint !== false;
				const isMutation =
					MUTATION_TOOLS.has(t.name.toLowerCase()) ||
					t.annotations?.destructiveHint === true ||
					!isReadOnly;
				const typeBadge = isMutation ? "⚠️ Mutate (Sandbox)" : "✅ Read-Only";
				const title = t.annotations?.title || t.title || t.name;
				const desc = (t.description?.split("\n")[0] ?? "").slice(0, 120);
				const params = Object.keys(t.inputSchema?.properties || {}).join(", ");
				md += `| \`${t.name}\` | ${title} | ${typeBadge} | ${desc} | \`${params || "none"}\` |\n`;
			}

			if (appTools.length > 0) {
				md += `\n### 🖥️ Interactive MCP Apps (${appTools.length})\n\n`;
				md +=
					"> *Note: Interactive MCP Apps render webview HTML in supported clients.*\n\n";
				md += "| App Tool Name | Title | Description |\n";
				md += "|:---|:---|:---|\n";
				for (const t of appTools) {
					const title = t.annotations?.title || t.title || t.name;
					const desc = (t.description?.split("\n")[0] ?? "").slice(0, 140);
					md += `| \`${t.name}\` | ${title} | ${desc} |\n`;
				}
			}

			return textResult(md.trim());
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(errorMsg)) {
				return textResult(
					`❌ [Permission Denied] ${errorMsg}\n${PERMISSION_HARD_STOP_ADVICE}`,
					true,
				);
			}
			return textResult(
				`❌ [Official Tools Discovery Failed] ${errorMsg}`,
				true,
			);
		}
	}

	// -------------------------------------------------------------------------
	// Action: 'schema' (Parameter Definition Lookup)
	// -------------------------------------------------------------------------
	if (action === "schema") {
		if (!toolName) {
			return textResult(
				"❌ 'toolName' parameter is required when action is 'schema' (e.g. toolName: 'ns_runReport').",
				true,
			);
		}

		try {
			const rawTools = await mcpTools.fetchTools();
			const tools = (rawTools as OfficialToolInfo[]) || [];
			const cleanName = toolName.toLowerCase();
			const target = tools.find((t) => t.name.toLowerCase() === cleanName);

			if (!target) {
				const available = tools.map((t) => `'${t.name}'`).join(", ");
				return textResult(
					`❌ Official tool '${toolName}' not found. Available official tools: ${available}`,
					true,
				);
			}

			const title = target.annotations?.title || target.title || target.name;
			const isReadOnly = target.annotations?.readOnlyHint !== false;
			const isDestructive = target.annotations?.destructiveHint === true;

			let schemaMd = `## 📋 Official Tool Schema: \`${target.name}\` (${title})\n\n`;
			schemaMd += `**Description**: ${target.description || "No description provided."}\n\n`;
			schemaMd += `**Permissions & Attributes**: Read-Only: \`${isReadOnly}\` | Destructive: \`${isDestructive}\`\n\n`;

			const props = target.inputSchema?.properties || {};
			const requiredKeys = new Set(target.inputSchema?.required || []);

			if (Object.keys(props).length === 0) {
				schemaMd += "*This tool accepts no input parameters.*\n";
			} else {
				schemaMd += "### 📥 Parameters\n\n";
				schemaMd += "| Parameter | Type | Required | Description |\n";
				schemaMd += "|:---|:---:|:---:|:---|\n";

				for (const [key, prop] of Object.entries(props)) {
					const req = requiredKeys.has(key) ? "✅ Yes" : "No";
					const type = prop.type || "string";
					const desc = (prop.description || "").replace(/\|/g, "\\|");
					schemaMd += `| \`${key}\` | \`${type}\` | ${req} | ${desc} |\n`;
				}
			}

			schemaMd += `\n### 💡 Example Invocation\n\`\`\`json\n{\n  "action": "call",\n  "toolName": "${target.name}",\n  "parameters": {\n`;
			const propEntries = Object.entries(props);
			const firstEntry = propEntries[0];
			if (firstEntry) {
				schemaMd += `    "${firstEntry[0]}": "..."\n`;
			}
			schemaMd += "  }\n}\n```\n";

			return textResult(schemaMd.trim());
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			return textResult(
				`❌ [Schema Lookup Failed] Failed to inspect schema for '${toolName}': ${errorMsg}`,
				true,
			);
		}
	}

	// -------------------------------------------------------------------------
	// Action: 'call' (Execute Official Tool)
	// -------------------------------------------------------------------------
	if (!toolName) {
		return textResult(
			"❌ 'toolName' parameter is required when action is 'call' (e.g. toolName: 'ns_runSavedSearch').",
			true,
		);
	}

	// Dual-Gate Production Write Protection
	const isMutation = MUTATION_TOOLS.has(toolName.toLowerCase());
	if (isMutation && !isSandbox) {
		logger.warn(
			`[Production Safety Guard] Blocked call to official mutation tool '${toolName}' in Production`,
		);
		return textResult(
			`❌ [Production Safety Violation] Executing official mutation tool '${toolName}' is strictly prohibited in Production environments. Write operations are restricted exclusively to Sandbox environments.`,
			true,
		);
	}

	try {
		logger.info(`Executing official tool via gateway: ${toolName}`);
		const rawResult = await mcpTools.executeTool(
			toolName,
			args.parameters || {},
		);
		assertNoMcpError(rawResult);

		// Handle compact_json output format
		if (args.format === "compact_json") {
			let contentToFormat: unknown = rawResult;
			if (
				rawResult &&
				typeof rawResult === "object" &&
				"content" in (rawResult as Record<string, unknown>)
			) {
				const c = (rawResult as { content?: Array<{ text?: string }> }).content;
				if (Array.isArray(c) && c[0]?.text) {
					try {
						contentToFormat = JSON.parse(c[0].text);
					} catch {
						contentToFormat = c[0].text;
					}
				}
			}
			return textResult(JSON.stringify(cleanRecordPayload(contentToFormat)));
		}

		// Handle markdown output format (default)
		// If result contains text JSON array (like from ns_runSavedSearch or ns_listAllReports), format to table
		let parsedData: unknown = rawResult;
		if (
			rawResult &&
			typeof rawResult === "object" &&
			"content" in (rawResult as Record<string, unknown>)
		) {
			const c = (rawResult as { content?: Array<{ text?: string }> }).content;
			if (Array.isArray(c) && c[0]?.text) {
				try {
					parsedData = JSON.parse(c[0].text);
				} catch {
					parsedData = c[0].text;
				}
			}
		}

		if (
			Array.isArray(parsedData) ||
			(parsedData && typeof parsedData === "object")
		) {
			const tableMd = formatSuiteQLToCompactMarkdown(parsedData);
			if (tableMd && tableMd !== "No rows returned.") {
				return textResult(
					`## 🏛️ Official Tool: \`${toolName}\`\n\n${tableMd}`.trim(),
				);
			}
		}

		// Fallback to text representation
		const textOutput =
			typeof parsedData === "string"
				? parsedData
				: JSON.stringify(cleanRecordPayload(parsedData), null, 2);

		return textResult(
			`## 🏛️ Official Tool: \`${toolName}\`\n\n${textOutput}`.trim(),
		);
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		logger.warn(`Official tool '${toolName}' execution failed: ${errorMsg}`);

		if (isPermissionError(errorMsg)) {
			return textResult(
				`❌ [Official Tool Permission Denied] ${errorMsg}\n${PERMISSION_HARD_STOP_ADVICE}`,
				true,
			);
		}

		return textResult(
			`❌ [Official Tool Execution Failed] Tool '${toolName}' threw an error: ${errorMsg}`,
			true,
		);
	}
}
