/**
 * Oracle NetSuite SAFE Guide (2025.2) Compliance Rules.
 * Enforces explicit column projections, mandatory mainline filter on transactionline,
 * table lock prevention on systemnote, and index performance rules.
 */

import type { SuiteQLRule } from "../types.js";

function peelOuterParentheses(expr: string): string {
	let current = expr.trim();
	while (current.startsWith("(") && current.endsWith(")")) {
		let depth = 0;
		let isWrapped = true;
		for (let i = 0; i < current.length - 1; i++) {
			if (current[i] === "(") depth++;
			else if (current[i] === ")") depth--;
			if (depth === 0) {
				isWrapped = false;
				break;
			}
		}
		if (isWrapped) {
			current = current.slice(1, -1).trim();
		} else {
			break;
		}
	}
	return current;
}

function isWildcardProjectionItem(rawItem: string): boolean {
	let item = rawItem.trim();
	if (!item) return false;

	// Strip trailing alias: "(*) AS all_cols", "table.* AS my_item"
	item = item.replace(/\s+AS\s+(?:"[^"]+"|[a-zA-Z0-9_]+)$/i, "").trim();
	item = item.replace(/\)\s+(?:"[^"]+"|[a-zA-Z0-9_]+)$/i, ")").trim();

	const unwrapped = peelOuterParentheses(item);
	return /^(?:(?:"[^"]+"|[a-zA-Z0-9_]+)\s*\.\s*)*\*$/.test(unwrapped);
}

function hasWildcardInProjections(projections: string[]): boolean {
	for (const proj of projections) {
		if (isWildcardProjectionItem(proj)) {
			return true;
		}
	}
	return false;
}

function hasMainlineFilter(maskedSql: string, literals: string[]): boolean {
	// 1. Restore only genuine single or double quoted 'T' or 'F' literals
	const sqlForMainlineCheck = maskedSql.replace(
		/__STR_LITERAL_(\d+)__/g,
		(_match, idx) => {
			const lit = literals[Number(idx)];
			if (lit && /^['"][TF]['"]$/i.test(lit)) {
				return lit;
			}
			return "__STR_LITERAL__";
		},
	);

	// 2. Extract WHERE and ON clauses
	const filterClauses: string[] = [];
	const whereRegex =
		/\bWHERE\s+([\s\S]+?)(?=\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST|FETCH\s+NEXT|LIMIT|OFFSET|UNION|INTERSECT|MINUS)\b|;|$)/gi;
	let m: RegExpExecArray | null;
	while (true) {
		m = whereRegex.exec(sqlForMainlineCheck);
		if (!m) break;
		if (m[1]) filterClauses.push(m[1]);
	}

	const onRegex =
		/\bON\s+([\s\S]+?)(?=\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|NATURAL)\s+)?JOIN\b|\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST|FETCH\s+NEXT|LIMIT|OFFSET|UNION|INTERSECT|MINUS)\b|;|$)/gi;
	while (true) {
		m = onRegex.exec(sqlForMainlineCheck);
		if (!m) break;
		if (m[1]) filterClauses.push(m[1]);
	}

	const searchScope = filterClauses.join(" ");
	if (!searchScope.trim()) return false;

	// Single-line unique key lookup
	if (
		/\b(?:[a-zA-Z0-9_]+\.)?(?:uniquekey|lineuniquekey)\s*(?:=|\bIN\b)\s*(\d+|\()/i.test(
			searchScope,
		)
	) {
		return true;
	}

	// Strict mainline predicate: mainline = 'T' or mainline = 'F'
	const standardMainline =
		/\b(?:[a-zA-Z0-9_]+\.)?mainline\s*(?:=|IS)\s*(['"])[TF]\1(?![a-zA-Z0-9_])/i;
	const yodaMainline =
		/(['"])[TF]\1\s*(?:=|IS)\s*(?:[a-zA-Z0-9_]+\.)?mainline\b/i;

	return standardMainline.test(searchScope) || yodaMainline.test(searchScope);
}

export const safeRules: SuiteQLRule[] = [
	{
		id: "safe-no-wildcards",
		name: "Explicit Column Projections Required",
		category: "safe",
		validate(ctx) {
			if (hasWildcardInProjections(ctx.projections)) {
				return "SuiteQL query contains 'SELECT *' or wildcard projection (e.g. 'table.*'). Explicitly specify each required column name to optimize performance, prevent governance timeouts, and avoid invalid field errors.";
			}
			return null;
		},
	},
	{
		id: "safe-transactionline-mainline",
		name: "Mandatory TransactionLine Mainline Filter",
		category: "safe",
		validate(ctx) {
			if (
				ctx.tables.includes("transactionline") &&
				!hasMainlineFilter(ctx.maskedSql, ctx.literals)
			) {
				return "Missing mandatory 'mainline' filter on 'transactionline'. Add `mainline = 'F'` for line-level items or `mainline = 'T'` for transaction headers to prevent row duplication and distorted sums.";
			}
			return null;
		},
	},
	{
		id: "safe-prohibit-systemnote-join",
		name: "Prohibit Audit Table SystemNote Multi-Table Joins (Pitfall 11)",
		category: "safe",
		validate(ctx) {
			if (
				ctx.tables.includes("systemnote") &&
				ctx.tables.some((t) => t !== "systemnote")
			) {
				return "Performance hazard (SAFE Pitfall 11): Multi-table JOIN with 'systemnote' is prohibited. Direct multi-table joins on 'systemnote' can lock database tables and trigger 45s+ timeouts. Instead, query 'systemnote' standalone by record ID (`WHERE recordid = :id`) or call the 'netsuite_get_system_notes' tool.";
			}
			return null;
		},
	},
	{
		id: "safe-no-derived-tables-in-from",
		name: "Use CTE Over Derived Tables in FROM/JOIN",
		category: "safe",
		validate(ctx) {
			if (
				/\b(?:FROM|JOIN)\s*\(\s*SELECT\b/i.test(ctx.maskedSql) &&
				!/^\s*WITH\b/i.test(ctx.maskedSql)
			) {
				return "Unsupported derived table / subquery in FROM/JOIN clause. In NetSuite SuiteQL, use Common Table Expressions (`WITH cte AS (...) SELECT ... FROM cte`) instead of inline subqueries in FROM or JOIN.";
			}
			return null;
		},
	},
	{
		id: "safe-no-functions-on-join-keys",
		name: "Prohibit Function Conversions in JOIN ON Keys",
		category: "safe",
		validate(ctx) {
			const hasTranOrLine =
				ctx.tables.includes("transactionline") ||
				ctx.tables.includes("transaction");
			if (!hasTranOrLine) return null;

			const onRegex =
				/\bON\s+([\s\S]+?)(?=\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|NATURAL)\s+)?JOIN\b|\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST|FETCH\s+NEXT|LIMIT|OFFSET|UNION|INTERSECT|MINUS)\b|;|$)/gi;
			let match: RegExpExecArray | null;
			while (true) {
				match = onRegex.exec(ctx.maskedSql);
				if (!match) break;
				const onClause = match[1] || "";
				if (
					/\b(?:TO_NUMBER|TO_CHAR|NVL|COALESCE|TRIM|SUBSTR|LOWER|UPPER)\s*\([^)]*\b(?:id|transaction|uniquekey|item|account)\b[^)]*\)/i.test(
						onClause,
					)
				) {
					return "Performance hazard: Function conversion (e.g. TO_NUMBER/TO_CHAR) detected in JOIN ON clause against 'transactionline' or 'transaction'. In NetSuite SuiteQL, wrapping join keys in functions invalidates Oracle B-tree index lookup and forces full-table nested loop scans, leading to 60s timeouts or socket hang up. Please remove functions from the JOIN ON clause, pre-cast/filter in an inner query or CTE, or join on native numeric keys.";
				}
			}
			return null;
		},
	},
	{
		id: "safe-group-by-builtin-df",
		name: "Prohibit BUILTIN.DF in GROUP BY without CTE",
		category: "safe",
		validate(ctx) {
			if (
				/\bBUILTIN\.DF\s*\(/i.test(ctx.maskedSql) &&
				/\bGROUP\s+BY\b/i.test(ctx.maskedSql) &&
				!/^\s*WITH\b/i.test(ctx.maskedSql)
			) {
				return "Unsupported 'BUILTIN.DF()' in Grouped Query: NetSuite Oracle SuiteQL rejects calling 'BUILTIN.DF()' directly inside queries containing a GROUP BY clause, triggering 'Search error occurred: Invalid or unsupported search'. Please rewrite your query using a Common Table Expression (CTE): perform aggregation and GROUP BY on raw IDs inside the CTE, and apply BUILTIN.DF() in the outer SELECT projection (e.g. `WITH grp AS (SELECT id, COUNT(*) FROM ... GROUP BY id) SELECT id, BUILTIN.DF(id) FROM grp`).";
			}
			return null;
		},
	},
];
