/**
 * Query Context Builder & AST Extractor.
 * Uses sqlingo (sqlingo/oracle) to tokenize and parse SuiteQL into strongly-typed ASTs.
 */

import {
	ColumnExpr,
	CteExpr,
	type Expression,
	FetchExpr,
	OffsetExpr,
	parse,
	TableExpr,
	type Token,
} from "sqlingo";
import { Oracle } from "sqlingo/oracle";
import type { QueryContext } from "./types.js";

const oracleTokenizer = new Oracle.Tokenizer();

/**
 * Tokenizes a raw SQL string using the Oracle SQL lexer.
 * Automatically strips single-line (--), multi-line (/* * /), and quoted string literals.
 */
export function tokenizeSuiteQL(rawSql: string): Token[] {
	if (!rawSql || typeof rawSql !== "string") return [];
	try {
		return oracleTokenizer.tokenize(rawSql);
	} catch {
		return [];
	}
}

/**
 * Splits a potentially multi-statement SQL string into individual SQL statements
 * using the Oracle lexer's top-level semicolon token positions.
 * Semicolons inside string literals or comments are never split.
 */
export function splitSuiteQLStatements(rawSql: string): string[] {
	const trimmed = (rawSql || "").trim();
	if (!trimmed) return [];

	const tokens = tokenizeSuiteQL(trimmed);
	if (tokens.length === 0) return [trimmed];

	const statements: string[] = [];
	let startIdx = 0;

	for (const token of tokens) {
		if (token.tokenType === "semicolon") {
			const segment = trimmed.slice(startIdx, token.start).trim();
			if (segment.length > 0) {
				statements.push(segment);
			}
			startIdx = token.end + 1;
		}
	}

	const tail = trimmed.slice(startIdx).trim();
	if (tail.length > 0) {
		statements.push(tail);
	}

	return statements;
}

/**
 * Extracts referenced physical tables, table aliases, and CTE names from parsed ASTs.
 */
export function extractTablesAndAliasesFromAsts(asts: Expression[]): {
	tables: string[];
	tableAliases: Map<string, string>;
	cteNames: Set<string>;
} {
	const cteNames = new Set<string>();
	const tableSet = new Set<string>();
	const tableAliases = new Map<string, string>();

	for (const ast of asts) {
		for (const cte of ast.findAll(CteExpr)) {
			const alias = cte.alias?.toLowerCase();
			if (alias) {
				cteNames.add(alias);
			}
		}
	}

	for (const ast of asts) {
		for (const tbl of ast.findAll(TableExpr)) {
			const name = tbl.name?.toLowerCase();
			if (!name || cteNames.has(name)) continue;

			tableSet.add(name);
			tableAliases.set(name, name);

			const alias = tbl.alias?.toLowerCase();
			if (alias) {
				tableAliases.set(alias, name);
			}
		}
	}

	return {
		tables: Array.from(tableSet),
		tableAliases,
		cteNames,
	};
}

/**
 * Extracts table names and aliases from a raw SQL string.
 * Falls back to token-level FROM/JOIN inspection if the SQL has a syntax error preventing full AST parsing.
 */
export function extractTablesAndAliases(rawSql: string): {
	tables: string[];
	tableAliases: Map<string, string>;
	cteNames: Set<string>;
} {
	const trimmed = (rawSql || "").trim();
	if (!trimmed) {
		return {
			tables: [],
			tableAliases: new Map(),
			cteNames: new Set(),
		};
	}

	try {
		const asts = parse(trimmed, { read: Oracle }).filter(
			(stmt): stmt is Expression => stmt !== null,
		);
		if (asts.length > 0) {
			return extractTablesAndAliasesFromAsts(asts);
		}
	} catch {
		// Fallback to token-level scan below when SQL contains syntax errors
	}

	const tokens = tokenizeSuiteQL(trimmed);
	const tableSet = new Set<string>();
	const tableAliases = new Map<string, string>();
	const cteNames = new Set<string>();

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (!tok) continue;
		const type = String(tok.tokenType).toLowerCase();
		if (type === "from" || type === "join") {
			const nextTok = tokens[i + 1];
			if (nextTok && String(nextTok.tokenType).toLowerCase() === "var") {
				const tableName = nextTok.text.toLowerCase();
				tableSet.add(tableName);
				tableAliases.set(tableName, tableName);

				const maybeAs = tokens[i + 2];
				if (maybeAs) {
					const maybeAsType = String(maybeAs.tokenType).toLowerCase();
					if (maybeAsType === "alias" || maybeAsType === "as") {
						const aliasTok = tokens[i + 3];
						if (
							aliasTok &&
							String(aliasTok.tokenType).toLowerCase() === "var"
						) {
							tableAliases.set(aliasTok.text.toLowerCase(), tableName);
						}
					} else if (maybeAsType === "var") {
						tableAliases.set(maybeAs.text.toLowerCase(), tableName);
					}
				}
			}
		}
	}

	return {
		tables: Array.from(tableSet),
		tableAliases,
		cteNames,
	};
}

/**
 * Checks whether parsed ASTs (or tokens) contain Oracle pagination syntax:
 * - FETCH FIRST / NEXT N ROWS ONLY (FetchExpr)
 * - OFFSET M ROWS FETCH NEXT N ROWS ONLY (OffsetExpr + FetchExpr)
 * - WHERE ROWNUM <= N (ColumnExpr with name 'rownum')
 */
export function checkHasPagination(
	asts: Expression[],
	tokens: Token[],
): boolean {
	for (const ast of asts) {
		if (ast.find(FetchExpr) || ast.find(OffsetExpr)) {
			return true;
		}
		for (const col of ast.findAll(ColumnExpr)) {
			if (col.name.toLowerCase() === "rownum") {
				return true;
			}
		}
	}

	return tokens.some(
		(t) =>
			t.text.toLowerCase() === "fetch" || t.text.toLowerCase() === "rownum",
	);
}

/**
 * Builds a structured QueryContext from a raw SuiteQL string using sqlingo/oracle.
 */
export function buildQueryContext(rawSql: string): QueryContext {
	const trimmed = (rawSql || "").trim();
	const tokens = tokenizeSuiteQL(trimmed);
	const statements = splitSuiteQLStatements(trimmed);
	const hasMultipleStatements = statements.length > 1;

	const firstToken = tokens[0];
	const firstTokenText = firstToken?.text.toLowerCase() ?? "";
	const isSelectOrWith =
		firstTokenText === "select" || firstTokenText === "with";

	let asts: Expression[] = [];
	let parseError: string | undefined;

	try {
		asts = parse(trimmed, { read: Oracle }).filter(
			(stmt): stmt is Expression => stmt !== null,
		);
	} catch (err) {
		parseError = err instanceof Error ? err.message : String(err);
	}

	const { tables, tableAliases, cteNames } =
		asts.length > 0
			? extractTablesAndAliasesFromAsts(asts)
			: extractTablesAndAliases(trimmed);

	const hasPagination = checkHasPagination(asts, tokens);

	return {
		rawSql: trimmed,
		tokens,
		asts,
		tables,
		tableAliases,
		cteNames,
		hasPagination,
		hasMultipleStatements,
		isSelectOrWith,
		parseError,
	};
}
