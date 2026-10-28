import { cacheService } from "../cache/cache.js";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import { createLogger } from "./logger.js";
import { ConcurrencyLimiter } from "./resilience.js";
import { type ColumnHint, findColumnHint } from "./suiteqlColumnHints.js";

const logger = createLogger("suiteql-column-probe");
const probeLimiter = new ConcurrencyLimiter(5);

export interface ProbedColumnIssue {
	table: string;
	column: string;
	hint?: ColumnHint | undefined;
}

const SQL_KEYWORDS = new Set([
	"on",
	"where",
	"left",
	"right",
	"inner",
	"outer",
	"join",
	"cross",
	"group",
	"order",
	"fetch",
	"union",
	"limit",
	"offset",
]);

/**
 * Extracts table alias mappings from a SuiteQL query.
 * e.g. "FROM transactionline tl" => tl -> transactionline
 */
export function extractTableAliases(sql: string): Map<string, string> {
	const aliases = new Map<string, string>();
	const fromJoinRegex =
		/\b(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?\b/gi;

	let match: RegExpExecArray | null;
	while (true) {
		match = fromJoinRegex.exec(sql);
		if (!match) break;

		const table = match[1]?.toLowerCase();
		if (!table || SQL_KEYWORDS.has(table)) continue;

		let alias = match[2]?.toLowerCase();
		if (!alias || SQL_KEYWORDS.has(alias)) {
			alias = table;
		}

		aliases.set(alias, table);
		// Also always map the table name itself
		aliases.set(table, table);
	}

	return aliases;
}

/**
 * Extracts alias.column pairs from a SuiteQL query.
 */
export function extractAliasedColumns(
	sql: string,
	tableAliases: Map<string, string>,
): Array<{ table: string; column: string; alias: string }> {
	const colRegex = /\b([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\b/g;
	const seen = new Set<string>();
	const results: Array<{ table: string; column: string; alias: string }> = [];

	let match: RegExpExecArray | null;
	while (true) {
		match = colRegex.exec(sql);
		if (!match) break;

		const alias = match[1]?.toLowerCase();
		const column = match[2]?.toLowerCase();
		if (!alias || !column) continue;

		const table = tableAliases.get(alias);
		if (table) {
			const key = `${table}:${column}`;
			if (!seen.has(key)) {
				seen.add(key);
				results.push({ table, column, alias });
			}
		}
	}

	return results;
}

/**
 * Concurrently probes suspicious columns referenced in a failing SuiteQL query
 * to identify non-existent or inaccessible fields that caused SuiteScript errors.
 */
export async function probeSuspiciousColumns(
	sqlQuery: string,
	accountId: string,
	mcpTools: NetSuiteMCPTools,
	maxColumns = 15,
): Promise<ProbedColumnIssue[]> {
	try {
		const tableAliases = extractTableAliases(sqlQuery);
		if (tableAliases.size === 0) return [];

		const aliasedCols = extractAliasedColumns(sqlQuery, tableAliases).slice(
			0,
			maxColumns,
		);
		if (aliasedCols.length === 0) return [];

		const invalidCols: ProbedColumnIssue[] = [];

		await Promise.all(
			aliasedCols.map((target) =>
				probeLimiter.run(async () => {
					const cacheKey = `colprobe:${target.table}:${target.column}`;
					try {
						const cached = await cacheService.get<"valid" | "invalid">(
							accountId,
							cacheKey,
						);
						if (cached === "invalid") {
							invalidCols.push({
								table: target.table,
								column: target.column,
								hint: findColumnHint(target.table, target.column),
							});
							return;
						}
						if (cached === "valid") {
							return;
						}
					} catch {
						// Cache miss
					}

					// Build minimal probe query
					const isTl = target.table.toLowerCase() === "transactionline";
					const probeSql = isTl
						? `SELECT ${target.column} FROM transactionline WHERE mainline = 'F' AND ROWNUM <= 1`
						: `SELECT ${target.column} FROM ${target.table} WHERE ROWNUM <= 1`;

					try {
						await mcpTools.executeTool("ns_runCustomSuiteQL", {
							sqlQuery: probeSql,
						});
						// Column succeeded
						await cacheService.set(accountId, cacheKey, "valid", 86400);
					} catch (err: unknown) {
						const errMsg = err instanceof Error ? err.message : String(err);
						// Column failed
						if (
							errMsg.includes("unexpected SuiteScript error") ||
							errMsg.includes("Unknown identifier") ||
							errMsg.includes("was not found") ||
							errMsg.includes("Invalid search type") ||
							errMsg.includes("Search error occurred") ||
							errMsg.includes("Failed to parse SQL") ||
							errMsg.includes("near: FETCH")
						) {
							await cacheService.set(accountId, cacheKey, "invalid", 86400);
							invalidCols.push({
								table: target.table,
								column: target.column,
								hint: findColumnHint(target.table, target.column),
							});
						}
					}
				}),
			),
		);

		return invalidCols;
	} catch (error: unknown) {
		logger.warn(`Column probe encountered non-fatal error: ${error}`);
		return [];
	}
}

/**
 * Formats column probe findings into clear self-healing markdown output.
 */
export function formatProbeResults(issues: ProbedColumnIssue[]): string {
	if (issues.length === 0) return "";

	let out = "\n\n🔬 **Automated Column Diagnostics:**\n";
	for (const issue of issues) {
		out += `- ❌ Column \`${issue.table}.${issue.column}\` failed validation on table \`${issue.table}\`.\n`;
		if (issue.hint) {
			out += `  💡 **Recommended Fix**: ${issue.hint.fix} — ${issue.hint.description}\n`;
		} else {
			out += `  📖 **Action**: Verify actual column name using \`netsuite_get_metadata({ table: '${issue.table}' })\`.\n`;
		}
	}

	return out;
}
