import { describe, expect, it } from "vitest";
import {
	formatSuiteQLBuiltinsMarkdown,
	getAllSuiteQLBuiltins,
	getSuiteQLBuiltinByName,
} from "./suiteqlBuiltinsReference.js";

describe("SuiteQLBuiltinsReference", () => {
	it("should provide authoritative list of all built-in functions", () => {
		const builtins = getAllSuiteQLBuiltins();
		expect(builtins.length).toBeGreaterThanOrEqual(6);

		const names = builtins.map((b) => b.name);
		expect(names).toContain("BUILTIN.DF");
		expect(names).toContain("BUILTIN.CF");
		expect(names).toContain("BUILTIN.HIERARCHY");
		expect(names).toContain("BUILTIN.PERIOD");
		expect(names).toContain("BUILTIN.CONSOLIDATE");
		expect(names).toContain("BUILTIN.RELATIVE_RANGES");
	});

	it("should look up built-in function by name case-insensitively", () => {
		const df = getSuiteQLBuiltinByName("builtin.df");
		expect(df).toBeDefined();
		expect(df?.signature).toContain("BUILTIN.DF(field_reference)");
		expect(df?.category).toBe("Display & Formatting");
		expect(df?.safePitfalls.some((p) => p.includes("GROUP BY"))).toBe(true);

		const consolidate = getSuiteQLBuiltinByName("BUILTIN.CONSOLIDATE");
		expect(consolidate).toBeDefined();
		expect(consolidate?.parameters.length).toBe(7);
		expect(consolidate?.category).toBe("Currency & Consolidation");

		const period = getSuiteQLBuiltinByName("BUILTIN.PERIOD");
		expect(period).toBeDefined();
		expect(period?.parameters.length).toBe(4);
		expect(period?.category).toBe("Periods & Dates");

		const hierarchy = getSuiteQLBuiltinByName("BUILTIN.HIERARCHY");
		expect(hierarchy).toBeDefined();
		expect(hierarchy?.parameters.some((p) => p.name === "format_type")).toBe(
			true,
		);

		const unknown = getSuiteQLBuiltinByName("BUILTIN.NONEXISTENT");
		expect(unknown).toBeUndefined();
	});

	it("should format markdown documentation with signatures, parameters, and examples", () => {
		const md = formatSuiteQLBuiltinsMarkdown();
		expect(md).toContain(
			"# Oracle NetSuite2.com Official SuiteQL Built-in Functions Reference",
		);
		expect(md).toContain("BUILTIN.DF");
		expect(md).toContain("BUILTIN.CF");
		expect(md).toContain("BUILTIN.HIERARCHY");
		expect(md).toContain("BUILTIN.PERIOD");
		expect(md).toContain("BUILTIN.CONSOLIDATE");
		expect(md).toContain("BUILTIN.RELATIVE_RANGES");
		expect(md).toContain("SAFE Pitfalls & Guardrail Constraints");
		expect(md).toContain("Production Query Examples");
	});
});
