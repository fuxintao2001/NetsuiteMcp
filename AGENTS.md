# NetSuite MCP & SuiteCloud AI Engineering Directives (AGENTS.md)

> 🤖 **Role & Purpose**: This document provides mandatory execution directives for AI coding agents. It instructs AI agents on how to write, refactor, inspect, and deploy code in this repository and client NetSuite workspaces, strictly adhering to Oracle authoritative documentation and Antigravity Agent Skills.

---

## 👑 1. Official Documentation Absolute Priority (官方权威文档最高效力)

AI agents must unconditionally enforce a **Strict Zero Hallucination** policy:

1. **Hierarchy of Authoritative Truth**:
   - **Tier 1 (Authoritative Standard)**: Oracle NetSuite Official Documentation (Help Center, SuiteAnswers, Records Catalog, SuiteScript 2.1 API Reference, SAFE Guide 2025.2). This unconditionally supersedes third-party forum posts, outdated tutorials, and LLM intuition.
   - **Tier 2 (Account Live Schema)**: Real-time metadata retrieved directly from the active NetSuite account via `ns_getSuiteQLMetadata`, `netsuite_get_record_definition`, or `netsuite_inspect_record`.
   - **Tier 3 (Curated Agent Skills)**: Antigravity Skills located at `~/.gemini/config/skills/`.
   - **Tier 4 (LLM Parametric Knowledge)**: General training knowledge — MUST always be verified against Tier 1/2 before proposing code changes.
2. **Strict Zero Hallucination**:
   - NEVER fabricate non-existent tables or field IDs (e.g., `transaction.createdfrom`, `item.recordtype`, `LotNumberedAssemblyItemLocations`).
   - Every technical proposal or schema reference should cite its official source (`📖 Official Source: [...]`).

---

## 📚 2. On-Demand Skills & Documentation Routing Matrix (技能与文档按需检索路由)

When developing or refactoring code in specific domains, the AI agent **MUST proactively read the corresponding skill or documentation** via `view_file` on demand:

| Development Domain | On-Demand Target Path | Key Engineering Directives & Standards |
|:---|:---|:---|
| **SuiteScript 2.1 & SAFE Guide Review** | `~/.gemini/config/skills/netsuite-sdf-safe-guide/SKILL.md` | Enforce 12 SAFE principles, 14 script types, governance budgets, `N/query` over `N/search`, and 140+ pitfalls. Never load records in loops; use Map/Reduce for bulk processing. |
| **SuiteScript Records & Fields Schema** | `~/.gemini/config/skills/netsuite-suitescript-records-reference/SKILL.md`<br>Resource: `netsuite://records/reference` | Lookup exact field IDs, sublists, mandatory fields, and search filters across all 272 standard records. Zero guesswork on field names. |
| **SuiteQL Modeling & Anti-Slow-Query** | `~/.gemini/config/skills/netsuite-ai-connector-instructions/SKILL.md`<br>Resource: `netsuite://queries/golden-templates` | Follow SuiteQL safety checklist: explicit column projections (no `SELECT *`), mandatory `mainline = 'F'`, pagination via `FETCH FIRST N ROWS ONLY`, driving index filters. |
| **SuiteScript 1.0 → 2.1 Modernization** | `~/.gemini/config/skills/netsuite-suitescript-upgrade/SKILL.md` | 125+ API mappings, 34 object conversions, modern ES6+ features, breaking behavioral changes migration. |
| **OWASP & Secure Coding Standards** | `~/.gemini/config/skills/netsuite-owasp-secure-coding/SKILL.md` | Context-aware output encoding, SQL injection prevention, CSP headers, credential protection, parameter sanitization. |
| **Financial Operations & Reporting** | `~/.gemini/config/skills/netsuite-finance-analyst/SKILL.md` | Accounting periods, multi-book, multi-currency, GL impact validation, balance sheet, and cash flow logic. |
| **SDF Roles & Permissions Config** | `~/.gemini/config/skills/netsuite-sdf-roles-and-permissions/SKILL.md` | Role permission XML (`customrole*`, `permkey`, `permlevel`), least-privilege role design, SDF object deployment. |
| **UIF SPA Component Development** | `~/.gemini/config/skills/netsuite-uif-spa-reference/SKILL.md` | Modern NetSuite UIF SPA development, `@uif-js/core` and `@uif-js/component` APIs and hooks. |

---

## 🧼 3. Code Craftsmanship & Anti-Compatibility Bloat (代码重构与反伪兼容铁律)

When writing, debugging, or refactoring code (SuiteScript, TypeScript, JavaScript, SQL), AI agents must strictly adhere to the **Single Authoritative Implementation** principle:

1. **Clean Replacement, Never Dual-Track (单一正解彻底替换，严禁双轨兼容)**:
   - ❌ **PROHIBITED**: If an earlier implementation fails or throws errors, wrapping the new attempt in `try { newWay(); } catch (e) { oldWay(); }` to "support both ways".
   - ❌ **PROHIBITED**: Adding dual-branch sniffing `if (supportsNewWay) { ... } else { ... }` when the previous way was defective or obsolete.
   - ❌ **PROHIBITED**: Chaining speculative fallbacks due to unverified schemas (e.g., `rec.getValue('field_v2') || rec.getValue('field_v1')`).
   - ✅ **MANDATE**: Locate the root cause via official schema or documentation. Determine the single officially sanctioned correct approach, and execute a **100% clean, total replacement**.
2. **Immediate Physical Dead-Code Elimination (彻底清除死代码)**:
   - When superseding an outdated implementation, immediately and physically delete obsolete functions, dead variables, deprecated arguments, and legacy logic.
   - NEVER leave dead code behind as comments or "just in case" fallbacks. Zero tolerance for defensive code bloat.
3. **Root Cause Resolution Over Defensive Masking (直面根因，拒绝防御掩盖)**:
   - Errors signify invalid assumptions or schema mismatches. Confront errors directly, identify the exact defect (e.g., wrong field ID, API versioning, permission deficit), and fix it definitively at the source.
4. **Current-State-Only Explanations (Zero Version Iteration Narrative)**:
   - ❌ **PROHIBITED**: Narrating code evolution history, migration trajectories, or past vs present comparisons (strictly prohibit narratives like "in the previous version it was X, now we upgraded to Y", "previously we used A, now refactored to B", "compared to earlier versions...").
   - ❌ **PROHIBITED**: Inserting changelog commentary, historical diff reflections, or superseded implementation post-mortems into code comments, technical responses, or documentation.
   - ✅ **MANDATE**: In all code comments, technical responses, and documentation, **describe ONLY the current, definitive state and logic of the latest code**. Treat the current codebase as the sole authoritative, standalone implementation. Explain directly its latest architecture, data flow, parameter semantics, and business logic, completely excising all version iteration narratives.

---

## 🛡️ 4. Runtime Guardrails & Operational Gates (运行时安全门禁)

1. **Reconnaissance First & Error-Driven Self-Healing**:
   - For unverified custom records (`customrecord_*`) or custom fields (`custbody_*`), always call `ns_getSuiteQLMetadata` or `netsuite_get_record_definition` before querying.
   - On syntax or validation errors (`suiteqlGuard`), parse the structured diagnostic response, directly fix the query, and re-execute without blind retries.
2. **Environment Lock & Write Protection**:
   - **Record Mutations (`ns_createRecord`, `ns_updateRecord`)**: Strictly blocked in Production accounts; allowed only in Sandbox/Test (`_SB`, `TSTDRV`).
   - **Code Deployment (`netsuite_suitecloud_upload`)**: Display an interactive confirmation card (`ask_question`) showing only the file's absolute path and choices `接受` / `拒绝` prior to uploading.
3. **Permission Hard-Stop**:
   - On authorization or permission errors (`INSUFFICIENT_PERMISSION`, 403 Forbidden, `Permission Violation`), immediately halt tool execution. Never simulate fake data. Report the failed record type and required permission configuration.
4. **Adaptive Communication & English Code Standards**:
   - Adapt conversational explanations, summaries, and interactive messages to the user's language (default to Simplified Chinese if prompted in Chinese).
   - Keep all code symbols, SQL keywords, table names, field IDs, and API syntax strictly in standard English.
   - **Current-State-Only Communication**: Focus solely on describing the latest codebase and logic; never narrate historical version changes, diffs, or migration trajectories.
   - Git commit messages pushed to remote must be in Simplified Chinese.

---

## ⚙️ 5. Antigravity Native Customization Architecture (.agents/)

This workspace adheres strictly to the official Google Antigravity Customization Architecture (`agy-customizations`):

- **Lifecycle Hooks ([`.agents/hooks.json`](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/hooks.json))**:
  - `PreToolUse`: Validates syntax and blocks credential leaks prior to SuiteCloud uploads (`scripts/pre-upload-check.js`).
  - `PostToolUse`: Runs automated code formatting and SAFE Guide offline linter (`scripts/suitescript-safe-check.js`) after code modifications.
- **Modular Directory Rules ([`.agents/rules/`](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules))**:
  - [Fast-Path Routing](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/fast-path-routing.md): Standard core tables 1-turn direct execution.
  - [SuiteQL Guardrails](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/suiteql-guardrails.md): 7 golden SQL defense rules.
  - [SAFE Guide Standards](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/safe-guide-standards.md): SAFE Guide 2025.2 & OWASP secure coding directives.
  - [Environment Locks](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/environment-locks.md): Production write lockout & upload card gates.
  - [Generative UI](file:///Users/fuxintao/WebstormProjects/NetsuiteMcp/.agents/rules/generative-ui.md): Antigravity Generative UI styling, CSS theme variables, and `<agent-embed>` directives.

