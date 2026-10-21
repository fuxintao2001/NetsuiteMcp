# Fast-Path & Slow-Path Routing Directives

> ⚡ **Core Business Latency Elimination & Single-Turn Fan-Out (Zero Unnecessary Reconnaissance)**

## 1. Dual-Path Execution Model & Single-Turn Fan-Out

1. **⚡ Fast-Path (Standard Core Business — Direct 1-Turn Penetration Mandate)**:
   - For queries involving standard core tables (`transaction`, `transactionline`, `customer`, `vendor`, `item`, `account`, `subsidiary`, `aggregateitemlocation`, `accountingperiod`, `transactionaccountingline`, `employee`, `location`, `department`, `classification`, `currency`):
   - **STRICTLY PROHIBITED**: Calling reconnaissance tools prior to querying standard core tables.
   - **MANDATORY**: Construct precise Oracle NetSuite SuiteQL and call **`netsuite_run_suiteql` directly on Turn 1**. Zero pre-flight roundtrips.

2. **🔍 Slow-Path (Unknown Custom Records — Reconnaissance First)**:
   - When operating on unverified custom records (`customrecord_*`), custom fields (`custbody_*`, `custcol_*`), or unlisted tables:
   - **MANDATORY**: Call `netsuite_get_metadata` to inspect table columns and field data types. When inspecting multiple unknown tables, pass `tables: ["customrecord_a", "customrecord_b"]` in a single call.

3. **🚀 Single-Turn Fan-Out & Batch Execution Mandate (Zero Sequential Turn Delay)**:
   - When a task requires retrieving multiple independent datasets, inspecting multiple tables, or fetching multiple records:
   - **STRICTLY PROHIBITED**: Executing read-only calls sequentially one-by-one across multiple conversation turns.
   - **MANDATORY (Batch-Parameter First)**:
     - **Multiple SuiteQL Queries**: Pass `sqlQueries: ["SELECT ... FROM transaction ...", "SELECT ... FROM customer ..."]` (or separate with semicolons `;` in `sqlQuery`) in a single `netsuite_run_suiteql` call.
     - **Multiple Table Schemas**: Pass `tables: ["table_a", "table_b"]` in a single `netsuite_get_metadata` call (up to 10 tables).
     - **Multiple Records**: Pass `ids: ["SO10023", "SO10024"]` in a single `netsuite_get_record` call (up to 10 records).
     - **Multiple Script Logs**: Pass `scriptIds: ["customscript_a", "customscript_b"]` in a single `netsuite_get_script_logs` call (up to 10 scripts).
     - **Multiple Audit System Notes**: Pass `recordIds: ["101", "102"]` in a single `netsuite_get_system_notes` call (up to 10 records).
     - **Multiple File Uploads**: Pass `paths: ["scripts/a.js", "scripts/b.js"]` in a single `netsuite_upload_file` call.
   - **MANDATORY (Multi-Tool Call Fan-Out)**:
     - When combining different read-only tools without data dependencies (e.g., `netsuite_get_record` + `netsuite_get_script_logs` + `netsuite_get_system_notes`), emit all `tool_calls` concurrently in the **same turn**.

---

## 2. Fast-Path Core Whitelist & In-Context Schema (Zero Reconnaissance Required)

These schemas are certified production standards. AI agents must project directly against these columns without calling metadata tools:

| Core Table | Certified Whitelist Columns | Notes / Golden Patterns |
|:---|:---|:---|
| **`transaction`** | `id`, `tranid`, `type`, `trandate`, `entity`, `subsidiary`, `status`, `postingperiod`, `memo`, `foreigntotal`, `currency` | Filter by `type` (e.g. `'SalesOrd'`, `'CustInvc'`, `'PurchOrd'`). Use `BUILTIN.DF(entity)`. |
| **`transactionline`** | `transaction`, `linesequencenumber`, `item`, `quantity`, `rate`, `amount`, `foreignamount`, `mainline`, `taxline`, `createdfrom` | **Mandatory** `mainline = 'F'` and `taxline = 'F'` for line items. Upstream lineage is `createdfrom`. **Note**: `createdfrom` exists on `transactionline` ONLY, never on `transaction` header — regardless of table alias (`t`, `tr`, `tran`, `tx`). |
| **`customer`** | `id`, `entityid`, `companyname`, `email`, `phone`, `subsidiary`, `isinactive` | Primary key is `id`. |
| **`vendor`** | `id`, `entityid`, `companyname`, `email`, `phone`, `subsidiary`, `isinactive` | Primary key is `id`. |
| **`item`** | `id`, `itemid`, `displayname`, `itemtype`, `subsidiary`, `isinactive` | Type field is `itemtype` (NEVER `recordtype`). |
| **`account`** | `id`, `acctnumber`, `acctname`, `accttype` | General ledger account chart. |
| **`subsidiary`** | `id`, `name`, `legalname`, `currency`, `isinactive` | OneWorld multi-subsidiary hierarchy. |
| **`aggregateitemlocation`** | `item`, `location`, `quantityonhand`, `quantityavailable`, `quantityonorder`, `quantityintransit`, `quantitycommitted` | Multi-location inventory MLI balances. |
| **`accountingperiod`** | `id`, `periodname`, `startdate`, `enddate`, `closed`, `isquarter`, `isyear`, `alllocked` | Period close validation. |
| **`transactionaccountingline`** | `transaction`, `account`, `amount`, `debit`, `credit`, `subsidiary`, `posting` | GL impact lines (`posting = 'T'`). |
| **`employee`** | `id`, `entityid`, `firstname`, `lastname`, `email`, `supervisor`, `department`, `subsidiary`, `isinactive` | HR / employee entity. |
| **`location`** | `id`, `name`, `fullname`, `subsidiary`, `isinactive`, `makeinventoryavailable` | Warehouse / Location master records. |
| **`department`** | `id`, `name`, `fullname`, `isinactive` | Department organizational segments. |
| **`classification`** | `id`, `name`, `fullname`, `isinactive` | Class / Business line tracking segments. |
| **`currency`** | `id`, `name`, `symbol`, `isbasecurrency`, `isinactive` | Currency definitions and base currency flag. |

---

## 3. Direct 1-Turn Golden Execution Templates

### Pattern A: Recent Transactions List
```sql
SELECT t.id, t.tranid, t.trandate, BUILTIN.DF(t.entity) AS entity_name, t.foreigntotal, BUILTIN.DF(t.status) AS status_label
FROM transaction t
WHERE t.type = 'SalesOrd'
ORDER BY t.id DESC
FETCH FIRST 10 ROWS ONLY
```

### Pattern B: Transaction Line Items
```sql
SELECT tl.linesequencenumber, BUILTIN.DF(tl.item) AS item_name, tl.quantity, tl.rate, tl.amount
FROM transactionline tl
WHERE tl.transaction = 12345 AND tl.mainline = 'F' AND tl.taxline = 'F'
ORDER BY tl.linesequencenumber ASC
```

### Pattern C: Multi-Location Inventory Balance
```sql
SELECT ail.item, BUILTIN.DF(ail.item) AS item_name, BUILTIN.DF(ail.location) AS location_name, ail.quantityavailable, ail.quantityonhand
FROM aggregateitemlocation ail
WHERE ail.item = 1001
```

---

## 4. Companion Rules & Authoritative References

- **Master Charter**: [AGENTS.md](file://{{PROJECT_PATH}}/AGENTS.md)
- **SuiteQL Defense**: [SuiteQL Guardrails](file://{{PROJECT_PATH}}/.agents/rules/suiteql-guardrails.md)
- **SAFE Guide**: [SAFE Guide Standards](file://{{PROJECT_PATH}}/.agents/rules/safe-guide-standards.md)
- **Environment Locks**: [Environment Locks](file://{{PROJECT_PATH}}/.agents/rules/environment-locks.md)
- **Generative UI**: [Generative UI](file://{{PROJECT_PATH}}/.agents/rules/generative-ui.md)
- **MCP Resources**:
  - `netsuite://queries/golden-templates` — Curated SuiteQL Query Template Library
  - `netsuite://records/reference` — Oracle NetSuite Official 272 Records Definition Index
  - `netsuite://guides/suiteql` — SuiteQL Query & Syntax Reference Guide
