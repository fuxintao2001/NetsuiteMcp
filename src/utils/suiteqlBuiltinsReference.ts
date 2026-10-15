/**
 * Oracle NetSuite Official SuiteQL Built-in Functions Reference
 * Sourced from Oracle NetSuite Help Center, Records Catalog & SAFE Guide 2025.2.
 */

export interface SuiteQLBuiltinParam {
	name: string;
	type: string;
	required: boolean;
	description: string;
	allowedValues?: string[];
	defaultValue?: string;
}

export interface SuiteQLBuiltinExample {
	title: string;
	sql: string;
	explanation: string;
}

export interface SuiteQLBuiltinFunction {
	name: string;
	signature: string;
	description: string;
	category:
		| "Display & Formatting"
		| "Hierarchy Navigation"
		| "Periods & Dates"
		| "Currency & Consolidation";
	parameters: SuiteQLBuiltinParam[];
	returns: string;
	safePitfalls: string[];
	officialSource: string;
	examples: SuiteQLBuiltinExample[];
}

export const OFFICIAL_SUITEQL_BUILTINS: SuiteQLBuiltinFunction[] = [
	{
		name: "BUILTIN.DF",
		signature: "BUILTIN.DF(field_reference)",
		description:
			"Resolves the human-readable text / display value of a reference, select, or multi-select field without requiring an explicit SQL JOIN to the target record type.",
		category: "Display & Formatting",
		parameters: [
			{
				name: "field_reference",
				type: "Field",
				required: true,
				description:
					"Field identifier for a foreign key, reference, or list column (e.g. Transaction.Entity, TransactionLine.Item, Transaction.Status).",
			},
		],
		returns: "VARCHAR2 / String",
		safePitfalls: [
			"SAFE Guide Pitfall 10: Incompatible with 'SELECT DISTINCT' and 'GROUP BY'. Using BUILTIN.DF() in GROUP BY or with DISTINCT throws 'Invalid or unsupported search'.",
			"For GROUP BY aggregation, group by the underlying numeric ID or use SUM(CASE WHEN BUILTIN.DF(field) = 'Val' THEN 1 ELSE 0 END).",
			"Be cautious with nullable fields: In certain SuiteQL engines, referencing null fields through BUILTIN.DF() may drop the row from the result set unless guarded with NVL or outer joined.",
		],
		officialSource:
			"Oracle NetSuite SuiteQL Documentation & SAFE Guide Section 3.3.3",
		examples: [
			{
				title: "Extract Customer Name and Status Label without Joins",
				sql: `SELECT
  id,
  tranid,
  BUILTIN.DF(entity) AS customer_name,
  BUILTIN.DF(status) AS status_display
FROM transaction
WHERE type = 'SalesOrd'
FETCH FIRST 10 ROWS ONLY`,
				explanation:
					"Directly retrieves entity company name and status display string in 1 single turn.",
			},
		],
	},
	{
		name: "BUILTIN.CF",
		signature: "BUILTIN.CF(field_reference)",
		description:
			"Extracts the criteria context value of a composite or context-dependent field (such as transaction.status), converting UI filter tokens to queryable values.",
		category: "Display & Formatting",
		parameters: [
			{
				name: "field_reference",
				type: "Field",
				required: true,
				description:
					"Composite field reference where display representation differs from filtering criteria (e.g. transaction.status).",
			},
		],
		returns: "VARCHAR2 / String",
		safePitfalls: [
			"Primarily used when filtering or projecting composite state fields.",
		],
		officialSource: "Oracle NetSuite SuiteQL Data Access Reference",
		examples: [
			{
				title: "Retrieve Criteria Context for Transaction Status",
				sql: `SELECT
  id,
  tranid,
  status,
  BUILTIN.CF(status) AS criteria_status
FROM transaction
WHERE type = 'SalesOrd'
FETCH FIRST 10 ROWS ONLY`,
				explanation:
					"Exposes both raw database status and criteria context status.",
			},
		],
	},
	{
		name: "BUILTIN.HIERARCHY",
		signature: "BUILTIN.HIERARCHY(hierarchical_field, format_type)",
		description:
			"Traverses and formats parent-child recursive trees (Chart of Accounts, Departments, Classes, Locations, Item Assemblies) without recursive CTEs or expensive self-joins.",
		category: "Hierarchy Navigation",
		parameters: [
			{
				name: "hierarchical_field",
				type: "Field",
				required: true,
				description:
					"Field referencing a hierarchical parent-child table (e.g. account, department, class, location).",
			},
			{
				name: "format_type",
				type: "String Literal",
				required: true,
				description: "Formatting mode string enclosed in single quotes.",
				allowedValues: [
					"'DISPLAY'",
					"'DISPLAY_JOINED'",
					"'DISPLAY_SEPARATED'",
					"'IDENTIFIER'",
					"'IDENTIFIER_SEPARATED'",
					"'LEVEL'",
				],
			},
		],
		returns: "VARCHAR2 or NUMBER (when format_type is 'LEVEL')",
		safePitfalls: [
			"Format parameter MUST be a literal string enclosed in single quotes (e.g. 'DISPLAY_JOINED'). Passing unquoted identifiers triggers a syntax error.",
			"Do not use on non-hierarchical fields.",
		],
		officialSource:
			"Oracle NetSuite SuiteQL Reference & Accounting Tree Modeling",
		examples: [
			{
				title: "Hierarchical Chart of Accounts Path & Tree Level",
				sql: `SELECT
  tal.account,
  BUILTIN.HIERARCHY(tal.account, 'DISPLAY_JOINED') AS account_full_path,
  BUILTIN.HIERARCHY(tal.account, 'LEVEL') AS account_depth
FROM transactionaccountingline tal
WHERE tal.posting = 'T'
FETCH FIRST 20 ROWS ONLY`,
				explanation:
					"Renders paths like '4000 Revenue : 4100 Sales' alongside integer tree depth.",
			},
		],
	},
	{
		name: "BUILTIN.PERIOD",
		signature: "BUILTIN.PERIOD(range_id, range_type, adjustment, operator)",
		description:
			"Evaluates relative accounting period tokens (e.g. Last Fiscal Year, This Month) into dynamic posting period sub-selection predicates for use with IN clauses.",
		category: "Periods & Dates",
		parameters: [
			{
				name: "range_id",
				type: "String Literal",
				required: true,
				description: "Relative accounting period token code.",
				allowedValues: [
					"'LFY' (Last Fiscal Year)",
					"'TFY' (This Fiscal Year)",
					"'LM' (Last Month)",
					"'TM' (This Month)",
					"'LQ' (Last Quarter)",
					"'TQ' (This Quarter)",
					"'LP' (Last Period)",
					"'TP' (This Period)",
				],
			},
			{
				name: "range_type",
				type: "String Literal",
				required: true,
				description: "Boundary selector: 'START' or 'END'.",
				allowedValues: ["'START'", "'END'"],
			},
			{
				name: "adjustment",
				type: "String Literal",
				required: true,
				description:
					"Adjustment period handling (e.g. Period 13 year-end close).",
				allowedValues: [
					"'NOT_LAST' (Exclude year-end adjustments)",
					"'ALL' (Include all adjustment periods)",
				],
			},
			{
				name: "operator",
				type: "String Literal",
				required: true,
				description: "Conditional comparison operator for boundary evaluation.",
				allowedValues: [
					"'BETWEEN'",
					"'NOT BETWEEN'",
					"'<'",
					"'<='",
					"'>'",
					"'>='",
				],
			},
		],
		returns: "Subquery / IN predicate clause",
		safePitfalls: [
			"Must be used inside an 'IN' predicate, e.g. 'WHERE postingperiod IN BUILTIN.PERIOD(...)'.",
			"All arguments must be single-quoted strings.",
		],
		officialSource:
			"Oracle NetSuite Financial Management & SuiteQL Period Mechanics",
		examples: [
			{
				title: "Filter Transactions Posted in Last Fiscal Year",
				sql: `SELECT
  id,
  tranid,
  postingperiod,
  BUILTIN.DF(postingperiod) AS period_name
FROM transaction
WHERE postingperiod IN BUILTIN.PERIOD('LFY', 'END', 'NOT_LAST', 'BETWEEN')
FETCH FIRST 50 ROWS ONLY`,
				explanation:
					"Automatically bounds query to periods within the previous fiscal year without hardcoding period IDs.",
			},
		],
	},
	{
		name: "BUILTIN.CONSOLIDATE",
		signature:
			"BUILTIN.CONSOLIDATE(amount_field, view_type, consolidation_rate_type, subsidiary_rate_type, target_subsidiary, period, book)",
		description:
			"Converts transactional or general ledger monetary amounts into a parent subsidiary's base currency using NetSuite consolidated exchange rates.",
		category: "Currency & Consolidation",
		parameters: [
			{
				name: "amount_field",
				type: "Field Expression",
				required: true,
				description:
					"Monetary field expression (e.g. TransactionAccountingLine.Amount, TransactionAccountingLine.Debit, TransactionAccountingLine.Credit).",
			},
			{
				name: "view_type",
				type: "String Literal",
				required: true,
				description: "Financial statement view: 'LEDGER' or 'INCOME'.",
				allowedValues: ["'LEDGER'", "'INCOME'"],
			},
			{
				name: "consolidation_rate_type",
				type: "String Literal",
				required: true,
				description:
					"Consolidation rate model. Pass 'DEFAULT' to use account setup rules.",
				allowedValues: ["'DEFAULT'", "'STANDARD'", "'BUDGET'"],
				defaultValue: "'DEFAULT'",
			},
			{
				name: "subsidiary_rate_type",
				type: "String Literal",
				required: true,
				description: "Exchange rate mechanism based on subsidiary rules.",
				allowedValues: ["'DEFAULT'", "'CURRENT'", "'HISTORICAL'", "'AVERAGE'"],
				defaultValue: "'DEFAULT'",
			},
			{
				name: "target_subsidiary",
				type: "Number or Expression",
				required: true,
				description:
					"Numeric internal ID of target parent subsidiary to consolidate into.",
			},
			{
				name: "period",
				type: "Number or Expression",
				required: true,
				description:
					"Internal ID of the accounting period (AccountingPeriod.ID) for period-specific rates.",
			},
			{
				name: "book",
				type: "String or Number",
				required: true,
				description:
					"Accounting Book ID or 'DEFAULT' for the primary accounting book.",
				defaultValue: "'DEFAULT'",
			},
		],
		returns: "NUMBER (Consolidated Currency Amount)",
		safePitfalls: [
			"Most reliable when applied to line-level GL impact amounts on TransactionAccountingLine.",
			"Target subsidiary must be an ancestor of or equal to the source transaction subsidiary in the subsidiary hierarchy.",
		],
		officialSource:
			"Oracle NetSuite Multi-Subsidiary Financial Consolidation Guide",
		examples: [
			{
				title: "Multi-Subsidiary GL Posting Income Consolidation",
				sql: `SELECT
  tal.transaction,
  tal.account,
  BUILTIN.DF(tal.account) AS account_name,
  tal.amount AS local_amount,
  BUILTIN.CONSOLIDATE(tal.amount, 'INCOME', 'DEFAULT', 'DEFAULT', 1, 263, 'DEFAULT') AS consolidated_amount
FROM transactionaccountingline tal
WHERE tal.posting = 'T'
FETCH FIRST 50 ROWS ONLY`,
				explanation:
					"Converts lines to Consolidated Subsidiary (ID: 1) for Accounting Period 263.",
			},
		],
	},
	{
		name: "BUILTIN.RELATIVE_RANGES",
		signature: "BUILTIN.RELATIVE_RANGES(range_id, range_type, [date_flag])",
		description:
			"Evaluates relative calendar date boundaries (Today, Yesterday, This Week, Last Year) into concrete dates for comparison predicates.",
		category: "Periods & Dates",
		parameters: [
			{
				name: "range_id",
				type: "String Literal",
				required: true,
				description: "Relative date token code.",
				allowedValues: [
					"'TODAY'",
					"'YESTERDAY'",
					"'TOMORROW'",
					"'TW' (This Week)",
					"'LW' (Last Week)",
					"'TM' (This Month)",
					"'LM' (Last Month)",
					"'TQ' (This Quarter)",
					"'LQ' (Last Quarter)",
					"'TY' (This Year)",
					"'LFY' (Last Fiscal Year)",
				],
			},
			{
				name: "range_type",
				type: "String Literal",
				required: true,
				description: "Boundary selector: 'START' or 'END'.",
				allowedValues: ["'START'", "'END'"],
			},
			{
				name: "date_flag",
				type: "String Literal",
				required: false,
				description: "Optional format specifier.",
				allowedValues: [
					"'DATE'",
					"'DATETIME_AS_DATE'",
					"'TIMESTAMP_WITH_TIMEZONE'",
				],
			},
		],
		returns: "DATE / DATETIME",
		safePitfalls: [
			"Ensure range_id and range_type are quoted string literals.",
		],
		officialSource: "Oracle NetSuite SuiteQL Dynamic Range Documentation",
		examples: [
			{
				title: "Query Transactions Created Since Beginning of Year",
				sql: `SELECT
  id,
  tranid,
  trandate
FROM transaction
WHERE trandate >= BUILTIN.RELATIVE_RANGES('TY', 'START')
FETCH FIRST 50 ROWS ONLY`,
				explanation:
					"Calculates current year start date automatically at query runtime.",
			},
		],
	},
	{
		name: "BUILTIN.CURRENCY",
		signature: "BUILTIN.CURRENCY(amount_field)",
		description:
			"Formats a numeric monetary value using the account's or subsidiary's default currency formatting rules and decimal precision.",
		category: "Display & Formatting",
		parameters: [
			{
				name: "amount_field",
				type: "Field Expression",
				required: true,
				description: "Numeric currency field to format.",
			},
		],
		returns: "VARCHAR2",
		safePitfalls: [
			"Formatted output is string text; do not perform arithmetic on the result.",
		],
		officialSource: "Oracle NetSuite SuiteQL Formatting Reference",
		examples: [
			{
				title: "Format Transaction Header Total with Currency",
				sql: `SELECT
  id,
  tranid,
  total,
  BUILTIN.CURRENCY(total) AS formatted_total
FROM transaction
WHERE type = 'SalesOrd'
FETCH FIRST 10 ROWS ONLY`,
				explanation: "Formats total with currency symbols.",
			},
		],
	},
];

export function getAllSuiteQLBuiltins(): SuiteQLBuiltinFunction[] {
	return [...OFFICIAL_SUITEQL_BUILTINS];
}

export function getSuiteQLBuiltinByName(
	name: string,
): SuiteQLBuiltinFunction | undefined {
	const clean = name.trim().toUpperCase();
	return OFFICIAL_SUITEQL_BUILTINS.find((b) => b.name.toUpperCase() === clean);
}

export function formatSuiteQLBuiltinsMarkdown(): string {
	let md = `# Oracle NetSuite2.com Official SuiteQL Built-in Functions Reference\n\n`;
	md += `> **Authority**: Oracle NetSuite Official Documentation, Records Catalog & SAFE Guide (2025.2)\n`;
	md += `> **Standard**: NetSuite2.com Data Model Extension Functions\n\n`;

	md += `## 📋 Overview of Built-in Functions\n\n`;
	md += `| Function Name | Category | Primary Purpose |\n|:---|:---|:---|\n`;
	for (const fn of OFFICIAL_SUITEQL_BUILTINS) {
		md += `| \`${fn.name}\` | ${fn.category} | ${fn.description.split(".")[0]}. |\n`;
	}
	md += `\n---\n\n`;

	for (const fn of OFFICIAL_SUITEQL_BUILTINS) {
		md += `## \`${fn.name}\` — ${fn.category}\n\n`;
		md += `**Signature**:\n\`\`\`sql\n${fn.signature}\n\`\`\`\n\n`;
		md += `**Returns**: \`${fn.returns}\` | **Official Source**: ${fn.officialSource}\n\n`;
		md += `### Description\n${fn.description}\n\n`;

		md += `### Parameters\n`;
		md += `| Parameter | Type | Required | Description | Allowed Values / Default |\n|:---|:---|:---:|:---|:---|\n`;
		for (const p of fn.parameters) {
			const allowed = p.allowedValues
				? p.allowedValues.join(", ")
				: p.defaultValue
					? `Default: ${p.defaultValue}`
					: "Any";
			md += `| \`${p.name}\` | \`${p.type}\` | ${p.required ? "Yes" : "No"} | ${p.description} | ${allowed} |\n`;
		}
		md += `\n`;

		if (fn.safePitfalls.length > 0) {
			md += `### ⚠️ SAFE Pitfalls & Guardrail Constraints\n`;
			for (const pit of fn.safePitfalls) {
				md += `- ${pit}\n`;
			}
			md += `\n`;
		}

		if (fn.examples.length > 0) {
			md += `### 💡 Production Query Examples\n\n`;
			for (const ex of fn.examples) {
				md += `#### ${ex.title}\n`;
				md += `\`\`\`sql\n${ex.sql}\n\`\`\`\n`;
				md += `> *${ex.explanation}*\n\n`;
			}
		}

		md += `---\n\n`;
	}

	return md;
}
