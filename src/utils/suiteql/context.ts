/**
 * Query Context Extractor.
 * Parses raw SQL into a structured QueryContext for evaluation by the rule engine.
 */

import { maskStringLiterals, stripSqlComments } from "./normalizer.js";
import type { QueryContext } from "./types.js";

const SQL_KEYWORDS = new Set([
	"on",
	"where",
	"left",
	"right",
	"inner",
	"outer",
	"join",
	"cross",
	"group",
	"order",
	"fetch",
	"union",
	"limit",
	"offset",
	"having",
	"as",
	"using",
	"by",
	"select",
	"with",
	"from",
	"set",
	"and",
	"or",
]);

/**
 * Extracts table names and table aliases from masked SQL string.
 */
export function extractTablesAndAliases(maskedSql: string): {
	tables: string[];
	tableAliases: Map<string, string>;
} {
	const tableSet = new Set<string>();
	const aliases = new Map<string, string>();

	// FROM / JOIN regex
	const fromJoinRegex =
		/\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\b/gi;

	let match: RegExpExecArray | null;
	while (true) {
		match = fromJoinRegex.exec(maskedSql);
		if (!match) break;

		const table = match[1]?.toLowerCase();
		if (!table || SQL_KEYWORDS.has(table)) continue;

		tableSet.add(table);

		let alias = match[2]?.toLowerCase();
		if (!alias || SQL_KEYWORDS.has(alias)) {
			alias = table;
		}

		aliases.set(alias, table);
		aliases.set(table, table);
	}

	return {
		tables: Array.from(tableSet),
		tableAliases: aliases,
	};
}

/**
 * Extracts projection items from SELECT statements in masked SQL.
 */
export function extractProjections(maskedSql: string): string[] {
	const projections: string[] = [];
	const selectRegex = /\bSELECT\s+([\s\S]*?)\s+\bFROM\b/gi;

	let match: RegExpExecArray | null;
	while (true) {
		match = selectRegex.exec(maskedSql);
		if (!match) break;

		const projBlock = match[1]?.trim();
		if (!projBlock) continue;

		// Split by top-level commas outside parentheses
		let depth = 0;
		let current = "";
		for (let i = 0; i < projBlock.length; i++) {
			const char = projBlock[i];
			if (char === "(") depth++;
			else if (char === ")") depth = Math.max(0, depth - 1);

			if (char === "," && depth === 0) {
				const trimmed = current.trim();
				if (trimmed.length > 0) projections.push(trimmed);
				current = "";
			} else {
				current += char;
			}
		}

		const lastTrimmed = current.trim();
		if (lastTrimmed.length > 0) {
			projections.push(lastTrimmed);
		}
	}

	return projections;
}

/**
 * Checks if the query has Oracle pagination syntax.
 */
export function checkHasPagination(maskedSql: string): boolean {
	return (
		/\bFETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b/i.test(maskedSql) ||
		/\bROWNUM\s*(?:<=|<|=)\s*\d+\b/i.test(maskedSql) ||
		/\bOFFSET\s+\d+\s+ROWS?\s+FETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b/i.test(
			maskedSql,
		)
	);
}

/**
 * Builds a QueryContext instance from a raw SQL string.
 */
export function buildQueryContext(rawSql: string): QueryContext {
	const trimmed = (rawSql || "").trim();
	const { maskedSql, literals } = maskStringLiterals(trimmed);
	const cleanMaskedSql = stripSqlComments(maskedSql).trim();

	const withoutTrailingSemicolon = cleanMaskedSql.endsWith(";")
		? cleanMaskedSql.slice(0, -1).trim()
		: cleanMaskedSql;

	const hasMultipleStatements = withoutTrailingSemicolon.includes(";");
	const isSelectOrWith = /^(?:SELECT|WITH)\b/i.test(withoutTrailingSemicolon);

	const { tables, tableAliases } = extractTablesAndAliases(
		withoutTrailingSemicolon,
	);
	const projections = extractProjections(withoutTrailingSemicolon);
	const hasPagination = checkHasPagination(withoutTrailingSemicolon);

	return {
		rawSql: trimmed,
		cleanSql: withoutTrailingSemicolon,
		maskedSql: withoutTrailingSemicolon,
		literals,
		tables,
		tableAliases,
		projections,
		hasPagination,
		hasMultipleStatements,
		isSelectOrWith,
	};
}
