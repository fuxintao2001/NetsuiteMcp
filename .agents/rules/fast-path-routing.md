# Fast-Path & Slow-Path Routing Directives

> ⚡ **Core Business Latency Elimination (Zero Unnecessary Reconnaissance)**

## 1. Dual-Path Execution Model

1. **⚡ Fast-Path (Standard Core Business — Direct 1-Turn Penetration Mandate)**:
   - For queries involving standard core tables (`transaction`, `transactionline`, `customer`, `vendor`, `item`, `account`, `subsidiary`, `aggregateitemlocation`, `accountingperiod`, `transactionaccountingline`, `employee`):
   - **STRICTLY PROHIBITED**: Calling reconnaissance or metadata sniffing tools (`ns_getSuiteQLMetadata`, `netsuite_get_record_definition`, `ns_getRecordTypeMetadata`, `netsuite_get_query_template`) prior to querying.
   - **STRICTLY PROHIBITED**: Calling Saved Search tools (`ns_runSavedSearch`, `ns_listSavedSearches`) by default.
   - **MANDATORY**: Construct precise SuiteQL and call **`ns_runCustomSuiteQL` directly on Turn 1**. Zero pre-flight roundtrips.

2. **🔍 Slow-Path (Unknown Custom Records — Reconnaissance First)**:
   - When operating on unverified custom records (`customrecord_*`), custom fields (`custbody_*`, `custcol_*`), or unlisted tables:
   - **For SuiteQL database tables**: Call `ns_getSuiteQLMetadata` (inspect columns or search catalog).
   - **For record fields & custom fields**: Call `ns_getRecordTypeMetadata` (live tenant schema with automatic offline fallback).

3. **🚫 Saved Search Non-Invocation Policy**:
   - In the vast majority of scenarios, **DO NOT call SavedSearch tools (`ns_listSavedSearches`, `ns_runSavedSearch`)**.
   - Data querying should always be performed via SuiteQL (`ns_runCustomSuiteQL`).
   - Only call Saved Search tools if explicitly instructed by the user or if a complex metric is exclusively available in an existing Saved Search that cannot be replicated in SuiteQL.

4. **🚀 Parallel Multi-Query Mandate (Zero Sequential Turn Delay)**:
   - When a task requires retrieving multiple independent or correlated datasets (e.g. Transaction details + Customer info + Stock balance, or period comparisons):
   - **STRICTLY PROHIBITED**: Executing queries sequentially across multiple conversation turns.
   - **MANDATORY**: Execute concurrently within **1 single turn** using:
     - **Option A (Semicolon syntax)**: `ns_runCustomSuiteQL({ sqlQuery: "SELECT ... FROM transaction ...; SELECT ... FROM customer ...;" })`
     - **Option B (Query array)**: `ns_runCustomSuiteQL({ sqlQueries: ["SELECT ... FROM transaction ...", "SELECT ... FROM customer ..."] })`
     - **Option C (Batch tool)**: `netsuite_batch_execute({ tasks: [{ toolName: "ns_runCustomSuiteQL", arguments: { sqlQuery: "..." } }, ...] })`
   - All queries execute concurrently via the MCP server's 5-thread pool and return unified results in 1 turn.

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
