# Defense-in-Depth for NetSuite & MCP Engineering

## Overview

When you fix a bug caused by invalid data, schema mismatch, or governance exhaustion, fixing the single point of failure is only step one. In enterprise ERP engineering, once the root cause is resolved, you must enforce **Defense-in-Depth** across all architectural layers so that the entire class of bug becomes structurally impossible.

---

## The 4-Layer Defense Model

### Layer 1: Entry Contract Validation (Fail-Fast at the Boundary)
Reject invalid inputs immediately before consuming NetSuite governance units or network connections.

- **In `@suiteinsider/netsuite-mcp` (`src/handlers/`)**:
  - Validate all tool arguments using strict **Zod schemas** (zero `any`; narrow `unknown` types explicitly).
  - Enforce `isSandboxAccount(accountId)` at the handler entry point before constructing any mutation payload.
- **In SuiteScript 2.1 (RESTlets, Suitelets, Map/Reduce)**:
  - Validate required parameters, `runtime.executionContext`, and event types (`context.UserEventType.CREATE`, `EDIT`, `DELETE`) at the very top of the entry point function:
    ```javascript
    if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
        return;
    }
    ```

### Layer 2: Schema & Static AST Guardrails
Ensure queries and record operations adhere to NetSuite invariants before hitting the database.

- **SuiteQL Guardrails (`src/utils/suiteqlGuard.ts`)**:
  - Block `SELECT *` and `SELECT alias.*`.
  - Require explicit `mainline = 'F'` or `mainline = 'T'` whenever `transactionline` is queried.
  - Block `JOIN systemnote` to prevent 45s+ gateway timeouts.
  - Block fabricated fields (`transaction.createdfrom`, `item.recordtype`).
- **SuiteScript Field Access**:
  - Verify every field ID against Tier 1 (`netsuite-suitescript-records-reference`) or Tier 2 (`netsuite_get_metadata`).
  - Never chain speculative fallbacks (`rec.getValue('a') || rec.getValue('b')`).

### Layer 3: Governance, Concurrency & Idempotency Guards
Protect the runtime from resource exhaustion and race conditions.

- **Governance Monitoring (SuiteScript 2.1)**:
  - In long-running scripts (`Scheduled`, `Map/Reduce`), monitor remaining usage via `runtime.getCurrentScript().getRemainingUsage()` and yield or reschedule cleanly before hitting 0.
  - Never place `record.load()`, `record.save()`, or `query.runSuiteQL()` inside a line-item loop.
- **Concurrency & Locking (`@suiteinsider/netsuite-mcp`)**:
  - All outbound NetSuite HTTP requests must pass through `ConcurrencyLimiter(5)` to prevent HTTP 429 (`SSS_REQUEST_LIMIT_EXCEEDED`).
  - Token refreshes and shared cache mutations must be protected by Redlock / file locks to prevent race conditions across multi-instance MCP processes.

### Layer 4: Structured Audit & Safe Logging
Ensure future issues leave an unambiguous diagnostic trail without crashing the runtime.

- **SuiteScript `N/log` Invariant**:
  - Use **ONLY** `log.debug(options)`, `log.audit(options)`, `log.error(options)`, or `log.emergency(options)`.
  - ❌ **NEVER call `log.warn()`** — it does not exist on `N/log` and will immediately crash the script with `TypeError: log.warn is not a function`.
  - Always include structured context in `details`: `{ recordType, recordId, subsidiaryId, executionContext: runtime.executionContext }`.
