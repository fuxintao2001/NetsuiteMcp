# NetSuite MCP Server

[English](README_EN.md) | [简体中文](README.md)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20Strict-blue.svg)](https://www.typescriptlang.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol%20v2-purple.svg)](https://modelcontextprotocol.io/)
[![Architecture Score](https://img.shields.io/badge/ISO%2FIEC%2025010-100%2F100-success.svg)](#️-development-testing--quality-benchmarks)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`) is an enterprise-grade Model Context Protocol (MCP) server engineered specifically for modern AI coding and automation agents, including **Claude Code**, **Cursor IDE**, **Windsurf**, **Google Antigravity**, and **Gemini CLI**.

Operating natively over the **Stdio JSON-RPC protocol**, it equips AI assistants with secure, high-performance, and anti-hallucinatory capabilities for Oracle NetSuite ERP full-stack data interoperability and SuiteCloud development automation.

---

## 📖 Table of Contents

- [🌟 Key Problems Solved](#-key-problems-solved)
- [🏛️ Industry Benchmark Reference Matrix](#️-industry-benchmark-reference-matrix)
- [📐 System Architecture Panorama](#-system-architecture-panorama)
- [⚡ Core Technical Highlights](#-core-technical-highlights)
- [🚀 Quick Start](#-quick-start)
- [💻 Major MCP Client Configuration](#-major-mcp-client-configuration)
- [🧰 8 Canonical MCP Tools Reference (Zero-Bloat)](#-8-canonical-mcp-tools-reference-zero-bloat)
- [📚 MCP Resources & Prompts](#-mcp-resources--prompts)
- [⏰ Background Token Keepalive Daemon & Sleep Guard](#-background-token-keepalive-daemon--sleep-guard)
- [📊 Workspace Log Diagnostics & Daily Reports](#-workspace-log-diagnostics--daily-reports)
- [🛠️ Development, Testing & Quality Benchmarks](#️-development-testing--quality-benchmarks)
- [🔒 Enterprise Security & Defense Specifications](#-enterprise-security--defense-specifications)
- [📄 License](#-license)

---

## 🌟 Key Problems Solved

In traditional "AI + NetSuite ERP" integration setups, developers and organizations routinely confront severe architectural bottlenecks:

| Traditional Integration Pitfalls | NetSuite MCP Server Authoritative Solutions |
| :--- | :--- |
| **Fragile OAuth Tokens & Laptop Sleep Drops**: NetSuite Access Tokens expire after only 1 hour; laptop lid closures and sleeping disconnect networks, causing background token refresh failures and constant manual re-logins. | **OAuth 2.0 PKCE Auto-Rotation + macOS Sleep Guard + Background Daemon**: Zero Client Secret exposure; LaunchAgent/systemd daemons maintain 24/7 proactive renewal; built-in DarkWake/sleep network detection and zero-touch silent reconnect (`trySilentReauth`). |
| **Wide-Table Projections Causing LLM Context Bloat**: NetSuite REST records frequently carry hundreds of empty fields and nested arrays, quickly exhausting the LLM's token context window. | **Extreme Context Slimming (`contextSlimmer`)**: Automatically strips `null`, `undefined`, and empty array noise; converts entity and SuiteQL payloads into high-density Markdown tables, **reducing token consumption by 50%+**. |
| **SuiteQL Dialect Pitfalls & Slow Query Timeouts**: LLMs habitually generate MySQL dialects (such as naked `LIMIT`/`OFFSET`) or trigger catastrophic full-table scans (e.g., cross-table `JOIN SystemNote`), causing 45s+ gateway timeouts. | **AST-Level SQL Runtime Guard (`suiteqlGuard`)**: Zero implicit dialect rewriting with strict AST pre-validation; hard-blocks `SELECT *`, naked dialects, and cross-table audit joins; enforces `tl.mainline` filtering and automatically injects safe fallback pagination (`FETCH FIRST 100 ROWS ONLY`). |
| **Production Account Misoperation Disasters**: AI assistants mistakenly execute write actions or deploy untested scripts directly to production environments. | **Dual Sandbox/Production Defense Barrier**: Automatically identifies environment types (Production vs Sandbox) via account identifiers; read-only operations natively enabled; script deployments to production strictly demand explicit confirmation (`allowProduction: true`). |
| **Multi-Tenant Concurrent Collisions & Deadlocks**: Concurrently operating multiple NetSuite accounts across multiple IDE instances leads to session overwrites and refresh race conditions. | **Pure Redis Cache + Redlock Distributed Lock**: Complete session and metadata isolation per account (`ns:<accountId>:*`); normalized lock keys (`formatNetSuiteAccountHost`) guarantee atomicity during token rotation. |

---

## 🏛️ Industry Benchmark Reference Matrix

The server's protocol architecture, tool orthogonality, and defensive mechanisms are designed against best practices from 8 top MCP open-source benchmarks:

| **#** | **Benchmark Project** | **Standard Reference & Implementation in this Repo** |
| :---: | :--- | :--- |
| ① | **MCP Official Servers** | **Tool Design Golden Standard**: Strict verb-noun naming convention, explicit description boundaries, strict Zod inputSchema typing, and standardized error responses (`textResult({ isError: true })`). |
| ② | **MCP TypeScript SDK** | **SDK Engineering Excellence**: Robust lifecycle management via Stdio Transport, `z.infer<typeof Schema>` static type inference, and lockless JSON-RPC wrapping. |
| ③ | **GitHub MCP Server** | **Enterprise Tool Governance**: Domain separation strategy, 8 canonical orthogonal tools (Zero-Bloat architecture), and sandbox/production privilege hierarchy. |
| ④ | **Supabase MCP** | **Database/ERP Integration Paradigm**: Environment write-safety barriers, unified record inspection, and offline metadata catalog for 272 standard entities. |
| ⑤ | **Sentry MCP** | **End-to-End Observability**: Automated metric capture on every tool invocation (`durationMs`, `payloadChars`, `errorCategory`), sanitized telemetry logging, and self-healing error summaries. |
| ⑥ | **Playwright MCP** | **Anti-Hallucination UX Design**: Descriptions crafted with precision to prevent LLM misfires; on-demand tool exposure eliminating deadlocks. |
| ⑦ | **Context7 MCP** | **Extreme Context Economy**: Minimal response payloads, noise pruning (stripping `null`/`undefined`), and high-density Markdown tabular formatting, cutting token costs by 50%+. |
| ⑧ | **ERPNext MCP Server** | **ERP Business Abstraction**: Metadata schema inspection (`netsuite_get_metadata`), automatic resolution of natural keys (`tranid`) to internal IDs (`id`), and active Web UI deep-links. |

---

## 📐 System Architecture Panorama

```
                      MCP Client Ecosystem
        (Claude Code / Cursor / Windsurf / Antigravity)
                               │
                     stdio Pipe (JSON-RPC)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    NetSuite MCP Server                      │
│                                                             │
│  ┌───────────────────┐  ┌─────────────────┐  ┌───────────┐  │
│  │   OAuth 2.0 PKCE  │  │ AST SuiteQL Guard│ │  Context  │  │
│  │  - Proactive Rot. │  │  - AST Validation│ │  Slimmer  │  │
│  │  - Sleep/DarkWake │  │  - Zero-Rewrites │ │  - Table  │  │
│  │  - Silent Healing │  │  - Prod Barrier  │ │  - Prune  │  │
│  └─────────┬─────────┘  └────────┬────────┘  └─────┬─────┘  │
│            │                     │                 │        │
│  ┌─────────┴─────────────────────┴─────────────────┴─────┐  │
│  │           Pure Redis Cache & Redlock Distributed Lock │  │
│  │  - Millisecond Metadata Cache  - Multi-Process Mutex  │  │
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

## ⚡ Core Technical Highlights

1. **Zero-Secret OAuth 2.0 PKCE Authentication & Sleep Guard**:
   - Operates via SHA-256 Code Challenge and Code Verifier as a public client, eliminating the risk of leaking sensitive Client Secrets locally.
   - Spins up a temporary local HTTP callback server to capture authorization codes; includes macOS sleep and DarkWake detection to prevent blind token rotation when the lid is closed.
   - Features `trySilentReauth` for transparent, zero-touch session re-establishment if tokens are unexpectedly invalidated.
2. **Pure Redis Cache & Redlock Distributed Locking**:
   - Deprecates in-memory caching in favor of Redis (`ioredis`) for resilient session persistence and metadata caching.
   - Employs Redlock distributed locking with normalized host keys (`formatNetSuiteAccountHost`), eradicating concurrency races across sandbox and multi-instance environments.
3. **AST-Level SuiteQL Runtime Shield (`suiteqlGuard`)**:
   - **Zero Implicit Dialect Rewriting**: Employs AST syntax tree analysis to block black-box query mutations. Non-standard SQL dialects are cleanly intercepted with official Oracle NetSuite remediation advice.
   - **Wildcard Interception**: Zero tolerance for `SELECT *`, requiring explicit column projections to protect the context window.
   - **Dialect Remediation**: Hard-blocks MySQL naked `LIMIT`/`OFFSET`, guiding models to official Oracle `FETCH FIRST N ROWS ONLY` or `ROWNUM <= N`.
   - **Transaction Line Duplication Guard**: Enforces `tl.mainline = 'F'` or `'T'` filtering on `transactionline` joins to prevent inflated line counts and amounts.
   - **Slow Query Shield**: Hard-blocks cross-table `systemnote` joins (SAFE Pitfall 11), directing agents to dedicated audit tools.
   - **Automatic Fallback Pagination**: Injects `FETCH FIRST 100 ROWS ONLY` when queries lack explicit limit constraints.
4. **Dual Sandbox/Production Defense Barrier**:
   - Single authoritative classification: account IDs containing `_sb`, `-sb`, or `tstdrv` are classified as Sandbox; all others as Production.
   - Script deployment (`netsuite_deploy_script`) requires explicit user confirmation via `allowProduction: true` when targeting production.
5. **Context Slimming & Tabular Markdown Rendering**:
   - `contextSlimmer` purges extraneous `null`, `undefined`, and empty arrays from NetSuite API payloads.
   - Automatically converts records and query results into compact Markdown tables.
6. **Full-Stack Observability & Automated Self-Healing**:
   - Automatically tracks structured invocation telemetry (latency `durationMs`, payload size `payloadChars`, category `errorCategory`).
   - Surfaces structured self-healing guidance (`[Self-Healing Action]`) alongside CLI tools for error aggregation and automated daily reports.

---

## 🚀 Quick Start

### Step 1: NetSuite Instance Setup

1. **Install Official AI Connector Bundle**:
   - In your NetSuite account, navigate to **Customization > SuiteBundler > Search & Install Bundles**.
   - Search for and install **NetSuite AI Connector** (Bundle ID: `522506`).
2. **Create OAuth 2.0 Integration Record**:
   - Navigate to **Setup > Integration > Manage Integrations > New**.
   - **Name**: `NetSuite MCP Server`
   - **State**: `Enabled`
   - **Authentication**:
     - Check **Authorization Code Grant**
     - Check **Public Client** (enables PKCE mode)
   - **Redirect URI**: `http://localhost:8080/callback` (adjust port if needed)
   - Save and record the generated **Client ID** (Consumer Key).

---

### Step 2: Local Configuration

We recommend creating `netsuite.config.json` in your project root or at `~/.config/netsuite-mcp/config.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "defaultCallbackPort": 8080,
  "sessionsDir": "~/.config/netsuite-mcp/sessions",
  "redisUrl": "redis://127.0.0.1:6379",
  "accounts": {
    "sandbox": {
      "accountId": "1234567-sb1",
      "clientId": "your-sandbox-client-id",
      "callbackPort": 8080
    },
    "production": {
      "accountId": "1234567",
      "clientId": "your-production-client-id",
      "callbackPort": 8081
    }
  }
}
```

Alternatively, configure using standard environment variables (takes precedence over configuration files):

| Environment Variable | Description | Default |
| :--- | :--- | :--- |
| `NETSUITE_ACCOUNT_ID` | NetSuite Account ID (e.g. `1234567` or `1234567_SB1`) | — |
| `NETSUITE_CLIENT_ID` | NetSuite OAuth 2.0 Integration Client ID | — |
| `OAUTH_CALLBACK_PORT` | Local HTTP port for OAuth callback redirect | `8080` |
| `NETSUITE_SESSION_PATH`| Local storage directory for account session tokens | `~/.config/netsuite-mcp/sessions/<account>` |
| `REDIS_URL` | Redis connection URL | `redis://127.0.0.1:6379` |

---

## 💻 Major MCP Client Configuration

### 1. Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "node",
      "args": ["/absolute/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "your-oauth-client-id",
        "OAUTH_CALLBACK_PORT": "8080",
        "REDIS_URL": "redis://127.0.0.1:6379"
      }
    }
  }
}
```

### 2. Cursor IDE (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "node",
      "args": ["/absolute/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "your-oauth-client-id",
        "REDIS_URL": "redis://127.0.0.1:6379"
      }
    }
  }
}
```

### 3. Multi-Account Concurrent Isolation (Sandbox & Production Online Together)

To switch between sandbox testing and production inspection within the same IDE, assign independent session directories and callback ports:

```json
{
  "mcpServers": {
    "netsuite_sb1": {
      "command": "node",
      "args": ["/absolute/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567-sb1",
        "NETSUITE_CLIENT_ID": "sandbox-client-id",
        "OAUTH_CALLBACK_PORT": "8080",
        "NETSUITE_SESSION_PATH": "~/.config/netsuite-mcp/sessions/1234567_sb1"
      }
    },
    "netsuite_prod": {
      "command": "node",
      "args": ["/absolute/path/to/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567",
        "NETSUITE_CLIENT_ID": "prod-client-id",
        "OAUTH_CALLBACK_PORT": "8081",
        "NETSUITE_SESSION_PATH": "~/.config/netsuite-mcp/sessions/1234567_prod"
      }
    }
  }
}
```

---

## 🧰 8 Canonical MCP Tools Reference (Zero-Bloat)

In accordance with **Zero-Bloat and orthogonal duty principles**, all obsolete aliases have been physically removed, leaving **8 canonical tools** that form the core capability matrix:

| Tool Name | Description | MCP Annotation Hints |
| :--- | :--- | :--- |
| [`netsuite_run_suiteql`](#1-netsuite_run_suiteql) | Execute read-only SuiteQL queries protected by AST guard with automatic fallback pagination, multi-statement, and parallel support. | `readOnlyHint: true`, `idempotentHint: true` |
| [`netsuite_get_metadata`](#2-netsuite_get_metadata) | Inspect database table schemas, column types, and authoritative 272 standard record definitions. | `readOnlyHint: true`, `idempotentHint: true` |
| [`netsuite_get_record`](#3-netsuite_get_record) | Inspect records by ID or tranid, prune noise, and generate deep-links to NetSuite Web UI. | `readOnlyHint: true`, `idempotentHint: true` |
| [`netsuite_get_script_logs`](#4-netsuite_get_script_logs) | Query SuiteScript execution logs (`ScriptNote`) with index optimization by level, script ID, and date range. | `readOnlyHint: true`, `idempotentHint: true` |
| [`netsuite_get_system_notes`](#5-netsuite_get_system_notes) | Perform record-level audit trail queries (`SystemNote`) via standalone indexed queries, avoiding SAFE Pitfall 11 timeouts. | `readOnlyHint: true`, `idempotentHint: true` |
| [`netsuite_deploy_script`](#6-netsuite_deploy_script) | Upload SuiteScript files to NetSuite FileCabinet via SuiteCloud CLI with syntax check and production write barrier. | `destructiveHint: true` |
| [`netsuite_status`](#7-netsuite_status) | Comprehensive diagnostic check of token lifespan, environment classification (Prod/Sandbox), Redis cache, and error telemetry. | `readOnlyHint: true`, `idempotentHint: true` |
| [`netsuite_auth`](#8-netsuite_auth) | Centralized OAuth 2.0 PKCE session and cache management (login, logout, refresh cache). | `idempotentHint: true` |

---

### 1. `netsuite_run_suiteql`
Executes read-only Oracle NetSuite SuiteQL queries and returns tabular results adhering strictly to Oracle NetSuite dialect rules.

- **Input Parameters**:
  - `sqlQuery` (`string`, optional): SuiteQL query string to execute. Multiple statements separated by `;` are supported.
  - `sqlQueries` (`string[]`, optional): Array of SuiteQL query strings to execute concurrently in parallel (max 10).
  - `limit` (`number`, optional): Safe maximum row limit (default: 100).
  - `customRecordMappings` (`array`, optional): Custom record mappings (`rectype` and `scriptId`).
- **Guard Rules**: Zero implicit rewriting; `SELECT *` strictly prohibited; naked `LIMIT`/`OFFSET` blocked with Oracle guidance; `transactionline` joins must filter `tl.mainline`; direct `JOIN systemnote` blocked; safe `FETCH FIRST 100 ROWS ONLY` automatically appended if pagination is omitted.

### 2. `netsuite_get_metadata`
Inspects NetSuite database table schemas, column names, and data types with 2ms Redis caching and an offline catalog of 272 standard entities.

- **Input Parameters**:
  - `table` (`string`, optional): NetSuite table name or record type ID (e.g. `customer`, `transaction`, `transactionline`, `item`). Omit to list or search the table catalog.
  - `keyword` (`string`, optional): Search keyword to filter tables, column names, labels, or descriptions.
  - `source` (`"auto" | "offline" | "remote"`, optional): Metadata source (default: `"auto"`).

### 3. `netsuite_get_record`
Retrieves and inspects a NetSuite record by internal numeric ID or document number (`tranid`). Returns cleaned header fields, custom fields, line-item sublists, and active Web UI links.

- **Input Parameters**:
  - `recordType` (`string`, required): NetSuite record type ID (e.g. `salesorder`, `customer`, `invoice`, `customrecord_xxx`).
  - `id` (`string`, required): Numeric internal ID (e.g. `"12345"`) or document number / tranid (e.g. `"SO10023"`).
  - `includeSublists` (`boolean`, optional): Whether to include line-item sublists (default: `true`).
  - `linesMode` (`"all" | "summary"`, optional): Sublist display mode (default: `"all"`).
  - `maxLines` (`number`, optional): Maximum number of lines to display per sublist.
  - `lineFields` (`string[]`, optional): Specific sublist columns/fields to extract.
  - `format` (`"markdown" | "compact_json"`, optional): Output format (default: `"markdown"`).

### 4. `netsuite_get_script_logs`
Queries NetSuite SuiteScript execution logs (`ScriptNote`) with index optimization, defaulting to the last 7 days.

- **Input Parameters**:
  - `scriptId` (`string`, optional): Filter by script's Script ID (e.g. `customscript_my_ue`).
  - `type` (`"DEBUG" | "AUDIT" | "ERROR" | "EMERGENCY"`, optional): Filter by log level.
  - `dateFrom` (`string`, optional): Start date in `YYYY-MM-DD` format (inclusive).
  - `dateTo` (`string`, optional): End date in `YYYY-MM-DD` format (inclusive).
  - `keyword` (`string`, optional): Filter by keyword matching log title or detail text.
  - `deploymentId` (`string`, optional): Filter by deployment Script ID.
  - `limit` (`number`, optional): Maximum log entries to return (default: 50, max: 200).

### 5. `netsuite_get_system_notes`
Standalone indexed audit trail and field change history queries (`SystemNote`) for specific records.

- **Input Parameters**:
  - `recordId` (`string`, required): Numeric internal ID or document number (`tranid`).
  - `recordType` (`string`, optional): Optional record type.
  - `limit` (`number`, optional): Maximum audit entries to return (default: 50, max: 100).

### 6. `netsuite_deploy_script`
Uploads SuiteScript files and assets to the NetSuite FileCabinet via SuiteCloud CLI.

- **Input Parameters**:
  - `paths` (`string | string[]`, required): Relative or absolute local file path(s) to upload.
  - `projectPath` (`string`, optional): Optional SDF project root path.
  - `authId` (`string`, optional): Optional SDF CLI authId.
  - `dryRun` (`boolean`, optional): Inspect and validate files without uploading (default: `false`).
  - `skipValidation` (`boolean`, optional): Skip pre-flight syntax validation (default: `false`).
  - `allowProduction` (`boolean`, optional): Explicit authorization required if deploying to a Production account (default: `false`).

### 7. `netsuite_status`
Checks connection status, OAuth token lifespan (TTL), environment type (Sandbox vs Production), and system health diagnostics.

- **Input Parameters**:
  - `includeErrors` (`boolean`, optional): Include recent error summary and self-healing recommendations.
  - `includeDiagnostics` (`boolean`, optional): Diagnostic alias for `includeErrors`.

### 8. `netsuite_auth`
Manages NetSuite OAuth 2.0 PKCE authentication sessions and Redis cache.

- **Input Parameters**:
  - `action` (`"login" | "logout" | "refresh_cache"`, required):
    - `"login"`: Launches browser PKCE flow and persists session;
    - `"logout"`: Revokes active session and purges local token cache;
    - `"refresh_cache"`: Clears local Redis cache and remote session metadata.

---

## 📚 MCP Resources & Prompts

### 1. Standard Read-Only Resources (`netsuite://`)

- **`netsuite://guides/suiteql`**: Comprehensive SuiteQL syntax guide, Oracle SQL subset rules, and query optimization guidelines.
- **`netsuite://queries/golden-templates`**: Curated library of 8 production-grade SuiteQL templates certified by Oracle SAFE Guide (lineage, transaction lines, multi-location stock MLI, etc.).
- **`netsuite://records/reference`**: Full catalog index and field definitions for all 272 standard NetSuite record types.
- **`netsuite://templates/generative-ui`**: Production-ready HTML/Tailwind templates conforming to Antigravity design variable standards.
- **`netsuite://skills/{skillName}`**: On-demand reference documentation for SuiteCloud agent skills.

### 2. Built-in Task Prompts

- **`review_suitescript`**: Review SuiteScript 2.1 code against Oracle SAFE Guide 2025.2, Governance unit budgets, and OWASP security standards.
- **`debug_script_error`**: Diagnose NetSuite runtime stack traces to locate root causes and generate precise refactoring patches.
- **`generate_suiteql`**: Generate standard, high-performance SuiteQL queries strictly adhering to SAFE syntax guardrails.
- **`visualize_netsuite_data`**: Render ERP data into interactive Generative UI components using HTML/Tailwind (`<agent-embed>`).
- **`upgrade_suitescript`**: Upgrade legacy SuiteScript 1.0/2.0 scripts to modern SuiteScript 2.1 with ES6+ idioms.

---

## ⏰ Background Token Keepalive Daemon & Sleep Guard

To eliminate repetitive daily manual authentication, the server includes system-level background daemon support:

1. **24/7 Automated Background Keepalive**: Runs via macOS LaunchAgent or Linux systemd every 10 minutes to scan for expiring tokens and refresh them seamlessly via PKCE.
2. **macOS Sleep & DarkWake Guard**: Suspends token rotation during system sleep or low-power DarkWake states when network connectivity is lost, preventing refresh token invalidation.
3. **Silent Re-Authentication Healing**: Combines `trySilentReauth` with Redlock normalized host keys (`formatNetSuiteAccountHost`) to self-heal expired sessions without user intervention.

```bash
# 1. Install and start the LaunchAgent daemon
npm run daemon:install

# 2. Check daemon status and next scheduled rotation
npm run daemon:status

# 3. Manually trigger a proactive refresh across all configured accounts
npm run daemon:run

# 4. Uninstall the daemon
npm run daemon:uninstall
```

Daemon logs are streamed directly to:
- macOS: `~/Library/Logs/netsuite-mcp-daemon.log`

---

## 📊 Workspace Log Diagnostics & Daily Reports

Analyze invocation errors and generate automated daily health inspections:

```bash
# 1. Summarize workspace errors and review self-healing actions
npm run logs:summary

# 2. Generate an automated daily markdown report (saved to logs/reports/daily-report-YYYY-MM-DD.md)
npm run logs:daily
```

---

## 🛠️ Development, Testing & Quality Benchmarks

This project enforces strict software engineering standards, passing all verification gates prior to any release:

### Common Development Commands

```bash
# Build production bundle (TypeScript Strict -> dist/)
npm run build

# Start development server with tsx hot-reloading
npm run dev

# Run Biome linter and code style checks
npm run lint

# Run strict TypeScript type check (tsc --noEmit)
npm run typecheck

# Run Vitest test suite
npm test

# Run ISO/IEC 25010 & Oracle SAFE architectural scoring suite (100/100 Optimizing)
npm run score

# Run Oracle official documentation compliance and anti-hallucination test suite
npm run test:compliance
```

### Architectural Benchmark Suite (ISO/IEC 25010 & Oracle SAFE)

The automated benchmark suite (`npm run score`) continuously verifies the system against **Level 5 (Optimizing) with a 100/100 score**:

| Pillar | Standard Metric Name | Weight | Physical Verification Focus | Status |
| :--- | :--- | :---: | :--- | :---: |
| **P1** | **Security & Resistance** | 20% | OWASP ASVS v4.0 & BFN: 100% interception of 20 complex DDL/DML injection attacks, production write locking, and deep credential masking. | 🟢 Optimal |
| **P2** | **Protocol & Tool Quality** | 20% | Anthropic MCP Specification: 8 canonical tools registered (Zero-Bloat), 100% inputSchema property descriptions, complete annotations, Prompts, and Resources. | 🟢 Optimal |
| **P3** | **Oracle SAFE Compliance** | 20% | SAFE 2025.2 & Zero-Transpile: Wildcard blocking, mainline verification, Pitfall 11 avoidance, zero implicit dialect rewriting, and 272 offline record catalog. | 🟢 Optimal |
| **P4** | **Efficiency & Slimming** | 15% | Context7 MCP Benchmark: 50%+ physical context character reduction via ContextSlimmer, automated fallback pagination, and 8 golden query templates. | 🟢 Optimal |
| **P5** | **Code Health & Discipline** | 15% | SonarQube & ArchUnitTS: Zero `any` types across all TypeScript files, 100% explicit `.js` ESM relative imports, and strictly decoupled unidirectional architecture. | 🟢 Optimal |
| **P6** | **Resilience & Classification** | 10% | MCPEval Benchmark: 100% F1-Score across 8 fault classifiers with structured self-healing clustering and multi-tenant environment integrity. | 🟢 Optimal |

---

## 🔒 Enterprise Security & Defense Specifications

1. **Public Client Credential Security**: Communicates strictly via OAuth 2.0 PKCE without requiring or storing NetSuite Client Secrets.
2. **Production Write Barrier**: Read-only operations natively isolated; script deployments to production mandate explicit confirmation (`allowProduction: true`).
3. **Deep Credential Sanitization**: Recursively scrubs tokens, passwords, and sensitive keys from error logs and telemetry.
4. **Zero Open Ports**: Operates over local Stdio transport without listening on external network ports, eliminating SSRF and remote unauthorized access risks.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE). Built to provide rock-solid infrastructure for enterprise NetSuite AI engineering.
