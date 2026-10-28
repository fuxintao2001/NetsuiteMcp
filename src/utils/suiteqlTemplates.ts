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
	aliases?: string[];
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

const NUMERIC_TEMPLATE_PARAMS = new Set([
	":tranid",
	":upstreamtranid",
	":itemid",
	":locationid",
	":recordid",
	":customerid",
]);

/**
 * Formats a raw template parameter value into a safe Oracle SuiteQL literal.
 */
export function formatSuiteQLTemplateParamValue(
	paramKey: string,
	rawValue: string | undefined,
): string {
	if (rawValue === undefined || rawValue === null) {
		return "NULL";
	}
	const trimmed = String(rawValue).trim();
	if (trimmed.length === 0 || trimmed.toUpperCase() === "NULL") {
		return "NULL";
	}
	// Already single-quoted literal (e.g. "'SalesOrd'" or "''")
	if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
		return trimmed;
	}
	const normalizedKey = (
		paramKey.startsWith(":") ? paramKey : `:${paramKey}`
	).toLowerCase();
	if (
		NUMERIC_TEMPLATE_PARAMS.has(normalizedKey) &&
		/^-?\d+(?:\.\d+)?$/.test(trimmed)
	) {
		return trimmed;
	}
	// If it's a pure number and not a string-typed code/docNumber parameter, allow numeric binding
	if (
		/^-?\d+(?:\.\d+)?$/.test(trimmed) &&
		normalizedKey !== ":docnumber" &&
		normalizedKey !== ":customercode" &&
		normalizedKey !== ":trantype" &&
		normalizedKey !== ":scriptid" &&
		normalizedKey !== ":recordtype"
	) {
		return trimmed;
	}
	return `'${trimmed.replace(/'/g, "''")}'`;
}

/**
 * Renders a SuiteQLTemplate by binding provided parameters and replacing any
 * omitted optional placeholders with NULL.
 */
export function renderSuiteQLTemplate(
	template: SuiteQLTemplate,
	params?: Record<string, string>,
): string {
	const normalizedInput = new Map<string, string>();
	if (params && typeof params === "object") {
		for (const [k, v] of Object.entries(params)) {
			const cleanKey = (k.startsWith(":") ? k : `:${k}`).toLowerCase();
			normalizedInput.set(cleanKey, String(v));
		}
	}

	let rendered = template.sqlTemplate;
	// Bind all declared template parameters (longest key first to avoid prefix collisions)
	const declaredKeys = Object.keys(template.params).sort(
		(a, b) => b.length - a.length,
	);
	for (const key of declaredKeys) {
		const lookupKey = (key.startsWith(":") ? key : `:${key}`).toLowerCase();
		const rawVal = normalizedInput.get(lookupKey);
		const formatted = formatSuiteQLTemplateParamValue(key, rawVal);
		rendered = rendered.replaceAll(key, formatted);
	}

	// Also bind any extra caller-provided parameters not listed in template.params
	if (params && typeof params === "object") {
		for (const [k, v] of Object.entries(params)) {
			const colonKey = k.startsWith(":") ? k : `:${k}`;
			if (rendered.includes(colonKey)) {
				const formatted = formatSuiteQLTemplateParamValue(colonKey, String(v));
				rendered = rendered.replaceAll(colonKey, formatted);
			}
		}
	}

	return rendered;
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
		aliases: ["transaction_lineage"],
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
		aliases: ["multi_location_inventory"],
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
		aliases: ["item_inventory_status"],
		name: "Bin-Level Inventory & Batch Balances",
		category: "inventory",
		description:
			"Detailed bin positions, lot/serial numbers, and quantity available for items in bin-enabled locations.",
		sqlTemplate: `SELECT 
  ib.item AS item_id,
  BUILTIN.DF(ib.item) AS item_name,
  ib.location AS location_id,
  BUILTIN.DF(ib.location) AS location_name,
  ib.binnumber AS bin_id,
  BUILTIN.DF(ib.binnumber) AS bin_number,
  ib.inventorynumber AS lot_serial_id,
  BUILTIN.DF(ib.inventorynumber) AS lot_serial_number,
  ib.quantityavailable,
  ib.quantityonhand,
  ib.quantitypicked
FROM 
  inventorybalance ib
WHERE 
  ib.item = :itemId
ORDER BY 
  ib.location, ib.binnumber ASC
FETCH FIRST 100 ROWS ONLY`,
		params: {
			":itemId": "Item internal ID (numeric)",
		},
		bestPractices: [
			"Query inventorybalance directly using ib.binnumber and BUILTIN.DF(ib.binnumber); do NOT join the 'bin' table (which is not exposed in SuiteQL).",
			"Use BUILTIN.DF(ib.inventorynumber) to resolve the actual lot/serial string.",
		],
		officialSource: "NetSuite2.com Records Catalog inventorybalance",
	},
	{
		id: "script_error_logs",
		aliases: ["script_execution_errors"],
		name: "Script Execution Error Logs",
		category: "system_debug",
		description:
			"Query script execution failures and exceptions with script ID, deployment, timestamp, title, and error stack trace.",
		sqlTemplate: `SELECT 
  TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date,
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
  AND (UPPER(s.scriptid) = UPPER(:scriptId) OR :scriptId IS NULL)
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
		aliases: ["audit_system_notes"],
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
		aliases: ["general_ledger_impact"],
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
		aliases: ["entity_balance_summary"],
		name: "Customer Balance & Credit Limit Status",
		category: "relationships",
		description:
			"Check customer financial standing: balance, overdue balance, unbilled orders, credit limit, and hold status.",
		sqlTemplate: `SELECT 
  c.id,
  c.entityid AS customer_number,
  c.companyname,
  c.balance,
  c.overduebalance,
  c.unbilledorders,
  c.creditlimit,
  c.creditholdoverride,
  BUILTIN.DF(c.creditholdoverride) AS credithold_status,
  c.oncredithold,
  c.daysoverduesearch AS days_overdue,
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
			"Use customer.unbilledorders and customer.overduebalance to see pipeline commitment and overdue exposure against credit limit.",
			"In NetSuite2.com SuiteQL, credit hold status is exposed via c.creditholdoverride (with BUILTIN.DF(c.creditholdoverride)) and c.oncredithold, NOT c.credithold.",
		],
		officialSource:
			"Oracle NetSuite Records Catalog & SAFE Guide Section 3.3.7 (Tim Dietrich SuiteQL Library)",
	},
	{
		id: "record_deployed_scripts",
		aliases: ["deployed_scripts"],
		name: "Scripts Deployed to Record Type (User Events, Client & Action Scripts)",
		category: "system_debug",
		description:
			"Inspect all SuiteScripts and Workflows deployed to a given record type (e.g. Sales Order, Customer, Invoice) along with their entry point handlers and active status.",
		sqlTemplate: `SELECT 
  s.id AS script_id,
  s.scriptid AS script_text_id,
  s.name AS script_name,
  s.scripttype AS script_type,
  sd.primarykey AS deployment_id,
  sd.scriptid AS deployment_text_id,
  sd.status,
  sd.isdeployed,
  s.isinactive,
  s.beforeloadfunction,
  s.beforesubmitfunction,
  s.aftersubmitfunction
FROM 
  ScriptDeployment sd
  INNER JOIN Script s ON sd.script = s.id
WHERE 
  UPPER(sd.recordtype) = UPPER(:recordType)
ORDER BY 
  s.scripttype, s.name`,
		params: {
			":recordType":
				"Record type script ID (e.g. \x27SALESORDER\x27, \x27CUSTOMER\x27, \x27INVOICE\x27, or custom record ID)",
		},
		bestPractices: [
			"Essential diagnostic query when debugging record save errors or slow UI performance.",
			"Filters by uppercase recordtype on ScriptDeployment table to reveal all active User Event and Client scripts.",
		],
		officialSource:
			"Oracle NetSuite SAFE Guide 2025.2 & ScriptDeployment Records Catalog",
	},
];

export class SuiteQLTemplateService {
	listTemplates(category?: string): SuiteQLTemplate[] {
		if (!category) return SUITEQL_TEMPLATES;
		return SUITEQL_TEMPLATES.filter((t) => t.category === category);
	}

	getTemplate(id: string): SuiteQLTemplate | undefined {
		const cleanId = id.trim().toLowerCase();
		return SUITEQL_TEMPLATES.find(
			(t) =>
				t.id.toLowerCase() === cleanId ||
				t.aliases?.some((a) => a.toLowerCase() === cleanId),
		);
	}

	renderTemplate(
		templateOrId: SuiteQLTemplate | string,
		params?: Record<string, string>,
	): string | undefined {
		const tmpl =
			typeof templateOrId === "string"
				? this.getTemplate(templateOrId)
				: templateOrId;
		if (!tmpl) return undefined;
		return renderSuiteQLTemplate(tmpl, params);
	}

	searchTemplates(keyword: string): SuiteQLTemplate[] {
		const kw = keyword.toLowerCase().trim();
		return SUITEQL_TEMPLATES.filter(
			(t) =>
				t.id.toLowerCase().includes(kw) ||
				t.aliases?.some((a) => a.toLowerCase().includes(kw)) ||
				t.name.toLowerCase().includes(kw) ||
				t.description.toLowerCase().includes(kw) ||
				t.sqlTemplate.toLowerCase().includes(kw),
		);
	}
}

export const suiteqlTemplateService = new SuiteQLTemplateService();
