# NetSuite MCP Plugin — Authoritative AI Engineering Charter (AGENTS.md)

> 🤖 **Role & Scope**: This document is the authoritative engineering charter for developing, maintaining, and refactoring the **NetSuite MCP Antigravity Plugin** (`@suiteinsider/netsuite-mcp`).
>
> 🎯 **Core Objective**: Maintain a clean, zero-bloat TypeScript/Node.js MCP server and native Antigravity Plugin bundle (`plugin.json`, `mcp_config.json`, `rules/AGENTS.md`, and `skills/`), enforce runtime safety guards (`suiteqlGuard`), and manage Redis caching and Redlock distributed locks.

---

## 🧼 1. Code Craftsmanship & Anti-Compatibility Bloat

1. **Clean Replacement, Never Dual-Track**:
   - ❌ **PROHIBITED**: Wrapping new logic in `try { newWay(); } catch (e) { oldWay(); }` or adding feature-sniffing branches for backward compatibility.
   - ✅ **MANDATE**: Verify the single authoritative specification and execute a **100% clean replacement**.
2. **Immediate Physical Dead-Code Elimination**:
   - Deprecated implementations, obsolete scripts, and unused parameters must be **physically deleted from the source code immediately**.
3. **Current-State-Only Explanations**:
   - Describe ONLY the current, definitive state and logic of the latest codebase.

---

## 🛠️ 2. Plugin & Server Directory Structure

```text
/Users/fuxintao/WebstormProjects/NetsuiteMcp/
├── plugin.json                # Antigravity Plugin manifest
├── mcp_config.json            # Multi-account NetSuite MCP server definitions
├── assets/
│   └── logo.svg               # Plugin icon
├── rules/
│   └── AGENTS.md              # Consolidated NetSuite engineering rules loaded when plugin is active
├── skills/                    # 12 bundled skills (10 Oracle NetSuite domain skills + 2 NetSuite engineering discipline skills)
├── src/
│   ├── index.ts               # Server entrypoint: CLI argument parsing, Stdio transport initialization
│   ├── mcp/                   # NetSuite low-level communication layer (SuiteQL, REST, ConcurrencyLimiter(5))
│   ├── handlers/              # 8 core tools (+ 2 Sandbox mutation tools + 1 official gateway)
│   ├── oauth/                 # OAuth 2.0 PKCE authentication subsystem
│   ├── cache/                 # Redis cache & Redlock distributed locks
│   └── utils/                 # Runtime guardrails: suiteqlGuard, environment isolation, contextSlimmer
└── scripts/                   # Bulk auth, official skills sync check, and Redis cache utilities
```

### Language Standards & Type Safety

- **Runtime Environment**: Node.js ≥ 18, TypeScript strict mode (`strict: true`).
- **ESM Module Standard**: All relative imports must explicitly include the `.js` extension (e.g., `import { foo } from "./bar.js"`).
- **Zero `any` Policy**: Using `any` in source files is strictly prohibited. Use `unknown` for untrusted data and narrow types safely via Zod schemas or custom Type Guards.

---

## 🛡️ 3. NetSuite Gateway & Security Guardrails

1. **SuiteQL Runtime Guard (`src/utils/suiteqlGuard.ts`)**:
   - Guarantees 100% transparent query execution with zero implicit dialect rewriting.
   - Statically blocks `SELECT *`, missing `mainline` filters on `transactionline`, `JOIN systemnote` (SAFE Pitfall 11), `item.recordtype`, and `transaction.createdfrom`.
2. **Dual-Gate Production Write Protection (`src/utils/environment.ts`)**:
   - Determined solely by `isSandboxAccount(accountId)`.
   - `netsuite_create_record` and `netsuite_update_record` are physically filtered out and blocked in Production environments.
   - `netsuite_upload_file` requires explicit `allowProduction: true` when targeting a Production account.

---

## 🚦 4. Quality Gates & Verification Pipeline

After any code change, execute the verification pipeline and ensure 0 errors:

```bash
# 1. Strict TypeScript compilation & type checking (0 errors)
npm run typecheck

# 2. Biome code formatting & static lint analysis (0 errors, 0 warnings)
npm run lint

# 3. Build production bundle (dist/)
npm run build
```
