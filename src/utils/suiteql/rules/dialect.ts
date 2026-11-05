/**
 * Oracle NetSuite SQL Dialect Rules.
 * Catches MySQL/PostgreSQL habits early to provide zero-cost fail-fast self-healing.
 */

import type { SuiteQLRule } from "../types.js";

export const dialectRules: SuiteQLRule[] = [
	{
		id: "dialect-oracle-pagination",
		name: "Enforce Oracle Pagination Syntax",
		category: "dialect",
		validate(ctx) {
			// MySQL LIMIT check (negative lookbehind avoids column aliases like 'creditlimit AS limit')
			if (
				/(?<!\bAS\s+)\bLIMIT\s*\(?\s*(?:\d+|\?|:\w+|\$\d+|@\w+|ALL\b|NULL\b|SELECT\b|$)/i.test(
					ctx.maskedSql,
				)
			) {
				return "SuiteQL does not support 'LIMIT/OFFSET' keywords in MySQL style. Use Oracle-standard 'FETCH FIRST N ROWS ONLY', 'WHERE ROWNUM <= N', or 'OFFSET M ROWS FETCH NEXT N ROWS ONLY' for pagination.";
			}

			// Bare OFFSET check without FETCH FIRST/NEXT
			if (
				/\bOFFSET\s+(?:\d+|\?|:\w+)/i.test(ctx.maskedSql) &&
				!/\bOFFSET\s+(?:\d+|\?|:\w+)\s+ROWS?\s+FETCH\s+(?:FIRST|NEXT)\s+(?:\d+|\?|:\w+)\s+ROWS?\s+ONLY\b/i.test(
					ctx.maskedSql,
				)
			) {
				return "Invalid OFFSET syntax. SuiteQL requires Oracle-standard offset syntax: 'OFFSET M ROWS FETCH NEXT N ROWS ONLY', or 'FETCH FIRST N ROWS ONLY'.";
			}

			return null;
		},
	},
	{
		id: "dialect-oracle-date-functions",
		name: "Enforce Oracle SYSDATE",
		category: "dialect",
		validate(ctx) {
			if (/\b(?:NOW|CURDATE)\s*\(\s*\)/i.test(ctx.maskedSql)) {
				return "Non-Oracle date function detected ('NOW()' or 'CURDATE()'). In Oracle NetSuite SuiteQL, use 'SYSDATE' or 'CURRENT_DATE' instead (e.g. `WHERE trandate >= SYSDATE - 30`).";
			}
			return null;
		},
	},
	{
		id: "dialect-oracle-null-functions",
		name: "Enforce Oracle NVL / COALESCE",
		category: "dialect",
		validate(ctx) {
			if (/\b(?:IFNULL|ISNULL)\s*\(/i.test(ctx.maskedSql)) {
				return "Non-Oracle NULL replacement function detected ('IFNULL()' or 'ISNULL()'). In Oracle NetSuite SuiteQL, use 'NVL(column, fallback)' or 'COALESCE(a, b, c)'.";
			}
			return null;
		},
	},
	{
		id: "dialect-oracle-boolean-literals",
		name: "Enforce 'T' / 'F' Boolean Literals",
		category: "dialect",
		validate(ctx) {
			// e.g. isinactive = true / isinactive = false / mainline = true
			if (
				/\b(?:isinactive|mainline|taxline|posting|voided|isclosed|closed)\s*(?:=|IS)\s*(?:true|false)\b/i.test(
					ctx.maskedSql,
				)
			) {
				return "Boolean Literal Syntax Error: NetSuite ERP stores boolean flags as 'T' or 'F' strings, not bare SQL true/false literals. Rewrite using `'T'` or `'F'` (e.g. `isinactive = 'F'`, `mainline = 'F'`).";
			}
			return null;
		},
	},
	{
		id: "dialect-oracle-string-concat",
		name: "Enforce Oracle String Concatenation (||)",
		category: "dialect",
		validate(ctx) {
			// e.g. col + ' ' + col2 or 'text' + col
			if (
				/(?:__STR_LITERAL_\d+__\s*\+\s*[a-zA-Z0-9_.]+|[a-zA-Z0-9_.]+\s*\+\s*__STR_LITERAL_\d+__)/i.test(
					ctx.maskedSql,
				)
			) {
				return "String Concatenation Operator: In Oracle NetSuite SuiteQL, the `+` operator is strictly for arithmetic addition. Use the Oracle string concatenation operator `||` or `CONCAT(a, b)` for strings.";
			}
			return null;
		},
	},
];
