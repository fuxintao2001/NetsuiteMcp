import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schemas & Inferred Types
// ---------------------------------------------------------------------------

export const AuthenticateArgsSchema = z.object({
	accountId: z
		.string()
		.trim()
		.optional()
		.describe(
			"NetSuite Account ID (e.g. 1234567 or 1234567_SB1). Falls back to NETSUITE_ACCOUNT_ID env var.",
		),
	clientId: z
		.string()
		.trim()
		.optional()
		.describe(
			"OAuth 2.0 Client ID from NetSuite integration record. Falls back to NETSUITE_CLIENT_ID env var.",
		),
});
export type AuthenticateArgs = z.infer<typeof AuthenticateArgsSchema>;

export const GetRecordLinkArgsSchema = z.object({
	recordId: z
		.string()
		.trim()
		.min(1, "recordId is required")
		.describe("Internal ID of the NetSuite record."),
	recordType: z
		.string()
		.trim()
		.toLowerCase()
		.optional()
		.describe("Record type (e.g. salesorder, customer, customrecord_xxx)."),
	accountId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Override account ID (defaults to current authenticated account).",
		),
	rectype: z
		.number()
		.int()
		.optional()
		.describe("Numeric custom record type ID. Auto-resolved if omitted."),
});
export type GetRecordLinkArgs = z.infer<typeof GetRecordLinkArgsSchema>;

export const RefreshCacheArgsSchema = z.object({
	tableName: z
		.string()
		.trim()
		.toLowerCase()
		.optional()
		.describe(
			"Optional: Specific NetSuite table or record type to clear from cache (e.g. customer, salesorder, customrecord_xxx).",
		),
});
export type RefreshCacheArgs = z.infer<typeof RefreshCacheArgsSchema>;

export const BatchTaskSchema = z.object({
	toolName: z
		.string()
		.trim()
		.min(1, "toolName is required")
		.describe("The name of the tool to execute."),
	arguments: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("Arguments dictionary for the specified tool."),
});
export type BatchTask = z.infer<typeof BatchTaskSchema>;

export const BatchExecuteArgsSchema = z.object({
	tasks: z
		.array(BatchTaskSchema)
		.min(1, "tasks must be a non-empty array")
		.max(10, "tasks array exceeds maximum limit of 10")
		.describe("Array of tasks to execute in parallel (maximum 10 tasks)."),
});
export type BatchExecuteArgs = z.infer<typeof BatchExecuteArgsSchema>;

export const GetScriptLogsArgsSchema = z.object({
	scriptId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Filter by script's Script ID (e.g. customscript_my_ue). Matches against Script.scriptid.",
		),
	type: z
		.enum(["DEBUG", "AUDIT", "ERROR", "EMERGENCY"], {
			error: () => ({
				message:
					"Invalid log type. Must be one of: DEBUG, AUDIT, ERROR, EMERGENCY.",
			}),
		})
		.optional()
		.describe("Filter by log level: DEBUG, AUDIT, ERROR, or EMERGENCY."),
	dateFrom: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid dateFrom format. Use YYYY-MM-DD.")
		.optional()
		.describe("Start date filter in YYYY-MM-DD format (inclusive)."),
	dateTo: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid dateTo format. Use YYYY-MM-DD.")
		.optional()
		.describe("End date filter in YYYY-MM-DD format (inclusive)."),
	title: z
		.string()
		.trim()
		.optional()
		.describe("Filter by log title keyword (LIKE fuzzy match)."),
	detail: z
		.string()
		.trim()
		.optional()
		.describe("Filter by log detail/message keyword (LIKE fuzzy match)."),
	deploymentId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Filter by deployment Script ID (e.g. customdeploy_my_ue). Matches against ScriptDeployment.scriptid.",
		),
	limit: z
		.number()
		.int()
		.optional()
		.transform((v) => (v !== undefined ? Math.min(Math.max(v, 1), 200) : 50))
		.describe(
			"Maximum number of log entries to return. Default: 50, Max: 200.",
		),
});
export type GetScriptLogsArgs = z.infer<typeof GetScriptLogsArgsSchema>;

// ---------------------------------------------------------------------------
// Static Tool Schema Definitions (local tools)
// ---------------------------------------------------------------------------

export const AUTH_TOOL = {
	name: "netsuite_authenticate",
	description:
		"Authenticate with NetSuite using OAuth 2.0 PKCE. Required before using any NetSuite tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.",
	inputSchema: {
		type: "object" as const,
		properties: {
			accountId: {
				type: "string",
				description:
					"NetSuite Account ID (e.g. 1234567 or 1234567_SB1). Falls back to NETSUITE_ACCOUNT_ID env var.",
			},
			clientId: {
				type: "string",
				description:
					"OAuth 2.0 Client ID from NetSuite integration record. Falls back to NETSUITE_CLIENT_ID env var.",
			},
		},
		required: [],
	},
};

export const LOGOUT_TOOL = {
	name: "netsuite_logout",
	description: "Clear NetSuite authentication session and logout.",
	inputSchema: { type: "object" as const, properties: {} },
};

export const RECORD_LINK_TOOL = {
	name: "netsuite_get_record_link",
	description:
		"Generate a direct NetSuite UI browser link to view a specific record.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordId: {
				type: "string",
				description: "Internal ID of the NetSuite record.",
			},
			recordType: {
				type: "string",
				description:
					"Record type (e.g. salesorder, customer, customrecord_xxx).",
			},
			accountId: {
				type: "string",
				description:
					"Override account ID (defaults to current authenticated account).",
			},
			rectype: {
				type: "integer",
				description: "Numeric custom record type ID. Auto-resolved if omitted.",
			},
		},
		required: ["recordId"],
	},
};

export const REFRESH_CACHE_TOOL = {
	name: "netsuite_refresh_cache",
	description:
		"Force clear local cache and refresh NetSuite internal REST session cache. Can optionally clear cache for a single table/recordType.",
	inputSchema: {
		type: "object" as const,
		properties: {
			tableName: {
				type: "string",
				description:
					"Optional: Specific NetSuite table or record type to clear from cache (e.g. customer, salesorder, customrecord_xxx).",
			},
		},
	},
};

export const STATUS_TOOL = {
	name: "netsuite_status",
	description:
		"Show diagnostic information: authentication state, token expiry, account details, cache statistics, and environment type.",
	inputSchema: { type: "object" as const, properties: {} },
};

export const BATCH_EXECUTE_TOOL = {
	name: "netsuite_batch_execute",
	description:
		"Execute multiple NetSuite tools in parallel (max 10 tasks, concurrency 5). Dramatically reduces latency for batch operations. Supports any tool including 'ns_runCustomSuiteQL', 'ns_getRecord', 'ns_getRecordTypeMetadata', 'ns_getSuiteQLMetadata', 'netsuite_get_script_logs', and 'netsuite_get_record_link'.",
	inputSchema: {
		type: "object" as const,
		properties: {
			tasks: {
				type: "array",
				description:
					"Array of tasks to execute in parallel (maximum 10 tasks).",
				items: {
					type: "object",
					properties: {
						toolName: {
							type: "string",
							description:
								"The name of the tool to execute (e.g. 'ns_runCustomSuiteQL', 'ns_getRecord', 'ns_getRecordTypeMetadata', 'ns_getSuiteQLMetadata', 'netsuite_get_script_logs', 'netsuite_get_record_link').",
						},
						arguments: {
							type: "object",
							description: "Arguments dictionary for the specified tool.",
						},
					},
					required: ["toolName"],
				},
			},
		},
		required: ["tasks"],
	},
};

export const SCRIPT_LOGS_TOOL = {
	name: "netsuite_get_script_logs",
	description:
		"Query NetSuite Script Execution Logs (ScriptNote table). Returns structured log entries with optional filtering by script, log level, date range, title/detail keywords, and deployment. Logs are retained for ~30 days by NetSuite.",
	inputSchema: {
		type: "object" as const,
		properties: {
			scriptId: {
				type: "string",
				description:
					"Filter by script's Script ID (e.g. customscript_my_ue). Matches against Script.scriptid.",
			},
			type: {
				type: "string",
				description: "Filter by log level: DEBUG, AUDIT, ERROR, or EMERGENCY.",
				enum: ["DEBUG", "AUDIT", "ERROR", "EMERGENCY"],
			},
			dateFrom: {
				type: "string",
				description: "Start date filter in YYYY-MM-DD format (inclusive).",
			},
			dateTo: {
				type: "string",
				description: "End date filter in YYYY-MM-DD format (inclusive).",
			},
			title: {
				type: "string",
				description: "Filter by log title keyword (LIKE fuzzy match).",
			},
			detail: {
				type: "string",
				description: "Filter by log detail/message keyword (LIKE fuzzy match).",
			},
			deploymentId: {
				type: "string",
				description:
					"Filter by deployment Script ID (e.g. customdeploy_my_ue). Matches against ScriptDeployment.scriptid.",
			},
			limit: {
				type: "integer",
				description:
					"Maximum number of log entries to return. Default: 50, Max: 200.",
			},
		},
		required: [],
	},
};

// ---------------------------------------------------------------------------
// Tool description enhancement suffixes
// ---------------------------------------------------------------------------

/**
 * SuiteQL rules to append to the `ns_runCustomSuiteQL` tool description.
 * These rules are embedded directly in the tool description so the AI agent
 * sees them at tool-discovery time, before writing any query.
 */
export const SUITEQL_RULES_SUFFIX = `

⚠️ ═══ MANDATORY SUITEQL PROTOCOL, DOMAIN TABLE ROUTING & SELF-HEALING WORKFLOW ═══

🔒 STEP 1 — RECONNAISSANCE (Before writing ANY query):
  Always call ns_getSuiteQLMetadata to verify exact table/field names and case-sensitivity before executing custom queries.

🎯 STEP 2 — BUSINESS DOMAIN TABLE ROUTING (Choose the right table for the business scenario):
  1. 📦 Inventory & Stock Management (Multi-Location & All Item Types):
     • 🌟 Cross-Item Location Stock (GOLDEN TABLE): ALWAYS use 'aggregateitemlocation' (NOT 'item', NOT 'inventoryitemlocations')!
       - Key Fields: item, location, quantityOnHand, quantityAvailable, quantityCommitted, quantityOnOrder, quantityBackOrdered, quantityInTransit, averageCostMli, onHandValueMli, reorderPoint, preferredStockLevel
       - Golden Template: SELECT a.item, BUILTIN.DF(a.item) AS item_name, a.location, BUILTIN.DF(a.location) AS loc_name, a.quantityOnHand, a.quantityAvailable, a.quantityOnOrder, a.averageCostMli FROM aggregateitemlocation a WHERE a.location = :loc_id
       - ⚠️ CRITICAL: 'inventoryitemlocations' only covers standard inventory items (InvtPart) and OMITS Assembly, Lot-numbered, and Serialized items. Querying 'item' table directly causes severe polymorphic scan timeouts.
     • Subtype Locations (Specific Types Only): 'inventoryitemlocations' (InvtPart), 'assemblyitemlocations' (Assembly), 'lotnumberedassemblyitemlocations' (Lot Assembly), 'lotnumberedinventoryitemlocations' (Lot Invt).
     • Granular Bin & Lot/Serial Stock: 'inventorybalance' (bin-level quantity), 'inventorynumber' (lot/serial tracking), 'bin'.
     • Item Catalog / Master Metadata: 'item' (SELECT minimal columns only: id, itemid, displayname, itemtype, baseprice, isinactive).

  2. 📑 Transactions & Order-to-Cash / Procure-to-Pay:
     • Header-Level Summary & Metrics: 'transaction' (MUST filter with indexed fields: WHERE type = '...' AND trandate >= TO_DATE(...) AND voided = 'F').
     • Line Item Breakdown: 'transactionline' JOIN 'transaction' (MUST include WHERE tl.mainline = 'F' AND tl.taxline = 'F' to prevent 2x+ row duplication).
     • Transaction Header Summary Line: 'transactionline' (WHERE tl.mainline = 'T').
     • Document Lineage / Upstream Links (PO➔IR, SO➔IF, etc.): 'tl.createdfrom = :upstream_id' on 'transactionline' (⚠️ 'createdfrom' does NOT exist on 'transaction' header!).
     • Intercompany Paired Numbers: Match 't.tranid' with 't.otherrefnum'.

  3. 🏭 Manufacturing, Work Orders & Assembly Builds:
     • Work Orders & Builds: 'transaction' WHERE type IN ('WorkOrd', 'Build', 'Unbuild', 'WOCompl', 'WOIssue', 'WOClose').
     • WO Component Consumption: 'transactionline' tl WHERE tl.transaction = :wo_id AND tl.mainline = 'F'.

  4. 📈 MRP & Demand Planning:
     • Custom MRP Records: 'customrecord_hc_mrp_*', paired with Open Sales Orders ('SalesOrd') and Purchase Orders ('PurchOrd').

  5. 🧬 Product Lifecycle (PL) & PIM Attributes:
     • Product Lifecycle Status: 'item' filtering 'custitem_product_lifecycle_status' and PIM attributes.

  6. 🚢 Landed Cost, Receipts & Customs:
     • Inbound Shipments: 'inboundshipment', 'inboundshipmentitem'.
     • Customs & Item Receipts: 'transaction' WHERE type = 'ItemRcpt' with customs declaration custom fields.

  7. 💰 Financial Costing & GL Postings:
     • GL Impact & Accounting Entries: 'transactionaccountingline' tal JOIN 'transaction' t ON t.id = tal.transaction JOIN 'account' a ON a.id = tal.account WHERE tal.posting = 'T'.
     • Chart of Accounts: 'account', Accounting Periods: 'accountingperiod', Subsidiaries: 'subsidiary'.

  8. 🛠️ Governance, System Notes & Script Logs:
     • Script Execution Logs: 'scriptnote' (or use tool 'netsuite_get_script_logs').
     • System Audit Logs: Standalone 'systemnote' ONLY with strict 'recordid' filter. ⚠️ NEVER JOIN SystemNote with transaction/entity tables (causes 45s+ timeouts).

📝 STEP 3 — SYNTAX & PERFORMANCE RULES (Non-negotiable):
  a) Explicit Column Selection: NO 'SELECT *' or 'table.*'. Explicitly specify each required field name.
  b) Pagination: Use 'FETCH FIRST N ROWS ONLY' or 'WHERE ROWNUM <= N'. NEVER use 'LIMIT' or 'OFFSET'.
  c) Date Handling: Wrap date literals in TO_DATE('<value>', '<format>'), e.g. TO_DATE('2025-01-15', 'YYYY-MM-DD'). NEVER compare bare date strings.
  d) Display Name Extraction: Use BUILTIN.DF(<foreign_key_field>) (e.g., BUILTIN.DF(item), BUILTIN.DF(location), BUILTIN.DF(entity), BUILTIN.DF(status), BUILTIN.DF(subsidiary)) to retrieve human-readable text labels instead of writing expensive multi-table JOINs.
  e) Primary Key Naming: The primary key column for NetSuite tables is 'id' (NOT 'internalid').
  f) Null Value Handling: Use NVL(field, default_value) to replace NULLs, e.g. NVL(memo, 'None').
  g) Driving Indexed Filters: Queries against 'transaction' / 'transactionline' MUST include indexed driving filters ('trandate', 'type', 'id', 'tranid', 'subsidiary', 'location', 'entity', 'item').
  h) Security Guardrails: Queries MUST begin with SELECT or WITH. SQL comments (-- or /* */ or #) are strictly prohibited.

📋 TRANSACTION TYPE SHORTCODES (Use in WHERE type = '...'):
  • Sales & AR: SalesOrd (Sales Order), CustInvc (Invoice), CashSale (Cash Sale), Estimate (Quote), Opprtnty (Opportunity), CustPymt (Customer Payment), CustDep (Customer Deposit), DepAppl (Deposit App), CustCred (Credit Memo), CustRfnd (Refund), RtnAuth (RMA), ItemShip (Fulfillment), CustChrg (Statement Charge), FinChrg (Finance Charge)
  • Purchases & AP: PurchOrd (Purchase Order), PurchReq (Requisition), PurchCon (Blanket PO), ItemRcpt (Item Receipt), VendBill (Bill), VendPymt (Bill Payment), VendCred (Bill Credit), VendAuth (Vendor Return), VPrep (Vendor Prepayment), VPrepApp (Prepayment App)
  • Inventory & Mfg: TrnfrOrd (Transfer Order), InvTrnfr (Inv Transfer), InvAdjst (Adjustment), InvCount (Count), InvReval (Revaluation), InvWksht (Worksheet), Build (Assembly Build), Unbuild (Assembly Unbuild), WorkOrd (Work Order), WOClose (WO Close), WOCompl (WO Completion), WOIssue (WO Issue), BinTrnfr (Bin Transfer), BinWksht (Bin Putaway), StatChng (Status Change), OwnTrnsf (Ownership Transfer)
  • Financial & Other: Journal (Journal Entry), InterCompJrn (Intercompany Journal), AdvInterCompJrn (Adv Interco Journal), StatJrn (Statistical Journal), PEJrnl (Period End Journal), Check (Check), Deposit (Deposit), CardChrg (Credit Card), CardRfnd (Card Refund), TaxPymt/TaxLiab (Tax Payment), Paycheck (Paycheck), PchkJrnl (Paycheck Journal), Commissn (Commission), ExpRept (Expense Report), FxReval (FX Revaluation), RevArrng (Revenue Arrangement), RevComm (Revenue Commitment), Transfer (Bank Transfer), Custom (Custom Transaction)

🔄 STEP 4 — AUTOMATIC SELF-HEALING LOOP (On syntax/schema errors only):
  If query execution returns a syntax or schema error (e.g. invalid column, wrong table, missing mainline, wrong type code) or unexpectedly empty results:
  Follow this self-healing procedure (up to 3 retry iterations):
    1. Parse the error message and guardrail advice to pinpoint the exact failure (e.g. use 'aggregateitemlocation' instead of 'inventoryitemlocations', or add 'tl.mainline = ''F''').
    2. Re-call ns_getSuiteQLMetadata to inspect table schema and confirm valid field names/types if needed.
    3. Correct the SuiteQL statement using recommended domain patterns and re-run ns_runCustomSuiteQL.
    4. Only report failure to the user after 3 unsuccessful automated retries.

🚫 ═══ PERMISSION ERROR HARD STOP (CRITICAL EXCEPTION TO STEP 4) ═══
  If query execution fails due to PERMISSION RESTRICTIONS (e.g. 'INSUFFICIENT_PERMISSION', HTTP 403, 'Permission Violation', or role access denied):
  • DO NOT attempt self-healing or query retries (permission errors CANNOT be resolved by modifying queries).
  • DO NOT guess, simulate, or fabricate any record data.
  • IMMEDIATELY STOP all tasks, explain which table/record lacked permissions, and request the user/admin to configure the required NetSuite role permissions.`;

/**
 * Metadata usage hint to append to the `ns_getSuiteQLMetadata` tool description.
 */
export const METADATA_RULES_SUFFIX = `

⚠️ MANDATORY: Call this tool BEFORE writing any SuiteQL query to verify exact field names, types, and case-sensitivity.
- Field names are CASE-SENSITIVE — use them exactly as returned (e.g., 'tranid' instead of 'TranId').
- Eliminates guesswork and prevents INVALID_SEARCH_SELECT_FIELD errors.
- If a subsequent ns_runCustomSuiteQL query fails, re-call this tool to self-heal and inspect field definitions.
- For custom records (customrecord_*), this returns both system and custom field definitions.`;

/** All locally-handled tools (excluding AUTH_TOOL which has special routing). */
export const LOCAL_TOOLS = [
	RECORD_LINK_TOOL,
	REFRESH_CACHE_TOOL,
	LOGOUT_TOOL,
	STATUS_TOOL,
	BATCH_EXECUTE_TOOL,
	SCRIPT_LOGS_TOOL,
];
