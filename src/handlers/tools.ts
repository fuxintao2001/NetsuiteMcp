import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import {
	ProtocolError,
	ProtocolErrorCode,
	type Server,
} from "@modelcontextprotocol/server";
import path from "node:path";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";
import { processParallelBatch } from "../utils/batchProcessor.js";
import { cacheService } from "../utils/cache.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import { buildEnvSuffix, isSandboxAccount } from "../utils/environment.js";
import {
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
} from "../utils/errors.js";
import { asyncJsonParse } from "../utils/json.js";
import {
	formatTableCatalogMarkdown,
	type JsonSchemaProperty,
	mapFieldType,
	sanitizeIntegerId,
	searchSuiteQLCatalog,
	unwrapMcpContent,
} from "../utils/metadata.js";
import { generateNetSuiteUrl } from "../utils/netsuiteUrls.js";
import { recordsReferenceService } from "../utils/recordsReference.js";
import { suitecloudRunnerService } from "../utils/suitecloudRunner.js";
import { formatSuiteQLErrorResponse } from "../utils/suiteqlGuard.js";

import { suiteqlTemplateService } from "../utils/suiteqlTemplates.js";
import {
	AUTH_TOOL,
	BatchExecuteArgsSchema,
	GetQueryTemplateArgsSchema,
	GetRecordDefinitionArgsSchema,
	GetRecordLinkArgsSchema,
	GetScriptLogsArgsSchema,
	GetSystemNotesArgsSchema,
	InspectRecordArgsSchema,
	LOCAL_TOOLS,
	LOGOUT_TOOL,
	METADATA_RULES_SUFFIX,
	STATUS_TOOL,
	SUITEQL_RULES_SUFFIX,
	SuitecloudUploadArgsSchema,
} from "./toolSchemas.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Create a text content response matching the MCP SDK CallToolResult shape. */
export function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

type ToolResponse = CallToolResult;

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface ToolHandlerDeps {
	server: Server;
	oauthManager: OAuthManager;
	mcpTools: NetSuiteMCPTools;
	projectRoot: string;
	handleAuthentication: (
		args: Record<string, unknown>,
	) => Promise<ToolResponse>;
	handleLogout: () => Promise<ToolResponse>;
	handleCacheRefresh: (args: Record<string, unknown>) => Promise<ToolResponse>;
	resolveCustomRecordRectype: (
		type: string,
	) => number | null | Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Local tool handlers
// ---------------------------------------------------------------------------

async function handleGetRecordLink(
	args: Record<string, unknown>,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<ToolResponse> {
	const parsed = GetRecordLinkArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const {
		recordId,
		recordType,
		accountId: targetAccId,
		rectype: explicitRectype,
	} = parsed.data;

	const currentAccountId = await oauthManager.getAccountId();
	const targetAccountId = targetAccId || currentAccountId;

	if (!targetAccountId) {
		return textResult("❌ Account ID not found.", true);
	}

	let rectype = explicitRectype;
	const isCustomRecord = recordType?.toLowerCase().startsWith("customrecord");

	if (!rectype && recordType && isCustomRecord) {
		rectype = (await resolveRectype(recordType)) ?? undefined;
	}

	// Detect if recordId might be a document number (tranid) instead of internal numeric ID
	const isNumericId = /^\d+$/.test(recordId.trim());
	let idWarning = "";
	if (!isNumericId) {
		idWarning = `\n\n⚠️ **Warning:** The provided recordId ('${recordId}') appears to be a document number (tranid) rather than a numeric internal ID. NetSuite UI links require the numeric internal ID (e.g. '123456'). If this link fails to open the record, query its internal ID first via SuiteQL (e.g. \`SELECT id FROM transaction WHERE tranid = '${recordId}'\`).`;
	}

	const url = generateNetSuiteUrl(
		targetAccountId,
		recordType,
		recordId,
		rectype,
	);

	if (!url) {
		if (isCustomRecord && !rectype) {
			return textResult(
				`❌ Failed to generate NetSuite UI Link for custom record '${recordType}': NetSuite custom record URLs strictly require the numeric custom record type ID (rectype). Automatic resolution via SuiteQL failed (ensure your NetSuite integration role has 'Custom Record Types' permission under Permissions > Setup, or provide the numeric 'rectype' parameter explicitly).`,
				true,
			);
		}
		return textResult(
			"❌ Failed to generate NetSuite UI Link: invalid or missing parameters.",
			true,
		);
	}

	let responseText = `🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`;
	if (idWarning) {
		responseText += idWarning;
	}
	return textResult(responseText);
}

async function handleGetScriptLogs(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = GetScriptLogsArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(`❌ ${parsed.error.issues[0]?.message}`, true);
	}
	const {
		scriptId,
		type: logType,
		dateFrom,
		dateTo,
		title,
		detail,
		deploymentId,
		limit,
	} = parsed.data;

	// Build SELECT with Script info joined for complete visibility
	let sql = `SELECT sn.date, sn.type, sn.title, sn.detail, s.scriptid AS scriptScriptId, s.name AS scriptName FROM ScriptNote AS sn LEFT JOIN Script AS s ON sn.scripttype = s.id`;

	// Build WHERE clauses
	const conditions: string[] = [];

	if (scriptId) {
		const escapedScriptId = scriptId.replace(/'/g, "''");
		conditions.push(`s.scriptid = '${escapedScriptId}'`);
	}
	if (deploymentId) {
		const escapedDeploymentId = deploymentId.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype IN (SELECT sd.script FROM ScriptDeployment sd WHERE sd.scriptid = '${escapedDeploymentId}')`,
		);
	}
	if (logType) {
		conditions.push(`sn.type = '${logType.toUpperCase()}'`);
	}
	if (dateFrom) {
		conditions.push(`sn.date >= TO_DATE('${dateFrom}', 'YYYY-MM-DD')`);
	}
	if (dateTo) {
		// Include the full day of dateTo (up to 23:59:59) by checking < dateTo + 1
		conditions.push(`sn.date < TO_DATE('${dateTo}', 'YYYY-MM-DD') + 1`);
	}
	if (title) {
		const escapedTitle = title.replace(/'/g, "''");
		conditions.push(`UPPER(sn.title) LIKE UPPER('%${escapedTitle}%')`);
	}
	if (detail) {
		const escapedDetail = detail.replace(/'/g, "''");
		conditions.push(`UPPER(sn.detail) LIKE UPPER('%${escapedDetail}%')`);
	}

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	sql += ` ORDER BY sn.date DESC FETCH FIRST ${limit} ROWS ONLY`;

	try {
		const result = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: sql,
		});

		// Check if SuiteQL returned a NetSuite-level error JSON payload
		const parsedResult = unwrapMcpContent(result) as Record<
			string,
			unknown
		> | null;

		if (parsedResult && typeof parsedResult === "object") {
			if (parsedResult.error || parsedResult.success === false) {
				const errorMsg = String(
					parsedResult.error ||
						parsedResult.message ||
						JSON.stringify(parsedResult),
				);
				if (
					errorMsg.includes("Record 'ScriptNote' was not found") ||
					errorMsg.includes("Record 'Script' was not found")
				) {
					return textResult(
						`❌ NetSuite Error: ${errorMsg}\n\n💡 Tip: Accessing script execution logs (ScriptNote table) requires the current NetSuite role to have the 'SuiteScript' (ADMI_CUSTOMSCRIPT) permission with at least 'View' level under Permissions > Setup.`,
						true,
					);
				}
				return textResult(`❌ Failed to query script logs: ${errorMsg}`, true);
			}
		}

		const data = mcpTools.extractDataArray(result);

		// If errors exist, add structured diagnostic summary inside JSON payload
		const errors = data.filter(
			(d) =>
				typeof d === "object" &&
				d !== null &&
				(d.type === "ERROR" || d.type === "EMERGENCY"),
		);
		let diagnosticSummary: Record<string, unknown> | undefined;
		const latest = errors[0] as Record<string, unknown> | undefined;
		if (latest) {
			diagnosticSummary = {
				errorCount: errors.length,
				latestScript: latest.scriptScriptId || latest.scriptName || "Unknown",
				latestTimestamp: latest.date,
				latestTitle: latest.title,
				latestDetailSnippet: String(latest.detail || "").slice(0, 200),
			};
		}

		return textResult(
			JSON.stringify(
				{
					totalResults: data.length,
					...(diagnosticSummary ? { diagnosticSummary } : {}),
					query: sql,
					data,
				},
				null,
				2,
			),
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ Failed to query script logs: ${msg}`, true);
	}
}

async function handleInspectRecord(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = InspectRecordArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	let { recordType, recordId, includeLines, nonEmptyOnly } = parsed.data;

	// If recordId is not numeric (e.g. document tranid 'SO1002'), try resolving internal numeric ID
	const isNumeric = /^\d+$/.test(recordId.trim());
	if (!isNumeric) {
		try {
			const lookupSql = `SELECT id, recordtype FROM transaction WHERE tranid = '${recordId.replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
			const lookupRes = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: lookupSql,
			});
			const rows = mcpTools.extractDataArray(lookupRes);
			if (rows.length > 0 && rows[0]?.id) {
				recordId = String(rows[0].id);
				if (rows[0].recordtype) {
					recordType = String(rows[0].recordtype).toLowerCase();
				}
			}
		} catch {
			// Continue with original recordId if lookup fails
		}
	}

	try {
		const rawRecord = await mcpTools.executeTool("ns_getRecord", {
			recordType,
			id: recordId,
		});

		const unwrapped = (unwrapMcpContent(rawRecord) || rawRecord) as Record<
			string,
			unknown
		>;
		if (!unwrapped || typeof unwrapped !== "object") {
			return textResult(
				`❌ Record not found or invalid response for ${recordType} ID: ${recordId}`,
				true,
			);
		}

		// Separate system fields vs custom fields vs sublists
		const systemFields: Record<string, unknown> = {};
		const customFields: Record<string, unknown> = {};
		const sublists: Record<string, unknown> = {};

		for (const [key, val] of Object.entries(unwrapped)) {
			if (
				nonEmptyOnly &&
				(val === null ||
					val === undefined ||
					val === "" ||
					(Array.isArray(val) && val.length === 0))
			) {
				continue;
			}

			if (
				key.startsWith("custbody_") ||
				key.startsWith("custentity_") ||
				key.startsWith("custrecord_")
			) {
				customFields[key] = val;
			} else if (
				Array.isArray(val) ||
				(typeof val === "object" &&
					val !== null &&
					!("id" in val && Object.keys(val).length <= 2))
			) {
				if (includeLines) {
					sublists[key] = val;
				}
			} else {
				systemFields[key] = val;
			}
		}

		let md = `## 🔍 NetSuite Record Inspection: \`${recordType}\` (ID: ${recordId})\n\n`;

		// Format system fields table
		md += `### 📋 System Header Fields (${Object.keys(systemFields).length})\n`;
		md += `| Field ID | Value |\n|---|---|\n`;
		for (const [k, v] of Object.entries(systemFields)) {
			const displayVal =
				typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
			md += `| \`${k}\` | ${displayVal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
		}

		// Format custom fields table
		md += `\n### 🏷️ Custom Fields (${Object.keys(customFields).length})\n`;
		if (Object.keys(customFields).length === 0) {
			md += `*(No populated custom fields found)*\n`;
		} else {
			md += `| Field ID | Value |\n|---|---|\n`;
			for (const [k, v] of Object.entries(customFields)) {
				const displayVal =
					typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
				md += `| \`${k}\` | ${displayVal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
			}
		}

		// Format sublists overview
		if (includeLines && Object.keys(sublists).length > 0) {
			md += `\n### 📦 Sublists & Lines Summary\n`;
			for (const [sublistName, val] of Object.entries(sublists)) {
				if (Array.isArray(val)) {
					md += `- **\`${sublistName}\`** (${val.length} rows)\n`;
					if (val.length > 0 && typeof val[0] === "object" && val[0] !== null) {
						const sampleKeys = Object.keys(val[0]).filter(
							(k) => val[0][k] !== null && val[0][k] !== "",
						);
						md += `  - Populated Columns in Row 1: \`${sampleKeys.slice(0, 15).join("`, `")}\`${sampleKeys.length > 15 ? "..." : ""}\n`;
					}
				}
			}
		}

		return textResult(md);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(
			`❌ Failed to inspect record ${recordType} (${recordId}): ${msg}`,
			true,
		);
	}
}

async function handleGetRecordDefinition(
	args: Record<string, unknown>,
): Promise<ToolResponse> {
	const parsed = GetRecordDefinitionArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const { recordType, keyword } = parsed.data;

	const def = recordsReferenceService.getRecordDefinition(recordType, keyword);
	if (!def) {
		return textResult(
			`⚠️ Official records definition not found on local disk. (Ensure 'npm run fetch-skills' has been executed).`,
			true,
		);
	}

	if (!def.found) {
		const allTypes = recordsReferenceService.listRecordTypes();
		const suggestions = allTypes
			.filter((t) => t.includes(recordType) || recordType.includes(t))
			.slice(0, 10);

		let msg = `❌ Record type '${recordType}' not found in official SuiteScript 272 records list.\n`;
		if (suggestions.length > 0) {
			msg += `\n💡 Did you mean one of these: \`${suggestions.join("`, `")}\`?`;
		}
		return textResult(msg, true);
	}

	let md = `## 📖 Official Records Definition: \`${def.recordType}\` (${def.fields.length} of ${def.totalFields} fields matching)\n\n`;
	md += `| Field ID | Label | Type | Required | Help / Notes |\n|---|---|---|---|---|\n`;

	for (const f of def.fields.slice(0, 100)) {
		const helpSnippet = (f.help || "")
			.slice(0, 80)
			.replace(/\|/g, "\\|")
			.replace(/\n/g, " ");
		md += `| \`${f.internalId}\` | ${f.label} | \`${f.type}\` | ${f.required ? "✅" : "❌"} | ${helpSnippet} |\n`;
	}

	if (def.fields.length > 100) {
		md += `\n*(Showing top 100 of ${def.fields.length} fields. Use keyword parameter to narrow search)*\n`;
	}

	if (def.sublists && def.sublists.length > 0) {
		md += `\n### 📦 Sublists:\n`;
		for (const sl of def.sublists) {
			md += `- \`${sl.name}\`${sl.label ? ` (${sl.label})` : ""}\n`;
		}
	}

	return textResult(md);
}

async function handleGetQueryTemplate(
	args: Record<string, unknown>,
): Promise<ToolResponse> {
	const parsed = GetQueryTemplateArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const { templateId, category, search } = parsed.data;

	if (templateId) {
		const tmpl = suiteqlTemplateService.getTemplate(templateId);
		if (!tmpl) {
			return textResult(`❌ Template '${templateId}' not found.`, true);
		}

		let md = `## 💎 SuiteQL Template: ${tmpl.name} (\`${tmpl.id}\`)\n\n`;
		md += `**Category**: \`${tmpl.category}\`  \n`;
		md += `**Source**: ${tmpl.officialSource}  \n\n`;
		md += `> ${tmpl.description}\n\n`;
		md += `### 📝 SQL Template\n\`\`\`sql\n${tmpl.sqlTemplate}\n\`\`\`\n\n`;
		md += `### ⚙️ Parameters\n| Parameter | Description |\n|---|---|\n`;
		for (const [param, desc] of Object.entries(tmpl.params)) {
			md += `| \`${param}\` | ${desc} |\n`;
		}
		md += `\n### 🛡️ SAFE Best Practices\n`;
		for (const bp of tmpl.bestPractices) {
			md += `- ${bp}\n`;
		}
		return textResult(md);
	}

	let templates = suiteqlTemplateService.listTemplates(category);
	if (search) {
		templates = suiteqlTemplateService.searchTemplates(search);
	}

	let md = `## 📚 Curated SuiteQL Templates (${templates.length} available)\n\n`;
	md += `| ID | Name | Category | Description |\n|---|---|---|---|\n`;
	for (const t of templates) {
		md += `| \`${t.id}\` | ${t.name} | \`${t.category}\` | ${t.description.slice(0, 70)}... |\n`;
	}
	md += `\n💡 Call with \`{ templateId: '...' }\` to retrieve full SQL and parameter guidance.`;
	return textResult(md);
}

async function handleGetSystemNotes(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = GetSystemNotesArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	let { recordId, limit } = parsed.data;

	const isNumeric = /^\d+$/.test(recordId.trim());
	if (!isNumeric) {
		try {
			const lookupSql = `SELECT id FROM transaction WHERE tranid = '${recordId.replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
			const lookupRes = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: lookupSql,
			});
			const rows = mcpTools.extractDataArray(lookupRes);
			if (rows.length > 0 && rows[0]?.id) {
				recordId = String(rows[0].id);
			}
		} catch {
			// Continue with recordId
		}
	}

	// Standalone query complying with SAFE Guide Pitfall 11
	const sql = `SELECT sn.date, sn.field, sn.oldvalue, sn.newvalue, sn.name AS author_id, BUILTIN.DF(sn.name) AS author_name, BUILTIN.DF(sn.role) AS role_name FROM systemnote sn WHERE sn.recordid = ${recordId} ORDER BY sn.date DESC FETCH FIRST ${limit} ROWS ONLY`;

	try {
		const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: sql,
		});
		const rows = mcpTools.extractDataArray(res);

		if (rows.length === 0) {
			return textResult(`ℹ️ No system notes found for record ID ${recordId}.`);
		}

		let md = `## 🕵️ System Notes Audit Trail (Record ID: ${recordId}, ${rows.length} changes)\n\n`;
		md += `| Timestamp | Author | Role | Field | Old Value | New Value |\n|---|---|---|---|---|---|\n`;

		for (const r of rows) {
			const author = r.author_name || r.author_id || "System";
			const role = r.role_name || "-";
			const field = r.field || "-";
			const oldVal = (
				r.oldvalue !== null && r.oldvalue !== undefined
					? String(r.oldvalue)
					: ""
			).slice(0, 30);
			const newVal = (
				r.newvalue !== null && r.newvalue !== undefined
					? String(r.newvalue)
					: ""
			).slice(0, 30);
			md += `| ${r.date} | ${author} | ${role} | \`${field}\` | ${oldVal} | ${newVal} |\n`;
		}

		return textResult(md);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(
			`❌ Failed to query system notes for record ID ${recordId}: ${msg}`,
			true,
		);
	}
}

async function handleSuitecloudUpload(
	args: Record<string, unknown>,
	oauthManager: OAuthManager,
	defaultProjectRoot: string,
): Promise<ToolResponse> {
	const parsed = SuitecloudUploadArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const {
		paths,
		projectPath: customProjectPath,
		dryRun,
		allowProduction,
	} = parsed.data;

	const currentAccountId = (await oauthManager.getAccountId()) || "UNKNOWN";
	const isProd = !isSandboxAccount(currentAccountId);

	// Normalize FileCabinet path
	const normalizedFcPath =
		suitecloudRunnerService.normalizeFileCabinetPath(paths);

	// Resolve project directory: if not specified and paths is absolute, try detecting upwards
	let startDir = customProjectPath;
	if (!startDir) {
		if (path.isAbsolute(paths)) {
			startDir =
				suitecloudRunnerService.findSdfProjectRoot(path.dirname(paths)) ||
				defaultProjectRoot;
		} else {
			startDir = defaultProjectRoot;
		}
	}
	const resolvedProjectRoot =
		suitecloudRunnerService.findSdfProjectRoot(startDir) || startDir;

	// Check local file existence and inspect
	const inspection = suitecloudRunnerService.inspectLocalFile(
		resolvedProjectRoot,
		paths,
	);

	// Safety check 1: If file doesn't exist, fail immediately
	if (!inspection.exists) {
		return textResult(
			`❌ Local file inspection failed: ${inspection.error}`,
			true,
		);
	}

	const fileSizeKb =
		inspection.sizeBytes !== undefined
			? (inspection.sizeBytes / 1024).toFixed(2)
			: "Unknown";

	// Safety check 2: Production environment block
	if (isProd && !allowProduction) {
		return textResult(
			`🚨 **生产环境安全拦截 (Production Safety Block)**\n\n` +
				`当前目标 NetSuite 账号为**生产环境** (\`${currentAccountId.toUpperCase()}\`)。\n` +
				`为防止误操作覆盖生产代码，需获得用户明确授权。\n\n` +
				`若用户已明确指示上传到生产环境，请设置 \`allowProduction: true\` 重新调用此工具，即可直接一步执行上传。`,
			true,
		);
	}

	if (dryRun) {
		let previewMd = `## 🔍 SuiteCloud File Upload Preview (Dry Run)\n\n`;
		previewMd += `| Parameter | Value |\n|---|---|\n`;
		previewMd += `| **File Cabinet Path** | \`${normalizedFcPath}\` |\n`;
		previewMd += `| **Local File Location** | \`${inspection.localFullPath}\` (${fileSizeKb} KB) |\n`;
		previewMd += `| **Target Account** | \`${currentAccountId.toUpperCase()}\` (${isProd ? "🚨 PRODUCTION" : "🛡️ SANDBOX"}) |\n`;
		previewMd += `| **SDF Project Root** | \`${resolvedProjectRoot}\` |\n`;
		previewMd += `| **Command to Run** | \`suitecloud file:upload --paths "${normalizedFcPath}"\` |\n`;
		return textResult(previewMd);
	}

	// In Sandbox (or authorized Production), execute the upload directly!
	const execResult = await suitecloudRunnerService.executeUpload(
		resolvedProjectRoot,
		normalizedFcPath,
	);

	if (!execResult.success) {
		let errorMd = `❌ **SuiteCloud Upload Failed (Time: ${execResult.executionTimeMs}ms)**\n\n`;
		errorMd += `### CLI Error Output:\n\`\`\`\n${execResult.stderr || execResult.stdout}\n\`\`\`\n\n`;
		errorMd += `💡 **Troubleshooting Tips:**\n`;
		errorMd += `1. Ensure you have authenticated with SuiteCloud CLI (\`npx suitecloud account:setup\` or manageauth).\n`;
		errorMd += `2. Ensure the active SuiteCloud auth ID matches account \`${currentAccountId}\`.\n`;
		errorMd += `3. Check that the path \`${normalizedFcPath}\` is registered in \`deploy.xml\` or FileCabinet structure.`;
		return textResult(errorMd, true);
	}

	let successMd = `✅ **SuiteCloud File Upload Succeeded (Time: ${execResult.executionTimeMs}ms)**\n\n`;
	successMd += `- **Uploaded Path**: \`${normalizedFcPath}\`\n`;
	successMd += `- **Target Account**: \`${currentAccountId.toUpperCase()}\`\n`;
	successMd += `- **Local File**: \`${inspection.localFullPath}\`\n\n`;
	if (execResult.stdout.trim().length > 0) {
		successMd += `### CLI Output:\n\`\`\`\n${execResult.stdout.trim()}\n\`\`\`\n`;
	}

	return textResult(successMd);
}

/** Normalize standard parameters (recordType, tableName, table_name, record_type, table). */
function normalizeStandardArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const rawRecordType =
		args.recordType ??
		args.record_type ??
		args.tableName ??
		args.table_name ??
		args.table;

	if (typeof rawRecordType === "string" && rawRecordType.trim().length > 0) {
		const normalized = rawRecordType.toLowerCase().trim();
		args.recordType = normalized;
		if (typeof args.tableName === "string") {
			args.tableName = normalized;
		}
	}

	if (
		typeof args.record_id === "string" ||
		typeof args.record_id === "number"
	) {
		const strId = String(args.record_id).trim();
		if (!args.recordId) args.recordId = strId;
		if (!args.id) args.id = strId;
	}

	return args;
}

async function handleBatchExecute(
	args: Record<string, unknown>,
	deps: ToolHandlerDeps,
): Promise<ToolResponse> {
	const parsed = BatchExecuteArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const { tasks } = parsed.data;
	const { mcpTools, oauthManager, resolveCustomRecordRectype } = deps;

	const accountId = await oauthManager.getAccountId();
	const isSandbox = accountId ? isSandboxAccount(accountId) : false;

	const batchResult = await processParallelBatch(
		tasks,
		async (task) => {
			if (!task || typeof task.toolName !== "string") {
				throw new Error("Invalid task: missing or invalid toolName");
			}

			const { toolName, arguments: toolArgs = {} } = task;
			const safeArgs = normalizeStandardArgs(
				(toolArgs || {}) as Record<string, unknown>,
			);

			// Enforce production write-protection guardrail
			if (
				(toolName === "ns_createRecord" || toolName === "ns_updateRecord") &&
				!isSandbox
			) {
				throw new Error(
					`Write operations are disabled in production environments: ${toolName}`,
				);
			}

			// Support local tools inside batch
			if (toolName === "netsuite_get_record_link") {
				const linkRes = await handleGetRecordLink(
					safeArgs,
					oauthManager,
					resolveCustomRecordRectype,
				);
				return linkRes.content[0]?.type === "text"
					? linkRes.content[0].text
					: linkRes;
			}
			if (toolName === "netsuite_get_script_logs") {
				const logsRes = await handleGetScriptLogs(safeArgs, mcpTools);
				if (logsRes.isError) {
					throw new Error(
						logsRes.content[0]?.type === "text"
							? logsRes.content[0].text
							: "Failed to get script logs",
					);
				}
				const text =
					logsRes.content[0]?.type === "text" ? logsRes.content[0].text : "";
				return await asyncJsonParse(text);
			}
			if (toolName === "netsuite_refresh_cache") {
				const refreshRes = await deps.handleCacheRefresh(safeArgs);
				return refreshRes.content[0]?.type === "text"
					? refreshRes.content[0].text
					: refreshRes;
			}

			let result = await mcpTools.executeTool(toolName, safeArgs);

			// Run hydration if metadata tool
			if (
				toolName === "ns_getRecordTypeMetadata" ||
				toolName === "ns_getSuiteQLMetadata"
			) {
				const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
				result = await hydrateMetadataIfNeeded(
					toolName,
					recordTypeRaw,
					result ?? null,
					mcpTools,
					resolveCustomRecordRectype,
				);
			}

			const parsedResult =
				typeof result === "string" ? await asyncJsonParse(result) : result;

			// Detect NetSuite-level error payloads in batch items
			const unwrapped = unwrapMcpContent(parsedResult);
			if (
				unwrapped &&
				typeof unwrapped === "object" &&
				(unwrapped as Record<string, unknown>).success === false
			) {
				const errObj = unwrapped as Record<string, unknown>;
				const errMsg = String(
					errObj.error || errObj.message || JSON.stringify(errObj),
				);
				if (isPermissionError(errMsg)) {
					throw new Error(
						`NetSuite Permission Error: ${errMsg}\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`,
					);
				}
				throw new Error(`NetSuite Error: ${errMsg}`);
			}

			// Clean/slim the results
			if (toolName === "ns_getRecord") {
				return cleanRecordPayload(parsedResult);
			}
			if (
				toolName === "ns_getRecordTypeMetadata" ||
				toolName === "ns_getSuiteQLMetadata"
			) {
				return formatMetadataToCompactMarkdown(parsedResult);
			}
			if (toolName === "ns_runCustomSuiteQL") {
				return formatSuiteQLToCompactMarkdown(parsedResult);
			}

			return parsedResult;
		},
		5,
	);

	return textResult(
		JSON.stringify(
			{
				totalTasks: batchResult.total,
				successfulTasks: batchResult.successful,
				failedTasks: batchResult.failed,
				totalDurationMs: batchResult.totalDurationMs,
				individualResults: batchResult.individualResults.map((r, i) => ({
					index: r.index,
					toolName: tasks[i]?.toolName,
					success: r.success,
					durationMs: r.durationMs,
					...(r.success ? { result: r.result } : { error: r.error }),
				})),
			},
			null,
			2,
		),
	);
}

/**
 * netsuite_status — Diagnostic tool
 */
async function handleStatus(oauthManager: OAuthManager): Promise<ToolResponse> {
	const sessionInfo = await oauthManager.getSessionInfo();
	const cacheStats = await cacheService.getStats();

	const status: Record<string, unknown> = {
		server: "netsuite-mcp",
		version: "1.0.0",
		authenticated: sessionInfo.authenticated,
		refreshSchedulerActive: sessionInfo.refreshSchedulerActive,
		cache: cacheStats,
	};

	if (sessionInfo.authenticated) {
		status.accountId = sessionInfo.accountId;
		status.clientId = sessionInfo.clientId
			? `${sessionInfo.clientId.substring(0, 8)}...`
			: undefined;
		status.tokenExpiresIn =
			sessionInfo.tokenExpiresIn !== undefined
				? `${sessionInfo.tokenExpiresIn}s`
				: "unknown";
		status.tokenExpiresAt = sessionInfo.tokenExpiresAt
			? new Date(sessionInfo.tokenExpiresAt).toISOString()
			: "unknown";

		const sandbox = sessionInfo.accountId
			? isSandboxAccount(sessionInfo.accountId)
			: false;
		status.environment = sandbox ? "Sandbox/Test" : "Production";
		status.writeOperations = sandbox ? "enabled" : "disabled";
	}

	return textResult(JSON.stringify(status, null, 2));
}

/** Append a NetSuite UI deep link to a record operation response. */
async function appendRecordLink(
	responseText: string,
	args: Record<string, unknown>,
	result: unknown,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<string> {
	const resObj =
		typeof result === "object" && result !== null
			? (result as Record<string, unknown>)
			: null;
	const recordId =
		(args.recordId as string) ||
		(resObj && (resObj.id || resObj.internalid)
			? String(resObj.id || resObj.internalid)
			: undefined);
	const recordType =
		(args.recordType as string) ||
		(resObj?.recordType ? String(resObj.recordType) : undefined);

	if (!recordId) return responseText;

	const currentAccountId = await oauthManager.getAccountId();
	if (!currentAccountId) return responseText;

	let rectype = args.rectype as number | string | undefined;
	const isCustomRecord = recordType?.toLowerCase().startsWith("customrecord");

	if (!rectype && recordType && isCustomRecord) {
		rectype = (await resolveRectype(recordType)) ?? undefined;
	}

	const url = generateNetSuiteUrl(
		currentAccountId,
		recordType,
		recordId,
		rectype,
	);
	if (url) {
		responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
	} else if (isCustomRecord && !rectype) {
		responseText += `\n\n⚠️ **Note:** Could not auto-resolve numeric record type ID for custom record '${recordType}'. UI deep link omitted (ensure your NetSuite integration role has 'Custom Record Types' permission under Permissions > Setup).`;
	}
	return responseText;
}

// ---------------------------------------------------------------------------
// Tool description enhancement helpers
// ---------------------------------------------------------------------------

/** Append suffix to a tool's description string. */
function enhanceDescription(
	tool: Record<string, unknown>,
	suffix: string,
): Record<string, unknown> {
	const desc = (tool.description as string) || "";
	return { ...tool, description: desc ? `${desc}${suffix}` : suffix };
}

/** Enhance fetched NetSuite tool descriptions with SuiteQL rules and parameter-level guidance. */
function enhanceToolDescriptions(
	tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return tools.map((t) => {
		if (t.name === "ns_runCustomSuiteQL") {
			const enhanced = enhanceDescription(t, SUITEQL_RULES_SUFFIX);
			if (enhanced.inputSchema && typeof enhanced.inputSchema === "object") {
				const schema = { ...(enhanced.inputSchema as Record<string, unknown>) };
				if (schema.properties && typeof schema.properties === "object") {
					const props = { ...(schema.properties as Record<string, unknown>) };
					if (props.sqlQuery && typeof props.sqlQuery === "object") {
						props.sqlQuery = {
							...(props.sqlQuery as Record<string, unknown>),
							description:
								"The SuiteQL query string to execute. UNIVERSAL RULES: (1) Reconnaissance: Verify exact table and column names via 'ns_getSuiteQLMetadata' before querying unfamiliar schemas. (2) Dialect: Explicit columns only (no SELECT *), use ROWNUM <= N or FETCH FIRST N ROWS ONLY (no LIMIT/OFFSET), wrap dates in TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD'), and use BUILTIN.DF(field) for labels. (3) Table Granularity: Distinguish header from line tables (filter line items with mainline='F'; relationship/upstream fields like createdfrom live on line tables); prefer domain-specialized tables over monolithic base tables for aggregations; never JOIN SystemNote directly. (4) Indexing: High-volume queries must include indexed filters (id, tranid, trandate, type, entity, subsidiary).",
						};
					}
					schema.properties = props;
				}
				enhanced.inputSchema = schema;
			}
			return enhanced;
		}
		if (t.name === "ns_getSuiteQLMetadata") {
			const enhanced = enhanceDescription(t, METADATA_RULES_SUFFIX);
			if (enhanced.inputSchema && typeof enhanced.inputSchema === "object") {
				const schema = { ...(enhanced.inputSchema as Record<string, unknown>) };
				const props = {
					...((schema.properties as Record<string, unknown>) || {}),
				};
				props.keyword = {
					type: "string",
					description:
						"Optional search keyword to discover available NetSuite SuiteQL tables across all business domains (e.g. 'inventory', 'transaction', 'invoice', 'order', 'account', 'customer', 'bom'). If provided without recordType, returns matching table names and descriptions in milliseconds without network timeout.",
				};
				schema.properties = props;
				enhanced.inputSchema = schema;
			}
			return enhanced;
		}
		return t;
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all MCP tool handlers on the server.
 *
 * Error handling contract:
 * - McpError → rethrown to MCP SDK (protocol-level error)
 * - All other errors → returned as textResult with isError: true
 */
export function registerToolHandlers(deps: ToolHandlerDeps): void {
	const {
		server,
		oauthManager,
		mcpTools,
		handleAuthentication,
		handleLogout,
		handleCacheRefresh,
		resolveCustomRecordRectype,
	} = deps;

	// --- List Tools ---
	server.setRequestHandler("tools/list", async () => {
		try {
			const accountId =
				(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
			const envSuffix = buildEnvSuffix(accountId ?? null);

			const isAuthenticated = await oauthManager.hasValidSession();
			if (!isAuthenticated) {
				const unauthTools = [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map((t) =>
					enhanceDescription(t, envSuffix),
				);
				return { tools: unauthTools as unknown as Tool[] };
			}

			const tools = (await mcpTools.fetchTools()) as Array<
				Record<string, unknown>
			>;

			// Filter write tools in production
			const isSandbox = accountId ? isSandboxAccount(accountId) : false;
			const filteredTools = isSandbox
				? tools
				: tools.filter(
						(t) => t.name !== "ns_createRecord" && t.name !== "ns_updateRecord",
					);

			// Enhance SuiteQL tool descriptions with rules
			const enhancedTools = enhanceToolDescriptions(filteredTools);

			// Combine with local tools and append env suffix
			const finalTools = [...enhancedTools, ...LOCAL_TOOLS].map((t) =>
				enhanceDescription(t, envSuffix),
			);

			return { tools: finalTools as unknown as Tool[] };
		} catch {
			const accountId =
				(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
			const envSuffix = buildEnvSuffix(accountId ?? null);
			const fallbackTools = [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map((t) =>
				enhanceDescription(t, envSuffix),
			);
			return { tools: fallbackTools as unknown as Tool[] };
		}
	});

	// --- Call Tool ---
	server.setRequestHandler("tools/call", async (request) => {
		const { name, arguments: args } = request.params;
		const safeArgs = normalizeStandardArgs(
			(args || {}) as Record<string, unknown>,
		);

		try {
			// --- Tools that do NOT require authentication ---
			if (name === "netsuite_authenticate") {
				return await handleAuthentication(safeArgs);
			}
			if (name === "netsuite_logout") {
				return await handleLogout();
			}
			if (name === "netsuite_status") {
				return await handleStatus(oauthManager);
			}

			// --- All remaining tools require authentication ---
			const isAuthenticated = await oauthManager.hasValidSession();
			if (!isAuthenticated) {
				return textResult(
					"❌ Not authenticated. Please use the netsuite_authenticate tool first.",
					true,
				);
			}

			// --- Local tools (authenticated) ---
			if (name === "netsuite_refresh_cache") {
				return await handleCacheRefresh(safeArgs);
			}
			if (name === "netsuite_get_record_link") {
				return await handleGetRecordLink(
					safeArgs,
					oauthManager,
					resolveCustomRecordRectype,
				);
			}
			if (name === "netsuite_batch_execute") {
				return await handleBatchExecute(safeArgs, deps);
			}
			if (name === "netsuite_get_script_logs") {
				return await handleGetScriptLogs(safeArgs, mcpTools);
			}
			if (name === "netsuite_inspect_record") {
				return await handleInspectRecord(safeArgs, mcpTools);
			}
			if (name === "netsuite_get_record_definition") {
				return await handleGetRecordDefinition(safeArgs);
			}
			if (name === "netsuite_get_query_template") {
				return await handleGetQueryTemplate(safeArgs);
			}
			if (name === "netsuite_get_system_notes") {
				return await handleGetSystemNotes(safeArgs, mcpTools);
			}
			if (name === "netsuite_suitecloud_upload") {
				return await handleSuitecloudUpload(
					safeArgs,
					oauthManager,
					deps.projectRoot,
				);
			}

			// --- Fast metadata discovery for ns_getSuiteQLMetadata without recordType ---
			if (name === "ns_getSuiteQLMetadata") {
				const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
				if (!recordTypeRaw) {
					const keywordRaw = safeArgs.keyword || safeArgs.search;
					const keyword =
						typeof keywordRaw === "string" ? keywordRaw.trim() : undefined;
					const entries = searchSuiteQLCatalog(keyword);
					return textResult(formatTableCatalogMarkdown(entries, keyword));
				}
			}

			// --- Block write operations in production ---
			if (name === "ns_createRecord" || name === "ns_updateRecord") {
				const accountId = await oauthManager.getAccountId();
				if (accountId && !isSandboxAccount(accountId)) {
					throw new ProtocolError(
						ProtocolErrorCode.InvalidRequest,
						`Write operations are disabled in production environments: ${name}`,
					);
				}
			}

			// --- Proxy to NetSuite MCP API ---
			let result: unknown;
			let executeError: unknown = null;

			try {
				result = await mcpTools.executeTool(name, safeArgs);
			} catch (err: unknown) {
				if (
					name === "ns_getRecordTypeMetadata" ||
					name === "ns_getSuiteQLMetadata"
				) {
					executeError = err;
				} else {
					throw err;
				}
			}

			if (
				name === "ns_getRecordTypeMetadata" ||
				name === "ns_getSuiteQLMetadata"
			) {
				const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
				const hydratedResult = await hydrateMetadataIfNeeded(
					name,
					recordTypeRaw,
					result ?? null,
					mcpTools,
					resolveCustomRecordRectype,
				);

				if (hydratedResult) {
					const parsed = unwrapMcpContent(hydratedResult) as Record<
						string,
						unknown
					> | null;

					if (
						parsed &&
						typeof parsed === "object" &&
						parsed.success === false
					) {
						const errorMsg =
							parsed.error || parsed.message || JSON.stringify(parsed);
						if (isPermissionError(String(errorMsg))) {
							return textResult(
								`❌ NetSuite Permission Error: ${errorMsg}\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`,
								true,
							);
						}
						if (name === "ns_getSuiteQLMetadata") {
							return textResult(
								formatSuiteQLErrorResponse(String(errorMsg)),
								true,
							);
						}
						return textResult(`❌ NetSuite Error: ${errorMsg}`, true);
					}

					const compactMarkdown =
						formatMetadataToCompactMarkdown(hydratedResult);
					return textResult(compactMarkdown);
				}

				if (executeError) {
					const errMsg =
						executeError instanceof Error
							? executeError.message
							: String(executeError);
					if (name === "ns_getSuiteQLMetadata") {
						return textResult(formatSuiteQLErrorResponse(errMsg), true);
					}
					throw executeError;
				}

				const compactMarkdown = formatMetadataToCompactMarkdown(result);
				return textResult(compactMarkdown);
			}

			// Check if the record tool call returned a NetSuite-level error
			const parsedRecordResult = unwrapMcpContent(result) as Record<
				string,
				unknown
			> | null;

			if (
				parsedRecordResult &&
				typeof parsedRecordResult === "object" &&
				parsedRecordResult.success === false
			) {
				const errorMsg = String(
					parsedRecordResult.error ||
						parsedRecordResult.message ||
						JSON.stringify(parsedRecordResult),
				);
				if (isPermissionError(errorMsg)) {
					return textResult(
						`❌ NetSuite Permission Error: ${errorMsg}\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`,
						true,
					);
				}
				if (name === "ns_runCustomSuiteQL") {
					const sqlQuery = (safeArgs.sqlQuery ||
						safeArgs.query ||
						safeArgs.sql ||
						"") as string;
					return textResult(
						formatSuiteQLErrorResponse(errorMsg, sqlQuery),
						true,
					);
				}
				const guidance =
					"\n\n💡 [Self-Healing Action]: Call `ns_getRecordTypeMetadata` to check schema constraints and valid field IDs.";
				return textResult(`❌ NetSuite Error: ${errorMsg}${guidance}`, true);
			}

			if (name === "ns_runCustomSuiteQL") {
				return textResult(formatSuiteQLToCompactMarkdown(result));
			}

			if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				result = cleanRecordPayload(result);
			}

			let responseText =
				typeof result === "string" ? result : JSON.stringify(result, null, 2);

			// Auto-append UI deep link for record operations
			if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				responseText = await appendRecordLink(
					responseText,
					safeArgs,
					result,
					oauthManager,
					resolveCustomRecordRectype,
				);
			}

			return textResult(responseText);
		} catch (error: unknown) {
			// Let McpError propagate directly to the MCP SDK
			if (error instanceof ProtocolError) {
				throw error;
			}
			// All other errors: return as tool-level error response
			const message = error instanceof Error ? error.message : String(error);
			let guidance = "";
			if (isPermissionError(message)) {
				// DO NOT attach self-healing guidance on permission errors
				if (!message.includes("PERMISSION DENIED — HARD STOP REQUIRED")) {
					guidance = `\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`;
				}
			} else if (name === "ns_runCustomSuiteQL") {
				const sqlQuery = (safeArgs.sqlQuery ||
					safeArgs.query ||
					safeArgs.sql ||
					"") as string;
				return textResult(formatSuiteQLErrorResponse(message, sqlQuery), true);
			} else if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				guidance =
					"\n\n💡 [Self-Healing Action]: Call `ns_getRecordTypeMetadata` to check schema constraints and valid field IDs.";
			}
			return textResult(`❌ Error: ${message}${guidance}`, true);
		}
	});
}

/** Hydrates NetSuite custom record metadata with custom fields from SuiteQL if needed. */
async function hydrateMetadataIfNeeded(
	_toolName: string,
	recordTypeRaw: unknown,
	originalResult: unknown,
	mcpTools: NetSuiteMCPTools,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<unknown> {
	const recordType =
		typeof recordTypeRaw === "string" ? recordTypeRaw.trim() : "";
	if (!recordType?.toLowerCase().startsWith("customrecord")) {
		return originalResult;
	}

	// If originalResult already contains valid property definitions, return directly
	const parsedOriginal = unwrapMcpContent(originalResult) as Record<
		string,
		unknown
	> | null;
	if (parsedOriginal && typeof parsedOriginal === "object") {
		const meta = (parsedOriginal.metadata || parsedOriginal) as Record<
			string,
			unknown
		>;
		if (
			meta &&
			typeof meta.properties === "object" &&
			meta.properties !== null &&
			Object.keys(meta.properties).length > 0
		) {
			return originalResult;
		}
	}

	try {
		const rawRectype = await resolveRectype(recordType);
		if (!rawRectype) {
			return originalResult;
		}

		const rectype = sanitizeIntegerId(rawRectype);

		const qFields = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: `SELECT Name, ScriptID, FieldType, IsMandatory FROM CustomField WHERE RecordType = ${rectype}`,
		});
		const fields = mcpTools.extractDataArray(qFields);

		if (!fields || fields.length === 0) {
			return originalResult;
		}

		const properties: Record<string, JsonSchemaProperty> = {
			id: { title: "Internal ID", type: "string", nullable: true },
			name: { title: "Name", type: "string", nullable: true },
			externalId: { title: "External ID", type: "string", nullable: true },
			isinactive: { title: "Is Inactive", type: "boolean", nullable: true },
			owner: {
				title: "Owner",
				type: "object",
				properties: {
					id: { title: "Internal identifier", type: "string" },
					refName: { title: "Reference Name", type: "string" },
				},
				nullable: true,
			},
		};

		for (const field of fields) {
			const scriptId = String(field.scriptid || field.scriptId || "")
				.toLowerCase()
				.trim();
			if (scriptId) {
				properties[scriptId] = {
					title: String(field.name || field.label || scriptId),
					nullable: field.ismandatory !== "T",
					...mapFieldType(field.fieldtype as string | undefined),
				};
			}
		}

		let originalProperties: Record<string, JsonSchemaProperty> = {};
		if (parsedOriginal && typeof parsedOriginal === "object") {
			const meta = (parsedOriginal.metadata || parsedOriginal) as Record<
				string,
				unknown
			>;
			if (
				meta &&
				typeof meta.properties === "object" &&
				meta.properties !== null
			) {
				originalProperties = meta.properties as Record<
					string,
					JsonSchemaProperty
				>;
			}
		}

		const finalProperties = { ...properties, ...originalProperties };

		const hydratedResponse = {
			success: true,
			metadata: {
				type: "object",
				properties: finalProperties,
			},
		};

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(hydratedResponse),
				},
			],
		};
	} catch {
		// Custom field hydration is a best-effort enhancement — fall back gracefully to original metadata
		return originalResult;
	}
}
