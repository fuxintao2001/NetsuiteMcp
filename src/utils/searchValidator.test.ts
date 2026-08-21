import { describe, expect, it } from "vitest";
import { SuiteScriptSearchValidator } from "./searchValidator.js";

describe("SuiteScriptSearchValidator", () => {
	it("should detect hallucinated customer search fields", () => {
		const res1 = SuiteScriptSearchValidator.validateField(
			"customer",
			"customerId",
		);
		expect(res1.valid).toBe(false);
		expect(res1.suggestion).toContain("entityid");

		const res2 = SuiteScriptSearchValidator.validateField(
			"customer",
			"customerName",
		);
		expect(res2.valid).toBe(false);
		expect(res2.suggestion).toContain("companyname");
	});

	it("should validate standard customer search fields", () => {
		expect(
			SuiteScriptSearchValidator.validateField("customer", "entityid").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateField("customer", "email").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateField("customer", "balance").valid,
		).toBe(true);
	});

	it("should allow custom fields on any record", () => {
		expect(
			SuiteScriptSearchValidator.validateField(
				"salesorder",
				"custbody_my_field",
			).valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateField("customer", "custentity_tax_id")
				.valid,
		).toBe(true);
	});

	it("should reject UI transaction names and recommend shortcodes", () => {
		const res =
			SuiteScriptSearchValidator.validateTransactionType("Sales Order");
		expect(res.valid).toBe(false);
		expect(res.suggestion).toContain("SalesOrd");
	});

	it("should accept valid transaction shortcodes", () => {
		expect(
			SuiteScriptSearchValidator.validateTransactionType("SalesOrd").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateTransactionType("CustInvc").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateTransactionType("PurchOrd").valid,
		).toBe(true);
	});

	it("should detect 1.0 API mixing in 2.1 code", () => {
		const badCode =
			"search.create({ filters: [new nlobjSearchFilter('email', null, 'is', 'a@b.com')] })";
		const res = SuiteScriptSearchValidator.checkLegacyApiMixing(badCode);
		expect(res.valid).toBe(false);
		expect(res.error).toContain("nlobjSearchFilter");
	});
});
