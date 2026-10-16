# Oracle NetSuite SAFE Guide & OWASP Standards

> 📖 **Authoritative Reference**: SAFE Guide 2025.2, OWASP Top 10 Secure Coding & Oracle SuiteCloud SDK.

## 1. Governance & Anti-Loop Standards

1. **Anti-Looping Operations**:
   - ❌ NEVER execute `record.load()`, `record.delete()`, or `search.create()` inside loops (`for`, `while`, `forEach`).
   - ✅ For bulk processing, leverage Map/Reduce scripts or batch `record.submitFields({ ignoreMandatoryFields: true })`.
2. **Search vs Record Loading**:
   - Prefer `N/query` or `N/search` with explicit column projections over loading full records. `record.load()` consumes 5–10 governance units per call; searches consume 10 units for up to 1,000 results.
3. **Cache Heavy Lookups**:
   - Use `N/cache` for repetitive metadata, subsidiary configs, or static parameter lookups.

## 2. OWASP Secure Coding & Injection Prevention

1. **Dynamic Code Execution**:
   - ❌ NEVER use `eval()`, `new Function()`, or dynamic setTimeout code evaluation.
2. **Output Encoding**:
   - Encode all dynamic parameters in Suitelet HTML output using `encodeHtml` or context-appropriate escaping to prevent XSS.
3. **SuiteQL Parameter Sanitization**:
   - Use parameterized queries `query.runSuiteQL({ query: sql, params: [...] })` rather than concatenating untrusted user input directly into SQL strings.

## 3. Two-Tier Code Quality & Static Analysis Standards

1. **Tier 1 (Language & Module Hygiene)**:
   - Use standard linters (Biome / ESLint with `eslint-plugin-suitescript`) for syntax verification, ES6+ module loading (`define(['N/record'], (record) => ...)`), and consistent formatting.
2. **Tier 2 (Domain & SAFE Compliance Guardrails)**:
   - Run `scripts/suitescript-safe-check.js` to catch ERP-specific failure modes that general linters miss:
     - `SAFE-GOV-001` / `002`: Governance unit budget exhaustion in loop bodies.
     - `SAFE-SQL-001` / `002`: Wildcard projections (`SELECT *`) and non-Oracle SQL dialects.
     - `SAFE-SQL-003`: Prohibited `JOIN SystemNote` cartesian product timeouts (Pitfall 11).
     - `SAFE-SCH-001`: Mandatory `mainline` filter predicates on transaction queries to prevent amount inflation.

## 4. SuiteScript Unit Testing Standards (@oracle/suitecloud-unit-testing)

1. **Official Unit Testing Mocking**:
   - When authoring complex SuiteScript 2.1 scripts (Map/Reduce, UserEvent, Suitelet, RESTlet), adhere to Oracle's official unit testing standard using `@oracle/suitecloud-unit-testing` with Jest or Vitest.
2. **Local Isolation**:
   - Always mock NetSuite native modules (`N/record`, `N/search`, `N/query`, `N/log`, `N/runtime`) with official stubs so business logic can be thoroughly verified locally before uploading to NetSuite File Cabinet.
