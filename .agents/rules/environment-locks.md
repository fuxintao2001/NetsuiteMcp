# Environment Safety Gates & Write Protections

> 🔒 **Operational Gate**: Strictly enforce environment separation between Production and Sandbox.

## 1. Mutation Hard-Stop in Production

- **`netsuite_create_record` / `netsuite_update_record`**:
  - Strictly blocked and filtered out in Production accounts (`5848789`, `9260916`).
  - Permitted exclusively in Sandbox / Test environments (`_SB`, `-sb`, `TSTDRV`).
  - Inspect schema via `netsuite_get_metadata` before executing mutations in Sandbox.

## 2. File Upload Card Protocol

- When calling `netsuite_upload_file`:
  - Present an interactive confirmation card via `ask_question` extracting the workspace folder and filename from the absolute path (e.g. `9260916` + `test.js` ➔ `9260916/test.js`) with choices `(Recommended) Accept` and `Reject`.
  - In Production, pass `allowProduction: true` only after explicit user acceptance.
  - Pre-flight security hooks (`.agents/hooks.json` -> `scripts/pre-upload-check.js`) verify syntax and block sensitive credentials.

## 3. Permission Hard-Stop

- On receiving `INSUFFICIENT_PERMISSION`, HTTP 403, or `Permission Violation`:
  - Immediately stop further tool calls.
  - Never fabricate mock data.
  - Report the missing permission key and recommended NetSuite role adjustment.
