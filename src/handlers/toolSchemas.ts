// ---------------------------------------------------------------------------
// MCP Tool Schema definitions (local tools)
// ---------------------------------------------------------------------------

/**
 * Static schema definitions for locally-handled MCP tools.
 *
 * These tools are handled entirely within the MCP server and are NOT proxied
 * to the NetSuite MCP REST API. They use the `netsuite_` prefix to
 * distinguish them from `ns_`-prefixed proxied tools.
 */

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
		"Execute multiple NetSuite MCP tools in parallel. Supports up to 10 sub-tasks. Useful for optimization by minimizing round-trip API delays.",
	inputSchema: {
		type: "object" as const,
		properties: {
			tasks: {
				type: "array",
				description:
					"An array of tasks to execute in parallel. Maximum 10 tasks.",
				items: {
					type: "object",
					properties: {
						toolName: {
							type: "string",
							description:
								"The name of the tool to execute (e.g. ns_getRecord, ns_runCustomSuiteQL).",
						},
						arguments: {
							type: "object",
							description: "Arguments to pass to the tool.",
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

⚠️ ═══ MANDATORY SUITEQL PROTOCOL & SELF-ITERATION WORKFLOW ═══

🔒 STEP 1 — RECONNAISSANCE (Before writing ANY query):
  Always call ns_getSuiteQLMetadata to verify exact table/field names and case-sensitivity before executing custom queries.

📝 STEP 2 — SYNTAX & PAGINATION RULES (Non-negotiable):
  a) Explicit Column Selection: NO 'SELECT *'. Explicitly specify each required field name.
  b) Pagination: Use 'FETCH FIRST N ROWS ONLY' or 'WHERE ROWNUM <= N'. NEVER use 'LIMIT' or 'OFFSET' (unsupported by SuiteQL).
  c) Date Handling: Wrap date literals in TO_DATE('<value>', '<format>'), e.g. TO_DATE('2025-01-15', 'YYYY-MM-DD'). NEVER compare bare date strings.
  d) Display Name Extraction: Use BUILTIN.DF(<foreign_key_field>) (e.g., BUILTIN.DF(entity), BUILTIN.DF(status), BUILTIN.DF(subsidiary)) to retrieve human-readable text labels instead of writing multi-table JOINs.
  e) Primary Key Naming: The primary key column for NetSuite tables is 'id' (NOT 'internalid').
  f) Null Value Handling: Use NVL(field, default_value) to replace NULLs, e.g. NVL(memo, 'None').
  g) Security Guardrails: Queries MUST begin with SELECT or WITH. SQL comments (-- or /* */ or #) are strictly prohibited.

📋 TRANSACTION TYPE SHORTCODES (Use in WHERE type = '...'):
  • Sales Orders: SalesOrd | Invoices: CustInvc | Purchase Orders: PurchOrd | Vendor Bills: VendBill
  • Journal Entries: Journal | Credit Memos: CustCred | Item Receipts: ItemRcpt | Item Fulfillments: ItemShip
  • Cash Sales: CashSale | Vendor Payments: VendPymt | Customer Payments: CustPymt | Quotes: Estimate
  • Return Auths: RtnAuth | Checks: Check | Deposits: Deposit | Transfer Orders: Transfer

🔄 STEP 3 — AUTOMATIC SELF-HEALING LOOP (Mandatory on failure):
  If query execution returns an error (e.g. invalid column, syntax error, missing permission) or unexpectedly empty results, DO NOT interrupt the user.
  Follow this self-healing procedure (up to 3 retry iterations):
    1. Parse the error message to pinpoint the exact failure (e.g., misspelled field or wrong type code).
    2. Re-call ns_getSuiteQLMetadata to inspect table schema and confirm valid field names/types.
    3. Correct the SuiteQL statement and re-run ns_runCustomSuiteQL.
    4. Only report failure to the user after 3 unsuccessful automated retries.`;

/**
 * Metadata usage hint to append to the `ns_getSuiteQLMetadata` tool description.
 */
export const METADATA_RULES_SUFFIX = `

⚠️ MANDATORY: Call this tool BEFORE writing any SuiteQL query to verify exact field names, types, and case-sensitivity.
- Field names are CASE-SENSITIVE — use them exactly as returned (e.g., 'tranid' instead of 'TranId').
- Eliminates guesswork and prevents INVALID_SEARCH_SELECT_FIELD errors.
- If a subsequent ns_runCustomSuiteQL query fails, re-call this tool to self-heal and inspect field definitions.
- For custom records (customrecord_*), this returns both system and custom field definitions.`;

/**
 * SuiteQL rules hint to append to `netsuite_run_parallel_queries`.
 */
export const PARALLEL_QUERIES_RULES_SUFFIX = `

⚠️ MANDATORY FOR PARALLEL QUERIES:
Every SuiteQL query in the input array MUST follow the SuiteQL Protocol:
- Explicit column selection (NO 'SELECT *').
- Use 'FETCH FIRST N ROWS ONLY' or 'ROWNUM <= N' (NO 'LIMIT'/'OFFSET').
- Use TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD') for dates and BUILTIN.DF(field) for foreign key labels.
- Primary key is 'id'. Call ns_getSuiteQLMetadata first if unsure of field names.`;

export const RUN_PARALLEL_QUERIES_TOOL = {
	name: "netsuite_run_parallel_queries",
	description:
		"Run multiple SuiteQL queries concurrently in parallel (up to 5 concurrent queries). Returns structured individual results." +
		PARALLEL_QUERIES_RULES_SUFFIX,
	inputSchema: {
		type: "object" as const,
		properties: {
			queries: {
				type: "array",
				description: "Array of SuiteQL query strings to execute in parallel.",
				items: { type: "string" },
			},
		},
		required: ["queries"],
	},
};

export const GET_PARALLEL_RECORDS_TOOL = {
	name: "netsuite_get_parallel_records",
	description:
		"Fetch multiple NetSuite records concurrently in parallel. Minimizes network round-trip overhead.",
	inputSchema: {
		type: "object" as const,
		properties: {
			records: {
				type: "array",
				description: "Array of record requests to fetch in parallel.",
				items: {
					type: "object",
					properties: {
						recordType: {
							type: "string",
							description: "NetSuite record type (e.g. customer, salesorder).",
						},
						recordId: {
							type: "string",
							description: "Internal ID of the record.",
						},
						fields: {
							type: "string",
							description:
								"Optional comma-separated list of field IDs to retrieve.",
						},
					},
					required: ["recordType", "recordId"],
				},
			},
		},
		required: ["records"],
	},
};

export const GET_PARALLEL_METADATA_TOOL = {
	name: "netsuite_get_parallel_metadata",
	description:
		"Fetch metadata for multiple NetSuite record types concurrently in parallel.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordTypes: {
				type: "array",
				description: "Array of NetSuite record type strings.",
				items: { type: "string" },
			},
			type: {
				type: "string",
				description: "Metadata type: 'record' or 'suiteql'. Default: 'record'.",
				enum: ["record", "suiteql"],
			},
		},
		required: ["recordTypes"],
	},
};

/** All locally-handled tools (excluding AUTH_TOOL which has special routing). */
export const LOCAL_TOOLS = [
	RECORD_LINK_TOOL,
	REFRESH_CACHE_TOOL,
	LOGOUT_TOOL,
	STATUS_TOOL,
	BATCH_EXECUTE_TOOL,
	SCRIPT_LOGS_TOOL,
	RUN_PARALLEL_QUERIES_TOOL,
	GET_PARALLEL_RECORDS_TOOL,
	GET_PARALLEL_METADATA_TOOL,
];
