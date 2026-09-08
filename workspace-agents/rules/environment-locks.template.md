# Environment Safety Gates & Write Protections

> 🔒 **Environment Lock**: Account `{{ACCOUNT_ID}}` | Type: **{{ENV_TYPE}}** | Write Ops: {{WRITE_OPS_BADGE}}

## 1. Environment Mutation Policy

{{WRITE_TOOLS_TABLE}}

## 2. Code Deployment & Card Protocol

{{WRITE_OPS_SECTION}}

## 3. Permission Hard-Stop

- On receiving `INSUFFICIENT_PERMISSION`, HTTP 403, or `Permission Violation`:
  - Immediately stop further tool calls.
  - Never fabricate mock data.
  - Report the missing permission key and recommended NetSuite role adjustment.
