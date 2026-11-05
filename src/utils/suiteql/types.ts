/**
 * Core types and interfaces for the SuiteQL AST & Rule Engine.
 */

export interface QueryContext {
	/** Original raw SQL string */
	rawSql: string;
	/** Clean SQL with comments stripped and trailing semicolon removed */
	cleanSql: string;
	/** Masked SQL where string literals ('...') are replaced with __STR_LITERAL_N__ */
	maskedSql: string;
	/** Extracted string literals preserving raw string values */
	literals: string[];
	/** Extracted referenced tables in lowercase (e.g. ['transaction', 'transactionline']) */
	tables: string[];
	/** Extracted table aliases mapping lowercase alias -> lowercase table name */
	tableAliases: Map<string, string>;
	/** Extracted projection expressions from SELECT clause */
	projections: string[];
	/** Whether the query contains pagination syntax (FETCH FIRST, ROWNUM, OFFSET) */
	hasPagination: boolean;
	/** Whether the query is a multi-statement query (contains unquoted semicolons) */
	hasMultipleStatements: boolean;
	/** Whether the query begins with SELECT or WITH */
	isSelectOrWith: boolean;
}

export type RuleCategory = "security" | "safe" | "dialect" | "schema";

export interface SuiteQLRule {
	/** Unique rule identifier (e.g. 'safe-no-wildcard') */
	id: string;
	/** Human-readable rule title */
	name: string;
	/** Rule category */
	category: RuleCategory;
	/**
	 * Evaluates query context against this rule.
	 * Returns error message string if violation occurs, or null if compliant.
	 */
	validate: (ctx: QueryContext) => string | null;
}

export interface SuiteQLValidationResult {
	valid: boolean;
	reason?: string | undefined;
	tables?: string[] | undefined;
	hasPagination?: boolean | undefined;
}

export interface SuiteQLErrorDiagnosis {
	isDiagnosed: boolean;
	summary: string;
	rootCause: string;
	officialGuidance: string;
	suggestedFix?: string | undefined;
	selfHealingAction: string;
}
