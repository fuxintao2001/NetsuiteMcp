/**
 * SuiteQL AST & Safety Guard Engine (Modernized Declarative Architecture).
 */

import { extractTablesAndAliases } from "./context.js";

export * from "./context.js";
export * from "./diagnostics.js";
export * from "./normalizer.js";
export * from "./rules/index.js";
export * from "./types.js";

/**
 * Extracts referenced table names from a SuiteQL query string.
 * High-performance convenience helper used by tools and caching layers.
 */
export function extractReferencedTables(sqlQuery: string): string[] {
	if (!sqlQuery || typeof sqlQuery !== "string") return [];
	const { tables } = extractTablesAndAliases(sqlQuery);
	return tables;
}
