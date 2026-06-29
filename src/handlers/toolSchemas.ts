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
  name: 'netsuite_authenticate',
  description: 'Authenticate with NetSuite using OAuth 2.0 PKCE. Required before using any NetSuite tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      accountId: {
        type: 'string',
        description: 'NetSuite Account ID (e.g. 1234567 or 1234567_SB1). Falls back to NETSUITE_ACCOUNT_ID env var.'
      },
      clientId: {
        type: 'string',
        description: 'OAuth 2.0 Client ID from NetSuite integration record. Falls back to NETSUITE_CLIENT_ID env var.'
      }
    },
    required: []
  }
};

export const LOGOUT_TOOL = {
  name: 'netsuite_logout',
  description: 'Clear NetSuite authentication session and logout.',
  inputSchema: { type: 'object' as const, properties: {} }
};

export const RECORD_LINK_TOOL = {
  name: 'netsuite_get_record_link',
  description: 'Generate a direct NetSuite UI browser link to view a specific record.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      recordId: { type: 'string', description: 'Internal ID of the NetSuite record.' },
      recordType: { type: 'string', description: 'Record type (e.g. salesorder, customer, customrecord_xxx).' },
      accountId: { type: 'string', description: 'Override account ID (defaults to current authenticated account).' },
      rectype: { type: 'integer', description: 'Numeric custom record type ID. Auto-resolved if omitted.' }
    },
    required: ['recordId']
  }
};

export const REFRESH_CACHE_TOOL = {
  name: 'netsuite_refresh_cache',
  description: 'Force clear local cache and refresh NetSuite internal REST session cache. Can optionally clear cache for a single table/recordType.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tableName: {
        type: 'string',
        description: 'Optional: Specific NetSuite table or record type to clear from cache (e.g. customer, salesorder, customrecord_xxx).'
      }
    }
  }
};

export const PARALLEL_QUERIES_TOOL = {
  name: 'netsuite_run_parallel_queries',
  description: 'Execute multiple SuiteQL queries concurrently (max 5). Use this instead of calling ns_runCustomSuiteQL multiple times sequentially.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of SuiteQL query strings to execute in parallel.'
      }
    },
    required: ['queries']
  }
};

export const STATUS_TOOL = {
  name: 'netsuite_status',
  description: 'Show diagnostic information: authentication state, token expiry, account details, cache statistics, and environment type.',
  inputSchema: { type: 'object' as const, properties: {} }
};

/** All locally-handled tools (excluding AUTH_TOOL which has special routing). */
export const LOCAL_TOOLS = [RECORD_LINK_TOOL, REFRESH_CACHE_TOOL, LOGOUT_TOOL, PARALLEL_QUERIES_TOOL, STATUS_TOOL];

// ---------------------------------------------------------------------------
// Tool description enhancement suffixes
// ---------------------------------------------------------------------------

/**
 * SuiteQL rules to append to the `ns_runCustomSuiteQL` tool description.
 * These rules are embedded directly in the tool description so the AI agent
 * sees them at tool-discovery time, before writing any query.
 */
export const SUITEQL_RULES_SUFFIX = `
⚠️ MANDATORY RULES:
1. MUST call ns_getSuiteQLMetadata FIRST to verify table/field names before writing any query.
2. Do NOT use SELECT * — explicitly list all required fields.
3. MUST include pagination: FETCH FIRST N ROWS ONLY or ROWNUM <= N (do NOT use LIMIT).
4. Use TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD') for date comparisons — never use bare date strings.
5. Use || for string concatenation (not +).
6. Use BUILTIN.DF(field) to get display values instead of complex JOINs.
7. Do NOT use WITH/CTE, ILIKE, :: type casting, or square brackets [].
8. Use INNER JOIN / LEFT JOIN explicitly — no implicit comma joins.
9. Use NVL(field, default) for null handling.
10. Use id for primary keys (not internalid).
11. Use posting = 'T' where GL accuracy is required.
12. Use approvalstatus = 2 where approved-only data is required.
13. For 2+ independent queries, use netsuite_run_parallel_queries instead of calling this tool multiple times.`;

/**
 * Metadata usage hint to append to the `ns_getSuiteQLMetadata` tool description.
 */
export const METADATA_RULES_SUFFIX = `
⚠️ MUST be called before ns_runCustomSuiteQL to verify field names and types. Field names are case-sensitive — use them exactly as returned. Only fields marked x-n:joinable=true can be used in JOIN clauses.`;
