# Oracle NetSuite SAFE Guide & OWASP Standards

> 📖 **Authoritative Reference**: SAFE Guide 2025.2 & OWASP Top 10 Secure Coding.

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
