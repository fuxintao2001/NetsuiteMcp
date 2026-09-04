# NetSuite MCP Server — AI Developer Guide

This repository contains the source code for the **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`). It exposes NetSuite functionalities to AI agents over the Model Context Protocol (MCP).

**Tech Stack:** TypeScript (strict) · Node.js ≥ 18 (ESM) · OAuth 2.0 PKCE · Dual-layer cache (L1 in-memory + L2 file system)

---

## ⚙️ Development & Testing Commands

| Command | Description |
|---|---|
| `npm run build` | Clean build (`rimraf dist && tsc`) |
| `npm run lint` | Run Biome linter & formatter check (`biome check src`) |
| `npm test` | Run all Vitest unit tests |
| `npm run dev` | Start the server in development mode (via `tsx`) |
| `npm run fetch-skills` | Download latest Oracle SuiteCloud Agent Skills |
| `npm run sync-agents` | Sync AGENTS.md template to all client workspaces (`--dry-run` to preview) |
| `npm run score` | Run 360° architecture & on-demand benchmark scoring suite |

---

## 📚 On-Demand Skills & Knowledge Routing (渐进式按需加载)

Detailed domain knowledge is decoupled into Antigravity Skills (`~/.gemini/config/skills/`) and MCP Resources (`netsuite://...`). **Read via `view_file` on demand only when working in that specific domain**:

| Domain Scenario | On-Demand Target | Primary Purpose |
|:---|:---|:---|
| **AI Connector SOP & SuiteQL** | `netsuite-ai-connector-instructions`<br>`netsuite://queries/golden-templates` | Tool selection hierarchy, SuiteQL safety checklist, number & link formatting |
| **SAFE Guide & SuiteScript 2.1** | `netsuite-sdf-safe-guide` | SAFE Guide 12 principles, 14 script types, governance, 140+ pitfalls |
| **272 Records & Fields Dictionary** | `netsuite-suitescript-records-reference`<br>`netsuite://records/reference` | Official standard record types, field IDs, required fields, and search attributes |
| **Financial Analysis & Period-Close**| `netsuite-finance-analyst` | Financial statements, period-close, variance review, executive reporting |
| **SuiteScript 1.0 → 2.1 Upgrade** | `netsuite-suitescript-upgrade` | 125+ API mappings, 34 object conversions, breaking behavioral changes |
| **OWASP & Secure Coding** | `netsuite-owasp-secure-coding` | Injection prevention, encoding, CSP, SuiteScript API hardening |
| **UIF SPA Components** | `netsuite-uif-spa-reference` | `@uif-js/core` and `@uif-js/component` component development |
| **SDF Roles & Permissions** | `netsuite-sdf-roles-and-permissions` | Role permission XML configuration (`customrole*`, `permkey`, `permlevel`) |

---

## 🔒 Critical Execution Rules (Always Active)

### 1. 👑 Official Documentation Absolute Highest Priority
- **Oracle NetSuite Official Authoritative Documentation** (Help Center, SuiteAnswers, Records Catalog, SAFE Guide 2025.2) unconditionally supersedes all third-party habits and LLM intuition.
- **Strict Zero Hallucination**: NEVER fabricate non-existent tables or fields (e.g. `LotNumberedAssemblyItemLocations`, `transaction.createdfrom`, or `item.recordtype`). Every technical recommendation MUST cite its official source (`📖 官方出处：[...]`).

### 2. Reconnaissance First & Error-Driven Self-Healing
- Always call `ns_getSuiteQLMetadata` or `netsuite_get_record_definition` when record schema or columns are unverified.
- Runtime validators (`suiteqlGuard.ts`) strictly block invalid syntax (`SELECT *`, `LIMIT/OFFSET`, missing `mainline`, unindexed table scans) and return structured diagnostic guidance. On validation or syntax errors, parse the diagnostic response, directly fix the query, and execute without blind retries.

### 3. Environment Lock & Write Protection
- **Record Write Operations (`ns_createRecord`, `ns_updateRecord`)**: Strictly disabled in Production environments; enabled in Sandbox/Test (`_SB`, `TSTDRV`). Managed via `src/utils/environment.ts`.
- **Code & Asset Uploads (`netsuite_suitecloud_upload`)**: Direct uploads to Production are blocked unless explicit user authorization and `allowProduction: true` are provided.

### 4. Permission Hard-Stop & Zero-Hallucination
- On NetSuite authorization/permission errors (`INSUFFICIENT_PERMISSION`, 403 Forbidden, `Permission Violation`), immediately cease all further tasks and tool calls. Never simulate fake data. Report the exact failed record type/table name and specify the required NetSuite role permission configuration.
