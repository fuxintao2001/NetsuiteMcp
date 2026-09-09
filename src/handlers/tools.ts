import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { ProtocolError, type Server } from "@modelcontextprotocol/server";
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
import { classifyError, recordToolError } from "../utils/toolErrorLogger.js";
import {
	formatSummaryToMarkdown,
	summarizeToolErrors,
} from "../utils/toolErrorSummarizer.js";
import {
	AUTH_TOOL,
	BatchExecuteArgsSchema,
	GetErrorSummaryArgsSchema,
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

	// Build SELECT with Script info joined for complete visibility (explicit second-level timestamp formatting)
	let sql = `SELECT TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date, sn.type, sn.title, sn.detail, s.scriptid AS scriptScriptId, s.name AS scriptName FROM ScriptNote AS sn LEFT JOIN Script AS s ON sn.scripttype = s.id`;

	// Build WHERE clauses
	const conditions: string[] = [];

	if (scriptId) {
		const escapedScriptId = scriptId.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype = (SELECT s_sub.id FROM Script s_sub WHERE s_sub.scriptid = '${escapedScriptId}' FETCH FIRST 1 ROWS ONLY)`,
		);
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
	} else if (!dateTo) {
		// SAFE Guide performance optimization: partition pruning defaults to last 7 days
		conditions.push("sn.date >= SYSDATE - 7");
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
	let {
		recordType,
		recordId,
		format,
		linesMode,
		maxLines,
		lineFields,
		includeLines,
		nonEmptyOnly,
	} = parsed.data;

	const shouldIncludeLines = includeLines !== false && linesMode !== "none";

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
			recordId,
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

		if (unwrapped.success === false) {
			const errMsg =
				(unwrapped.error as string) ||
				(unwrapped.message as string) ||
				JSON.stringify(unwrapped);
			return textResult(
				`❌ NetSuite Record Inspection Failed: ${errMsg}`,
				true,
			);
		}

		// Unwrap nested data payload if present (NetSuite REST API returns { success: true, data: { ... } })
		const recordData =
			unwrapped.data &&
			typeof unwrapped.data === "object" &&
			!Array.isArray(unwrapped.data)
				? (unwrapped.data as Record<string, unknown>)
				: unwrapped;

		// Separate system fields vs custom fields vs sublists vs false flags
		const systemFields: Record<string, unknown> = {};
		const customFields: Record<string, unknown> = {};
		const rawSublists: Record<string, unknown> = {};
		const systemFalseFlags: string[] = [];
		const customFalseFlags: string[] = [];

		for (const [key, val] of Object.entries(recordData)) {
			if (
				nonEmptyOnly &&
				(val === null ||
					val === undefined ||
					val === "" ||
					(Array.isArray(val) && val.length === 0) ||
					(typeof val === "object" &&
						val !== null &&
						"totalResults" in val &&
						(val as { totalResults: number }).totalResults === 0))
			) {
				continue;
			}

			const isFalseFlag = val === false || val === "F";
			const lowerKey = key.toLowerCase();
			if (
				lowerKey.startsWith("custbody") ||
				lowerKey.startsWith("custentity") ||
				lowerKey.startsWith("custrecord") ||
				lowerKey.startsWith("custcol") ||
				lowerKey.startsWith("custitem") ||
				lowerKey.startsWith("custevent")
			) {
				if (isFalseFlag) {
					customFalseFlags.push(key);
				} else {
					customFields[key] = val;
				}
			} else if (
				Array.isArray(val) ||
				(typeof val === "object" &&
					val !== null &&
					"items" in val &&
					Array.isArray((val as { items: unknown[] }).items)) ||
				(typeof val === "object" &&
					val !== null &&
					!("id" in val && Object.keys(val).length <= 2))
			) {
				if (shouldIncludeLines) {
					rawSublists[key] = val;
				}
			} else {
				if (isFalseFlag) {
					systemFalseFlags.push(key);
				} else {
					systemFields[key] = val;
				}
			}
		}

		// Process sublists
		const sublistsDetail: Record<string, Array<Record<string, unknown>>> = {};
		const sublistsSummary: Record<
			string,
			{ count: number; sampleColumns: string[] }
		> = {};

		if (shouldIncludeLines && Object.keys(rawSublists).length > 0) {
			for (const [sublistName, val] of Object.entries(rawSublists)) {
				let items: unknown[] | null = null;
				if (Array.isArray(val)) {
					items = val;
				} else if (
					typeof val === "object" &&
					val !== null &&
					"items" in val &&
					Array.isArray((val as { items: unknown[] }).items)
				) {
					items = (val as { items: unknown[] }).items;
				}

				if (items) {
					const sampleKeys =
						items.length > 0 &&
						typeof items[0] === "object" &&
						items[0] !== null
							? Object.keys(items[0]).filter(
									(k) =>
										(items[0] as Record<string, unknown>)[k] !== null &&
										(items[0] as Record<string, unknown>)[k] !== "",
								)
							: [];
					sublistsSummary[sublistName] = {
						count: items.length,
						sampleColumns: sampleKeys.slice(0, 15),
					};

					if (linesMode === "all") {
						const projectedRows: Array<Record<string, unknown>> = [];
						for (const item of items.slice(0, maxLines)) {
							if (typeof item !== "object" || item === null) continue;
							const itemObj = item as Record<string, unknown>;
							const cleanedRow: Record<string, unknown> = {};
							for (const [k, v] of Object.entries(itemObj)) {
								if (
									lineFields &&
									lineFields.length > 0 &&
									!lineFields.includes(k)
								) {
									continue;
								}
								if (
									nonEmptyOnly &&
									(v === null || v === undefined || v === "")
								) {
									continue;
								}
								cleanedRow[k] = v;
							}
							projectedRows.push(cleanedRow);
						}
						sublistsDetail[sublistName] = projectedRows;
					}
				}
			}
		}

		// If compact_json format is requested
		if (format === "compact_json") {
			const compactJsonResult: Record<string, unknown> = {
				recordType,
				recordId,
				systemFields,
				customFields,
			};
			if (systemFalseFlags.length > 0) {
				compactJsonResult.systemFalseFlags = systemFalseFlags;
			}
			if (customFalseFlags.length > 0) {
				compactJsonResult.customFalseFlags = customFalseFlags;
			}
			if (shouldIncludeLines) {
				if (linesMode === "all") {
					compactJsonResult.sublists = sublistsDetail;
				} else {
					compactJsonResult.sublistsSummary = sublistsSummary;
				}
			}
			return textResult(JSON.stringify(compactJsonResult, null, 2));
		}

		// Otherwise format as Markdown (default)
		let md = `## 🔍 NetSuite Record Inspection: \`${recordType}\` (ID: ${recordId})\n\n`;

		// Format system fields table
		const sysTotal = Object.keys(systemFields).length + systemFalseFlags.length;
		md += `### 📋 System Header Fields (${sysTotal})\n`;
		if (Object.keys(systemFields).length > 0) {
			md += `| Field ID | Value |\n|---|---|\n`;
			for (const [k, v] of Object.entries(systemFields)) {
				const displayVal =
					typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
				md += `| \`${k}\` | ${displayVal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
			}
		}
		if (systemFalseFlags.length > 0) {
			md += `\n> 🔘 **Unchecked / False Flags (${systemFalseFlags.length})**: \`${systemFalseFlags.join("`, `")}\`\n\n`;
		}

		// Format custom fields table
		const custTotal =
			Object.keys(customFields).length + customFalseFlags.length;
		md += `### 🏷️ Custom Fields (${custTotal})\n`;
		if (
			Object.keys(customFields).length === 0 &&
			customFalseFlags.length === 0
		) {
			md += `*(No populated custom fields found)*\n`;
		} else {
			if (Object.keys(customFields).length > 0) {
				md += `| Field ID | Value |\n|---|---|\n`;
				for (const [k, v] of Object.entries(customFields)) {
					const displayVal =
						typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
					md += `| \`${k}\` | ${displayVal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
				}
			}
			if (customFalseFlags.length > 0) {
				md += `\n> 🔘 **Unchecked / False Flags (${customFalseFlags.length})**: \`${customFalseFlags.join("`, `")}\`\n\n`;
			}
		}

		// Format sublists overview or detailed rows
		if (shouldIncludeLines && Object.keys(rawSublists).length > 0) {
			if (linesMode === "all") {
				md += `\n### 📦 Sublists & Line Details (up to ${maxLines} rows/list)\n`;
				for (const [sublistName, rows] of Object.entries(sublistsDetail)) {
					const totalCount = sublistsSummary[sublistName]?.count ?? rows.length;
					md += `\n#### Sublist: \`${sublistName}\` (Showing ${rows.length} of ${totalCount} rows)\n`;
					if (rows.length === 0) {
						md += `*(Empty sublist)*\n`;
					} else {
						const allCols = Array.from(
							new Set(rows.flatMap((r) => Object.keys(r))),
						);
						md += `| # | ${allCols.map((c) => `\`${c}\``).join(" | ")} |\n`;
						md += `|---|${allCols.map(() => "---").join("|")}|\n`;
						rows.forEach((r, idx) => {
							const rowVals = allCols.map((col) => {
								const val = r[col];
								if (val === undefined || val === null) return "";
								return typeof val === "object"
									? JSON.stringify(val)
									: String(val);
							});
							md += `| ${idx + 1} | ${rowVals.map((v) => v.replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |\n`;
						});
					}
				}
			} else {
				md += `\n### 📦 Sublists & Lines Summary\n`;
				for (const [sublistName, summary] of Object.entries(sublistsSummary)) {
					md += `- **\`${sublistName}\`** (${summary.count} rows)\n`;
					if (summary.sampleColumns.length > 0) {
						md += `  - Populated Columns in Row 1: \`${summary.sampleColumns.join("`, `")}\`${summary.sampleColumns.length >= 15 ? "..." : ""}\n`;
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

const TRANSACTION_RECORD_TYPES = new Set([
	"transaction",
	"salesorder",
	"invoice",
	"itemfulfillment",
	"itemreceipt",
	"purchaseorder",
	"cashsale",
	"cashrefund",
	"creditmemo",
	"vendorbill",
	"vendorpayment",
	"vendorcredit",
	"customerpayment",
	"customerrefund",
	"customerdeposit",
	"deposit",
	"check",
	"estimate",
	"opportunity",
	"journalentry",
	"inventoryadjustment",
	"inventorytransfer",
	"transferorder",
	"returnauthorization",
	"vendorreturnauthorization",
	"workorder",
	"assemblybuild",
	"assemblyunbuild",
]);

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
	let { recordId, recordType, limit } = parsed.data;
	let recordTypeId: number | undefined;

	if (recordType && TRANSACTION_RECORD_TYPES.has(recordType.toLowerCase())) {
		recordTypeId = -30;
	}

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
				recordTypeId = -30; // Resolved from transaction table
			} else {
				return textResult(
					`❌ Record '${recordId}' could not be resolved to a numeric internal ID. Please verify the document number (tranid) or provide the numeric internal ID directly.`,
					true,
				);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return textResult(
				`❌ Failed to resolve document number '${recordId}': ${msg}`,
				true,
			);
		}
	}

	const whereConditions: string[] = [];
	if (recordTypeId !== undefined) {
		whereConditions.push(`sn.recordtypeid = ${recordTypeId}`);
	}
	whereConditions.push(`sn.recordid = ${recordId}`);

	// Standalone query complying with SAFE Guide Pitfall 11
	// Optimized: composite index prefix (sn.recordtypeid), primary key ordering (ORDER BY sn.id DESC), and second-level timestamp formatting
	const sql = `SELECT sn.id, TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date, sn.field, sn.oldvalue, sn.newvalue, sn.name AS author_id, BUILTIN.DF(sn.name) AS author_name, BUILTIN.DF(sn.role) AS role_name FROM systemnote sn WHERE ${whereConditions.join(" AND ")} ORDER BY sn.id DESC FETCH FIRST ${limit} ROWS ONLY`;

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
		authId: customAuthId,
		dryRun,
		skipValidation,
		allowProduction,
	} = parsed.data;

	const currentAccountId = (await oauthManager.getAccountId()) || "UNKNOWN";
	const isProd = !isSandboxAccount(currentAccountId);

	// 1. Resolve Project Root
	let firstPathCandidate = Array.isArray(paths) ? paths[0] : paths;
	if (firstPathCandidate && typeof firstPathCandidate === "string") {
		firstPathCandidate = firstPathCandidate.split(/[\s,]+/)[0];
	}

	let candidateStartDir = customProjectPath;
	if (
		!candidateStartDir &&
		firstPathCandidate &&
		path.isAbsolute(firstPathCandidate)
	) {
		candidateStartDir = path.dirname(firstPathCandidate);
	}
	if (!candidateStartDir) {
		candidateStartDir = defaultProjectRoot;
	}

	const resolvedProjectRoot =
		suitecloudRunnerService.findSdfProjectRoot(
			candidateStartDir,
			currentAccountId,
		) || candidateStartDir;

	// 2. Resolve and inspect target files
	const resolution = suitecloudRunnerService.resolveUploadFiles(
		resolvedProjectRoot,
		paths,
		{ skipValidation },
	);

	if (resolution.files.length === 0) {
		return textResult(
			`❌ 未找到待上传的文件。\n` +
				`输入路径: ${JSON.stringify(paths)}\n` +
				`解析工程根目录: \`${resolvedProjectRoot}\`\n` +
				`提示: 请确认文件存在于项目的 FileCabinet 结构下，或直接传入文件的绝对路径。`,
			true,
		);
	}

	// 3. Check for missing files
	const missingFiles = resolution.files.filter((f) => !f.exists);
	if (missingFiles.length > 0) {
		let missingMd = `❌ **部分或全部本地文件未找到 (404 Not Found)**\n\n`;
		missingMd += `SDF 项目根目录: \`${resolvedProjectRoot}\`\n\n`;
		missingMd += `| 请求路径 | 状态 | 详情 |\n|---|---|---|\n`;
		for (const mf of missingFiles) {
			missingMd += `| \`${mf.fileCabinetPath || "未知"}\` | ❌ 不存在 | ${mf.error || "未在项目内定位到对应文件"} |\n`;
		}
		missingMd += `\n💡 **排查建议**：\n`;
		missingMd += `1. 检查文件是否位于 \`${resolvedProjectRoot}/src/FileCabinet/\` 下。\n`;
		missingMd += `2. 可显式指定 \`projectPath\` 参数，例如 \`projectPath: "/path/to/sdf_project"\`。\n`;
		missingMd += `3. 也可以直接传入本地文件的绝对路径。`;
		return textResult(missingMd, true);
	}

	// 4. Pre-flight Syntax & Validation Check (unless skipValidation)
	const invalidFiles = resolution.files.filter((f) => f.syntaxValid === false);
	if (invalidFiles.length > 0 && !skipValidation) {
		let syntaxMd = `🚨 **SuiteScript 代码预检失败 (Pre-flight Syntax Error)**\n\n`;
		syntaxMd += `在尝试上传前，检测到待上传的脚本存在明显的 JavaScript 语法错误，上传到 NetSuite 会导致脚本编译或运行时异常：\n\n`;
		for (const inv of invalidFiles) {
			syntaxMd += `### 📄 \`${inv.fileCabinetPath}\`\n`;
			syntaxMd += `- **本地路径**: \`${inv.localFullPath}\`\n`;
			syntaxMd += `- **语法错误**: \`${inv.syntaxError}\`\n\n`;
		}
		syntaxMd += `💡 **处理方式**：请先修正上述语法错误。若确定无需预检，可指定 \`skipValidation: true\` 强制跳过。`;
		return textResult(syntaxMd, true);
	}

	// 5. SuiteCloud Auth ID Verification and Auto-Synchronization
	const authSync = await suitecloudRunnerService.syncProjectAuthId(
		resolvedProjectRoot,
		currentAccountId,
		customAuthId,
	);

	const effectiveAuthId =
		authSync.matchedAuthId || authSync.configuredAuthId || "UNKNOWN";

	// 6. Production Safety Check (Rule 3)
	if (isProd && !allowProduction) {
		let prodMd = `🚨 **生产环境安全拦截 (Production Safety Block)**\n\n`;
		prodMd += `当前目标 NetSuite 账号为**生产环境** (\`${currentAccountId.toUpperCase()}\`)。\n`;
		prodMd += `为防止误操作覆盖生产代码，需获得用户明确授权。\n\n`;
		prodMd += `### 待上传文件清单（共 ${resolution.files.length} 个文件，${(resolution.totalBytes / 1024).toFixed(2)} KB）：\n`;
		for (const f of resolution.files) {
			prodMd += `- \`${f.fileCabinetPath}\` (${f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : 0} KB)\n`;
		}
		prodMd += `\n若用户已明确指示上传到生产环境，请设置 \`allowProduction: true\` 重新调用此工具，即可直接一步执行上传。`;
		return textResult(prodMd, true);
	}

	// Array of normalized FileCabinet paths
	const uploadFcPaths = resolution.files.map((f) => f.fileCabinetPath || "");

	// 7. Dry Run Preview
	if (dryRun) {
		let previewMd = `## 🔍 SuiteCloud File Upload Preview (Dry Run)\n\n`;
		previewMd += `| 配置项 | 详情 |\n|---|---|\n`;
		previewMd += `| **目标账号** | \`${currentAccountId.toUpperCase()}\` (${isProd ? "🚨 PRODUCTION" : "🛡️ SANDBOX"}) |\n`;
		previewMd += `| **SDF 项目目录** | \`${resolvedProjectRoot}\` |\n`;
		previewMd += `| **SuiteCloud Auth ID** | \`${effectiveAuthId}\` ${authSync.autoUpdated ? "(已自动对齐)" : ""} |\n`;
		previewMd += `| **文件总数 / 总大小** | ${resolution.files.length} 个文件 / ${(resolution.totalBytes / 1024).toFixed(2)} KB |\n`;
		previewMd += `| **执行命令预览** | \`suitecloud file:upload --paths "${uploadFcPaths.join(" ")}"\` |\n\n`;

		previewMd += `### 📋 文件详情清单\n\n`;
		previewMd += `| # | File Cabinet 目标路径 | 本地文件位置 | 大小 | 脚本类型 / API 版本 | 预检状态 |\n|---|---|---|---|---|---|\n`;
		resolution.files.forEach((f, idx) => {
			const sizeKb =
				f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : "0";
			const scriptInfo =
				[f.scriptType, f.apiVersion ? `v${f.apiVersion}` : ""]
					.filter(Boolean)
					.join(" / ") || "-";
			const status = f.syntaxValid === false ? "❌ 语法错误" : "✅ 正常";
			previewMd += `| ${idx + 1} | \`${f.fileCabinetPath}\` | \`${f.localFullPath}\` | ${sizeKb} KB | ${scriptInfo} | ${status} |\n`;
		});

		if (authSync.warning) {
			previewMd += `\n> [!WARNING]\n> ${authSync.warning}\n`;
		}
		if (resolution.warnings.length > 0) {
			previewMd += `\n> [!NOTE]\n> ${resolution.warnings.join("\n> ")}\n`;
		}

		return textResult(previewMd);
	}

	// 8. Execute the upload via SuiteCloud CLI
	const execResult = await suitecloudRunnerService.executeUpload(
		resolvedProjectRoot,
		uploadFcPaths,
		{
			targetAccountId: currentAccountId,
			authId: effectiveAuthId,
		},
	);

	if (!execResult.success) {
		let errorMd = `❌ **SuiteCloud Upload 失败 (耗时: ${execResult.executionTimeMs}ms)**\n\n`;
		errorMd += `- **目标账号**: \`${currentAccountId.toUpperCase()}\`\n`;
		errorMd += `- **使用的 Auth ID**: \`${effectiveAuthId}\`\n`;
		errorMd += `- **SDF 项目根目录**: \`${resolvedProjectRoot}\`\n\n`;
		errorMd += `### CLI 原始错误输出：\n\`\`\`\n${execResult.stderr || execResult.stdout}\n\`\`\`\n\n`;

		if (execResult.diagnostics && execResult.diagnostics.length > 0) {
			errorMd += `💡 **智能自愈与排查指南：**\n`;
			execResult.diagnostics.forEach((diag) => {
				errorMd += `${diag}\n\n`;
			});
		}

		return textResult(errorMd, true);
	}

	// 9. Success response formatting
	let successMd = `✅ **SuiteCloud File Upload Succeeded / 上传成功 (Time: ${execResult.executionTimeMs}ms)**\n\n`;
	successMd += `| 属性 | 信息 |\n|---|---|\n`;
	successMd += `| **目标账号** | \`${currentAccountId.toUpperCase()}\` (${isProd ? "🚨 PRODUCTION" : "🛡️ SANDBOX"}) |\n`;
	successMd += `| **使用的 Auth ID** | \`${effectiveAuthId}\` |\n`;
	successMd += `| **成功上传文件数** | ${resolution.files.length} 个文件 (${(resolution.totalBytes / 1024).toFixed(2)} KB) |\n`;
	successMd += `| **SDF 项目目录** | \`${resolvedProjectRoot}\` |\n\n`;

	successMd += `### 📄 已上传文件列表\n`;
	for (const f of resolution.files) {
		const sizeKb =
			f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : "0";
		successMd += `- \`${f.fileCabinetPath}\` (${sizeKb} KB) ➔ \`${f.localFullPath}\`\n`;
	}

	if (execResult.stdout.trim().length > 0) {
		successMd += `\n### CLI 输出：\n\`\`\`\n${execResult.stdout.trim()}\n\`\`\`\n`;
	}

	return textResult(successMd);
}

async function handleGetErrorSummary(
	args: Record<string, unknown>,
): Promise<ToolResponse> {
	const parsed = GetErrorSummaryArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	try {
		const summary = await summarizeToolErrors({
			days: parsed.data.days,
			tool: parsed.data.tool,
			category: parsed.data.category,
		});
		return textResult(formatSummaryToMarkdown(summary));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return textResult(`❌ Failed to summarize error logs: ${message}`, true);
	}
}

/** Normalize standard parameters (recordType, tableName, recordId, id, record_id, internalId). */
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

	const rawId =
		args.recordId ??
		args.id ??
		args.record_id ??
		args.internalId ??
		args.internal_id;
	if (rawId !== undefined && rawId !== null) {
		const strId = String(rawId).trim();
		if (strId.length > 0) {
			if (!args.recordId) args.recordId = strId;
			if (!args.id) args.id = strId;
		}
	}

	return args;
}

async function handleBatchExecute(
	args: Record<string, unknown>,
	deps: ToolHandlerDeps,
	onProgress?: (
		completed: number,
		total: number,
		message?: string,
	) => Promise<void>,
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

	const accountId =
		(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
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
		async (completed, total, result) => {
			if (onProgress) {
				const task = tasks[result.index];
				await onProgress(
					completed,
					total,
					`Executed ${task?.toolName || "tool"} (${completed}/${total})`,
				);
			}
		},
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
// Tool description & annotation enhancement helpers
// ---------------------------------------------------------------------------

/**
 * Generate standard MCP tool annotations.
 * - readOnlyHint: Indicates tool produces no side effects or data mutations.
 * - destructiveHint: Indicates tool mutates or deletes data.
 * - idempotentHint: Indicates calling repeatedly with identical arguments produces identical results.
 */
export function getToolAnnotations(name: string): Record<string, boolean> {
	const READ_ONLY_TOOLS = new Set([
		"ns_runCustomSuiteQL",
		"ns_getRecord",
		"ns_getRecordTypeMetadata",
		"ns_getSuiteQLMetadata",
		"ns_runReport",
		"ns_listAllReports",
		"ns_listSavedSearches",
		"ns_runSavedSearch",
		"ns_getSubsidiaries",
		"ns_getAccountingBooks",
		"ns_getAccountingContexts",
		"ns_getNexusIds",
		"netsuite_status",
		"netsuite_get_record_link",
		"netsuite_get_script_logs",
		"netsuite_inspect_record",
		"netsuite_get_record_definition",
		"netsuite_get_query_template",
		"netsuite_get_system_notes",
	]);

	const DESTRUCTIVE_TOOLS = new Set([
		"ns_createRecord",
		"ns_updateRecord",
		"netsuite_suitecloud_upload",
		"netsuite_logout",
	]);

	const IDEMPOTENT_TOOLS = new Set([
		...READ_ONLY_TOOLS,
		"netsuite_refresh_cache",
		"netsuite_logout",
	]);

	const isReadOnly = READ_ONLY_TOOLS.has(name);
	const isDestructive = DESTRUCTIVE_TOOLS.has(name);
	const isIdempotent = IDEMPOTENT_TOOLS.has(name);

	return {
		readOnlyHint: isReadOnly,
		...(isDestructive ? { destructiveHint: true } : {}),
		...(isIdempotent ? { idempotentHint: true } : {}),
	};
}

/** Append suffix to a tool's description string and attach MCP annotations. */
function enhanceDescription(
	tool: Record<string, unknown>,
	suffix: string,
): Record<string, unknown> {
	const toolName = (tool.name as string) || "";
	const desc = (tool.description as string) || "";
	const annotations = getToolAnnotations(toolName);
	return {
		...tool,
		description: desc ? `${desc}${suffix}` : suffix,
		annotations,
	};
}

/** Enhance fetched NetSuite tool descriptions with SuiteQL rules, annotations and parameter-level guidance. */
function enhanceToolDescriptions(
	tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return tools.map((t) => {
		const toolName = (t.name as string) || "";
		const annotations = getToolAnnotations(toolName);
		let enhanced: Record<string, unknown> = { ...t, annotations };

		if (t.name === "ns_runCustomSuiteQL") {
			enhanced = enhanceDescription(enhanced, SUITEQL_RULES_SUFFIX);
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
			enhanced = enhanceDescription(enhanced, METADATA_RULES_SUFFIX);
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
		return enhanced;
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Tools that are pruned from tools/list:
 * - Interactive MCP apps that require NetSuite web UI modal widgets and cause headless agent deadlocks
 * - Rarely used, low-value cascading report tools that can be directly queried via SuiteQL
 */
export const PRUNED_TOOLS = new Set([
	"ns_prompt_library_app",
	"ns_selector_app",
	"ns_report_filters_app",
	"ns_getAccountingContexts",
	"ns_getNexusIds",
]);

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

			// Filter write tools in production and prune useless/hazardous interactive tools
			const isSandbox = accountId ? isSandboxAccount(accountId) : false;
			const filteredTools = tools.filter((t) => {
				const toolName = (t.name as string) || "";
				if (PRUNED_TOOLS.has(toolName)) return false;
				if (
					!isSandbox &&
					(toolName === "ns_createRecord" || toolName === "ns_updateRecord")
				) {
					return false;
				}
				return true;
			});

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
		const callStartTime = Date.now();
		const { name, arguments: args } = request.params;
		const safeArgs = normalizeStandardArgs(
			(args || {}) as Record<string, unknown>,
		);

		const reqMeta = (
			request.params as { _meta?: { progressToken?: string | number } }
		)._meta;
		const progressToken = reqMeta?.progressToken;

		const reportProgress = async (
			progress: number,
			total?: number,
			message?: string,
		): Promise<void> => {
			if (progressToken === undefined || progressToken === null) return;
			try {
				await server.notification({
					method: "notifications/progress",
					params: {
						progressToken,
						progress,
						...(total !== undefined ? { total } : {}),
						...(message ? { message } : {}),
					},
				});
			} catch {
				// Notification failure is non-fatal
			}
		};

		const recordErrorIfPresent = async (
			res: CallToolResult,
			errorStack?: string,
		): Promise<CallToolResult> => {
			if (res.isError && name !== "netsuite_get_error_summary") {
				let currentAccountId: string | undefined;
				let currentEnv: "Sandbox" | "Production" | "Unknown" = "Unknown";
				try {
					const detectedId =
						(await oauthManager.getAccountId()) ||
						process.env.NETSUITE_ACCOUNT_ID;
					if (detectedId) {
						currentAccountId = detectedId;
						currentEnv = isSandboxAccount(detectedId)
							? "Sandbox"
							: "Production";
					}
				} catch {
					// Non-fatal
				}

				const errorText =
					res.content
						?.filter(
							(c): c is { type: "text"; text: string } => c.type === "text",
						)
						.map((c) => c.text)
						.join("\n") || "Unknown error";
				const category = classifyError(name, errorText);
				recordToolError({
					tool: name,
					accountId: currentAccountId,
					environment: currentEnv,
					durationMs: Date.now() - callStartTime,
					category,
					errorMessage: errorText,
					errorStack,
					parameters: safeArgs,
				});
			}
			return res;
		};

		try {
			const result = await (async (): Promise<CallToolResult> => {
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
				if (name === "netsuite_get_error_summary") {
					return await handleGetErrorSummary(safeArgs);
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
					return await handleBatchExecute(safeArgs, deps, reportProgress);
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

				// --- Defense for interactive _app tools in headless/coding environment ---
				if (
					name === "ns_prompt_library_app" ||
					name === "ns_selector_app" ||
					name === "ns_report_filters_app"
				) {
					return textResult(
						`⛔ [Interactive App Unsupported] The tool '${name}' is an interactive UI widget designed strictly for NetSuite web browser environments. It is not supported in headless agent environments to prevent task hanging. Please use 'ns_runCustomSuiteQL' or 'netsuite_inspect_record' instead.`,
						true,
					);
				}

				// --- Dual-Gate Defense: Strictly block write operations in production ---
				if (name === "ns_createRecord" || name === "ns_updateRecord") {
					const accountId =
						(await oauthManager.getAccountId()) ||
						process.env.NETSUITE_ACCOUNT_ID;
					if (!accountId || !isSandboxAccount(accountId)) {
						return textResult(
							`⛔ [Production Safety Violation] Operation '${name}' is strictly blocked in Production environment (${accountId || "unknown"}). ` +
								`Record create and update operations are only permitted in Sandbox / Test environments (accounts containing '_SB' or 'TSTDRV').`,
							true,
						);
					}
				}

				// --- Zero-friction document number (tranid) resolution for ns_getRecord ---
				if (name === "ns_getRecord") {
					const rawRecordId = String(
						safeArgs.recordId || safeArgs.id || "",
					).trim();
					if (rawRecordId && !/^\d+$/.test(rawRecordId)) {
						try {
							const lookupSql = `SELECT id, recordtype FROM transaction WHERE tranid = '${rawRecordId.replace(/'/g, "''")}' FETCH FIRST 1 ROWS ONLY`;
							const lookupRes = await mcpTools.executeTool(
								"ns_runCustomSuiteQL",
								{
									sqlQuery: lookupSql,
								},
							);
							const rows = mcpTools.extractDataArray(lookupRes);
							if (rows.length > 0 && rows[0]?.id) {
								safeArgs.recordId = String(rows[0].id);
								safeArgs.id = String(rows[0].id);
								if (rows[0].recordtype) {
									safeArgs.recordType = String(
										rows[0].recordtype,
									).toLowerCase();
								}
							}
						} catch {
							// Continue with original recordId if lookup fails
						}
					}
				}

				// --- Proxy to NetSuite MCP API ---
				let result: unknown;
				let executeError: unknown = null;

				if (name === "ns_runCustomSuiteQL") {
					await reportProgress(
						1,
						3,
						"Validating & optimizing SuiteQL query...",
					);
				}

				try {
					if (name === "ns_runCustomSuiteQL") {
						await reportProgress(
							2,
							3,
							"Executing SuiteQL query against NetSuite...",
						);
					}
					result = await mcpTools.executeTool(name, safeArgs);
					if (name === "ns_runCustomSuiteQL") {
						await reportProgress(
							3,
							3,
							"Formatting & slimming response payload...",
						);
					}
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
			})();

			return await recordErrorIfPresent(result);
		} catch (error: unknown) {
			// Let McpError propagate directly to the MCP SDK
			if (error instanceof ProtocolError) {
				throw error;
			}
			// All other errors: return as tool-level error response
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			let guidance = "";
			let finalRes: CallToolResult;
			if (isPermissionError(message)) {
				// DO NOT attach self-healing guidance on permission errors
				if (!message.includes("PERMISSION DENIED — HARD STOP REQUIRED")) {
					guidance = `\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`;
				}
				finalRes = textResult(`❌ Error: ${message}${guidance}`, true);
			} else if (name === "ns_runCustomSuiteQL") {
				const sqlQuery = (safeArgs.sqlQuery ||
					safeArgs.query ||
					safeArgs.sql ||
					"") as string;
				finalRes = textResult(
					formatSuiteQLErrorResponse(message, sqlQuery),
					true,
				);
			} else if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				guidance =
					"\n\n💡 [Self-Healing Action]: Call `ns_getRecordTypeMetadata` to check schema constraints and valid field IDs.";
				finalRes = textResult(`❌ Error: ${message}${guidance}`, true);
			} else {
				finalRes = textResult(`❌ Error: ${message}`, true);
			}
			return await recordErrorIfPresent(finalRes, stack);
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
