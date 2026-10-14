# Environment Safety Gates & Write Protections

> 🔒 **Operational Gate**: Strictly enforce environment separation between Production and Sandbox.

## 1. Mutation Hard-Stop in Production

- **`netsuite_create_record` / `netsuite_update_record`**:
  - Strictly blocked and filtered out in Production accounts (`5848789`, `9260916`).
  - Permitted exclusively in Sandbox / Test environments (`_SB`, `-sb`, `TSTDRV`).
  - Inspect schema via `netsuite_get_metadata` before executing mutations in Sandbox.

## 2. Code Deployment Card Protocol

- When calling `netsuite_deploy_script`:
  - Present an interactive confirmation card via `ask_question` showing only the file's absolute path and choices `Accept` and `Reject`.
  - In Production, pass `allowProduction: true` only after explicit user acceptance.
  - Pre-flight security hooks (`.agents/hooks.json` -> `scripts/pre-upload-check.js`) verify syntax and block sensitive credentials.

## 3. Permission Hard-Stop

- On receiving `INSUFFICIENT_PERMISSION`, HTTP 403, or `Permission Violation`:
  - Immediately stop further tool calls.
  - Never fabricate mock data.
  - Report the missing permission key and recommended NetSuite role adjustment.
