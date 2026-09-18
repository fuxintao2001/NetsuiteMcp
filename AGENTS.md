# NetSuite MCP Server — AI Developer Guide (AGENTS.md)

> 🤖 **Role & Purpose**: This document provides mandatory execution directives for AI coding agents developing, refactoring, and maintaining the **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`) repository.
> 
> ⚠️ **Workspace Boundary**: This repository is a **Node.js TypeScript MCP Server**, NOT a NetSuite SuiteScript client project. Client SuiteScript/SDF workspace directives are defined in `workspace-agents/AGENTS.template.md` and provisioned via `npm run sync-agents`.

**Tech Stack**: TypeScript (strict mode) · Node.js ≥ 18 (ESM) · Stdio Transport · OAuth 2.0 PKCE · Redis Distributed Cache & Redlock Distributed Locking · Biome · Vitest

---

## ⚙️ 1. Development & Testing Commands

All code modifications in this repository must be verified using the following standard commands:

| Command | Purpose & Standard |
|:---|:---|
| `npm run build` | Clean production build (`rimraf dist && tsc && node scripts/stamp-build.js`). |
| `npm run dev` | Start the MCP server in development mode via `tsx src/index.ts`. |
| `npm run lint` | Run Biome linter & code formatter check (`biome check src`). Must report 0 errors. |
| `npm test` | Run all Vitest unit tests (`vitest run`). All unit tests must pass 100%. |
| `npm run typecheck` | Strict TypeScript type checking across source and test configs (`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`). |
| `npm run score` | Run the 360° ISO/IEC 25010 & Oracle SAFE architectural scoring suite (`scripts/test-system-architecture-score.ts`). Must maintain 100/100 (Level 5 Optimizing). |
| `npm run test:compliance` | Run the Oracle NetSuite official documentation compliance & anti-hallucination test suite (`scripts/test-official-docs-compliance.ts`). Must pass 100%. |
| `npm run sync-agents` | Synchronize `workspace-agents/` templates and rules to all connected NetSuite client workspaces. |
| `npm run sync:push` | Synchronize and git commit/push updates to all client workspace repositories (`node scripts/sync-agents.js --push`). |
| `npm run fetch-skills` | Download and update latest Oracle SuiteCloud Agent Skills to local cache. |
| `npm run auth:all` | Multi-tenant bulk OAuth authorization across configured workspaces (`tsx scripts/bulk-auth.ts`). |
| `npm run daemon:status` | Inspect background token keepalive daemon status (`node scripts/daemon.js status`). |
| `npm run logs:summary` | Inspect aggregated MCP tool error logs and invocation telemetry (`tsx scripts/summarize-errors.ts`). |
| `npm run check:safe` | Run SuiteScript SAFE Guide offline AST linter (`node scripts/suitescript-safe-check.js`). |
| `npm run check:upload` | Run SuiteCloud upload pre-flight syntax & credential leak gate (`node scripts/pre-upload-check.js`). |

---

## 🏗️ 2. Repository Architecture & Codebase Map

When navigating, maintaining, or adding features to this repository, adhere strictly to the established module boundaries:

```
NetsuiteMcp/
├── src/
│   ├── index.ts                # Server entry point, CLI args, stdio transport initialization
│   ├── mcp/                    # Core NetSuite MCP business service layer
│   │   ├── tools.ts            # NetSuiteMCPTools service class (SuiteQL, REST WS, inspect, reports)
│   │   └── tools.test.ts       # SuiteQL & resilience unit tests
│   ├── handlers/               # MCP Protocol Handlers (JSON-RPC dispatchers & schemas)
│   │   ├── tools.ts            # Central MCP tool registry & request dispatcher
│   │   ├── toolSchemas.ts      # Zod validation schemas for all MCP tool parameters
│   │   ├── recordHandlers.ts   # netsuite_schema, netsuite_inspect_record, ns_getRecord, mutations
│   │   ├── queryHandlers.ts    # ns_runCustomSuiteQL, ns_getSuiteQLMetadata, query templates, reports
│   │   ├── authHandlers.ts     # netsuite_authenticate, netsuite_get_auth_status
│   │   ├── batchHandler.ts     # netsuite_batch_execute parallel tool dispatcher
│   │   ├── deployHandlers.ts   # netsuite_suitecloud_upload deployment handler
│   │   ├── prompts.ts          # MCP Prompts: review_suitescript, debug_script_error, generate_suiteql, etc.
│   │   ├── resources.ts        # MCP Resources: netsuite://records/reference, golden-templates, etc.
│   │   └── metadataHydrator.ts # In-memory metadata pre-warming & cache hydration
│   ├── oauth/                  # OAuth 2.0 PKCE authentication subsystem
│   │   ├── manager.ts          # OAuthManager: token lifecycle, proactive renewal & auto-recovery
│   │   ├── tokenExchange.ts    # Token exchange & refresh endpoints with backoff retry
│   │   ├── sessionStorage.ts   # Persistent token storage (~/.netsuite/sessions.json)
│   │   ├── callbackServer.ts   # Ephemeral local HTTP callback server for OAuth redirect
│   │   └── pkce.ts             # PKCE code challenge & verifier generator
│   ├── daemon/                 # Background token keepalive & scheduler daemon
│   │   ├── keepalive.ts        # Proactive multi-account token refresher loop
│   │   └── installer.ts        # OS service installer (launchd / systemd)
│   ├── utils/                  # Domain utilities & runtime guardrails
│   │   ├── suiteqlGuard.ts     # AST & regex SuiteQL defense engine (blocks SELECT *, non-Oracle syntax)
│   │   ├── environment.ts      # Environment classification (isSandboxAccount) & Production write locks
│   │   ├── recordsReference.ts # 272 standard NetSuite record types offline catalog & field definitions
│   │   ├── metadata.ts         # SuiteQL table catalog & record type reflection
│   │   ├── suiteqlTemplates.ts # Oracle SAFE Guide certified high-frequency SuiteQL templates
│   │   ├── contextSlimmer.ts   # Payload token compression & null stripping for LLM context optimization
│   │   ├── suitecloudRunner.ts # SuiteCloud CLI runner wrapper (netsuite_suitecloud_upload)
│   │   ├── toolErrorLogger.ts  # Structured telemetry recording (duration, errors, payload size)
│   │   ├── toolErrorSummarizer.ts # Aggregated diagnostic summaries & self-healing suggestions
│   │   ├── redisCacheProvider.ts # Distributed Redis cache provider
│   │   ├── redisLock.ts        # Redlock distributed locking mechanism
│   │   ├── resilience.ts       # Concurrency limiter & exponential backoff retry
│   │   └── errors.ts           # NetSuite structured error parser & diagnostic classifier
│   └── supervisor/             # Child process supervisor & connection resilience
├── scripts/                    # Engineering evaluation, lifecycle hooks & automation scripts
│   ├── test-system-architecture-score.ts # ISO/IEC 25010 & SAFE 6-pillar architecture benchmark
│   ├── test-official-docs-compliance.ts  # Oracle NetSuite documentation compliance & anti-hallucination suite
│   ├── sync-agents.js          # Multi-tenant workspace AGENTS.md / rules synchronization engine
│   ├── post-tool-sync.js       # Antigravity PostToolUse hook for auto-syncing workspace-agents
│   ├── pre-upload-check.js     # SuiteCloud upload pre-flight syntax & credential leak gate
│   └── suitescript-safe-check.js # SuiteScript SAFE Guide offline AST linter
├── workspace-agents/           # Distribution templates for NetSuite client workspaces
│   ├── AGENTS.template.md      # Template for client workspace AGENTS.md (SuiteScript/SDF directives)
│   ├── hooks.template.json     # Template for client workspace Antigravity lifecycle hooks
│   ├── workspaces.json         # Workspace path → NetSuite account/environment mapping
│   └── rules/                  # Modular domain rule templates (fast-path, suiteql, safe, locks, ui)
└── .agents/                    # Local Antigravity configuration for this MCP Server repository
    ├── hooks.json              # Local PreToolUse and PostToolUse lifecycle gates
    └── rules/                  # Local engineering rules
```

---

## 🧼 3. Code Craftsmanship & Anti-Compatibility Bloat

When writing, refactoring, or reviewing code (TypeScript, JavaScript, SQL), AI agents must strictly adhere to the **Single Authoritative Implementation** principle:

1. **Clean Replacement, Never Dual-Track**:
   - ❌ **PROHIBITED**: Wrapping defective or outdated implementations in `try { newWay(); } catch (e) { oldWay(); }` to "support both ways".
   - ❌ **PROHIBITED**: Adding dual-branch sniffing `if (supportsNewWay) { ... } else { ... }` when the previous way was defective or obsolete.
   - ❌ **PROHIBITED**: Chaining speculative fallbacks due to unverified schemas (e.g. `val = newProp ?? oldProp`).
   - ✅ **MANDATE**: Identify the single officially sanctioned correct approach, and execute a **100% clean, total replacement**.
2. **Immediate Physical Dead-Code Elimination**:
   - When superseding an outdated implementation, immediately and physically delete obsolete functions, dead variables, deprecated arguments, and legacy logic.
   - NEVER leave dead code behind as comments or "just in case" fallbacks. Zero tolerance for defensive code bloat. Adhere strictly to the KISS principle.
3. **Root Cause Resolution Over Defensive Masking**:
   - Errors signify invalid assumptions, type defects, or schema mismatches. Confront errors directly, identify the exact defect, and fix it definitively at the source. Never mask unverified failures with defensive try-catch traps or silent fallback branching.
4. **Current-State-Only Explanations (Zero Version Iteration Narrative)**:
   - ❌ **PROHIBITED**: Narrating code evolution history, migration trajectories, or past vs present comparisons (strictly prohibit narratives like "in the previous version it was X, now we upgraded to Y", "previously we used A, now refactored to B", "compared to earlier versions...").
   - ❌ **PROHIBITED**: Inserting changelog commentary, historical diff reflections, or superseded implementation post-mortems into code comments, technical responses, or documentation.
   - ✅ **MANDATE**: In all code comments, technical responses, and documentation, **describe ONLY the current, definitive state and logic of the latest code**. Treat the current codebase as the sole authoritative, standalone implementation. Explain directly its latest architecture, data flow, parameter semantics, and business logic, completely excising all version iteration narratives.

---

## 👑 4. MCP Server Core Engineering Invariants

When developing tools, handlers, and utilities in this codebase, enforce the following core invariants:

1. **Official Documentation Absolute Priority & Zero Hallucination**:
   - Oracle NetSuite Official Documentation (Tier 1: Help Center, SuiteAnswers, Records Catalog, SuiteScript 2.1 API Reference, SAFE Guide 2025.2) unconditionally supersedes third-party forum posts and LLM training intuition.
   - NEVER fabricate non-existent NetSuite tables or field IDs (e.g. `transaction.createdfrom`, `item.recordtype`, `LotNumberedAssemblyItemLocations`).
   - **Schema Invariants**:
     - `item` uses **`itemtype`** and **`subtype`**; `item` NEVER has `recordtype`.
     - `transaction` and `entity` use `type` or `recordtype`.
     - `createdfrom` exists exclusively on `transactionline`, NEVER on `transaction` header.
2. **Runtime SuiteQL Guard Integrity (`suiteqlGuard.ts`)**:
   - Zero tolerance for `SELECT *` (hard-blocked with structured guidance).
   - Zero tolerance for MySQL/PostgreSQL dialects (`LIMIT` or bare non-standard `OFFSET`; Oracle-standard `OFFSET M ROWS FETCH NEXT N ROWS ONLY` passes cleanly).
   - Hard-block unindexed Cartesian joins on `systemnote` (SAFE Guide Pitfall 11).
   - Enforce `tl.mainline = 'F'` or `tl.mainline = 'T'` on `transactionline` joins to prevent line duplication.
   - Auto-inject safe pagination bounds (`FETCH FIRST 100 ROWS ONLY`) when pagination is omitted.
3. **Dual-Gate Environment & Write Safety (`environment.ts`)**:
   - `isSandboxAccount(accountId)` is the single authoritative environment gate.
   - Mutation tools (`ns_createRecord`, `ns_updateRecord`) MUST remain physically disabled in Production accounts.
   - Code uploads (`netsuite_suitecloud_upload`) MUST block Production deployments unless `allowProduction: true` is explicitly provided.
4. **Structured Error Diagnostics & Self-Healing SOP**:
   - Tool error responses must provide structured diagnostic tags (`[Self-Healing Action]`, `[suiteqlGuard]`, `PERMISSION DENIED — HARD STOP`, `NETWORK_OR_TIMEOUT`, `[Production Safety Violation]`).
   - Distinguish transient network timeouts (`NETWORK_OR_TIMEOUT`: ETIMEDOUT, ECONNRESET, 504 Gateway Timeout) from SQL syntax errors (`SUITEQL_SYNTAX`). Do not rewrite valid queries on network timeouts.
   - Permission errors (`INSUFFICIENT_PERMISSION`, 403 Forbidden) must trigger a clean hard-stop with required role permission advice.
5. **Observability & Telemetry (`toolErrorLogger.ts`)**:
   - Every MCP tool call must record structured metrics: `tool`, `durationMs`, `isError`, and `payloadChars`.
   - The aggregated error summarizer (`netsuite_get_error_summary`) must provide actionable pattern analysis for client agent self-healing.
6. **MCP Tool Response Protocol & Context Slimming**:
   - MCP tools must return standard MCP-compliant text results via `textResult()`.
   - Tool parameters must be strictly validated with Zod schemas in `src/handlers/toolSchemas.ts`.
   - Large record payloads must be compressed via `contextSlimmer.ts` (stripping nulls, undefined, and empty arrays) to prevent LLM context exhaustion.
7. **Concurrency Governance & Distributed Locking**:
   - All outbound NetSuite API calls must pass through `ConcurrencyLimiter` and `retryWithBackoff` (`src/utils/resilience.ts`) to respect NetSuite concurrency limits.
   - Multi-instance token renewal and mutations must acquire distributed locks via Redlock (`src/utils/redisLock.ts`).
8. **Adaptive Communication & Code Standards**:
   - Adapt conversational explanations, summaries, and interactive messages to the user's language (default to Simplified Chinese if prompted in Chinese).
   - Keep all code symbols, TypeScript types, variables, SQL keywords, and API syntax strictly in standard English.
   - Git commit messages pushed to remote must be in Simplified Chinese.

---

## 📚 5. On-Demand Skills & Knowledge Routing Matrix

When maintaining or extending NetSuite domain features in this server (e.g. metadata definitions, SuiteQL templates, prompt templates, or AST analyzers), consult the corresponding Antigravity skills in `~/.gemini/config/skills/` and MCP resources:

| Development Domain | On-Demand Target Path / Resource | Key Server Architecture Alignment |
|:---|:---|:---|
| **SuiteScript 2.1 & SAFE Guide Review** | `~/.gemini/config/skills/netsuite-sdf-safe-guide/SKILL.md` | SAFE Guide rules for `suitescript-safe-check.js`, `review_suitescript` prompt, and governance budgeting. |
| **SuiteScript Records & Fields Schema** | `~/.gemini/config/skills/netsuite-suitescript-records-reference/SKILL.md`<br>Resource: `netsuite://records/reference` | Standard 272 record definitions in `src/utils/metadata.ts` and `netsuite_schema` routing. |
| **SuiteQL Modeling & Anti-Slow-Query** | `~/.gemini/config/skills/netsuite-ai-connector-instructions/SKILL.md`<br>Resource: `netsuite://queries/golden-templates`<br>Tool: `netsuite_get_query_template` | SuiteQL validation rules in `src/utils/suiteqlGuard.ts` and golden templates in `src/utils/suiteqlTemplates.ts`. |
| **SuiteScript 1.0 → 2.1 Modernization** | `~/.gemini/config/skills/netsuite-suitescript-upgrade/SKILL.md` | Migration mappings in `upgrade_suitescript` prompt and AST deprecation checks in `suitescript-safe-check.js`. |
| **OWASP & Secure Coding Standards** | `~/.gemini/config/skills/netsuite-owasp-secure-coding/SKILL.md` | SQL injection detection, credential scanning in `scripts/pre-upload-check.js`, and parameter sanitization. |
| **Financial Operations & Reporting** | `~/.gemini/config/skills/netsuite-finance-analyst/SKILL.md` | Financial statements reporting logic in `ns_runReport` and accounting period queries. |
| **SDF Roles & Permissions Config** | `~/.gemini/config/skills/netsuite-sdf-roles-and-permissions/SKILL.md` | Role permission validation in `toolErrorSummarizer.ts` and SDF permission structures. |
| **SDF Project Documentation** | `~/.gemini/config/skills/netsuite-sdf-project-documentation/SKILL.md` | SDF architecture diagrams, manifest analysis, and deployment troubleshooting. |
| **UIF SPA Component Development** | `~/.gemini/config/skills/netsuite-uif-spa-reference/SKILL.md` | Modern NetSuite UIF SPA development patterns and `@uif-js/core` specifications. |

---

## ⚙️ 6. Antigravity Native Customization Architecture (.agents/)

This workspace adheres strictly to the official Google Antigravity Customization Architecture (`agy-customizations`):

- **Lifecycle Hooks ([`.agents/hooks.json`](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/hooks.json))**:
  - `PreToolUse`: Automated pre-upload safety and syntax checks (`scripts/pre-upload-check.js`).
  - `PostToolUse`: Automated code formatting and SAFE Guide static checks (`scripts/suitescript-safe-check.js`), plus workspace template synchronization (`scripts/post-tool-sync.js`).
- **Modular Directory Rules ([`.agents/rules/`](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules))**:
  - [Fast-Path Routing](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/fast-path-routing.md): 1-turn direct execution on standard tables.
  - [SuiteQL Guardrails](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/suiteql-guardrails.md): 7 golden SQL defense rules.
  - [SAFE Guide Standards](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/safe-guide-standards.md): SAFE Guide 2025.2 & OWASP secure coding directives.
  - [Environment Locks](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/environment-locks.md): Production write lockout & upload card gates.
  - [Generative UI](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/generative-ui.md): Antigravity Generative UI styling, CSS theme variables, and `<agent-embed>` directives.
