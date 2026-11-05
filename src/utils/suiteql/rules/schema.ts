/**
 * NetSuite ERP Schema Invariants Rules.
 * Catches high-frequency schema hallucinations before execution using sqlingo AST nodes.
 */

import { ColumnExpr, SelectExpr } from "sqlingo";
import { Oracle } from "sqlingo/oracle";
import type { QueryContext, SuiteQLRule } from "../types.js";

function findDuplicateProjectionAlias(ctx: QueryContext): {
	duplicate: string;
	firstExpr: string;
	secondExpr: string;
} | null {
	for (const ast of ctx.asts) {
		if (!(ast instanceof SelectExpr)) continue;

		const seen = new Map<string, string>();
		for (const proj of ast.selects) {
			const effectiveName = (
				proj.alias || (proj instanceof ColumnExpr ? proj.name : "")
			).toLowerCase();

			if (!effectiveName || effectiveName === "*") continue;

			const exprSql = proj.sql({ dialect: Oracle });
			const existing = seen.get(effectiveName);
			if (existing) {
				return {
					duplicate: effectiveName,
					firstExpr: existing,
					secondExpr: exprSql,
				};
			}
			seen.set(effectiveName, exprSql);
		}
	}

	return null;
}

export const schemaRules: SuiteQLRule[] = [
	{
		id: "schema-item-no-recordtype",
		name: "Enforce item.itemtype Over recordtype",
		category: "schema",
		severity: "error",
		validate(ctx) {
			if (!ctx.tables.includes("item")) return null;

			const itemAliases = new Set<string>();
			for (const [alias, table] of ctx.tableAliases.entries()) {
				if (table === "item") itemAliases.add(alias);
			}

			const hasEntityOrTran = ctx.tables.some((t) =>
				["entity", "customer", "vendor", "employee", "transaction"].includes(t),
			);

			for (const ast of ctx.asts) {
				for (const col of ast.findAll(ColumnExpr)) {
					if (col.name.toLowerCase() !== "recordtype") continue;

					const tableQualifier = col.table.toLowerCase();
					if (tableQualifier && itemAliases.has(tableQualifier)) {
						return {
							ruleId: "schema-item-no-recordtype",
							ruleName: "Enforce item.itemtype Over recordtype",
							category: "schema",
							severity: "error",
							message:
								"Invalid Column on 'item' Table: The 'item' table in NetSuite does NOT have a 'recordtype' column. Use 'itemtype' ('Assembly', 'InvtPart', 'NonInvtPart', 'Service', etc.) and 'subtype' ('Sale', 'Purchase', 'Resale') instead.",
							suggestedFix:
								"Replace `item.recordtype` with `item.itemtype` or `item.subtype`.",
						};
					}

					if (!tableQualifier && !hasEntityOrTran) {
						return {
							ruleId: "schema-item-no-recordtype",
							ruleName: "Enforce item.itemtype Over recordtype",
							category: "schema",
							severity: "error",
							message:
								"Invalid Column on 'item' Table: The 'item' table in NetSuite does NOT have a 'recordtype' column. Use 'itemtype' ('Assembly', 'InvtPart', 'NonInvtPart', 'Service', etc.) and 'subtype' ('Sale', 'Purchase', 'Resale') instead.",
							suggestedFix:
								"Replace `recordtype` with `itemtype` or `subtype`.",
						};
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
		severity: "error",
		validate(ctx) {
			if (!ctx.tables.includes("transaction")) return null;

			const tranAliases = new Set<string>();
			for (const [alias, table] of ctx.tableAliases.entries()) {
				if (table === "transaction") tranAliases.add(alias);
			}

			const hasTranLine = ctx.tables.includes("transactionline");

			for (const ast of ctx.asts) {
				for (const col of ast.findAll(ColumnExpr)) {
					if (col.name.toLowerCase() !== "createdfrom") continue;

					const tableQualifier = col.table.toLowerCase();
					if (
						(tableQualifier && tranAliases.has(tableQualifier)) ||
						(!tableQualifier && !hasTranLine)
					) {
						return {
							ruleId: "schema-transaction-no-createdfrom",
							ruleName: "Enforce createdfrom on transactionline",
							category: "schema",
							severity: "error",
							message:
								"Invalid Field Location: 'createdfrom' exists exclusively on the 'transactionline' table (line items), NEVER on the 'transaction' header. To track upstream documents, JOIN transactionline tl ON tl.transaction = t.id and filter tl.createdfrom.",
							suggestedFix:
								"JOIN transactionline tl ON t.id = tl.transaction and query `tl.createdfrom` with `tl.mainline = 'T'`.",
						};
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
		severity: "error",
		validate(ctx) {
			const dup = findDuplicateProjectionAlias(ctx);
			if (dup) {
				return {
					ruleId: "schema-unique-projection-aliases",
					ruleName: "Require Unique Column Aliases in SELECT",
					category: "schema",
					severity: "error",
					message: `Duplicate Column Alias detected in SELECT: '${dup.duplicate}'. In NetSuite SuiteQL, each projected column must have a unique alias. Found duplicate across '${dup.firstExpr}' and '${dup.secondExpr}'.`,
					suggestedFix: `Rename one of the conflicting columns (e.g. 'AS ${dup.duplicate}_1', 'AS ${dup.duplicate}_2').`,
				};
			}
			return null;
		},
	},
];
