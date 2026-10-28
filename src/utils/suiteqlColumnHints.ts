/**
 * Authoritative relocation and remediation hints for common NetSuite SuiteQL
 * hallucinated columns and pseudo tables derived from real-world telemetry.
 */

export interface ColumnHint {
	table: string;
	column: string;
	fix: string;
	description: string;
}

export const COLUMN_HINTS: ReadonlyArray<ColumnHint> = [
	{
		table: "transactionline",
		column: "lineuniquekey",
		fix: "transactionline.uniquekey",
		description:
			"'lineuniquekey' is NOT_EXPOSED to SuiteQL search channel. Use 'uniquekey' instead on transactionline.",
	},
	{
		table: "transactionline",
		column: "intercotransaction",
		fix: "transaction.intercotransaction",
		description:
			"'intercotransaction' is a transaction header field on table 'transaction', NOT on 'transactionline'.",
	},
	{
		table: "transactionline",
		column: "closed",
		fix: "transactionline.isclosed",
		description:
			"The line closed flag on transactionline is 'isclosed' ('T'/'F'), not 'closed'.",
	},
	{
		table: "transaction",
		column: "createdfrom",
		fix: "transactionline.createdfrom",
		description:
			"'createdfrom' exists exclusively on 'transactionline', not on 'transaction'. Join transactionline with mainline = 'T' for upstream transaction.",
	},
	{
		table: "item",
		column: "recordtype",
		fix: "item.itemtype, item.subtype",
		description:
			"Table 'item' has columns 'itemtype' and 'subtype', never 'recordtype'.",
	},
	{
		table: "customrecordtype",
		column: "id",
		fix: "customrecordtype.internalid",
		description:
			"Table 'customrecordtype' uses 'internalid' for its primary key, not 'id'.",
	},
	{
		table: "customrecordtype",
		column: "recordname",
		fix: "customrecordtype.name",
		description:
			"Table 'customrecordtype' uses 'name' for the human-readable record name, not 'recordname'.",
	},
];

/**
 * Metadata pseudo-tables that do NOT exist in SuiteQL.
 */
export const PSEUDO_METADATA_TABLES = new Map<string, string>([
	[
		"customfield",
		"In NetSuite, custom field definitions cannot be queried via a 'customfield' SQL table. Call netsuite_get_metadata({ table: '...', source: 'remote' }) to discover custom fields.",
	],
	[
		"oa_columns",
		"OpenAccess/ODBC pseudo-table 'OA_COLUMNS' is not exposed in SuiteQL. Call netsuite_get_metadata({ table: '...' }) to inspect column definitions.",
	],
	[
		"customform",
		"Standard/custom form definitions are not exposed as a queryable SuiteQL table. Use netsuite_get_metadata or SDF XML definitions.",
	],
	[
		"customercurrency",
		"Customer secondary currencies cannot be queried via a 'customercurrency' table in SuiteQL. Secondary currencies can be inspected via netsuite_get_record({ recordType: 'customer', id: '...' }).",
	],
	[
		"tables",
		"Information schema table 'tables' is not supported in SuiteQL. Call netsuite_get_metadata to search available tables.",
	],
]);

/**
 * Finds a known hint for a table and column.
 */
export function findColumnHint(
	table: string,
	column: string,
): ColumnHint | undefined {
	const cleanTable = table.toLowerCase().trim();
	const cleanCol = column.toLowerCase().trim();
	return COLUMN_HINTS.find(
		(h) =>
			h.table.toLowerCase() === cleanTable &&
			h.column.toLowerCase() === cleanCol,
	);
}

/**
 * Checks if a table name is a known metadata pseudo table.
 */
export function getPseudoTableRemediation(
	tableName: string,
): string | undefined {
	const clean = tableName
		.toLowerCase()
		.trim()
		.replace(/^information_schema\./, "");
	return PSEUDO_METADATA_TABLES.get(clean);
}
