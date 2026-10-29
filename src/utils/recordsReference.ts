import fs from "node:fs";
import path from "node:path";
import { getSkillsDir } from "./environment.js";

export interface RecordFieldMeta {
	internalId: string;
	label: string;
	type: string;
	required: boolean;
	help?: string;
	foreignKey?: { table: string; field?: string };
}

export interface RecordSublistMeta {
	name: string;
	label?: string;
	fields?: RecordFieldMeta[];
}

export interface RecordRelationMeta {
	field: string;
	targetTable: string;
	targetField?: string;
	type: "foreignKey" | "primaryKey" | "oneToMany" | "manyToOne";
	description?: string;
}

export interface RecordTypeMeta {
	internalId: string;
	label?: string;
	description?: string;
	fields: RecordFieldMeta[];
	sublists?: RecordSublistMeta[];
	relations?: RecordRelationMeta[];
	primaryKey?: string;
}

export interface RecordDefinitionResult {
	recordType: string;
	found: boolean;
	totalFields: number;
	fields: RecordFieldMeta[];
	sublists?: RecordSublistMeta[];
	relations?: RecordRelationMeta[];
	primaryKey?: string;
	description?: string;
}

export const TRANSACTION_ACCOUNTING_LINE_FIELDS: RecordFieldMeta[] = [
	{
		internalId: "transaction",
		label: "Transaction ID",
		type: "integer",
		required: true,
		help: "Internal ID of parent transaction header.",
		foreignKey: { table: "transaction", field: "id" },
	},
	{
		internalId: "transactionline",
		label: "Transaction Line ID",
		type: "integer",
		required: true,
		help: "Line sequence identifier on the transaction.",
		foreignKey: { table: "transactionline", field: "id" },
	},
	{
		internalId: "account",
		label: "Account ID",
		type: "select",
		required: true,
		help: "General Ledger account posted by this line.",
		foreignKey: { table: "account", field: "id" },
	},
	{
		internalId: "amount",
		label: "Net Amount",
		type: "currency",
		required: true,
		help: "Net monetary impact in transaction currency.",
	},
	{
		internalId: "debit",
		label: "Debit Amount",
		type: "currency",
		required: false,
		help: "Debit amount posted to GL.",
	},
	{
		internalId: "credit",
		label: "Credit Amount",
		type: "currency",
		required: false,
		help: "Credit amount posted to GL.",
	},
	{
		internalId: "netamount",
		label: "Net Transaction Amount",
		type: "currency",
		required: false,
	},
	{
		internalId: "posting",
		label: "Posting Flag",
		type: "checkbox",
		required: true,
		help: "Must be 'T' to post to General Ledger.",
	},
	{
		internalId: "accountingbook",
		label: "Accounting Book",
		type: "select",
		required: false,
		foreignKey: { table: "accountingbook", field: "id" },
	},
	{
		internalId: "subsidiary",
		label: "Subsidiary",
		type: "select",
		required: false,
		foreignKey: { table: "subsidiary", field: "id" },
	},
	{
		internalId: "department",
		label: "Department",
		type: "select",
		required: false,
		foreignKey: { table: "department", field: "id" },
	},
	{
		internalId: "class",
		label: "Class",
		type: "select",
		required: false,
		foreignKey: { table: "classification", field: "id" },
	},
	{
		internalId: "location",
		label: "Location",
		type: "select",
		required: false,
		foreignKey: { table: "location", field: "id" },
	},
];

export const TRANSACTION_LINE_FIELDS: RecordFieldMeta[] = [
	{
		internalId: "id",
		label: "Line Internal ID",
		type: "integer",
		required: true,
		help: "Unique internal ID of the transaction line.",
	},
	{
		internalId: "transaction",
		label: "Transaction ID",
		type: "integer",
		required: true,
		help: "Internal ID of the parent transaction header.",
		foreignKey: { table: "transaction", field: "id" },
	},
	{
		internalId: "linesequencenumber",
		label: "Line Sequence Number",
		type: "integer",
		required: true,
	},
	{
		internalId: "item",
		label: "Item ID",
		type: "select",
		required: false,
		foreignKey: { table: "item", field: "id" },
	},
	{
		internalId: "quantity",
		label: "Quantity",
		type: "float",
		required: false,
	},
	{
		internalId: "rate",
		label: "Unit Rate",
		type: "currency",
		required: false,
	},
	{
		internalId: "amount",
		label: "Line Total Amount",
		type: "currency",
		required: false,
	},
	{
		internalId: "mainline",
		label: "Mainline Flag",
		type: "checkbox",
		required: true,
		help: "Must filter tl.mainline = 'F' for line items or 'T' for summary line.",
	},
	{
		internalId: "taxline",
		label: "Tax Line Flag",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "createdfrom",
		label: "Created From (Lineage)",
		type: "select",
		required: false,
		help: "Upstream source transaction (e.g. Sales Order for Item Fulfillment).",
		foreignKey: { table: "transaction", field: "id" },
	},
	{
		internalId: "location",
		label: "Location",
		type: "select",
		required: false,
		foreignKey: { table: "location", field: "id" },
	},
	{
		internalId: "department",
		label: "Department",
		type: "select",
		required: false,
		foreignKey: { table: "department", field: "id" },
	},
	{
		internalId: "class",
		label: "Class",
		type: "select",
		required: false,
		foreignKey: { table: "classification", field: "id" },
	},
	{
		internalId: "subsidiary",
		label: "Subsidiary",
		type: "select",
		required: false,
		foreignKey: { table: "subsidiary", field: "id" },
	},
	{
		internalId: "units",
		label: "Units of Measure",
		type: "select",
		required: false,
	},
	{
		internalId: "memo",
		label: "Line Memo",
		type: "text",
		required: false,
	},
];

export const BILLING_REVENUE_EVENT_FIELDS: RecordFieldMeta[] = [
	{
		internalId: "id",
		label: "Internal ID",
		type: "integer",
		required: true,
	},
	{
		internalId: "eventtype",
		label: "Event Type",
		type: "select",
		required: true,
	},
	{
		internalId: "transaction",
		label: "Transaction ID",
		type: "select",
		required: true,
		foreignKey: { table: "transaction", field: "id" },
	},
	{
		internalId: "transactionline",
		label: "Transaction Line ID",
		type: "select",
		required: false,
		foreignKey: { table: "transactionline", field: "id" },
	},
	{
		internalId: "revenueelement",
		label: "Revenue Element",
		type: "select",
		required: false,
		foreignKey: { table: "revenueelement", field: "id" },
	},
	{
		internalId: "amount",
		label: "Revenue Amount",
		type: "currency",
		required: true,
	},
	{
		internalId: "quantity",
		label: "Quantity",
		type: "float",
		required: false,
	},
	{
		internalId: "eventdate",
		label: "Event Date",
		type: "date",
		required: true,
	},
	{
		internalId: "createddate",
		label: "Date Created",
		type: "datetime",
		required: false,
	},
	{
		internalId: "subsidiary",
		label: "Subsidiary",
		type: "select",
		required: true,
		foreignKey: { table: "subsidiary", field: "id" },
	},
	{
		internalId: "customform",
		label: "Custom Form",
		type: "select",
		required: false,
	},
];

export const SYSTEM_NOTE_FIELDS: RecordFieldMeta[] = [
	{
		internalId: "id",
		label: "Internal ID",
		type: "integer",
		required: true,
	},
	{
		internalId: "recordid",
		label: "Target Record Internal ID",
		type: "integer",
		required: true,
	},
	{
		internalId: "recordtypeid",
		label: "Record Type Numeric ID",
		type: "integer",
		required: true,
	},
	{
		internalId: "name",
		label: "User / Employee ID",
		type: "select",
		required: true,
		foreignKey: { table: "employee", field: "id" },
	},
	{
		internalId: "date",
		label: "Date & Time",
		type: "datetime",
		required: true,
	},
	{
		internalId: "field",
		label: "Field Name Changed",
		type: "text",
		required: false,
	},
	{
		internalId: "standardfield",
		label: "Standard Field Identifier",
		type: "text",
		required: false,
	},
	{
		internalId: "oldvalue",
		label: "Previous Value",
		type: "text",
		required: false,
	},
	{
		internalId: "newvalue",
		label: "New Value",
		type: "text",
		required: false,
	},
	{
		internalId: "role",
		label: "Role ID",
		type: "integer",
		required: false,
	},
	{
		internalId: "context",
		label: "Execution Context",
		type: "text",
		required: false,
	},
];

export const COMMON_TRANSACTION_RELATIONS: RecordRelationMeta[] = [
	{
		field: "entity",
		targetTable: "customer",
		targetField: "id",
		type: "foreignKey",
		description: "Customer or Entity associated with this transaction",
	},
	{
		field: "subsidiary",
		targetTable: "subsidiary",
		targetField: "id",
		type: "foreignKey",
		description: "Operating subsidiary",
	},
	{
		field: "currency",
		targetTable: "currency",
		targetField: "id",
		type: "foreignKey",
		description: "Transaction currency",
	},
	{
		field: "location",
		targetTable: "location",
		targetField: "id",
		type: "foreignKey",
		description: "Primary fulfillment or receiving location",
	},
	{
		field: "department",
		targetTable: "department",
		targetField: "id",
		type: "foreignKey",
		description: "Cost center department",
	},
	{
		field: "class",
		targetTable: "classification",
		targetField: "id",
		type: "foreignKey",
		description: "Line of business / class",
	},
	{
		field: "terms",
		targetTable: "term",
		targetField: "id",
		type: "foreignKey",
		description: "Payment terms",
	},
	{
		field: "postingperiod",
		targetTable: "accountingperiod",
		targetField: "id",
		type: "foreignKey",
		description: "Accounting posting period",
	},
];

export const COMMON_ENTITY_RELATIONS: RecordRelationMeta[] = [
	{
		field: "subsidiary",
		targetTable: "subsidiary",
		targetField: "id",
		type: "foreignKey",
		description: "Primary entity subsidiary",
	},
	{
		field: "currency",
		targetTable: "currency",
		targetField: "id",
		type: "foreignKey",
		description: "Primary transaction currency",
	},
	{
		field: "terms",
		targetTable: "term",
		targetField: "id",
		type: "foreignKey",
		description: "Standard payment terms",
	},
	{
		field: "salesrep",
		targetTable: "employee",
		targetField: "id",
		type: "foreignKey",
		description: "Assigned sales representative",
	},
];

export const COMMON_ITEM_RELATIONS: RecordRelationMeta[] = [
	{
		field: "subsidiary",
		targetTable: "subsidiary",
		targetField: "id",
		type: "foreignKey",
		description: "Owning subsidiary",
	},
	{
		field: "incomeaccount",
		targetTable: "account",
		targetField: "id",
		type: "foreignKey",
		description: "GL Revenue / Income account",
	},
	{
		field: "assetaccount",
		targetTable: "account",
		targetField: "id",
		type: "foreignKey",
		description: "GL Inventory Asset account",
	},
	{
		field: "cogsaccount",
		targetTable: "account",
		targetField: "id",
		type: "foreignKey",
		description: "GL Cost of Goods Sold account",
	},
	{
		field: "expenseaccount",
		targetTable: "account",
		targetField: "id",
		type: "foreignKey",
		description: "GL Expense account",
	},
];

export const COMMON_TRANSACTION_SUBLISTS: RecordSublistMeta[] = [
	{ name: "item", label: "Line Items" },
	{ name: "accountingbookdetail", label: "Accounting Books" },
	{ name: "partners", label: "Sales Partners" },
	{ name: "salesteam", label: "Sales Team" },
	{ name: "billing", label: "Billing Schedules" },
	{ name: "shipping", label: "Shipment Packages" },
];

export const COMMON_ENTITY_SUBLISTS: RecordSublistMeta[] = [
	{ name: "addressbook", label: "Address Book" },
	{ name: "contactroles", label: "Contact Roles" },
	{ name: "currency", label: "Currencies" },
	{ name: "itempricing", label: "Item Pricing" },
];

export const COMMON_ITEM_SUBLISTS: RecordSublistMeta[] = [
	{ name: "itemvendor", label: "Preferred Vendors" },
	{ name: "pricing", label: "Price Matrix" },
	{ name: "locations", label: "Location Inventory" },
];

const COMMON_TRANSACTION_FIELDS: RecordFieldMeta[] = [
	{ internalId: "id", label: "Internal ID", type: "integer", required: false },
	{
		internalId: "externalid",
		label: "External ID",
		type: "text",
		required: false,
	},
	{
		internalId: "tranid",
		label: "Document Number",
		type: "text",
		required: false,
	},
	{
		internalId: "trandate",
		label: "Date",
		type: "date",
		required: true,
	},
	{
		internalId: "entity",
		label: "Customer / Entity",
		type: "select",
		required: true,
		help: "Primary customer, vendor, or entity associated with this transaction.",
	},
	{
		internalId: "subsidiary",
		label: "Subsidiary",
		type: "select",
		required: true,
	},
	{
		internalId: "location",
		label: "Location",
		type: "select",
		required: false,
	},
	{
		internalId: "department",
		label: "Department",
		type: "select",
		required: false,
	},
	{ internalId: "class", label: "Class", type: "select", required: false },
	{
		internalId: "currency",
		label: "Currency",
		type: "select",
		required: true,
	},
	{
		internalId: "exchangerate",
		label: "Exchange Rate",
		type: "currency2",
		required: true,
	},
	{
		internalId: "postingperiod",
		label: "Posting Period",
		type: "select",
		required: false,
	},
	{ internalId: "status", label: "Status", type: "text", required: false },
	{
		internalId: "orderstatus",
		label: "Order Status",
		type: "select",
		required: false,
	},
	{ internalId: "memo", label: "Memo", type: "text", required: false },
	{
		internalId: "otherrefnum",
		label: "PO / Check Number",
		type: "text",
		required: false,
	},
	{
		internalId: "salesrep",
		label: "Sales Rep",
		type: "select",
		required: false,
	},
	{ internalId: "partner", label: "Partner", type: "select", required: false },
	{ internalId: "terms", label: "Terms", type: "select", required: false },
	{
		internalId: "billaddress",
		label: "Bill To",
		type: "textarea",
		required: false,
	},
	{
		internalId: "shipaddress",
		label: "Ship To",
		type: "textarea",
		required: false,
	},
	{
		internalId: "shipmethod",
		label: "Ship Via",
		type: "select",
		required: false,
	},
	{
		internalId: "shipdate",
		label: "Ship Date",
		type: "date",
		required: false,
	},
	{
		internalId: "shipcomplete",
		label: "Ship Complete",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "subtotal",
		label: "Subtotal",
		type: "currency",
		required: false,
	},
	{
		internalId: "discounttotal",
		label: "Discount Total",
		type: "currency",
		required: false,
	},
	{
		internalId: "taxtotal",
		label: "Tax Total",
		type: "currency",
		required: false,
	},
	{
		internalId: "shippingcost",
		label: "Shipping Cost",
		type: "currency",
		required: false,
	},
	{
		internalId: "handlingcost",
		label: "Handling Cost",
		type: "currency",
		required: false,
	},
	{ internalId: "total", label: "Total", type: "currency", required: false },
	{
		internalId: "foreigntotal",
		label: "Foreign Total",
		type: "currency",
		required: false,
	},
	{
		internalId: "createddate",
		label: "Date Created",
		type: "datetime",
		required: false,
	},
	{
		internalId: "lastmodifieddate",
		label: "Last Modified Date",
		type: "datetime",
		required: false,
	},
	{
		internalId: "customform",
		label: "Custom Form",
		type: "select",
		required: false,
	},
	{
		internalId: "account",
		label: "Account",
		type: "select",
		required: false,
	},
	{
		internalId: "approvalstatus",
		label: "Approval Status",
		type: "select",
		required: false,
	},
	{
		internalId: "nextapprover",
		label: "Next Approver",
		type: "select",
		required: false,
	},
	{
		internalId: "opportunity",
		label: "Opportunity",
		type: "select",
		required: false,
	},
	{
		internalId: "leadsource",
		label: "Lead Source",
		type: "select",
		required: false,
	},
	{
		internalId: "promocode",
		label: "Promotion",
		type: "select",
		required: false,
	},
	{
		internalId: "discountitem",
		label: "Discount Item",
		type: "select",
		required: false,
	},
	{
		internalId: "discountrate",
		label: "Rate",
		type: "rate",
		required: false,
	},
	{
		internalId: "ismultishipto",
		label: "Enable Item Line Shipping",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "istaxable",
		label: "Taxable",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "taxitem",
		label: "Tax",
		type: "select",
		required: false,
	},
	{
		internalId: "taxrate",
		label: "Tax %",
		type: "float",
		required: false,
	},
	{
		internalId: "tobeprinted",
		label: "To Be Printed",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "tobeemailed",
		label: "To Be E-mailed",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "tobefaxed",
		label: "To Be Faxed",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "email",
		label: "Email",
		type: "emails",
		required: false,
	},
	{
		internalId: "fax",
		label: "Fax",
		type: "text",
		required: false,
	},
	{
		internalId: "message",
		label: "Customer Message",
		type: "textarea",
		required: false,
	},
	{
		internalId: "startdate",
		label: "Start Date",
		type: "date",
		required: false,
	},
	{
		internalId: "enddate",
		label: "End Date",
		type: "date",
		required: false,
	},
	{
		internalId: "duedate",
		label: "Due Date",
		type: "date",
		required: false,
	},
	{
		internalId: "shipcarrier",
		label: "Shipping Carrier",
		type: "select",
		required: false,
	},
	{
		internalId: "trackingnumbers",
		label: "Tracking Numbers",
		type: "text",
		required: false,
	},
	{
		internalId: "linkedtrackingnumbers",
		label: "Linked Tracking Numbers",
		type: "text",
		required: false,
	},
	{
		internalId: "fob",
		label: "FOB",
		type: "text",
		required: false,
	},
	{
		internalId: "shipaddresslist",
		label: "Ship To Select",
		type: "select",
		required: false,
	},
	{
		internalId: "billaddresslist",
		label: "Bill To Select",
		type: "select",
		required: false,
	},
	{
		internalId: "intercotransaction",
		label: "Paired Intercompany Transaction",
		type: "select",
		required: false,
	},
	{
		internalId: "intercostatus",
		label: "Intercompany Status",
		type: "select",
		required: false,
	},
	{
		internalId: "source",
		label: "Web Store / Source",
		type: "text",
		required: false,
	},
	{
		internalId: "onhold",
		label: "On Hold",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "overridehold",
		label: "Override Hold",
		type: "checkbox",
		required: false,
	},
];

const COMMON_ENTITY_FIELDS: RecordFieldMeta[] = [
	{ internalId: "id", label: "Internal ID", type: "integer", required: false },
	{
		internalId: "externalid",
		label: "External ID",
		type: "text",
		required: false,
	},
	{
		internalId: "entityid",
		label: "Customer / Entity ID",
		type: "text",
		required: true,
	},
	{
		internalId: "companyname",
		label: "Company Name",
		type: "text",
		required: false,
	},
	{
		internalId: "isperson",
		label: "Type (Individual)",
		type: "radio",
		required: false,
	},
	{
		internalId: "firstname",
		label: "First Name",
		type: "text",
		required: false,
	},
	{
		internalId: "lastname",
		label: "Last Name",
		type: "text",
		required: false,
	},
	{ internalId: "email", label: "Email", type: "email", required: false },
	{ internalId: "phone", label: "Phone", type: "phone", required: false },
	{
		internalId: "subsidiary",
		label: "Primary Subsidiary",
		type: "select",
		required: true,
	},
	{
		internalId: "currency",
		label: "Primary Currency",
		type: "select",
		required: true,
	},
	{ internalId: "terms", label: "Terms", type: "select", required: false },
	{
		internalId: "creditlimit",
		label: "Credit Limit",
		type: "currency",
		required: false,
	},
	{
		internalId: "balance",
		label: "Balance",
		type: "currency",
		required: false,
	},
	{
		internalId: "isinactive",
		label: "Inactive",
		type: "checkbox",
		required: false,
	},
	{
		internalId: "entitystatus",
		label: "Status",
		type: "select",
		required: true,
	},
	{
		internalId: "salesrep",
		label: "Sales Rep",
		type: "select",
		required: false,
	},
	{
		internalId: "category",
		label: "Category",
		type: "select",
		required: false,
	},
	{
		internalId: "defaultaddress",
		label: "Address",
		type: "address",
		required: false,
	},
	{
		internalId: "comments",
		label: "Comments",
		type: "textarea",
		required: false,
	},
];

const COMMON_ITEM_FIELDS: RecordFieldMeta[] = [
	{ internalId: "id", label: "Internal ID", type: "integer", required: false },
	{
		internalId: "externalid",
		label: "External ID",
		type: "text",
		required: false,
	},
	{
		internalId: "itemid",
		label: "Item Name/Number",
		type: "text",
		required: true,
	},
	{
		internalId: "displayname",
		label: "Display Name/Code",
		type: "text",
		required: false,
	},
	{
		internalId: "itemtype",
		label: "Item Type",
		type: "text",
		required: false,
	},
	{ internalId: "subtype", label: "SubType", type: "text", required: false },
	{
		internalId: "subsidiary",
		label: "Subsidiary",
		type: "multiselect",
		required: false,
	},
	{
		internalId: "unitstype",
		label: "Units Type",
		type: "select",
		required: false,
	},
	{
		internalId: "cost",
		label: "Purchase Price",
		type: "currency",
		required: false,
	},
	{
		internalId: "baseprice",
		label: "Base Price",
		type: "currency",
		required: false,
	},
	{
		internalId: "assetaccount",
		label: "Asset Account",
		type: "select",
		required: false,
	},
	{
		internalId: "incomeaccount",
		label: "Income Account",
		type: "select",
		required: false,
	},
	{
		internalId: "cogsaccount",
		label: "COGS Account",
		type: "select",
		required: false,
	},
	{
		internalId: "isinactive",
		label: "Inactive",
		type: "checkbox",
		required: false,
	},
];

const STANDARD_272_RECORD_TYPES: string[] = [
	"account",
	"accountingbook",
	"accountingcontext",
	"accountingperiod",
	"advintercompanyjournalentry",
	"allocationschedule",
	"amortizationschedule",
	"amortizationtemplate",
	"assemblybuild",
	"assemblyitem",
	"assemblyunbuild",
	"AutomatedClearingHouse",
	"balanceoverview",
	"bankstatement",
	"billingaccount",
	"billingclass",
	"billingratecard",
	"billingrevenueevent",
	"billingschedule",
	"bin",
	"bintransfer",
	"binworksheet",
	"blanketpurchaseorder",
	"bom",
	"bomrevision",
	"bonus",
	"bonustype",
	"budget",
	"budgetcategory",
	"budgetexchangerate",
	"bulkownershiptransfer",
	"bundledcomponents",
	"calendarEvent",
	"campaign",
	"campaignaudience",
	"campaigncategory",
	"campaignchannel",
	"campaignfamily",
	"campaignoffer",
	"campaignresponse",
	"campaignsearch",
	"campaignsubscription",
	"campaignvertical",
	"cashrefund",
	"cashsale",
	"charge",
	"chargerule",
	"check",
	"classification",
	"clientscript",
	"cmscontent",
	"cmscontenttype",
	"cmspage",
	"commercecategory",
	"competitor",
	"consolidatedexchangerate",
	"contact",
	"contactcategory",
	"contactrole",
	"costcategory",
	"couponcode",
	"creditcardcharge",
	"creditcardrefund",
	"creditmemo",
	"currency",
	"currencyrate",
	"customer",
	"customercategory",
	"customerdeposit",
	"customermessage",
	"customerpayment",
	"customerpaymentauthorization",
	"customerrefund",
	"customerstatus",
	"customersubsidiaryrelationship",
	"customlist",
	"custom purchase",
	"customrecord",
	"customrecordtype",
	"customsale",
	"customsegment",
	"customtransaction",
	"department",
	"deposit",
	"depositapplication",
	"descriptionitem",
	"discountitem",
	"downloaditem",
	"emailtemplate",
	"employee",
	"employeechangerequest",
	"employeechangerequesttype",
	"employeestatus",
	"employeetype",
	"entityaccountmapping",
	"entitygroup",
	"estimate",
	"expensecategory",
	"expensereport",
	"fairvalueformula",
	"fairvalueprice",
	"file",
	"financialinstitution",
	"FixedAmountProjectRevenueRule",
	"folder",
	"fulfillmentrequest",
	"generalToken",
	"genericresource",
	"giftcertificate",
	"giftcertificateitem",
	"globalaccountmapping",
	"globalinventoryrelationship",
	"goal",
	"governmentissuedidtype",
	"hcmjob",
	"inboundshipment",
	"intercompanyallocation",
	"intercompanyjournalentry",
	"intercompanytransferorder",
	"inventoryadjustment",
	"inventorycostrevaluation",
	"inventorycount",
	"inventorydetail",
	"inventoryitem",
	"inventorynumber",
	"inventorystatus",
	"inventorystatuschange",
	"inventorytransfer",
	"invoice",
	"invoicegroup",
	"issue",
	"issueproduct",
	"issueproductversion",
	"item",
	"itemaccountmapping",
	"itemcollection",
	"itemdemandplan",
	"itemfulfillment",
	"itemgroup",
	"itemlocationconfiguration",
	"itemprocessfamily",
	"itemprocessgroup",
	"itemreceipt",
	"itemrevision",
	"itemsupplyplan",
	"job",
	"jobrequisition",
	"jobstatus",
	"jobtype",
	"journalentry",
	"kititem",
	"laborbasedprojectrevenuerule",
	"lead",
	"location",
	"lotnumberedassemblyitem",
	"lotnumberedinventoryitem",
	"manufacturingcosttemplate",
	"manufacturingoperationtask",
	"manufacturingrouting",
	"mapreducescript",
	"markupitem",
	"massupdatescript",
	"memdoc",
	"merchandisehierarchylevel",
	"merchandisehierarchyversion",
	"merchandisehierarchynode",
	"message",
	"mfgplannedtime",
	"nexus",
	"noninventoryitem",
	"note",
	"notetype",
	"opportunity",
	"orderreservation",
	"orderschedule",
	"otherchargeitem",
	"othername",
	"othernamecategory",
	"partner",
	"partnercategory",
	"paycheck",
	"paycheckjournal",
	"paymentcard",
	"paymentcardtoken",
	"paymentinstrument",
	"paymentitem",
	"paymentmethod",
	"payrollitem",
	"pctcompleteprojectrevenuerule",
	"performanceappraisal",
	"periodendjournal",
	"phonecall",
	"pickstrategy",
	"picktask",
	"plannedorder",
	"planningitemcategory",
	"planningitemgroup",
	"planningrule",
	"planningview",
	"portlet",
	"pricebook",
	"pricelevel",
	"priceplan",
	"pricinggroup",
	"projectexpensetype",
	"projecticchargerequest",
	"projecttask",
	"projecttemplate",
	"promotioncode",
	"prospect",
	"purchasecontract",
	"purchaseorder",
	"purchaserequisition",
	"reallocateitem",
	"receiveinboundshipment",
	"recognitioneventtype",
	"restlet",
	"returnauthorization",
	"revendrecognitionrule",
	"revenuearrangement",
	"revenuecommitment",
	"revenuecommitmentreversal",
	"revenueplan",
	"revrecschedule",
	"revrectemplate",
	"role",
	"salesorder",
	"salesrole",
	"salestaxitem",
	"scheduledscript",
	"scheduledscriptinstance",
	"scriptdeployment",
	"serializedassemblyitem",
	"serializedinventoryitem",
	"serviceitem",
	"shipitem",
	"solution",
	"statisticaljournalentry",
	"storepickupfulfillment",
	"subscription",
	"subscriptionchangeorder",
	"subscriptionline",
	"subscriptionplan",
	"subscriptionterm",
	"subsidiary",
	"subsidiarysettings",
	"subtotalitem",
	"suitelet",
	"supplychainrule",
	"supplychainsnapshot",
	"supplychangeorder",
	"supplyplan",
	"supportcase",
	"supportcaseissue",
	"supportcaseorigin",
	"supportcasepriority",
	"supportcasestatus",
	"supportcasetype",
	"systemnote",
	"task",
	"taxacct",
	"taxgroup",
	"taxperiod",
	"taxtype",
	"term",
	"timebill",
	"timeentry",
	"ConcurTimeOffChange",
	"timeoffplan",
	"timeoffrequest",
	"timeoffrule",
	"timeofftype",
	"timesheet",
	"topic",
	"transaction",
	"transferorder",
	"unitsType",
	"usage",
	"usereventscript",
	"vendor",
	"vendorbill",
	"vendorcategory",
	"vendorcredit",
	"vendorpayment",
	"vendorprepayment",
	"vendorprepaymentapplication",
	"vendorreturnauthorization",
	"vendorsubsidiaryrelationship",
	"wave",
	"website",
	"winlossreason",
	"workflowactionscript",
	"workorder",
	"workorderclose",
	"workordercompletion",
	"workorderissue",
	"workplace",
	"zone",
].map((s) => s.trim().toLowerCase());

export const CORE_ANALYTIC_VIEWS: Record<
	string,
	{
		label: string;
		description: string;
		fields: RecordFieldMeta[];
		relations: RecordRelationMeta[];
		sublists?: RecordSublistMeta[];
	}
> = {
	transactionaccountingline: {
		label: "Transaction Accounting Line (GL Posting Impact)",
		description:
			"General Ledger (GL) posting impact lines generated by transactions. Contains debit, credit, net amount, and posting accounts.",
		fields: TRANSACTION_ACCOUNTING_LINE_FIELDS,
		relations: [
			{
				field: "transaction",
				targetTable: "transaction",
				targetField: "id",
				type: "foreignKey",
				description: "Parent transaction header",
			},
			{
				field: "transactionline",
				targetTable: "transactionline",
				targetField: "id",
				type: "foreignKey",
				description: "Related transaction line item",
			},
			{
				field: "account",
				targetTable: "account",
				targetField: "id",
				type: "foreignKey",
				description: "Target General Ledger Account",
			},
			{
				field: "subsidiary",
				targetTable: "subsidiary",
				targetField: "id",
				type: "foreignKey",
				description: "Posting subsidiary",
			},
			{
				field: "accountingbook",
				targetTable: "accountingbook",
				targetField: "id",
				type: "foreignKey",
				description: "Secondary accounting book",
			},
		],
		sublists: [],
	},
	transactionline: {
		label: "Transaction Line Items",
		description:
			"Transaction line details (items, expenses, taxes, shipping, upstream lineage). Requires mainline filter.",
		fields: TRANSACTION_LINE_FIELDS,
		relations: [
			{
				field: "transaction",
				targetTable: "transaction",
				targetField: "id",
				type: "foreignKey",
				description: "Parent transaction header",
			},
			{
				field: "item",
				targetTable: "item",
				targetField: "id",
				type: "foreignKey",
				description: "Referenced Item master",
			},
			{
				field: "createdfrom",
				targetTable: "transaction",
				targetField: "id",
				type: "foreignKey",
				description: "Upstream order / transaction lineage",
			},
			{
				field: "location",
				targetTable: "location",
				targetField: "id",
				type: "foreignKey",
				description: "Inventory fulfillment location",
			},
		],
		sublists: [],
	},
	billingrevenueevent: {
		label: "Billing Revenue Event (ARM)",
		description:
			"Advanced Revenue Management (ARM) billing revenue event record for revenue recognition.",
		fields: BILLING_REVENUE_EVENT_FIELDS,
		relations: [
			{
				field: "transaction",
				targetTable: "transaction",
				targetField: "id",
				type: "foreignKey",
				description: "Source transaction",
			},
			{
				field: "transactionline",
				targetTable: "transactionline",
				targetField: "id",
				type: "foreignKey",
				description: "Source transaction line",
			},
			{
				field: "revenueelement",
				targetTable: "revenueelement",
				targetField: "id",
				type: "foreignKey",
				description: "ARM revenue element",
			},
			{
				field: "subsidiary",
				targetTable: "subsidiary",
				targetField: "id",
				type: "foreignKey",
				description: "Revenue subsidiary",
			},
		],
		sublists: [],
	},
	systemnote: {
		label: "System Note Audit Trail",
		description:
			"NetSuite system audit trail logging field modifications, users, dates, and previous/new values.",
		fields: SYSTEM_NOTE_FIELDS,
		relations: [
			{
				field: "name",
				targetTable: "employee",
				targetField: "id",
				type: "foreignKey",
				description: "User modifying record",
			},
		],
		sublists: [],
	},
};

const TRANSACTION_TYPES_LIST = [
	"salesorder",
	"invoice",
	"purchaseorder",
	"estimate",
	"opportunity",
	"creditmemo",
	"cashsale",
	"cashrefund",
	"vendorbill",
	"vendorpayment",
	"vendorcredit",
	"customerpayment",
	"customerdeposit",
	"customerrefund",
	"itemfulfillment",
	"itemreceipt",
	"returnauthorization",
	"vendorreturnauthorization",
	"journalentry",
	"transferorder",
	"workorder",
	"assemblybuild",
	"assemblyunbuild",
	"inventoryadjustment",
	"inventorytransfer",
	"check",
	"deposit",
	"expensereport",
	"transaction",
];

/**
 * Service to access Oracle NetSuite official 272 SuiteScript Records Reference definitions & core views.
 * Acts as the authoritative L0 local static cache reflection base.
 */
class RecordsReferenceService {
	private recordsCache: Map<string, RecordTypeMeta> | null = null;
	private recordNamesCache: string[] | null = null;

	private getRecordsJsonPath(): string {
		return path.join(
			getSkillsDir(),
			"netsuite-suitescript-records-reference",
			"references",
			"records.json",
		);
	}

	private seedBuiltinFallbackCatalog(): void {
		this.recordsCache = new Map();
		this.recordNamesCache = [];

		// 1. Register Core Analytical Views
		for (const [viewName, viewMeta] of Object.entries(CORE_ANALYTIC_VIEWS)) {
			this.recordsCache.set(viewName, {
				internalId: viewName,
				label: viewMeta.label,
				description: viewMeta.description,
				fields: viewMeta.fields,
				relations: viewMeta.relations,
				sublists: viewMeta.sublists || [],
				primaryKey: "id",
			});
			this.recordNamesCache.push(viewName);
		}

		// 2. Register Standard 272 Record Types
		for (const recType of STANDARD_272_RECORD_TYPES) {
			if (this.recordsCache.has(recType)) continue;

			let fields = COMMON_ENTITY_FIELDS;
			let sublists = COMMON_ENTITY_SUBLISTS;
			let relations = COMMON_ENTITY_RELATIONS;

			if (TRANSACTION_TYPES_LIST.includes(recType)) {
				fields = COMMON_TRANSACTION_FIELDS;
				sublists = COMMON_TRANSACTION_SUBLISTS;
				relations = COMMON_TRANSACTION_RELATIONS;
			} else if (
				recType.includes("item") ||
				recType === "bom" ||
				recType === "bomrevision"
			) {
				fields = COMMON_ITEM_FIELDS;
				sublists = COMMON_ITEM_SUBLISTS;
				relations = COMMON_ITEM_RELATIONS;
			}

			this.recordsCache.set(recType, {
				internalId: recType,
				fields,
				sublists,
				relations,
				primaryKey: "id",
			});
			this.recordNamesCache.push(recType);
		}
		this.recordNamesCache.sort();
	}

	private ensureLoaded(): boolean {
		if (this.recordsCache) return true;

		const jsonPath = this.getRecordsJsonPath();
		if (!fs.existsSync(jsonPath)) {
			this.seedBuiltinFallbackCatalog();
			return true;
		}

		try {
			const rawContent = fs.readFileSync(jsonPath, "utf-8");
			const parsed = JSON.parse(rawContent) as {
				records?: Record<
					string,
					{
						internalId: string;
						fields?: Array<{
							internalId: string;
							label?: string;
							type?: string;
							required?: string | boolean;
							help?: string;
						}>;
						sublists?: Array<{ name: string; label?: string }>;
					}
				>;
			};

			if (!parsed.records) {
				this.seedBuiltinFallbackCatalog();
				return true;
			}

			this.recordsCache = new Map();
			this.recordNamesCache = [];

			// 1. Populate Core Analytical Views
			for (const [viewName, viewMeta] of Object.entries(CORE_ANALYTIC_VIEWS)) {
				this.recordsCache.set(viewName, {
					internalId: viewName,
					label: viewMeta.label,
					description: viewMeta.description,
					fields: viewMeta.fields,
					relations: viewMeta.relations,
					sublists: viewMeta.sublists || [],
					primaryKey: "id",
				});
				this.recordNamesCache.push(viewName);
			}

			// 2. Populate Records from JSON
			for (const [key, val] of Object.entries(parsed.records)) {
				const lowerKey = key.toLowerCase();
				if (this.recordsCache.has(lowerKey)) continue;

				let fields: RecordFieldMeta[] = (val.fields || []).map((f) => ({
					internalId: f.internalId,
					label: f.label || f.internalId,
					type: f.type || "string",
					required: f.required === "true" || f.required === true,
					help: f.help || "",
				}));

				if (fields.length === 0) {
					if (TRANSACTION_TYPES_LIST.includes(lowerKey)) {
						fields = COMMON_TRANSACTION_FIELDS;
					} else if (lowerKey.includes("item") || lowerKey === "bom") {
						fields = COMMON_ITEM_FIELDS;
					} else {
						fields = COMMON_ENTITY_FIELDS;
					}
				}

				let sublists: RecordSublistMeta[] = (val.sublists || []).map(
					(s: { name?: string; internalId?: string; label?: string }) => ({
						name: s.name || s.internalId || "",
						label: s.label || s.name || s.internalId || "",
					}),
				);
				let relations: RecordRelationMeta[] = [];

				if (TRANSACTION_TYPES_LIST.includes(lowerKey)) {
					relations = COMMON_TRANSACTION_RELATIONS;
					if (sublists.length === 0) sublists = COMMON_TRANSACTION_SUBLISTS;
				} else if (lowerKey.includes("item") || lowerKey === "bom") {
					relations = COMMON_ITEM_RELATIONS;
					if (sublists.length === 0) sublists = COMMON_ITEM_SUBLISTS;
				} else {
					relations = COMMON_ENTITY_RELATIONS;
					if (sublists.length === 0) sublists = COMMON_ENTITY_SUBLISTS;
				}

				this.recordsCache.set(lowerKey, {
					internalId: val.internalId || key,
					fields,
					sublists,
					relations,
					primaryKey: "id",
				});
				this.recordNamesCache.push(lowerKey);
			}

			// 3. Ensure any missing types from STANDARD_272_RECORD_TYPES are present
			for (const recType of STANDARD_272_RECORD_TYPES) {
				if (!this.recordsCache.has(recType)) {
					let fields = COMMON_ENTITY_FIELDS;
					let sublists = COMMON_ENTITY_SUBLISTS;
					let relations = COMMON_ENTITY_RELATIONS;

					if (TRANSACTION_TYPES_LIST.includes(recType)) {
						fields = COMMON_TRANSACTION_FIELDS;
						sublists = COMMON_TRANSACTION_SUBLISTS;
						relations = COMMON_TRANSACTION_RELATIONS;
					} else if (recType.includes("item") || recType === "bom") {
						fields = COMMON_ITEM_FIELDS;
						sublists = COMMON_ITEM_SUBLISTS;
						relations = COMMON_ITEM_RELATIONS;
					}

					this.recordsCache.set(recType, {
						internalId: recType,
						fields,
						sublists,
						relations,
						primaryKey: "id",
					});
					this.recordNamesCache.push(recType);
				}
			}

			this.recordNamesCache.sort();
			return true;
		} catch (error) {
			console.error("⚠️ Failed to load records.json reference:", error);
			this.seedBuiltinFallbackCatalog();
			return true;
		}
	}

	/** List all supported standard record types & core views */
	listRecordTypes(): string[] {
		if (!this.ensureLoaded() || !this.recordNamesCache) {
			return [];
		}
		return [...this.recordNamesCache];
	}

	/** Get definition for a standard record type or analytical view */
	getRecordDefinition(
		recordType: string,
		keyword?: string,
	): RecordDefinitionResult | null {
		if (!this.ensureLoaded() || !this.recordsCache) {
			return null;
		}

		const cleanType = recordType.toLowerCase().replace(/[^a-z0-9_]/g, "");
		const rec = this.recordsCache.get(cleanType);
		if (!rec) {
			return {
				recordType,
				found: false,
				totalFields: 0,
				fields: [],
			};
		}

		let filteredFields = rec.fields;
		if (keyword && keyword.trim().length > 0) {
			const kw = keyword.toLowerCase().trim();
			filteredFields = rec.fields.filter(
				(f) =>
					f.internalId.toLowerCase().includes(kw) ||
					f.label.toLowerCase().includes(kw) ||
					f.help?.toLowerCase().includes(kw),
			);
		}

		return {
			recordType: rec.internalId,
			found: true,
			totalFields: rec.fields.length,
			fields: filteredFields,
			...(rec.sublists ? { sublists: rec.sublists } : {}),
			...(rec.relations ? { relations: rec.relations } : {}),
			primaryKey: rec.primaryKey || "id",
			...(rec.description ? { description: rec.description } : {}),
		};
	}
}

export const recordsReferenceService = new RecordsReferenceService();
