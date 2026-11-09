---
name: netsuite-systematic-debugging
description: Use when encountering any NetSuite SuiteScript error, SuiteQL query failure, SDF deployment issue, data discrepancy, or MCP server bug, before proposing or writing any fixes. Enforces 4-phase root cause investigation using concurrent NetSuite MCP evidence gathering (script logs, system notes, live schema metadata) and 3-strike architectural escalation.
license: MIT
metadata:
  author: SuiteInsider (Adapted from obra/superpowers for Oracle NetSuite)
  version: "1.0.0"
---

# NetSuite Systematic Root-Cause Debugging

## Overview

**Core principle:** ALWAYS find the authoritative root cause in NetSuite's execution logs, audit trail, live schema, or MCP pipeline before attempting fixes. Symptom fixes and speculative fallbacks are engineering failures.

**Violating the letter of this process is violating the spirit of debugging.**

## The Iron Law

```text
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you have not completed Phase 1 (Evidence Gathering & Schema Verification), you are strictly prohibited from editing SuiteScript files, rewriting SuiteQL logic blindly, or patching MCP TypeScript handlers.

---

## When to Use

Activate this skill immediately for ANY NetSuite or MCP technical issue:
- **SuiteScript 2.1 Runtime Exceptions**: `SSS_USAGE_LIMIT_EXCEEDED`, `INVALID_KEY_OR_REF`, `RCRD_HAS_BEEN_CHANGED`, `USER_ERROR`, `TypeError: log.warn is not a function`, unexpected `null`/`NaN` values.
- **SuiteQL Failures & Discrepancies**: `[suiteqlGuard]` interceptions, Oracle syntax errors near `FETCH`, 0-row results, duplicate rows from unguarded joins, or GL impact mismatches.
- **Record & Workflow Anomalies**: Fields unexpectedly overwritten after save, status transitions failing, or permission violations (`INSUFFICIENT_PERMISSION` / HTTP 403).
- **MCP Server & Tooling Bugs**: `node:test` failures in `test/`, OAuth 2.0 PKCE token refresh issues, Redis/Redlock contention, or `contextSlimmer` truncation bugs.

**Use this ESPECIALLY when:**
- Under month-end close or production hotfix pressure (emergencies make guessing tempting).
- "Just adding a fallback `||`" or wrapping code in `try/catch` seems like a quick fix.
- A previous fix attempt did not resolve the issue.

---

## The Four Mandatory Phases

You MUST complete each phase sequentially before proceeding to the next.

### Phase 1: Root Cause Investigation (Zero Code Changes Allowed)

**BEFORE proposing or writing ANY fix:**

1. **Single-Turn Evidence Fan-Out (NetSuite Live Telemetry)**
   When investigating a NetSuite record, transaction, or script issue, emit independent diagnostic tool calls **concurrently in the exact same turn**:
   - **Execution Logs (`netsuite_get_script_logs`)**: Pass `scriptIds` or filter by `ERROR` / `EMERGENCY` to capture the exact stack trace, line number, and error code.
   - **Audit Trail (`netsuite_get_system_notes`)**: Pass `recordIds` to inspect who or what (User Event, Workflow, Scheduled Script, CSV Import, or UI user) modified the field, when, and from what old value to what new value.
   - **Authoritative Schema (`netsuite_get_metadata`)**: When dealing with custom records (`customrecord_*`), custom fields (`custbody_*`, `custcol_*`), or unfamiliar tables, inspect the live schema first. Never guess field IDs.
   - **Record State (`netsuite_get_record`)**: Inspect the actual field values on the target record.

2. **Read Diagnostic Tags & Stack Traces Completely**
   - If an MCP tool returns a `[suiteqlGuard]` or `[Self-Healing Action]` diagnostic tag, read the exact rule violated.
   - If `PERMISSION DENIED — HARD STOP` (`INSUFFICIENT_PERMISSION` / HTTP 403) occurs, **halt immediately**. Do not attempt workarounds or alternative queries to bypass permissions; consult `netsuite-sdf-roles-and-permissions` and report the missing permission key.

3. **Check Recent Changes**
   - In local workspaces: check `git status` and `git diff` to see recent code, XML, or schema guard modifications.
   - In NetSuite: check `systemnote` or script deployment modification timestamps.

4. **Trace Data Flow Backward across Multi-Component Boundaries**
   See [root-cause-tracing.md](root-cause-tracing.md) for the complete backward tracing technique across NetSuite layers:
   ```text
   External Integration / RESTlet / UI Client Script
     └──> User Event (beforeLoad -> beforeSubmit -> afterSubmit)
           └──> Workflow (Entry / Before Record Submit / After Record Submit)
                 └──> Sublist Line Items (transactionline) & GL Impact (transactionaccountingline)
   ```
   - Where did the bad field value (`NaN`, wrong `subsidiary`, wrong `taxcode`, missing `mainline = 'F'`) originate?
   - Fix at the source where bad data is introduced, NEVER by masking it downstream.

---

### Phase 2: Pattern Analysis

**Find the authoritative pattern before fixing:**

1. **Consult Tier 1/2/3 Authoritative References**
   - Check `netsuite-suitescript-records-reference` for standard record field IDs and sublist names.
   - Check `netsuite-sdf-safe-guide` for the 140+ documented SuiteApp pitfalls and governance rules.
   - Check `netsuite-ai-connector-instructions` for SuiteQL join patterns and multi-currency handling.

2. **Compare Working vs. Broken Records/Queries**
   - Run a single `netsuite_run_suiteql` batch comparing a **working transaction** against the **failing transaction** (comparing `status`, `subsidiary`, `currency`, `postingperiod`, `mainline`, `taxline`, `createdfrom`).
   - List every difference, however small. Do not assume "that custom field couldn't matter."

3. **Identify Coexistence & Context Conflicts**
   - Check `runtime.executionContext` (e.g., does the script work in `USERINTERFACE` but fail in `CSVIMPORT`, `WEBSERVICES`, or `MAPREDUCE`?).
   - Check if another deployed User Event script or Workflow is running after your script and overwriting values.

---

### Phase 3: Hypothesis and Testing

**Apply the scientific method:**

1. **Formulate a Single, Explicit Hypothesis**
   - State clearly: *"I hypothesize that `customscript_so_ue` throws `INVALID_KEY_OR_REF` on `custbody_dept` because Subsidiary 3 does not have access to Department 12, as evidenced by the script log and subsidiary mapping."*
   - Be specific, never vague.

2. **Test Minimally**
   - For **SuiteQL / Data hypotheses**: Execute a targeted read-only query via `netsuite_run_suiteql` with `FETCH FIRST 10 ROWS ONLY` to prove or disprove the data relationship before touching any code.
   - For **MCP Server / Guardrail hypotheses**: Run a single isolated test via `node --import tsx --test test/suiteql/suiteqlGuard.test.ts`.
   - Change only ONE variable at a time.

3. **Verify Before Continuing**
   - Confirmed? Proceed to Phase 4.
   - Disproved? Discard the hypothesis and form a new one based on the new evidence. **NEVER stack a second speculative fix on top of an unverified first fix.**

---

### Phase 4: Implementation & Architectural Escalation

**Fix the root cause cleanly — zero compatibility bloat:**

1. **Create a Failing Test Case First**
   - Follow the `netsuite-tdd` skill (`skills/netsuite-tdd/SKILL.md`).
   - For MCP Server / `suiteqlGuard` bugs: write a failing `node:test` case reproducing the exact SQL or payload edge case.
   - For SuiteScript pure business logic: write a failing unit test or deterministic SuiteQL verification query before modifying the script.

2. **Implement a Single Clean Replacement**
   - ❌ **STRICTLY PROHIBITED**: `try { newWay(); } catch (e) { oldWay(); }`
   - ❌ **STRICTLY PROHIBITED**: `rec.getValue('custbody_v2') || rec.getValue('custbody_v1')` when one field is simply wrong.
   - ✅ **MANDATE**: Execute a 100% clean replacement using the verified field ID/API, and physically delete dead code immediately.
   - See [defense-in-depth.md](defense-in-depth.md) for adding layered validation after resolving the root cause.

3. **Verify the Fix**
   - For MCP codebase changes: run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` (must achieve 0 errors and 0 warnings).
   - For SuiteScript uploads: present the interactive confirmation card via `ask_question` before calling `netsuite_upload_file`, then verify execution via `netsuite_get_script_logs`.

4. **The 3-Strike Rule: Architectural Escalation**
   - If you have attempted **3 fixes** and the issue persists (or each fix exposes a new problem): **STOP IMMEDIATELY.**
   - **Common NetSuite Architectural Mismatches (Not fixable by tuning lines of code)**:
     - Attempting to process 200+ transaction lines or call `record.load` inside a loop within a synchronous `UserEvent` (`beforeSubmit` / `afterSubmit` — 1,000 unit limit) instead of delegating to a `Map/Reduce` script (10,000 unit limit per stage).
     - Attempting to join `systemnote` across millions of transactions in SuiteQL instead of querying standalone by `recordid`.
     - Mutating the current record via `record.submitFields` inside `beforeSubmit` (which causes `RCRD_HAS_BEEN_CHANGED`) instead of setting fields directly on `context.newRecord`.
   - Discuss the architectural redesign with the user before attempting Fix #4.

---

## Red Flags — STOP and Return to Phase 1

If you catch yourself thinking any of the following, **STOP immediately**:
- *"Let me just wrap this `record.load` or field lookup in a `try/catch` so it doesn't crash."*
- *"I'm not sure if the field is `tranid` or `transactionnumber`, I'll check both with `||`."*
- *"Let me add `log.warn()` to see what's happening."* (Fatal crash: `N/log` only has `debug`, `audit`, `error`, `emergency`!)
- *"The SuiteQL query failed near `FETCH`, so `FETCH FIRST N ROWS ONLY` must be unsupported — let me switch to `LIMIT`."* (Wrong! A syntax error near `FETCH` is caused by an invalid column or missing clause *preceding* `FETCH`.)
- *"Let me deploy the whole project with `suitecloud project:deploy` to see if it fixes the environment."* (Strictly prohibited! Always use granular `netsuite_upload_file` with user confirmation.)

---

## Common Rationalizations vs. NetSuite Reality

| Excuse | NetSuite & MCP Reality |
|:---|:---|
| "Calling `netsuite_get_metadata` takes an extra turn, I'll guess the custom field ID" | Guessing a wrong `custbody_*` or `customrecord_*` field causes immediate runtime failure or silent `undefined` bugs. Reconnaissance on unknown custom schemas takes 1 second. |
| "I'll fix the symptom in the saved search / report instead of the User Event script" | Dirty data written to the ledger (`transactionaccountingline`) corrupts financial close and reconciliation. Fix the script writing the bad data. |
| "Let's try one more regex tweak in `suiteqlGuard.ts` without running `npm test`" | Blind regex edits break valid Oracle CTEs or analytic functions (`OVER (PARTITION BY ...)`). Run the test suite every time. |
| "3 fixes failed, let me try a 4th workaround in `afterSubmit`" | 3 failures in a synchronous script means you hit a NetSuite platform architecture boundary (Governance / Concurrency / Record Lock). Redesign as asynchronous Map/Reduce. |

---

## Quick Reference Checklist

| Phase | Key NetSuite / MCP Actions | Success Criteria |
|:---|:---|:---|
| **1. Root Cause** | Concurrent fan-out: `netsuite_get_script_logs` + `netsuite_get_system_notes` + `netsuite_get_metadata` | Know exact error code, offending script/workflow, and verified field IDs |
| **2. Pattern** | Compare working vs. failing records via `netsuite_run_suiteql`; check `netsuite-sdf-safe-guide` | Pinpoint exact data, context (`runtime.executionContext`), or schema difference |
| **3. Hypothesis** | Form single theory; verify with read-only SuiteQL (`FETCH FIRST 10 ROWS ONLY`) or isolated `node:test` | Hypothesis proven with live data or test output |
| **4. Implementation** | Write failing test (`netsuite-tdd`), apply 100% clean replacement, run quality gates | Bug resolved, 0 dead code, all tests and checks green |
