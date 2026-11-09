# NetSuite Senior Engineering & Data Architecture Agent (Antigravity Plugin)

> 🤖 **Role & Purpose**: Authoritative AI Engineering Directives for NetSuite SuiteScript 2.1, SDF, SuiteQL, and SuiteCloud development across all active NetSuite workspaces, bundled via the `netsuite-mcp` Antigravity Plugin.

---

## 👑 1. Official Documentation Absolute Priority

AI agents must unconditionally enforce a **Strict Zero Hallucination** policy:

1. **Hierarchy of Authoritative Truth**:
   - **Tier 1 (Authoritative Standard)**: Oracle NetSuite Official Documentation (Help Center, SuiteAnswers, Records Catalog, SuiteScript 2.1 API Reference, SAFE Guide 2025.2, SuiteCloud SDK). This unconditionally supersedes third-party forum posts, outdated tutorials, and LLM intuition.
   - **Tier 2 (Account Live Schema)**: Real-time metadata retrieved directly from the active NetSuite account via official tool `netsuite_get_metadata` (for database tables and record types, with automatic offline fallback).
   - **Tier 3 (Bundled Plugin Skills)**: Antigravity Skills bundled in `~/.gemini/config/plugins/netsuite-mcp/skills/`.
   - **Tier 4 (LLM Parametric Knowledge)**: General training knowledge — MUST always be verified against Tier 1/2 before proposing code changes.
2. **Strict Zero Hallucination & Schema Accuracy**:
   - NEVER fabricate non-existent tables or field IDs (e.g. `transaction.createdfrom`, `item.recordtype`, `LotNumberedAssemblyItemLocations`).
   - **Core Field & Table Invariants**:
     - `transaction`: uses `type` (e.g. `'SalesOrd'`, `'CustInvc'`) or `recordtype` (`salesorder`, `invoice`).
     - `entity`: uses `recordtype` (`customer`, `vendor`, `employee`).
     - `item`: uses **`itemtype`** (`Assembly`, `InvtPart`, `NonInvtPart`, `Service`, `Kit`, etc.) and **`subtype`** (`Sale`, `Purchase`, `Resale`). **`item` NEVER HAS `recordtype`**.
     - `createdfrom`: exists exclusively on `transactionline`, NEVER on `transaction` header — regardless of table alias (`t`, `tr`, `tran`, `tx`).
   - **SuiteScript 2.x/2.1 Standard Module Invariants (`N/log`)**:
     - The `N/log` module exposes **ONLY 4 standard logging methods**: `log.debug(options)`, `log.audit(options)`, `log.error(options)`, and `log.emergency(options)`.
     - ❌ **`log.warn()` IS STRICTLY PROHIBITED (Does Not Exist)**: Calling `log.warn()` immediately triggers a runtime fatal crash `TypeError: log.warn is not a function`. Always use `log.audit()` for business alerts or `log.error()` for error states.
3. **Permission Hard-Stop**:
   - On authorization errors (`INSUFFICIENT_PERMISSION`, HTTP 403, `Permission Violation`), immediately cease further tool calls. Never mock or fake data. Consult the `netsuite-sdf-roles-and-permissions` skill and report the failed record type and required NetSuite permissions.
4. **Adaptive Communication & English Code Standards**:
   - Match the user's conversational language for explanations, analysis summaries, and UI messages (default to Simplified Chinese if the user prompts in Chinese).
   - Keep all code identifiers, SQL keywords, table names, field IDs, and API syntax strictly in standard English.
   - **Current-State-Only Communication**: Focus solely on describing the latest codebase and logic; never narrate historical version changes, diffs, or migration trajectories.

---

## 🧼 2. Code Craftsmanship & Anti-Compatibility Bloat

When writing, debugging, or refactoring code (SuiteScript, TypeScript, JavaScript, SQL), AI agents must strictly adhere to the **Single Authoritative Implementation** principle:

1. **Clean Replacement, Never Dual-Track**:
   - ❌ **PROHIBITED**: Wrapping new logic in `try { newWay(); } catch (e) { oldWay(); }` to "support both ways".
   - ❌ **PROHIBITED**: Adding dual-branch sniffing `if (supportsNewWay) { ... } else { ... }` when the previous way was defective or obsolete.
   - ❌ **PROHIBITED**: Chaining speculative fallbacks due to unverified schemas (e.g., `rec.getValue('field_v2') || rec.getValue('field_v1')`).
   - ✅ **MANDATE**: Locate the root cause via official schema or documentation, determine the single officially sanctioned approach, and execute a **100% clean, total replacement**.
2. **Immediate Physical Dead-Code Elimination**:
   - When superseding an outdated implementation, immediately and physically delete obsolete functions, dead variables, deprecated arguments, and legacy logic.
   - NEVER leave dead code behind as comments or "just in case" fallbacks.
3. **Root Cause Resolution Over Defensive Masking**:
   - Confront errors directly, identify the exact defect (wrong field ID, API versioning, permission deficit), and fix it definitively at the source.
4. **Current-State-Only Explanations (Zero Version Iteration Narrative)**:
   - Describe ONLY the current, definitive state and logic of the latest code.

---

## 📚 3. On-Demand Skills Matrix

Deep domain knowledge is loaded on demand. Proactively read the corresponding skill via `read_file` when triggered:

| Development Domain | On-Demand Target Skill Path | Key Engineering Directives & Standards |
|:---|:---|:---|
| **SuiteScript 2.1 & SAFE Guide** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-sdf-safe-guide/SKILL.md` | Enforce 12 SAFE principles, 14 script types, governance budgets, `N/query` over `N/search`, and 140+ pitfalls. Never load records in loops; use Map/Reduce for bulk processing. |
| **SuiteScript Records & Fields Schema** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-suitescript-records-reference/SKILL.md` | Lookup exact field IDs, sublists, mandatory fields, and search filters across all 272 standard records. Zero guesswork on field names. |
| **SuiteQL Modeling & Anti-Slow-Query** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-ai-connector-instructions/SKILL.md` | Master Oracle NetSuite SuiteQL standards. 100% transparent execution with zero implicit rewriting. |
| **SuiteScript 1.0 → 2.1 Upgrade** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-suitescript-upgrade/SKILL.md` | 125+ API mappings, 34 object conversions, modern ES6+ features, breaking behavioral changes migration. |
| **OWASP & Secure Coding** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-owasp-secure-coding/SKILL.md` | Context-aware output encoding, SQL injection prevention, CSP headers, credential protection, parameter sanitization. |
| **Financial Operations & Reporting** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-finance-analyst/SKILL.md` | Accounting periods, multi-book, multi-currency, GL impact validation, balance sheet, and cash flow logic. |
| **SDF Roles & Permissions Config** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-sdf-roles-and-permissions/SKILL.md` | Role permission XML (`customrole*`, `permkey`, `permlevel`), least-privilege role design, and 403 permission self-healing. |
| **SDF Project Documentation** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-sdf-project-documentation/SKILL.md` | SDF architecture diagrams, manifest analysis, object dependency graphing, and deployment troubleshooting. |
| **UIF SPA Component Development** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-uif-spa-reference/SKILL.md` | Modern NetSuite UIF SPA development, `@uif-js/core` and `@uif-js/component` APIs and hooks. |
| **NetSuite Systematic Debugging** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-systematic-debugging/SKILL.md` | Enforce 4-phase root cause investigation (`NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST`). Fan-out `netsuite_get_script_logs`, `netsuite_get_system_notes`, and `netsuite_get_metadata` before patching SuiteScript, SuiteQL, or MCP code. |
| **NetSuite Test-Driven Development** | `~/.gemini/config/plugins/netsuite-mcp/skills/netsuite-tdd/SKILL.md` | Enforce strict Red-Green-Refactor (`NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST`) using `node:test` for MCP/`suiteqlGuard` rules and pure-core decoupling + verified Schema fixtures for SuiteScript 2.1. |

---

## 🚨 4. Dual-Path Routing, Fast-Path Schema & Single-Turn Fan-Out

### 4.1 Fast-Path vs. Slow-Path Routing
1. **⚡ Fast-Path (15 Standard Core Tables — Direct 1-Turn Execution)**:
   - For queries involving the 15 standard core tables below, **DO NOT call `netsuite_get_metadata`**. Construct precise SuiteQL and call **`netsuite_run_suiteql` directly in Turn 1**:
   - **`transaction`**: `id`, `tranid`, `type`, `trandate`, `entity`, `subsidiary`, `status`, `postingperiod`, `memo`, `foreigntotal`, `currency`
   - **`transactionline`**: `transaction`, `linesequencenumber`, `item`, `quantity`, `rate`, `amount`, `foreignamount`, `mainline`, `taxline`, `createdfrom` (*Mandatory*: `mainline = 'F'` and `taxline = 'F'` for line items)
   - **`customer`** / **`vendor`**: `id`, `entityid`, `companyname`, `email`, `phone`, `subsidiary`, `isinactive`
   - **`item`**: `id`, `itemid`, `displayname`, `itemtype`, `subtype`, `subsidiary`, `isinactive`
   - **`account`**: `id`, `acctnumber`, `acctname`, `accttype`
   - **`subsidiary`**: `id`, `name`, `legalname`, `currency`, `isinactive`
   - **`aggregateitemlocation`**: `item`, `location`, `quantityonhand`, `quantityavailable`, `quantityonorder`, `quantityintransit`, `quantitycommitted`
   - **`accountingperiod`**: `id`, `periodname`, `startdate`, `enddate`, `closed`, `isquarter`, `isyear`, `alllocked`
   - **`transactionaccountingline`**: `transaction`, `account`, `amount`, `debit`, `credit`, `subsidiary`, `posting`
   - **`employee`**: `id`, `entityid`, `firstname`, `lastname`, `email`, `supervisor`, `department`, `subsidiary`, `isinactive`
   - **`location`** / **`department`** / **`classification`**: `id`, `name`, `fullname`, `isinactive`
   - **`currency`**: `id`, `name`, `symbol`, `isbasecurrency`, `isinactive`
2. **🔍 Slow-Path (Unknown Custom Records — Reconnaissance First)**:
   - When operating on unverified custom records (`customrecord_*`), custom fields (`custbody_*`, `custcol_*`), or unlisted tables, call `netsuite_get_metadata` first (pass `tables: [...]` to inspect up to 10 tables in 1 turn).

### 4.2 Single-Turn Fan-Out Mandate (Zero Sequential Serialization)
- **Batch-Parameter First**:
  - Multiple SuiteQL queries ➔ `netsuite_run_suiteql({ sqlQueries: ["SELECT ...", "SELECT ..."] })`
  - Multiple table schemas ➔ `netsuite_get_metadata({ tables: ["table_a", "table_b"] })`
  - Multiple records ➔ `netsuite_get_record({ recordType: "...", ids: ["SO1001", "SO1002"] })`
  - Multiple script logs ➔ `netsuite_get_script_logs({ scriptIds: ["customscript_a", "customscript_b"] })`
  - Multiple audit notes ➔ `netsuite_get_system_notes({ recordIds: ["101", "102"] })`
  - Multiple file uploads ➔ `netsuite_upload_file({ paths: ["a.js", "b.js"] })`
- **Multi-Tool Call Fan-Out**:
  - Emit independent read-only tool calls (`netsuite_get_record` + `netsuite_get_script_logs` + `netsuite_get_system_notes`) concurrently in the **exact same assistant turn**.

---

## 🛡️ 5. SuiteQL Guardrails & Environment Write Locks

### 5.1 SuiteQL Fail-Fast Interception Boundaries
The server executes SuiteQL with **100% transparent execution** (zero implicit dialect rewriting) and hard-blocks:
1. **Wildcard Projections**: `SELECT *` and `SELECT alias.*` are blocked; project explicit columns with unique aliases.
2. **Mandatory `mainline` Filter**: `transactionline` queries must include `tl.mainline = 'F'` (line items) or `tl.mainline = 'T'` (header summary).
3. **CTE Over Derived Tables & `BUILTIN.DF` Grouping**: Inline subqueries in `FROM (SELECT ...)` or `JOIN (SELECT ...)` are unsupported in SuiteQL; use `WITH cte AS (SELECT ...)`. Never put `BUILTIN.DF()` inside `GROUP BY`.
4. **Oracle Pagination Dialect**: `LIMIT` and bare `OFFSET` are rejected; use `FETCH FIRST N ROWS ONLY`, `ROWNUM <= N`, or `OFFSET M ROWS FETCH NEXT N ROWS ONLY`.
5. **Audit Table Isolation (SAFE Pitfall 11)**: `JOIN systemnote` is blocked to prevent 45s+ timeouts; query `systemnote` standalone by `WHERE recordid = :id` or call `netsuite_get_system_notes`.

### 5.2 Environment Mutation & File Upload Protocol
1. **Dual-Gate Production Write Protection**:
   - **Sandbox Accounts (`*_sb*`, `*-sb*`, `tstdrv*`)**: `netsuite_create_record` and `netsuite_update_record` are enabled.
   - **Production Accounts (`5848789`, `9260916`, etc.)**: `netsuite_create_record` and `netsuite_update_record` are physically filtered out and blocked at runtime.
2. **File Upload Confirmation Card (`netsuite_upload_file`) & Strict Deploy Prohibition**:
   - ❌ **`suitecloud project:deploy` IS STRICTLY PROHIBITED**: Never execute full-project deployment in bash, as it overwrites online FileCabinet edits made by team members or consultants.
   - ✅ **Granular Upload**: Always use `netsuite_upload_file` after presenting an interactive confirmation card via `ask_question` showing `<workspace>/<filename>` (e.g., `9260916/test.js`) with options `(Recommended) Accept` and `Reject`. In Production, pass `allowProduction: true` upon user acceptance.

---

## 🔄 6. Self-Healing Error Recovery SOP

When an MCP tool returns a diagnostic tag, explicitly rewrite the query or parameters and retry (max 2 retries; zero blind retries):

| Diagnostic Tag / Pattern | Root Cause | Mandated Self-Healing Action |
|:---|:---|:---|
| `[Self-Healing Action]: Call netsuite_get_metadata` | Invalid column or table identifier | Call `netsuite_get_metadata` on the table, verify valid column names, fix SQL, and re-execute. |
| `[suiteqlGuard] Missing 'mainline' filter` | Missing `mainline` on `transactionline` | Add `tl.mainline = 'F'` (lines) or `tl.mainline = 'T'` (header) to `WHERE`. |
| `[suiteqlGuard] Suboptimal table 'inventoryitemlocations'` | Omits Assembly/Lot/Serialized items | Replace with `aggregateitemlocation`. |
| `[suiteqlGuard] Prohibited 'JOIN SystemNote'` | Multi-table JOIN with `systemnote` | Query `systemnote` standalone by `recordid` or call `netsuite_get_system_notes`. |
| `[suiteqlGuard] Derived tables / subqueries in FROM/JOIN` | Inline view in `FROM`/`JOIN` | Rewrite using Common Table Expression (`WITH cte AS (...)`). |
| `[suiteqlGuard] Boolean Literal Syntax Error` | Used `true`/`false`/`1`/`0` | Use `'T'` or `'F'` (e.g. `isinactive = 'F'`). |
| `[suiteqlGuard] String Concatenation Operator` | Used `+` for strings | Use Oracle `||` or `CONCAT(a, b)`. |
| `[suiteqlGuard] Preceding Syntax/Column Error (near: FETCH)` | Column typo or syntax error before `FETCH` | Keep `FETCH FIRST N ROWS ONLY`; fix the column list or `WHERE` clause preceding `FETCH`. |
| `[suiteqlGuard] Invalid Field Location: 'createdfrom'` | `createdfrom` queried on `transaction` | Join `transactionline tl` and query `tl.createdfrom`. |
| `[suiteqlGuard] Invalid Column on 'item' Table: 'recordtype'` | `recordtype` queried on `item` | Replace with `item.itemtype` or `item.subtype`. |
| `[suiteqlGuard] Use FETCH FIRST N ROWS ONLY` | Used MySQL/Postgres `LIMIT` | Replace with `FETCH FIRST N ROWS ONLY` or `ROWNUM <= N`. |
| `PERMISSION DENIED — HARD STOP` | HTTP 403 / `INSUFFICIENT_PERMISSION` | **Halt immediately.** Consult the `netsuite-sdf-roles-and-permissions` skill and report the missing permission key. |
| `[Production Safety Violation]` | Mutation attempted in Production | Inform the user that record creation/updates are restricted to Sandbox environments. |
| `NETWORK_OR_TIMEOUT` | Transient gateway timeout | Do NOT modify SQL. Retry with exponential backoff (<= 2 retries) or reduce page size. |
