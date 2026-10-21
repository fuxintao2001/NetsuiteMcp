# Antigravity Generative UI Directives for NetSuite Data

> 🎨 **Authoritative Reference**: Antigravity Official `generative_ui` Skill & NetSuite Component Library.

## 1. Authoritative References & MCP Resources

- `netsuite://templates/generative-ui` — **Antigravity Generative UI NetSuite Visual Component Library**: Production-ready HTML/Tailwind templates (metric summary card, transaction flow / lineage graph, multi-location stock heatmap).

---

## 2. When to Trigger Generative UI

Trigger custom, rich, interactive HTML widgets or artifacts when the user requests:
- **Financial Visualizations**: Income statement variance waterfalls, balance sheet comparisons, cash flow graphs.
- **Transaction Lineage**: Interactive directed graphs showing Quote -> Sales Order -> Fulfillment -> Invoice -> Payment.
- **Multi-Location Inventory**: Stock heatmaps across warehouses, reorder point alerts, and inventory turnover.
- **Audit Trails & System Logs**: Execution timelines, script error frequency distributions.

---

## 3. Technical Constraints & Design System Theming

1. **Tailwind CSS Inclusion**:
   - MUST include the official allowlisted Tailwind script in `<head>`:
     ```html
     <script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>
     ```
   - All external CDNs are blocked by CSP. Do NOT link external stylesheets or font CDNs.

2. **Design System Semantic CSS Variables**:
   - Never hardcode fixed dark/light colors (e.g. `bg-slate-900`, `text-black`).
   - Use host CSS variables to ensure automatic dark/light theme switching:
     - Surfaces: `bg-[var(--card)]`, `bg-[var(--background)]`, `bg-[var(--sidebar)]`
     - Borders: `border-[var(--border)]`
     - Text: `text-[var(--foreground)]`, `text-[var(--muted-foreground)]`, `text-[var(--placeholder)]`
     - Accents: `bg-[var(--primary)]`, `text-[var(--primary-foreground)]`, `bg-[var(--accent)]`
   - NEVER declare local fallback overrides on `:root` in `<style>`.

3. **Inline vs Standalone Placement**:
   - **Inline Embed (`<agent-embed>`)**: For compact widgets (< 500px tall) like mini metric cards or simple status charts:
     - Set `<body class="bg-transparent text-[var(--foreground)] p-4">`
     - Wrap in a card container: `<div class="bg-[var(--card)] border border-[var(--border)] rounded-xl p-4 shadow-sm">`
     - Embed in chat response: `<agent-embed src="file:///<artifact_path>/widget.html"></agent-embed>`
   - **Standalone Artifact**: For complex full-page dashboards, multi-tab financial reports, or large graph canvases. Reference the artifact link directly.

---

## 4. Companion Rules & Authoritative References

- **Master Charter**: [AGENTS.md](file://{{PROJECT_PATH}}/AGENTS.md)
- **Fast-Path Routing**: [Fast-Path Routing](file://{{PROJECT_PATH}}/.agents/rules/fast-path-routing.md)
- **SuiteQL Defense**: [SuiteQL Guardrails](file://{{PROJECT_PATH}}/.agents/rules/suiteql-guardrails.md)
- **SAFE Guide**: [SAFE Guide Standards](file://{{PROJECT_PATH}}/.agents/rules/safe-guide-standards.md)
- **Environment Locks**: [Environment Locks](file://{{PROJECT_PATH}}/.agents/rules/environment-locks.md)
