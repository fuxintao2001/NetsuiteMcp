# SuiteQL Authoritative Index & Fail-Fast Guardrails

> 🛡️ **Execution Philosophy**: **100% Transparent Execution & Zero Implicit Rewriting**. The NetSuite MCP Server executes SuiteQL transparently without silent SQL alteration, automatic dialect translation, or stealth pagination injection. Any query violating safety or dialect boundaries triggers an immediate Fail-Fast rejection. AI agents must understand the exact failure cause, explicitly correct their SQL, and retry.

---

## 1. Official Single Source of Truth (SSOT)

Do not maintain redundant, bespoke syntax encyclopedias locally. Always anchor SuiteQL design to Oracle authoritative documentation and skills:

### Primary Agent Skills (On-Demand Reading)
- `~/.gemini/config/skills/netsuite-ai-connector-instructions/SKILL.md` — Authoritative NetSuite Intelligence skill covering query standards, multi-subsidiary filtering, and SAFE anti-patterns.
- `~/.gemini/config/skills/netsuite-sdf-safe-guide/SKILL.md` — SAFE Guide data access architecture, index governance, and query optimization rules.

### MCP Read-Only Resources (URI Protocols)
- `netsuite://guides/suiteql` — **SuiteQL Query & Syntax Reference Guide**: Oracle SQL subset rules, BUILTIN functions, date arithmetic, and ScriptNote log query patterns.
- `netsuite://reference/suiteql-builtins` — **SuiteQL Built-in Functions Reference**: Signatures, schemas, and SAFE restrictions for `BUILTIN.DF`, `BUILTIN.CF`, `BUILTIN.HIERARCHY`, `BUILTIN.PERIOD`, `BUILTIN.CONSOLIDATE`, `BUILTIN.CURRENCY`.
- `netsuite://queries/golden-templates` — **Curated SuiteQL Query Template Library**: Certified production queries from Oracle SAFE Guide and Tim Dietrich.

---

## 2. Transparent Execution & Zero Implicit Rewriting Mandate

1. **Zero Secret AST Alteration**:
   - The server **never** silently converts MySQL/Postgres `LIMIT` to `FETCH FIRST`.
   - The server **never** forces or silently injects pagination behind the agent's back.
   - The server **never** auto-injects missing `mainline` predicates into executed SQL.
2. **Fail-Fast Interception**:
   - Queries violating syntax or security invariants fail immediately with structured diagnostic tags (`[suiteqlGuard]`).
3. **Explicit AI Self-Healing**:
   - AI agents must inspect the diagnostic message, review the referenced schema via `netsuite_get_metadata` or `netsuite://` guides, explicitly rewrite the query, and re-execute.

---

## 3. Core Fail-Fast Interception Boundaries

The server statically validates and hard-blocks the following 5 critical failure modes:

1. **Explicit Column Projections & Unique Aliases**:
   - ❌ `SELECT *` and `SELECT alias.*` are unconditionally blocked to prevent wide-table token explosion.
   - Multi-table joins must prefix shared column names (`t.id`, `tl.id`) to eliminate `ambiguous column` errors.
   - Projected columns must have distinct aliases (`AS col1`, `AS col2`) to eliminate `QUERY_DUPLICATE_ALIAS`.

2. **Mandatory `mainline` & Core Schema Invariants**:
   - Queries referencing `transactionline` must specify `tl.mainline = 'F'` (line items) or `tl.mainline = 'T'` (header summary) to prevent duplicate sums and inflated row counts.
   - Lineage queries must filter `transactionline.createdfrom = :upstreamId` (the column `createdfrom` does not exist on `transaction`).
   - Item classifications must use `item.itemtype` or `item.subtype` (the column `recordtype` does not exist on `item`).

3. **Common Table Expressions (CTE) Over Derived Tables & `BUILTIN.DF` Grouping**:
   - SuiteQL strictly prohibits inline views / subqueries in `FROM (SELECT ...)` or `JOIN (SELECT ...)`. Always rewrite using Common Table Expressions (CTE: `WITH cte_name AS (SELECT ...) SELECT ... FROM cte_name`).
   - `BUILTIN.DF()` is rejected inside `GROUP BY` expressions. Group by the underlying raw numeric ID or wrap aggregation in a CTE and apply `BUILTIN.DF()` in the outer query.

4. **Situational Oracle Pagination & Preceding Column Error Diagnosis**:
   - Dialect keywords `LIMIT` and bare `OFFSET` are strictly rejected.
   - AI agents dynamically judge whether to apply Oracle pagination (`FETCH FIRST N ROWS ONLY`, `OFFSET M ROWS FETCH NEXT N ROWS ONLY`, or `ROWNUM <= N`) based on query nature (e.g., broad sampling vs. unique entity lookup or aggregations).
   - NetSuite parser syntax errors flagged `near: FETCH` indicate preceding column typos, missing commas, or non-existent identifiers. **DO NOT remove 'FETCH FIRST' or convert to MySQL 'LIMIT'**; inspect projections and predicates immediately preceding `FETCH`.

5. **Audit Table Isolation & Driving Index Discipline**:
   - Direct `JOIN systemnote` is strictly blocked (SAFE Pitfall 11, causes 45s+ full-table scan timeouts). Query `systemnote` standalone by `recordid` or call `netsuite_get_system_notes`.
   - Queries against large transactional tables must filter on at least one driving indexed column (`trandate`, `type`, `id`, `tranid`, `entity`, `subsidiary`).

---

## 4. Companion Rules & Authoritative References

- **Master Charter**: [AGENTS.md](file://{{PROJECT_PATH}}/AGENTS.md)
- **Fast-Path Routing**: [Fast-Path Routing](file://{{PROJECT_PATH}}/.agents/rules/fast-path-routing.md)
- **SAFE Guide**: [SAFE Guide Standards](file://{{PROJECT_PATH}}/.agents/rules/safe-guide-standards.md)
- **Environment Locks**: [Environment Locks](file://{{PROJECT_PATH}}/.agents/rules/environment-locks.md)
- **Generative UI**: [Generative UI](file://{{PROJECT_PATH}}/.agents/rules/generative-ui.md)
