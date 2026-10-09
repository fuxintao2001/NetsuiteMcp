import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import { isSandboxAccount } from "../utils/environment.js";
import {
	formatTableCatalogMarkdown,
	searchSuiteQLCatalog,
	unwrapMcpContent,
} from "../utils/metadata.js";
import { generateNetSuiteUrl } from "../utils/netsuiteUrls.js";
import {
	type RecordFieldMeta,
	recordsReferenceService,
} from "../utils/recordsReference.js";
import {
	CreateRecordArgsSchema,
	GetMetadataArgsSchema,
	GetRecordArgsSchema,
	GetSystemNotesArgsSchema,
	UpdateRecordArgsSchema,
} from "./toolSchemas.js";
import { textResult } from "./types.js";

type ToolResponse = CallToolResult;

/**
 * Resolves natural keys (document tranid, entity entityid, item itemid) to numeric internal ID via 1-turn SuiteQL.
 */
export async function resolveNaturalKeyToInternalId(
	recordType: string,
	naturalKey: string,
	mcpTools: NetSuiteMCPTools,
): Promise<{ id: string; recordType?: string | undefined } | null> {
	const safeKey = naturalKey.replace(/'/g, "''").trim();
	if (!safeKey || !recordType) return null;

	const recType = recordType.toLowerCase().trim();

	// 1. Transaction types: search transaction by tranid
	const isTransaction = [
		"salesorder",
		"invoice",
		"purchaseorder",
		"estimate",
		"opportunity",
		"customerpayment",
		"vendorbill",
		"vendorpayment",
		"creditmemo",
		"itemfulfillment",
		"itemreceipt",
		"returnauthorization",
		"journalentry",
		"transferorder",
		"transaction",
	].includes(recType);

	if (isTransaction) {
		try {
			const typeFilter =
				recType !== "transaction" ? `AND LOWER(type) = '${recType}'` : "";
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id, type, tranid FROM transaction WHERE UPPER(tranid) = '${upperKey}' ${typeFilter} ORDER BY id DESC FETCH FIRST 1 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return {
					id: String(rows[0].id),
					recordType: (rows[0].type as string)?.toLowerCase() || recordType,
				};
			}
		} catch {
			/* Lookup failed */
		}
		return null;
	}

	// 2. Custom record lookup by canonical name
	if (recType.startsWith("customrecord")) {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id, name FROM ${recType} WHERE UPPER(name) = '${upperKey}' ORDER BY id DESC FETCH FIRST 1 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: recType };
			}
		} catch {
			/* Lookup failed */
		}
		return null;
	}

	// 3. Customer / Vendor / Entity
	if (recType === "customer" || recType === "vendor" || recType === "entity") {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id FROM entity WHERE UPPER(entityid) = '${upperKey}' FETCH FIRST 1 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: recType };
			}
		} catch {
			/* Lookup failed */
		}
		return null;
	}

	// 4. Item
	if (recType === "item" || recType === "inventoryitem") {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id FROM item WHERE UPPER(itemid) = '${upperKey}' FETCH FIRST 1 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: "item" };
			}
		} catch {
			/* Lookup failed */
		}
		return null;
	}

	return null;
}

/**
 * Appends a clickable NetSuite Web UI link to the response text.
 */
export async function appendRecordLink(
	baseText: string,
	recordType: string,
	recordId: string,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<string> {
	try {
		const accountId = await oauthManager.getAccountId();
		if (!accountId) return baseText;

		let rectype: number | undefined;
		if (recordType.toLowerCase().startsWith("customrecord")) {
			rectype = (await resolveRectype(recordType)) ?? undefined;
		}

		const url = generateNetSuiteUrl(accountId, recordType, recordId, rectype);
		if (url) {
			return `${baseText}\n\n---\n🔗 **NetSuite UI Link**: [Open ${recordType} (${recordId}) in NetSuite](${url})`;
		}
	} catch {
		/* Non-fatal */
	}
	return baseText;
}

/**
 * netsuite_get_record
 * Authoritative tool for inspecting NetSuite records.
 * Integrates natural key resolution, structured field grouping, empty pruning, and active UI links.
 */
export async function handleGetRecord(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<ToolResponse> {
	const parsed = GetRecordArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}

	const {
		recordType,
		id: rawId,
		includeSublists,
		linesMode,
		maxLines,
		lineFields,
		format,
	} = parsed.data;
	let targetId = rawId.trim();

	// Auto-resolve document number (tranid) to numeric internal ID if needed
	if (!/^-?\d+$/.test(targetId)) {
		const resolved = await resolveNaturalKeyToInternalId(
			recordType,
			targetId,
			mcpTools,
		);
		if (resolved?.id) {
			targetId = resolved.id;
		} else {
			return textResult(
				`❌ [Record Not Found] Could not resolve document number / name '${rawId}' for record type '${recordType}'.\n` +
					`👉 Please verify the document number (tranid) or provide the numeric internal ID directly.`,
				true,
			);
		}
	}

	// Fetch record from NetSuite API
	let rawRecord: unknown;
	try {
		rawRecord = await mcpTools.executeTool("ns_getRecord", {
			recordType,
			recordId: targetId,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ NetSuite Record Fetch Failed: ${msg}`, true);
	}

	const unwrapped = (unwrapMcpContent(rawRecord) || rawRecord) as Record<
		string,
		unknown
	>;
	if (!unwrapped || typeof unwrapped !== "object") {
		return textResult(
			`❌ Record not found or invalid response for ${recordType} ID: ${targetId}`,
			true,
		);
	}

	if (unwrapped.success === false || unwrapped.error) {
		const errMsg =
			(unwrapped.error as string) ||
			(unwrapped.message as string) ||
			JSON.stringify(unwrapped);
		throw new Error(errMsg);
	}

	const recordData =
		unwrapped.data &&
		typeof unwrapped.data === "object" &&
		!Array.isArray(unwrapped.data)
			? (unwrapped.data as Record<string, unknown>)
			: unwrapped;

	// Separate system fields vs custom fields vs sublists vs false flags
	const systemFields: Record<string, unknown> = {};
	const customFields: Record<string, unknown> = {};
	const rawSublists: Record<string, unknown[]> = {};
	const systemFalseFlags: string[] = [];
	const customFalseFlags: string[] = [];

	for (const [key, val] of Object.entries(recordData)) {
		if (val === null || val === undefined || val === "") continue;

		const isFalseFlag = val === false || val === "F";
		const lowerKey = key.toLowerCase();
		if (
			lowerKey.startsWith("custbody") ||
			lowerKey.startsWith("custentity") ||
			lowerKey.startsWith("custrecord") ||
			lowerKey.startsWith("custcol") ||
			lowerKey.startsWith("custitem")
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
				Array.isArray((val as { items: unknown[] }).items))
		) {
			const items = Array.isArray(val)
				? val
				: (val as { items: unknown[] }).items;
			rawSublists[key] = items as unknown[];
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
	const sublistsSummary: Record<string, { count: number }> = {};

	for (const [sublistName, items] of Object.entries(rawSublists)) {
		sublistsSummary[sublistName] = { count: items.length };

		let processed = items.filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" && item !== null,
		);
		if (maxLines !== undefined && maxLines > 0) {
			processed = processed.slice(0, maxLines);
		}
		if (lineFields && lineFields.length > 0) {
			const fieldsSet = new Set(lineFields);
			processed = processed.map((row) => {
				const filteredRow: Record<string, unknown> = {};
				for (const [f, v] of Object.entries(row)) {
					if (fieldsSet.has(f)) filteredRow[f] = v;
				}
				return filteredRow;
			});
		}
		sublistsDetail[sublistName] = processed;
	}

	if (format === "compact_json") {
		const jsonOutput: Record<string, unknown> = {
			recordType,
			recordId: targetId,
			systemFields,
			customFields,
		};
		if (linesMode === "summary") {
			jsonOutput.sublistsSummary = sublistsSummary;
		} else if (includeSublists && Object.keys(sublistsDetail).length > 0) {
			jsonOutput.sublists = sublistsDetail;
		}
		let jsonStr = JSON.stringify(jsonOutput, null, 2);
		jsonStr = await appendRecordLink(
			jsonStr,
			recordType,
			targetId,
			oauthManager,
			resolveRectype,
		);
		return textResult(jsonStr);
	}

	// Markdown Format (Default)
	let md = `## 🔍 NetSuite Record Inspection: \`${recordType}\` (ID: \`${targetId}\`)\n\n`;

	// System Header Fields Table
	md += `### 📋 System & Header Fields\n`;
	if (Object.keys(systemFields).length > 0) {
		md += `| Field ID | Value |\n|:---|:---|\n`;
		for (const [k, v] of Object.entries(systemFields)) {
			const displayVal =
				typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
			md += `| \`${k}\` | ${displayVal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
		}
	} else {
		md += `*(No populated system fields)*\n`;
	}

	// Custom Fields Table
	if (Object.keys(customFields).length > 0) {
		md += `\n### 🏷️ Custom Fields (Tenant Extensions)\n`;
		md += `| Field ID | Value |\n|:---|:---|\n`;
		for (const [k, v] of Object.entries(customFields)) {
			const displayVal =
				typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
			md += `| \`${k}\` | ${displayVal.replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
		}
	}

	// Compact Unchecked / False Flags
	const totalFalseFlags = systemFalseFlags.length + customFalseFlags.length;
	if (totalFalseFlags > 0) {
		md += `\n### 🔲 Unchecked / False Flags (${totalFalseFlags})\n`;
		if (systemFalseFlags.length > 0) {
			md += `- **System**: \`${systemFalseFlags.join("`, `")}\`\n`;
		}
		if (customFalseFlags.length > 0) {
			md += `- **Custom**: \`${customFalseFlags.join("`, `")}\`\n`;
		}
	}

	// Sublists & Line Details
	if (includeSublists && Object.keys(sublistsDetail).length > 0) {
		md += `\n### 📦 Sublists & Line Details\n`;
		for (const [sublistName, rows] of Object.entries(sublistsDetail)) {
			md += `#### 🔹 Sublist: \`${sublistName}\` (${rows.length} lines)\n\n`;
			if (rows.length > 0 && rows[0]) {
				const headers = Object.keys(rows[0]);
				md += `| ${headers.join(" | ")} |\n`;
				md += `| ${headers.map(() => "---").join(" | ")} |\n`;
				for (const r of rows) {
					md += `| ${headers.map((h) => String(r[h] ?? "").replace(/\|/g, "\\|")).join(" | ")} |\n`;
				}
				md += "\n";
			}
		}
	}

	// Append active Web UI link
	md = await appendRecordLink(
		md,
		recordType,
		targetId,
		oauthManager,
		resolveRectype,
	);

	return textResult(md);
}

/**
 * netsuite_get_metadata
 * Single authoritative tool for inspecting NetSuite table schema, valid column names, and data types.
 * Powered by Redis cache and authoritative 272 records catalog.
 */
export async function handleGetMetadata(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = GetMetadataArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}

	const { table, keyword, source = "auto" } = parsed.data;

	// Case 1: Catalog search if table is missing
	if (!table) {
		const matches = searchSuiteQLCatalog(keyword);
		return textResult(formatTableCatalogMarkdown(matches, keyword));
	}

	const isCustom = table.toLowerCase().startsWith("customrecord");

	// Case 2: Explicit offline source routing or auto standard reference check
	if (source === "offline" || (source === "auto" && !isCustom)) {
		const def = recordsReferenceService.getRecordDefinition(table, keyword);
		if (def?.found && def.fields.length > 0) {
			let md = `## 📖 Official Records Definition: \`${table}\` (Offline Catalog)\n\n`;
			md += `*Total Fields: ${def.fields.length} standard fields identified.*\n\n`;
			md += `| Field ID | Type | Label | Required |\n|:---|:---|:---|:---|\n`;
			for (const f of def.fields as RecordFieldMeta[]) {
				md += `| \`${f.internalId}\` | ${f.type} | ${f.label} | ${f.required ? "Yes" : "No"} |\n`;
			}
			return textResult(md);
		}
	}

	// Case 3: Query remote SuiteQL / REST metadata
	try {
		const sqlMeta = await mcpTools.executeTool("ns_getSuiteQLMetadata", {
			recordType: table,
			keyword,
		});
		return textResult(formatMetadataToCompactMarkdown(sqlMeta));
	} catch (err: unknown) {
		// Fallback to offline catalog if remote fails
		const fallbackDef = recordsReferenceService.getRecordDefinition(
			table,
			keyword,
		);
		if (fallbackDef?.found && fallbackDef.fields.length > 0) {
			let md = `## 📖 Official Records Definition: \`${table}\` (Offline Catalog)\n\n`;
			md += `*Total Fields: ${fallbackDef.fields.length} standard fields identified.*\n\n`;
			md += `| Field ID | Type | Label | Required |\n|:---|:---|:---|:---|\n`;
			for (const f of fallbackDef.fields as RecordFieldMeta[]) {
				md += `| \`${f.internalId}\` | ${f.type} | ${f.label} | ${f.required ? "Yes" : "No"} |\n`;
			}
			return textResult(md);
		}

		const msg = err instanceof Error ? err.message : String(err);
		return textResult(
			`❌ Failed to inspect metadata for '${table}': ${msg}\n` +
				`👉 Tip: Call with keyword to search across available tables, or verify table name in NetSuite Records Catalog.`,
			true,
		);
	}
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

/**
 * netsuite_get_system_notes
 * Dedicated audit log query complying strictly with Oracle SAFE Guide Pitfall 11.
 */
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

	const isNumeric = /^-?\d+$/.test(recordId.trim());
	if (!isNumeric) {
		try {
			const safeTranid = recordId.trim().replace(/'/g, "''");
			const upperTranid = safeTranid.toUpperCase();
			const lookupSql = `SELECT id FROM transaction WHERE UPPER(tranid) = '${upperTranid}' FETCH FIRST 1 ROWS ONLY`;
			const lookupRes = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: lookupSql,
			});
			const rows = mcpTools.extractDataArray(lookupRes);
			if (rows.length > 0 && rows[0]?.id) {
				recordId = String(rows[0].id);
				recordTypeId = -30;
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

	const sql = `SELECT sn.id, TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date, sn.field, sn.oldvalue, sn.newvalue, sn.name AS author_id, BUILTIN.DF(sn.name) AS author_name, BUILTIN.DF(sn.role) AS role_name FROM systemnote sn WHERE ${whereConditions.join(" AND ")} ORDER BY sn.id DESC FETCH FIRST ${limit} ROWS ONLY`;

	try {
		const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: sql,
		});
		const rows = mcpTools.extractDataArray(res);

		if (rows.length === 0) {
			return textResult(`ℹ️ No system notes found for record ID ${recordId}.`);
		}

		let md = `## 🕵️ System Notes Audit Trail (Record ID: \`${recordId}\`, ${rows.length} changes)\n\n`;
		md += `| Timestamp | Author | Role | Field | Old Value | New Value |\n|:---|:---|:---|:---|:---|:---|\n`;

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

/**
 * netsuite_create_record
 * Authoritative tool for creating NetSuite records in Sandbox / Test environments.
 * Dual-Gate Defense: Strictly blocked in Production accounts.
 */
export async function handleCreateRecord(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<ToolResponse> {
	const parsed = CreateRecordArgsSchema.safeParse(args);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join(", ");
		return textResult(
			`❌ Invalid arguments for 'netsuite_create_record': ${issues}`,
			true,
		);
	}

	const accountId =
		(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
	if (!accountId || !isSandboxAccount(accountId)) {
		return textResult(
			`⛔ [Production Safety Violation] Operation 'netsuite_create_record' is strictly blocked in Production environment (${accountId || "unknown"}). ` +
				`Record create and update operations are only permitted in Sandbox / Test environments (accounts containing '_SB', '-sb', or 'TSTDRV').`,
			true,
		);
	}

	const { recordType, record, ...rest } = parsed.data;
	const recordPayload =
		record && typeof record === "object" && Object.keys(record).length > 0
			? record
			: rest;

	let rawResult: unknown;
	try {
		rawResult = await mcpTools.executeTool("ns_createRecord", {
			recordType,
			...recordPayload,
			record: recordPayload,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ NetSuite Record Creation Failed: ${msg}`, true);
	}

	const unwrapped = (unwrapMcpContent(rawResult) || rawResult) as Record<
		string,
		unknown
	>;
	if (
		unwrapped &&
		typeof unwrapped === "object" &&
		(unwrapped.success === false || unwrapped.error)
	) {
		const errMsg =
			(unwrapped.error as string) ||
			(unwrapped.message as string) ||
			JSON.stringify(unwrapped);
		return textResult(`❌ NetSuite Record Creation Error: ${errMsg}`, true);
	}

	const cleaned = cleanRecordPayload(unwrapped);
	const targetId = String(
		(unwrapped as Record<string, unknown>)?.id ??
			(unwrapped as Record<string, unknown>)?.recordId ??
			((unwrapped as Record<string, unknown>)?.data as Record<string, unknown>)
				?.id ??
			"",
	);

	let md = `## ✅ NetSuite Record Created: \`${recordType}\`${targetId ? ` (ID: \`${targetId}\`)` : ""}\n\n`;
	md += `\`\`\`json\n${JSON.stringify(cleaned, null, 2)}\n\`\`\`\n`;

	if (targetId) {
		md = await appendRecordLink(
			md,
			recordType,
			targetId,
			oauthManager,
			resolveRectype,
		);
	}

	return textResult(md);
}

/**
 * netsuite_update_record
 * Authoritative tool for updating NetSuite records in Sandbox / Test environments.
 * Dual-Gate Defense: Strictly blocked in Production accounts.
 */
export async function handleUpdateRecord(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<ToolResponse> {
	const parsed = UpdateRecordArgsSchema.safeParse(args);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `${i.path.join(".")}: ${i.message}`)
			.join(", ");
		return textResult(
			`❌ Invalid arguments for 'netsuite_update_record': ${issues}`,
			true,
		);
	}

	const accountId =
		(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
	if (!accountId || !isSandboxAccount(accountId)) {
		return textResult(
			`⛔ [Production Safety Violation] Operation 'netsuite_update_record' is strictly blocked in Production environment (${accountId || "unknown"}). ` +
				`Record create and update operations are only permitted in Sandbox / Test environments (accounts containing '_SB', '-sb', or 'TSTDRV').`,
			true,
		);
	}

	const { recordType, id: rawId, record, ...rest } = parsed.data;
	let targetId = rawId;

	// Resolve natural key (e.g. SO10023) if not pure numeric
	if (!/^-?\d+$/.test(targetId)) {
		const resolved = await resolveNaturalKeyToInternalId(
			recordType,
			targetId,
			mcpTools,
		);
		if (resolved?.id) {
			targetId = resolved.id;
		} else {
			return textResult(
				`❌ [Record Not Found] Could not resolve document number / name '${rawId}' for record type '${recordType}'.\n` +
					`👉 Please verify the document number (tranid) or provide the numeric internal ID directly.`,
				true,
			);
		}
	}

	const recordPayload =
		record && typeof record === "object" && Object.keys(record).length > 0
			? record
			: rest;

	let rawResult: unknown;
	try {
		rawResult = await mcpTools.executeTool("ns_updateRecord", {
			recordType,
			recordId: targetId,
			id: targetId,
			...recordPayload,
			record: recordPayload,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ NetSuite Record Update Failed: ${msg}`, true);
	}

	const unwrapped = (unwrapMcpContent(rawResult) || rawResult) as Record<
		string,
		unknown
	>;
	if (
		unwrapped &&
		typeof unwrapped === "object" &&
		(unwrapped.success === false || unwrapped.error)
	) {
		const errMsg =
			(unwrapped.error as string) ||
			(unwrapped.message as string) ||
			JSON.stringify(unwrapped);
		return textResult(`❌ NetSuite Record Update Error: ${errMsg}`, true);
	}

	const cleaned = cleanRecordPayload(unwrapped);

	let md = `## ✅ NetSuite Record Updated: \`${recordType}\` (ID: \`${targetId}\`)\n\n`;
	md += `\`\`\`json\n${JSON.stringify(cleaned, null, 2)}\n\`\`\`\n`;

	md = await appendRecordLink(
		md,
		recordType,
		targetId,
		oauthManager,
		resolveRectype,
	);

	return textResult(md);
}
