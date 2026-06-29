---
name: netsuite-mcp-dev-guide
description: >-
  NetSuite MCP Server 开发指南。涵盖项目架构（OAuth PKCE、双层缓存、StdioTransport）、
  源码结构、设计模式（McpError/textResult 错误处理、DI、环境隔离、工具描述增强）、
  TypeScript 命名规范（ns_ vs netsuite_ 前缀）、认证生命周期、Token 刷新调度，
  以及如何扩展 Server 添加新工具。在修改 src/ 目录下的代码时激活此 skill。
---

# NetSuite MCP Server — Development Guide

This skill contains the architecture, design patterns, and extensibility guide for the NetSuite MCP Server (`@suiteinsider/netsuite-mcp`).

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
    ├── errors.ts              # Error formatting with actionable advice
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

## 🧠 Server Extensibility

- **Adding Tools:** Add new tool schemas in `src/handlers/toolSchemas.ts`, then add the handler function in `src/handlers/tools.ts` as a standalone `async function handleXxx()`.
- **Utilities:** Place reusable utilities in `src/utils/`.
- **Workspace AGENTS.md:** The `workspace-agents/` directory contains the AGENTS.md template (`AGENTS.template.md`) and workspace config (`workspaces.json`) for all client NetSuite projects. After modifying MCP tools or behaviors, update the template and run `npm run sync-agents` to propagate changes to all workspaces. Use `npm run sync-agents -- --dry-run` to preview.

---

## 🔄 Caching

- `CacheService` is a singleton configured at startup via `cacheService.configure(projectRoot)`.
- Metadata cache is self-healing: automatically invalidated for affected tables when a SuiteQL error occurs.
- Use `netsuite_refresh_cache` to clear all caches.

---

## 🔐 Authentication Lifecycle

- **Dynamic Mappings:** `fetchCustomRecordMappings()` is called after successful authentication, not in the constructor.
- **Token Maintenance:** `TokenRefreshScheduler` proactively refreshes tokens before they expire (checked every 60 seconds).
- **Transient Failures:** On `401 Unauthorized`, tools auto-retry once after force-refreshing the access token.
