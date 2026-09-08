# Fast-Path & Slow-Path Routing Directives

> ⚡ **Core Business Latency Elimination (Zero Unnecessary Reconnaissance)**

## 1. Dual-Path Execution Model

1. **⚡ Fast-Path (Standard Core Business — Direct 1-Turn Execution)**:
   - For queries involving standard core tables (`transaction`, `transactionline`, `customer`, `vendor`, `item`, `account`, `subsidiary`) or known transaction lineages:
   - **DO NOT call reconnaissance tools** (`ns_getSuiteQLMetadata`, `netsuite_get_record_definition`, `netsuite_get_query_template`).
   - **MUST generate precise SuiteQL and call `ns_runCustomSuiteQL` directly in Turn 1.**

2. **🔍 Slow-Path (Unknown Custom Records — Reconnaissance First)**:
   - Only when operating on unverified custom records (`customrecord_*`), custom fields (`custbody_*`, `custcol_*`, `custrecord_*`), or unlisted niche tables:
   - Call `ns_getSuiteQLMetadata` or `netsuite_get_record_definition` to inspect the live schema before executing queries or mutations.

## 2. In-Context Standard Core Schema

- **`transaction`**: `id`, `tranid`, `type`, `trandate`, `entity`, `subsidiary`, `status`, `postingperiod`, `memo`, `foreigntotal`, `currency`
- **`transactionline`**: `transaction`, `linesequencenumber`, `item`, `quantity`, `rate`, `amount`, `foreignamount`, `mainline` ('T'/'F'), `taxline` ('T'/'F'), `createdfrom`
- **`customer` / `vendor`**: `id`, `entityid`, `companyname`, `email`, `phone`, `subsidiary`, `isinactive`
- **`item`**: `id`, `itemid`, `displayname`, `itemtype`, `subsidiary`, `isinactive`
- **`account`**: `id`, `acctnumber`, `acctname`, `accttype`
- **`subsidiary`**: `id`, `name`, `legalname`, `currency`, `isinactive`
