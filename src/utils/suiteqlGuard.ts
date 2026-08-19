/**
 * SuiteQL Safety Checklist & Validation Guard.
 * Enforces read-only SELECT/WITH queries, prevents SQL injection hazards,
 * multi-statement execution, comments obfuscation, and DDL/DML mutation attempts
 * while respecting string literals (e.g. preventing false positives on 'DROP SHIPPING').
 */

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
 * Replaces SQL string literals ('...') with placeholder tokens to avoid false positives
 * when matching keywords or comment symbols inside benign data values.
 */
export function maskStringLiterals(sql: string): {
	maskedSql: string;
	literals: string[];
} {
	const literals: string[] = [];
	let inString = false;
	let currentLiteral = "";
	let maskedSql = "";

	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		const nextChar = sql[i + 1];

		if (char === "'") {
			if (inString) {
				// Handle escaped single quote ''
				if (nextChar === "'") {
					currentLiteral += "''";
					i++; // Skip next quote
					continue;
				}
				// End of string literal
				inString = false;
				currentLiteral += "'";
				literals.push(currentLiteral);
				maskedSql += `__STR_LITERAL_${literals.length - 1}__`;
				currentLiteral = "";
				continue;
			}
			// Start of string literal
			inString = true;
			currentLiteral = "'";
			continue;
		}

		if (inString) {
			currentLiteral += char;
		} else {
			maskedSql += char;
		}
	}

	if (inString) {
		// Unterminated string literal
		maskedSql += currentLiteral;
	}

	return { maskedSql, literals };
}

/**
 * Extracts referenced table names from a SuiteQL query.
 */
export function extractReferencedTables(sqlQuery: string): string[] {
	const { maskedSql } = maskStringLiterals(sqlQuery);
	const tableSet = new Set<string>();

	// Match FROM and JOIN clauses
	const tableRegex = /\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)/gi;
	let match: RegExpExecArray | null;

	while (true) {
		match = tableRegex.exec(maskedSql);
		if (!match) break;
		const tableName = match[1]?.toLowerCase().trim();
		if (tableName && !tableName.startsWith("__str_literal")) {
			tableSet.add(tableName);
		}
	}

	return Array.from(tableSet);
}

/**
 * Checks if a SuiteQL query already has a pagination clause (ROWNUM or FETCH FIRST).
 */
export function hasPaginationClause(sqlQuery: string): boolean {
	const { maskedSql } = maskStringLiterals(sqlQuery);
	return (
		/\bROWNUM\b/i.test(maskedSql) ||
		/\bFETCH\s+(FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY\b/i.test(maskedSql)
	);
}

/**
 * Ensures a SuiteQL query has pagination. If missing, appends FETCH FIRST N ROWS ONLY.
 */
export function ensureSuiteQLPagination(
	sqlQuery: string,
	defaultLimit = 100,
): string {
	const trimmed = sqlQuery.trim().replace(/;+$/, "");
	if (hasPaginationClause(trimmed)) {
		return trimmed;
	}
	return `${trimmed} FETCH FIRST ${defaultLimit} ROWS ONLY`;
}

/**
 * Validates a SuiteQL query string for security compliance.
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
	const { maskedSql } = maskStringLiterals(trimmed);

	// Check for SQL comment obfuscation outside string literals
	if (
		maskedSql.includes("--") ||
		maskedSql.includes("/*") ||
		maskedSql.includes("*/") ||
		maskedSql.includes("#")
	) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains prohibited SQL comments (-- or /* */ or #). Remove all comment blocks and re-submit a clean query.",
		};
	}

	// Check for multi-statement execution (semicolons that are not just a single trailing semicolon)
	const withoutTrailingSemicolon = maskedSql.endsWith(";")
		? maskedSql.slice(0, -1).trim()
		: maskedSql;

	if (withoutTrailingSemicolon.includes(";")) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains multiple statements separated by semicolons. Only single read-only queries are allowed per invocation (or use `netsuite_batch_execute` for batch queries).",
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

	// Check for DDL/DML disallowed keywords in the masked SQL (ignores string literal contents)
	const match = DISALLOWED_KEYWORDS_REGEX.exec(withoutTrailingSemicolon);
	if (match) {
		return {
			valid: false,
			reason: `SuiteQL query contains disallowed mutation or DDL keyword: '${match[1]}'. Only read-only queries are permitted. Use ns_createRecord or ns_updateRecord for data mutations.`,
		};
	}

	const tables = extractReferencedTables(trimmed);
	const hasPagination = hasPaginationClause(trimmed);

	return { valid: true, tables, hasPagination };
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
