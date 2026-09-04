# NetSuite MCP Server

An enterprise-grade Model Context Protocol (MCP) server providing AI agents with secure, high-performance access to Oracle NetSuite ERP data and SuiteCloud developer operations.

Built for seamless integration with MCP clients including **Claude Code**, **Cursor IDE**, **Gemini CLI**, **Windsurf**, and **Roo Code**.

---

## 🌟 Key Capabilities

- 🔐 **OAuth 2.0 PKCE Authentication**: Secure public-client authentication without client secrets. Proactive token rotation and auto-recovery survive server restarts.
- ⚡ **Industry-Standard Stdio Transport**: Native standard I/O communication for local IDEs and CLI coding agents. Zero network port conflicts, zero SSRF attack surface, and automatic lifecycle management bound to your MCP client.
- 🔒 **Distributed Cache & Concurrency Safety**: Pure Redis caching (`ioredis`) backed by Redlock distributed locks (`redlock`) to prevent concurrent token refresh race conditions across multi-worker environments.
- 🛡️ **Runtime SQL Guardrails & Self-Healing (`suiteqlGuard`)**:
  - Hard-blocks dangerous wildcard projections (`SELECT *`) to preserve LLM token context.
  - Intercepts dialect mistakes (e.g. MySQL `LIMIT/OFFSET`) and guides to Oracle NetSuite standards (`FETCH FIRST N ROWS ONLY` or `ROWNUM <= N`).
  - Blocks high-latency anti-patterns (e.g. `JOIN SystemNote` which triggers 45s+ timeouts) and directs to optimized standalone alternatives.
  - Prevents schema hallucinations (e.g. redirects `transaction.createdfrom` to `transactionline.createdfrom`, and `item.recordtype` to `itemtype`).
  - Auto-injects `tl.mainline = 'F'` and pagination bounds when missing.
- 🚦 **Dual-Gate Production Safety**:
  - Write operations (`ns_createRecord`, `ns_updateRecord`) are automatically disabled in Production accounts and only permitted in Sandbox/Test (`_SB`, `TSTDRV`).
  - Code deployment (`netsuite_suitecloud_upload`) requires explicit `allowProduction: true` confirmation before uploading scripts to Production accounts.
- 🗜️ **Context Slimming & Token Economy**:
  - Strips null/empty noise from NetSuite JSON payloads.
  - Automatically formats query results and metadata into dense, readable Markdown tables, cutting LLM context consumption by over 60%.
- 📚 **Native MCP Resources & Prompts (Out-of-the-Box)**:
  - Exposes 272 standard NetSuite record definitions (`netsuite://records/reference`).
  - Curated SuiteQL golden templates (`netsuite://queries/golden-templates`).
  - SuiteCloud Agent Skills integration (`netsuite://skills/*`).
  - Ready-to-use prompt templates for SuiteScript 2.1 code reviews, error stack trace debugging, and SuiteQL generation.
- 🔄 **Daemon & Background Keepalive**:
  - Background scheduler proactively refreshes OAuth tokens before expiration.
  - Native macOS LaunchAgent daemon keeps tokens fresh 24/7 without manual user re-authentication.

---

## 🏛️ System Architecture

```
                      MCP Clients
       (Claude Code / Cursor / Windsurf / Gemini CLI)
                             │
                      stdio (JSON-RPC)
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      NetSuite MCP Core                      │
│                                                             │
│  ┌───────────────────┐  ┌─────────────────┐  ┌───────────┐  │
│  │   OAuth Manager   │  │ Runtime Guards  │  │  Context  │  │
│  │  - PKCE Flow      │  │  - AST Parser   │  │  Slimmer  │  │
│  │  - Token Rotation │  │  - SQL Security │  │  - Tables │  │
│  │  - Auto-Recovery  │  │  - Prod Lockout │  │  - Markdown│  │
│  └─────────┬─────────┘  └────────┬────────┘  └─────┬─────┘  │
│            │                     │                 │        │
│  ┌─────────┴─────────────────────┴─────────────────┴─────┐  │
│  │           Redis Cache & Redlock Provider              │  │
│  │  - Metadata caching    - Token refresh concurrency    │  │
│  └───────────────────────────────┬───────────────────────┘  │
└──────────────────────────────────┼──────────────────────────┘
                                   │ HTTPS + Bearer Token
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│             Oracle NetSuite AI Connector SuiteApp           │
│        (REST Web Services / SuiteQL Engine / SuiteScript)   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🧰 Tools Reference

### 1. Local SuiteCloud & Diagnostic Tools (`netsuite_*`)

| Tool Name | Description | Annotations |
|---|---|---|
| `netsuite_authenticate` | Authenticate with NetSuite using OAuth 2.0 PKCE. Opens browser authorization automatically. | — |
| `netsuite_logout` | Invalidate active tokens and clear local session storage. | `destructive`, `idempotent` |
| `netsuite_status` | Comprehensive diagnostics: authentication state, token TTL, account ID, environment classification (Production vs Sandbox), and cache statistics. | `readOnly` |
| `netsuite_refresh_cache` | Clear local/Redis cache and invalidate NetSuite REST session cache. Supports clearing single table schemas. | `idempotent` |
| `netsuite_batch_execute` | Concurrently execute multiple NetSuite tools in parallel (up to 10 tasks, concurrency: 5) to minimize LLM roundtrip latency. | — |
| `netsuite_inspect_record` | Inspect real NetSuite records in the target account. Separates header fields from custom fields (`custbody_*`, `custcol_*`, `custrecord_*`) with empty fields filtered out. | `readOnly` |
| `netsuite_get_record_definition` | Lookup official field types, IDs, required flags, and help text across 272 standard NetSuite record types from the SuiteScript Records Reference. | `readOnly` |
| `netsuite_get_query_template` | Retrieve verified, production-tested SuiteQL golden templates (SAFE Guide 2025.2 & Tim Dietrich library). | `readOnly` |
| `netsuite_get_system_notes` | High-performance audit trail query to inspect record change history without triggering timeout penalties. | `readOnly` |
| `netsuite_get_script_logs` | Query NetSuite Script Execution Logs (`ScriptNote`) with filters for log level (DEBUG, AUDIT, ERROR, EMERGENCY), date range, and script IDs. | `readOnly` |
| `netsuite_get_record_link` | Generate direct, clickable NetSuite UI deep links for standard and custom records. | `readOnly` |
| `netsuite_suitecloud_upload` | Upload script and asset files to NetSuite File Cabinet using SuiteCloud CLI. Features dry-run inspection and production confirmation safeguards. | `destructive` |

### 2. NetSuite AI Connector Proxied Tools (`ns_*`)

| Tool Name | Description | Safety Gate |
|---|---|---|
| `ns_runCustomSuiteQL` | Execute custom SuiteQL queries. Enforces AST validation, auto-pagination, and formats outputs as compact Markdown tables. | Read-Only |
| `ns_getSuiteQLMetadata` | Inspect table schemas, field types, and column nullability. Supports keyword search across all domains without network timeout. | Read-Only |
| `ns_getRecord` | Retrieve complete NetSuite record details by type and ID. Automatically attaches direct UI deep links. | Read-Only |
| `ns_getRecordTypeMetadata` | Retrieve record type schema. Automatically hydrates custom fields for custom records (`customrecord_*`). | Read-Only |
| `ns_listAllReports` / `ns_runReport` | Discover and run NetSuite financial, operational, and managerial reports. | Read-Only |
| `ns_listSavedSearches` / `ns_runSavedSearch` | List and execute existing saved searches. | Read-Only |
| `ns_getSubsidiaries` | Fetch subsidiary hierarchy in OneWorld accounts. | Read-Only |
| `ns_getAccountingBooks` | Fetch active accounting books (Multi-Book Accounting). | Read-Only |
| `ns_getAccountingContexts` | Fetch localized accounting contexts. | Read-Only |
| `ns_getNexusIds` | Fetch tax nexus configurations. | Read-Only |
| `ns_createRecord` | Create a new record in NetSuite. | **Sandbox / Test Only** (Blocked in Prod) |
| `ns_updateRecord` | Update fields on an existing NetSuite record. | **Sandbox / Test Only** (Blocked in Prod) |

---

## 📖 MCP Resources & Prompts

### Resources (`netsuite://`)

- **`netsuite://guides/suiteql`**: Comprehensive SuiteQL query syntax, Oracle dialect rules, BUILTIN functions, and performance best practices.
- **`netsuite://queries/golden-templates`**: Curated, production-tested SuiteQL templates for transactions, line items, inventory, GL impact, and audit logs.
- **`netsuite://records/reference`**: Complete catalog index of all 272 standard NetSuite record types.
- **`netsuite://skills/{skillName}`**: Markdown manuals for bundled NetSuite SuiteCloud Agent Skills (e.g., `netsuite-ai-connector-instructions`, `netsuite-sdf-safe-guide`).

### Prompts (Ready-to-Use)

- **`review_suitescript`**: Review SuiteScript 2.1 code against Oracle SAFE Guide principles, governance limits, OWASP security, and performance patterns.
- **`debug_script_error`**: Analyze NetSuite runtime error stack traces, explain root causes, and provide actionable refactoring patches.
- **`generate_suiteql`**: Generate production-ready SuiteQL queries adhering to SAFE Guide guidelines.

---

## 🚀 Getting Started

### 1. NetSuite Prerequisites

1. **Install NetSuite AI Connector SuiteApp**:
   - Install the official NetSuite AI Connector SuiteApp (Bundle ID: `522506`) in your NetSuite account.
2. **Create an OAuth 2.0 Integration Record**:
   - In NetSuite, navigate to **Setup > Integration > Manage Integrations > New**.
   - **Name**: `NetSuite MCP Server`
   - **State**: `Enabled`
   - **Authentication**:
     - Check **Authorization Code Grant**
     - Check **Public Client** (PKCE enabled — no client secret needed)
   - **Redirect URI**: `http://localhost:8080/callback` (or your chosen callback port)
   - Save and record your **Client ID** (Consumer Key).

---

### 2. Configuration Options

#### Option A: Unified Configuration File (`netsuite.config.json`)

Place `netsuite.config.json` in your project root or in `~/.config/netsuite-mcp/config.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "defaultCallbackPort": 8080,
  "sessionsDir": "~/.config/netsuite-mcp/sessions",
  "redisUrl": "redis://127.0.0.1:6379",
  "accounts": {
    "sandbox": {
      "accountId": "1234567-sb1",
      "clientId": "your-sandbox-oauth-client-id",
      "callbackPort": 8080
    },
    "production": {
      "accountId": "1234567",
      "clientId": "your-production-oauth-client-id",
      "callbackPort": 8081
    }
  }
}
```

#### Option B: Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NETSUITE_ACCOUNT_ID` | NetSuite Account ID (e.g. `1234567` or `1234567_SB1`) | — |
| `NETSUITE_CLIENT_ID` | OAuth 2.0 Client ID from the NetSuite Integration record | — |
| `OAUTH_CALLBACK_PORT` | Local port for OAuth PKCE browser redirect callback | `8080` |
| `NETSUITE_SESSION_PATH`| Directory where tokens and sessions are stored | `~/.config/netsuite-mcp/sessions/<account>` |
| `REDIS_URL` | Redis connection URL for distributed cache and lock provider | `redis://127.0.0.1:6379` |

---

### 3. Client Setup

#### Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "npx",
      "args": ["@suiteinsider/netsuite-mcp"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "your-oauth-client-id",
        "OAUTH_CALLBACK_PORT": "8080"
      }
    }
  }
}
```

#### Cursor IDE (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "node",
      "args": ["/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "your-oauth-client-id"
      }
    }
  }
}
```

#### Multi-Account Configuration in Cursor / Claude Code

To work with multiple NetSuite accounts concurrently without session collisions:

```json
{
  "mcpServers": {
    "netsuite_sb1": {
      "command": "node",
      "args": ["/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "sandbox-client-id",
        "OAUTH_CALLBACK_PORT": "8080",
        "NETSUITE_SESSION_PATH": "~/.config/netsuite-mcp/sessions/1234567_sb1"
      }
    },
    "netsuite_prod": {
      "command": "node",
      "args": ["/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567",
        "NETSUITE_CLIENT_ID": "prod-client-id",
        "OAUTH_CALLBACK_PORT": "8081",
        "NETSUITE_SESSION_PATH": "~/.config/netsuite-mcp/sessions/1234567"
      }
    }
  }
}
```

---

## ⏰ Token Keepalive Daemon (macOS)

Keep NetSuite OAuth 2.0 tokens active 24/7 in the background via a native macOS LaunchAgent:

```bash
# Install and register the LaunchAgent daemon (runs keepalive every 10 minutes)
npm run daemon:install

# Check daemon execution and plist status
npm run daemon:status

# Manually trigger an immediate keepalive scan across all saved sessions
npm run daemon:run

# Uninstall the LaunchAgent
npm run daemon:uninstall
```

Logs are stored in:
- `~/Library/Logs/netsuite-mcp-daemon.log`

---

## 🛠️ Developer Scripts

| Command | Description |
|---|---|
| `npm run build` | Clean build TypeScript to `dist/` |
| `npm test` | Run Vitest unit & integration test suite |
| `npm run lint` | Run Biome linter & code formatter check |
| `npm run dev` | Start stdio MCP server in development mode via `tsx` |
| `npm run auth:all` | Interactive bulk OAuth authentication tool across all configured accounts |
| `npm run fetch-skills` | Download official Oracle SuiteCloud Agent Skills |
| `npm run sync-agents` | Sync AGENTS.md rules to connected client workspaces |
| `npm run score` | Run the 360° architecture & runtime guardrail scoring suite |

---

## 🔒 Security Best Practices

1. **Public Client PKCE**: Tokens are exchanged using cryptographically generated code verifiers and SHA-256 challenges. No client secrets are stored or transmitted.
2. **Production Write Shield**: Destructive tools (`ns_createRecord`, `ns_updateRecord`) are guarded by both tool-filtering and runtime account-type inspection to prevent accidental updates in Production environments.
3. **Session Quarantine**: Each NetSuite account maintains its own isolated token directory, preventing cross-tenant data leakage.
4. **Zero Open Ports**: Stdio transport runs via local child process standard I/O, exposing no network listeners or endpoints.
5. **Least Privilege**: Configure the NetSuite Integration Role with only the permissions required for your team's workflow.

---

## 📄 License

MIT License. Designed and maintained for enterprise NetSuite AI automation.
