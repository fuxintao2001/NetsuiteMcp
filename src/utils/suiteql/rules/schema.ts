/**
 * NetSuite ERP Schema Invariants Rules.
 * Catches high-frequency schema hallucinations before execution.
 */

import type { SuiteQLRule } from "../types.js";

function findDuplicateProjectionAlias(projections: string[]): {
	duplicate: string;
	firstExpr: string;
	secondExpr: string;
} | null {
	const seen = new Map<string, string>();

	for (const proj of projections) {
		const asMatch = /\s+AS\s+([a-zA-Z0-9_]+)$/i.exec(proj);
		if (asMatch?.[1]) {
			const alias = asMatch[1].toLowerCase();
			const existing = seen.get(alias);
			if (existing) {
				return {
					duplicate: alias,
					firstExpr: existing,
					secondExpr: proj,
				};
			}
			seen.set(alias, proj);
			continue;
		}

		// Implicit column name from identifier: e.g. "t.id" -> "id"
		const identMatch = /^(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)$/i.exec(
			proj.trim(),
		);
		if (identMatch?.[1]) {
			const colName = identMatch[1].toLowerCase();
			const existing = seen.get(colName);
			if (existing) {
				return {
					duplicate: colName,
					firstExpr: existing,
					secondExpr: proj,
				};
			}
			seen.set(colName, proj);
		}
	}

	return null;
}

export const schemaRules: SuiteQLRule[] = [
	{
		id: "schema-item-no-recordtype",
		name: "Enforce item.itemtype Over recordtype",
		category: "schema",
		validate(ctx) {
			const itemAliases = new Set<string>();
			for (const [alias, table] of ctx.tableAliases.entries()) {
				if (table === "item") itemAliases.add(alias);
			}

			if (itemAliases.size > 0) {
				for (const alias of itemAliases) {
					const pattern = new RegExp(`\\b${alias}\\.recordtype\\b`, "i");
					if (pattern.test(ctx.maskedSql)) {
						return "Invalid Column on 'item' Table: The 'item' table in NetSuite does NOT have a 'recordtype' column. Use 'itemtype' ('Assembly', 'InvtPart', 'NonInvtPart', 'Service', etc.) and 'subtype' ('Sale', 'Purchase', 'Resale') instead.";
					}
				}
			}
			return null;
		},
	},
	{
		id: "schema-transaction-no-createdfrom",
		name: "Enforce createdfrom on transactionline",
		category: "schema",
		validate(ctx) {
			const tranAliases = new Set<string>();
			for (const [alias, table] of ctx.tableAliases.entries()) {
				if (table === "transaction") tranAliases.add(alias);
			}

			if (tranAliases.size > 0) {
				for (const alias of tranAliases) {
					const pattern = new RegExp(`\\b${alias}\\.createdfrom\\b`, "i");
					if (pattern.test(ctx.maskedSql)) {
						return "Invalid Field Location: 'createdfrom' exists exclusively on the 'transactionline' table (line items), NEVER on the 'transaction' header. To track upstream documents, JOIN transactionline tl ON tl.transaction = t.id and filter tl.createdfrom.";
					}
				}
			}
			return null;
		},
	},
	{
		id: "schema-unique-projection-aliases",
		name: "Require Unique Column Aliases in SELECT",
		category: "schema",
		validate(ctx) {
			const dup = findDuplicateProjectionAlias(ctx.projections);
			if (dup) {
				return `Duplicate column alias '${dup.duplicate}' detected in SELECT projection ('${dup.firstExpr}', '${dup.secondExpr}'). NetSuite SuiteQL requires unique column aliases. Please assign explicit aliases using AS (e.g. '${dup.firstExpr} AS ${dup.duplicate}_1, ${dup.secondExpr} AS ${dup.duplicate}_2').`;
			}
			return null;
		},
	},
	{
		id: "schema-pseudo-tables",
		name: "Replace Non-Existent Pseudo-Tables",
		category: "schema",
		validate(ctx) {
			if (
				ctx.tables.includes("inventoryitemlocations") ||
				ctx.tables.includes("lotnumberedassemblyitemlocations")
			) {
				return "Suboptimal table detected: 'inventoryitemlocations' only contains standard inventory items and omits Assembly, Lot, and Serialized items. Replace with 'aggregateitemlocation' which covers all item types.";
			}
			return null;
		},
	},
];
