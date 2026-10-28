# NetSuite MCP Server — Authoritative AI Engineering & Code Generation Charter (AGENTS.md)

> 🤖 **Role & Scope**: This document is the authoritative engineering charter and code generation specification for AI Coding Agents (such as Google Antigravity, Claude Code, Cursor, and Windsurf) developing, maintaining, and refactoring **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`).
>
> 🎯 **Core Objective**: Guide AI Agents to write high-resilience, strict TypeScript/Node.js server code, maintain the 8 authoritative MCP tools (plus 2 Sandbox mutation tools and 1 official gateway), enforce runtime safety guards (`suiteqlGuard`), manage Redis caching and Redlock distributed locks, and preserve a 100/100 system architecture benchmark score.

---

## 🏛️ 1. Benchmark Reference Matrix

When designing, implementing, or refactoring tools, schemas, runtime guards, and observability in this repository, AI Agents must align with the best practices of these 8 industry-leading MCP reference projects:

| **#** | **Project** | **GitHub URL** | **Stars** | **Reference Value & Alignment in This Repository** |
| :---: | :--- | :--- | :---: | :--- |
| ① | **MCP Official Servers** | `github.com/modelcontextprotocol/servers` | ~90k★ | **Gold Standard for Tool Design**: Verb-noun naming conventions (`netsuite_get_record`), precise descriptions (explicit input/output expectations), strict Zod `inputSchema` definitions, and standard error payloads (`textResult(..., true)`). |
| ② | **MCP TypeScript SDK** | `github.com/modelcontextprotocol/typescript-sdk` | ~13k★ | **SDK Engineering Best Practices**: Stdio transport lifecycle management, static TypeScript type inference from Zod schemas (`z.infer<typeof Schema>`), and lock-free JSON-RPC 2.0 protocol encapsulation. |
| ③ | **GitHub MCP Server** | `github.com/github/github-mcp-server` | ~17k★ | **Enterprise Toolset Governance**: Domain-driven organization (Auth, Query, Record, Deployment, Diagnostics), 8 orthogonal core tools (Zero-Bloat, physical removal of deprecated aliases), and Production vs. Sandbox permission boundaries. |
| ④ | **Supabase MCP** | `github.com/supabase/mcp` | — | **Database & ERP Integration Paradigm**: Feature grouping, physical production write barriers, unified data inspection, and entity dictionary reflection. |
| ⑤ | **Sentry MCP** | `github.com/getsentry/sentry-mcp` | — | **End-to-End Observability**: Automated telemetry capture per tool invocation (`durationMs`, `payloadChars`, `errorCategory`), sensitive data masking, and frequency-based self-healing diagnostics (`netsuite_status`). |
| ⑥ | **Playwright MCP** | `github.com/microsoft/playwright-mcp` | — | **Complex Toolset UX Design**: Concise "Action Verb + Resource" descriptions in the first 5 words to eliminate LLM hallucination and misfires; on-demand exposure without deadlocks. |
| ⑦ | **Context7 MCP** | `github.com/upstash/context7-mcp` | — | **Context Economy Optimization**: Minimal response payloads, noise stripping (`contextSlimmer` automatically removes `null`/`undefined`/empty values), and high-density Markdown table formatting to reduce LLM token consumption by 50%+. |
| ⑧ | **ERPNext MCP Server** | `github.com/rakeshgangwar/erpnext-mcp-server` | — | **ERP Domain Abstraction**: Metadata reflection for complex ERP entity models (`netsuite_get_metadata`), automatic resolution of natural keys (`tranid`) to internal IDs (`id`), and direct Web UI link generation. |

### 1.1 Dynamic Benchmark Research

When static benchmarks do not cover a specialized requirement (such as complex SQL AST validation, chunked file transfers, or Node.js signal handling):

- **Proactive Benchmark Research**:
  - NEVER invent ad-hoc workarounds in isolation.
  - Proactively use web and GitHub search to inspect mature open-source implementations (official `modelcontextprotocol` servers, Prisma Engine, Hasura, Apache Calcite, Fastify, tRPC, BullMQ) and distill industry de facto standards into a single authoritative implementation.

---

## 🧼 2. Code Craftsmanship & Anti-Compatibility Bloat

AI Agents writing, reviewing, or refactoring code in this repository (`TypeScript`, `JavaScript`, `SuiteQL Guard`) must enforce the **Single Authoritative Implementation** principle:

1. **Clean Replacement, Never Dual-Track**:
   - ❌ **PROHIBITED**: Wrapping new logic in `try { newWay(); } catch (e) { oldWay(); }` for backward compatibility.
   - ❌ **PROHIBITED**: Adding feature-sniffing branches `if (supportsNewWay) { ... } else { ... }` to keep defective legacy code alive.
   - ❌ **PROHIBITED**: Chaining speculative property fallbacks (`val = newProp ?? oldProp ?? fallback`) due to unverified schemas.
   - ✅ **MANDATE**: Verify the single authoritative specification and execute a **100% clean replacement**.
2. **Immediate Physical Dead-Code Elimination**:
   - Deprecated implementations, obsolete methods, and unused parameters must be **physically deleted from the source code immediately**.
   - Never leave dead code behind as comments or defensive "just-in-case" branches.
3. **Root-Cause Resolution Over Defensive Masking**:
   - Errors indicate type defects, schema mismatches, or invalid assumptions. Identify the exact root cause and fix it at the source rather than swallowing exceptions with blind `try-catch` blocks.
4. **Current-State-Only Explanations (Zero Version Iteration Narrative)**:
   - ❌ **PROHIBITED**: Narrating historical code evolution or migration logs in comments, responses, or documentation (e.g., "Previously we used X, now we refactored to Y").
   - ✅ **MANDATE**: **Describe ONLY the current, definitive state and logic of the latest codebase.**

---

## 🛠️ 3. TypeScript MCP Server Development Specification

### 3.1 Architectural Layering & Responsibilities

```
src/
├── index.ts                # Server entrypoint: CLI argument parsing, Stdio transport initialization
├── mcp/                    # NetSuite low-level communication layer
│   └── tools.ts            # NetSuiteMCPTools: SuiteQL, REST Web Services, HTTP boundary & ConcurrencyLimiter(5)
├── handlers/               # MCP protocol dispatch layer
│   ├── tools.ts            # 8 authoritative core tools (+ 2 Sandbox mutation tools + 1 official gateway) registry & dispatcher
│   ├── toolSchemas.ts      # Zod parameter schemas, inferred types, and MCP JSON inputSchemas
│   ├── recordHandlers.ts   # Record inspection, natural key resolution, metadata dictionary, and system notes
│   ├── queryHandlers.ts    # Real-time SuiteScript execution logs & error stack tracing
│   ├── authHandlers.ts     # OAuth authentication status, logout, and diagnostic dashboard
│   ├── officialHandlers.ts # Universal gateway for Oracle NetSuite official native tools (reports, saved searches)
│   ├── uploadHandlers.ts   # SuiteCloud file upload & production write barrier
│   ├── prompts.ts          # MCP Prompts templates
│   └── resources.ts        # MCP read-only resources registration & retrieval
├── oauth/                  # OAuth 2.0 PKCE authentication subsystem (token rotation, session isolation)
├── cache/                  # Redis cache & Redlock distributed locks
├── telemetry/              # Structured invocation telemetry & error self-healing diagnostics
└── utils/                  # Runtime guardrails: suiteqlGuard, environment isolation, contextSlimmer
```

### 3.2 Language Standards & Type Safety

- **Runtime Environment**: Node.js ≥ 18, TypeScript strict mode (`strict: true`).
- **ESM Module Standard**: All relative imports must explicitly include the `.js` extension (e.g., `import { foo } from "./bar.js"`).
- **Zero `any` Policy**: Using `any` in source files is strictly prohibited. Use `unknown` for untrusted data and narrow types safely via Zod schemas or custom Type Guards.

### 3.3 Standard Recipe for Adding or Refactoring MCP Tools

Every new or modified tool in NetSuite MCP Server must follow this 4-step closed loop:

#### Step 1: Define Zod Schema in `src/handlers/toolSchemas.ts` (Batch-Array First)
```typescript
export const GetRecordArgsSchema = z.object({
  recordType: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "recordType is required")
    .describe("NetSuite record type ID (e.g. salesorder, customer, customrecord_xxx)."),
  id: z
    .string()
    .trim()
    .min(1, "id is required")
    .optional()
    .describe("Numeric internal ID (e.g. '12345') or document number / tranid (e.g. 'SO10023')."),
  ids: z
    .array(z.string().trim().min(1, "id is required"))
    .min(1, "id is required")
    .max(10, "A maximum of 10 records can be inspected in parallel.")
    .optional()
    .describe("Optional array of numeric internal IDs or document numbers (tranid) to inspect concurrently in parallel in a single turn (max 10)."),
  includeSublists: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to include line-item sublists in the output (default: true)."),
  format: z
    .enum(["markdown", "compact_json"])
    .optional()
    .default("markdown")
    .describe("Output format: 'markdown' (default) or 'compact_json'."),
});
export type GetRecordArgs = z.infer<typeof GetRecordArgsSchema>;
```

#### Step 2: Register Tool Metadata in `src/handlers/toolSchemas.ts` & `src/handlers/tools.ts`
Follow Playwright MCP naming conventions and explicitly expose batch array properties (`sqlQueries`, `tables`, `ids`) in `inputSchema.properties`:
```typescript
export const GET_RECORD_TOOL = {
  name: "netsuite_get_record",
  description: "Retrieve and inspect one or multiple NetSuite records concurrently by numeric internal ID or document number (tranid). Returns cleaned header fields, custom fields, and active Web UI links.",
  inputSchema: {
    type: "object" as const,
    properties: { /* ... */ },
    required: ["recordType"],
  },
};
```

#### Step 3: Implement Handler Business Logic with Built-in Parallel Pool Fan-Out
- Normalize arguments (trim whitespace, lowercase identifiers, merge singular and array inputs).
- Execute multi-entity, multi-table, and multi-query requests concurrently in a single turn via `Promise.all` backed by `ConcurrencyLimiter(5)`.
- Propagate permission errors immediately to trigger `PERMISSION DENIED — HARD STOP`, while isolating per-item non-permission errors in batch calls.
- Strip `null`/`undefined`/empty noise via `contextSlimmer`, format as compact Markdown tables, and append clickable NetSuite Web UI links.

#### Step 4: Write Vitest Unit Tests
Cover both single-entity and parallel batch execution flows, parameter boundary validations, and error scenarios (timeouts, permission hard-stops, production write blocks) in `*.test.ts`.

### 3.4 Redis Cache & Redlock Distributed Lock Specification

- Exclusively use Redis (`ioredis`) for caching (`ns:<accountId>:*` key namespace isolation).
- Acquire a distributed lock via Redlock (`src/cache/redisLock.ts`) during concurrent OAuth token refreshes to prevent destructive session race conditions.

### 3.5 Single-Turn Fan-Out Mandate (Parallel Execution Rules)

When executing read-only operations (SuiteQL queries, metadata reconnaissance, record inspection, script log retrieval, and system note audits), **step-by-step sequential serialization across turns is strictly prohibited**:

1. **Batch-Parameter First (Server-Side Parallelism)**:
   - **Multiple SuiteQL Queries**: Never split independent queries across multiple conversation turns. Submit all queries in **1 single call** to `netsuite_run_suiteql` using `sqlQueries: ["SELECT ...", "SELECT ..."]` (or `;`-separated statements in `sqlQuery`), executing concurrently via the server's 5-thread pool (`ConcurrencyLimiter(5)`).
   - **Multiple Table Schemas**: When inspecting multiple unknown tables or record types, pass `tables: ["customrecord_a", "customrecord_b"]` in **1 single call** to `netsuite_get_metadata`.
   - **Multiple Record Inspections**: When inspecting multiple records of the same type by internal ID or `tranid`, pass `ids: ["SO10023", "SO10024"]` in **1 single call** to `netsuite_get_record`.
2. **Multi-Tool Call Fan-Out (Client-Side Parallelism)**:
   - When a task requires multiple independent read-only tools without data dependencies, emit all `tool_calls` concurrently in the **exact same Assistant Turn**:
     - ✅ **Cross-Dimension Troubleshooting**: Emit `netsuite_get_record` + `netsuite_get_script_logs` + `netsuite_get_system_notes` together in Turn 1.
     - ✅ **Hybrid Discovery & Querying**: Emit `netsuite_get_metadata` (for unknown custom tables) alongside `netsuite_run_suiteql` (for known standard tables) in Turn 1.
   - ❌ **PROHIBITED**: Emitting a single read-only tool call, waiting for the response, and then emitting a second independent read-only tool call in the next turn.
3. **Only Permitted Sequential Boundary**:
   - Split execution into 2 turns ONLY when a downstream call's required argument (such as an unknown `internalId` or unverified custom column name) must be dynamically extracted from an upstream call's output (Turn 1: parallel reconnaissance / ID lookup ➔ Turn 2: parallel data retrieval).

---

## 🛡️ 4. NetSuite Gateway & Security Guardrails

### 4.1 SuiteQL Runtime Guard Contract (`src/utils/suiteqlGuard.ts`)

All SuiteQL queries executed through this server undergo static AST and regex validation:

1. **Zero Implicit Dialect Rewriting**: The server never silently rewrites non-standard SQL dialects. Queries using bare MySQL/Postgres `LIMIT` or bare `OFFSET` are strictly rejected at runtime with remediation guidance to enforce Oracle NetSuite standard syntax.
2. **Wildcard Projection Block**: `SELECT *` and `SELECT alias.*` are strictly blocked to prevent wide-table token explosion.
3. **Mandatory `mainline` Filter Check**: Queries referencing `transactionline` must include `tl.mainline = 'F'` or `'T'` to prevent duplicate row and amount inflation.
4. **Zero Implicit Query Rewriting & Situational Pagination**: The server executes SuiteQL queries transparently without automatic SQL rewriting or silent pagination injection, ensuring the AI model has full awareness and determinism over executed SQL statements. Pagination is never mandatory; AI models dynamically judge whether to include Oracle-compliant pagination (`FETCH FIRST N ROWS ONLY` or `ROWNUM <= N`) based on data volume, query nature (e.g., exploratory sampling vs. unique entity lookup/aggregations), and response payload requirements.
5. **Slow-Query Hard Block (SAFE Pitfall 11)**: Joining `systemnote` with transactional tables (`JOIN systemnote`) is strictly blocked to prevent 45s+ full-table scan timeouts; use standalone `systemnote` queries or `netsuite_get_system_notes`.
6. **Core Schema Invariant Remediation**:
   - Rejects `item.recordtype` ➔ directs to `itemtype` and `subtype`.
   - Rejects `transaction.createdfrom` ➔ directs to `transactionline.createdfrom`.

### 4.2 Dual-Gate Production Write Protection (`src/utils/environment.ts`)

- **Authoritative Environment Detection**: Determined solely by `isSandboxAccount(accountId)` (accounts containing `_sb`, `-sb`, or starting with `tstdrv` are Sandbox; all others are Production).
- **Physical Mutation Lockout**: `netsuite_create_record` and `netsuite_update_record` are physically filtered out and blocked in Production environments.
- **File Upload Confirmation**: `netsuite_upload_file` requires explicit `allowProduction: true` authorization when targeting a Production account.

---

## 🚦 5. Quality Gates & Verification Pipeline

After any code change, AI Agents must execute the full verification pipeline and ensure 100% pass rates:

```bash
# 1. Strict TypeScript compilation & type checking (0 errors)
npm run typecheck

# 2. Biome code formatting & static lint analysis (0 errors, 0 warnings)
npm run lint

# 3. Vitest unit & integration test suite (100% pass)
npm test

# 4. ISO/IEC 25010 & Oracle SAFE system architecture benchmark score (95+ / 100)
npm run score

# 5. Oracle NetSuite official documentation compliance suite (100% compliant)
npm run test:compliance
```

---

## 🔄 6. Structured Error Diagnostics & Self-Healing SOP

When an MCP tool returns an error, AI Agents must follow the structured diagnostic tag and execute targeted self-healing without blind retries:

| Diagnostic Tag / Error Pattern | Root Cause Category | Mandated Self-Healing Action |
| :--- | :--- | :--- |
| `[Self-Healing Action]: Call netsuite_get_metadata` | Non-existent column or table name | Call `netsuite_get_metadata` to verify valid column names, fix the SQL, and re-execute. |
| `[suiteqlGuard] Missing 'mainline' filter` | Missing `mainline` predicate on `transactionline` | Add `tl.mainline = 'F'` (line items) or `tl.mainline = 'T'` (header summary) to the `WHERE` clause. |
| `[suiteqlGuard] Use FETCH FIRST N ROWS ONLY` | Non-Oracle pagination dialect (`LIMIT`) | Replace with `FETCH FIRST 100 ROWS ONLY`, `ROWNUM <= 100`, or `OFFSET M ROWS FETCH NEXT N ROWS ONLY`. |
| `PERMISSION DENIED — HARD STOP` | Insufficient NetSuite role permissions (403) | **Halt immediately!** Never fabricate data; report the missing NetSuite permission key to the user. |
| `[Production Safety Violation]` | Write operation attempted in Production | Halt mutation and inform the user that record creation/updates are restricted to Sandbox environments. |
| `NETWORK_OR_TIMEOUT` | Transient network jitter or gateway timeout | **Do not modify SQL.** Retry with exponential backoff (≤ 2 retries) or reduce pagination page size. |

---

## 💬 7. Communication & Code Style Conventions

1. **Language Conventions**:
   - Match the user's conversational language in chat explanations, analysis summaries, and troubleshooting responses.
   - Keep all guidance files (`AGENTS.md`, `.agents/rules/*.md`), code identifiers, TypeScript types, comments, SQL keywords, and schema names strictly in **standard English**.
2. **Current-State Focus**:
   - Always explain only the current design and runtime logic of the codebase, omitting historical version narratives.
