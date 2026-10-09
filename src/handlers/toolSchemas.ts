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
		.optional()
		.describe(
			"Optional array of SuiteQL query strings to execute concurrently in parallel (max 10).",
		),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional safe maximum row limit (default: 100)."),
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
		.describe(
			"Numeric internal ID (e.g. '12345') or document number / tranid (e.g. 'SO10023').",
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
		.transform((v) => (v !== undefined ? Math.min(Math.max(v, 1), 200) : 50))
		.describe(
			"Maximum number of log entries to return. Default: 50, Max: 200.",
		),
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
		.describe(
			"Numeric internal ID (e.g. '12345') or document number (tranid).",
		),
	limit: z
		.number()
		.int()
		.optional()
		.transform((v) => (v !== undefined ? Math.min(Math.max(v, 1), 100) : 50))
		.describe(
			"Maximum number of audit trail entries to return. Default: 50, Max: 100.",
		),
});
export type GetSystemNotesArgs = z.infer<typeof GetSystemNotesArgsSchema>;

/**
 * 6. netsuite_deploy_script
 * Single authoritative tool for uploading SuiteScript files to NetSuite FileCabinet.
 */
export const DeployScriptArgsSchema = z.object({
	paths: z
		.union([z.string().trim().min(1), z.array(z.string().trim().min(1))])
		.describe("Relative or absolute path(s) to the local file(s) to upload."),
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
		.describe("Optional SDF CLI authId to use for deployment."),
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
export type DeployScriptArgs = z.infer<typeof DeployScriptArgsSchema>;

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
	includeDiagnostics: z
		.boolean()
		.optional()
		.default(false)
		.describe("Alias for includeErrors."),
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
});
export type AuthArgs = z.infer<typeof AuthArgsSchema>;

// ---------------------------------------------------------------------------
// 8 Authoritative Tool Definitions for MCP Server Registration
// ---------------------------------------------------------------------------

export const RUN_SUITEQL_TOOL = {
	name: "netsuite_run_suiteql",
	description: `Execute read-only Oracle NetSuite SuiteQL queries and return tabular results.
MANDATORY OFFICIAL SYNTAX RULES:
1. PROJECTION: NEVER use 'SELECT *'. Always specify explicit column names.
2. PAGINATION: Oracle-standard ONLY. Use 'FETCH FIRST N ROWS ONLY' or 'WHERE ROWNUM <= N'. NEVER use MySQL/Postgres 'LIMIT' or 'OFFSET'.
3. TRANSACTION LINES: When querying 'transactionline', MUST filter 'tl.mainline = 'T'' (header summary) or 'tl.mainline = 'F'' (item lines) to prevent duplicate sums.
4. LINEAGE: 'createdfrom' exists ONLY on 'transactionline', NEVER on 'transaction'.
5. ITEMS: 'item' table has 'itemtype' and 'subtype', NEVER 'recordtype'.
6. AUDIT: NEVER JOIN 'systemnote' directly (causes 45s+ timeouts). Use 'netsuite_get_system_notes'.
7. UNKNOWN SCHEMA: If not 100% sure of column names, MUST call 'netsuite_get_metadata' first before writing SQL.`,
	inputSchema: {
		type: "object" as const,
		properties: {
			sqlQuery: {
				type: "string",
				description:
					"The SuiteQL query string to execute. Follows Oracle NetSuite dialect rules above. Supports multiple statements separated by ';'.",
			},
			limit: {
				type: "number",
				description: "Optional safe row limit (default: 100).",
			},
		},
		required: ["sqlQuery"],
	},
};

export const GET_METADATA_TOOL = {
	name: "netsuite_get_metadata",
	description:
		"Inspect NetSuite database table schema, valid column names, and data types for SuiteQL and records. Powered by 2ms Redis cache and authoritative 272 records catalog.",
	inputSchema: {
		type: "object" as const,
		properties: {
			table: {
				type: "string",
				description:
					"NetSuite database table name or record type ID (e.g. 'customer', 'transaction', 'transactionline', 'item', 'salesorder').",
			},
			keyword: {
				type: "string",
				description:
					"Optional search keyword to filter column names, labels, or descriptions.",
			},
		},
		required: ["table"],
	},
};

export const GET_RECORD_TOOL = {
	name: "netsuite_get_record",
	description:
		"Retrieve and inspect a NetSuite record by numeric internal ID or document number (tranid). Returns cleaned header fields, custom fields, and an active Web UI link.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordType: {
				type: "string",
				description:
					"Record type (e.g. 'salesorder', 'customer', 'invoice', 'customrecord_xxx').",
			},
			id: {
				type: "string",
				description:
					"Numeric internal ID (e.g. '12345') or document number (tranid, e.g. 'SO10023').",
			},
			includeSublists: {
				type: "boolean",
				description:
					"Whether to include line items / sublists (default false).",
			},
			format: {
				type: "string",
				enum: ["markdown", "compact_json"],
				description: "Output format: 'markdown' (default) or 'compact_json'.",
			},
		},
		required: ["recordType", "id"],
	},
};

export const SCRIPT_LOGS_TOOL = {
	name: "netsuite_get_script_logs",
	description:
		"Query NetSuite SuiteScript execution logs (ScriptNote) by script, deployment, or record type with index optimization. Defaults to the last 7 days.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordType: {
				type: "string",
				description:
					"Optional filter by NetSuite record type (e.g. 'salesorder', 'customer'). Resolves all scripts deployed to this record type.",
			},
			scriptId: {
				type: "string",
				description:
					"Filter by script's Script ID (e.g. customscript_my_ue). Matches against Script.scriptid.",
			},
			type: {
				type: "string",
				enum: ["DEBUG", "AUDIT", "ERROR", "EMERGENCY"],
				description: "Filter by log level.",
			},
			dateFrom: {
				type: "string",
				description: "Start date in YYYY-MM-DD format (inclusive).",
			},
			dateTo: {
				type: "string",
				description: "End date in YYYY-MM-DD format (inclusive).",
			},
			keyword: {
				type: "string",
				description: "Filter by log title or detail keyword.",
			},
			deploymentId: {
				type: "string",
				description: "Filter by deployment Script ID.",
			},
			limit: {
				type: "number",
				description: "Max log entries to return (default: 50, max: 200).",
			},
		},
	},
};

export const SYSTEM_NOTES_TOOL = {
	name: "netsuite_get_system_notes",
	description:
		"Query system audit trail and field change history (SystemNote) for a specific record. Standalone indexed query preventing SAFE Pitfall 11 timeouts.",
	inputSchema: {
		type: "object" as const,
		properties: {
			recordType: {
				type: "string",
				description: "Optional record type (e.g. 'salesorder', 'customer').",
			},
			recordId: {
				type: "string",
				description: "Numeric internal ID or document number (tranid).",
			},
			limit: {
				type: "number",
				description: "Max audit entries to return (default: 50).",
			},
		},
		required: ["recordId"],
	},
};

export const DEPLOY_SCRIPT_TOOL = {
	name: "netsuite_deploy_script",
	description:
		"Upload SuiteScript files to NetSuite FileCabinet via SuiteCloud CLI. Includes syntax pre-flight check and production write barrier.",
	inputSchema: {
		type: "object" as const,
		properties: {
			paths: {
				oneOf: [
					{ type: "string" },
					{ type: "array", items: { type: "string" } },
				],
				description: "File path or array of file paths to upload.",
			},
			projectPath: {
				type: "string",
				description: "Optional SDF project root path.",
			},
			dryRun: {
				type: "boolean",
				description: "Validate files without uploading.",
			},
			skipValidation: {
				type: "boolean",
				description: "Skip pre-flight syntax validation.",
			},
			allowProduction: {
				type: "boolean",
				description:
					"Explicit confirmation required if deploying to a production account.",
			},
		},
		required: ["paths"],
	},
};

export const STATUS_TOOL = {
	name: "netsuite_status",
	description:
		"Check NetSuite connection status, active account environment (Sandbox vs. Production), OAuth token lifespan, and recent error diagnostics.",
	inputSchema: {
		type: "object" as const,
		properties: {
			includeErrors: {
				type: "boolean",
				description:
					"Whether to include recent error summary and self-healing advice.",
			},
		},
	},
};

export const AUTH_TOOL = {
	name: "netsuite_auth",
	description:
		"Manage NetSuite OAuth 2.0 PKCE authentication session and cache.",
	inputSchema: {
		type: "object" as const,
		properties: {
			action: {
				type: "string",
				enum: ["login", "logout", "refresh_cache"],
				description:
					"Action: 'login' (browser auth), 'logout' (revoke session), or 'refresh_cache' (clear Redis cache).",
			},
		},
		required: ["action"],
	},
};

/** All 8 Authoritative Tools exposed by NetSuite MCP Server. */
export const LOCAL_TOOLS = [
	RUN_SUITEQL_TOOL,
	GET_METADATA_TOOL,
	GET_RECORD_TOOL,
	SCRIPT_LOGS_TOOL,
	SYSTEM_NOTES_TOOL,
	DEPLOY_SCRIPT_TOOL,
	STATUS_TOOL,
	AUTH_TOOL,
];
