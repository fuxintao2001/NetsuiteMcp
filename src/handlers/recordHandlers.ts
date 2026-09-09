import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";
import { unwrapMcpContent } from "../utils/metadata.js";
import { generateNetSuiteUrl } from "../utils/netsuiteUrls.js";
import { recordsReferenceService } from "../utils/recordsReference.js";
import {
	GetRecordDefinitionArgsSchema,
	GetRecordLinkArgsSchema,
	GetSystemNotesArgsSchema,
	InspectRecordArgsSchema,
} from "./toolSchemas.js";

type ToolResponse = CallToolResult;

function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

export async function handleGetRecordLink(
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

export async function handleInspectRecord(
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
			// OWASP injection prevention: sanitize and bound tranid
			const safeTranid = recordId.trim().replace(/'/g, "''");
			const lookupSql = `SELECT id, recordtype FROM transaction WHERE tranid = '${safeTranid}' FETCH FIRST 1 ROWS ONLY`;
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

export async function handleGetRecordDefinition(
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

export async function handleGetSystemNotes(
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
			const safeTranid = recordId.trim().replace(/'/g, "''");
			const lookupSql = `SELECT id FROM transaction WHERE tranid = '${safeTranid}' FETCH FIRST 1 ROWS ONLY`;
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

/** Append a NetSuite UI deep link to a record operation response. */
export async function appendRecordLink(
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
