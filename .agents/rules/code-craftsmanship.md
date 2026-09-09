# NetSuite Code Craftsmanship & Anti-Compatibility Bloat (反伪兼容铁律)

> 🧼 **Engineering Directives**: Strictly enforce the **Single Authoritative Implementation** principle across SuiteScript, TypeScript, JavaScript, and SQL. Zero tolerance for defensive compatibility bloat.

---

## 1. Clean Replacement, Never Dual-Track (单一正解彻底替换，严禁双轨兼容)

- ❌ **PROHIBITED**: If an earlier implementation fails or throws errors, wrapping the new attempt in `try { newWay(); } catch (e) { oldWay(); }` to "support both ways".
- ❌ **PROHIBITED**: Adding dual-branch sniffing `if (supportsNewWay) { ... } else { ... }` when the previous way was defective or obsolete (unless multi-environment backward compatibility is explicitly instructed by the user).
- ❌ **PROHIBITED**: Chaining speculative fallbacks due to unverified schemas (e.g. `rec.getValue('field_v2') || rec.getValue('field_v1')`).
- ✅ **MANDATE**: Locate the root cause via official schema or documentation. Determine the single officially sanctioned correct approach, and execute a **100% clean, total replacement**.

---

## 2. Immediate Physical Dead-Code Elimination (彻底清除死代码)

- When superseding an outdated implementation, immediately and physically delete obsolete functions, dead variables, deprecated arguments, and legacy logic.
- NEVER leave dead code behind as comments or "just in case" fallbacks. Zero tolerance for defensive code bloat.
- Adhere strictly to the KISS principle: keep the codebase minimal, explicit, and free of ambiguity.

---

## 3. Root Cause Resolution Over Defensive Masking (直面根因，拒绝防御掩盖)

- Errors signify invalid assumptions, schema mismatches, or API deprecations.
- Confront errors directly, identify the exact defect (e.g. wrong field ID, API versioning, permission deficit, type mismatch), and fix it definitively at the source.
- Never mask unverified failures with defensive try-catch traps or silent fallback branching.

---

## 4. Current-State-Only Explanations (Zero Version Iteration Narrative)

- ❌ **PROHIBITED**: Narrating code evolution history, migration trajectories, or past vs present comparisons (strictly prohibit narratives like "in the previous version it was X, now we upgraded to Y", "previously we used A, now refactored to B", "compared to earlier versions...").
- ❌ **PROHIBITED**: Inserting changelog commentary, historical diff reflections, or superseded implementation post-mortems into code comments, technical responses, or documentation.
- ✅ **MANDATE**: In all code comments, technical responses, and documentation, **describe ONLY the current, definitive state and logic of the latest code**. Treat the current codebase as the sole authoritative, standalone implementation. Explain directly its latest architecture, data flow, parameter semantics, and business logic, completely excising all version iteration narratives.
