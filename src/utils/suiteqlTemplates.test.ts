import { describe, expect, it } from "vitest";
import { validateSuiteQL } from "./suiteqlGuard.js";
import {
	renderSuiteQLTemplate,
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

	it("should resolve templates by schema aliases", () => {
		expect(suiteqlTemplateService.getTemplate("transaction_lineage")?.id).toBe(
			"transaction_lineage_downstream",
		);
		expect(
			suiteqlTemplateService.getTemplate("multi_location_inventory")?.id,
		).toBe("multi_location_stock");
		expect(
			suiteqlTemplateService.getTemplate("item_inventory_status")?.id,
		).toBe("bin_inventory_balance");
		expect(
			suiteqlTemplateService.getTemplate("script_execution_errors")?.id,
		).toBe("script_error_logs");
		expect(suiteqlTemplateService.getTemplate("audit_system_notes")?.id).toBe(
			"system_notes_standalone",
		);
		expect(
			suiteqlTemplateService.getTemplate("general_ledger_impact")?.id,
		).toBe("gl_impact_lines");
		expect(
			suiteqlTemplateService.getTemplate("entity_balance_summary")?.id,
		).toBe("customer_balance_aging");
	});

	it("should search templates by keyword", () => {
		const results = suiteqlTemplateService.searchTemplates("location");
		expect(results.length).toBeGreaterThan(0);
		expect(results.some((t) => t.id === "multi_location_stock")).toBe(true);
	});

	it("should render all 9 golden templates into valid SuiteQL passing validateSuiteQL", () => {
		const sampleParamsByTemplate: Record<string, Record<string, string>> = {
			transaction_lines: {
				tranType: "SalesOrd",
				tranId: "6257",
				docNumber: "SO10023",
			},
			transaction_lineage_downstream: {
				upstreamTranId: "6257",
			},
			multi_location_stock: {
				itemId: "100",
				locationId: "1",
			},
			bin_inventory_balance: {
				itemId: "100",
			},
			script_error_logs: {
				scriptId: "customscript_my_ue",
			},
			system_notes_standalone: {
				recordId: "6257",
			},
			gl_impact_lines: {
				tranId: "6257",
			},
			customer_balance_aging: {
				customerId: "166",
				customerCode: "IC00000009",
			},
			record_deployed_scripts: {
				recordType: "SALESORDER",
			},
		};

		for (const tmpl of SUITEQL_TEMPLATES) {
			const rendered = renderSuiteQLTemplate(
				tmpl,
				sampleParamsByTemplate[tmpl.id],
			);
			const validation = validateSuiteQL(rendered);
			expect(
				validation.valid,
				`Template '${tmpl.id}' failed validation: ${validation.reason}\nSQL:\n${rendered}`,
			).toBe(true);
			for (const paramKey of Object.keys(tmpl.parameters ?? {})) {
				expect(rendered).not.toContain(`:${paramKey}`);
			}
		}
	});

	it("should safely quote strings, escape single quotes, and bind NULL for omitted optional params", () => {
		const tmpl = suiteqlTemplateService.getTemplate("customer_balance_aging");
		expect(tmpl).toBeDefined();
		if (!tmpl) return;
		const rendered = renderSuiteQLTemplate(tmpl, {
			customerCode: "CUST'001",
		});
		expect(rendered).toContain("c.id = NULL");
		expect(rendered).toContain("c.entityid = 'CUST''001'");
		expect(validateSuiteQL(rendered).valid).toBe(true);
	});
});
