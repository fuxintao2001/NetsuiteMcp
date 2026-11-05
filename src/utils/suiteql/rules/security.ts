/**
 * Security & Anti-Injection Rules.
 * Enforces 100% read-only SuiteQL execution and blocks multi-statement injection.
 */

import { SelectExpr, UnionExpr } from "sqlingo";
import type { SuiteQLRule } from "../types.js";

const DISALLOWED_MUTATION_KEYWORDS = new Set([
	"insert",
	"update",
	"delete",
	"drop",
	"create",
	"alter",
	"truncate",
	"grant",
	"revoke",
	"exec",
	"execute",
	"merge",
	"into",
	"database",
	"schema",
]);

export const securityRules: SuiteQLRule[] = [
	{
		id: "sec-no-multi-statements",
		name: "Disallow Multi-Statement Injection",
		category: "security",
		severity: "error",
		validate(ctx) {
			if (ctx.hasMultipleStatements) {
				return {
					ruleId: "sec-no-multi-statements",
					ruleName: "Disallow Multi-Statement Injection",
					category: "security",
					severity: "error",
					message:
						"SuiteQL query contains multiple statements separated by semicolons. Only single read-only queries are allowed per invocation (or provide 'sqlQueries' array to 'netsuite_run_suiteql' for concurrent execution).",
					suggestedFix:
						"Execute queries individually, or pass an array of query strings via the 'sqlQueries' parameter.",
				};
			}
			return null;
		},
	},
	{
		id: "sec-start-with-select-or-with",
		name: "Require SELECT or WITH Statement",
		category: "security",
		severity: "error",
		validate(ctx) {
			if (!ctx.isSelectOrWith) {
				return {
					ruleId: "sec-start-with-select-or-with",
					ruleName: "Require SELECT or WITH Statement",
					category: "security",
					severity: "error",
					message:
						"SuiteQL queries must begin with a SELECT or WITH statement. SuiteQL is strictly read-only; use record API tools for mutations.",
					suggestedFix:
						"Ensure your query begins with `SELECT ...` or `WITH cte AS (...) SELECT ...`.",
				};
			}
			return null;
		},
	},
	{
		id: "sec-read-only-only",
		name: "Disallow Mutation & DDL Statements",
		category: "security",
		severity: "error",
		validate(ctx) {
			const hasMutationAst =
				ctx.asts.length > 0 &&
				ctx.asts.some(
					(ast) => !(ast instanceof SelectExpr) && !(ast instanceof UnionExpr),
				);

			const hasMutationToken = ctx.tokens.some((tok) => {
				const tokenType = String(tok.tokenType).toLowerCase();
				if (tokenType === "string") return false;
				return DISALLOWED_MUTATION_KEYWORDS.has(tok.text.toLowerCase());
			});

			if (hasMutationAst || hasMutationToken) {
				return {
					ruleId: "sec-read-only-only",
					ruleName: "Disallow Mutation & DDL Statements",
					category: "security",
					severity: "error",
					message:
						"SuiteQL query contains disallowed modification or DDL keywords. SuiteQL supports read-only SELECT and WITH statements only.",
					suggestedFix:
						"Remove mutation keywords. If you need to create or update records, use the NetSuite Record REST APIs.",
				};
			}
			return null;
		},
	},
];
