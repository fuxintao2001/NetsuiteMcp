/**
 * SuiteQL Rule Registry & Execution Pipeline.
 */

import { LRUCache } from "lru-cache";
import { buildQueryContext } from "../context.js";
import type { SuiteQLRule, SuiteQLValidationResult } from "../types.js";
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

/**
 * Executes all registered SuiteQL rules against a SQL query string.
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
	if (cached) return cached;

	const ctx = buildQueryContext(trimmed);

	for (const rule of ALL_RULES) {
		const violation = rule.validate(ctx);
		if (violation) {
			const failedResult: SuiteQLValidationResult = {
				valid: false,
				reason: violation,
				tables: ctx.tables,
				hasPagination: ctx.hasPagination,
			};
			validationCache.set(trimmed, failedResult);
			return failedResult;
		}
	}

	const successResult: SuiteQLValidationResult = {
		valid: true,
		tables: ctx.tables,
		hasPagination: ctx.hasPagination,
	};
	validationCache.set(trimmed, successResult);
	return successResult;
}

export class SuiteQLValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SuiteQLValidationError";
	}
}

/**
 * Asserts that a SuiteQL query is compliant with all guardrails.
 * Throws SuiteQLValidationError if any rule fails.
 */
export function assertValidSuiteQL(sqlQuery: string): void {
	const result = validateSuiteQL(sqlQuery);
	if (!result.valid) {
		throw new SuiteQLValidationError(
			`❌ SuiteQL Security Guardrail Violation: ${result.reason}`,
		);
	}
}
