/**
 * SuiteQL Safety Checklist & Validation Guard.
 * Enforces read-only SELECT/WITH queries, prevents SQL injection hazards,
 * multi-statement execution, comments obfuscation, and DDL/DML mutation attempts.
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
}

const DISALLOWED_KEYWORDS_REGEX =
	/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|INTO|DATABASE|SCHEMA)\b/i;

/**
 * Validates a SuiteQL query string for security compliance.
 *
 * Rules:
 * 1. Must be a non-empty string.
 * 2. Must begin with SELECT or WITH (case-insensitive, ignoring leading whitespace).
 * 3. Cannot contain DDL/DML mutation keywords.
 * 4. Cannot contain SQL comment markers (-- or /* ... *\/) to prevent obfuscation.
 * 5. Cannot contain multiple statements separated by trailing semicolons (except a single optional trailing semicolon).
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

	// Check for SQL comment obfuscation
	if (
		trimmed.includes("--") ||
		trimmed.includes("/*") ||
		trimmed.includes("*/") ||
		trimmed.includes("#")
	) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains prohibited SQL comments (-- or /* */ or #). Remove all comment blocks and re-submit a clean query.",
		};
	}

	// Check for multi-statement execution (semicolons that are not just a single trailing semicolon)
	const withoutTrailingSemicolon = trimmed.endsWith(";")
		? trimmed.slice(0, -1).trim()
		: trimmed;
	if (withoutTrailingSemicolon.includes(";")) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains multiple statements separated by semicolons. Only single read-only queries are allowed per invocation (or use `netsuite_run_parallel_queries` for batch queries).",
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

	// Check for DDL/DML disallowed keywords
	const match = DISALLOWED_KEYWORDS_REGEX.exec(withoutTrailingSemicolon);
	if (match) {
		return {
			valid: false,
			reason: `SuiteQL query contains disallowed mutation or DDL keyword: '${match[1]}'. Only read-only queries are permitted. Use ns_createRecord or ns_updateRecord for data mutations.`,
		};
	}

	return { valid: true };
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
