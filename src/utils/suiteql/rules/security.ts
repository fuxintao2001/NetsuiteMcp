/**
 * Security & Anti-Injection Rules.
 * Enforces 100% read-only SuiteQL execution and blocks multi-statement injection.
 */

import type { SuiteQLRule } from "../types.js";

const DISALLOWED_MUTATION_KEYWORDS =
	/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|INTO|DATABASE|SCHEMA)\b/i;

export const securityRules: SuiteQLRule[] = [
	{
		id: "sec-no-multi-statements",
		name: "Disallow Multi-Statement Injection",
		category: "security",
		validate(ctx) {
			if (ctx.hasMultipleStatements) {
				return "SuiteQL query contains multiple statements separated by semicolons. Only single read-only queries are allowed per invocation (or provide 'sqlQueries' array to 'netsuite_run_suiteql' for concurrent execution).";
			}
			return null;
		},
	},
	{
		id: "sec-start-with-select-or-with",
		name: "Require SELECT or WITH Statement",
		category: "security",
		validate(ctx) {
			if (!ctx.isSelectOrWith) {
				return "SuiteQL queries must begin with a SELECT or WITH statement. SuiteQL is strictly read-only; use record API tools for mutations.";
			}
			return null;
		},
	},
	{
		id: "sec-read-only-only",
		name: "Disallow Mutation & DDL Statements",
		category: "security",
		validate(ctx) {
			if (DISALLOWED_MUTATION_KEYWORDS.test(ctx.maskedSql)) {
				return "SuiteQL query contains disallowed modification or DDL keywords. SuiteQL supports read-only SELECT and WITH statements only.";
			}
			return null;
		},
	},
];
