/**
 * SQL Lexical Normalizer & Pre-processor.
 * Handles literal masking, comment stripping, and statement splitting.
 */

/**
 * Replaces SQL string literals ('...') and double-quoted identifiers/literals ("...")
 * with placeholder tokens (__STR_LITERAL_N__) to avoid false positives in keyword checks.
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
					i++;
					continue;
				}
				// End of literal
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
 * Strips block comments and line comments from a masked SQL string.
 */
export function stripSqlComments(maskedSql: string): string {
	// 1. Strip block comments: /* ... */
	const withoutBlockComments = maskedSql.replace(/\/\*[\s\S]*?\*\//g, " ");

	// 2. Strip single-line comments: -- ... until newline or end
	const withoutLineComments = withoutBlockComments.replace(
		/--[^\r\n]*(?:[\r\n]|$)/g,
		" ",
	);

	// 3. Normalize multiple whitespace characters
	return withoutLineComments.replace(/[ \t\r\n]+/g, " ").trim();
}

/**
 * Splits raw SQL containing multiple queries separated by semicolons outside string literals.
 */
export function splitSuiteQLStatements(rawSql: string): string[] {
	if (!rawSql || typeof rawSql !== "string") return [];
	const trimmed = rawSql.trim();
	if (trimmed.length === 0) return [];

	const { maskedSql, literals } = maskStringLiterals(trimmed);
	const rawStatements = maskedSql
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	return rawStatements.map((stmt) => unmaskStringLiterals(stmt, literals));
}
