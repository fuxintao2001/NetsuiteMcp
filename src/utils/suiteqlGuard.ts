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

/**
 * Tracks schema metadata reconnaissance calls in the current session
 * to prevent agents from skipping ns_getSuiteQLMetadata (Gate 2 Enforcement).
 */
const consultedTables = new Set<string>();

export const schemaReconnaissanceTracker = {
	record(tableName?: unknown): void {
		if (typeof tableName === "string" && tableName.trim().length > 0) {
			consultedTables.add(tableName.toLowerCase().trim());
		}
	},
	has(tableName: string): boolean {
		return consultedTables.has(tableName.toLowerCase().trim());
	},
	getConsultedTables(): string[] {
		return Array.from(consultedTables);
	},
	clear(): void {
		consultedTables.clear();
	},
};

export const SchemaReconnaissanceTracker = schemaReconnaissanceTracker;

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
 * Detects whether a SuiteQL query contains any wildcard column projection (* or alias.*),
 * while correctly ignoring COUNT(*) aggregate functions and arithmetic multiplication (a * b).
 */
export function hasWildcardSelection(maskedSql: string): boolean {
	const selectBlocks = maskedSql.match(
		/(?:^|\s|\()SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\b/gi,
	);
	if (!selectBlocks) return false;

	for (const block of selectBlocks) {
		const projMatch =
			/(?:^|\s|\()SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\b/i.exec(block);
		if (!projMatch?.[1]) continue;
		const projection = projMatch[1];

		// Check for standalone * or alias.* not enclosed as a function parameter (e.g. not COUNT(*))
		if (/(?:^|\s|,)(?:\w+\.)?\*\s*(?:,|$)/.test(projection.trim())) {
			return true;
		}
	}
	return false;
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

	// Check for 'SELECT *' or 'SELECT alias.*' (Gate 2 Syntax Mandate) across all projection positions
	if (hasWildcardSelection(maskedSql)) {
		return {
			valid: false,
			reason:
				"SuiteQL query contains 'SELECT *' or wildcard projection (e.g. 'table.*'). Explicitly specify each required column name to optimize performance, prevent governance timeouts, and avoid invalid field errors.",
		};
	}

	// Check for MySQL/Postgres-style LIMIT / OFFSET (Gate 2 Syntax Mandate)
	if (/\b(LIMIT|OFFSET)\b/i.test(withoutTrailingSemicolon)) {
		return {
			valid: false,
			reason:
				"SuiteQL does not support 'LIMIT/OFFSET' keywords. Use 'WHERE ROWNUM <= N' or 'FETCH FIRST N ROWS ONLY' for pagination.",
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

	// --- Slow Query Anti-Pattern Checks & Smart Routing Guidance ---

	// Anti-Pattern 1: Prohibited SystemNote JOIN (causes catastrophic timeouts on high-volume datasets)
	if (tables.includes("systemnote") && tables.length > 1) {
		return {
			valid: false,
			reason:
				"Prohibited 'JOIN SystemNote': Joining 'SystemNote' directly with other tables causes severe query timeouts due to massive table volume. Please execute a standalone query against SystemNote with tight filters on 'recordid' and a narrow date range instead.",
		};
	}

	// Anti-Pattern 2: 'createdfrom' field location on transaction header
	if (
		/\b(?:transaction|t)\.createdfrom\b/i.test(trimmed) ||
		(tables.includes("transaction") &&
			!tables.includes("transactionline") &&
			/\bcreatedfrom\b/i.test(trimmed))
	) {
		return {
			valid: false,
			reason:
				"Invalid field location 'createdfrom': In NetSuite SuiteQL, 'createdfrom' does NOT exist on the 'transaction' header table; it is a column on 'transactionline'. Please join transactionline to query lineage (e.g. `JOIN transactionline tl ON t.id = tl.transaction WHERE tl.createdfrom = :id AND tl.mainline = 'T'`).",
		};
	}

	// Anti-Pattern 3: Suboptimal table 'inventoryitemlocations' for general inventory
	if (
		tables.includes("inventoryitemlocations") &&
		!/\b(itemtype|type)\s*=\s*['"]?InvtPart['"]?/i.test(trimmed)
	) {
		return {
			valid: false,
			reason:
				"Suboptimal table 'inventoryitemlocations': 'inventoryitemlocations' only contains standard inventory items (InvtPart) and omits Assembly, Lot-numbered, and Serialized items. For complete cross-item location stock (quantityOnHand, quantityAvailable, quantityOnOrder, averageCostMli), use the unified 'aggregateitemlocation' table instead: `SELECT a.item, a.location, a.quantityOnHand, a.quantityAvailable, a.quantityOnOrder, a.averageCostMli FROM aggregateitemlocation a`.",
		};
	}

	// Anti-Pattern 4: 'transactionline' missing 'mainline' filter
	if (
		tables.includes("transactionline") &&
		!/\bmainline\s*=\s*['"]?[TF]['"]?/i.test(trimmed)
	) {
		return {
			valid: false,
			reason:
				"Missing 'mainline' filter on 'transactionline': NetSuite 'transactionline' rows contain both header summary (mainline = 'T') and line items (mainline = 'F'). Omitting this filter causes row duplication and distorted sum amounts. Add `tl.mainline = 'F'` (for line item details) or `tl.mainline = 'T'` (for transaction header line) to your WHERE clause.",
		};
	}

	// Anti-Pattern 5: Unindexed query against 'transaction' + 'transactionline'
	if (tables.includes("transaction") && tables.includes("transactionline")) {
		const whereMatch =
			/\bWHERE\s+([\s\S]+?)(?:\s+(?:GROUP\s+BY|HAVING|ORDER\s+BY|FETCH\s+FIRST)|;|$)/i.exec(
				maskedSql,
			);
		const whereClause = whereMatch?.[1] || "";

		const hasDrivingFilter =
			/\b(tranid|otherrefnum|trandate|datecreated|type|recordtype|entity|item|subsidiary|location|createdfrom)\s*(?:=|IN|<|>|BETWEEN|LIKE|>=|<=)/i.test(
				whereClause,
			) ||
			/\b(?:t\.|tl\.|transaction\.|transactionline\.)?(?:id|internalid)\s*(?:=|IN|<|>|BETWEEN|LIKE|>=|<=)\s*(?:\d+|__STR_LITERAL_\d+__|\?|\()/i.test(
				whereClause,
			);

		if (!hasDrivingFilter) {
			return {
				valid: false,
				reason:
					"Unindexed query against 'transaction' + 'transactionline': Queries joining transaction tables MUST include at least one indexed driving filter in the WHERE clause (such as 'trandate', 'type', 'id', 'tranid', 'entity', 'subsidiary', or 'item') to prevent full-table scan timeouts. Example: `WHERE t.type = 'SalesOrd' AND t.trandate >= TO_DATE('2025-01-01', 'YYYY-MM-DD') AND tl.mainline = 'F'`.",
			};
		}
	}

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

export interface SuiteQLErrorDiagnosis {
	isDiagnosed: boolean;
	summary: string;
	rootCause: string;
	officialGuidance: string;
	suggestedFix?: string;
	selfHealingAction: string;
}

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

	// 1. Unknown identifier: createdfrom on transaction
	if (
		/unknown identifier ['"]?createdfrom['"]?/i.test(err) ||
		/Invalid field location 'createdfrom'/i.test(err) ||
		(sql &&
			/\bcreatedfrom\b/i.test(sql) &&
			/\btransaction\b/i.test(sql) &&
			!/\btransactionline\b/i.test(sql))
	) {
		return {
			isDiagnosed: true,
			summary: "Invalid Field Location: 'createdfrom'",
			rootCause:
				"In NetSuite SuiteQL, 'createdfrom' does NOT exist on the 'transaction' header table; it is exclusively a column on 'transactionline'.",
			officialGuidance:
				"To query upstream transaction lineage (e.g. PO from SO, IR from PO, IF from SO), join 'transactionline' and filter on 'tl.createdfrom'.",
			suggestedFix:
				"SELECT t.id, t.tranid, t.type FROM transactionline tl JOIN transaction t ON t.id = tl.transaction WHERE tl.createdfrom = :upstream_id AND tl.mainline = 'T'",
			selfHealingAction:
				"Join 'transactionline' and query 'tl.createdfrom' with tl.mainline = 'T'.",
		};
	}

	// 2. Table not found: bin / oa_tables / generic
	if (
		/record ['"]?bin['"]? was not found/i.test(err) ||
		/invalid search type: bin/i.test(err)
	) {
		return {
			isDiagnosed: true,
			summary: "Table Not Directly Accessible: 'bin'",
			rootCause:
				"The table 'bin' is not directly queryable via SuiteQL in this account configuration.",
			officialGuidance:
				"Use 'inventorybalance' to query bin-level inventory balances, bin numbers, and status breakdown.",
			suggestedFix:
				"SELECT item, location, binnumber, inventorynumber, quantityavailable, quantityonhand FROM inventorybalance WHERE location = :loc_id",
			selfHealingAction: "Rewrite the query against 'inventorybalance' table.",
		};
	}

	if (
		/record ['"]?([a-zA-Z0-9_]+)['"]? was not found/i.test(err) ||
		/invalid search type: ([a-zA-Z0-9_]+)/i.test(err)
	) {
		const match =
			/record ['"]?([a-zA-Z0-9_]+)['"]? was not found/i.exec(err) ||
			/invalid search type: ([a-zA-Z0-9_]+)/i.exec(err);
		const tableName = match?.[1] || "unknown";

		return {
			isDiagnosed: true,
			summary: `Non-Existent or Disabled Table: '${tableName}'`,
			rootCause: `Table '${tableName}' does not exist in NetSuite's SuiteQL schema or the corresponding feature is disabled.`,
			officialGuidance:
				"Verify available tables by calling `ns_getSuiteQLMetadata({ keyword: '...' })` or check NetSuite Records Catalog.",
			selfHealingAction: `Call ns_getSuiteQLMetadata({ keyword: '${tableName}' }) to discover the correct table name.`,
		};
	}

	// 3. Generic Unknown identifier
	if (/unknown identifier ['"]?([a-zA-Z0-9_]+)['"]?/i.test(err)) {
		const match = /unknown identifier ['"]?([a-zA-Z0-9_]+)['"]?/i.exec(err);
		const colName = match?.[1] || "unknown";
		const tables = sql ? extractReferencedTables(sql) : [];
		const tableContext =
			tables.length > 0 ? ` on table(s): ${tables.join(", ")}` : "";

		return {
			isDiagnosed: true,
			summary: `Unknown Field/Column: '${colName}'`,
			rootCause: `Column '${colName}' was not recognized${tableContext}. Field names are case-sensitive and vary by custom fields (custbody_*, custrecord_*, custitem_*).`,
			officialGuidance: `Inspect the exact column definitions for ${tables[0] || "the table"} using ns_getSuiteQLMetadata.`,
			selfHealingAction: `Call ns_getSuiteQLMetadata({ recordType: '${tables[0] || "tableName"}' }) to verify valid column names.`,
		};
	}

	// 4. Suboptimal table inventoryitemlocations
	if (
		/Suboptimal table 'inventoryitemlocations'/i.test(err) ||
		(sql &&
			/\binventoryitemlocations\b/i.test(sql) &&
			!/\b(itemtype|type)\s*=/i.test(sql))
	) {
		return {
			isDiagnosed: true,
			summary: "Suboptimal Table: 'inventoryitemlocations'",
			rootCause:
				"'inventoryitemlocations' only contains standard raw materials (InvtPart) and omits Assembly, Lot-numbered, and Serialized items.",
			officialGuidance:
				"Use 'aggregateitemlocation' for unified multi-location stock across all item types.",
			suggestedFix:
				"SELECT a.item, BUILTIN.DF(a.item) AS item_name, a.location, BUILTIN.DF(a.location) AS loc_name, a.quantityOnHand, a.quantityAvailable, a.quantityOnOrder, a.averageCostMli FROM aggregateitemlocation a WHERE a.location = :loc_id",
			selfHealingAction:
				"Switch query table from 'inventoryitemlocations' to 'aggregateitemlocation'.",
		};
	}

	// 5. Missing mainline filter
	if (
		/Missing 'mainline' filter/i.test(err) ||
		(sql &&
			/\btransactionline\b/i.test(sql) &&
			!/\bmainline\s*=\s*['"]?[TF]['"]?/i.test(sql))
	) {
		return {
			isDiagnosed: true,
			summary: "Missing 'mainline' Filter on 'transactionline'",
			rootCause:
				"NetSuite 'transactionline' contains both header summary lines (mainline = 'T') and line items (mainline = 'F'). Omitting this filter causes row duplication and 2x inflated totals.",
			officialGuidance:
				"Add `tl.mainline = 'F'` for line-item details or `tl.mainline = 'T'` for transaction header line.",
			suggestedFix:
				"SELECT t.id, t.tranid, tl.item, tl.quantity, tl.rate, tl.amount FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd' AND tl.mainline = 'F'",
			selfHealingAction:
				"Add `tl.mainline = 'F'` (for line items) or `tl.mainline = 'T'` (for transaction header line) to your WHERE clause.",
		};
	}

	// 6. LIMIT / OFFSET dialect error
	if (/\b(LIMIT|OFFSET)\b/i.test(err) || /\b(LIMIT|OFFSET)\b/i.test(sql)) {
		return {
			isDiagnosed: true,
			summary: "Unsupported Dialect Keyword: LIMIT / OFFSET",
			rootCause:
				"NetSuite SuiteQL does not support MySQL/Postgres-style 'LIMIT' or 'OFFSET' keywords.",
			officialGuidance:
				"Use Oracle-standard pagination: 'ROWNUM <= N' or 'FETCH FIRST N ROWS ONLY' (and 'OFFSET M ROWS FETCH NEXT N ROWS ONLY').",
			suggestedFix:
				"SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' FETCH FIRST 100 ROWS ONLY",
			selfHealingAction:
				"Replace LIMIT/OFFSET with ROWNUM <= N or FETCH FIRST N ROWS ONLY.",
		};
	}

	// 7. SystemNote JOIN error
	if (
		/Prohibited 'JOIN SystemNote'/i.test(err) ||
		(sql &&
			/\bsystemnote\b/i.test(sql) &&
			extractReferencedTables(sql).length > 1)
	) {
		return {
			isDiagnosed: true,
			summary: "Prohibited Multi-Table JOIN with SystemNote",
			rootCause:
				"Joining SystemNote with large transactional/entity tables causes massive Cartesian products and 45s query timeouts.",
			officialGuidance:
				"Query SystemNote as an independent standalone table with strict filters on 'recordid' and a narrow date range.",
			suggestedFix:
				"SELECT recordid, field, oldvalue, newvalue, date, BUILTIN.DF(name) AS author FROM systemnote WHERE recordtypeid = -30 AND recordid = :id AND date >= TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD')",
			selfHealingAction:
				"Separate into a standalone SystemNote query with tight filters on recordid.",
		};
	}

	// 8. Unindexed transaction query
	if (/Unindexed query against 'transaction'/i.test(err)) {
		return {
			isDiagnosed: true,
			summary: "Unindexed Transaction Query (Timeout Risk)",
			rootCause:
				"Querying transaction and transactionline without driving index filters causes full-table scans across millions of rows.",
			officialGuidance:
				"Include at least one indexed filter: 'trandate', 'type', 'id', 'tranid', 'entity', or 'subsidiary'.",
			suggestedFix:
				"WHERE t.type = 'SalesOrd' AND t.trandate >= TO_DATE('2025-01-01', 'YYYY-MM-DD') AND tl.mainline = 'F'",
			selfHealingAction:
				"Add indexed driving filters to the WHERE clause before executing.",
		};
	}

	// Default / Generic SuiteQL Error
	return {
		isDiagnosed: false,
		summary: "SuiteQL Query Error",
		rootCause: err,
		officialGuidance:
			"Verify table and column names using ns_getSuiteQLMetadata, ensure strict read-only SELECT syntax, and include indexed filters.",
		selfHealingAction:
			"1. Call `ns_getSuiteQLMetadata` for referenced table(s) to verify columns. 2. Directly fix query based on the diagnostic and execute.",
	};
}

/**
 * Formats a diagnosed SuiteQL error into a clean Markdown block for MCP tool responses.
 */
export function formatSuiteQLErrorResponse(
	rawError: string,
	sqlQuery?: string,
): string {
	const diag = diagnoseSuiteQLError(rawError, sqlQuery);

	let out = `❌ **SuiteQL Error:** ${rawError}\n\n`;
	out += `🔍 **Diagnostic:** ${diag.summary}\n`;
	out += `📌 **Root Cause:** ${diag.rootCause}\n`;
	out += `📖 **Official NetSuite Guidance:** ${diag.officialGuidance}\n`;
	if (diag.suggestedFix) {
		out += `💡 **Suggested Pattern:**\n\`\`\`sql\n${diag.suggestedFix}\n\`\`\`\n`;
	}
	out += `🔄 **Self-Healing Action:** ${diag.selfHealingAction}`;

	return out;
}
