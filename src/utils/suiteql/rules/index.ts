/**
 * SuiteQL Rule Registry & Multi-Diagnostic Execution Pipeline.
 * Evaluates queries against all security, SAFE, dialect, and schema guardrails.
 */

import { LRUCache } from "lru-cache";
import { buildQueryContext } from "../context.js";
import type {
	RuleViolation,
	SuiteQLRule,
	SuiteQLValidationResult,
} from "../types.js";
import { dialectRules } from "./dialect.js";
import { safeRules } from "./safe.js";
import { schemaRules } from "./schema.js";
import { securityRules } from "./security.js";

const ALL_RULES: SuiteQLRule[] = [
	...securityRules,
	...safeRules,
	...dialectRules,
	...schemaRules,
];

const validationCache = new LRUCache<string, SuiteQLValidationResult>({
	max: 500,
	ttl: 10 * 60 * 1000, // 10 minutes
});

function normalizeViolations(
	rule: SuiteQLRule,
	raw: string | RuleViolation | RuleViolation[] | null,
): RuleViolation[] {
	if (!raw) return [];
	if (Array.isArray(raw)) return raw;
	if (typeof raw === "string") {
		return [
			{
				ruleId: rule.id,
				ruleName: rule.name,
				category: rule.category,
				severity: rule.severity || "error",
				message: raw,
			},
		];
	}
	return [raw];
}

/**
 * Executes all registered SuiteQL rules against a SQL query string.
 * Collects all errors and warnings across the query (multi-diagnostic).
 */
export function validateSuiteQL(sqlQuery: string): SuiteQLValidationResult {
	if (
		!sqlQuery ||
		typeof sqlQuery !== "string" ||
		sqlQuery.trim().length === 0
	) {
		const emptyViolation: RuleViolation = {
			ruleId: "sec-not-empty",
			ruleName: "Query Not Empty",
			category: "security",
			severity: "error",
			message:
				"SuiteQL query cannot be empty. Please provide a valid SELECT or WITH statement.",
		};
		return {
			valid: false,
			reason: emptyViolation.message,
			errors: [emptyViolation],
			warnings: [],
			tables: [],
			hasPagination: false,
		};
	}

	const trimmed = sqlQuery.trim();
	const cached = validationCache.get(trimmed);
	if (cached) return cached;

	const ctx = buildQueryContext(trimmed);
	const errors: RuleViolation[] = [];
	const warnings: RuleViolation[] = [];

	for (const rule of ALL_RULES) {
		const rawViolation = rule.validate(ctx);
		const violations = normalizeViolations(rule, rawViolation);

		for (const v of violations) {
			if (v.severity === "warning") {
				warnings.push(v);
			} else {
				errors.push(v);
			}
		}
	}

	let reason: string | undefined;
	if (errors.length === 1) {
		reason = errors[0]?.message;
	} else if (errors.length > 1) {
		reason = `Multiple SuiteQL Guardrail Violations (${errors.length} errors):\n${errors
			.map((e, idx) => `${idx + 1}. [${e.ruleId}]: ${e.message}`)
			.join("\n\n")}`;
	}

	const result: SuiteQLValidationResult = {
		valid: errors.length === 0,
		reason,
		errors,
		warnings,
		tables: ctx.tables,
		hasPagination: ctx.hasPagination,
	};

	validationCache.set(trimmed, result);
	return result;
}

export class SuiteQLValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SuiteQLValidationError";
	}
}

/**
 * Asserts that a SuiteQL query is compliant with all guardrails.
 * Throws SuiteQLValidationError if any blocking error violation is found.
 */
export function assertValidSuiteQL(sqlQuery: string): void {
	const result = validateSuiteQL(sqlQuery);
	if (!result.valid) {
		throw new SuiteQLValidationError(
			`❌ SuiteQL Security Guardrail Violation:\n${result.reason}`,
		);
	}
}
