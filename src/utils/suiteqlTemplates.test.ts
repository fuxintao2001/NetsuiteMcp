import { describe, expect, it } from "vitest";
import {
	SUITEQL_TEMPLATES,
	suiteqlTemplateService,
} from "./suiteqlTemplates.js";

describe("SuiteQLTemplateService", () => {
	it("should have curated templates defined", () => {
		expect(SUITEQL_TEMPLATES.length).toBeGreaterThanOrEqual(5);
	});

	it("should retrieve all templates without category", () => {
		const list = suiteqlTemplateService.listTemplates();
		expect(list.length).toBe(SUITEQL_TEMPLATES.length);
	});

	it("should filter templates by category", () => {
		const txList = suiteqlTemplateService.listTemplates("transactions");
		expect(txList.length).toBeGreaterThanOrEqual(2);
		expect(txList.every((t) => t.category === "transactions")).toBe(true);
	});

	it("should retrieve specific template by id", () => {
		const tmpl = suiteqlTemplateService.getTemplate("transaction_lines");
		expect(tmpl).toBeDefined();
		expect(tmpl?.id).toBe("transaction_lines");
		expect(tmpl?.sqlTemplate).toContain("tl.mainline = \x27F\x27");
		expect(tmpl?.sqlTemplate).toContain("FETCH FIRST");
	});

	it("should search templates by keyword", () => {
		const results = suiteqlTemplateService.searchTemplates("location");
		expect(results.length).toBeGreaterThan(0);
		expect(results.some((t) => t.id === "multi_location_stock")).toBe(true);
	});
});
