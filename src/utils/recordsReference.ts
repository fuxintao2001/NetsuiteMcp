import fs from "node:fs";
import path from "node:path";
import { getSkillsDir } from "./environment.js";

export interface RecordFieldMeta {
	internalId: string;
	label: string;
	type: string;
	required: boolean;
	help?: string;
}

interface RecordTypeMeta {
	internalId: string;
	label?: string;
	fields: RecordFieldMeta[];
	sublists?: Array<{ name: string; label?: string }>;
}

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

/**
 * Service to access Oracle NetSuite official 272 SuiteScript Records Reference definitions.
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

		for (const recType of STANDARD_272_RECORD_TYPES) {
			if (this.recordsCache.has(recType)) continue;
			let fields = COMMON_ENTITY_FIELDS;
			if (
				[
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
				].includes(recType)
			) {
				fields = COMMON_TRANSACTION_FIELDS;
			} else if (
				recType.includes("item") ||
				recType === "bom" ||
				recType === "bomrevision"
			) {
				fields = COMMON_ITEM_FIELDS;
			}
			this.recordsCache.set(recType, {
				internalId: recType,
				fields,
				sublists: [{ name: "item", label: "Items" }],
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

			for (const [key, val] of Object.entries(parsed.records)) {
				const lowerKey = key.toLowerCase();
				const fields: RecordFieldMeta[] = (val.fields || []).map((f) => ({
					internalId: f.internalId,
					label: f.label || f.internalId,
					type: f.type || "string",
					required: f.required === "true" || f.required === true,
					help: f.help || "",
				}));

				this.recordsCache.set(lowerKey, {
					internalId: val.internalId || key,
					fields,
					sublists: val.sublists || [],
				});
				this.recordNamesCache.push(lowerKey);
			}

			this.recordNamesCache.sort();
			return true;
		} catch (error) {
			console.error("⚠️ Failed to load records.json reference:", error);
			this.seedBuiltinFallbackCatalog();
			return true;
		}
	}

	/** List all supported standard record types (272 types) */
	listRecordTypes(): string[] {
		if (!this.ensureLoaded() || !this.recordNamesCache) {
			return [];
		}
		return [...this.recordNamesCache];
	}

	/** Get definition for a standard record type */
	getRecordDefinition(
		recordType: string,
		keyword?: string,
	): {
		recordType: string;
		found: boolean;
		totalFields: number;
		fields: RecordFieldMeta[];
		sublists?: Array<{ name: string; label?: string }>;
	} | null {
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
		};
	}
}

export const recordsReferenceService = new RecordsReferenceService();
