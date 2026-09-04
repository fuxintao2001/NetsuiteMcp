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

export const InspectRecordArgsSchema = z.object({
	recordType: z
		.string()
		.trim()
		.min(1, "recordType is required")
		.toLowerCase()
		.describe(
			"Record type (e.g. salesorder, invoice, customer, item, customrecord_xxx).",
		),
	recordId: z
		.string()
		.trim()
		.min(1, "recordId is required")
		.describe(
			"Record internal numeric ID (e.g. '12345') or document number / tranid (e.g. 'SO1002').",
		),
	includeLines: z
		.boolean()
		.optional()
		.default(true)
		.describe("Whether to include line item details (default: true)."),
	nonEmptyOnly: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			"Whether to filter out null/empty fields to keep output compact and clean (default: true).",
		),
});
export type InspectRecordArgs = z.infer<typeof InspectRecordArgsSchema>;

export const GetRecordDefinitionArgsSchema = z.object({
	recordType: z
		.string()
		.trim()
		.min(1, "recordType is required")
		.toLowerCase()
		.describe(
			"Record type name (e.g. salesorder, customer, item, invoice, vendor).",
		),
	keyword: z
		.string()
		.trim()
		.optional()
		.describe("Optional keyword to filter field names, labels, or help text."),
});
export type GetRecordDefinitionArgs = z.infer<
	typeof GetRecordDefinitionArgsSchema
>;

export const GetQueryTemplateArgsSchema = z.object({
	templateId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Specific template ID (e.g. 'transaction_lines', 'transaction_lineage_downstream', 'multi_location_stock', 'script_error_logs', 'system_notes_standalone', 'gl_impact_lines').",
		),
	category: z
		.enum([
			"transactions",
			"inventory",
			"system_debug",
			"accounting",
			"relationships",
		])
		.optional()
		.describe("Filter templates by domain category."),
	search: z
		.string()
		.trim()
		.optional()
		.describe(
			"Search keyword across template names, descriptions, and SQL patterns.",
		),
});
export type GetQueryTemplateArgs = z.infer<typeof GetQueryTemplateArgsSchema>;

export const GetSystemNotesArgsSchema = z.object({
	recordId: z
		.string()
		.trim()
		.min(1, "recordId is required")
		.describe("Record internal ID or document number (tranid)."),
	recordType: z
		.string()
		.trim()
		.toLowerCase()
		.optional()
		.describe(
			"Optional record type (e.g. salesorder, invoice, customer). Helps resolve tranid.",
		),
	limit: z
		.number()
		.int()
		.optional()
		.transform((v) => (v !== undefined ? Math.min(Math.max(v, 1), 100) : 30))
		.describe(
			"Maximum number of system notes to return. Default: 30, Max: 100.",
		),
});
export type GetSystemNotesArgs = z.infer<typeof GetSystemNotesArgsSchema>;

export const SuitecloudUploadArgsSchema = z.object({
	paths: z
		.string()
		.trim()
		.min(1, "paths is required")
		.describe(
			"File Cabinet path or local file path to upload (e.g. '/SuiteScripts/my_script.js' or full local path).",
		),
	projectPath: z
		.string()
		.trim()
		.optional()
		.describe(
			"Optional path to the SDF project root directory. Defaults to detecting upwards from paths or current directory.",
		),
	dryRun: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Optional dry-run flag. If true, generates execution preview without uploading.",
		),
	allowProduction: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Explicit user authorization flag required when uploading to a Production account. Set to true once user authorizes.",
		),
});
export type SuitecloudUploadArgs = z.infer<typeof SuitecloudUploadArgsSchema>;

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

export const INSPECT_RECORD_TOOL = {
	name: "netsuite_inspect_record",
	description:
		"Deeply inspect a real NetSuite record's populated fields and line items in the current environment. Eliminates null/empty noise, separates system header fields from custom fields (custbody_*, custcol_*, custrecord_*), and formats a clean developer-friendly overview. Ideal for writing SuiteScript and SuiteQL.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordType: {
				type: "string",
				description:
					"Record type (e.g. salesorder, invoice, customer, item, purchaseorder, customrecord_xxx).",
			},
			recordId: {
				type: "string",
				description:
					"Record internal numeric ID (e.g. '12345') or document number / tranid (e.g. 'SO1002').",
			},
			includeLines: {
				type: "boolean",
				description: "Whether to include line item details (default: true).",
			},
			nonEmptyOnly: {
				type: "boolean",
				description:
					"Whether to filter out null/empty fields to keep output compact and clean (default: true).",
			},
		},
		required: ["recordType", "recordId"],
	},
};

export const GET_RECORD_DEFINITION_TOOL = {
	name: "netsuite_get_record_definition",
	description:
		"Lookup official standard field definitions, types, required flags, and help texts for 272 NetSuite record types from Oracle SuiteScript Records Reference. Zero guesswork.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordType: {
				type: "string",
				description:
					"Record type name (e.g. salesorder, customer, item, invoice, vendor).",
			},
			keyword: {
				type: "string",
				description:
					"Optional keyword to filter field names, labels, or help text.",
			},
		},
		required: ["recordType"],
	},
};

export const GET_QUERY_TEMPLATE_TOOL = {
	name: "netsuite_get_query_template",
	description:
		"Get verified, production-ready SuiteQL query templates sourced from Oracle SAFE Guide 2025.2 and Tim Dietrich Query Library. Avoids common pitfalls like missing mainline='F', joining SystemNote, or table hallucination.",
	inputSchema: {
		type: "object" as const,
		properties: {
			templateId: {
				type: "string",
				description:
					"Specific template ID (e.g. 'transaction_lines', 'transaction_lineage_downstream', 'multi_location_stock', 'script_error_logs', 'system_notes_standalone', 'gl_impact_lines').",
			},
			category: {
				type: "string",
				enum: [
					"transactions",
					"inventory",
					"system_debug",
					"accounting",
					"relationships",
				],
				description: "Filter templates by domain category.",
			},
			search: {
				type: "string",
				description:
					"Search keyword across template names, descriptions, and SQL patterns.",
			},
		},
	},
};

export const GET_SYSTEM_NOTES_TOOL = {
	name: "netsuite_get_system_notes",
	description:
		"Investigate audit trail and field modification history for a specific record. Uses high-performance standalone query adhering to SAFE Guide Pitfall 11 to prevent query timeouts. Identifies who changed what, when, and old vs new values.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordId: {
				type: "string",
				description: "Record internal ID or document number (tranid).",
			},
			recordType: {
				type: "string",
				description:
					"Optional record type (e.g. salesorder, invoice, customer).",
			},
			limit: {
				type: "integer",
				description:
					"Maximum number of system notes to return. Default: 30, Max: 100.",
			},
		},
		required: ["recordId"],
	},
};

export const SUITECLOUD_UPLOAD_TOOL = {
	name: "netsuite_suitecloud_upload",
	description:
		"Upload script or asset files to NetSuite File Cabinet using SuiteCloud CLI ('suitecloud file:upload'). " +
		"In Sandbox, uploads execute directly. In Production, requires allowProduction=true when user authorizes upload to Production.",
	inputSchema: {
		type: "object" as const,
		properties: {
			paths: {
				type: "string",
				description:
					"File Cabinet path or local file path to upload (e.g. '/SuiteScripts/my_script.js').",
			},
			projectPath: {
				type: "string",
				description:
					"Optional SDF project root path. Auto-detected if omitted.",
			},
			dryRun: {
				type: "boolean",
				description:
					"Optional. If true, inspects local file and returns execution preview without uploading.",
			},
			allowProduction: {
				type: "boolean",
				description:
					"Explicit user authorization required if uploading to a Production account.",
			},
		},
		required: ["paths"],
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

═══ MANDATORY SUITEQL PROTOCOL & ON-DEMAND TEMPLATES ═══
1. RECONNAISSANCE: Call 'ns_getSuiteQLMetadata' to verify exact table and column names before querying unverified schemas.
2. GOLDEN TEMPLATES (ON-DEMAND): For multi-location inventory ('aggregateitemlocation'), transaction line items ('transactionline' with 'mainline=F'), lineage ('tl.createdfrom'), or GL impact ('transactionaccountingline'), call 'netsuite_get_query_template' or read 'netsuite://queries/golden-templates'.
3. MANDATORY SYNTAX RULES:
   • Explicit columns only — NEVER use 'SELECT *' or 'table.*'.
   • Oracle pagination: MUST use 'ROWNUM <= N' or 'FETCH FIRST N ROWS ONLY'. NEVER use 'LIMIT' or 'OFFSET'.
   • Dates: MUST wrap date literals in TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD').
   • Labels: Use BUILTIN.DF(field) instead of joining master tables.
   • Driving filters: Always filter high-volume tables (transaction, transactionline) by indexed columns (id, tranid, trandate, type, entity, subsidiary).
   • Prohibited joins: NEVER join 'SystemNote' directly (causes 45s+ timeouts; use 'netsuite_get_system_notes' instead).
4. ERROR-DRIVEN DIRECT CORRECTION: On syntax or schema errors, parse the diagnostic guidance, fix the query directly, and re-execute. Blind identical retries are prohibited.
5. PERMISSION HARD STOP: On 403 or INSUFFICIENT_PERMISSION, cease all operations immediately; never hallucinate fake data.`;

/**
 * Metadata usage hint to append to the `ns_getSuiteQLMetadata` tool description.
 */
export const METADATA_RULES_SUFFIX = `

⚠️ MANDATORY: Call this tool BEFORE writing any SuiteQL query to verify exact field names, types, and case-sensitivity.
- Fast Table Discovery: To discover available SuiteQL tables across all business domains (Inventory, Transactions, Manufacturing, Accounting, CRM, Custom Records) without network timeouts, pass a search keyword (e.g. \`{ keyword: 'inventory' }\`, \`{ keyword: 'transaction' }\`, \`{ keyword: 'order' }\`, \`{ keyword: 'account' }\`).
- Column Schema Inspection: To view exact column names, data types, and nullability for a specific table, provide recordType (e.g. \`{ recordType: 'aggregateitemlocation' }\`).
- Field names are CASE-SENSITIVE — use them exactly as returned (e.g., 'tranid' instead of 'TranId').
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
	INSPECT_RECORD_TOOL,
	GET_RECORD_DEFINITION_TOOL,
	GET_QUERY_TEMPLATE_TOOL,
	GET_SYSTEM_NOTES_TOOL,
	SUITECLOUD_UPLOAD_TOOL,
];
