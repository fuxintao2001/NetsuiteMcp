import { LRUCache } from "lru-cache";
import pkg from "node-sql-parser";

const { Parser } = pkg;
const sqlParser = new Parser();

const validationCache = new LRUCache<string, SuiteQLValidationResult>({
	max: 500,
	ttl: 10 * 60 * 1000, // 10 minutes
});

export class SuiteQLValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SuiteQLValidationError";
	}
}

export interface SuiteQLValidationResult {
	valid: boolean;
	reason?: string;
	tables?: string[];
	hasPagination?: boolean;
}

const DISALLOWED_KEYWORDS_REGEX =
	/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|INTO|DATABASE|SCHEMA)\b/i;

/**
 * Replaces SQL string literals ('...') and double-quoted identifiers/literals ("...")
 * with placeholder tokens to avoid false positives when matching keywords or comment symbols.
 */
export function maskStringLiterals(sql: string): {
	maskedSql: string;
	literals: string[];
} {
	const literals: string[] = [];
	let quoteChar: "'" | '"' | null = null;
	let currentLiteral = "";
	let maskedSql = "";

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const nextChar = sql[i + 1];

		if (quoteChar === null) {
			if (char === "'" || char === '"') {
				quoteChar = char;
				currentLiteral = char;
				continue;
			}
			maskedSql += char;
		} else {
			if (char === quoteChar) {
				// Handle escaped quote ('' or "")
				if (nextChar === quoteChar) {
					currentLiteral += quoteChar + quoteChar;
					i++; // Skip escaped quote
					continue;
				}
				// End of literal / quoted identifier
				currentLiteral += quoteChar;
				literals.push(currentLiteral);
				maskedSql += `__STR_LITERAL_${literals.length - 1}__`;
				currentLiteral = "";
				quoteChar = null;
				continue;
			}
			currentLiteral += char;
		}
	}

	if (quoteChar !== null) {
		// Unterminated literal
		maskedSql += currentLiteral;
	}

	return { maskedSql, literals };
}

/**
 * Restores string literals previously replaced by maskStringLiterals.
 */
export function unmaskStringLiterals(
	maskedSql: string,
	literals: string[],
): string {
	let unmasked = maskedSql;
	for (let i = 0; i < literals.length; i++) {
		const literal = literals[i] ?? "";
		unmasked = unmasked.replace(`__STR_LITERAL_${i}__`, () => literal);
	}
	return unmasked;
}

/**
 * Safely strips line comments (-- ...) and block comments (/* ... * /) outside string literals,
 * replacing them with whitespace to preserve token boundaries.
 */
export function stripSqlComments(maskedSql: string): string {
	if (!maskedSql) return "";
	// Replace block comments /* ... */ with a single space
	let stripped = maskedSql.replace(/\/\*[\s\S]*?\*\//g, " ");
	// Replace single line comments -- ... or # ... with a single space
	stripped = stripped.replace(/(?:--|#)[^\r\n]*/g, " ");
	return stripped;
}

/**
 * Splits a composite SQL string into individual statements by semicolon (;),
 * while safely ignoring semicolons inside string literals ('...').
 * Returns an array of trimmed, non-empty SQL statements.
 */
export function splitSuiteQLStatements(rawSql: string): string[] {
	if (!rawSql || typeof rawSql !== "string") {
		return [];
	}

	const trimmed = rawSql.trim();
	if (!trimmed) return [];

	const { maskedSql, literals } = maskStringLiterals(trimmed);
	const rawParts = maskedSql.split(";");
	const statements: string[] = [];

	for (const part of rawParts) {
		const unmasked = unmaskStringLiterals(part, literals).trim();
		if (unmasked.length > 0) {
			statements.push(unmasked);
		}
	}

	return statements;
}

/**
 * Extracts referenced table names from a SuiteQL query.
 * Excludes virtual Common Table Expressions (CTE) defined via WITH <name> AS (...).
 */
export function extractReferencedTables(
	sqlQuery: string,
	literals?: string[],
): string[] {
	const cteNames = new Set<string>();

	// 1. Try AST parsing via node-sql-parser to extract CTE table names
	try {
		const ast = sqlParser.astify(sqlQuery, { database: "postgresql" });
		if (ast && typeof ast === "object") {
			const astObj = ast as unknown as Record<string, unknown>;
			if (Array.isArray(astObj.with)) {
				for (const item of astObj.with) {
					const cteName =
						item?.name?.value ||
						(typeof item?.name === "string" ? item.name : undefined);
					if (typeof cteName === "string") {
						cteNames.add(cteName.toLowerCase());
					}
				}
			}
		}
	} catch {
		// Fall through to regex extraction
	}

	// Prepare clean SQL and resolve string literals if tokens like __STR_LITERAL_0__ are present
	let cleanSql: string;
	let resolvedLiterals: string[];

	if (sqlQuery.includes("__STR_LITERAL_")) {
		cleanSql = stripSqlComments(sqlQuery);
		resolvedLiterals = literals ?? [];
	} else {
		const masked = maskStringLiterals(sqlQuery);
		cleanSql = stripSqlComments(masked.maskedSql);
		resolvedLiterals = literals ?? masked.literals;
	}

	// Extract CTE names via regex fallback: WITH name AS ( ... ), name2 AS ( ... )
	// Supports optional double quotes around CTE identifiers
	const withMatch = cleanSql.match(
		/\bWITH\s+["']?([a-zA-Z0-9_]+)["']?\s+AS\s*\(/i,
	);
	if (withMatch?.[1]) {
		cteNames.add(withMatch[1].toLowerCase());
		const subsequentCteRegex = /,\s*["']?([a-zA-Z0-9_]+)["']?\s+AS\s*\(/gi;
		let subMatch: RegExpExecArray | null;
		while (true) {
			subMatch = subsequentCteRegex.exec(cleanSql);
			if (!subMatch) break;
			if (subMatch[1]) cteNames.add(subMatch[1].toLowerCase());
		}
	}

	const tableSet = new Set<string>();
	const reservedKeywords = new Set([
		"select",
		"where",
		"join",
		"left",
		"right",
		"inner",
		"outer",
		"from",
		"cross",
		"natural",
		"table",
		"with",
		"on",
		"using",
		"as",
		"group",
		"order",
	]);

	const resolveTableToken = (rawToken: string): string | null => {
		let token = rawToken.trim();
		// If token is masked literal __STR_LITERAL_(\d+)__
		const literalMatch = /^__STR_LITERAL_(\d+)__$/i.exec(token);
		if (literalMatch) {
			const lit = resolvedLiterals[Number(literalMatch[1])];
			if (lit) {
				token = lit.replace(/^["']|["']$/g, "").trim();
			} else {
				return null;
			}
		} else {
			token = token.replace(/^["']|["']$/g, "").trim();
		}

		const lowered = token.toLowerCase();
		if (
			lowered &&
			/^[a-zA-Z0-9_]+$/.test(lowered) &&
			!lowered.startsWith("__str_literal") &&
			!cteNames.has(lowered) &&
			!reservedKeywords.has(lowered)
		) {
			return lowered;
		}
		return null;
	};

	// 1. Match JOIN clauses: JOIN <table>, JOIN "<table>", JOIN (<table> ...), JOIN ("<table>" ...)
	const joinRegex =
		/\bJOIN\s*[(\s]*(?:([a-zA-Z0-9_]+)|__STR_LITERAL_(\d+)__|"([^"]+)")/gi;
	let match: RegExpExecArray | null;
	while (true) {
		match = joinRegex.exec(cleanSql);
		if (!match) break;
		const rawToken =
			match[1] || (match[2] ? `__STR_LITERAL_${match[2]}__` : match[3]);
		if (rawToken) {
			const resolved = resolveTableToken(rawToken);
			if (resolved) {
				tableSet.add(resolved);
			}
		}
	}

	// 2. Match FROM clauses with balanced parenthesis tracking
	// Handles: FROM table, FROM "table", FROM (table alias), FROM (customer c), (systemnote sn)
	const fromKeywordRegex = /\bFROM\s+/gi;
	while (true) {
		match = fromKeywordRegex.exec(cleanSql);
		if (!match) break;
		const startIdx = match.index + match[0].length;
		let depth = 0;
		let endIdx = startIdx;
		for (let i = startIdx; i < cleanSql.length; i++) {
			const char = cleanSql[i];
			if (char === "(") {
				depth++;
			} else if (char === ")") {
				if (depth > 0) {
					depth--;
				} else {
					// Unmatched closing parenthesis terminates FROM in subquery
					endIdx = i;
					break;
				}
			} else if (depth === 0) {
				const remaining = cleanSql.slice(i);
				if (
					/^(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST|FETCH\s+NEXT|LIMIT|OFFSET|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|FULL\s+JOIN|CROSS\s+JOIN|NATURAL\s+JOIN|UNION|WINDOW|;)/i.test(
						remaining,
					)
				) {
					endIdx = i;
					break;
				}
			}
			endIdx = i + 1;
		}

		const fromClause = cleanSql.slice(startIdx, endIdx).trim();
		if (!fromClause) continue;

		// Split comma-separated table factors strictly at depth 0
		const items: string[] = [];
		let curItem = "";
		let itemDepth = 0;
		for (let i = 0; i < fromClause.length; i++) {
			const c = fromClause[i];
			if (c === "(") itemDepth++;
			else if (c === ")") {
				if (itemDepth > 0) itemDepth--;
			} else if (c === "," && itemDepth === 0) {
				if (curItem.trim()) items.push(curItem.trim());
				curItem = "";
				continue;
			}
			curItem += c;
		}
		if (curItem.trim()) items.push(curItem.trim());

		for (const rawItem of items) {
			let item = rawItem.trim();
			// Strip outer matching parentheses: (systemnote sn) -> systemnote sn
			while (item.startsWith("(") && item.endsWith(")")) {
				let d = 0;
				let closesAtEnd = true;
				for (let i = 0; i < item.length - 1; i++) {
					if (item[i] === "(") d++;
					else if (item[i] === ")") {
						d--;
						if (d === 0) {
							closesAtEnd = false;
							break;
						}
					}
				}
				if (closesAtEnd) {
					item = item.slice(1, -1).trim();
				} else {
					break;
				}
			}
			// Strip any remaining leading open parenthesis
			item = item.replace(/^\(+/, "").trim();

			// Match first token: unquoted, double/single quoted identifier, or __STR_LITERAL_(\d+)__
			const tokenMatch =
				/^(?:([a-zA-Z0-9_]+)|__STR_LITERAL_(\d+)__|"([^"]+)"|'([^']+)')/i.exec(
					item,
				);
			if (tokenMatch) {
				const rawToken =
					tokenMatch[1] ||
					(tokenMatch[2]
						? `__STR_LITERAL_${tokenMatch[2]}__`
						: tokenMatch[3] || tokenMatch[4]);
				if (rawToken) {
					const resolved = resolveTableToken(rawToken);
					if (resolved) {
						tableSet.add(resolved);
					}
				}
			}
		}
	}

	return Array.from(tableSet);
}

/**
 * Checks if a SuiteQL query already has a pagination clause (ROWNUM or FETCH FIRST).
 */
export function hasPaginationClause(sqlQuery: string): boolean {
	const { maskedSql } = maskStringLiterals(sqlQuery);
	const cleanMasked = stripSqlComments(maskedSql);
	return (
		/\bROWNUM\b/i.test(cleanMasked) ||
		/\bFETCH\s+(?:FIRST|NEXT)\s+(?:\d+|\?|:\w+)\s+ROWS?\s+ONLY\b/i.test(
			cleanMasked,
		) ||
		/\bOFFSET\s+(?:\d+|\?|:\w+)\s+ROWS?\s+FETCH\s+(?:FIRST|NEXT)\s+(?:\d+|\?|:\w+)\s+ROWS?\s+ONLY\b/i.test(
			cleanMasked,
		)
	);
}

/**
 * Strips trailing comments (-- ... or /* ... * /) and whitespace/semicolons from the end of a SQL query.
 */
export function stripTrailingCommentsAndWhitespace(sql: string): string {
	let result = sql.trim().replace(/;+$/, "").trim();
	while (true) {
		// Strip trailing block comment /* ... */
		const blockMatch = result.match(/\/\*[\s\S]*?\*\/$/);
		if (blockMatch) {
			result = result.slice(0, -blockMatch[0].length).trim();
			continue;
		}
		// Strip trailing line comment -- ... or # ...
		// Ensure we don't accidentally match inside string literal
		const { maskedSql } = maskStringLiterals(result);
		const lineMatch = maskedSql.match(/(?:--|#)[^\r\n]*$/);
		if (lineMatch) {
			result = result.slice(0, -lineMatch[0].length).trim();
			continue;
		}
		break;
	}
	return result.replace(/;+$/, "").trim();
}

/**
 * Ensures a SuiteQL query has pagination.
 * If missing:
 * - For UNION / compound queries: wraps safely in outer query `SELECT * FROM (...) WHERE ROWNUM <= N`
 * - For standard SELECT queries: appends `FETCH FIRST N ROWS ONLY`
 */
export function ensureSuiteQLPagination(
	sqlQuery: string,
	defaultLimit = 100,
): string {
	const trimmed = stripTrailingCommentsAndWhitespace(sqlQuery);
	if (hasPaginationClause(trimmed)) {
		return trimmed;
	}

	const { maskedSql } = maskStringLiterals(trimmed);

	// Try parsing AST with node-sql-parser
	try {
		const ast = sqlParser.astify(trimmed);
		if (ast && typeof ast === "object") {
			const astObj = ast as unknown as Record<string, unknown>;
			// Check if it is a compound query (UNION, UNION ALL, INTERSECT, etc.)
			if (astObj.set_op || astObj._next) {
				return `SELECT * FROM (${trimmed}) WHERE ROWNUM <= ${defaultLimit}`;
			}
		}
	} catch {
		// Fallback to masked regex analysis if AST parsing encounters dialect specifics (e.g. BUILTIN.DF)
		if (/\bUNION\b/i.test(maskedSql)) {
			return `SELECT * FROM (${trimmed}) WHERE ROWNUM <= ${defaultLimit}`;
		}
	}

	return `${trimmed} FETCH FIRST ${defaultLimit} ROWS ONLY`;
}

/**
 * Extracts SELECT projection expressions, respecting nested parenthesis depth
 * so that FROM keywords inside functions (e.g. EXTRACT(YEAR FROM date)) or subqueries
 * do not prematurely terminate the projection clause.
 */
function extractSelectProjections(maskedSql: string): string[] {
	const projections: string[] = [];
	const selectRegex = /\bSELECT\b/gi;
	let match: RegExpExecArray | null;

	while (true) {
		match = selectRegex.exec(maskedSql);
		if (!match) break;

		// Ensure SELECT is not part of a larger identifier (e.g. my_select)
		if (
			match.index > 0 &&
			/[a-zA-Z0-9_]/.test(maskedSql[match.index - 1] ?? "")
		) {
			continue;
		}

		let cursor = match.index + match[0].length;
		// Skip optional DISTINCT or ALL keyword
		const rest = maskedSql.slice(cursor);
		const distinctMatch = rest.match(/^\s+(?:DISTINCT|ALL)\b/i);
		if (distinctMatch) {
			cursor += distinctMatch[0].length;
		}

		// Track parenthesis depth starting from cursor
		let depth = 0;
		const projStart = cursor;
		let projEnd = -1;

		for (let i = cursor; i < maskedSql.length; i++) {
			const char = maskedSql[i];
			if (char === "(") {
				depth++;
			} else if (char === ")") {
				if (depth > 0) {
					depth--;
				} else {
					// Closing parenthesis of an outer expression/subquery
					projEnd = i;
					break;
				}
			} else if (depth === 0) {
				// At depth 0, check if we encountered FROM keyword
				const slice = maskedSql.slice(i);
				if (/^\s+FROM\b/i.test(slice)) {
					projEnd = i;
					break;
				}
			}
		}

		if (projEnd === -1) {
			projEnd = maskedSql.length;
		}

		const projection = maskedSql.slice(projStart, projEnd).trim();
		if (projection.length > 0) {
			projections.push(projection);
		}
	}

	return projections;
}

/**
 * Helper to recursively peel matching balanced outer parentheses from an expression.
 * E.g. "(( * ))" -> "*" or "(item.*)" -> "item.*", while preserving "(a) + (b)".
 */
function peelOuterParentheses(expr: string): string {
	let trimmed = expr.trim();
	while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
		let depth = 0;
		let matchesOuter = false;
		for (let i = 0; i < trimmed.length; i++) {
			if (trimmed[i] === "(") {
				depth++;
			} else if (trimmed[i] === ")") {
				depth--;
				if (depth === 0) {
					if (i === trimmed.length - 1) {
						matchesOuter = true;
					}
					break;
				}
			}
		}
		if (matchesOuter) {
			trimmed = trimmed.slice(1, -1).trim();
		} else {
			break;
		}
	}
	return trimmed;
}

/**
 * Splits a SELECT projection clause into individual top-level column expressions
 * by top-level commas (depth 0), safely preserving commas inside functions (e.g. NVL(a, b)).
 */
function splitTopLevelProjections(projection: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let start = 0;

	for (let i = 0; i < projection.length; i++) {
		const char = projection[i];
		if (char === "(") {
			depth++;
		} else if (char === ")") {
			if (depth > 0) depth--;
		} else if (char === "," && depth === 0) {
			const item = projection.slice(start, i).trim();
			if (item.length > 0) {
				items.push(item);
			}
			start = i + 1;
		}
	}

	const lastItem = projection.slice(start).trim();
	if (lastItem.length > 0) {
		items.push(lastItem);
	}

	return items;
}

/**
 * Evaluates whether an individual projection item is a wildcard projection.
 * Handles:
 * - Bare asterisk: "*" or "(*)" or "(( * ))"
 * - Qualified asterisk: "item.*" or '"item".*' or "(item.*)" or '("item".*)' or "( item . * )"
 * - Optional column aliases: "(*) AS all_cols", "(item.*) AS all_cols", "(*) all_cols"
 * Ignores:
 * - Aggregate functions: "COUNT(*)", "COUNT ( * )", "COUNT(*) AS total"
 * - Arithmetic multiplication: "a.rate * a.quantity", "(a * b)", "SUM(a * b)"
 */
function isWildcardProjectionItem(rawItem: string): boolean {
	let item = rawItem.trim();
	if (!item) return false;

	// Normalize trailing alias: e.g. "(*) AS all_cols", "(item.*) AS my_item"
	item = item.replace(/\s+AS\s+(?:"[^"]+"|[a-zA-Z0-9_]+)$/i, "").trim();
	// Normalize implicit alias after closing parenthesis: e.g. "(*) all_cols"
	item = item.replace(/\)\s+(?:"[^"]+"|[a-zA-Z0-9_]+)$/i, ")").trim();

	// Peel outer matching parentheses: (( * )) -> *
	const unwrapped = peelOuterParentheses(item);

	// Check if unwrapped expression is a bare asterisk or qualified alias asterisk:
	// Bare: "*"
	// Qualified: "item.*", '"item".*', "item . *", '"item" . *'
	const wildcardRegex = /^(?:(?:"[^"]+"|[a-zA-Z0-9_]+)\s*\.\s*)*\*$/;
	return wildcardRegex.test(unwrapped);
}

/**
 * Detects whether a SuiteQL query contains any wildcard column projection (* or alias.*),
 * while correctly ignoring COUNT(*) aggregate functions, arithmetic multiplication (a * b),
 * and FROM clauses inside functions like EXTRACT(YEAR FROM trandate).
 */
function hasWildcardSelection(cleanMaskedSql: string): boolean {
	const projections = extractSelectProjections(cleanMaskedSql);
	if (projections.length === 0) return false;

	for (const projection of projections) {
		const items = splitTopLevelProjections(projection);
		for (const item of items) {
			if (isWildcardProjectionItem(item)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Evaluates whether transactionline queries contain a genuine mainline filter (= 'T' or = 'F'),
 * ensuring that:
 * 1. String literals (e.g. memo = 'mainline = T' or memo = "mainline = T") cannot spoof the filter.
 * 2. Unquoted identifiers (TOTAL, TARGET, false, t.id, tl.transaction) cannot match [TF].
 * 3. The condition is strictly evaluated inside WHERE or ON clauses (not SELECT projections or ORDER BY).
 */
export function hasMainlineFilter(
	cleanMaskedSql: string,
	literals: string[] = [],
): boolean {
	// 1. Restore only genuine single or double quoted 'T' or 'F' literals
	const sqlForMainlineCheck = cleanMaskedSql.replace(
		/__STR_LITERAL_(\d+)__/g,
		(_match, idx) => {
			const lit = literals[Number(idx)];
			if (lit && /^['"][TF]['"]$/i.test(lit)) {
				return lit;
			}
			return "__STR_LITERAL__";
		},
	);

	// 2. Extract only WHERE and ON filtering clauses (ignoring SELECT projections and ORDER BY)
	const filterClauses: string[] = [];

	// Match all WHERE clauses up to the next major SQL clause or end of statement
	const whereRegex =
		/\bWHERE\s+([\s\S]+?)(?=\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST|FETCH\s+NEXT|LIMIT|OFFSET|UNION|INTERSECT|MINUS)\b|;|$)/gi;
	let m: RegExpExecArray | null;
	while (true) {
		m = whereRegex.exec(sqlForMainlineCheck);
		if (!m) break;
		if (m[1]) {
			filterClauses.push(m[1]);
		}
	}

	// Match all ON clauses up to the next JOIN, WHERE, or other major clause
	const onRegex =
		/\bON\s+([\s\S]+?)(?=\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|NATURAL)\s+)?JOIN\b|\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST|FETCH\s+NEXT|LIMIT|OFFSET|UNION|INTERSECT|MINUS)\b|;|$)/gi;
	while (true) {
		m = onRegex.exec(sqlForMainlineCheck);
		if (!m) break;
		if (m[1]) {
			filterClauses.push(m[1]);
		}
	}

	const searchScope = filterClauses.join(" ");
	if (!searchScope.trim()) {
		return false;
	}

	// 3. Match strict mainline predicate:
	// Requires matching quotes: (['"])[TF]\1 followed by non-identifier boundary (?![a-zA-Z0-9_])
	// Also supports Yoda syntax: 'T' = tl.mainline
	const standardMainline =
		/\b(?:[a-zA-Z0-9_]+\.)?mainline\s*(?:=|IS)\s*(['"])[TF]\1(?![a-zA-Z0-9_])/i;
	const yodaMainline =
		/(['"])[TF]\1\s*(?:=|IS)\s*(?:[a-zA-Z0-9_]+\.)?mainline\b/i;

	return standardMainline.test(searchScope) || yodaMainline.test(searchScope);
}

function validateSuiteQLInternal(sqlQuery: string): SuiteQLValidationResult {
	if (
		!sqlQuery ||
		typeof sqlQuery !== "string" ||
		sqlQuery.trim().length === 0
	) {
		return {
			valid: false,
			reason:
				"SuiteQL query cannot be empty. Please provide a valid SELECT or WITH statement.",
		};
	}

	const trimmed = sqlQuery.trim();
	const { maskedSql, literals } = maskStringLiterals(trimmed);
	// Safely strip SQL comments outside string literals (preserving legitimate comments without false-positive blocks)
	const cleanMaskedSql = stripSqlComments(maskedSql).trim();
	const cleanSql = unmaskStringLiterals(cleanMaskedSql, literals).trim();

	// Check for multi-statement execution (semicolons that are not just a single trailing semicolon)
	const withoutTrailingSemicolon = cleanMaskedSql.endsWith(";")
		? cleanMaskedSql.slice(0, -1).trim()
		: cleanMaskedSql;

	if (withoutTrailingSemicolon.includes(";")) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains multiple statements separated by semicolons. Only single read-only queries are allowed per invocation (or provide 'sqlQueries' array to 'netsuite_run_suiteql' for concurrent execution).",
		};
	}

	// Must start with SELECT or WITH
	if (!/^(SELECT|WITH)\b/i.test(withoutTrailingSemicolon)) {
		return {
			valid: false,
			reason:
				"SuiteQL queries must begin with a SELECT or WITH statement. SuiteQL is strictly read-only; use record API tools for mutations.",
		};
	}

	// Check for 'SELECT *' or 'SELECT alias.*' (Gate 2 Syntax Mandate) across all projection positions
	if (hasWildcardSelection(cleanMaskedSql)) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains 'SELECT *' or wildcard projection (e.g. 'table.*'). Explicitly specify each required column name to optimize performance, prevent governance timeouts, and avoid invalid field errors.",
		};
	}

	// Check for MySQL/Postgres-style LIMIT (bare, parenthesized, parameterized, named bind, user variable, or keyword)
	// Uses negative lookbehind (?<!\bAS\s+) to avoid false positives on legitimate column aliases (e.g. creditlimit AS limit)
	if (
		/(?<!\bAS\s+)\bLIMIT\s*\(?\s*(?:\d+|\?|:\w+|\$\d+|@\w+|ALL\b|NULL\b|SELECT\b|$)/i.test(
			withoutTrailingSemicolon,
		)
	) {
		return {
			valid: false,
			reason:
				"SuiteQL does not support 'LIMIT/OFFSET' keywords in MySQL style. Use Oracle-standard 'FETCH FIRST N ROWS ONLY', 'WHERE ROWNUM <= N', or 'OFFSET M ROWS FETCH NEXT N ROWS ONLY' for pagination.",
		};
	}

	// Check for invalid standalone OFFSET (Oracle SuiteQL requires: OFFSET M ROWS FETCH NEXT N ROWS ONLY)
	if (
		/\bOFFSET\s+(?:\d+|\?|:\w+)/i.test(withoutTrailingSemicolon) &&
		!/\bOFFSET\s+(?:\d+|\?|:\w+)\s+ROWS?\s+FETCH\s+(?:FIRST|NEXT)\s+(?:\d+|\?|:\w+)\s+ROWS?\s+ONLY\b/i.test(
			withoutTrailingSemicolon,
		)
	) {
		return {
			valid: false,
			reason:
				"Invalid OFFSET syntax. SuiteQL requires Oracle-standard offset syntax: 'OFFSET M ROWS FETCH NEXT N ROWS ONLY', or 'FETCH FIRST N ROWS ONLY'.",
		};
	}

	// Dialect Linter 1: Non-standard MySQL/Postgres date functions
	if (/\b(?:NOW|CURDATE)\s*\(\s*\)/i.test(withoutTrailingSemicolon)) {
		return {
			valid: false,
			reason:
				"Non-Oracle date function detected ('NOW()' or 'CURDATE()'). In Oracle NetSuite SuiteQL, use 'SYSDATE' or 'CURRENT_DATE' instead (e.g. `WHERE trandate >= SYSDATE - 30`).",
		};
	}

	// Dialect Linter 2: Non-standard null replacement functions
	if (/\b(?:IFNULL|ISNULL)\s*\(/i.test(withoutTrailingSemicolon)) {
		return {
			valid: false,
			reason:
				"Non-Oracle null function detected ('IFNULL()' or 'ISNULL()'). In Oracle NetSuite SuiteQL, use 'NVL(expr, replacement)' or standard ANSI 'COALESCE(expr, replacement)' instead.",
		};
	}

	// Dialect Linter 3: Non-standard string aggregation function
	if (/\bGROUP_CONCAT\s*\(/i.test(withoutTrailingSemicolon)) {
		return {
			valid: false,
			reason:
				"Non-Oracle aggregation function detected ('GROUP_CONCAT()'). In Oracle NetSuite SuiteQL, use 'LISTAGG(column, \", \") WITHIN GROUP (ORDER BY ...)' instead.",
		};
	}

	// Dialect Linter 4: Subquery in FROM or JOIN clause (Derived Tables / Inline Views)
	if (/\b(?:FROM|JOIN)\s*\(\s*SELECT\b/i.test(withoutTrailingSemicolon)) {
		return {
			valid: false,
			reason:
				"Derived tables / subqueries in FROM or JOIN clauses ('FROM (SELECT ...)') are strictly unsupported by Oracle NetSuite SuiteQL. Please rewrite the query using a Common Table Expression (CTE: `WITH cte_name AS (SELECT ...) SELECT ... FROM cte_name`) or flatten into direct joins.",
		};
	}

	// Check for DDL/DML disallowed keywords in the masked SQL (ignores string literal contents)
	const match = DISALLOWED_KEYWORDS_REGEX.exec(withoutTrailingSemicolon);
	if (match) {
		return {
			valid: false,
			reason: `SuiteQL query contains disallowed mutation or DDL keyword: '${match[1]}'. Only read-only queries are permitted. Use netsuite_create_record or netsuite_update_record for data mutations.`,
		};
	}

	const tables = extractReferencedTables(cleanMaskedSql, literals);
	const hasPagination = hasPaginationClause(cleanMaskedSql);

	// --- Slow Query Anti-Pattern Checks & Smart Routing Guidance ---

	// Anti-Pattern 1: Prohibited SystemNote JOIN or Unindexed Full-Table Scan (SAFE Guide Pitfall 11)
	if (tables.includes("systemnote")) {
		if (tables.length > 1) {
			return {
				valid: false,
				reason:
					"Prohibited 'JOIN SystemNote': Joining 'SystemNote' directly with other tables causes severe query timeouts due to massive table volume. Please execute a standalone query against SystemNote with tight filters on 'recordid' and a narrow date range instead.",
			};
		}
		// Standalone SystemNote query must filter by recordid in WHERE clause to avoid catastrophic full-table scan (>60s timeout)
		const whereMatch =
			/\bWHERE\s+([\s\S]+?)(?:\s+(?:GROUP\s+BY|ORDER\s+BY|FETCH\s+FIRST)|;|$)/i.exec(
				cleanMaskedSql,
			);
		const whereClause = whereMatch?.[1] || "";
		if (!/\brecordid\b/i.test(whereClause)) {
			return {
				valid: false,
				reason:
					"Unindexed 'systemnote' scan: NetSuite 'systemnote' contains tens of millions of audit log records across the entire tenant. Querying 'systemnote' without filtering by 'recordid' causes catastrophic full-table scan timeouts (>60s). Please include a specific `recordid = ...` filter, or use the specialized tool `netsuite_get_system_notes`.",
			};
		}
	}

	// Anti-Pattern 2: 'createdfrom' field location on transaction header
	if (tables.includes("transaction")) {
		const tranAliasRegex =
			/\b(?:FROM|JOIN)\s+transaction\s+(?:AS\s+)?([a-zA-Z0-9_]+)/gi;
		const tranAliases = new Set<string>(["transaction", "t"]);
		let tranAliasMatch: RegExpExecArray | null;
		while (true) {
			tranAliasMatch = tranAliasRegex.exec(cleanMaskedSql);
			if (!tranAliasMatch) break;
			const alias = tranAliasMatch[1]?.toLowerCase().trim();
			if (
				alias &&
				![
					"where",
					"join",
					"left",
					"right",
					"inner",
					"outer",
					"cross",
					"on",
					"group",
					"order",
				].includes(alias)
			) {
				tranAliases.add(alias);
			}
		}

		let hasHeaderCreatedFrom = false;
		for (const alias of tranAliases) {
			if (
				new RegExp(`\\b${alias}\\.createdfrom\\b`, "i").test(cleanMaskedSql)
			) {
				hasHeaderCreatedFrom = true;
				break;
			}
		}

		if (
			hasHeaderCreatedFrom ||
			(!tables.includes("transactionline") && /\bcreatedfrom\b/i.test(cleanSql))
		) {
			return {
				valid: false,
				reason:
					"Invalid field location 'createdfrom': In NetSuite SuiteQL, 'createdfrom' does NOT exist on the 'transaction' header table; it is a column on 'transactionline'. Please join transactionline to query lineage (e.g. `JOIN transactionline tl ON t.id = tl.transaction WHERE tl.createdfrom = :id AND tl.mainline = 'T'`).",
			};
		}
	}

	// Anti-Pattern 3: Suboptimal table 'inventoryitemlocations' for general inventory
	if (
		tables.includes("inventoryitemlocations") &&
		!/\b(?:[a-zA-Z0-9_]+\.)?(?:itemtype|type)\s*=\s*['"]?InvtPart['"]?/i.test(
			cleanSql,
		)
	) {
		return {
			valid: false,
			reason:
				"Suboptimal table 'inventoryitemlocations': 'inventoryitemlocations' only contains standard inventory items (InvtPart) and omits Assembly, Lot-numbered, and Serialized items. For complete cross-item location stock (quantityOnHand, quantityAvailable, quantityOnOrder, averageCostMli), use the unified 'aggregateitemlocation' table instead: `SELECT a.item, a.location, a.quantityOnHand, a.quantityAvailable, a.quantityOnOrder, a.averageCostMli FROM aggregateitemlocation a`.",
		};
	}

	// Anti-Pattern 4: 'transactionline' missing 'mainline' filter
	if (
		tables.includes("transactionline") &&
		!hasMainlineFilter(cleanMaskedSql, literals)
	) {
		return {
			valid: false,
			reason:
				"Missing 'mainline' filter on 'transactionline': NetSuite 'transactionline' rows contain both header summary (mainline = 'T') and line items (mainline = 'F'). Omitting this filter causes row duplication and distorted sum amounts. Add `tl.mainline = 'F'` (for line item details) or `tl.mainline = 'T'` (for transaction header line) to your WHERE clause.",
		};
	}

	// Anti-Pattern 4b: Invalid column 'previousline' on 'transactionline'
	if (
		tables.includes("transactionline") &&
		/\bpreviousline\b/i.test(withoutTrailingSemicolon)
	) {
		return {
			valid: false,
			reason:
				"Invalid column 'previousline': The 'previousline' column does not exist on 'transactionline' in the NetSuite2.com SuiteQL schema. To trace upstream or downstream order relationships, join transactionline via 'createdfrom' (e.g. `JOIN transactionline tl ON t.id = tl.transaction WHERE tl.createdfrom = :sourceTranId`).",
		};
	}

	// Anti-Pattern 5: Invalid column 'recordtype' on 'item' table
	if (tables.includes("item")) {
		const itemAliasRegex =
			/\b(?:FROM|JOIN)\s+item\s+(?:AS\s+)?([a-zA-Z0-9_]+)/gi;
		const itemAliases = new Set<string>(["item"]);
		let aliasMatch: RegExpExecArray | null;
		while (true) {
			aliasMatch = itemAliasRegex.exec(cleanMaskedSql);
			if (!aliasMatch) break;
			const alias = aliasMatch[1]?.toLowerCase().trim();
			if (
				alias &&
				![
					"where",
					"join",
					"left",
					"right",
					"inner",
					"outer",
					"cross",
					"on",
					"group",
					"order",
				].includes(alias)
			) {
				itemAliases.add(alias);
			}
		}

		for (const alias of itemAliases) {
			const aliasDotRecordType = new RegExp(`\\b${alias}\\.recordtype\\b`, "i");
			if (aliasDotRecordType.test(cleanMaskedSql)) {
				return {
					valid: false,
					reason: `Invalid column '${alias}.recordtype' on 'item': In NetSuite SuiteQL, the 'item' table does NOT have a 'recordtype' column. Use '${alias}.itemtype' (e.g. 'Assembly', 'InvtPart', 'Kit', 'NonInvtPart', 'Service') or '${alias}.subtype' instead. ('recordtype' is exclusively used on 'transaction' and 'entity' tables).`,
				};
			}
		}

		// Also check if query has item but no transaction/entity and queries bare 'recordtype'
		if (
			!tables.includes("transaction") &&
			!tables.includes("entity") &&
			!tables.includes("customrecordtype") &&
			/\brecordtype\b/i.test(cleanMaskedSql)
		) {
			return {
				valid: false,
				reason:
					"Invalid column 'recordtype': 'recordtype' does not exist on the 'item' table. In NetSuite SuiteQL, use 'itemtype' (e.g. 'Assembly', 'InvtPart', 'Kit', 'NonInvtPart', 'Service') or 'subtype' to filter or group items.",
			};
		}
	}

	// Anti-Pattern 6: Unindexed query against 'transaction' + 'transactionline'
	if (tables.includes("transaction") && tables.includes("transactionline")) {
		const whereMatch =
			/\bWHERE\s+([\s\S]+?)(?:\s+(?:GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST)|;|$)/i.exec(
				cleanMaskedSql,
			);
		const whereClause = whereMatch?.[1] || "";

		// Also extract all ON conditions across JOINs so driving index filters in ON clauses are recognized
		const onMatches =
			cleanMaskedSql.match(
				/\bON\s+([\s\S]+?)(?:\b(?:JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|FETCH\s+FIRST)\b|;|$)/gi,
			) || [];
		const combinedSearchTarget = `${whereClause} ${onMatches.join(" ")}`;

		const hasDrivingFilter =
			/\b(tranid|otherrefnum|trandate|datecreated|type|recordtype|entity|item|subsidiary|location|createdfrom|status)\s*(?:=|IN|<|>|BETWEEN|LIKE|>=|<=)/i.test(
				combinedSearchTarget,
			) ||
			/\b(?:t\.|tl\.|transaction\.|transactionline\.)?(?:id|internalid|transaction)\s*(?:=|IN|<|>|BETWEEN|LIKE|>=|<=)\s*(?:\d+|__STR_LITERAL_\d+__|\?|\()/i.test(
				combinedSearchTarget,
			);

		if (!hasDrivingFilter) {
			return {
				valid: false,
				reason:
					"Unindexed query against 'transaction' + 'transactionline': Queries joining transaction tables MUST include at least one indexed driving filter in the WHERE clause (such as 'trandate', 'type', 'id', 'tranid', 'entity', 'subsidiary', or 'item') to prevent full-table scan timeouts. Example: `WHERE t.type = 'SalesOrd' AND t.trandate >= TO_DATE('2025-01-01', 'YYYY-MM-DD') AND tl.mainline = 'F'`.",
			};
		}
	}

	// Anti-Pattern 7: Heavy aggregation with HAVING but missing driving WHERE filter
	if (
		tables.includes("transaction") &&
		/\bGROUP\s+BY\b/i.test(cleanMaskedSql) &&
		/\bHAVING\b/i.test(cleanMaskedSql)
	) {
		const whereMatch = /\bWHERE\s+([\s\S]+?)(?:\s+GROUP\s+BY)/i.exec(
			cleanMaskedSql,
		);
		const whereClause = whereMatch?.[1] || "";

		// Also extract ON conditions (consistent with Anti-Pattern 6)
		const onMatchesAP7 =
			cleanMaskedSql.match(
				/\bON\s+([\s\S]+?)(?:\b(?:JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|FETCH\s+FIRST)\b|;|$)/gi,
			) || [];
		const combinedSearchTargetAP7 = `${whereClause} ${onMatchesAP7.join(" ")}`;

		const hasIndexedWhere =
			/\b(tranid|otherrefnum|trandate|datecreated|type|recordtype|entity|item|subsidiary|location|createdfrom|status|previousType|nextType|previousDoc|nextDoc)\s*(?:=|IN|<|>|BETWEEN|LIKE|>=|<=)/i.test(
				combinedSearchTargetAP7,
			) ||
			/\b(?:t\.|tl\.|transaction\.|transactionline\.)?(?:id|internalid|transaction)\s*(?:=|IN|<|>|BETWEEN|LIKE|>=|<=)\s*(?:\d+|__STR_LITERAL_\d+__|\?|\()/i.test(
				combinedSearchTargetAP7,
			);
		if (!hasIndexedWhere) {
			return {
				valid: false,
				reason:
					"Unindexed aggregation query with HAVING: Filtering aggregated groups using HAVING without a driving indexed filter in the WHERE clause forces a full-table scan across transactions before grouping. Add driving WHERE filters (e.g. `WHERE t.trandate >= TO_DATE(...) AND t.type = 'SalesOrd'`) before the GROUP BY clause.",
			};
		}
	}

	// Anti-Pattern 8: Function conversion in JOIN ON clause against transactionline/transaction
	// (SAFE Guide Principle 3: Wrapping join keys in functions invalidates Oracle B-tree index lookup and forces 60s full table scans)
	if (tables.includes("transactionline") || tables.includes("transaction")) {
		const onClauseMatches = cleanMaskedSql.matchAll(
			/\bJOIN\s+(?:transactionline|transaction)\b[\s\S]*?\bON\b([\s\S]*?)(?=\b(?:WHERE|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|GROUP|ORDER|FETCH|UNION)\b|$)/gi,
		);
		for (const m of onClauseMatches) {
			const onClause = m[1] || "";
			if (/\b(?:TO_NUMBER|TO_CHAR)\s*\(/i.test(onClause)) {
				return {
					valid: false,
					reason:
						"Performance hazard: Function conversion (e.g. TO_NUMBER/TO_CHAR) detected in JOIN ON clause against 'transactionline' or 'transaction'. In NetSuite SuiteQL, wrapping join keys in functions invalidates Oracle B-tree index lookup and forces full-table nested loop scans, leading to 60s timeouts or socket hang up. Please remove functions from the JOIN ON clause, pre-cast/filter in an inner query or CTE, or join on native numeric keys.",
				};
			}
		}
	}

	return { valid: true, tables, hasPagination };
}

/**
 * Validates a SuiteQL query string for security compliance.
 * Utilizes in-memory LRU cache to avoid redundant AST & regex parsing overhead.
 */
export function validateSuiteQL(sqlQuery: string): SuiteQLValidationResult {
	if (
		!sqlQuery ||
		typeof sqlQuery !== "string" ||
		sqlQuery.trim().length === 0
	) {
		return {
			valid: false,
			reason:
				"SuiteQL query cannot be empty. Please provide a valid SELECT or WITH statement.",
		};
	}

	const trimmed = sqlQuery.trim();
	const cached = validationCache.get(trimmed);
	if (cached) {
		return cached;
	}

	const result = validateSuiteQLInternal(trimmed);
	validationCache.set(trimmed, result);
	return result;
}

/**
 * Asserts that a SuiteQL query is valid. Throws SuiteQLValidationError if invalid.
 */
export function assertValidSuiteQL(sqlQuery: string): void {
	const result = validateSuiteQL(sqlQuery);
	if (!result.valid) {
		throw new SuiteQLValidationError(
			`❌ SuiteQL Security Guardrail Violation: ${result.reason}`,
		);
	}
}

export interface SuiteQLErrorDiagnosis {
	isDiagnosed: boolean;
	summary: string;
	rootCause: string;
	officialGuidance: string;
	suggestedFix?: string;
	selfHealingAction: string;
}

/**
 * Diagnoses NetSuite runtime SuiteQL errors or guardrail rejection reasons,
 * providing actionable self-healing guidance and official NetSuite suggestions.
 */
export function diagnoseSuiteQLError(
	rawError: string,
	sqlQuery?: string,
): SuiteQLErrorDiagnosis {
	const err = (rawError || "").trim();
	const sql = (sqlQuery || "").trim();

	// 0. The "False near: FETCH Trap" (Derived from netsuite-full-tools real-world telemetry)
	if (
		/failed to parse sql[\s\S]*near:\s*FETCH/i.test(err) ||
		/syntax error[\s\S]*near:\s*FETCH/i.test(err)
	) {
		return {
			isDiagnosed: true,
			summary: "Preceding Syntax/Column Error (The False 'near: FETCH' Trap)",
			rootCause:
				"NetSuite SuiteQL fully supports 'FETCH FIRST N ROWS ONLY'. The parser encountered an invalid column name, missing comma, or unbalanced expression immediately before the FETCH clause and derailed onto the FETCH token.",
			officialGuidance:
				"DO NOT remove 'FETCH FIRST' or convert it to MySQL 'LIMIT' (which is completely invalid in NetSuite). Inspect the column list or WHERE clause immediately before 'FETCH'. You can test individual columns or use 'WHERE ROWNUM <= N' to locate the offending column.",
			suggestedFix: "SELECT id, tranid FROM transaction WHERE ROWNUM <= 10",
			selfHealingAction:
				"Keep Oracle-standard pagination. Check the column list and WHERE condition directly preceding the FETCH clause for typos or missing commas.",
		};
	}

	// 0b. Duplicate column alias
	if (/duplicate alias|QUERY_DUPLICATE_ALIAS|SSS_DUPLICATE_ALIAS/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Duplicate Column Alias in SELECT Clause",
			rootCause:
				"Two or more projected columns share the identical AS alias name. In NetSuite SuiteQL, each column alias must be unique across the projection.",
			officialGuidance:
				"Assign distinct alias names to each projected column (e.g. 'AS col1', 'AS col2').",
			suggestedFix:
				"SELECT t.id AS tran_id, tl.id AS line_id, t.tranid FROM transaction t JOIN transactionline tl ON t.id = tl.transaction",
			selfHealingAction: "Rename conflicting column aliases to unique names.",
		};
	}

	// 0c. Ambiguous column reference
	if (/ambiguous column|ambiguously defined/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Ambiguous Column Reference in Joined Tables",
			rootCause:
				"The specified column exists in multiple joined tables (e.g. 'id', 'lastmodifieddate', 'subsidiary', 'memo'). NetSuite cannot determine which table to read from.",
			officialGuidance:
				"Prefix the column name with the appropriate table alias (e.g. 't.id' or 'tl.id').",
			suggestedFix:
				"SELECT t.id, t.tranid, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction",
			selfHealingAction:
				"Prefix ambiguous column(s) with their specific table alias.",
		};
	}

	// 0d. GROUP BY non-aggregated expression
	if (
		/not a GROUP BY expression|not a single-group group function|must appear in the GROUP BY/i.test(
			err,
		)
	) {
		return {
			isDiagnosed: true,
			summary: "Invalid GROUP BY Expression (Non-Aggregated Column)",
			rootCause:
				"When mixing aggregate functions (SUM, COUNT, AVG, MAX, MIN) with regular columns, Oracle NetSuite requires EVERY non-aggregated column in SELECT to appear in the GROUP BY clause.",
			officialGuidance:
				"Add all non-aggregated SELECT columns to the GROUP BY clause, or reference them by ordinal column position (e.g. GROUP BY 1, 2).",
			suggestedFix:
				"SELECT t.type, t.entity, COUNT(*), SUM(t.foreigntotal) FROM transaction t GROUP BY t.type, t.entity",
			selfHealingAction:
				"Add missing non-aggregated columns to the GROUP BY clause.",
		};
	}

	// 0e. Invalid JOIN relationship
	if (/QUERY_INVALID_JOIN|invalid join/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Invalid Table JOIN (No Direct Relationship)",
			rootCause:
				"The two joined tables do not have a direct foreign key relationship in NetSuite SuiteQL schema.",
			officialGuidance:
				"Verify valid join paths via 'netsuite_get_metadata'. For example, join 'transaction' to 'item' through 'transactionline'.",
			suggestedFix:
				"SELECT t.id, tl.item, i.itemid FROM transaction t JOIN transactionline tl ON t.id = tl.transaction JOIN item i ON tl.item = i.id",
			selfHealingAction:
				"Call netsuite_get_metadata to verify foreign keys and join through linking tables (such as transactionline).",
		};
	}

	// 0f. Invalid or unsupported search (Derived table / inline view, BUILTIN.DF in GROUP BY, or unsupported query construct)
	if (/invalid or unsupported search/i.test(err)) {
		if (/\b(?:FROM|JOIN)\s*\(\s*SELECT\b/i.test(sql)) {
			return {
				isDiagnosed: true,
				summary: "Unsupported Subquery in FROM/JOIN Clause (Derived Table)",
				rootCause:
					"NetSuite SuiteQL does not support derived tables or inline subqueries in the FROM or JOIN clause (e.g. 'FROM (SELECT ...)').",
				officialGuidance:
					"Rewrite using a Common Table Expression (CTE): `WITH cte_name AS (SELECT ...) SELECT ... FROM cte_name` or flatten the query into direct joins.",
				suggestedFix:
					"WITH summary AS (SELECT item, COUNT(*) AS cnt FROM customrecord_xxx GROUP BY item) SELECT * FROM summary",
				selfHealingAction:
					"Replace 'FROM (SELECT ...)' with a CTE (`WITH cte_name AS (...) SELECT ...`) or flatten the query.",
			};
		}
		if (/BUILTIN\.DF\s*\(/i.test(sql) && /\bGROUP\s+BY\b/i.test(sql)) {
			return {
				isDiagnosed: true,
				summary: "Unsupported 'BUILTIN.DF()' in Grouped Query",
				rootCause:
					"NetSuite SuiteQL does not support applying 'BUILTIN.DF()' directly on grouped expressions in aggregate queries.",
				officialGuidance:
					"Query the underlying numeric ID in the grouped query, or wrap with a CTE (`WITH data AS (SELECT col, COUNT(*) AS cnt FROM ... GROUP BY col) SELECT BUILTIN.DF(col), cnt FROM data`).",
				suggestedFix:
					"WITH grp AS (SELECT status, COUNT(*) AS cnt FROM customrecord_xxx GROUP BY status) SELECT BUILTIN.DF(status), cnt FROM grp",
				selfHealingAction:
					"Remove BUILTIN.DF from the GROUP BY query or wrap the aggregation in a CTE.",
			};
		}
		return {
			isDiagnosed: true,
			summary: "Invalid or Unsupported Search Specification",
			rootCause:
				"NetSuite SuiteQL rejected the query structure (typically caused by FROM subqueries, unsupported window functions, or unsupported functions in GROUP BY clauses).",
			officialGuidance:
				"Ensure queries follow Oracle NetSuite SuiteQL standards: avoid derived tables in FROM, avoid unsupported functions in GROUP BY, and verify valid column references via netsuite_get_metadata.",
			suggestedFix:
				"Inspect referenced tables using netsuite_get_metadata, eliminate nested FROM subqueries, and simplify GROUP BY expressions.",
			selfHealingAction:
				"1. Flatten FROM subqueries into CTEs (`WITH ...`). 2. Verify column names with netsuite_get_metadata.",
		};
	}

	// 1. Unknown identifier: createdfrom on transaction
	if (
		/unknown identifier ['"]?createdfrom['"]?/i.test(err) ||
		/Invalid field location 'createdfrom'/i.test(err) ||
		(sql &&
			/\bcreatedfrom\b/i.test(sql) &&
			/\btransaction\b/i.test(sql) &&
			!/\btransactionline\b/i.test(sql))
	) {
		return {
			isDiagnosed: true,
			summary: "Invalid Field Location: 'createdfrom'",
			rootCause:
				"In NetSuite SuiteQL, 'createdfrom' does NOT exist on the 'transaction' header table; it is exclusively a column on 'transactionline'.",
			officialGuidance:
				"To query upstream transaction lineage (e.g. PO from SO, IR from PO, IF from SO), join 'transactionline' and filter on 'tl.createdfrom'.",
			suggestedFix:
				"SELECT t.id, t.tranid, t.type FROM transactionline tl JOIN transaction t ON t.id = tl.transaction WHERE tl.createdfrom = :upstream_id AND tl.mainline = 'T'",
			selfHealingAction:
				"Join 'transactionline' and query 'tl.createdfrom' with tl.mainline = 'T'.",
		};
	}

	// 2. Unknown identifier: recordtype on item
	if (
		/Invalid column '.*recordtype' on 'item'/i.test(err) ||
		(/unknown identifier ['"]?recordtype['"]?/i.test(err) &&
			sql &&
			/\bitem\b/i.test(sql)) ||
		(sql &&
			/\bitem\b/i.test(sql) &&
			!/\btransaction\b/i.test(sql) &&
			!/\bentity\b/i.test(sql) &&
			/\brecordtype\b/i.test(sql))
	) {
		return {
			isDiagnosed: true,
			summary: "Invalid Column on 'item' Table: 'recordtype'",
			rootCause:
				"In NetSuite SuiteQL, 'recordtype' exists exclusively on 'transaction' (e.g. custinvc, salesord) and 'entity' records. The 'item' table uses 'itemtype' (e.g. 'Assembly', 'InvtPart', 'Service', 'Kit') and 'subtype' instead.",
			officialGuidance:
				"Query 'itemtype' or 'subtype' on 'item'. Use values such as 'Assembly', 'InvtPart', 'Kit', 'NonInvtPart', 'Service' for item type classification.",
			suggestedFix:
				"SELECT id, itemid, itemtype, subtype, displayname FROM item WHERE itemtype = 'Assembly' AND isinactive = 'F'",
			selfHealingAction:
				"Replace all occurrences of 'recordtype' on 'item' with 'itemtype' or 'subtype' and re-run query.",
		};
	}

	// 2. Table not found: bin / oa_tables / generic
	if (
		/record ['"]?bin['"]? was not found/i.test(err) ||
		/invalid search type: bin/i.test(err)
	) {
		return {
			isDiagnosed: true,
			summary: "Table Not Directly Accessible: 'bin'",
			rootCause:
				"The table 'bin' is not directly queryable via SuiteQL in this account configuration.",
			officialGuidance:
				"Use 'inventorybalance' to query bin-level inventory balances, bin numbers, and status breakdown.",
			suggestedFix:
				"SELECT item, location, binnumber, inventorynumber, quantityavailable, quantityonhand FROM inventorybalance WHERE location = :loc_id",
			selfHealingAction: "Rewrite the query against 'inventorybalance' table.",
		};
	}

	if (
		/record ['"]?([a-zA-Z0-9_]+)['"]? was not found/i.test(err) ||
		/invalid search type: ([a-zA-Z0-9_]+)/i.test(err)
	) {
		const match =
			/record ['"]?([a-zA-Z0-9_]+)['"]? was not found/i.exec(err) ||
			/invalid search type: ([a-zA-Z0-9_]+)/i.exec(err);
		const tableName = match?.[1] || "unknown";

		return {
			isDiagnosed: true,
			summary: `Non-Existent or Disabled Table: '${tableName}'`,
			rootCause: `Table '${tableName}' does not exist in NetSuite's SuiteQL schema or the corresponding feature is disabled.`,
			officialGuidance:
				"Verify available tables by calling `netsuite_get_metadata({ keyword: '...' })` or check NetSuite Records Catalog.",
			selfHealingAction: `Call netsuite_get_metadata({ keyword: '${tableName}' }) to discover the correct table name.`,
		};
	}

	// 3. Generic Unknown identifier
	if (/unknown identifier ['"]?([a-zA-Z0-9_]+)['"]?/i.test(err)) {
		const match = /unknown identifier ['"]?([a-zA-Z0-9_]+)['"]?/i.exec(err);
		const colName = match?.[1] || "unknown";
		const tables = sql ? extractReferencedTables(sql) : [];
		const tableContext =
			tables.length > 0 ? ` on table(s): ${tables.join(", ")}` : "";

		return {
			isDiagnosed: true,
			summary: `Unknown Field/Column: '${colName}'`,
			rootCause: `Column '${colName}' was not recognized${tableContext}. Field names are case-sensitive and vary by custom fields (custbody_*, custrecord_*, custitem_*).`,
			officialGuidance: `Inspect the exact column definitions for ${tables[0] || "the table"} using netsuite_get_metadata.`,
			selfHealingAction: `Call netsuite_get_metadata({ table: '${tables[0] || "tableName"}' }) to verify valid column names.`,
		};
	}

	// 4. Suboptimal table inventoryitemlocations
	if (
		/Suboptimal table 'inventoryitemlocations'/i.test(err) ||
		(sql &&
			/\binventoryitemlocations\b/i.test(sql) &&
			!/\b(itemtype|type)\s*=/i.test(sql))
	) {
		return {
			isDiagnosed: true,
			summary: "Suboptimal Table: 'inventoryitemlocations'",
			rootCause:
				"'inventoryitemlocations' only contains standard raw materials (InvtPart) and omits Assembly, Lot-numbered, and Serialized items.",
			officialGuidance:
				"Use 'aggregateitemlocation' for unified multi-location stock across all item types.",
			suggestedFix:
				"SELECT a.item, BUILTIN.DF(a.item) AS item_name, a.location, BUILTIN.DF(a.location) AS loc_name, a.quantityOnHand, a.quantityAvailable, a.quantityOnOrder, a.averageCostMli FROM aggregateitemlocation a WHERE a.location = :loc_id",
			selfHealingAction:
				"Switch query table from 'inventoryitemlocations' to 'aggregateitemlocation'.",
		};
	}

	// 5. Statement execution timeout or socket hang up
	if (
		/timeout of \d+ms exceeded/i.test(err) ||
		/\b(?:query|statement|request|connection)\s+timed?\s*out\b/i.test(err) ||
		/socket hang up/i.test(err) ||
		/\bECONNABORTED\b/i.test(err) ||
		/\bETIMEDOUT\b/i.test(err)
	) {
		const hasFunctionInJoin =
			sql &&
			/\bON\b[\s\S]*?\b(?:TO_NUMBER|TO_CHAR|UPPER|LOWER)\s*\(/i.test(sql);
		const hasSystemNote = sql && /\bsystemnote\b/i.test(sql);

		let specificRootCause =
			"NetSuite database statement execution exceeded the 60-second limit and was terminated.";
		let specificGuidance =
			"Add selective indexed filters in WHERE clause (e.g. narrow 'trandate' range, 'type', 'id', 'entity').";

		if (hasFunctionInJoin) {
			specificRootCause =
				"Type conversion function detected in JOIN ON clause (e.g. TO_NUMBER/TO_CHAR). This invalidates B-tree indexes on large tables (like transactionline) and forces massive full table scans resulting in 60s timeout or socket hang up.";
			specificGuidance =
				"Eliminate type-casting functions in JOIN ON clauses. Pre-cast or filter IDs in an inner query/CTE, or ensure matching numeric foreign key columns.";
		} else if (hasSystemNote) {
			specificRootCause =
				"Querying 'systemnote' without indexed filters or with broad range causes full-table scans across millions of audit records.";
			specificGuidance =
				"Filter 'systemnote' strictly by 'recordid' and a narrow date range, or use the dedicated 'netsuite_get_system_notes' tool.";
		}

		return {
			isDiagnosed: true,
			summary:
				"Statement Execution Timeout (60s Limit Exceeded) / Connection Severed",
			rootCause: specificRootCause,
			officialGuidance: specificGuidance,
			suggestedFix:
				"Filter by indexed fields (id, tranid, type, trandate >= TO_DATE(...)), eliminate functions in JOIN ON clauses, and enforce tl.mainline = 'T' or 'F'.",
			selfHealingAction:
				"Optimize query: 1. Add selective indexed WHERE filters. 2. Remove functions in JOIN ON clauses. 3. Avoid scanning broad tables like systemnote without recordid.",
		};
	}

	// 6. Function conversion in JOIN ON clause
	if (/Function conversion .*? detected in JOIN ON clause/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Function Conversion in JOIN ON Clause (Performance Hazard)",
			rootCause:
				"Using functions like TO_NUMBER() or TO_CHAR() in JOIN ON conditions invalidates B-tree indexes on transactionline/transaction.",
			officialGuidance:
				"Join on clean numeric IDs directly or use a CTE/subquery to cast and pre-filter before joining.",
			suggestedFix:
				"WITH pre_filtered AS (SELECT TO_NUMBER(custcol_link) AS linked_id FROM ...) SELECT ... FROM pre_filtered p JOIN transactionline tl ON tl.createdfrom = p.linked_id",
			selfHealingAction: "Remove TO_NUMBER/TO_CHAR from the JOIN ON condition.",
		};
	}

	// 7. Unindexed SystemNote scan
	if (/Unindexed 'systemnote' scan/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Unindexed Full-Table Scan on SystemNote",
			rootCause:
				"NetSuite 'systemnote' contains tens of millions of audit log records across the entire tenant. Querying without 'recordid' causes catastrophic 60s full-table scan timeouts.",
			officialGuidance:
				"Always filter systemnote by 'recordid' (e.g. `WHERE recordid = 12345`) or use the specialized 'netsuite_get_system_notes' tool.",
			suggestedFix:
				"SELECT recordid, field, oldvalue, newvalue, date, BUILTIN.DF(name) AS author FROM systemnote WHERE recordtypeid = -30 AND recordid = :id AND date >= TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD')",
			selfHealingAction:
				"Add `recordid = <internal_id>` to the WHERE clause, or call `netsuite_get_system_notes` directly.",
		};
	}

	// 8. Missing mainline filter
	const hasMissingMainlineInSql = Boolean(
		sql &&
			extractReferencedTables(sql).includes("transactionline") &&
			(() => {
				const { maskedSql: mSql, literals: lits } = maskStringLiterals(sql);
				const cleanM = stripSqlComments(mSql);
				return !hasMainlineFilter(cleanM, lits);
			})(),
	);
	if (/Missing 'mainline' filter/i.test(err) || hasMissingMainlineInSql) {
		return {
			isDiagnosed: true,
			summary: "Missing 'mainline' Filter on 'transactionline'",
			rootCause:
				"NetSuite 'transactionline' contains both header summary lines (mainline = 'T') and line items (mainline = 'F'). Omitting this filter causes row duplication and 2x inflated totals.",
			officialGuidance:
				"Add `tl.mainline = 'F'` for line-item details or `tl.mainline = 'T'` for transaction header line.",
			suggestedFix:
				"SELECT t.id, t.tranid, tl.item, tl.quantity, tl.rate, tl.amount FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd' AND tl.mainline = 'F'",
			selfHealingAction:
				"Add `tl.mainline = 'F'` (for line items) or `tl.mainline = 'T'` (for transaction header line) to your WHERE clause.",
		};
	}

	// 6. LIMIT / OFFSET dialect error
	if (
		/\bLIMIT\s+(?:\d+|\?|:\w+|\$\d+)/i.test(err) ||
		/\bLIMIT\s+(?:\d+|\?|:\w+|\$\d+)/i.test(sql) ||
		/Invalid OFFSET syntax/i.test(err) ||
		/does not support MySQL-style 'LIMIT'/i.test(err)
	) {
		return {
			isDiagnosed: true,
			summary: "Unsupported Dialect Keyword: LIMIT / Invalid OFFSET",
			rootCause:
				"NetSuite SuiteQL does not support MySQL/Postgres-style 'LIMIT' syntax.",
			officialGuidance:
				"Use Oracle-standard pagination: 'FETCH FIRST N ROWS ONLY', 'WHERE ROWNUM <= N', or 'OFFSET M ROWS FETCH NEXT N ROWS ONLY'.",
			suggestedFix:
				"FETCH FIRST 100 ROWS ONLY (or OFFSET M ROWS FETCH NEXT N ROWS ONLY)",
			selfHealingAction:
				"Replace MySQL LIMIT with 'FETCH FIRST N ROWS ONLY' or Oracle 'OFFSET M ROWS FETCH NEXT N ROWS ONLY'.",
		};
	}

	// 7. SystemNote JOIN error
	if (
		/Prohibited 'JOIN SystemNote'/i.test(err) ||
		(sql &&
			/\bsystemnote\b/i.test(sql) &&
			extractReferencedTables(sql).length > 1)
	) {
		return {
			isDiagnosed: true,
			summary: "Prohibited Multi-Table JOIN with SystemNote",
			rootCause:
				"Joining SystemNote with large transactional/entity tables causes massive Cartesian products and 45s query timeouts.",
			officialGuidance:
				"Query SystemNote as an independent standalone table with strict filters on 'recordid' and a narrow date range.",
			suggestedFix:
				"SELECT recordid, field, oldvalue, newvalue, date, BUILTIN.DF(name) AS author FROM systemnote WHERE recordtypeid = -30 AND recordid = :id AND date >= TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD')",
			selfHealingAction:
				"Separate into a standalone SystemNote query with tight filters on recordid.",
		};
	}

	// 8. Unindexed transaction query
	if (/Unindexed query against 'transaction'/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Unindexed Transaction Query (Timeout Risk)",
			rootCause:
				"Querying transaction and transactionline without driving index filters causes full-table scans across millions of rows.",
			officialGuidance:
				"Include at least one indexed filter: 'trandate', 'type', 'id', 'tranid', 'entity', or 'subsidiary'.",
			suggestedFix:
				"WHERE t.trandate >= TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD') AND tl.mainline = 'F'",
			selfHealingAction:
				"Add indexed driving filters to the WHERE clause before executing.",
		};
	}

	// 9. Unindexed aggregation with HAVING
	if (/Unindexed aggregation query with HAVING/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Unindexed Aggregation Query with HAVING (Timeout Risk)",
			rootCause:
				"Using HAVING to filter grouped transactions without indexed filters in the WHERE clause forces a full-table scan before aggregation.",
			officialGuidance:
				"Add driving WHERE filters (e.g. `WHERE t.trandate >= TO_DATE(...)`) before the GROUP BY clause to narrow candidate rows.",
			suggestedFix:
				"WHERE t.trandate >= TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD') GROUP BY t.id HAVING SUM(tl.amount) > 1000",
			selfHealingAction:
				"Add indexed driving filters to the WHERE clause before the GROUP BY/HAVING clause.",
		};
	}

	// Default / Generic SuiteQL Error
	return {
		isDiagnosed: false,
		summary: "SuiteQL Query Error",
		rootCause: err,
		officialGuidance:
			"Verify table and column names using netsuite_get_metadata, ensure strict read-only SELECT syntax, and include indexed filters.",
		selfHealingAction:
			"1. Call `netsuite_get_metadata` for referenced table(s) to verify columns. 2. Directly fix query based on the diagnostic and execute.",
	};
}

/**
 * Formats a diagnosed SuiteQL error into a clean Markdown block for MCP tool responses.
 */
export function formatSuiteQLErrorResponse(
	rawError: string,
	sqlQuery?: string,
): string {
	const diag = diagnoseSuiteQLError(rawError, sqlQuery);

	let out = `❌ **SuiteQL Error:** ${rawError}\n\n`;
	out += `🔍 **Diagnostic:** ${diag.summary}\n`;
	out += `📌 **Root Cause:** ${diag.rootCause}\n`;
	out += `📖 **Official NetSuite Guidance:** ${diag.officialGuidance}\n`;
	if (diag.suggestedFix) {
		out += `💡 **Suggested Pattern:**\n\`\`\`sql\n${diag.suggestedFix}\n\`\`\`\n`;
	}
	out += `🔄 **Self-Healing Action:** ${diag.selfHealingAction}\n\n`;
	out += `💡 **Official Guidance:** Read MCP resource 'netsuite://guides/suiteql' for deep Oracle patterns.`;

	return out;
}
