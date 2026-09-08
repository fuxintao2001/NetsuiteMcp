# Environment Safety Gates & Write Protections

> 🔒 **Operational Gate**: Strictly enforce environment separation between Production and Sandbox.

## 1. Mutation Hard-Stop in Production

- **`ns_createRecord` / `ns_updateRecord`**:
  - Strictly blocked in Production accounts (`5848789`, `9260916`).
  - Permitted only in Sandbox (`_SB`, `TSTDRV`).
  - Reconnaissance must be executed via `ns_getRecordTypeMetadata` before mutation in Sandbox.

## 2. Code Deployment Card Protocol

- When calling `netsuite_suitecloud_upload`:
  - Must present an interactive card via `ask_question` with only the file's absolute path and choices `接受` / `拒绝`.
  - In Production, requires `allowProduction: true` to bypass server-side write guard.
  - Pre-flight security hooks (`.agents/hooks.json` -> `scripts/pre-upload-check.js`) will verify syntax and block sensitive credentials.

## 3. Permission Hard-Stop

- On receiving `INSUFFICIENT_PERMISSION`, HTTP 403, or `Permission Violation`:
  - Immediately stop further tool calls.
  - Never fabricate mock data.
  - Report the missing permission key and recommended NetSuite role adjustment.
