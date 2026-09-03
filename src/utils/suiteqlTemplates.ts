/**
 * Curated SuiteQL Query Template Library
 *
 * Sourced from:
 * - Oracle NetSuite SAFE Guide (2025.2 Data Access & Query Standards)
 * - Tim Dietrich SuiteQL Query Library & Best Practices
 * - NetSuite2.com Records Catalog
 */

export interface SuiteQLTemplate {
	id: string;
	name: string;
	category:
		| "transactions"
		| "inventory"
		| "system_debug"
		| "accounting"
		| "relationships";
	description: string;
	sqlTemplate: string;
	params: Record<string, string>;
	bestPractices: string[];
	officialSource: string;
}

export const SUITEQL_TEMPLATES: SuiteQLTemplate[] = [
	{
		id: "transaction_lines",
		name: "Transaction Line Items (Lines & Amounts)",
		category: "transactions",
		description:
			"Retrieve line items with item name, quantity, rate, and amount for any transaction. Eliminates duplicate header totals.",
		sqlTemplate: `SELECT 
  t.id AS tran_id,
  t.tranid AS doc_number,
  t.type AS tran_type,
  t.trandate,
  tl.linesequencenumber,
  tl.item AS item_id,
  BUILTIN.DF(tl.item) AS item_name,
  tl.quantity,
  tl.rate,
  tl.amount
FROM 
  transaction t
  JOIN transactionline tl ON t.id = tl.transaction
WHERE 
  t.type = :tranType 
  AND (t.id = :tranId OR t.tranid = :docNumber)
  AND tl.mainline = \x27F\x27
  AND tl.taxline = \x27F\x27
ORDER BY 
  tl.linesequencenumber ASC
FETCH FIRST 100 ROWS ONLY`,
		params: {
			":tranType":
				"Transaction type code (e.g. \x27SalesOrd\x27, \x27PurchOrd\x27, \x27CustInvc\x27, \x27ItemShip\x27)",
			":tranId":
				"Internal numeric ID of the transaction (or pass 0 if using docNumber)",
			":docNumber": "Document tranid (e.g. \x27SO1002\x27)",
		},
		bestPractices: [
			"Always include tl.mainline = \x27F\x27 to filter out header summary lines, avoiding 2x duplicate rows and inflated amounts.",
			"Use BUILTIN.DF(tl.item) to display the item name directly without joining the huge item master table.",
			"Filter by indexed column t.type for fast index scan.",
		],
		officialSource:
			"Oracle SAFE Guide 2025.2 Section 3.3.7 & SuiteAnswers 80499",
	},
	{
		id: "transaction_lineage_downstream",
		name: "Transaction Lineage (Downstream Linked Documents)",
		category: "transactions",
		description:
			"Find all downstream transactions generated from an upstream transaction (e.g. Item Fulfillments or Invoices created from a Sales Order).",
		sqlTemplate: `SELECT 
  t.id AS downstream_id,
  t.tranid AS downstream_doc_number,
  t.type AS downstream_type,
  BUILTIN.DF(t.type) AS downstream_type_name,
  t.trandate,
  t.status,
  BUILTIN.DF(t.status) AS status_name
FROM 
  transactionline tl
  JOIN transaction t ON tl.transaction = t.id
WHERE 
  tl.createdfrom = :upstreamTranId
  AND tl.mainline = \x27T\x27
ORDER BY 
  t.trandate DESC`,
		params: {
			":upstreamTranId":
				"Internal numeric ID of the origin/upstream transaction (e.g. Sales Order ID)",
		},
		bestPractices: [
			"CRITICAL: createdfrom does NOT exist on the transaction header table. You MUST join on transactionline.createdfrom.",
			"Use tl.mainline = \x27T\x27 to obtain one row per linked downstream transaction header.",
		],
		officialSource:
			"Oracle SAFE Guide 2025.2 Section 3.3.7 & NetSuite2.com Records Catalog",
	},
	{
		id: "multi_location_stock",
		name: "Multi-Location Inventory Balances (All Item Types)",
		category: "inventory",
		description:
			"Get complete stock levels (on hand, available, on order, average cost) across locations for inventory, assembly, lot, and serial items.",
		sqlTemplate: `SELECT 
  a.item AS item_id,
  BUILTIN.DF(a.item) AS item_name,
  a.location AS location_id,
  BUILTIN.DF(a.location) AS location_name,
  a.quantityOnHand,
  a.quantityAvailable,
  a.quantityOnOrder,
  a.quantityBackOrdered,
  a.averageCostMli
FROM 
  aggregateitemlocation a
WHERE 
  (a.item = :itemId OR a.location = :locationId)
ORDER BY 
  a.location ASC
FETCH FIRST 100 ROWS ONLY`,
		params: {
			":itemId": "Item internal ID (numeric)",
			":locationId":
				"Location internal ID (numeric, or 0 if filtering by item)",
		},
		bestPractices: [
			"ALWAYS use aggregateitemlocation instead of inventoryitemlocations (which omits Assembly, Lot, and Serial items).",
			"Avoid querying the monolithic polymorphic item table for stock numbers.",
		],
		officialSource:
			"Oracle SAFE Guide Section 3.3.4 & NetSuite2.com aggregateitemlocation",
	},
	{
		id: "bin_inventory_balance",
		name: "Bin-Level Inventory & Batch Balances",
		category: "inventory",
		description:
			"Detailed bin positions, lot/serial numbers, and quantity available for items in bin-enabled locations.",
		sqlTemplate: `SELECT 
  ib.item AS item_id,
  BUILTIN.DF(ib.item) AS item_name,
  ib.location AS location_id,
  BUILTIN.DF(ib.location) AS location_name,
  b.binnumber,
  ib.inventorynumber AS lot_serial_id,
  BUILTIN.DF(ib.inventorynumber) AS lot_serial_number,
  ib.quantityavailable,
  ib.quantityonhand
FROM 
  inventorybalance ib
  LEFT JOIN bin b ON ib.bin = b.id
WHERE 
  ib.item = :itemId
ORDER BY 
  ib.location, b.binnumber ASC
FETCH FIRST 100 ROWS ONLY`,
		params: {
			":itemId": "Item internal ID (numeric)",
		},
		bestPractices: [
			"Query inventorybalance and join bin on ib.bin = b.id for accurate bin storage data.",
			"Use BUILTIN.DF(ib.inventorynumber) to resolve the actual lot/serial string.",
		],
		officialSource: "NetSuite2.com Records Catalog inventorybalance",
	},
	{
		id: "script_error_logs",
		name: "Script Execution Error Logs",
		category: "system_debug",
		description:
			"Query script execution failures and exceptions with script ID, deployment, timestamp, title, and error stack trace.",
		sqlTemplate: `SELECT 
  sn.id,
  sn.date,
  sn.type,
  sn.title,
  sn.detail,
  s.scriptid AS script_script_id,
  s.name AS script_name
FROM 
  ScriptNote sn
  LEFT JOIN Script s ON sn.scripttype = s.id
WHERE 
  sn.type IN (\x27ERROR\x27, \x27EMERGENCY\x27)
  AND (s.scriptid = :scriptId OR :scriptId IS NULL)
ORDER BY 
  sn.date DESC
FETCH FIRST 50 ROWS ONLY`,
		params: {
			":scriptId":
				"Custom Script ID (e.g. \x27customscript_my_ue\x27), or NULL to query across all scripts",
		},
		bestPractices: [
			"Filters specifically on ERROR/EMERGENCY to avoid flooding with thousands of DEBUG entries.",
			"Requires SuiteScript (ADMI_CUSTOMSCRIPT) permission on the NetSuite role.",
		],
		officialSource:
			"Oracle SuiteScript Logs Reference & Tim Dietrich Script Queries",
	},
	{
		id: "system_notes_standalone",
		name: "Standalone System Audit Trail (SystemNote)",
		category: "system_debug",
		description:
			"Find who changed what field on a record, when it happened, and old vs new values. Completely avoids query timeouts.",
		sqlTemplate: `SELECT 
  sn.recordid,
  sn.date,
  sn.field,
  sn.oldvalue,
  sn.newvalue,
  sn.name AS author_id,
  BUILTIN.DF(sn.name) AS author_name,
  BUILTIN.DF(sn.role) AS role_name
FROM 
  systemnote sn
WHERE 
  sn.recordid = :recordId
ORDER BY 
  sn.date DESC
FETCH FIRST 50 ROWS ONLY`,
		params: {
			":recordId": "Internal numeric ID of the record being investigated",
		},
		bestPractices: [
			"NEVER join SystemNote to transaction in a single query (causes severe 45s+ timeouts). Always query standalone by recordid.",
			"Use BUILTIN.DF(sn.name) to resolve user name and BUILTIN.DF(sn.role) to see under which role the change was submitted.",
		],
		officialSource: "Oracle SAFE Guide Section 3.3.6 & Pitfall 11",
	},
	{
		id: "gl_impact_lines",
		name: "General Ledger (GL) Impact Lines",
		category: "accounting",
		description:
			"Retrieve actual posted GL accounting impact for any transaction with accounts, debits, and credits.",
		sqlTemplate: `SELECT 
  tal.transaction AS tran_id,
  a.acctnumber,
  a.accountsearchdisplaynamecopy AS account_name,
  tal.amount,
  tal.netamount,
  tal.debit,
  tal.credit,
  tal.posting
FROM 
  transactionaccountingline tal
  JOIN account a ON tal.account = a.id
WHERE 
  tal.transaction = :tranId
  AND tal.posting = \x27T\x27
ORDER BY 
  tal.linesequencenumber ASC`,
		params: {
			":tranId": "Internal numeric ID of the transaction",
		},
		bestPractices: [
			"Never attempt to calculate GL postings from transactionline rate/amount. Always query transactionaccountingline.",
			"Filter with tal.posting = \x27T\x27 to view officially posted ledger lines.",
		],
		officialSource: "Oracle NetSuite Accounting Records Catalog & SAFE Guide",
	},
	{
		id: "customer_balance_aging",
		name: "Customer Balance & Credit Limit Status",
		category: "relationships",
		description:
			"Check customer financial standing: balance, unbilled orders, credit limit, and hold status.",
		sqlTemplate: `SELECT 
  c.id,
  c.entityid AS customer_number,
  c.companyname,
  c.balance,
  c.unbilledorders,
  c.creditlimit,
  c.credithold,
  BUILTIN.DF(c.credithold) AS credithold_status,
  BUILTIN.DF(c.terms) AS payment_terms
FROM 
  customer c
WHERE 
  c.id = :customerId OR c.entityid = :customerCode
FETCH FIRST 10 ROWS ONLY`,
		params: {
			":customerId": "Customer internal numeric ID",
			":customerCode": "Customer code/entityid (e.g. \x27CUST001\x27)",
		},
		bestPractices: [
			"Use customer.unbilledorders to see pipeline commitment against credit limit.",
			"BUILTIN.DF(c.credithold) displays human-readable status (Auto Hold, On Hold, Off).",
		],
		officialSource: "Tim Dietrich SuiteQL Library - Customer Queries",
	},
];

export class SuiteQLTemplateService {
	listTemplates(category?: string): SuiteQLTemplate[] {
		if (!category) return SUITEQL_TEMPLATES;
		return SUITEQL_TEMPLATES.filter((t) => t.category === category);
	}

	getTemplate(id: string): SuiteQLTemplate | undefined {
		return SUITEQL_TEMPLATES.find((t) => t.id === id);
	}

	searchTemplates(keyword: string): SuiteQLTemplate[] {
		const kw = keyword.toLowerCase().trim();
		return SUITEQL_TEMPLATES.filter(
			(t) =>
				t.id.toLowerCase().includes(kw) ||
				t.name.toLowerCase().includes(kw) ||
				t.description.toLowerCase().includes(kw) ||
				t.sqlTemplate.toLowerCase().includes(kw),
		);
	}
}

export const suiteqlTemplateService = new SuiteQLTemplateService();
