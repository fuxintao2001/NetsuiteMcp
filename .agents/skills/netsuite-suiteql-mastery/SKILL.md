---
name: netsuite-suiteql-mastery
description: >-
  SuiteQL 查询完全指南。包含 Oracle SQL 子集语法规则、BUILTIN 函数用法（DF/CONSOLIDATE）、
  JOIN/日期/字符串/NULL 处理、字段命名约定（id 非 internalid）、并行查询要求、
  禁止语法清单、ScriptNote 日志查询模式，以及强制工作流 SOP（schema→build→test→execute）。
  在编写或调试任何 SuiteQL 查询时激活此 skill。
---

# SuiteQL Mastery — Complete Query & Syntax Guide

This skill consolidates all SuiteQL rules from the project. For the full syntax reference with examples, see `netsuite://guides/suiteql` MCP Resource or `skills/netsuite-ai-connector-instructions/references/SUITEQL_GUIDE.md`.

---

## Mandatory Workflow (Zero-Guessing SOP)

| Step | Action | Tool |
|:---|:---|:---|
| ① Schema | Query target table schema — **NEVER guess field names** | `ns_getSuiteQLMetadata` |
| ② Build | Write query per schema; add `ROWNUM` limit for large tables | — |
| ③ Test | Validate with `WHERE ROWNUM <= 5` before full execution | `ns_runCustomSuiteQL` |
| ④ Execute | Run final query (2+ independent queries → **MUST use parallel**) | `ns_runCustomSuiteQL` / `netsuite_run_parallel_queries` |

---

## Basic Rules

- Do NOT use `SELECT *`; you must explicitly list all required fields.
- All queries MUST include a pagination limit: `FETCH FIRST 100 ROWS ONLY` (or use `WHERE ROWNUM <= N`).
- Table and field names are case-sensitive and must match the NetSuite Schema exactly.
- **You MUST call `ns_getSuiteQLMetadata` to verify the table schema before querying.** Never guess field names.

---

## Syntax Rules (Oracle SQL Subset)

- **Preferred Syntax**: Always prefer **Oracle SQL syntax** over SQL-92. SQL-92 carries higher risk of performance issues (timeouts).
- **No Mixing**: You can use either SQL-92 or Oracle SQL syntax, but **you cannot mix them in the same query**.
- **JOIN:** Explicitly use `INNER JOIN` / `LEFT JOIN`; implicit comma joins are prohibited.
- **Null Value Handling:** Prefer `NVL(field, default)`. `COALESCE` is supported but do not mix Oracle syntax.
- **Date Parameters:** You MUST use `TO_DATE('2024-01-01', 'YYYY-MM-DD')`; direct date string literals are prohibited.
- **String Concatenation:** Use the `||` operator; `+` concatenation is not supported.
- Do NOT use MySQL / PostgreSQL specific syntax (e.g., `LIMIT`, `ILIKE`, `::` type casting).
- **`WITH` (CTE) clauses are NOT supported.** Use subqueries instead.
- **`Square brackets []` are NOT supported.**
- A single `IN` clause can contain a maximum of 1000 parameters.
- Always provide explicit aliases for subqueries and tables to avoid column name ambiguity.

---

## Built-in Functions

All NetSuite-specific functions must be prefixed with `BUILTIN.`.

- **`BUILTIN.DF(field_name)`** — Get the display value of a field (avoids complex JOINs).
  ```sql
  SELECT id, BUILTIN.DF(status) AS status_display FROM transaction
  ```
- **`BUILTIN.CONSOLIDATE(field, type, currencyId, trandate)`** — Currency conversion.
  - Type options: `'A'` (Average), `'H'` (Historical), `'C'` (Current).
  ```sql
  SELECT id, BUILTIN.CONSOLIDATE(foreignamount, 'A', 1, trandate) AS consolidated_usd FROM transaction
  ```

---

## Date & Time Functions

```sql
-- Date conversion (always use TO_DATE with format mask)
WHERE trandate >= TO_DATE('2024-01-01', 'YYYY-MM-DD')

-- Date formatting
SELECT TO_CHAR(trandate, 'YYYY-MM') AS month_period FROM transaction

-- Date arithmetic
WHERE trandate >= ADD_MONTHS(TRUNC(SYSDATE), -3)
```

---

## String Functions

```sql
-- Concatenation (use ||, NOT + or CONCAT)
SELECT firstname || ' ' || lastname AS fullname FROM employee

-- Substring & Length
SELECT SUBSTR(name, 1, 10) AS short_name, LENGTH(name) AS len FROM item
```

---

## Null & Conditional Logic

```sql
-- NVL for null handling
SELECT id, NVL(memo, 'No memo provided') AS memo_clean FROM transaction

-- CASE WHEN for conditionals
SELECT id,
       CASE WHEN foreignamount > 10000 THEN 'High Value'
            WHEN foreignamount > 1000  THEN 'Medium Value'
            ELSE 'Low Value'
       END AS value_tier
FROM transaction
```

---

## Common Field Conventions

- Use `id` for primary keys (do NOT use `internalid`).
- Transaction amounts: `transamount` (local currency) vs. `foreignamount` (foreign currency). Clarify which one the user needs.
- Status fields are usually encoded; use `BUILTIN.DF(status)` to get the display name.
- Only fields marked as `x-n:joinable: true` in the metadata are allowed in JOIN clauses.
- Use `posting = 'T'` where GL accuracy is required.
- Use `approvalstatus = 2` where approved-only data is required.

---

## Transaction Mainline Filter

When querying `transaction` and `transactionline`, always filter by `mainline`:
- `mainline = 'T'` → Summary/Header row of the transaction.
- `mainline = 'F'` → Line items of the transaction.

```sql
SELECT id, tranid FROM transaction WHERE mainline = 'T' AND type = 'SalesOrd'
```

---

## Prohibited Syntax

| ❌ Prohibited | ✅ Use Instead |
|:---|:---|
| `LIMIT 10` | `FETCH FIRST 10 ROWS ONLY` |
| `ILIKE` | `LOWER(field) LIKE LOWER('%query%')` |
| `::varchar` / `CAST(x AS type)` | `TO_CHAR(x)` / `TO_NUMBER(x)` |
| `WITH cte_name AS (...)` | Inline subqueries |
| `Square brackets []` | Remove brackets |
| `SELECT *` | Explicit field list |
| `CREATE VIEW` | Not supported |

---

## Prohibited Actions

- Do NOT hardcode any environment-specific IDs (internal IDs differ between Sandbox and Production).
- Do NOT omit aliases in subqueries.

---

## Parallel Query Rule

> [!IMPORTANT]
> **🚨 If you need to execute two or more independent SuiteQL queries, you MUST run them concurrently using `netsuite_run_parallel_queries`. Directly calling `ns_runCustomSuiteQL` sequentially is strictly prohibited** unless a subsequent query depends on the output of a previous one.

---

## Supplementary Rules

- **Script Execution Logs:** Query the `ScriptNote` table for script logs (see `netsuite://guides/suiteql` §7 for patterns).
- **Native Pagination:** For high-volume result sets, prefer `pageSize` + `pageIndex` API parameters over SQL-level `ROWNUM` pagination.
- **Multi-Subsidiary Queries:** Before pulling financial data, explicitly clarify if user wants consolidated or subsidiary-specific results.

---

## Official Documentation

- 📖 [SuiteQL Overview](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257770590.html)
- ✏️ [SuiteQL Syntax and Examples](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257791851.html)
- ✅ [SuiteQL Supported and Unsupported Functions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257799794.html)
- ⚙️ [SuiteQL Supported Built-in Functions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257816823.html)
- 📊 NetSuite Records Catalog: `/app/recordscatalog/rcanalytics.nl` (Setup > Records Catalog)
