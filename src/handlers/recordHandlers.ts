import type { CallToolResult } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import { isSandboxAccount } from "../utils/environment.js";
import { assertNoMcpError, isPermissionError } from "../utils/errors.js";
import {
	formatTableCatalogMarkdown,
	searchSuiteQLCatalog,
	unwrapMcpContent,
} from "../utils/metadata.js";
import { generateNetSuiteUrl } from "../utils/netsuiteUrls.js";
import {
	type RecordDefinitionResult,
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

interface RecordInspectOptions {
	includeSublists: boolean;
	linesMode: "all" | "summary";
	maxLines?: number | undefined;
	lineFields?: string[] | undefined;
	format: "markdown" | "compact_json";
}

const TRANSACTION_TYPE_MAP: Record<string, string> = {
	salesorder: "SalesOrd",
	invoice: "CustInvc",
	purchaseorder: "PurchOrd",
	estimate: "Estimate",
	opportunity: "Opprtnty",
	customerpayment: "CustPymt",
	vendorbill: "VendBill",
	vendorpayment: "VendPymt",
	creditmemo: "CustCred",
	itemfulfillment: "ItemShip",
	itemreceipt: "ItemRcpt",
	returnauthorization: "RtnAuth",
	journalentry: "Journal",
	transferorder: "TrnfrOrd",
};

function getTransactionTypeFilter(recType: string): string {
	if (recType === "transaction") return "";
	const mappedType = TRANSACTION_TYPE_MAP[recType];
	if (mappedType) {
		return `AND (type = '${mappedType}' OR LOWER(type) = '${recType}')`;
	}
	return `AND LOWER(type) = '${recType}'`;
}

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
			const typeFilter = getTransactionTypeFilter(recType);
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id, type, tranid FROM transaction WHERE UPPER(tranid) = '${upperKey}' ${typeFilter} ORDER BY id DESC FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return {
					id: String(rows[0].id),
					recordType: (rows[0].type as string)?.toLowerCase() || recordType,
				};
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	// 2. Custom record lookup by canonical name
	if (recType.startsWith("customrecord")) {
		if (!/^customrecord_[a-z0-9_]+$/i.test(recType)) {
			return null;
		}
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id, name FROM ${recType} WHERE UPPER(name) = '${upperKey}' ORDER BY id DESC FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: recType };
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	// 3. Customer / Vendor / Employee / Partner / Contact / Job / Entity
	const specificEntityTables = new Set([
		"customer",
		"vendor",
		"employee",
		"partner",
		"contact",
		"job",
	]);
	if (
		specificEntityTables.has(recType) ||
		recType === "lead" ||
		recType === "prospect" ||
		recType === "entity"
	) {
		try {
			const upperKey = safeKey.toUpperCase();
			const targetTable = specificEntityTables.has(recType)
				? recType
				: recType === "lead" || recType === "prospect"
					? "customer"
					: "entity";
			const sql = `SELECT id FROM ${targetTable} WHERE UPPER(entityid) = '${upperKey}' FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: recType };
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	// 4. Item
	if (ITEM_RECORD_TYPES.has(recType)) {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id FROM item WHERE UPPER(itemid) = '${upperKey}' FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: "item" };
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	// 5. Script Deployment (matches ScriptDeployment.scriptid e.g. customdeploy_xxx or title)
	const isDeployment = [
		"scriptdeployment",
		"deployment",
		"scriptdeploy",
	].includes(recType);
	if (isDeployment) {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT primarykey AS id, scriptid, title FROM ScriptDeployment WHERE UPPER(scriptid) = '${upperKey}' OR UPPER(title) = '${upperKey}' FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: "scriptdeployment" };
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	// 6. Script Record (matches Script.scriptid e.g. customscript_xxx or name)
	const isScript = [
		"script",
		"scriptrecord",
		"clientscript",
		"usereventscript",
		"suitelet",
		"restlet",
		"scheduledscript",
		"mapreducescript",
		"portlet",
		"massupdatescript",
		"workflowactionscript",
		"bundleinstallationscript",
		"sdfinstallationscript",
	].includes(recType);
	if (isScript) {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id, scriptid, name FROM Script WHERE UPPER(scriptid) = '${upperKey}' OR UPPER(name) = '${upperKey}' FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: "script" };
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	// 7. File Cabinet File (matches file.name e.g. script_file.js)
	if (recType === "file") {
		try {
			const upperKey = safeKey.toUpperCase();
			const sql = `SELECT id, name FROM file WHERE UPPER(name) = '${upperKey}' FETCH FIRST 2 ROWS ONLY`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0 && rows[0]?.id) {
				return { id: String(rows[0].id), recordType: "file" };
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			/* Lookup failed */
		}
		return null;
	}

	return null;
}

/**
 * Resolves an array of natural keys concurrently in a single batch SuiteQL query.
 */
export async function resolveNaturalKeysBatch(
	recordType: string,
	naturalKeys: string[],
	mcpTools: NetSuiteMCPTools,
): Promise<Map<string, { id: string; recordType?: string | undefined }>> {
	const resultMap = new Map<
		string,
		{ id: string; recordType?: string | undefined }
	>();
	const safeKeys = naturalKeys
		.map((k) => k.trim())
		.filter((k) => k.length > 0 && !/^-?\d+$/.test(k));

	if (safeKeys.length === 0 || !recordType) return resultMap;

	const recType = recordType.toLowerCase().trim();
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
			const typeFilter = getTransactionTypeFilter(recType);
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const sql = `SELECT id, type, tranid FROM transaction WHERE UPPER(tranid) IN (${inList}) ${typeFilter}`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const tranid = (row.tranid as string)?.toUpperCase();
				if (tranid && row.id) {
					resultMap.set(tranid, {
						id: String(row.id),
						recordType: (row.type as string)?.toLowerCase() || recordType,
					});
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	if (
		recType.startsWith("customrecord") &&
		/^customrecord_[a-z0-9_]+$/i.test(recType)
	) {
		try {
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const sql = `SELECT id, name FROM ${recType} WHERE UPPER(name) IN (${inList})`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const name = (row.name as string)?.toUpperCase();
				if (name && row.id) {
					resultMap.set(name, { id: String(row.id), recordType: recType });
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	const specificBatchEntityTables = new Set([
		"customer",
		"vendor",
		"employee",
		"partner",
		"contact",
		"job",
	]);
	if (
		specificBatchEntityTables.has(recType) ||
		recType === "lead" ||
		recType === "prospect" ||
		recType === "entity"
	) {
		try {
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const targetTable = specificBatchEntityTables.has(recType)
				? recType
				: recType === "lead" || recType === "prospect"
					? "customer"
					: "entity";
			const sql = `SELECT id, entityid FROM ${targetTable} WHERE UPPER(entityid) IN (${inList})`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const entityid = (row.entityid as string)?.toUpperCase();
				if (entityid && row.id) {
					resultMap.set(entityid, { id: String(row.id), recordType: recType });
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	if (ITEM_RECORD_TYPES.has(recType)) {
		try {
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const sql = `SELECT id, itemid FROM item WHERE UPPER(itemid) IN (${inList})`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const itemid = (row.itemid as string)?.toUpperCase();
				if (itemid && row.id) {
					resultMap.set(itemid, { id: String(row.id), recordType: "item" });
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	const isDeployment = [
		"scriptdeployment",
		"deployment",
		"scriptdeploy",
	].includes(recType);
	if (isDeployment) {
		try {
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const sql = `SELECT primarykey AS id, scriptid, title FROM ScriptDeployment WHERE UPPER(scriptid) IN (${inList}) OR UPPER(title) IN (${inList})`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const scriptid = (row.scriptid as string)?.toUpperCase();
				const title = (row.title as string)?.toUpperCase();
				if (row.id) {
					if (scriptid) {
						resultMap.set(scriptid, {
							id: String(row.id),
							recordType: "scriptdeployment",
						});
					}
					if (title) {
						resultMap.set(title, {
							id: String(row.id),
							recordType: "scriptdeployment",
						});
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	const isScript = [
		"script",
		"scriptrecord",
		"clientscript",
		"usereventscript",
		"suitelet",
		"restlet",
		"scheduledscript",
		"mapreducescript",
		"portlet",
		"massupdatescript",
		"workflowactionscript",
		"bundleinstallationscript",
		"sdfinstallationscript",
	].includes(recType);
	if (isScript) {
		try {
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const sql = `SELECT id, scriptid, name FROM Script WHERE UPPER(scriptid) IN (${inList}) OR UPPER(name) IN (${inList})`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const scriptid = (row.scriptid as string)?.toUpperCase();
				const name = (row.name as string)?.toUpperCase();
				if (row.id) {
					if (scriptid) {
						resultMap.set(scriptid, {
							id: String(row.id),
							recordType: "script",
						});
					}
					if (name) {
						resultMap.set(name, {
							id: String(row.id),
							recordType: "script",
						});
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	if (recType === "file") {
		try {
			const inList = safeKeys
				.map((k) => `'${k.replace(/'/g, "''").toUpperCase()}'`)
				.join(", ");
			const sql = `SELECT id, name FROM file WHERE UPPER(name) IN (${inList})`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			assertNoMcpError(res);
			const rows = mcpTools.extractDataArray(res);
			for (const row of rows) {
				const name = (row.name as string)?.toUpperCase();
				if (name && row.id) {
					resultMap.set(name, { id: String(row.id), recordType: "file" });
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
		}
		return resultMap;
	}

	return resultMap;
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
 * Core helper to fetch, clean, and format a single NetSuite record.
 */
async function inspectSingleRecord(
	recordType: string,
	rawId: string,
	options: RecordInspectOptions,
	mcpTools: NetSuiteMCPTools,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
	preResolved?: { id: string; recordType?: string | undefined },
): Promise<ToolResponse> {
	const { includeSublists, linesMode, maxLines, lineFields, format } = options;
	let targetId = rawId.trim();

	// Auto-resolve document number (tranid) to numeric internal ID if needed
	if (!/^-?\d+$/.test(targetId)) {
		if (preResolved?.id) {
			targetId = preResolved.id;
		} else {
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
		if (isPermissionError(msg)) {
			throw err;
		}
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
				if (format === "compact_json") {
					customFields[key] = val;
				}
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
				if (format === "compact_json") {
					systemFields[key] = val;
				}
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
		processed = processed.map(
			(row) => (cleanRecordPayload(row) || {}) as Record<string, unknown>,
		);
		sublistsDetail[sublistName] = processed;
	}

	if (format === "compact_json") {
		const jsonOutput: Record<string, unknown> = {
			recordType,
			recordId: targetId,
			systemFields,
			customFields,
			...(systemFalseFlags.length > 0 || customFalseFlags.length > 0
				? {
						uncheckedFlags: {
							system: systemFalseFlags,
							custom: customFalseFlags,
						},
					}
				: {}),
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
	if (linesMode === "summary" && Object.keys(sublistsSummary).length > 0) {
		md += `\n### 📦 Sublists Summary\n`;
		md += `| Sublist Name | Line Count |\n|:---|:---|\n`;
		for (const [sublistName, info] of Object.entries(sublistsSummary)) {
			md += `| \`${sublistName}\` | ${info.count} |\n`;
		}
	} else if (includeSublists && Object.keys(sublistsDetail).length > 0) {
		md += `\n### 📦 Sublists & Line Details\n`;
		for (const [sublistName, rows] of Object.entries(sublistsDetail)) {
			const totalCount = sublistsSummary[sublistName]?.count ?? rows.length;
			const isTruncated = totalCount > rows.length;
			md += `#### 🔹 Sublist: \`${sublistName}\` (Showing ${rows.length} of ${totalCount} lines${isTruncated ? " — TRUNCATED" : ""})\n\n`;
			if (rows.length > 0) {
				const headerSet = new Set<string>();
				for (const r of rows) {
					for (const k of Object.keys(r)) {
						headerSet.add(k);
					}
				}
				const headers = Array.from(headerSet);
				if (headers.length > 0) {
					md += `| ${headers.join(" | ")} |\n`;
					md += `| ${headers.map(() => "---").join(" | ")} |\n`;
					for (const r of rows) {
						md += `| ${headers
							.map((h) =>
								String(r[h] ?? "")
									.replace(/\|/g, "\\|")
									.replace(/\n/g, " "),
							)
							.join(" | ")} |\n`;
					}
					md += "\n";
				}
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
 * netsuite_get_record
 * Authoritative tool for inspecting one or multiple NetSuite records concurrently.
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
		ids: rawIds,
		includeSublists,
		linesMode,
		maxLines,
		lineFields,
		format,
	} = parsed.data;

	const targetIds: string[] = [];
	if (Array.isArray(rawIds) && rawIds.length > 0) {
		for (const item of rawIds) {
			const trimmed = item.trim();
			if (trimmed && !targetIds.includes(trimmed)) {
				targetIds.push(trimmed);
			}
		}
	}
	if (rawId && rawId.trim().length > 0) {
		const trimmed = rawId.trim();
		if (!targetIds.includes(trimmed)) {
			targetIds.unshift(trimmed);
		}
	}

	if (targetIds.length === 0) {
		return textResult(
			"❌ Invalid arguments: id is required (provide 'id' or 'ids')",
			true,
		);
	}

	const options: RecordInspectOptions = {
		includeSublists,
		linesMode,
		maxLines,
		lineFields,
		format,
	};

	if (targetIds.length === 1 && targetIds[0]) {
		return inspectSingleRecord(
			recordType,
			targetIds[0],
			options,
			mcpTools,
			oauthManager,
			resolveRectype,
		);
	}

	// Pre-resolve natural keys in batch if multiple IDs contain non-numeric keys
	let preResolvedMap = new Map<
		string,
		{ id: string; recordType?: string | undefined }
	>();
	if (targetIds.some((id) => !/^-?\d+$/.test(id))) {
		preResolvedMap = await resolveNaturalKeysBatch(
			recordType,
			targetIds,
			mcpTools,
		);
	}

	const parallelResults = await Promise.all(
		targetIds.map(async (itemId, index) => {
			try {
				const res = await inspectSingleRecord(
					recordType,
					itemId,
					options,
					mcpTools,
					oauthManager,
					resolveRectype,
					preResolvedMap.get(itemId.toUpperCase()),
				);
				const firstContent = res.content?.[0];
				const text =
					firstContent && firstContent.type === "text" ? firstContent.text : "";
				return {
					index: index + 1,
					id: itemId,
					isError: Boolean(res.isError),
					text,
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (isPermissionError(msg)) {
					throw err;
				}
				return {
					index: index + 1,
					id: itemId,
					isError: true,
					text: `❌ NetSuite Record Fetch Failed (${itemId}): ${msg}`,
				};
			}
		}),
	);

	let combinedOutput = `## 🔍 Parallel NetSuite Record Batch Inspection: \`${recordType}\` (${targetIds.length} Records)\n\n`;
	let failCount = 0;
	for (const res of parallelResults) {
		if (res.isError) failCount++;
		combinedOutput += `### 🔹 Record #${res.index} (\`${res.id}\`)\n\n${res.text}\n\n`;
	}

	return textResult(
		combinedOutput.trim(),
		failCount === parallelResults.length,
	);
}

/**
 * Formats offline record metadata into structured Markdown including sublists and relationships.
 */
function formatOfflineRecordMetadata(
	def: RecordDefinitionResult,
	table: string,
): string {
	let md = `## 📖 Official Records Definition: \`${table}\` (Offline Catalog)\n\n`;
	md += `> ℹ️ **Notice**: Showing standard built-in schema from offline catalog (fast cache). Tenant custom fields (\`custbody_*\`, \`custentity_*\`, \`custcol_*\`, etc.) are not included in offline reference. To inspect live tenant custom fields, invoke \`netsuite_get_metadata\` with \`source: 'remote'\`.\n\n`;
	if (def.description) {
		md += `> **Description**: ${def.description}\n\n`;
	}
	md += `*Total Fields: ${def.fields.length} standard fields identified.*\n\n`;
	md += `| Field ID | Type | Label | Required |\n|:---|:---|:---|:---|\n`;
	for (const f of def.fields as RecordFieldMeta[]) {
		md += `| \`${f.internalId}\` | ${f.type} | ${f.label} | ${f.required ? "Yes" : "No"} |\n`;
	}

	if (def.sublists && def.sublists.length > 0) {
		md += `\n### 📦 Official Sublists (${def.sublists.length})\n\n`;
		md += `| Sublist ID | Label |\n|:---|:---|\n`;
		for (const s of def.sublists) {
			md += `| \`${s.name}\` | ${s.label || s.name} |\n`;
		}
	}

	if (def.relations && def.relations.length > 0) {
		md += `\n### 🔗 Key Relationships (Primary & Foreign Keys)\n\n`;
		md += `| Field ID | Target Table | Type | Description |\n|:---|:---|:---|:---|\n`;
		for (const r of def.relations) {
			md += `| \`${r.field}\` | \`${r.targetTable}\` | ${r.type} | ${r.description || "-"} |\n`;
		}
	}

	return md;
}

/**
 * Core helper to inspect metadata for a single NetSuite table or record type.
 * Supports offline-first standard catalog, on-demand miss-driven remote refresh,
 * and explicit refresh invalidation.
 */
async function inspectSingleTableMetadata(
	table: string,
	keyword: string | undefined,
	source: "auto" | "offline" | "remote",
	mcpTools: NetSuiteMCPTools,
	refresh = false,
): Promise<ToolResponse> {
	const isCustom = table.toLowerCase().startsWith("customrecord");

	// 1. Explicit offline routing
	if (source === "offline") {
		const def = recordsReferenceService.getRecordDefinition(table, keyword);
		if (def?.found) {
			if (def.fields.length > 0) {
				return textResult(formatOfflineRecordMetadata(def, table));
			}
			return textResult(
				`## 📖 Official Records Definition: \`${table}\` (Offline Catalog)\n\n` +
					`> ℹ️ **Notice**: Table \`${table}\` is a standard NetSuite table, but **no standard fields matched the keyword "${keyword}"**.\n\n` +
					`> 📋 **Available Standard Fields (${def.totalFields})**: \`${def.fields
						.map((f) => f.internalId)
						.slice(0, 20)
						.join("`, `")}\`...\n\n` +
					`> 💡 **Tip**: If you are searching for tenant custom fields (\`custcol_*\`, \`custbody_*\`), query with \`source: 'remote'\` or omit source for miss-driven search.`,
			);
		}
	}

	// 2. Auto mode (Offline-first, Miss-driven on demand)
	if (source === "auto" && !isCustom && !refresh) {
		const def = recordsReferenceService.getRecordDefinition(table, keyword);
		if (def?.found) {
			// If keyword is omitted, or keyword matched standard fields, return offline instantly (0ms)!
			if (!keyword || def.fields.length > 0) {
				return textResult(formatOfflineRecordMetadata(def, table));
			}
			// Keyword WAS provided, but def.fields.length === 0 (not found in standard fields!)
			// This is the MISS TRIGGER: it may be a tenant custom field (custcol_*, custbody_*, etc.).
			// We fall through to remote SuiteQL metadata below to query/refresh live tenant schema!
		}
	}

	// 3. Query remote SuiteQL metadata (for custom records, explicit remote, refresh: true, or keyword miss trigger)
	try {
		if (refresh) {
			await mcpTools.clearTableMetadataCache(table);
		}
		const sqlMeta = await mcpTools.executeTool("ns_getSuiteQLMetadata", {
			recordType: table,
		});
		const formatted = formatMetadataToCompactMarkdown(sqlMeta, keyword);

		// If keyword was filtered and yielded no rows (only table header and divider returned):
		const rows = formatted
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("|"));
		if (keyword && rows.length <= 2) {
			const fallbackDef = recordsReferenceService.getRecordDefinition(table);
			let msg = `## 📖 Metadata Inspection: \`${table}\` (Real-Time Synchronized)\n\n`;
			msg += `> ℹ️ **Notice**: Synchronized latest schema from NetSuite. **No standard or custom fields matched the keyword "${keyword}"** on table \`${table}\`.\n\n`;
			if (fallbackDef?.found && fallbackDef.fields.length > 0) {
				msg += `> 📋 **Available Standard Fields (${fallbackDef.totalFields})**: \`${fallbackDef.fields
					.map((f) => f.internalId)
					.slice(0, 20)
					.join("`, `")}\`...\n\n`;
			}
			msg +=
				`> 💡 **Tip**: NetSuite custom fields carry mandatory prefixes:\n` +
				`- Transaction lines: \`custcol_*\`\n` +
				`- Transaction body: \`custbody_*\`\n` +
				`- Items / Master: \`custitem_*\`\n` +
				`- Custom records: \`custrecord_*\``;
			return textResult(msg);
		}

		return textResult(formatted);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isPermissionError(msg)) throw err;

		// Fallback to offline catalog if remote encounters an error
		const fallbackDef = recordsReferenceService.getRecordDefinition(
			table,
			keyword,
		);
		if (fallbackDef?.found) {
			if (fallbackDef.fields.length > 0) {
				let out = `⚠️ Remote metadata sync encountered: ${msg}. Showing offline standard catalog:\n\n`;
				out += formatOfflineRecordMetadata(fallbackDef, table);
				return textResult(out);
			}
			return textResult(
				`## 📖 Official Records Definition: \`${table}\` (Offline Catalog)\n\n` +
					`> ⚠️ Remote metadata sync encountered: ${msg}\n` +
					`> ℹ️ Table \`${table}\` is a standard NetSuite table, but **no standard fields matched the keyword "${keyword}"**.\n\n` +
					`> 📋 **Available Standard Fields (${fallbackDef.totalFields})**: \`${fallbackDef.fields
						.map((f) => f.internalId)
						.slice(0, 20)
						.join("`, `")}\`...`,
				false,
			);
		}

		return textResult(
			`❌ Failed to inspect metadata for '${table}': ${msg}\n` +
				`👉 Tip: Call with keyword to search across available tables, or verify table name in NetSuite Records Catalog.`,
			true,
		);
	}
}

/**
 * netsuite_get_metadata
 * Single authoritative tool for inspecting NetSuite table schema, valid column names, and data types.
 * Supports single-turn parallel inspection of multiple tables via 'tables'.
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

	const {
		table,
		tables,
		keyword,
		source = "auto",
		refresh = false,
	} = parsed.data;

	const targetTables: string[] = [];
	if (Array.isArray(tables) && tables.length > 0) {
		for (const tbl of tables) {
			if (tbl && !targetTables.includes(tbl)) {
				targetTables.push(tbl);
			}
		}
	}
	if (table && !targetTables.includes(table)) {
		targetTables.unshift(table);
	}

	// Case 1: Catalog search if no table is specified
	if (targetTables.length === 0) {
		const matches = searchSuiteQLCatalog(keyword);
		return textResult(formatTableCatalogMarkdown(matches, keyword));
	}

	if (targetTables.length === 1 && targetTables[0]) {
		return inspectSingleTableMetadata(
			targetTables[0],
			keyword,
			source,
			mcpTools,
			refresh,
		);
	}

	const parallelResults = await Promise.all(
		targetTables.map(async (tbl, index) => {
			const res = await inspectSingleTableMetadata(
				tbl,
				keyword,
				source,
				mcpTools,
				refresh,
			);
			const firstContent = res.content?.[0];
			const text =
				firstContent && firstContent.type === "text" ? firstContent.text : "";
			return {
				index: index + 1,
				table: tbl,
				isError: Boolean(res.isError),
				text,
			};
		}),
	);

	let combinedMd = `## 📚 Parallel Metadata Batch Inspection (${targetTables.length} Tables)\n\n`;
	let failCount = 0;
	for (const res of parallelResults) {
		if (res.isError) failCount++;
		combinedMd += `### 🔹 Table #${res.index}: \`${res.table}\`\n\n${res.text}\n\n`;
	}

	return textResult(combinedMd.trim(), failCount === parallelResults.length);
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

const ENTITY_RECORD_TYPES = new Set([
	"entity",
	"customer",
	"vendor",
	"employee",
	"contact",
	"partner",
	"lead",
	"prospect",
]);

const ITEM_RECORD_TYPES = new Set([
	"item",
	"inventoryitem",
	"noninventoryitem",
	"serviceitem",
	"assemblyitem",
	"kititem",
	"otherchargeitem",
	"giftcertificateitem",
]);

async function inspectSingleRecordSystemNotes(
	rawRecordId: string,
	recordType: string | undefined,
	limit: number,
	mcpTools: NetSuiteMCPTools,
	resolveRectype?: (type: string) => number | null | Promise<number | null>,
): Promise<string> {
	let recordId = rawRecordId.trim();
	let recordTypeId: number | undefined;

	if (recordType) {
		const lowerType = recordType.toLowerCase().trim();
		if (TRANSACTION_RECORD_TYPES.has(lowerType)) {
			recordTypeId = -30;
		} else if (ENTITY_RECORD_TYPES.has(lowerType)) {
			recordTypeId = -9;
		} else if (ITEM_RECORD_TYPES.has(lowerType)) {
			recordTypeId = -10;
		} else if (resolveRectype) {
			const resolved = await resolveRectype(recordType);
			if (resolved !== null && resolved !== undefined) {
				recordTypeId = resolved;
			}
		}
	}

	const isNumeric = /^-?\d+$/.test(recordId);
	if (!isNumeric) {
		try {
			const lookupType = recordType?.trim() || "transaction";
			const resolved = await resolveNaturalKeyToInternalId(
				lookupType,
				recordId,
				mcpTools,
			);
			if (resolved?.id) {
				recordId = resolved.id;
				if (recordTypeId === undefined && lookupType === "transaction") {
					recordTypeId = -30;
				}
			} else {
				return `❌ Record '${rawRecordId}' could not be resolved to a numeric internal ID. Please verify the document number (tranid) or provide the numeric internal ID directly.`;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			return `❌ Failed to resolve document number '${rawRecordId}': ${msg}`;
		}
	}

	const whereConditions: string[] = [];
	if (recordTypeId !== undefined) {
		whereConditions.push(`sn.recordtypeid = ${recordTypeId}`);
	}
	whereConditions.push(`sn.recordid = ${recordId}`);

	const sql = `SELECT sn.id, TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date, sn.field, sn.oldvalue, sn.newvalue, sn.name AS author_id, BUILTIN.DF(sn.name) AS author_name, BUILTIN.DF(sn.role) AS role_name FROM systemnote sn WHERE ${whereConditions.join(" AND ")} ORDER BY sn.id DESC FETCH FIRST ${limit} ROWS ONLY`;

	const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
		sqlQuery: sql,
	});
	assertNoMcpError(res);
	const rows = mcpTools.extractDataArray(res);

	if (rows.length === 0) {
		return `ℹ️ No system notes found for record ID ${recordId}.`;
	}

	let md = `## 🕵️ System Notes Audit Trail (Record ID: \`${recordId}\`, ${rows.length} changes)\n\n`;
	md += `| Timestamp | Author | Role | Field | Old Value | New Value |\n|:---|:---|:---|:---|:---|:---|\n`;

	for (const r of rows) {
		const author = r.author_name || r.author_id || "System";
		const role = r.role_name || "-";
		const field = r.field || "-";
		const rawOld =
			r.oldvalue !== null && r.oldvalue !== undefined ? String(r.oldvalue) : "";
		const oldVal = rawOld.length > 60 ? `${rawOld.slice(0, 57)}...` : rawOld;
		const rawNew =
			r.newvalue !== null && r.newvalue !== undefined ? String(r.newvalue) : "";
		const newVal = rawNew.length > 60 ? `${rawNew.slice(0, 57)}...` : rawNew;
		md += `| ${r.date} | ${author} | ${role} | \`${field}\` | ${oldVal} | ${newVal} |\n`;
	}

	return md;
}

/**
 * netsuite_get_system_notes
 * Dedicated audit log query complying strictly with Oracle SAFE Guide Pitfall 11.
 */
export async function handleGetSystemNotes(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
	resolveRectype?: (type: string) => number | null | Promise<number | null>,
): Promise<ToolResponse> {
	const parsed = GetSystemNotesArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}

	const { recordType } = parsed.data;
	const limit = Math.min(Math.max(parsed.data.limit ?? 50, 1), 100);
	const targetIds = [
		...(parsed.data.recordId ? [parsed.data.recordId.trim()] : []),
		...(parsed.data.recordIds || []).map((id) => id.trim()),
	];

	if (targetIds.length === 0) {
		return textResult(
			"❌ Either recordId or recordIds must be specified.",
			true,
		);
	}

	const firstId = targetIds[0];
	if (targetIds.length === 1 && firstId) {
		try {
			const res = await inspectSingleRecordSystemNotes(
				firstId,
				recordType,
				limit,
				mcpTools,
				resolveRectype,
			);
			return textResult(res, res.startsWith("❌"));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (isPermissionError(msg)) throw err;
			return textResult(
				`❌ Failed to query system notes for record ID ${firstId}: ${msg}`,
				true,
			);
		}
	}

	// Multi-record parallel execution with ConcurrencyLimiter(5)
	const limiter = pLimit(5);
	try {
		const results = await Promise.all(
			targetIds.map((recId) =>
				limiter(async () => {
					try {
						return await inspectSingleRecordSystemNotes(
							recId,
							recordType,
							limit,
							mcpTools,
							resolveRectype,
						);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						if (isPermissionError(msg)) throw err;
						return `❌ Failed to query system notes for record ID ${recId}: ${msg}`;
					}
				}),
			),
		);
		return textResult(results.join("\n\n---\n\n"));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isPermissionError(msg)) throw err;
		return textResult(`❌ Failed to query system notes: ${msg}`, true);
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
		if (isPermissionError(msg)) throw err;
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
	const targetId = unwrapped?.id != null ? String(unwrapped.id) : "";

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
		if (isPermissionError(msg)) throw err;
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
