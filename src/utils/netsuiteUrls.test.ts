import { describe, expect, it } from "vitest";
import { generateNetSuiteUrl } from "./netsuiteUrls.js";

describe("NetSuite UI URL Generation", () => {
	it("should return null if accountId or recordId is missing", () => {
		expect(generateNetSuiteUrl(undefined, "customer", "123")).toBeNull();
		expect(generateNetSuiteUrl("123456", "customer", undefined)).toBeNull();
		expect(generateNetSuiteUrl("123456", "customer", "")).toBeNull();
		expect(generateNetSuiteUrl("123456", "customer", "   ")).toBeNull();
	});

	it("should format host subdomain accurately", () => {
		const url = generateNetSuiteUrl("9260916-sb1", "customer", "789");
		expect(url).toContain("https://9260916-sb1.app.netsuite.com");
	});

	it("should resolve standard mapped record types", () => {
		const custUrl = generateNetSuiteUrl("123456", "customer", "100");
		expect(custUrl).toBe(
			"https://123456.app.netsuite.com/app/common/entity/custjob.nl?id=100",
		);

		const invUrl = generateNetSuiteUrl("123456", "invoice", "200");
		expect(invUrl).toBe(
			"https://123456.app.netsuite.com/app/accounting/transactions/custinvc.nl?id=200",
		);

		const periodUrl = generateNetSuiteUrl("123456", "accountingperiod", "350");
		expect(periodUrl).toBe(
			"https://123456.app.netsuite.com/app/accounting/other/period.nl?id=350",
		);

		const currencyUrl = generateNetSuiteUrl("123456", "currency", "1");
		expect(currencyUrl).toBe(
			"https://123456.app.netsuite.com/app/common/other/currency.nl?id=1",
		);

		const scriptUrl = generateNetSuiteUrl("123456", "script", "99");
		expect(scriptUrl).toBe(
			"https://123456.app.netsuite.com/app/common/scripting/script.nl?id=99",
		);
	});

	it("should handle custom records requiring numeric rectype parameter", () => {
		// Custom records without numeric rectype return null to prevent broken NetSuite UI URLs
		const customWithoutRectype = generateNetSuiteUrl(
			"123456",
			"customrecord_my_script",
			"500",
		);
		expect(customWithoutRectype).toBeNull();

		// Custom records with numeric rectype (number or numeric string) succeed
		const customNumericUrl = generateNetSuiteUrl(
			"123456",
			"customrecord_type",
			"500",
			105,
		);
		expect(customNumericUrl).toBe(
			"https://123456.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=105&id=500",
		);

		const customStringNumericUrl = generateNetSuiteUrl(
			"123456",
			"customrecord_type",
			"500",
			"105",
		);
		expect(customStringNumericUrl).toBe(
			"https://123456.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=105&id=500",
		);
	});

	it("should fall back to standard transaction page if record type is unmapped", () => {
		const fallbackUrl = generateNetSuiteUrl("123456", "unknown_type", "888");
		expect(fallbackUrl).toBe(
			"https://123456.app.netsuite.com/app/accounting/transactions/transaction.nl?id=888",
		);
	});
});
