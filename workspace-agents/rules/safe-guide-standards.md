# Oracle NetSuite SAFE Guide & OWASP Standards

> 📖 **Authoritative Reference**: SAFE Guide 2025.2, OWASP Top 10 Secure Coding & Oracle SuiteCloud SDK.

## 1. Authoritative References & MCP Resources

- `netsuite://safe/governance-units` — **Oracle SAFE Guide Official Governance Units & Limits Reference**: API operation unit costs, script usage limits across all 14 script types, and SAFE optimization patterns.

---

## 2. Governance & Anti-Loop Standards

1. **Anti-Looping Operations**:
   - ❌ NEVER execute `record.load()`, `record.delete()`, or `search.create()` inside loops (`for`, `while`, `forEach`).
   - ✅ For bulk processing, leverage Map/Reduce scripts or batch `record.submitFields({ ignoreMandatoryFields: true })`.
2. **Search vs Record Loading**:
   - Prefer `N/query` or `N/search` with explicit column projections over loading full records. `record.load()` consumes 5–10 governance units per call; searches consume 10 units for up to 1,000 results.
3. **Cache Heavy Lookups**:
   - Use `N/cache` for repetitive metadata, subsidiary configs, or static parameter lookups.

---

## 3. OWASP Secure Coding & Injection Prevention

1. **Dynamic Code Execution**:
   - ❌ NEVER use `eval()`, `new Function()`, or dynamic setTimeout code evaluation.
2. **Output Encoding**:
   - Encode all dynamic parameters in Suitelet HTML output using `encodeHtml` or context-appropriate escaping to prevent XSS.
3. **SuiteQL Parameter Sanitization**:
   - Use parameterized queries `query.runSuiteQL({ query: sql, params: [...] })` rather than concatenating untrusted user input directly into SQL strings.

---

## 4. Two-Tier Code Quality & Static Analysis Standards

1. **Tier 1 (Language & Module Hygiene)**:
   - Use standard linters (Biome / ESLint with `eslint-plugin-suitescript`) for syntax verification, ES6+ module loading (`define(['N/record'], (record) => ...)`), and consistent formatting.
2. **Tier 2 (Domain & SAFE Compliance Guardrails)**:
   - Run `scripts/suitescript-safe-check.js` to catch ERP-specific failure modes that general linters miss:
     - `SAFE-GOV-001` / `002`: Governance unit budget exhaustion in loop bodies.
     - `SAFE-SQL-001` / `002`: Wildcard projections (`SELECT *`) and non-Oracle SQL dialects.
     - `SAFE-SQL-003`: Prohibited `JOIN SystemNote` cartesian product timeouts (Pitfall 11).
     - `SAFE-SCH-001`: Mandatory `mainline` filter predicates on transaction queries to prevent amount inflation.

---

## 5. SuiteScript Unit Testing Standards (@oracle/suitecloud-unit-testing)

1. **Official Unit Testing Mocking**:
   - When authoring complex SuiteScript 2.1 scripts (Map/Reduce, UserEvent, Suitelet, RESTlet), adhere to Oracle's official unit testing standard using `@oracle/suitecloud-unit-testing` with Jest or Vitest.
2. **Local Isolation**:
   - Always mock NetSuite native modules (`N/record`, `N/search`, `N/query`, `N/log`, `N/runtime`) with official stubs so business logic can be thoroughly verified locally before uploading to NetSuite File Cabinet.

---

## 6. Ten NetSuite MCP Tools Governance Architecture

The workspace interacts with NetSuite through **10 NetSuite MCP Tools** (8 Core Tools + 2 Sandbox Mutation Tools), architected to preserve NetSuite governance and prevent runtime lockouts:

1. **8 Core Tools (Governance-Preserving & Read-Only)**:
   - `netsuite_run_suiteql`: High-density query engine; batches up to 10 queries via `sqlQueries` over a 5-worker pool, consuming vastly fewer governance units than individual record operations.
   - `netsuite_get_metadata`: Cached schema dictionary supporting batch reconnaissance via `tables: [...]`.
   - `netsuite_get_record`: Read and inspect records via `id` or batch `ids: [...]` (max 10) with automatic natural key resolution and null noise pruning.
   - `netsuite_get_script_logs`: Real-time execution log auditing via `scriptId` or batch `scriptIds: [...]` without triggering script re-runs.
   - `netsuite_get_system_notes`: Field-level audit trail inspection via `recordId` or batch `recordIds: [...]`, avoiding unindexed Cartesian joins.
   - `netsuite_upload_file`: SuiteCloud CLI file upload via `paths` with pre-flight dry-run validation and syntax checks.
   - `netsuite_status`: Account health, token expiry, and telemetry error frequency diagnostics.
   - `netsuite_auth`: OAuth 2.0 PKCE session lifecycle and Redis cache management.
2. **2 Sandbox Mutation Tools (Strictly Sandbox-Only)**:
   - `netsuite_create_record`: Create business records in Sandbox environments with validated field maps.
   - `netsuite_update_record`: Update business records in Sandbox environments by internal ID or `tranid`.
   - *Production Guard*: Both mutation tools are physically blocked in Production environments to ensure absolute data safety.

---

## 7. Companion Rules & Authoritative References

- **Master Charter**: [AGENTS.md](file://{{PROJECT_PATH}}/AGENTS.md)
- **SuiteQL Defense**: [SuiteQL Guardrails](file://{{PROJECT_PATH}}/.agents/rules/suiteql-guardrails.md)
- **Fast-Path Routing**: [Fast-Path Routing](file://{{PROJECT_PATH}}/.agents/rules/fast-path-routing.md)
- **Environment Locks**: [Environment Locks](file://{{PROJECT_PATH}}/.agents/rules/environment-locks.md)
- **Generative UI**: [Generative UI](file://{{PROJECT_PATH}}/.agents/rules/generative-ui.md)
