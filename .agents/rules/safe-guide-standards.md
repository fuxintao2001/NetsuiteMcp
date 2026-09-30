# NetSuite MCP Server — Core Architecture & Reliability Standards

> 🛡️ **Authoritative Scope**: MCP Server TypeScript Engineering Invariants (`@suiteinsider/netsuite-mcp`).

## 1. Single Authoritative Implementation & Zero Defensive Bloat

1. **Definitive Implementation Over Fallback Chaining**:
   - Every feature, tool handler, or query builder must have a single authoritative code path.
   - Do NOT wrap unverified code in speculative try-catch fallbacks or dual-track sniffing branches (`if (newWay) ... else oldWay`). Confront errors at the root cause.
2. **Immediate Dead Code Removal**:
   - Deprecated functions, obsolete parameters, and superseded logic must be immediately deleted. Do NOT retain dead code as comments or "safety fallbacks".

## 2. Official Tool Primacy & Transparent Self-Healing

1. **Official Tool Standard**:
   - Preserves 100% of Oracle NetSuite official tools (`ns_runCustomSuiteQL`, `ns_getRecord`, `ns_getRecordTypeMetadata`, `ns_getSuiteQLMetadata`, `ns_runReport`, `ns_createRecord`, `ns_updateRecord`).
   - Official tool names, contracts, and parameters remain the canonical interfaces.
2. **Under-the-Hood Transparent Resilience**:
   - Tool handlers must be resilient to common LLM habits:
     - `ns_runCustomSuiteQL`: Automatically transpile MySQL/Postgres `LIMIT` / `OFFSET` dialects to Oracle `FETCH FIRST` / `ROWNUM` before execution.
     - `ns_getRecord`: Automatically resolve natural keys (`tranid`, `entityid`, `itemid`) to internal numeric IDs via SuiteQL instead of halting with 404 errors.
     - `ns_getRecordTypeMetadata`: Automatically fall back to offline 272 standard record definitions if the remote REST metadata API returns 404 or fails.

## 3. Concurrency Governance & Reliability Guardrails

1. **Concurrency Bounds**:
   - All outbound NetSuite API calls must pass through `ConcurrencyLimiter(5)` and `retryWithBackoff` to respect NetSuite account concurrency limits.
2. **Dual-Gate Environment Protection**:
   - Mutation operations (`ns_createRecord`, `ns_updateRecord`) are physically blocked in Production accounts.
   - Code deployments via `netsuite_suitecloud_upload` strictly require user confirmation before uploading to NetSuite.
