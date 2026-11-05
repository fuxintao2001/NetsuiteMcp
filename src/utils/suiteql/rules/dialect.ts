/**
 * Oracle NetSuite SQL Dialect Rules.
 * Catches MySQL/PostgreSQL habits early to provide zero-cost fail-fast self-healing.
 */

import {
	AddExpr,
	BooleanExpr,
	ColumnExpr,
	EqExpr,
	type Expression,
	FetchExpr,
	IsExpr,
	LimitExpr,
	LiteralExpr,
	OffsetExpr,
	SelectExpr,
} from "sqlingo";
import type { QueryContext, SuiteQLRule } from "../types.js";

const ERP_BOOLEAN_FLAG_COLUMNS = new Set([
	"isinactive",
	"mainline",
	"taxline",
	"posting",
	"voided",
	"isclosed",
	"closed",
]);

function hasMySqlLimit(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		if (ast.find(LimitExpr)) {
			return true;
		}
	}
	return false;
}

function hasBareOffsetWithoutFetch(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		for (const select of ast.findAll(SelectExpr)) {
			if (select.args.offset instanceof OffsetExpr) {
				if (!(select.args.limit instanceof FetchExpr)) {
					return true;
				}
			}
		}
	}
	return false;
}

function hasNonOracleFunctionCall(
	ctx: QueryContext,
	forbiddenFuncNames: Set<string>,
): boolean {
	for (let i = 0; i < ctx.tokens.length - 1; i++) {
		const tok = ctx.tokens[i];
		const nextTok = ctx.tokens[i + 1];
		if (!tok || !nextTok) continue;

		const tokType = String(tok.tokenType).toLowerCase();
		if (tokType === "string") continue;

		const nextTokType = String(nextTok.tokenType).toLowerCase();
		if (
			forbiddenFuncNames.has(tok.text.toLowerCase()) &&
			(nextTokType === "lparen" || nextTokType === "l_paren")
		) {
			return true;
		}
	}
	return false;
}

function hasBooleanLiteralOnErpColumn(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		const binaryNodes = [...ast.findAll(EqExpr), ...ast.findAll(IsExpr)];
		for (const node of binaryNodes) {
			const left = node.args.this as Expression | undefined;
			const right = node.args.expression as Expression | undefined;

			const leftIsFlag =
				left instanceof ColumnExpr &&
				ERP_BOOLEAN_FLAG_COLUMNS.has(left.name.toLowerCase());
			const rightIsFlag =
				right instanceof ColumnExpr &&
				ERP_BOOLEAN_FLAG_COLUMNS.has(right.name.toLowerCase());

			if (
				(leftIsFlag && right instanceof BooleanExpr) ||
				(rightIsFlag && left instanceof BooleanExpr)
			) {
				return true;
			}
		}
	}
	return false;
}

function hasStringConcatWithPlus(ctx: QueryContext): boolean {
	for (const ast of ctx.asts) {
		for (const addNode of ast.findAll(AddExpr)) {
			const left = addNode.args.this as Expression | undefined;
			const right = addNode.args.expression as Expression | undefined;
			const leftIsString = left instanceof LiteralExpr && left.isString;
			const rightIsString = right instanceof LiteralExpr && right.isString;
			if (leftIsString || rightIsString) {
				return true;
			}
		}
	}
	return false;
}

export const dialectRules: SuiteQLRule[] = [
	{
		id: "dialect-oracle-pagination",
		name: "Enforce Oracle Pagination Syntax",
		category: "dialect",
		severity: "error",
		validate(ctx) {
			if (hasMySqlLimit(ctx)) {
				return {
					ruleId: "dialect-oracle-pagination",
					ruleName: "Enforce Oracle Pagination Syntax",
					category: "dialect",
					severity: "error",
					message:
						"SuiteQL does not support 'LIMIT/OFFSET' keywords in MySQL style. Use Oracle-standard 'FETCH FIRST N ROWS ONLY', 'WHERE ROWNUM <= N', or 'OFFSET M ROWS FETCH NEXT N ROWS ONLY' for pagination.",
					suggestedFix:
						"Replace `LIMIT N` with `FETCH FIRST N ROWS ONLY` (e.g. `FETCH FIRST 10 ROWS ONLY`).",
				};
			}

			if (hasBareOffsetWithoutFetch(ctx)) {
				return {
					ruleId: "dialect-oracle-pagination",
					ruleName: "Enforce Oracle Pagination Syntax",
					category: "dialect",
					severity: "error",
					message:
						"Invalid OFFSET syntax. SuiteQL requires Oracle-standard offset syntax: 'OFFSET M ROWS FETCH NEXT N ROWS ONLY', or 'FETCH FIRST N ROWS ONLY'.",
					suggestedFix:
						"Use `OFFSET M ROWS FETCH NEXT N ROWS ONLY` (e.g. `OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY`).",
				};
			}

			return null;
		},
	},
	{
		id: "dialect-oracle-date-functions",
		name: "Enforce Oracle SYSDATE",
		category: "dialect",
		severity: "error",
		validate(ctx) {
			if (hasNonOracleFunctionCall(ctx, new Set(["now", "curdate"]))) {
				return {
					ruleId: "dialect-oracle-date-functions",
					ruleName: "Enforce Oracle SYSDATE",
					category: "dialect",
					severity: "error",
					message:
						"Non-Oracle date function detected ('NOW()' or 'CURDATE()'). In Oracle NetSuite SuiteQL, use 'SYSDATE' or 'CURRENT_DATE' instead (e.g. `WHERE trandate >= SYSDATE - 30`).",
					suggestedFix:
						"Replace `NOW()` or `CURDATE()` with `SYSDATE` or `CURRENT_DATE`.",
				};
			}
			return null;
		},
	},
	{
		id: "dialect-oracle-null-functions",
		name: "Enforce Oracle NVL / COALESCE",
		category: "dialect",
		severity: "error",
		validate(ctx) {
			if (hasNonOracleFunctionCall(ctx, new Set(["ifnull", "isnull"]))) {
				return {
					ruleId: "dialect-oracle-null-functions",
					ruleName: "Enforce Oracle NVL / COALESCE",
					category: "dialect",
					severity: "error",
					message:
						"Non-Oracle NULL replacement function detected ('IFNULL()' or 'ISNULL()'). In Oracle NetSuite SuiteQL, use 'NVL(column, fallback)' or 'COALESCE(a, b, c)'.",
					suggestedFix:
						"Replace `IFNULL(a, b)` or `ISNULL(a, b)` with `NVL(a, b)` or `COALESCE(a, b)`.",
				};
			}
			return null;
		},
	},
	{
		id: "dialect-oracle-boolean-literals",
		name: "Enforce 'T' / 'F' Boolean Literals",
		category: "dialect",
		severity: "error",
		validate(ctx) {
			if (hasBooleanLiteralOnErpColumn(ctx)) {
				return {
					ruleId: "dialect-oracle-boolean-literals",
					ruleName: "Enforce 'T' / 'F' Boolean Literals",
					category: "dialect",
					severity: "error",
					message:
						"Boolean Literal Syntax Error: NetSuite ERP stores boolean flags as 'T' or 'F' strings, not bare SQL true/false literals. Rewrite using `'T'` or `'F'` (e.g. `isinactive = 'F'`, `mainline = 'F'`).",
					suggestedFix:
						"Replace `true`/`false` with `'T'`/`'F'` (e.g. `isinactive = 'F'`).",
				};
			}
			return null;
		},
	},
	{
		id: "dialect-oracle-string-concat",
		name: "Enforce Oracle String Concatenation (||)",
		category: "dialect",
		severity: "error",
		validate(ctx) {
			if (hasStringConcatWithPlus(ctx)) {
				return {
					ruleId: "dialect-oracle-string-concat",
					ruleName: "Enforce Oracle String Concatenation (||)",
					category: "dialect",
					severity: "error",
					message:
						"String Concatenation Operator: In Oracle NetSuite SuiteQL, the `+` operator is strictly for arithmetic addition. Use the Oracle string concatenation operator `||` or `CONCAT(a, b)` for strings.",
					suggestedFix:
						"Replace `+` with `||` or `CONCAT(a, b)` for string concatenation.",
				};
			}
			return null;
		},
	},
];
