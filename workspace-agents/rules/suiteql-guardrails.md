# SuiteQL Architectural Guardrails (Zero-Shot Pass Standards)

> 🛡️ Strictly enforce these 7 golden rules to achieve 100% first-pass execution through `suiteqlGuard`:

1. **Zero Wildcards**: NEVER use `SELECT *`; ALWAYS specify explicit column names.
2. **Display Value Mapping**: To display friendly names of foreign entities, items, or statuses, use `BUILTIN.DF(field)` (e.g. `BUILTIN.DF(tl.item) AS item_name`) instead of costly multi-table JOINs.
3. **Mainline & Taxline Discipline**:
   - Line-item details: ALWAYS include `tl.mainline = 'F' AND tl.taxline = 'F'`.
   - Header summary only: ALWAYS include `tl.mainline = 'T'`.
4. **Downstream Transaction Lineage**:
   - Link downstream transactions via `transactionline.createdfrom = :upstreamId`; NEVER use `transaction.createdfrom` (column does not exist).
5. **No SystemNote JOINs**:
   - NEVER JOIN `SystemNote` directly with transactional tables (causes Cartesian explosion and 45s+ timeouts). Query `SystemNote` as a standalone table or call `netsuite_get_system_notes`.
6. **Pagination & Date Standards**:
   - ALWAYS paginate via `FETCH FIRST N ROWS ONLY` or `ROWNUM <= N` (NEVER MySQL `LIMIT / OFFSET`).
   - ALWAYS cast date literals using `TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD')`.
7. **Driving Index Requirement**:
   - Queries against large tables MUST filter on at least one indexed column: `type`, `trandate`, `id`, `tranid`, `entity`, `subsidiary`.
