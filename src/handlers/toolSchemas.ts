import { z } from "zod";

// ---------------------------------------------------------------------------
// 8 Authoritative Zod Schemas & Inferred Types (Zero Bloat, First Principles)
// ---------------------------------------------------------------------------

/**
 * 1. netsuite_run_suiteql
 * Single authoritative tool for executing read-only SuiteQL queries.
 */
export const RunSuiteQLArgsSchema = z.object({
	sqlQuery: z
		.string()
		.trim()
		.optional()
		.describe(
			"The SuiteQL query string to execute. Follows Oracle NetSuite dialect rules. Multiple queries can be separated by ';'.",
		),
	sqlQueries: z
		.array(z.string())
		.max(
			10,
			"[Batch Limit Exceeded] A maximum of 10 queries can be executed in parallel.",
		)
		.optional()
		.describe(
			"Optional array of SuiteQL query strings to execute concurrently in parallel (max 10).",
		),
	customRecordMappings: z
		.array(
			z.object({
				rectype: z.union([z.string(), z.number()]),
				scriptId: z.string().optional(),
			}),
		)
		.optional()
		.describe(
			"Optional mappings for custom record types (rectype and scriptId).",
		),
	templateId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Optional verified Oracle SAFE golden template ID (e.g. 'transaction_lines', 'transaction_lineage', 'multi_location_inventory', 'general_ledger_impact', 'script_execution_errors', 'audit_system_notes', 'entity_balance_summary', 'item_inventory_status').",
		),
	templateParams: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			"Optional parameter key-value pairs to bind into the golden template (e.g. { ':tranType': \"'SalesOrd'\", ':tranId': '6257', ':docNumber': \"'SO10023'\" }).",
		),
});
export type RunSuiteQLArgs = z.infer<typeof RunSuiteQLArgsSchema>;

/**
 * 2. netsuite_get_metadata
 * Single authoritative tool for table schema, column definitions, and 272 records.
 */
export const GetMetadataArgsSchema = z.object({
	table: z
		.string()
		.trim()
		.toLowerCase()
		.optional()
		.describe(
			"NetSuite database table name or record type ID (e.g. 'customer', 'transaction', 'transactionline', 'item', 'salesorder'). Omit to list or search the table catalog.",
		),
	tables: z
		.array(z.string().trim().toLowerCase().min(1))
		.max(10, "A maximum of 10 tables can be inspected in parallel.")
		.optional()
		.describe(
			"Optional array of NetSuite database table names or record type IDs to inspect concurrently in parallel in a single turn (max 10).",
		),
	keyword: z
		.string()
		.trim()
		.optional()
		.describe(
			"Optional keyword to filter tables, column names, labels, or descriptions.",
		),
	source: z
		.enum(["auto", "offline", "remote"])
		.default("auto")
		.optional()
		.describe(
			"Metadata source: 'auto' (cached/remote), 'offline' (272 catalog), or 'remote' (live NetSuite API).",
		),
});
export type GetMetadataArgs = z.infer<typeof GetMetadataArgsSchema>;

/**
 * 3. netsuite_get_record
 * Single authoritative tool for inspecting records (with fields pruned + active Web UI link).
 */
export const GetRecordArgsSchema = z.object({
	recordType: z
		.string()
		.trim()
		.toLowerCase()
		.min(1, "recordType is required")
		.describe(
			"NetSuite record type ID (e.g. 'salesorder', 'customer', 'invoice', 'customrecord_xxx').",
		),
	id: z
		.string()
		.trim()
		.min(1, "id is required")
		.optional()
		.describe(
			"Numeric internal ID (e.g. '12345') or document number / tranid (e.g. 'SO10023').",
		),
	ids: z
		.array(z.string().trim().min(1, "id is required"))
		.min(1, "id is required")
		.max(10, "A maximum of 10 records can be inspected in parallel.")
		.optional()
		.describe(
			"Optional array of numeric internal IDs or document numbers (tranid) to inspect concurrently in parallel in a single turn (max 10).",
		),
	includeSublists: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			"Whether to include line-item sublists in the output (default: true).",
		),
	linesMode: z
		.enum(["all", "summary"])
		.optional()
		.default("all")
		.describe(
			"Line item detail mode: 'all' (full lines) or 'summary' (count summary only).",
		),
	maxLines: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of lines to display per sublist."),
	lineFields: z
		.array(z.string())
		.optional()
		.describe("Specific sublist columns/fields to include."),
	format: z
		.enum(["markdown", "compact_json"])
		.optional()
		.default("markdown")
		.describe("Output format: 'markdown' (default) or 'compact_json'."),
});
export type GetRecordArgs = z.infer<typeof GetRecordArgsSchema>;

/**
 * 4. netsuite_get_script_logs
 * Single authoritative tool for debugging SuiteScript execution logs (ScriptNote).
 */
export const GetScriptLogsArgsSchema = z.object({
	recordType: z
		.string()
		.trim()
		.toLowerCase()
		.optional()
		.describe(
			"Optional filter by NetSuite record type (e.g. 'salesorder', 'customer', 'invoice', 'customrecord_xxx'). Automatically resolves all scripts deployed to this record type via ScriptDeployment.",
		),
	scriptId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Filter by script's Script ID (e.g. customscript_my_ue). Matches against Script.scriptid.",
		),
	scriptIds: z
		.array(z.string().trim().min(1, "scriptId is required"))
		.min(1)
		.max(10, "A maximum of 10 script IDs can be queried concurrently.")
		.optional()
		.describe(
			"Optional array of script Script IDs (e.g. ['customscript_a', 'customscript_b']) to query concurrently in parallel (max 10).",
		),
	type: z
		.enum(["DEBUG", "AUDIT", "ERROR", "EMERGENCY"])
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
	title: z.string().trim().optional().describe("Filter by log title keyword."),
	detail: z
		.string()
		.trim()
		.optional()
		.describe("Filter by log detail keyword."),
	keyword: z
		.string()
		.trim()
		.optional()
		.describe("Filter by keyword matching log title or detail text."),
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
		.default(50)
		.describe(
			"Maximum number of log entries to return. Default: 50, Max: 200.",
		),
	format: z
		.enum(["markdown", "compact_json"])
		.optional()
		.default("markdown")
		.describe("Output format: 'markdown' (default) or 'compact_json'."),
});
export type GetScriptLogsArgs = z.infer<typeof GetScriptLogsArgsSchema>;

/**
 * 5. netsuite_get_system_notes
 * Single authoritative tool for record-level audit trail (SystemNote), preventing Pitfall 11 timeouts.
 */
export const GetSystemNotesArgsSchema = z.object({
	recordType: z
		.string()
		.trim()
		.toLowerCase()
		.optional()
		.describe(
			"Optional record type (e.g. 'salesorder', 'customer', 'invoice').",
		),
	recordId: z
		.string()
		.trim()
		.min(1, "recordId is required")
		.optional()
		.describe(
			"Numeric internal ID (e.g. '12345') or document number (tranid).",
		),
	recordIds: z
		.array(z.string().trim().min(1, "recordId is required"))
		.min(1)
		.max(10, "A maximum of 10 records can be queried in parallel.")
		.optional()
		.describe(
			"Optional array of numeric internal IDs or document numbers (tranid) to inspect audit trails concurrently in parallel in a single turn (max 10).",
		),
	limit: z
		.number()
		.int()
		.optional()
		.default(50)
		.describe(
			"Maximum number of audit trail entries to return. Default: 50, Max: 100.",
		),
});
export type GetSystemNotesArgs = z.infer<typeof GetSystemNotesArgsSchema>;

/**
 * 6. netsuite_upload_file
 * Single authoritative tool for uploading SuiteScript files to NetSuite FileCabinet.
 */
export const UploadFileArgsSchema = z.object({
	paths: z
		.union([
			z.string().trim().min(1),
			z
				.array(z.string().trim().min(1))
				.min(1)
				.max(10, "A maximum of 10 files can be uploaded concurrently."),
		])
		.describe(
			"Relative or absolute path(s) to the local file(s) to upload (max 10).",
		),
	projectPath: z
		.string()
		.trim()
		.optional()
		.describe(
			"Optional SDF project root path containing src/FileCabinet structure.",
		),
	authId: z
		.string()
		.trim()
		.optional()
		.describe("Optional SDF CLI authId to use for file upload."),
	dryRun: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"If true, inspects local files and validates syntax without executing upload.",
		),
	skipValidation: z
		.boolean()
		.optional()
		.default(false)
		.describe("If true, skips pre-flight SuiteScript syntax validation."),
	allowProduction: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Explicit user authorization required if uploading to a Production account.",
		),
});
export type UploadFileArgs = z.infer<typeof UploadFileArgsSchema>;

/**
 * 7. netsuite_status
 * Single authoritative tool for environment, authentication, and diagnostic health.
 */
export const StatusArgsSchema = z.object({
	includeErrors: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Whether to include recent error summary and self-healing recommendations.",
		),
});
export type StatusArgs = z.infer<typeof StatusArgsSchema>;

/**
 * 8. netsuite_auth
 * Single authoritative tool for managing OAuth 2.0 PKCE session and cache.
 */
export const AuthArgsSchema = z.object({
	action: z
		.enum(["login", "logout", "refresh_cache"])
		.describe(
			"Authentication action: 'login' (browser PKCE auth), 'logout' (revoke session), or 'refresh_cache' (clear Redis cache).",
		),
	accountId: z
		.string()
		.trim()
		.optional()
		.describe(
			"Optional NetSuite account ID (e.g. '123456', '9260916_SB1') for target session.",
		),
	clientId: z
		.string()
		.trim()
		.optional()
		.describe("Optional NetSuite OAuth 2.0 Client ID."),
	table: z
		.string()
		.trim()
		.optional()
		.describe(
			"Optional table name to clear cache for when action is 'refresh_cache'.",
		),
});
export type AuthArgs = z.infer<typeof AuthArgsSchema>;

/**
 * 9. netsuite_create_record (Sandbox Only)
 * Authoritative tool for creating NetSuite records in Sandbox / Test environments.
 */
export const CreateRecordArgsSchema = z
	.object({
		recordType: z
			.string()
			.trim()
			.toLowerCase()
			.min(1, "recordType is required")
			.describe(
				"NetSuite record type ID (e.g. 'salesorder', 'customer', 'invoice', 'customrecord_xxx').",
			),
		record: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"Key-value object containing the field IDs and values to populate on the new record.",
			),
	})
	.passthrough();
export type CreateRecordArgs = z.infer<typeof CreateRecordArgsSchema>;

/**
 * 10. netsuite_update_record (Sandbox Only)
 * Authoritative tool for updating NetSuite records in Sandbox / Test environments.
 */
export const UpdateRecordArgsSchema = z
	.object({
		recordType: z
			.string()
			.trim()
			.toLowerCase()
			.min(1, "recordType is required")
			.describe(
				"NetSuite record type ID (e.g. 'salesorder', 'customer', 'invoice', 'customrecord_xxx').",
			),
		id: z
			.string()
			.trim()
			.min(1, "id is required")
			.describe(
				"Numeric internal ID (e.g. '12345') or document number / tranid (e.g. 'SO10023').",
			),
		record: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"Key-value object containing the field IDs and values to update on the record.",
			),
	})
	.passthrough();
export type UpdateRecordArgs = z.infer<typeof UpdateRecordArgsSchema>;

/**
 * 11. netsuite_call_official
 * Universal gateway to inspect and invoke Oracle NetSuite official native tools (e.g. reports, saved searches).
 */
export const CallOfficialArgsSchema = z.object({
	action: z
		.enum(["call", "list", "schema"])
		.optional()
		.default("call")
		.describe(
			"Action to perform: 'call' (execute an official tool), 'list' (list all available official tools with descriptions), or 'schema' (retrieve input parameters schema for a specific tool).",
		),
	toolName: z
		.string()
		.trim()
		.optional()
		.describe(
			"The official NetSuite tool name to invoke or inspect (e.g. 'ns_runReport', 'ns_runSavedSearch', 'ns_listAllReports', 'ns_listSavedSearches', 'ns_getSubsidiaries', etc.). Required when action is 'call' or 'schema'.",
		),
	parameters: z
		.record(z.string(), z.unknown())
		.optional()
		.default({})
		.describe(
			"Key-value object containing the arguments to pass to the official NetSuite tool.",
		),
	format: z
		.enum(["markdown", "compact_json"])
		.optional()
		.default("markdown")
		.describe("Output format: 'markdown' (default) or 'compact_json'."),
});
export type CallOfficialArgs = z.infer<typeof CallOfficialArgsSchema>;

// ---------------------------------------------------------------------------
// Automatic MCP InputSchema Derivation from Zod Schemas
// ---------------------------------------------------------------------------

/**
 * Automatically derives standard MCP Tool inputSchema from a Zod Schema object,
 * preserving all descriptions, types, enums, constraints, and required fields.
 */
export function createToolInputSchema<T extends z.ZodObject<z.ZodRawShape>>(
	schema: T,
): {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
} {
	const jsonSchema = z.toJSONSchema(schema) as {
		properties?: Record<string, unknown>;
	};
	const required: string[] = [];
	for (const [key, field] of Object.entries(schema.shape)) {
		const candidate = field as unknown as { isOptional?: () => boolean };
		if (typeof candidate.isOptional === "function") {
			if (!candidate.isOptional()) {
				required.push(key);
			}
		}
	}
	const result: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	} = {
		type: "object",
		properties: jsonSchema.properties || {},
	};
	if (required.length > 0) {
		result.required = required;
	}
	return result;
}

// ---------------------------------------------------------------------------
// 8 Authoritative Tool Definitions for MCP Server Registration
// ---------------------------------------------------------------------------

export const RUN_SUITEQL_TOOL = {
	name: "netsuite_run_suiteql",
	description: `Execute read-only Oracle NetSuite SuiteQL queries and return tabular results. Supports single-turn parallel batch execution via 'sqlQueries' array or ';' separated statements.
MANDATORY OFFICIAL SYNTAX RULES:
1. PROJECTION: NEVER use 'SELECT *'. Always specify explicit column names.
2. PAGINATION (Situational, Not Mandatory): NetSuite does NOT support MySQL/Postgres 'LIMIT' or 'OFFSET'. Pagination is NOT mandatory. Intelligently judge based on context: for exploratory queries or scanning large transactional tables, explicitly author Oracle standard 'FETCH FIRST N ROWS ONLY' or 'WHERE ROWNUM <= N'. For unique key lookups, small lookup tables, or aggregations (COUNT/SUM), omit pagination. Queries are executed transparently without automatic rewriting.
3. BOOLEANS: NetSuite boolean fields are stored as 'T' or 'F' (e.g. isinactive = 'F', mainline = 'T', taxline = 'F'). NEVER use bare true/false or 1/0.
4. STRING CONCAT: Use Oracle standard '||' or CONCAT(a, b). NEVER use '+'.
5. TRANSACTION LINES: When querying 'transactionline', MUST filter 'tl.mainline = 'T'' (header summary) or 'tl.mainline = 'F'' (item lines) to prevent duplicate sums.
6. LINEAGE: 'createdfrom' exists ONLY on 'transactionline', NEVER on 'transaction'.
7. ITEMS: 'item' table has 'itemtype' and 'subtype', NEVER 'recordtype'.
8. SUBQUERIES IN FROM: Derived tables 'FROM (SELECT ...)' are prohibited. Use Common Table Expressions (WITH cte AS (...) SELECT ... FROM cte).
9. BUILTIN.DF IN GROUP BY: NEVER use 'BUILTIN.DF()' inside GROUP BY. Group by raw numeric ID, or wrap aggregation in a CTE.
10. AUDIT: NEVER JOIN 'systemnote' directly (causes 45s+ timeouts). Use 'netsuite_get_system_notes'.
11. UNKNOWN SCHEMA: If not 100% sure of column names, MUST call 'netsuite_get_metadata' first before writing SQL.
12. PARALLEL BATCHING: When retrieving multiple independent datasets, pass an array in 'sqlQueries' to execute concurrently in 1 turn.`,
	inputSchema: createToolInputSchema(RunSuiteQLArgsSchema),
};

export const GET_METADATA_TOOL = {
	name: "netsuite_get_metadata",
	description:
		"Inspect NetSuite database table schema, valid column names, and data types for SuiteQL and records. Supports single-turn parallel inspection of multiple tables via 'tables'. Powered by 2ms Redis cache and authoritative 272 records catalog.",
	inputSchema: createToolInputSchema(GetMetadataArgsSchema),
};

export const GET_RECORD_TOOL = {
	name: "netsuite_get_record",
	description:
		"Retrieve and inspect one or multiple NetSuite records concurrently by numeric internal ID or document number (tranid). Returns cleaned header fields, custom fields, and active Web UI links.",
	inputSchema: createToolInputSchema(GetRecordArgsSchema),
};

export const SCRIPT_LOGS_TOOL = {
	name: "netsuite_get_script_logs",
	description:
		"Query NetSuite SuiteScript execution logs (ScriptNote) by script, deployment, or record type with index optimization. Defaults to the last 7 days.",
	inputSchema: createToolInputSchema(GetScriptLogsArgsSchema),
};

export const SYSTEM_NOTES_TOOL = {
	name: "netsuite_get_system_notes",
	description:
		"Query system audit trail and field change history (SystemNote) for one or multiple records concurrently. Standalone indexed query preventing SAFE Pitfall 11 timeouts.",
	inputSchema: createToolInputSchema(GetSystemNotesArgsSchema),
};

export const UPLOAD_FILE_TOOL = {
	name: "netsuite_upload_file",
	description:
		"Upload SuiteScript or FileCabinet files to NetSuite via SuiteCloud CLI. Before invocation, confirmation must be requested via ask_question displaying '<folder>/<fileName>' (e.g. '9260916/script.js'). Includes syntax pre-flight check and production write barrier.",
	inputSchema: createToolInputSchema(UploadFileArgsSchema),
};

export const STATUS_TOOL = {
	name: "netsuite_status",
	description:
		"Check NetSuite connection status, active account environment (Sandbox vs. Production), OAuth token lifespan, and recent error diagnostics.",
	inputSchema: createToolInputSchema(StatusArgsSchema),
};

export const AUTH_TOOL = {
	name: "netsuite_auth",
	description:
		"Manage NetSuite OAuth 2.0 PKCE authentication session and cache.",
	inputSchema: createToolInputSchema(AuthArgsSchema),
};

export const CREATE_RECORD_TOOL = {
	name: "netsuite_create_record",
	description:
		"Create a new NetSuite record in Sandbox / Test environments. Physically blocked in Production to guarantee ERP data integrity. Automatically cleans noise and generates active Web UI direct link.",
	inputSchema: createToolInputSchema(CreateRecordArgsSchema),
};

export const UPDATE_RECORD_TOOL = {
	name: "netsuite_update_record",
	description:
		"Update an existing NetSuite record by numeric internal ID or document number (tranid) in Sandbox / Test environments. Physically blocked in Production. Automatically resolves natural keys and generates active Web UI direct link.",
	inputSchema: createToolInputSchema(UpdateRecordArgsSchema),
};

export const CALL_OFFICIAL_TOOL = {
	name: "netsuite_call_official",
	description:
		"[Official Fallback & Extension Gateway] Secondary gateway to invoke Oracle NetSuite's official native tools (e.g. ns_runReport, ns_runSavedSearch, ns_listAllReports, ns_getSubsidiaries). ALWAYS use primary custom tools (netsuite_run_suiteql, netsuite_get_record, netsuite_get_metadata, etc.) first. Use this tool ONLY when custom tools lack the required capability (e.g. native reports, saved searches) or when custom tools encounter an unresolvable error.",
	inputSchema: createToolInputSchema(CallOfficialArgsSchema),
};

/** Set of tools restricted strictly to Sandbox / Test environments. */
export const SANDBOX_MUTATION_TOOLS = new Set([
	"netsuite_create_record",
	"netsuite_update_record",
]);

/** All Authoritative Tools exposed by NetSuite MCP Server (8 Core + 2 Sandbox Mutation + 1 Official Gateway). */
export const LOCAL_TOOLS = [
	RUN_SUITEQL_TOOL,
	GET_METADATA_TOOL,
	GET_RECORD_TOOL,
	SCRIPT_LOGS_TOOL,
	SYSTEM_NOTES_TOOL,
	UPLOAD_FILE_TOOL,
	STATUS_TOOL,
	AUTH_TOOL,
	CREATE_RECORD_TOOL,
	UPDATE_RECORD_TOOL,
	CALL_OFFICIAL_TOOL,
];
