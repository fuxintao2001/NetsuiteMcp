# NetSuite MCP Server — AI Developer Guide

This repository contains the source code for the **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`). It exposes NetSuite functionalities to AI agents over the Model Context Protocol (MCP).

---

## 🚀 Architecture Overview

- **Language & Runtime:** TypeScript (strict mode) on Node.js ≥ 18 (ESM).
- **Compilation:** Source in `src/` → compiled to `dist/` via `tsc`.
- **Transport:** Standard I/O (`StdioServerTransport`). Entry point: `dist/index.js`.
- **Authentication:** OAuth 2.0 Authorization Code Grant with PKCE (public client). No client secret needed.
- **Resilience:** Proactive token refresh scheduler (runs every 60 seconds) and automatic retry (once) on transient `401 Unauthorized` errors.
- **Caching:** Dual-layer cache service:
  - **L1 Cache:** In-memory (`node-cache` with a default TTL of 1 hour).
  - **L2 Cache:** File system-backed persistent cache under `.cache/`.
- **Capabilities:** Exposes both MCP Tools (`ns_` and `netsuite_` prefixes) and MCP Resources (e.g. SuiteQL guide).

---

## 📂 Source Structure

```
src/
├── index.ts                   # Server bootstrap, handler wiring, and Zod env validation
├── handlers/
│   ├── tools.ts               # MCP tool registration + local tool handlers
│   ├── toolSchemas.ts         # Tool schema definitions + description enhancement strings
│   ├── resources.ts           # MCP resource registration + local resource handlers
│   └── handlers.test.ts       # Test suite for tool handlers
├── mcp/
│   ├── tools.ts               # NetSuite REST API client (JSON-RPC 2.0)
│   └── tools.test.ts          # Test suite for API client
├── oauth/
│   ├── manager.ts             # OAuth flow orchestrator
│   ├── callbackServer.ts      # Local HTTP callback server for OAuth redirect
│   ├── tokenExchange.ts       # Token exchange & refresh logic
│   ├── sessionStorage.ts      # Session file I/O (types: SessionData, TokenData)
│   ├── pkce.ts                # PKCE challenge & verifier generation
│   └── *.test.ts              # Unit tests for OAuth components
└── utils/
    ├── cache.ts               # CacheService singleton (L1 + L2)
    ├── environment.ts         # isSandboxAccount() + buildEnvSuffix() shared helpers
    ├── envValidator.ts        # Startup environment configuration schema (Zod validation)
    ├── resilience.ts          # TokenRefreshScheduler class
    ├── netsuiteUrls.ts        # NetSuite UI deep link URL generation
    ├── browserLauncher.ts     # Cross-platform browser opener using secure execFile
    ├── json.ts                # Non-blocking JSON parser (asyncJsonParse) for large datasets
    └── *.test.ts              # Unit tests for utilities
```

---

## ⚙️ Development & Testing Commands

| Command | Description |
|---|---|
| `npm run build` | Clean build (`rimraf dist && tsc`) |
| `npm test` | Run all Jest tests |
| `npm run start` | Start the server in production mode (runs from `dist/`) |
| `npm run dev` | Start the server in development mode (via `tsx`) |

---

## 🔧 Key Design Patterns

### 1. Error Handling
- **MCP-Facing Errors:** Must use `McpError` combined with `ErrorCode` from `@modelcontextprotocol/sdk/types.js`.
  ```typescript
  throw new McpError(ErrorCode.InvalidRequest, 'Write operations disabled in production');
  ```
- **Business/Tool-Level Errors:** Return `{ isError: true }` wrapped in the `textResult()` helper.
  ```typescript
  return textResult('❌ Not authenticated.', true);
  ```
- **Constraint:** In the `CallToolRequestSchema` catch block, `McpError` is always rethrown. All other errors are returned as `textResult(isError: true)`.
- **Global handlers:** `uncaughtException` and `unhandledRejection` log errors but **NEVER call `process.exit()`**. This prevents transient network errors from killing the server.

### 2. Tool Response Helper
All tool handlers wrap text responses in `textResult()`:
```typescript
export function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}
```

### 3. Dependency Injection
`registerToolHandlers()` accepts a unified `ToolHandlerDeps` object:
```typescript
interface ToolHandlerDeps {
  server: Server;
  oauthManager: OAuthManager;
  mcpTools: NetSuiteMCPTools;
  projectRoot: string;
  handleAuthentication: (args: Record<string, unknown>) => Promise<ToolResponse>;
  handleLogout: () => Promise<ToolResponse>;
  handleCacheRefresh: () => Promise<ToolResponse>;
  resolveCustomRecordRectype: (type: string) => number | null;
}
```

### 4. Write Operations Control
> [!IMPORTANT]
> Write operations (`ns_createRecord`, `ns_updateRecord`) are strictly disabled in **Production environments**. They are **fully enabled in Sandbox/Test environments** (account IDs containing `_SB` or starting with `TSTDRV`). Environment detection is centralized in `src/utils/environment.ts` via `isSandboxAccount()`.

### 5. TypeScript & Naming Conventions
- `tsconfig.json` enforces `"strict": true`. All code must be fully typed.
- **Naming Prefix Protocol:**
  - `ns_` prefix: NetSuite-proxied tools (routed to NetSuite REST API).
  - `netsuite_` prefix: Local tools (handled entirely within the MCP server).

### 6. Environment Isolation & Labeling
- **Dynamic Suffixes:** Every tool description dynamically appends ` [Account: <accountId>, Env: <Sandbox/Production>]` during tool discovery (`list_tools`) via `buildEnvSuffix()` in `src/utils/environment.ts`.
- **Configuration-Layer Isolation:** Each NetSuite workspace has a project-level `.gemini/settings.json` that only activates the corresponding MCP server instance. This replaces runtime workspace detection — the server no longer inspects IDE workspaces at runtime.

### 7. Tool Description Enhancement
- During `list_tools`, tool descriptions fetched from the NetSuite MCP API are dynamically enhanced with usage rules:
  - `ns_runCustomSuiteQL` gets SuiteQL mandatory rules appended (defined in `SUITEQL_RULES_SUFFIX` in `src/handlers/toolSchemas.ts`).
  - `ns_getSuiteQLMetadata` gets metadata usage hints appended (defined in `METADATA_RULES_SUFFIX`).
- This ensures AI agents see critical rules at tool-discovery time, before writing any query.

---

## 🧠 AI Agent Operating Procedures (SOP)

### 1. NetSuite SuiteQL Rules


- **Syntax Reference:** For detailed SuiteQL syntax specifications, Oracle SQL function usages, NetSuite built-in functions, and common query patterns, always refer to the local [SUITEQL_GUIDE.md](file://./SUITEQL_GUIDE.md) in the workspace root, or retrieve the guide directly via the MCP Resource `netsuite://guides/suiteql`.
- **Script Execution Logs:** You can query script execution logs from the `ScriptNote` table (see Section 7 of `SUITEQL_GUIDE.md` or the MCP Resource for patterns).
Before executing SQL queries, you must strictly follow these rules:

#### Basic Rules
- Do NOT use `SELECT *`; you must explicitly list all required fields.
- All queries MUST include a pagination limit: `FETCH FIRST 100 ROWS ONLY` (or use `WHERE ROWNUM <= N`).
- Table and field names are case-sensitive and must match the NetSuite Schema exactly.
- **You MUST call `ns_getSuiteQLMetadata` to verify the table schema before querying.** Never guess field names.

#### Syntax Rules (SuiteQL is based on a subset of Oracle SQL syntax)
- **JOIN:** Explicitly use `INNER JOIN` / `LEFT JOIN`; implicit comma joins are prohibited.
- **Null Value Handling:** Prefer `NVL(field, default)`. `COALESCE` is supported but do not mix Oracle syntax.
- **Date Parameters:** You MUST use `TO_DATE('2024-01-01', 'YYYY-MM-DD')`; direct date string literals are prohibited.
- **String Concatenation:** Use the `||` operator; `+` concatenation is not supported.
- Do NOT use MySQL / PostgreSQL specific syntax (e.g., `LIMIT`, `ILIKE`, `::` type casting).
- Do NOT mix SQL-92 syntax and Oracle-proprietary syntax in a single query.
- **`WITH` (CTE) clauses are NOT supported.** Use subqueries instead.
- **`Square brackets []` are NOT supported.**
- A single `IN` clause can contain a maximum of 1000 parameters.

#### Built-in Functions
- Use `BUILTIN.DF(field_name)` to get the display value of a field (avoid complex JOINs).
- Use `BUILTIN.CONSOLIDATE` for currency conversion.
- All built-in functions must be prefixed with `BUILTIN.`.

#### Common Field Conventions
- Use `id` for primary keys (do NOT use `internalid`).
- Note the difference between transaction amounts: `transamount` (local currency) vs. `foreignamount` (foreign currency).
- Status fields are usually encoded; use `BUILTIN.DF(status)` to get the display name.
- Only fields marked as `x-n:joinable: true` in the metadata are allowed in JOIN clauses.

#### Prohibited Actions
- Do NOT hardcode any environment-specific IDs (internal IDs differ between Sandbox and Production).
- Do NOT omit aliases in subqueries.
- Do NOT use `CREATE VIEW`.

> [!IMPORTANT]
> **🚨 Parallel Query Rule:** If you need to execute two or more independent SuiteQL queries, you **MUST** run them concurrently using `netsuite_run_parallel_queries`. **Directly calling `ns_runCustomSuiteQL` sequentially is strictly prohibited** unless a subsequent query depends on the output of a previous one.

---

### 2. NetSuite Record Operations

- **SOP:** **ALWAYS** call `ns_getRecordTypeMetadata` before retrieving or modifying a record to verify its schema.
- **Write Restriction:** Write operations are only permitted in sandbox/test environments.
- **Deep Linking:** After locating or reading a record, use `netsuite_get_record_link` to generate a clickable UI link.

---

### 3. SuiteCloud Agent Skills SOP

This MCP server exposes official Oracle NetSuite SuiteCloud Agent Skills as MCP resources under `netsuite://skills/<skill-name>`. You must follow these guidelines:
- **Tool Selection Strategy:** When deciding which tool to call, strictly adhere to the following priority:
  `PRIORITY 1 → Reports` | `PRIORITY 2 → Saved Searches` | `PRIORITY 3 → Records` | `PRIORITY 4 → SuiteQL (Last Resort)`.
- **Domain Knowledge Lookup:** Before writing any SuiteScript code or working on SDF configurations, check the corresponding skill resource (e.g., `netsuite://skills/netsuite-owasp-secure-coding`, `netsuite://skills/netsuite-suitescript-upgrade`, etc.) to align with NetSuite's official standards.
- **Multi-Subsidiary & Currency Handling:** Before pulling financial datasets, explicitly clarify if the user wants consolidated data or data for a specific subsidiary.
- **OWASP Secure Coding:** Follow the OWASP Top 10 guidelines provided in `netsuite://skills/netsuite-owasp-secure-coding` for RESTlets, Suitelets, and Client Scripts, especially input validation and output encoding.

---

### 4. Server Extensibility

- **Adding Tools:** Add new tool schemas in `src/handlers/toolSchemas.ts`, then add the handler function in `src/handlers/tools.ts` as a standalone `async function handleXxx()`.
- **Utilities:** Place reusable utilities in `src/utils/`.

---

### 5. Caching

- `CacheService` is a singleton configured at startup via `cacheService.configure(projectRoot)`.
- Metadata cache is self-healing: automatically invalidated for affected tables when a SuiteQL error occurs.
- Use `netsuite_refresh_cache` to clear all caches.

---

### 6. Authentication Lifecycle

- **Dynamic Mappings:** `fetchCustomRecordMappings()` is called after successful authentication, not in the constructor.
- **Token Maintenance:** `TokenRefreshScheduler` proactively refreshes tokens before they expire (checked every 60 seconds).
- **Transient Failures:** On `401 Unauthorized`, tools auto-retry once after force-refreshing the access token.

---
## 🛠️ MCP Tools Reference

### Local Tools (`netsuite_` prefix)

- **`netsuite_authenticate`**: Start OAuth 2.0 PKCE authentication flow.
  - *Arguments:* `accountId` (optional), `clientId` (optional). Falls back to environment variables.
- **`netsuite_logout`**: Clear NetSuite authentication session.
- **`netsuite_refresh_cache`**: Force clear L1/L2 metadata caches and NetSuite REST session cache.
- **`netsuite_get_record_link`**: Generate a direct browser URL to view a record in NetSuite.
  - *Arguments:* `recordId` (string, required), `recordType` (string, optional), `accountId` (string, optional), `rectype` (integer, optional).
- **`netsuite_run_parallel_queries`**: Concurrently execute multiple SuiteQL queries (up to 5 in parallel).
  - *Arguments:* `queries` (array of strings, required).

### NetSuite Proxied Tools (`ns_` prefix)

- **`ns_getRecord`**: Retrieve a specific record from NetSuite.
- **`ns_getRecordTypeMetadata`**: Retrieve the metadata for a record type.
- **`ns_runReport`**: Run a NetSuite financial/functional report.
- **`ns_listAllReports`**: Retrieve a list of all available reports.
- **`ns_getSubsidiaries`**: Retrieve the list of subsidiaries.
- **`ns_getAccountingBooks`**: Retrieve the list of accounting books.
- **`ns_getAccountingContexts`**: Retrieve the list of accounting contexts.
- **`ns_getNexusIds`**: Retrieve the list of tax nexuses.
- **`ns_runCustomSuiteQL`**: Execute a custom SuiteQL query string.
- **`ns_getSuiteQLMetadata`**: Retrieve schema/metadata for a SuiteQL table.

---

## 📂 MCP Resources Reference

- **`netsuite://guides/suiteql`**: Access the complete SuiteQL syntax, Oracle SQL subset rules, and query reference guide (including ScriptNote log queries) directly via the MCP Resource.
- **`netsuite://skills/<skill-name>`**: Access official NetSuite SuiteCloud Agent Skills (e.g., `netsuite-ai-connector-instructions`, `netsuite-owasp-secure-coding`, `netsuite-suitescript-records-reference`, `netsuite-suitescript-upgrade`, etc.) directly via the MCP Resource.
