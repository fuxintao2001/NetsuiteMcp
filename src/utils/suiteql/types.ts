/**
 * Core types and interfaces for the SuiteQL AST & Rule Engine.
 * Powered by sqlingo (sqlingo/oracle).
 */

import type { Expression, Token } from "sqlingo";

export interface QueryContext {
	/** Original raw SQL string */
	rawSql: string;
	/** Lexical tokens produced by Oracle.Tokenizer */
	tokens: Token[];
	/** Parsed AST statements produced by Oracle.Parser */
	asts: Expression[];
	/** Extracted referenced physical tables in lowercase (excluding CTE aliases) */
	tables: string[];
	/** Extracted table aliases mapping lowercase alias -> lowercase physical table name */
	tableAliases: Map<string, string>;
	/** Extracted CTE names in lowercase */
	cteNames: Set<string>;
	/** Whether the query contains Oracle pagination syntax (FETCH FIRST, ROWNUM, OFFSET) */
	hasPagination: boolean;
	/** Whether the query contains multiple statements separated by semicolons */
	hasMultipleStatements: boolean;
	/** Whether the query begins with SELECT or WITH */
	isSelectOrWith: boolean;
	/** Optional syntax/parse error if sqlingo could not fully parse into AST */
	parseError?: string | undefined;
}

export type RuleCategory = "security" | "safe" | "dialect" | "schema";

export type RuleSeverity = "error" | "warning";

export interface RuleViolation {
	/** Unique rule identifier (e.g. 'safe-no-wildcards') */
	ruleId: string;
	/** Human-readable rule title */
	ruleName: string;
	/** Category of the rule */
	category: RuleCategory;
	/** Severity level: 'error' (hard block) or 'warning' (advisory) */
	severity: RuleSeverity;
	/** Clear description of the violation and why it is prohibited */
	message: string;
	/** Concrete suggested replacement or fix guidance */
	suggestedFix?: string | undefined;
}

export interface SuiteQLRule {
	/** Unique rule identifier (e.g. 'safe-no-wildcards') */
	id: string;
	/** Human-readable rule title */
	name: string;
	/** Rule category */
	category: RuleCategory;
	/** Default severity (defaults to 'error') */
	severity?: RuleSeverity | undefined;
	/**
	 * Evaluates query context against this rule.
	 * Returns:
	 * - string (error message)
	 * - RuleViolation or RuleViolation[]
	 * - null (if compliant)
	 */
	validate: (
		ctx: QueryContext,
	) => string | RuleViolation | RuleViolation[] | null;
}

export interface SuiteQLValidationResult {
	/** True if zero 'error' severity violations exist */
	valid: boolean;
	/** Consolidated summary of all blocking error reasons (if any) */
	reason?: string | undefined;
	/** All blocking error violations */
	errors: RuleViolation[];
	/** All non-blocking advisory warnings */
	warnings: RuleViolation[];
	/** Referenced table names in lowercase */
	tables: string[];
	/** Whether Oracle pagination syntax was detected */
	hasPagination: boolean;
}

export interface SuiteQLErrorDiagnosis {
	isDiagnosed: boolean;
	summary: string;
	rootCause: string;
	officialGuidance: string;
	suggestedFix?: string | undefined;
	selfHealingAction: string;
}
