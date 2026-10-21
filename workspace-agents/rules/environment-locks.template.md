# Environment Safety Gates & Write Protections

> 🔒 **Environment Lock**: Account `{{ACCOUNT_ID}}` | Type: **{{ENV_TYPE}}** | Write Ops: {{WRITE_OPS_BADGE}}

## 1. Environment Mutation Policy

{{WRITE_TOOLS_TABLE}}

## 2. File Upload & Card Protocol

{{WRITE_OPS_SECTION}}

## 3. Permission Hard-Stop & Diagnostic Reference

- On receiving `INSUFFICIENT_PERMISSION`, HTTP 403, or `Permission Violation`:
  - Immediately stop further tool calls.
  - Never fabricate mock data.
  - Consult the official permissions dictionary via MCP resource `netsuite://reference/permissions`.
  - Report the missing permission key and recommended NetSuite role adjustment.

---

## 4. Companion Rules & Authoritative References

- **Master Charter**: [AGENTS.md](file://{{PROJECT_PATH}}/AGENTS.md)
- **Fast-Path Routing**: [Fast-Path Routing](file://{{PROJECT_PATH}}/.agents/rules/fast-path-routing.md)
- **SuiteQL Defense**: [SuiteQL Guardrails](file://{{PROJECT_PATH}}/.agents/rules/suiteql-guardrails.md)
- **SAFE Guide**: [SAFE Guide Standards](file://{{PROJECT_PATH}}/.agents/rules/safe-guide-standards.md)
- **Generative UI**: [Generative UI](file://{{PROJECT_PATH}}/.agents/rules/generative-ui.md)
