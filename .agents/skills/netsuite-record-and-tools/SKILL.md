---
name: netsuite-record-and-tools
description: >-
  NetSuite MCP 工具和 Record 操作参考。包含全部 MCP Tools（本地工具 netsuite_ 前缀 + 
  代理工具 ns_ 前缀）的参数说明、Record CRUD SOP（元数据验证→构建→执行→深度链接）、
  写操作环境限制（仅 Sandbox）、MCP Resources URI 列表，以及 SuiteCloud Agent Skills 使用指引。
  在操作 NetSuite Record 或查找工具用法时激活此 skill。
---

# NetSuite MCP Tools & Record Operations Reference

This skill provides the complete MCP Tools reference and Record operations SOP.

---

## 🛠️ MCP Tools Reference

### Local Tools (`netsuite_` prefix)

| Tool | Purpose | Key Args |
|:---|:---|:---|
| `netsuite_authenticate` | Start OAuth 2.0 PKCE authentication flow | `accountId` (optional), `clientId` (optional). Falls back to env vars. |
| `netsuite_logout` | Clear NetSuite authentication session | *(none)* |
| `netsuite_status` | Show diagnostic info: auth state, token expiry, cache stats, env type | *(none)* |
| `netsuite_refresh_cache` | Force clear L1/L2 caches and REST session cache | `tableName` (optional, for single table) |
| `netsuite_get_record_link` | Generate a direct browser URL to view a record in NetSuite | `recordId` (required), `recordType` (optional), `accountId` (optional), `rectype` (optional integer) |
| `netsuite_run_parallel_queries` | Concurrently execute multiple SuiteQL queries (max 5) | `queries` (array of strings, required) |

### NetSuite Proxied Tools (`ns_` prefix)

| Tool | Purpose | Key Args |
|:---|:---|:---|
| `ns_getRecord` | Retrieve a specific record | `recordType`, `recordId` (required); `fields` (optional, comma-separated subset) |
| `ns_getRecordTypeMetadata` | Get record type schema and field constraints | `recordType` (optional) |
| `ns_createRecord` | Create a new record (**Sandbox only**) | `recordType`, `data` (stringified JSON) |
| `ns_updateRecord` | Update an existing record (**Sandbox only**) | `recordType`, `recordId`, `data` (stringified JSON) |
| `ns_runReport` | Run a NetSuite financial/functional report | `reportId`, `dateTo` (required); + optional filters |
| `ns_listAllReports` | Retrieve a list of all available reports | *(none)* |
| `ns_getSubsidiaries` | Retrieve the list of subsidiaries | *(none)* |
| `ns_getAccountingBooks` | Retrieve the list of accounting books | *(none)* |
| `ns_getAccountingContexts` | Retrieve the list of accounting contexts | *(none)* |
| `ns_getNexusIds` | Retrieve the list of tax nexuses | *(none)* |
| `ns_runCustomSuiteQL` | Execute a custom SuiteQL query string | `sqlQuery` (required), `pageSize`, `pageIndex` |
| `ns_getSuiteQLMetadata` | Retrieve schema/metadata for a SuiteQL table | `recordType` (optional) |

---

## 📂 MCP Resources Reference

| URI | Description |
|:---|:---|
| `netsuite://guides/suiteql` | Complete SuiteQL syntax, Oracle SQL subset rules, and query reference guide (including ScriptNote log queries) |
| `netsuite://skills/<skill-name>` | Official NetSuite SuiteCloud Agent Skills |

---

## 📋 Record Operations SOP

### Mandatory Workflow

| Phase | Rule |
|:---|:---|
| **Before** | MUST call `ns_getRecordTypeMetadata` to verify JSON Schema constraints |
| **Build Params** | Sublist arrays must conform to metadata; IDs, booleans must match internal types |
| **After** | Use `netsuite_get_record_link` to generate UI link (auto-appended by `ns_getRecord`) |
| **Custom Records** | Pass `customrecord_xxx` as `recordType` — no numeric `rectype` needed |
| **Field Selection** | Use `fields` param on `ns_getRecord` to fetch only needed fields for performance |

### Write Operations

> [!IMPORTANT]
> Write operations (`ns_createRecord`, `ns_updateRecord`) are strictly disabled in **Production environments**. They are **fully enabled in Sandbox/Test environments** (account IDs containing `_SB` or starting with `TSTDRV`). Environment detection is centralized in `src/utils/environment.ts` via `isSandboxAccount()`.

**Write Workflow (Sandbox only):**
1. `ns_getRecordTypeMetadata` → verify record schema and field constraints
2. For reference fields → use SuiteQL to look up valid IDs
3. Build `data` as **stringified JSON** matching the schema exactly
4. Call `ns_createRecord` or `ns_updateRecord`
5. Verify result → `netsuite_get_record_link` for UI confirmation

---

## 🧩 SuiteCloud Agent Skills

This MCP server exposes official Oracle NetSuite SuiteCloud Agent Skills as MCP resources under `netsuite://skills/<skill-name>`.

| Skill | Domain |
|:---|:---|
| `netsuite-ai-connector-instructions` | AI Connector setup, tool selection, SuiteQL safety checklist |
| `netsuite-finance-analyst` | Financial analysis and reporting |
| `netsuite-owasp-secure-coding` | OWASP Top 10 security for SuiteScript |
| `netsuite-sdf-project-documentation` | SDF project structure and documentation |
| `netsuite-sdf-roles-and-permissions` | Role/permission configuration via SDF |
| `netsuite-sdf-safe-guide` | SDF deployment safety guidelines (SAFE Guide) |
| `netsuite-suitescript-learning` | SuiteScript learning resources |
| `netsuite-suitescript-records-reference` | Record type API reference (272 record types) |
| `netsuite-suitescript-upgrade` | SuiteScript 1.0 → 2.1 migration guide |
| `netsuite-uif-spa-reference` | UIF SPA (SuiteApp) development reference |

**Usage Rules:**
- Before writing SuiteScript or SDF configs → check the corresponding skill resource
- OWASP guidelines → mandatory for RESTlets, Suitelets, Client Scripts (input validation, output encoding)
- Financial analysis → consult `netsuite-finance-analyst` for reporting best practices
- **Tool Selection Strategy:** `PRIORITY 1 → Reports` | `PRIORITY 2 → Saved Searches` | `PRIORITY 3 → Records` | `PRIORITY 4 → SuiteQL (Last Resort)`
