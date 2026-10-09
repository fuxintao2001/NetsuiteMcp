import { formatNetSuiteAccountHost } from "./environment.js";

const RECORD_URL_MAP: Record<string, string> = {
	// Entities
	customer: "/app/common/entity/custjob.nl",
	lead: "/app/common/entity/custjob.nl",
	prospect: "/app/common/entity/custjob.nl",
	project: "/app/common/entity/custjob.nl",
	vendor: "/app/common/entity/vendor.nl",
	employee: "/app/common/entity/employee.nl",
	contact: "/app/common/entity/contact.nl",
	partner: "/app/common/entity/partner.nl",

	// CRM & Activities
	supportcase: "/app/crm/support/supportcase.nl",
	task: "/app/common/entity/task.nl",
	phonecall: "/app/crm/calendar/call.nl",
	event: "/app/crm/calendar/event.nl",
	message: "/app/common/entity/message.nl",
	opportunity: "/app/accounting/transactions/opprtnty.nl",

	// Transactions (Direct URL paths)
	salesorder: "/app/accounting/transactions/salesord.nl",
	invoice: "/app/accounting/transactions/custinvc.nl",
	purchaseorder: "/app/accounting/transactions/purchord.nl",
	vendorbill: "/app/accounting/transactions/vendbill.nl",
	cashsale: "/app/accounting/transactions/cashsale.nl",
	estimate: "/app/accounting/transactions/estimate.nl",
	customerpayment: "/app/accounting/transactions/custpymt.nl",
	vendorpayment: "/app/accounting/transactions/vendpymt.nl",
	journalentry: "/app/accounting/transactions/journal.nl",
	creditmemo: "/app/accounting/transactions/custcred.nl",
	vendorcredit: "/app/accounting/transactions/vendcred.nl",
	returnauthorization: "/app/accounting/transactions/rtnauth.nl",
	vendorreturnauthorization: "/app/accounting/transactions/vendauth.nl",
	deposit: "/app/accounting/transactions/deposit.nl",
	check: "/app/accounting/transactions/check.nl",
	assemblybuild: "/app/accounting/transactions/build.nl",
	assemblyunbuild: "/app/accounting/transactions/unbuild.nl",
	itemfulfillment: "/app/accounting/transactions/itemship.nl",
	itemreceipt: "/app/accounting/transactions/itemrcpt.nl",
	transferorder: "/app/accounting/transactions/trnfrord.nl",
	expensereport: "/app/accounting/transactions/exprept.nl",
	cashrefund: "/app/accounting/transactions/cashrfnd.nl",
	workorder: "/app/accounting/transactions/workord.nl",
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
	accountingbook: "/app/accounting/general/accountingbook.nl",
	currency: "/app/common/other/currency.nl",
	nexus: "/app/accounting/general/nexus.nl",
	taxitem: "/app/accounting/general/taxitem.nl",
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
	customrecordtype: "/app/common/custom/custrecord.nl",
	script: "/app/common/scripting/script.nl",
	scriptdeployment: "/app/common/scripting/scriptrecord.nl",
	workflow: "/app/common/workflow/setup/nextgen/workflowdesktop.nl",
	savedsearch: "/app/common/search/search.nl",

	// File Cabinet & Media
	file: "/app/common/media/mediaitem.nl",
	folder: "/app/common/media/mediaitemfolders.nl",

	// Advanced PDF Templates
	advancedpdftemplate: "/app/common/custom/advancedprint/pdftemplate.nl",

	// Custom Fields
	customfield: "/app/common/custom/custfield.nl",
	bodycustfield: "/app/common/custom/bodycustfield.nl",
	columncustfield: "/app/common/custom/columncustfield.nl",
	entitycustfield: "/app/common/custom/entitycustfield.nl",
	itemcustfield: "/app/common/custom/itemcustfield.nl",
	othercustfield: "/app/common/custom/othercustfield.nl",
	crmcustfield: "/app/common/custom/crmcustfield.nl",
	itemnumbercustfield: "/app/common/custom/itemnumbercustfield.nl",
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
	} else if (normalizedType === "folder") {
		urlPath = `/app/common/media/mediaitemfolders.nl?folder=${cleanRecordId}`;
	} else if (RECORD_URL_MAP[normalizedType]) {
		urlPath = `${RECORD_URL_MAP[normalizedType]}?id=${cleanRecordId}`;
	} else {
		return null;
	}

	return `https://${formattedAccountId}.app.netsuite.com${urlPath}`;
}

/**
 * Generate NetSuite script file editor direct link URL.
 */
export function generateNetSuiteScriptFileUrl(
	accountId: string | undefined,
	fileId: string | number | undefined,
): string | null {
	const cleanFileId =
		fileId !== undefined && fileId !== null ? String(fileId).trim() : "";
	if (!accountId || !cleanFileId) return null;
	const formattedAccountId = formatNetSuiteAccountHost(accountId.toString());
	return `https://${formattedAccountId}.app.netsuite.com/app/common/record/edittextmediaitem.nl?id=${cleanFileId}&e=T&l=T&target=filesize&syntaxHighlighting=T`;
}
