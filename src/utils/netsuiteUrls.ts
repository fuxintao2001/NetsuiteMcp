import { formatNetSuiteAccountHost } from "./environment.js";

const RECORD_URL_MAP: Record<string, string> = {
	// Entities
	customer: "/app/common/entity/custjob.nl",
	custjob: "/app/common/entity/custjob.nl",
	lead: "/app/common/entity/custjob.nl",
	prospect: "/app/common/entity/custjob.nl",
	project: "/app/common/entity/custjob.nl",
	job: "/app/common/entity/custjob.nl",
	vendor: "/app/common/entity/vendor.nl",
	employee: "/app/common/entity/employee.nl",
	contact: "/app/common/entity/contact.nl",
	partner: "/app/common/entity/partner.nl",
	entity: "/app/common/entity/custjob.nl",

	// CRM & Activities
	supportcase: "/app/crm/support/supportcase.nl",
	case: "/app/crm/support/supportcase.nl",
	task: "/app/common/entity/task.nl",
	phonecall: "/app/crm/calendar/call.nl",
	call: "/app/crm/calendar/call.nl",
	event: "/app/crm/calendar/event.nl",
	message: "/app/common/entity/message.nl",
	opportunity: "/app/accounting/transactions/opprtnty.nl",
	opprtnty: "/app/accounting/transactions/opprtnty.nl",

	// Transactions (Direct URL paths)
	salesorder: "/app/accounting/transactions/salesord.nl",
	salesord: "/app/accounting/transactions/salesord.nl",
	invoice: "/app/accounting/transactions/custinvc.nl",
	custinvc: "/app/accounting/transactions/custinvc.nl",
	purchaseorder: "/app/accounting/transactions/purchord.nl",
	purchord: "/app/accounting/transactions/purchord.nl",
	vendorbill: "/app/accounting/transactions/vendbill.nl",
	vendbill: "/app/accounting/transactions/vendbill.nl",
	cashsale: "/app/accounting/transactions/cashsale.nl",
	estimate: "/app/accounting/transactions/estimate.nl",
	quote: "/app/accounting/transactions/estimate.nl",
	custpymt: "/app/accounting/transactions/custpymt.nl",
	customerpayment: "/app/accounting/transactions/custpymt.nl",
	payment: "/app/accounting/transactions/custpymt.nl",
	vendpymt: "/app/accounting/transactions/vendpymt.nl",
	vendorpayment: "/app/accounting/transactions/vendpymt.nl",
	journalentry: "/app/accounting/transactions/journal.nl",
	journal: "/app/accounting/transactions/journal.nl",
	creditmemo: "/app/accounting/transactions/custcred.nl",
	custcred: "/app/accounting/transactions/custcred.nl",
	vendorcredit: "/app/accounting/transactions/vendcred.nl",
	vendcred: "/app/accounting/transactions/vendcred.nl",
	returnauthorization: "/app/accounting/transactions/rtnauth.nl",
	rtnauth: "/app/accounting/transactions/rtnauth.nl",
	vendorreturnauthorization: "/app/accounting/transactions/vendauth.nl",
	deposit: "/app/accounting/transactions/deposit.nl",
	check: "/app/accounting/transactions/check.nl",
	assemblybuild: "/app/accounting/transactions/build.nl",
	assemblyunbuild: "/app/accounting/transactions/unbuild.nl",
	itemfulfillment: "/app/accounting/transactions/itemship.nl",
	itemship: "/app/accounting/transactions/itemship.nl",
	itemfld: "/app/accounting/transactions/itemship.nl",
	itemreceipt: "/app/accounting/transactions/itemrcpt.nl",
	itemrcpt: "/app/accounting/transactions/itemrcpt.nl",
	transferorder: "/app/accounting/transactions/trnfrord.nl",
	transfer: "/app/accounting/transactions/trnfrord.nl",
	expensereport: "/app/accounting/transactions/exprept.nl",
	exprept: "/app/accounting/transactions/exprept.nl",
	cashrefund: "/app/accounting/transactions/cashrfnd.nl",
	cashrfnd: "/app/accounting/transactions/cashrfnd.nl",
	workorder: "/app/accounting/transactions/workord.nl",
	workord: "/app/accounting/transactions/workord.nl",
	inventoryadjustment: "/app/accounting/transactions/invadjst.nl",
	inventorytransfer: "/app/accounting/transactions/invtrnfr.nl",
	inventorycostrevaluation: "/app/accounting/transactions/reval.nl",
	transaction: "/app/accounting/transactions/transaction.nl",

	// Master Data, Setup & Organization
	subsidiary: "/app/common/other/subsidiary.nl",
	department: "/app/common/other/department.nl",
	location: "/app/common/other/location.nl",
	account: "/app/accounting/general/account.nl",
	accountingperiod: "/app/accounting/other/period.nl",
	period: "/app/accounting/other/period.nl",
	accountingbook: "/app/accounting/general/accountingbook.nl",
	currency: "/app/common/other/currency.nl",
	nexus: "/app/accounting/general/nexus.nl",
	taxitem: "/app/accounting/general/taxitem.nl",
	salestaxitem: "/app/accounting/general/taxitem.nl",
	taxgroup: "/app/accounting/general/taxgroup.nl",
	taxtype: "/app/accounting/general/taxtype.nl",
	pricelevel: "/app/accounting/general/pricelevel.nl",
	unitstype: "/app/common/item/units.nl",
	bin: "/app/common/other/bin.nl",

	// Items & Inventory
	item: "/app/common/item/item.nl",
	inventoryitem: "/app/common/item/item.nl",
	noninventoryitem: "/app/common/item/item.nl",
	serviceitem: "/app/common/item/item.nl",
	kititem: "/app/common/item/item.nl",
	assemblyitem: "/app/common/item/item.nl",
	otherchargeitem: "/app/common/item/item.nl",
	giftcertificateitem: "/app/common/item/item.nl",
	discountitem: "/app/common/item/item.nl",
	paymentitem: "/app/common/item/item.nl",
	markupitem: "/app/common/item/item.nl",
	subtotalitem: "/app/common/item/item.nl",
	descriptionitem: "/app/common/item/item.nl",
	inventorydetail: "/app/common/item/itemnumber.nl",
	inventorynumber: "/app/common/item/itemnumber.nl",

	// Customization, SuiteScript & Search
	customlist: "/app/common/custom/customlist.nl",
	customsegment: "/app/common/custom/customsegment.nl",
	script: "/app/common/scripting/script.nl",
	scriptdeployment: "/app/common/scripting/scriptrecord.nl",
	workflow: "/app/common/workflow/setup.nl",
	savedsearch: "/app/common/search/search.nl",
};

/**
 * Generate standard NetSuite browser deep link URL
 * @param accountId - NetSuite Account ID (e.g. 123456 or 123456_SB1)
 * @param recordType - Record type (e.g. salesorder, customer, customrecord_...)
 * @param recordId - Record internal ID
 * @param rectype - Optional numeric ID for custom record types
 * @returns Full URL to access record in the UI, or null if required params missing/invalid
 */
export function generateNetSuiteUrl(
	accountId: string | undefined,
	recordType: string | undefined,
	recordId: string | number | undefined,
	rectype?: number | string,
): string | null {
	const cleanRecordId =
		recordId !== undefined && recordId !== null ? String(recordId).trim() : "";
	if (!accountId || !cleanRecordId) return null;

	// DNS-compliant formatting: replace underscores with hyphens, lowercase
	const formattedAccountId = formatNetSuiteAccountHost(accountId.toString());

	// Normalize record type (lowercase and remove spaces, underscores, hyphens)
	const originalType = recordType ? recordType.toLowerCase().trim() : "";
	const normalizedType = originalType.replace(/[\s_-]/g, "");

	let urlPath = "";

	// Check if a valid numeric rectype is provided (e.g. 105 or "105")
	const isNumericRectype =
		rectype !== undefined &&
		rectype !== null &&
		(typeof rectype === "number" || /^\d+$/.test(String(rectype).trim()));

	if (isNumericRectype) {
		const numericRectype = String(rectype).trim();
		urlPath = `/app/common/custom/custrecordentry.nl?rectype=${numericRectype}&id=${cleanRecordId}`;
	} else if (originalType.startsWith("customrecord")) {
		// Custom records MUST have a numeric rectype in NetSuite UI.
		// Passing a string script ID (e.g. rectype=customrecord_xxx) produces a broken NetSuite page.
		// Return null to signal resolution failure.
		return null;
	} else if (RECORD_URL_MAP[normalizedType]) {
		urlPath = `${RECORD_URL_MAP[normalizedType]}?id=${cleanRecordId}`;
	} else {
		// Fallback: transaction.nl automatically redirects standard transaction types
		urlPath = `/app/accounting/transactions/transaction.nl?id=${cleanRecordId}`;
	}

	return `https://${formattedAccountId}.app.netsuite.com${urlPath}`;
}
