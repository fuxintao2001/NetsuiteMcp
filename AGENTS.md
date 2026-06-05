# NetSuite MCP Server — AI Developer Guide

This repository contains the source code for the **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`). It exposes NetSuite functionalities to AI agents over the Model Context Protocol (MCP).

---

## 🚀 Architecture Overview

- **Language & Runtime:** TypeScript (strict mode) on Node.js ≥ 18 (ESM).
- **Compilation:** Source in `src/` → compiled to `dist/` via `tsc`.
- **Transport:** Standard I/O (`StdioServerTransport`). Entry point: `dist/index.js`.
- **Authentication:** OAuth 2.0 with PKCE (public client). No client secret needed.
- **Resilience:** Automatic token refresh scheduler (runs every 10 minutes) and automatic retry (once) on transient `401 Unauthorized` errors.
- **Caching:** Dual-layer cache service:
  - **L1 Cache:** In-memory (`node-cache` with a default TTL of 1 hour).
  - **L2 Cache:** File system-backed persistent cache under `.cache/`.

---

## 📂 Source Structure

```
src/
├── index.ts                   # Server bootstrap, handler wiring, and Zod env validation
├── handlers/
│   ├── tools.ts               # MCP tool registration + local tool handlers
│   ├── resources.ts           # MCP resource handlers (memory://sql-cheat-sheet)
│   ├── prompts.ts             # MCP prompt handlers (netsuite-sql-expert)
│   └── handlers.test.ts       # Test suite for tools, resources, and prompts handlers
├── mcp/
│   ├── tools.ts               # NetSuite REST API client (read-only record & query execution)
│   └── tools.test.ts          # Test suite for NetSuite REST API tools
├── oauth/
│   ├── manager.ts             # OAuth flow orchestrator
│   ├── callbackServer.ts      # Local HTTP callback server for OAuth redirect
│   ├── tokenExchange.ts       # Token exchange & refresh logic
│   ├── sessionStorage.ts      # Session file I/O (types: SessionData, TokenData)
│   ├── pkce.ts                # PKCE challenge & verifier generation
│   └── *.test.ts              # Unit tests for OAuth components
└── utils/
    ├── cache.ts               # CacheService singleton (L1 + L2)
    ├── envValidator.ts        # Startup environment configuration schema (Zod validation)
    ├── sqlValidator.ts        # SuiteQL AST (node-sql-parser) & RegExp spelling validator
    ├── resilience.ts          # retryWithBackoff helper & TokenRefreshScheduler class
    ├── sqlMemory.ts           # Shared SQL memory template & file system helpers
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
| `npm test` | Run all Jest tests (66 tests across 9 suites) |
| `npm run start` | Start the server in production mode (runs from `dist/`) |
| `npm run dev` | Start the server in development mode (via `tsx`) |

---

## 🔧 Key Design Patterns

### 1. Error Handling
- **MCP-Facing Errors:** Must use `McpError` combined with `ErrorCode` from `@modelcontextprotocol/sdk/types.js`.
  ```typescript
  import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
  throw new McpError(ErrorCode.InvalidRequest, 'Resource not found');
  throw new McpError(ErrorCode.InternalError, 'Failed to read file');
  throw new McpError(ErrorCode.MethodNotFound, 'Prompt not found');
  ```
- **Business/Tool-Level Errors:** Return `{ isError: true }` wrapped in the `textResult()` helper.
  ```typescript
  return textResult('❌ Not authenticated.', true);
  ```
- **Constraint:** Never throw raw `new Error()` from top-level MCP request handlers; always map them to `McpError` or return error status in the results.

### 2. Tool Response Helper
All tool handlers wrap text responses in `textResult()` to narrow the response type to the literal required by the MCP SDK:
```typescript
function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
}
```

### 3. Dependency Injection
`registerToolHandlers()` accepts a unified `ToolHandlerDeps` object, facilitating cleaner testing and decoupling:
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
> To ensure production database integrity, write operations (`ns_createRecord`, `ns_updateRecord`) are strictly disabled in **Production environments**. However, they are **fully enabled in Sandbox/Test environments** (which are identified by account IDs containing `_SB` or starting with `TSTDRV`).

### 5. TypeScript & Naming Conventions
- `tsconfig.json` enforces `"strict": true`. All code must be fully typed; avoid using `any` in public APIs. Use `unknown` with type guards or concrete interfaces.
- **Naming Prefix Protocol:**
  - `ns_` prefix: NetSuite-proxied tools (routed to NetSuite REST API).
  - `netsuite_` prefix: Local tools (handled entirely within the MCP server).

---

## 🧠 AI Agent Operating Procedures (SOP)

### 1. SuiteQL Queries (`ns_runCustomSuiteQL`)

> [!NOTE]
> NetSuite SuiteQL queries must be designed carefully to avoid schema mismatches, table locks, and query timeouts.

- **SOP:** Always read the resource `memory://sql-cheat-sheet` BEFORE drafting any query. You can also invoke the Prompt `netsuite-sql-expert` to automatically inject this context.
- **Table Verification:** **NEVER** guess table schemas or column names. Call `ns_getSuiteQLMetadata` first to verify schemas.
- **Join Rule:** Only perform `JOIN` operations on fields explicitly marked with `x-n:joinable: true` in the table's metadata.
- **Display Fields:** Prefer using `BUILTIN.DF(field_name)` to retrieve display names instead of writing complex `JOIN` statements against lookup tables.
- **Pagination & Limits:** Apply `ROWNUM` limits where appropriate to prevent timeouts. Note that query results are returned in full without silent auto-limiting to ensure calculation accuracy.
- **Error Tracking:** If a query fails and you successfully correct it, **ALWAYS** call `netsuite_save_sql_error` to log the incorrect SQL, the corrected SQL, and the prevention rule. This updates the local `.gemini_sql_memory.md` file to prevent future mistakes.

> [!IMPORTANT]
> **🚨 PARALLEL RULE:** If you need to execute two or more SuiteQL queries (e.g., fetching related data, batch querying multiple tables, or retrieving multiple pages of results), you **MUST** use `netsuite_run_parallel_queries` to execute them concurrently instead of calling `ns_runCustomSuiteQL` sequentially. Sequential query execution is **STRICTLY PROHIBITED** unless a subsequent query depends directly on the output of a prior query.

---

### 2. NetSuite Record Operations

- **SOP:** **ALWAYS** call `ns_getRecordTypeMetadata` before retrieving or modifying a record to verify its schema/properties and prevent errors.
- **Write Restriction:** Direct write operations (`ns_createRecord`, `ns_updateRecord`) are only permitted in sandbox/test environments. They will return an error in production environments.
- **Deep Linking:** After successfully locating or reading a record, use the tool `netsuite_get_record_link` to generate a clickable NetSuite UI deep link. This deep link is also automatically appended to responses for record operations.
- **Dataset Completeness:** Always use `ns_getRecord` to fetch the full record and ensure the AI receives complete datasets.

---

### 3. Server Extensibility & Refactoring

- **Adding Tools:** Add new local tools or operations in `src/handlers/tools.ts`. Extract the tool's implementation into a standalone `async function handleXxx()`.
- **Adding Resources:** Add read-only endpoints to `src/handlers/resources.ts`. Throw `McpError(ErrorCode.InvalidRequest, ...)` for unknown URIs.
- **Adding Prompts:** Add templated workflows to `src/handlers/prompts.ts`. Register them in the `ListPromptsRequestSchema` handler so clients can discover them.
- **Utilities:** Place reusable utilities in `src/utils/` (following the pattern of `src/utils/sqlMemory.ts` or `src/utils/json.ts`).

---

### 4. Caching

- `CacheService` is a singleton configured at startup via `cacheService.configure(projectRoot)`.
- Metadata cache is self-healing: it automatically invalidates for affected tables when a SuiteQL error occurs.
- To clear both L1/L2 and NetSuite REST session caches completely, use the `netsuite_refresh_cache` tool.

---

### 5. Authentication Lifecycle

- **Dynamic Mappings:** `fetchCustomRecordMappings()` is called after successful authentication, not in the class constructor, ensuring server initialization doesn't block on NetSuite network requests.
- **Token Maintenance:** `TokenRefreshScheduler` proactively refreshes tokens before they expire (checked every 10 minutes).
- **Transient Failures:** On receiving a `401 Unauthorized` response, tools auto-retry once after force-refreshing the access token.

---

## 🛠️ MCP Tools Reference

### Local Tools (`netsuite_` prefix)

- **`netsuite_authenticate`**: Start OAuth 2.0 PKCE authentication flow.
  - *Arguments:* `accountId` (optional), `clientId` (optional). Falls back to environment variables.
- **`netsuite_logout`**: Clear NetSuite authentication session and delete local session files.
- **`netsuite_refresh_cache`**: Force clear L1/L2 metadata caches and NetSuite REST session cache.
- **`netsuite_get_record_link`**: Generate a direct browser URL to view a record in NetSuite.
  - *Arguments:* `recordId` (string, required), `recordType` (string, optional), `accountId` (string, optional), `rectype` (integer, optional).
- **`netsuite_save_sql_error`**: Log a resolved SuiteQL query error to `.gemini_sql_memory.md`.
  - *Arguments:* `errorDescription` (string, required), `incorrectSql` (string, required), `correctSql` (string, required), `rule` (string, required), `workspacePath` (string, optional).
- **`netsuite_run_parallel_queries`**: Concurrently execute multiple SuiteQL queries (up to 5 in parallel).
  - *Arguments:* `queries` (array of strings, required).

### NetSuite Proxied Tools (`ns_` prefix)

- **`ns_getRecord`**: Retrieve a specific record from NetSuite.
  - *Arguments:* `recordType` (string, required), `id` (string, required).
- **`ns_getRecordTypeMetadata`**: Retrieve the metadata for a record type.
  - *Arguments:* `recordType` (string, required).
- **`ns_runReport`**: Run a NetSuite financial/functional report.
  - *Arguments:* `reportId` (string, required).
- **`ns_listAllReports`**: Retrieve a list of all available reports in NetSuite.
- **`ns_getSubsidiaries`**: Retrieve the list of subsidiaries.
- **`ns_getAccountingBooks`**: Retrieve the list of accounting books.
- **`ns_getAccountingContexts`**: Retrieve the list of accounting contexts.
- **`ns_getNexusIds`**: Retrieve the list of tax nexuses.
- **`ns_runCustomSuiteQL`**: Execute a custom SuiteQL query string.
  - *Arguments:* `sqlQuery` (string, required).
- **`ns_getSuiteQLMetadata`**: Retrieve schema/metadata for a SuiteQL table.
  - *Arguments:* `tableName` (string, required).

---

## 📚 Prompts & Resources Reference

### Resources
- **`memory://sql-cheat-sheet`**: Exposes the contents of `.gemini_sql_memory.md` containing NetSuite SQL structures, guidelines, and recorded query errors with solutions.

### Prompts
- **`netsuite-sql-expert`**: Prepares the AI with the SQL cheat sheet and historical error logs, guiding the agent to draft robust, error-free SuiteQL queries.
  - *Arguments:* `task` (string, optional description of the SQL task).
