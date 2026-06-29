# NetSuite MCP Server — AI Developer Guide

This repository contains the source code for the **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`). It exposes NetSuite functionalities to AI agents over the Model Context Protocol (MCP).

**Tech Stack:** TypeScript (strict) · Node.js ≥ 18 (ESM) · OAuth 2.0 PKCE · Dual-layer cache (L1 in-memory + L2 file system)

---

## 📚 Skills Index

Detailed knowledge is organized into Antigravity Skills. Read the corresponding skill when working in that area.

### Project Skills (`.agents/skills/`)

| Skill | When to Use |
|:---|:---|
| `netsuite-mcp-dev-guide` | Modifying `src/` source code — architecture, design patterns, error handling, DI, extensibility, auth lifecycle, caching |
| `netsuite-suiteql-mastery` | Writing or debugging any SuiteQL query — syntax rules, BUILTIN functions, mandatory workflow SOP, parallel query requirements |
| `netsuite-record-and-tools` | Operating on NetSuite Records or looking up MCP tool usage — full tools reference, Record CRUD SOP, MCP Resources, SuiteCloud Agent Skills |

### Oracle SuiteCloud Agent Skills (`skills/`)

| Skill | Domain |
|:---|:---|
| `netsuite-ai-connector-instructions` | AI Connector guardrails, tool selection order, SuiteQL safety checklist, output formatting |
| `netsuite-finance-analyst` | Financial analysis, period-close, variance review, executive reporting |
| `netsuite-owasp-secure-coding` | OWASP Top 10 for SuiteScript — injection, encoding, CSP, API hardening |
| `netsuite-sdf-project-documentation` | SDF project documentation generation (README, architecture diagrams, runbooks) |
| `netsuite-sdf-roles-and-permissions` | SDF role/permission XML configuration and validation |
| `netsuite-sdf-safe-guide` | SDF SAFE Guide — 12 principles, 14 script types, governance, security, 139+ pitfalls |
| `netsuite-suitescript-learning` | Interactive SuiteScript learning system (6 modes + SAFE Guide integration) |
| `netsuite-suitescript-records-reference` | SuiteScript record/field reference (272 record types) |
| `netsuite-suitescript-upgrade` | SuiteScript 1.0 → 2.1 migration (125+ API mappings, 34 object conversions) |
| `netsuite-uif-spa-reference` | UIF SPA component development (`@uif-js/core` + `@uif-js/component` API) |

---

## ⚙️ Development & Testing Commands

| Command | Description |
|---|---|
| `npm run build` | Clean build (`rimraf dist && tsc`) |
| `npm test` | Run all Jest tests |
| `npm run start` | Start the server in production mode (runs from `dist/`) |
| `npm run dev` | Start the server in development mode (via `tsx`) |
| `npm run fetch-skills` | Download latest Oracle SuiteCloud Agent Skills |
| `npm run sync-agents` | Sync AGENTS.md template to all client workspaces (`--dry-run` to preview) |

---

## 🔒 Critical Rules (Always Active)

### Write Operations Control

> [!IMPORTANT]
> Write operations (`ns_createRecord`, `ns_updateRecord`) are strictly disabled in **Production environments**. They are **fully enabled in Sandbox/Test environments** (account IDs containing `_SB` or starting with `TSTDRV`). Environment detection is centralized in `src/utils/environment.ts` via `isSandboxAccount()`.

### TypeScript & Naming Conventions

- `tsconfig.json` enforces `"strict": true`. All code must be fully typed.
- **Naming Prefix Protocol:**
  - `ns_` prefix: NetSuite-proxied tools (routed to NetSuite REST API).
  - `netsuite_` prefix: Local tools (handled entirely within the MCP server).

### Parallel Query Rule

> [!IMPORTANT]
> **🚨 Parallel Query Rule:** If you need to execute two or more independent SuiteQL queries, you **MUST** run them concurrently using `netsuite_run_parallel_queries`. **Directly calling `ns_runCustomSuiteQL` sequentially is strictly prohibited** unless a subsequent query depends on the output of a previous one.
