# SuiteQL Architectural Guardrails (Zero-Shot Pass Standards)

> 🛡️ Strictly enforce these 7 golden rules and defensive syntax patterns to achieve 100% first-pass execution through `suiteqlGuard`:

## 1. Authoritative References & MCP Resources

Read these MCP resources on demand when authoring or debugging SuiteQL:
- `netsuite://guides/suiteql` — **SuiteQL Query & Syntax Reference Guide**: Oracle SQL subset rules, BUILTIN functions, date arithmetic, and ScriptNote log queries.
- `netsuite://queries/golden-templates` — **Curated SuiteQL Query Template Library**: Certified production queries from Oracle SAFE Guide and Tim Dietrich.
- `netsuite://reference/suiteql-builtins` — **SuiteQL Built-in Functions Reference**: Signatures and SAFE restrictions for `BUILTIN.DF`, `BUILTIN.CF`, `BUILTIN.HIERARCHY`, `BUILTIN.PERIOD`, `BUILTIN.CONSOLIDATE`, `BUILTIN.CURRENCY`.

---

## 2. Seven Golden SuiteQL Guardrails

1. **Zero Wildcards**: NEVER use `SELECT *`; ALWAYS specify explicit column names.
2. **Display Value Mapping**: To display friendly names of foreign entities, items, or statuses, use `BUILTIN.DF(field)` (e.g. `BUILTIN.DF(tl.item) AS item_name`) instead of costly multi-table JOINs.
3. **Mainline & Taxline Discipline**:
   - Line-item details: ALWAYS include `tl.mainline = 'F' AND tl.taxline = 'F'`.
   - Header summary only: ALWAYS include `tl.mainline = 'T'`.
4. **Downstream Transaction Lineage**:
   - Link downstream transactions via `transactionline.createdfrom = :upstreamId`; NEVER use `transaction.createdfrom` (column does not exist).
5. **No SystemNote JOINs**:
   - NEVER JOIN `SystemNote` directly with transactional tables (causes Cartesian explosion and 45s+ timeouts). Query `SystemNote` as a standalone table or call `netsuite_get_system_notes`.
6. **Pagination & Date Standards**:
   - **Recommended**: `FETCH FIRST N ROWS ONLY` for simple pagination, or Oracle-standard `OFFSET M ROWS FETCH NEXT N ROWS ONLY` for skip-pagination.
   - **Allowed**: `ROWNUM <= N` as an alternative.
   - **Prohibited**: MySQL-style `LIMIT N` and bare non-standard `OFFSET N` (without `ROWS FETCH`).
   - **Parameterized Binding**: `FETCH FIRST ? ROWS ONLY` and `FETCH FIRST :limit ROWS ONLY` are recognized correctly; do not manually append additional pagination clauses.
   - ALWAYS cast date literals using `TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD')`.
7. **Driving Index Requirement**:
   - Queries against large tables MUST filter on at least one indexed column: `type`, `trandate`, `id`, `tranid`, `entity`, `subsidiary`.

---

## 3. Critical Syntax Traps & Defensive Standards

1. **Derived Tables in FROM/JOIN (`FROM (SELECT ...)` or `JOIN (SELECT ...)`)**:
   - NetSuite SuiteQL strictly disallows inline views or subqueries in `FROM` or `JOIN` clauses.
   - **Mandatory Pattern**: Rewrite using Common Table Expressions (CTE: `WITH cte_name AS (SELECT ...) SELECT ... FROM cte_name`) or flatten into direct joins.
2. **`BUILTIN.DF()` in `GROUP BY` Expressions**:
   - SuiteQL does not support `BUILTIN.DF()` directly within `GROUP BY` expressions.
   - **Mandatory Pattern**: Group by the underlying numeric ID (e.g., `GROUP BY t.entity`), or aggregate within a CTE and apply `BUILTIN.DF()` in the outer query (`WITH grp AS (SELECT entity, COUNT(*) AS cnt FROM transaction GROUP BY entity) SELECT BUILTIN.DF(entity) AS entity_name, cnt FROM grp`).
3. **Duplicate Column Aliases (`QUERY_DUPLICATE_ALIAS`)**:
   - Projecting identical alias names (e.g., `SELECT a AS name, b AS name`) causes syntax rejection.
   - **Mandatory Pattern**: Ensure every projected column has a distinct alias name.
4. **Ambiguous Join Columns (`ambiguous column` / `ambiguously defined`)**:
   - When joining tables that share column names (`id`, `subsidiary`, `memo`, `name`), un-aliased column references cause query errors.
   - **Mandatory Pattern**: Explicitly prefix ambiguous columns with their corresponding table alias (e.g., `t.id` vs. `tl.id`).
5. **The False 'near: FETCH' Trap**:
   - NetSuite's SQL parser often flags syntax errors, invalid column names, or missing commas immediately preceding `FETCH` as `near: FETCH`.
   - **Mandatory Pattern**: **DO NOT remove 'FETCH FIRST' or convert to MySQL 'LIMIT'** (which is completely invalid). Inspect column projections and WHERE predicates immediately before `FETCH`, or verify columns using `WHERE ROWNUM <= 10`.

---

## 4. Companion Rules & Authoritative References

- **Master Charter**: [AGENTS.md](file://{{PROJECT_PATH}}/AGENTS.md)
- **Fast-Path Routing**: [Fast-Path Routing](file://{{PROJECT_PATH}}/.agents/rules/fast-path-routing.md)
- **SAFE Guide**: [SAFE Guide Standards](file://{{PROJECT_PATH}}/.agents/rules/safe-guide-standards.md)
- **Environment Locks**: [Environment Locks](file://{{PROJECT_PATH}}/.agents/rules/environment-locks.md)
- **Generative UI**: [Generative UI](file://{{PROJECT_PATH}}/.agents/rules/generative-ui.md)
