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
	{
		table: "account",
		column: "acctname",
		fix: "account.fullname, account.accountsearchdisplaynamecopy",
		description:
			"Column 'acctname' does not exist on 'account' in NetSuite2.com SuiteQL. Use 'fullname', 'accountsearchdisplaynamecopy', or 'accountsearchdisplayname' instead.",
	},
	{
		table: "account",
		column: "name",
		fix: "account.fullname, account.accountsearchdisplaynamecopy",
		description:
			"Column 'name' does not exist on 'account' in NetSuite2.com SuiteQL. Use 'fullname' or 'accountsearchdisplaynamecopy' for the account name, or 'acctnumber' for the GL account number.",
	},
	{
		table: "customer",
		column: "credithold",
		fix: "customer.creditholdoverride, customer.oncredithold",
		description:
			"Column 'credithold' does not exist on 'customer' in NetSuite2.com SuiteQL. Use 'creditholdoverride' (with BUILTIN.DF(creditholdoverride) for display status) or 'oncredithold' instead.",
	},
	{
		table: "inventorybalance",
		column: "bin",
		fix: "inventorybalance.binnumber",
		description:
			"Column 'bin' does not exist on 'inventorybalance' in NetSuite2.com SuiteQL. Query 'binnumber' (and BUILTIN.DF(binnumber)) directly without joining the non-queryable 'bin' table.",
	},
	{
		table: "scriptnote",
		column: "time",
		fix: "scriptnote.date",
		description:
			"Column 'time' does not exist on 'ScriptNote' in SuiteQL. Timestamp information is stored in 'date' (use TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS')).",
	},
	{
		table: "scriptnote",
		column: "id",
		fix: "scriptnote.internalid",
		description:
			"Table 'ScriptNote' uses 'internalid' for its primary key, not 'id'.",
	},
	{
		table: "assemblyitembom",
		column: "id",
		fix: "assemblyitembom.assembly, assemblyitembom.billofmaterials",
		description:
			"Table 'assemblyitembom' is a join table without an 'id' column. Query 'assembly', 'billofmaterials', 'currentrevision', and 'masterdefault'.",
	},
	{
		table: "assemblyitembom",
		column: "default",
		fix: "assemblyitembom.masterdefault, assemblyitembom.defaultforlocation",
		description:
			"Column 'default' does not exist on 'assemblyitembom'. Use 'masterdefault' or 'defaultforlocation' instead.",
	},
	{
		table: "pricing",
		column: "quantityrange",
		fix: "pricing.quantity, pricing.priceqty",
		description:
			"Column 'quantityrange' does not exist on 'pricing'. Use 'quantity' or 'priceqty' instead.",
	},
	{
		table: "itemvendor",
		column: "purchaseleadtime",
		fix: "item.leadtime, aggregateitemlocation.leadtime",
		description:
			"Column 'purchaseleadtime' does not exist on 'itemvendor'. Query 'leadtime' on 'item' or 'inventoryitemlocations' instead.",
	},
	{
		table: "savedsearch",
		column: "title",
		fix: "savedsearch.name",
		description:
			"Table 'savedsearch' uses 'name' for the saved search title, not 'title'.",
	},
	{
		table: "savedsearch",
		column: "recordtype",
		fix: "savedsearch.searchtype",
		description:
			"Table 'savedsearch' uses 'searchtype' for the target record/transaction type, not 'recordtype'.",
	},
	{
		table: "transactionshipment",
		column: "trackingnumber",
		fix: "transaction.trackingnumberlist",
		description:
			"Column 'trackingnumber' does not exist on 'TransactionShipment' in SuiteQL. Query 'trackingnumberlist' on 'transaction' instead.",
	},
	{
		table: "inventorynumber",
		column: "quantityonhand",
		fix: "inventorybalance.quantityonhand",
		description:
			"Column 'quantityonhand' does not exist on 'inventorynumber' in NetSuite2.com SuiteQL. Query 'inventorybalance' for lot/serial quantity on hand and quantity available.",
	},
	{
		table: "inventorynumber",
		column: "quantityavailable",
		fix: "inventorybalance.quantityavailable",
		description:
			"Column 'quantityavailable' does not exist on 'inventorynumber' in NetSuite2.com SuiteQL. Query 'inventorybalance' for lot/serial quantity available.",
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

/**
 * Common misnamed ERP tables in NetSuite2.com SuiteQL and their verified table replacements.
 */
export const TABLE_NAME_REMEDIATIONS = new Map<
	string,
	{ targetTable: string; guidance: string; suggestedFix: string }
>([
	[
		"currencyexchangerate",
		{
			targetTable: "currencyrate",
			guidance:
				"Table 'currencyexchangerate' does not exist in NetSuite2.com SuiteQL. Use 'currencyrate' to query daily currency exchange rates.",
			suggestedFix:
				"SELECT id, basecurrency, transactioncurrency, exchangerate, effectivedate FROM currencyrate FETCH FIRST 20 ROWS ONLY",
		},
	],
	[
		"unitsset",
		{
			targetTable: "unitstype",
			guidance:
				"Table 'unitsset' does not exist in NetSuite2.com SuiteQL. Use 'unitstype' to query unit of measure types.",
			suggestedFix:
				"SELECT id, name, isinactive, lastmodifieddate FROM unitstype WHERE isinactive = 'F'",
		},
	],
]);

/**
 * Checks if a table name is a known misnamed ERP table and returns its verified replacement.
 */
export function getTableNameRemediation(
	tableName: string,
): { targetTable: string; guidance: string; suggestedFix: string } | undefined {
	return TABLE_NAME_REMEDIATIONS.get(tableName.toLowerCase().trim());
}
