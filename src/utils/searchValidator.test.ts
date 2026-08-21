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

	it("should validate and reject invalid search summary aggregation types", () => {
		expect(SuiteScriptSearchValidator.validateSummaryType("SUM").valid).toBe(
			true,
		);
		expect(SuiteScriptSearchValidator.validateSummaryType("COUNT").valid).toBe(
			true,
		);
		expect(SuiteScriptSearchValidator.validateSummaryType("GROUP").valid).toBe(
			true,
		);

		const invalid = SuiteScriptSearchValidator.validateSummaryType("TOTAL");
		expect(invalid.valid).toBe(false);
		expect(invalid.suggestion).toContain("SUM");
	});

	it("should validate and reject invalid formula column names", () => {
		expect(
			SuiteScriptSearchValidator.validateFormulaField("formulatext").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateFormulaField("formulanumeric").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateFormulaField("formulacurrency").valid,
		).toBe(true);

		const invalid =
			SuiteScriptSearchValidator.validateFormulaField("formula_currency");
		expect(invalid.valid).toBe(false);
		expect(invalid.suggestion).toContain("formulacurrency");
	});

	it("should reject camelCase or PascalCase record type strings", () => {
		expect(
			SuiteScriptSearchValidator.validateRecordTypeString("salesorder").valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateRecordTypeString("customerpayment")
				.valid,
		).toBe(true);

		const camel =
			SuiteScriptSearchValidator.validateRecordTypeString("salesOrder");
		expect(camel.valid).toBe(false);
		expect(camel.suggestion).toContain("salesorder");

		const pascal =
			SuiteScriptSearchValidator.validateRecordTypeString("PurchaseOrder");
		expect(pascal.valid).toBe(false);
		expect(pascal.suggestion).toContain("purchaseorder");
	});

	it("should validate and reject invalid sublist field IDs", () => {
		expect(
			SuiteScriptSearchValidator.validateSublistField(
				"salesorder",
				"item",
				"quantity",
			).valid,
		).toBe(true);
		expect(
			SuiteScriptSearchValidator.validateSublistField(
				"salesorder",
				"item",
				"rate",
			).valid,
		).toBe(true);

		const invalidQty = SuiteScriptSearchValidator.validateSublistField(
			"salesorder",
			"item",
			"qty",
		);
		expect(invalidQty.valid).toBe(false);
		expect(invalidQty.suggestion).toContain("quantity");

		const invalidRate = SuiteScriptSearchValidator.validateSublistField(
			"salesorder",
			"item",
			"unitprice",
		);
		expect(invalidRate.valid).toBe(false);
		expect(invalidRate.suggestion).toContain("rate");
	});

	it("should validate and reject invalid filter connectors", () => {
		expect(
			SuiteScriptSearchValidator.validateFilterConnector("AND").valid,
		).toBe(true);
		expect(SuiteScriptSearchValidator.validateFilterConnector("OR").valid).toBe(
			true,
		);
		expect(
			SuiteScriptSearchValidator.validateFilterConnector("NOT").valid,
		).toBe(true);

		const invalidAnd =
			SuiteScriptSearchValidator.validateFilterConnector("and");
		expect(invalidAnd.valid).toBe(false);

		const invalidSymbol =
			SuiteScriptSearchValidator.validateFilterConnector("&&");
		expect(invalidSymbol.valid).toBe(false);
	});
});
