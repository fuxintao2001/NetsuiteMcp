/**
 * Oracle NetSuite SAFE Guide (2025.2) Compliance Rules.
 * Enforces explicit column projections, mandatory mainline filter on transactionline,
 * table lock prevention on systemnote, index performance, and CTE-based grouping.
 */

import {
	AliasExpr,
	AnonymousExpr,
	ColumnExpr,
	DotExpr,
	EqExpr,
	type Expression,
	FromExpr,
	FuncExpr,
	InExpr,
	IsExpr,
	JoinExpr,
	LiteralExpr,
	ParenExpr,
	SelectExpr,
	StarExpr,
	SubqueryExpr,
	WhereExpr,
} from "sqlingo";
import type { QueryContext, SuiteQLRule } from "../types.js";

/**
 * Checks whether a SELECT projection expression is a bare wildcard (`*`, `t.*`, `(*) AS x`).
 * Does NOT flag `COUNT(*)` because `StarExpr` inside `CountExpr` is not the top-level projection node.
 */
function isWildcardProjectionNode(expr: Expression): boolean {
	let current: Expression | undefined = expr;
	while (current instanceof AliasExpr || current instanceof ParenExpr) {
		current = current.args.this as Expression | undefined;
	}
	if (!current) return false;
	if (current instanceof StarExpr) return true;
	if (current instanceof ColumnExpr && current.args.this instanceof StarExpr) {
		return true;
	}
	return false;
}

function hasWildcardInSelectProjections(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		for (const select of ast.findAll(SelectExpr)) {
			for (const proj of select.selects) {
				if (isWildcardProjectionNode(proj)) {
					return true;
				}
			}
		}
	}
	return false;
}

function isTFStringLiteral(node: Expression | undefined): boolean {
	if (!node) return false;
	if (node instanceof LiteralExpr && node.isString) {
		const val = String(node.name).toUpperCase();
		return val === "T" || val === "F";
	}
	return false;
}

function isColumnNamed(
	node: Expression | undefined,
	targetNames: Set<string>,
): boolean {
	if (!(node instanceof ColumnExpr)) return false;
	return targetNames.has(node.name.toLowerCase());
}

/**
 * Checks whether any WHERE or JOIN ON predicate in the AST filters on
 * `mainline = 'T'/'F'` or `uniquekey / lineuniquekey = ...` or `IN (...)`.
 */
function hasMainlineFilterInAst(ctx: QueryContext): boolean {
	const mainlineSet = new Set(["mainline"]);
	const uniqueKeySet = new Set(["uniquekey", "lineuniquekey"]);

	for (const ast of ctx.asts) {
		const filterScopes: Expression[] = [
			...ast.findAll(WhereExpr),
			...Array.from(ast.findAll(JoinExpr))
				.map((j) => j.args.on)
				.filter((on): on is Expression => Boolean(on)),
		];

		for (const scope of filterScopes) {
			for (const eq of scope.findAll(EqExpr)) {
				const left = eq.args.this as Expression | undefined;
				const right = eq.args.expression as Expression | undefined;
				if (
					(isColumnNamed(left, mainlineSet) && isTFStringLiteral(right)) ||
					(isColumnNamed(right, mainlineSet) && isTFStringLiteral(left))
				) {
					return true;
				}
				if (
					isColumnNamed(left, uniqueKeySet) ||
					isColumnNamed(right, uniqueKeySet)
				) {
					return true;
				}
			}

			for (const isNode of scope.findAll(IsExpr)) {
				const left = isNode.args.this as Expression | undefined;
				const right = isNode.args.expression as Expression | undefined;
				if (
					(isColumnNamed(left, mainlineSet) && isTFStringLiteral(right)) ||
					(isColumnNamed(right, mainlineSet) && isTFStringLiteral(left))
				) {
					return true;
				}
			}

			for (const inNode of scope.findAll(InExpr)) {
				const left = inNode.args.this as Expression | undefined;
				if (isColumnNamed(left, uniqueKeySet)) {
					return true;
				}
				const exprs = inNode.args.expressions;
				if (
					isColumnNamed(left, mainlineSet) &&
					Array.isArray(exprs) &&
					exprs.some((e: Expression) => isTFStringLiteral(e))
				) {
					return true;
				}
			}
		}
	}

	return false;
}

function hasDerivedTableInFromOrJoin(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		for (const fromNode of ast.findAll(FromExpr)) {
			if (fromNode.args.this instanceof SubqueryExpr) {
				return true;
			}
		}
		for (const joinNode of ast.findAll(JoinExpr)) {
			if (joinNode.args.this instanceof SubqueryExpr) {
				return true;
			}
		}
	}
	return false;
}

const JOIN_KEY_CONVERSION_FUNCS = new Set([
	"to_number",
	"to_char",
	"nvl",
	"coalesce",
	"trim",
	"substr",
	"lower",
	"upper",
]);

const JOIN_KEY_COLUMNS = new Set([
	"id",
	"transaction",
	"uniquekey",
	"item",
	"account",
]);

function hasFunctionOnJoinKeys(ctx: QueryContext): boolean {
	const hasTranOrLine =
		ctx.tables.includes("transactionline") ||
		ctx.tables.includes("transaction");
	if (!hasTranOrLine) return false;

	for (const ast of ctx.asts) {
		for (const joinNode of ast.findAll(JoinExpr)) {
			const onExpr = joinNode.args.on;
			if (!onExpr) continue;

			for (const func of onExpr.findAll(FuncExpr)) {
				const funcCtor = func.constructor as typeof FuncExpr;
				const funcName = (
					func instanceof AnonymousExpr ? func.name : funcCtor.sqlName()
				).toLowerCase();

				if (JOIN_KEY_CONVERSION_FUNCS.has(funcName)) {
					for (const col of func.findAll(ColumnExpr)) {
						if (JOIN_KEY_COLUMNS.has(col.name.toLowerCase())) {
							return true;
						}
					}
				}
			}
		}
	}

	return false;
}

function containsBuiltinDf(expr: Expression): boolean {
	for (const dot of expr.findAll(DotExpr)) {
		const left = dot.args.this as Expression | undefined;
		const right = dot.args.expression as Expression | undefined;
		const leftName = (left?.name ?? "").toLowerCase();
		const rightName = (
			right instanceof AnonymousExpr
				? right.name
				: right instanceof FuncExpr
					? (right.constructor as typeof FuncExpr).sqlName()
					: (right?.name ?? "")
		).toLowerCase();
		if (leftName === "builtin" && rightName === "df") {
			return true;
		}
	}
	return false;
}

function hasBuiltinDfInGroupedSelect(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		for (const select of ast.findAll(SelectExpr)) {
			if (select.args.group && containsBuiltinDf(select)) {
				return true;
			}
		}
	}
	return false;
}

export const safeRules: SuiteQLRule[] = [
	{
		id: "safe-no-wildcards",
		name: "Explicit Column Projections Required",
		category: "safe",
		severity: "error",
		validate(ctx) {
			if (hasWildcardInSelectProjections(ctx)) {
				return {
					ruleId: "safe-no-wildcards",
					ruleName: "Explicit Column Projections Required",
					category: "safe",
					severity: "error",
					message:
						"SuiteQL query contains 'SELECT *' or wildcard projection (e.g. 'table.*'). Explicitly specify each required column name to optimize performance, prevent governance timeouts, and avoid invalid field errors.",
					suggestedFix:
						"Replace '*' with explicit columns (e.g. 'SELECT id, tranid, trandate, foreigntotal FROM transaction').",
				};
			}
			return null;
		},
	},
	{
		id: "safe-transactionline-mainline",
		name: "Mandatory TransactionLine Mainline Filter",
		category: "safe",
		severity: "error",
		validate(ctx) {
			if (
				ctx.tables.includes("transactionline") &&
				!hasMainlineFilterInAst(ctx)
			) {
				return {
					ruleId: "safe-transactionline-mainline",
					ruleName: "Mandatory TransactionLine Mainline Filter",
					category: "safe",
					severity: "error",
					message:
						"Missing mandatory 'mainline' filter on 'transactionline'. Add `mainline = 'F'` for line-level items or `mainline = 'T'` for transaction headers to prevent row duplication and distorted sums.",
					suggestedFix:
						"Add `WHERE tl.mainline = 'F'` (for lines) or `WHERE tl.mainline = 'T'` (for header) in WHERE or JOIN ON clause.",
				};
			}
			return null;
		},
	},
	{
		id: "safe-prohibit-systemnote-join",
		name: "Prohibit Audit Table SystemNote Multi-Table Joins (SAFE Pitfall 11)",
		category: "safe",
		severity: "error",
		validate(ctx) {
			if (
				ctx.tables.includes("systemnote") &&
				ctx.tables.some((t) => t !== "systemnote")
			) {
				return {
					ruleId: "safe-prohibit-systemnote-join",
					ruleName:
						"Prohibit Audit Table SystemNote Multi-Table Joins (SAFE Pitfall 11)",
					category: "safe",
					severity: "error",
					message:
						"Performance hazard (SAFE Pitfall 11): Multi-table JOIN with 'systemnote' is prohibited. Direct multi-table joins on 'systemnote' can lock database tables and trigger 45s+ timeouts. Instead, query 'systemnote' standalone by record ID (`WHERE recordid = :id`) or call the 'netsuite_get_system_notes' tool.",
					suggestedFix:
						"Query systemnote as a standalone query: `SELECT id, recordid, field, date FROM systemnote WHERE recordid = :id`.",
				};
			}
			return null;
		},
	},
	{
		id: "safe-no-derived-tables-in-from",
		name: "Use CTE Over Derived Tables in FROM/JOIN",
		category: "safe",
		severity: "error",
		validate(ctx) {
			if (hasDerivedTableInFromOrJoin(ctx)) {
				return {
					ruleId: "safe-no-derived-tables-in-from",
					ruleName: "Use CTE Over Derived Tables in FROM/JOIN",
					category: "safe",
					severity: "error",
					message:
						"Unsupported derived table / subquery in FROM/JOIN clause. In NetSuite SuiteQL, use Common Table Expressions (`WITH cte AS (...) SELECT ... FROM cte`) instead of inline subqueries in FROM or JOIN.",
					suggestedFix:
						"Rewrite the inline subquery using CTE: `WITH sub AS (SELECT ...) SELECT ... FROM sub`.",
				};
			}
			return null;
		},
	},
	{
		id: "safe-no-functions-on-join-keys",
		name: "Prohibit Function Conversions in JOIN ON Keys",
		category: "safe",
		severity: "error",
		validate(ctx) {
			if (hasFunctionOnJoinKeys(ctx)) {
				return {
					ruleId: "safe-no-functions-on-join-keys",
					ruleName: "Prohibit Function Conversions in JOIN ON Keys",
					category: "safe",
					severity: "error",
					message:
						"Performance hazard: Function conversion (e.g. TO_NUMBER/TO_CHAR) detected in JOIN ON clause against 'transactionline' or 'transaction'. In NetSuite SuiteQL, wrapping join keys in functions invalidates Oracle B-tree index lookup and forces full-table nested loop scans, leading to 60s timeouts or socket hang up. Please remove functions from the JOIN ON clause, pre-cast/filter in an inner query or CTE, or join on native numeric keys.",
					suggestedFix:
						"Join directly on native IDs (e.g. `ON tl.transaction = t.id`), avoiding functions like TO_NUMBER or TO_CHAR on key columns.",
				};
			}
			return null;
		},
	},
	{
		id: "safe-group-by-builtin-df",
		name: "Prohibit BUILTIN.DF in GROUP BY without CTE",
		category: "safe",
		severity: "error",
		validate(ctx) {
			if (hasBuiltinDfInGroupedSelect(ctx)) {
				return {
					ruleId: "safe-group-by-builtin-df",
					ruleName: "Prohibit BUILTIN.DF in GROUP BY without CTE",
					category: "safe",
					severity: "error",
					message:
						"Unsupported 'BUILTIN.DF()' in Grouped Query: NetSuite Oracle SuiteQL rejects calling 'BUILTIN.DF()' directly inside queries containing a GROUP BY clause, triggering 'Search error occurred: Invalid or unsupported search'. Please rewrite your query using a Common Table Expression (CTE): perform aggregation and GROUP BY on raw IDs inside the CTE, and apply BUILTIN.DF() in the outer SELECT projection (e.g. `WITH grp AS (SELECT id, COUNT(*) FROM ... GROUP BY id) SELECT id, BUILTIN.DF(id) FROM grp`).",
					suggestedFix:
						"Use a CTE: `WITH grp AS (SELECT entity, COUNT(*) FROM ... GROUP BY entity) SELECT entity, BUILTIN.DF(entity) FROM grp`.",
				};
			}
			return null;
		},
	},
];
