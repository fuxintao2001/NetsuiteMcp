/**
 * Metadata & SuiteQL Field Mapping Utilities
 */

export interface JsonSchemaProperty {
	title?: string;
	type: string;
	format?: string;
	description?: string;
	nullable?: boolean;
	properties?: Record<string, JsonSchemaProperty>;
}

/**
 * Maps a NetSuite field type string (e.g., 'CHECKBOX', 'CURRENCY', 'SELECT')
 * to standard JSON Schema property definitions.
 */
export function mapFieldType(
	fieldType: string | undefined,
): JsonSchemaProperty {
	const type = (fieldType || "TEXT").toUpperCase().trim();

	if (type === "CHECKBOX" || type === "BOOLEAN") {
		return { type: "boolean" };
	}
	if (type === "INTEGER") {
		return { type: "integer" };
	}
	if (
		type === "FLOAT" ||
		type === "DOUBLE" ||
		type === "CURRENCY" ||
		type === "PERCENT"
	) {
		return { type: "number", format: "double" };
	}
	if (type === "DATE") {
		return { type: "string", format: "date" };
	}
	if (type === "DATETIME" || type === "DATE-TIME") {
		return { type: "string", format: "date-time" };
	}
	if (type === "SELECT" || type === "MULTISELECT" || type === "RECORD") {
		return {
			type: "object",
			properties: {
				id: { title: "Internal identifier", type: "string" },
				refName: { title: "Reference Name", type: "string" },
			},
		};
	}
	return { type: "string" };
}

/**
 * Sanitizes a script ID for use in SuiteQL queries to prevent SQL injection.
 * Enforces that scriptId contains only alphanumeric characters and underscores.
 */
export function sanitizeScriptId(scriptId: string): string {
	const sanitized = scriptId.trim().toUpperCase();
	if (!/^[A-Z0-9_]+$/.test(sanitized)) {
		throw new Error(`Invalid script ID format: "${scriptId}"`);
	}
	return sanitized;
}

/**
 * Sanitizes an integer ID (e.g. rectype or internalId) for use in SuiteQL queries.
 */
export function sanitizeIntegerId(id: unknown): number {
	const parsed = typeof id === "number" ? id : Number.parseInt(String(id), 10);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid numeric ID format: "${String(id)}"`);
	}
	return parsed;
}

/**
 * Unwraps data from an MCP content wrapper response or stringified JSON payload.
 */
export function unwrapMcpContent(result: unknown): unknown {
	if (result === null || result === undefined) return result;

	let data: unknown = result;

	// Handle MCP wrapper shape: { content: [{ text: '...' }] }
	if (
		typeof data === "object" &&
		data !== null &&
		"content" in data &&
		Array.isArray((data as { content: unknown[] }).content)
	) {
		const contentList = (data as { content: Array<{ text?: string }> }).content;
		const first = contentList[0];
		if (first?.text && typeof first.text === "string") {
			try {
				data = JSON.parse(first.text);
			} catch {
				return first.text;
			}
		}
	}

	// Handle stringified JSON
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch {
			return data;
		}
	}

	return data;
}

/**
 * Shared dynamic resolution for custom record numeric IDs (rectype).
 * Checks memory cache first, then queries SuiteQL with SQL injection protection,
 * and updates persistent cache.
 */
export async function resolveCustomRecordRectype(
	mcpTools: {
		customRecordMappings: Map<string, number>;
		executeTool: (
			name: string,
			params: Record<string, unknown>,
		) => Promise<unknown>;
		extractDataArray: (result: unknown) => Array<Record<string, unknown>>;
	},
	oauthManager: { getAccountId: () => Promise<string | null | undefined> },
	cacheServiceInstance: {
		get: <T>(accountId: string, key: string) => Promise<T | null | undefined>;
		set: <T>(accountId: string, key: string, val: T) => Promise<void>;
	},
	recordType: string,
): Promise<number | null> {
	if (!recordType) return null;
	const upperType = recordType.toUpperCase().trim();
	const cached = mcpTools.customRecordMappings.get(upperType);
	if (cached !== undefined) return cached;

	try {
		const safeType = sanitizeScriptId(upperType);
		console.error(
			`🔍 Resolving custom record type mapping dynamically for ${safeType}...`,
		);
		const result = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: `SELECT internalId FROM customrecordtype WHERE UPPER(scriptId) = '${safeType}'`,
		});
		const records = mcpTools.extractDataArray(result);
		const firstRecord = records[0];
		if (firstRecord) {
			const internalId = Number.parseInt(
				String(firstRecord.internalid || firstRecord.internalId),
				10,
			);
			if (!Number.isNaN(internalId)) {
				mcpTools.customRecordMappings.set(upperType, internalId);
				const accountId = await oauthManager.getAccountId();
				if (accountId) {
					const mappingsObj =
						(await cacheServiceInstance.get<Record<string, number>>(
							accountId,
							"customrecord_mappings",
						)) || {};
					mappingsObj[upperType] = internalId;
					await cacheServiceInstance.set(
						accountId,
						"customrecord_mappings",
						mappingsObj,
					);
				}
				return internalId;
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(
			`⚠️ Failed to dynamically resolve custom record rectype for ${upperType}: ${msg}`,
		);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Universal SuiteQL Table Catalog & Fast Discovery
// ---------------------------------------------------------------------------

export interface SuiteQLTableCatalogEntry {
	tableName: string;
	domain: string;
	description: string;
	keyFields: string[];
	bestPractice?: string;
}

export const SUITEQL_TABLE_CATALOG: SuiteQLTableCatalogEntry[] = [
	// 1. Inventory & Stock Management
	{
		tableName: "aggregateitemlocation",
		domain: "Inventory & Stock",
		description:
			"Unified multi-location inventory summary across ALL item types (InvtPart, Assembly, Lot, Serialized).",
		keyFields: [
			"item",
			"location",
			"quantityOnHand",
			"quantityAvailable",
			"quantityCommitted",
			"quantityOnOrder",
			"quantityBackOrdered",
			"quantityInTransit",
			"averageCostMli",
			"onHandValueMli",
		],
		bestPractice:
			"GOLDEN TABLE for stock queries across warehouses. Replaces slow scans on 'item' table.",
	},
	{
		tableName: "inventoryitemlocations",
		domain: "Inventory & Stock",
		description:
			"Location stock specifically for standard inventory items (InvtPart only).",
		keyFields: [
			"item",
			"location",
			"quantityOnHand",
			"quantityAvailable",
			"averageCostMli",
		],
		bestPractice:
			"Use ONLY when intentionally filtering standard raw materials/inventory parts (WHERE itemtype='InvtPart').",
	},
	{
		tableName: "assemblyitemlocations",
		domain: "Inventory & Stock",
		description:
			"Location stock specifically for assembly / manufactured items.",
		keyFields: [
			"item",
			"location",
			"quantityOnHand",
			"quantityAvailable",
			"buildTime",
			"reorderPoint",
		],
		bestPractice: "Contains assembly-specific work order build lead times.",
	},
	{
		tableName: "lotnumberedassemblyitemlocations",
		domain: "Inventory & Stock",
		description: "Location stock specifically for lot-numbered assembly items.",
		keyFields: [
			"item",
			"location",
			"quantityOnHand",
			"quantityAvailable",
			"averageCostMli",
		],
	},
	{
		tableName: "lotnumberedinventoryitemlocations",
		domain: "Inventory & Stock",
		description:
			"Location stock specifically for lot-numbered raw material inventory items.",
		keyFields: [
			"item",
			"location",
			"quantityOnHand",
			"quantityAvailable",
			"averageCostMli",
		],
	},
	{
		tableName: "inventorybalance",
		domain: "Inventory & Stock",
		description:
			"Bin-level inventory balances, lot/serial numbers, and status breakdown.",
		keyFields: [
			"item",
			"location",
			"binnumber",
			"inventorynumber",
			"quantityavailable",
			"quantityonhand",
		],
		bestPractice:
			"Use for granular warehouse bin stock or batch/lot quantity lookups.",
	},
	{
		tableName: "inventorynumber",
		domain: "Inventory & Stock",
		description: "Lot number and serial number master records.",
		keyFields: ["id", "item", "inventorynumber", "memo", "expirationdate"],
		bestPractice: "Track lot expiration dates and batch certificates.",
	},
	{
		tableName: "location",
		domain: "Inventory & Stock",
		description: "Warehouse / Location master records.",
		keyFields: [
			"id",
			"name",
			"fullname",
			"subsidiary",
			"isinactive",
			"makeinventoryavailable",
		],
	},

	// 2. Transactions & Orders
	{
		tableName: "transaction",
		domain: "Transactions & Orders",
		description:
			"Transaction header table (Sales Orders, Invoices, POs, Item Receipts, Fulfillments, Journals, etc.).",
		keyFields: [
			"id",
			"tranid",
			"type",
			"trandate",
			"entity",
			"subsidiary",
			"status",
			"otherrefnum",
			"postingperiod",
			"currency",
		],
		bestPractice:
			"Filter with indexed columns (WHERE type = 'SalesOrd' AND trandate >= TO_DATE(...)).",
	},
	{
		tableName: "transactionline",
		domain: "Transactions & Orders",
		description:
			"Transaction lines (item details, taxes, shipping, upstream lineage).",
		keyFields: [
			"id",
			"transaction",
			"linesequencenumber",
			"item",
			"quantity",
			"rate",
			"amount",
			"mainline",
			"taxline",
			"createdfrom",
			"location",
		],
		bestPractice:
			"MUST filter with tl.mainline = 'F' for item lines or tl.mainline = 'T' for header line. Upstream source 'createdfrom' is on this table.",
	},
	{
		tableName: "transactionaccountingline",
		domain: "Transactions & Orders",
		description:
			"General Ledger (GL) posting impact lines generated by transactions.",
		keyFields: [
			"transaction",
			"transactionline",
			"account",
			"amount",
			"debit",
			"credit",
			"posting",
			"netamount",
		],
		bestPractice:
			"Join with 'account' where posting = 'T' for official accounting impact.",
	},
	{
		tableName: "inboundshipment",
		domain: "Transactions & Orders",
		description:
			"Inbound shipment container tracking and landed cost allocations.",
		keyFields: [
			"id",
			"shipmentnumber",
			"status",
			"vesselnumber",
			"billoflading",
			"expecteddeliverydate",
		],
	},
	{
		tableName: "inboundshipmentitem",
		domain: "Transactions & Orders",
		description: "Line items assigned to an inbound shipment.",
		keyFields: [
			"id",
			"inboundshipment",
			"purchaseorder",
			"item",
			"quantityexpected",
			"quantityreceived",
		],
	},

	// 3. Manufacturing & Work Orders
	{
		tableName: "bom",
		domain: "Manufacturing",
		description: "Bill of Materials master definition.",
		keyFields: ["id", "name", "isinactive", "memo", "subsidiary"],
	},
	{
		tableName: "bomrevision",
		domain: "Manufacturing",
		description: "BOM revisions with effective dates.",
		keyFields: ["id", "billofmaterials", "name", "effectivestartdate"],
	},
	{
		tableName: "bomcomponent",
		domain: "Manufacturing",
		description: "Component materials and quantities within a BOM revision.",
		keyFields: ["id", "bomrevision", "item", "bomquantity", "units"],
	},
	{
		tableName: "manufacturingrouting",
		domain: "Manufacturing",
		description: "Routing operations and sequences for assembly items.",
		keyFields: ["id", "name", "item", "location", "isdefault"],
	},

	// 4. Financials & Accounting
	{
		tableName: "account",
		domain: "Financials & Accounting",
		description: "Chart of Accounts master.",
		keyFields: [
			"id",
			"acctnumber",
			"acctname",
			"accttype",
			"currency",
			"isinactive",
		],
		bestPractice: "Join with transactionaccountingline on account.id.",
	},
	{
		tableName: "accountingperiod",
		domain: "Financials & Accounting",
		description: "Fiscal accounting periods, quarters, and years.",
		keyFields: [
			"id",
			"periodname",
			"startdate",
			"enddate",
			"isquarter",
			"isyear",
			"closed",
		],
	},
	{
		tableName: "subsidiary",
		domain: "Financials & Accounting",
		description: "OneWorld corporate legal entities and subsidiaries.",
		keyFields: [
			"id",
			"name",
			"fullname",
			"parent",
			"currency",
			"country",
			"isinactive",
		],
	},
	{
		tableName: "currency",
		domain: "Financials & Accounting",
		description: "Currency definitions and precision settings.",
		keyFields: ["id", "name", "symbol", "isbasecurrency", "isinactive"],
	},
	{
		tableName: "currencyexchangerate",
		domain: "Financials & Accounting",
		description: "Daily and period consolidated exchange rate tables.",
		keyFields: [
			"id",
			"basecurrency",
			"transactioncurrency",
			"exchangerate",
			"effectivedate",
		],
	},
	{
		tableName: "taxgroup",
		domain: "Financials & Accounting",
		description: "Tax groups and rates.",
		keyFields: ["id", "itemid", "rate", "country", "isinactive"],
	},
	{
		tableName: "department",
		domain: "Financials & Accounting",
		description: "Department organizational segments.",
		keyFields: ["id", "name", "fullname", "isinactive"],
	},
	{
		tableName: "classification",
		domain: "Financials & Accounting",
		description: "Class / Business line tracking segments.",
		keyFields: ["id", "name", "fullname", "isinactive"],
	},

	// 5. Entities & CRM
	{
		tableName: "customer",
		domain: "Entities & CRM",
		description: "Customer entity master.",
		keyFields: [
			"id",
			"entityid",
			"companyname",
			"email",
			"phone",
			"subsidiary",
			"balance",
			"creditlimit",
			"terms",
			"isinactive",
		],
	},
	{
		tableName: "vendor",
		domain: "Entities & CRM",
		description: "Supplier / Vendor entity master.",
		keyFields: [
			"id",
			"entityid",
			"companyname",
			"email",
			"phone",
			"subsidiary",
			"balance",
			"terms",
			"isinactive",
		],
	},
	{
		tableName: "employee",
		domain: "Entities & CRM",
		description: "Employee records and supervisor hierarchy.",
		keyFields: [
			"id",
			"entityid",
			"firstname",
			"lastname",
			"email",
			"supervisor",
			"department",
			"isinactive",
		],
	},
	{
		tableName: "contact",
		domain: "Entities & CRM",
		description:
			"Individual contacts associated with customer/vendor entities.",
		keyFields: ["id", "entityid", "firstname", "lastname", "email", "company"],
	},

	// 6. Items & Master Data
	{
		tableName: "item",
		domain: "Items & Master Data",
		description:
			"Polymorphic Item base master table (all standard and custom items).",
		keyFields: [
			"id",
			"itemid",
			"displayname",
			"itemtype",
			"baseprice",
			"cost",
			"isinactive",
		],
		bestPractice:
			"Query minimal master attributes. For multi-location stock, prefer 'aggregateitemlocation'.",
	},
	{
		tableName: "pricing",
		domain: "Items & Master Data",
		description: "Item pricing matrices by currency and price level.",
		keyFields: ["item", "pricelevel", "currency", "unitprice", "quantityrange"],
	},
	{
		tableName: "itemvendor",
		domain: "Items & Master Data",
		description: "Item preferred vendor relationships and purchase prices.",
		keyFields: ["item", "vendor", "purchaseprice", "purchaseleadtime"],
	},
	{
		tableName: "unitsset",
		domain: "Items & Master Data",
		description: "Unit of measure types and base conversion units.",
		keyFields: ["id", "name", "isinactive"],
	},

	// 7. System, Logs & Customization
	{
		tableName: "systemnote",
		domain: "System & Logs",
		description:
			"System audit log tracking field changes, authors, and timestamps.",
		keyFields: [
			"id",
			"recordtypeid",
			"recordid",
			"field",
			"oldvalue",
			"newvalue",
			"date",
			"name",
		],
		bestPractice:
			"STANDALONE QUERY ONLY. Never JOIN systemnote directly with transactional tables.",
	},
	{
		tableName: "scriptnote",
		domain: "System & Logs",
		description: "SuiteScript execution logs (Debug, Audit, Error).",
		keyFields: [
			"id",
			"script",
			"scripttype",
			"title",
			"detail",
			"type",
			"date",
		],
	},
	{
		tableName: "customrecordtype",
		domain: "Customization",
		description: "Custom record type definitions in the account.",
		keyFields: ["internalid", "scriptid", "recordname", "description"],
	},
	{
		tableName: "customfield",
		domain: "Customization",
		description: "Custom field definitions.",
		keyFields: ["id", "scriptid", "fieldtype", "label"],
	},
];

/**
 * Searches the SuiteQL table catalog by keyword across table names, domains, and descriptions.
 * If keyword is omitted, returns all catalog entries.
 */
export function searchSuiteQLCatalog(
	keyword?: string,
): SuiteQLTableCatalogEntry[] {
	if (!keyword || keyword.trim().length === 0) {
		return SUITEQL_TABLE_CATALOG;
	}
	const q = keyword.trim().toLowerCase();
	return SUITEQL_TABLE_CATALOG.filter((entry) => {
		return (
			entry.tableName.toLowerCase().includes(q) ||
			entry.domain.toLowerCase().includes(q) ||
			entry.description.toLowerCase().includes(q) ||
			entry.keyFields.some((f) => f.toLowerCase().includes(q))
		);
	});
}

/**
 * Formats table catalog entries into a clean, compact Markdown discovery table.
 */
export function formatTableCatalogMarkdown(
	entries: SuiteQLTableCatalogEntry[],
	searchKeyword?: string,
): string {
	if (entries.length === 0) {
		return `⚠️ No matching NetSuite SuiteQL tables found for keyword "${searchKeyword}".\n\n💡 Tip: Call \`ns_getSuiteQLMetadata({ recordType: 'your_table_name' })\` to inspect any specific standard table or custom record (e.g. \`customrecord_...\`).`;
	}

	const header = searchKeyword
		? `### 🔍 NetSuite SuiteQL Table Catalog (Matches for "${searchKeyword}" — ${entries.length} tables found)`
		: `### 📚 NetSuite SuiteQL Universal Table Catalog (${entries.length} tables available)`;

	let md = `${header}\n\n`;
	md +=
		"> 💡 **Tip:** To view exact field definitions and types for any table, call: `ns_getSuiteQLMetadata({ recordType: 'tableName' })`.\n\n";
	md +=
		"| Table Name | Business Domain | Key Fields | Description & Best Practice |\n";
	md += "|---|---|---|---|\n";

	for (const e of entries) {
		const fieldsPreview = `\`${e.keyFields.slice(0, 5).join("`, `")}\`${e.keyFields.length > 5 ? "..." : ""}`;
		const desc = e.bestPractice
			? `${e.description} *(⭐ ${e.bestPractice})*`
			: e.description;
		md += `| \`${e.tableName}\` | ${e.domain} | ${fieldsPreview} | ${desc} |\n`;
	}

	return md;
}
