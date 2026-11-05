/**
 * SuiteQL Runtime Error Diagnostic & Response Formatter.
 * Transforms raw NetSuite runtime error messages into high-signal, actionable self-healing guidance.
 */

import { extractTablesAndAliases } from "./context.js";
import type { SuiteQLErrorDiagnosis } from "./types.js";

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

	// 1. The False "near: FETCH" Trap
	if (
		/failed to parse sql[\s\S]*near:\s*FETCH/i.test(err) ||
		/syntax error[\s\S]*near:\s*FETCH/i.test(err)
	) {
		const { tables } = extractTablesAndAliases(sql);
		const targetTable = tables[0] || "the queried table";
		return {
			isDiagnosed: true,
			summary: "Preceding Syntax/Column Error (The False 'near: FETCH' Trap)",
			rootCause:
				"NetSuite SuiteQL fully supports 'FETCH FIRST N ROWS ONLY', but masks column errors behind the FETCH token when an unknown column name, typo, or syntax error precedes it.",
			officialGuidance: `DO NOT remove 'FETCH FIRST' or convert it to MySQL 'LIMIT' (which is completely invalid in NetSuite). The error is almost always caused by an invalid or non-existent column preceding FETCH. Inspect valid column names using netsuite_get_metadata({ table: '${targetTable}' }).`,
			suggestedFix: tables[0]
				? `Call netsuite_get_metadata({ table: '${tables[0]}' }) to inspect authoritative fields, then verify the column projection.`
				: "Check the column list and WHERE condition directly preceding the FETCH clause for typos or missing commas.",
			selfHealingAction: `Keep Oracle-standard pagination. Call netsuite_get_metadata({ table: '${targetTable}' }) to verify column names and correct the invalid identifier directly preceding FETCH.`,
		};
	}

	// 2. Duplicate column alias
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

	// 3. Ambiguous column reference
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

	// 4. GROUP BY non-aggregated expression
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

	// 5. Invalid JOIN relationship
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

	// 6. Invalid or unsupported search (Derived table / inline view, BUILTIN.DF in GROUP BY)
	if (/invalid or unsupported search/i.test(err)) {
		if (/\b(?:FROM|JOIN)\s*\(\s*SELECT\b/i.test(sql)) {
			return {
				isDiagnosed: true,
				summary: "Unsupported Derived Table in FROM / JOIN",
				rootCause:
					"NetSuite SuiteQL rejects inline derived tables `FROM (SELECT ...)` or `JOIN (SELECT ...)`. It triggers 'Search error occurred: Invalid or unsupported search'.",
				officialGuidance:
					"Rewrite query using Common Table Expressions (`WITH cte AS (...) SELECT ... FROM cte`).",
				suggestedFix:
					"WITH sub AS (SELECT id, tranid FROM transaction WHERE trandate >= '2025-01-01') SELECT s.id, tl.item FROM sub s JOIN transactionline tl ON s.id = tl.transaction WHERE tl.mainline = 'F'",
				selfHealingAction:
					"Rewrite inline derived table as a WITH Common Table Expression (CTE).",
			};
		}
		if (/\bBUILTIN\.DF\s*\(/i.test(sql) && /\bGROUP\s+BY\b/i.test(sql)) {
			return {
				isDiagnosed: true,
				summary: "BUILTIN.DF() in GROUP BY Query",
				rootCause:
					"Oracle NetSuite SuiteQL does not support evaluating BUILTIN.DF() inside an aggregated query with GROUP BY.",
				officialGuidance:
					"Aggregate in a CTE by ID, and invoke BUILTIN.DF() in the outer query.",
				suggestedFix:
					"WITH grp AS (SELECT entity, COUNT(*) AS cnt FROM transaction GROUP BY entity) SELECT g.entity, BUILTIN.DF(g.entity) AS name, g.cnt FROM grp g",
				selfHealingAction:
					"Move BUILTIN.DF() to outer SELECT projection wrapping CTE results.",
			};
		}
	}

	// 7. Unknown Column / Field Not Found
	const colMatch =
		/(?:Field|Column|Property)\s*['"]?([a-zA-Z0-9_]+)['"]?\s*(?:was not found|is invalid|does not exist)/i.exec(
			err,
		) ||
		/Invalid\s+(?:column|field)\s+name\s*['"]?([a-zA-Z0-9_]+)['"]?/i.exec(err);

	if (colMatch?.[1]) {
		const invalidCol = colMatch[1];
		const { tables } = extractTablesAndAliases(sql);
		const targetTable = tables[0] || "the table";

		return {
			isDiagnosed: true,
			summary: `Invalid Column: '${invalidCol}' on ${targetTable}`,
			rootCause: `Column '${invalidCol}' does not exist on table '${targetTable}' or lacks permissions in this NetSuite account.`,
			officialGuidance: `Inspect valid column names by calling netsuite_get_metadata({ table: '${targetTable}' }).`,
			suggestedFix: `Call netsuite_get_metadata({ table: '${targetTable}' }) to find the correct column name.`,
			selfHealingAction: `Call netsuite_get_metadata({ table: '${targetTable}' }) to inspect available columns.`,
		};
	}

	// 8. Table Not Found / Record Was Not Found
	const tableMatch =
		/(?:Table|Record type|Record)\s*['"]?([a-zA-Z0-9_]+)['"]?\s*(?:was not found|does not exist|is invalid)/i.exec(
			err,
		);

	if (tableMatch?.[1]) {
		const tableName = tableMatch[1];
		return {
			isDiagnosed: true,
			summary: `Table Not Found or Access Denied: '${tableName}'`,
			rootCause: `Table '${tableName}' does not exist in SuiteQL schema or the current role lacks permission to query it.`,
			officialGuidance: `Verify the table name in Oracle NetSuite Records Catalog. Standard tables include transaction, transactionline, customer, vendor, item, account, subsidiary.`,
			selfHealingAction: `Verify table name in skills or call netsuite_get_metadata({ table: '${tableName}' }).`,
		};
	}

	// Fallback diagnosis
	return {
		isDiagnosed: false,
		summary: "SuiteQL Execution Error",
		rootCause: err,
		officialGuidance:
			"Review the query syntax against NetSuite SuiteQL standards.",
		selfHealingAction:
			"Inspect the SQL syntax and call netsuite_get_metadata if columns are uncertain.",
	};
}

/**
 * Formats a raw NetSuite error into a clear, high-signal Markdown response.
 */
export function formatSuiteQLErrorResponse(
	rawError: string,
	sqlQuery: string,
): string {
	const diag = diagnoseSuiteQLError(rawError, sqlQuery);

	let md = `❌ **NetSuite SuiteQL Error**\n\n`;
	md += `> **Error:** ${rawError}\n\n`;

	if (diag.isDiagnosed) {
		md += `🔍 **Diagnostic:** ${diag.summary}\n\n`;
		md += `📌 **Root Cause:** ${diag.rootCause}\n\n`;
		md += `💡 **Official Guidance:** ${diag.officialGuidance}\n\n`;
		if (diag.suggestedFix) {
			md += `🛠️ **Suggested Fix:**\n\`\`\`sql\n${diag.suggestedFix}\n\`\`\`\n\n`;
		}
		md += `⚡ **Self-Healing Action:** ${diag.selfHealingAction}\n\n`;
	}

	return md;
}
