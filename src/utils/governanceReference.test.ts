import { describe, expect, it } from "vitest";
import {
	formatGovernanceUnitsMarkdown,
	getAllOperationCosts,
	getAllScriptLimits,
} from "./governanceReference.js";

describe("GovernanceReference", () => {
	it("should provide script type governance limits conforming to Oracle SAFE Guide", () => {
		const limits = getAllScriptLimits();
		expect(limits.length).toBeGreaterThanOrEqual(10);

		const userEvent = limits.find((l) => l.scriptType === "User Event Script");
		expect(userEvent).toBeDefined();
		expect(userEvent?.limitUnits).toBe(1000);

		const suitelet = limits.find((l) => l.scriptType === "Suitelet");
		expect(suitelet).toBeDefined();
		expect(suitelet?.limitUnits).toBe(1000);

		const restlet = limits.find((l) => l.scriptType === "RESTlet");
		expect(restlet).toBeDefined();
		expect(restlet?.limitUnits).toBe(5000);

		const scheduled = limits.find((l) => l.scriptType === "Scheduled Script");
		expect(scheduled).toBeDefined();
		expect(scheduled?.limitUnits).toBe(10000);

		const mapReduce = limits.find((l) => l.scriptType === "Map/Reduce Script");
		expect(mapReduce).toBeDefined();
		expect(mapReduce?.limitUnits).toBe(10000);

		const client = limits.find((l) => l.scriptType === "Client Script");
		expect(client).toBeDefined();
		expect(client?.limitUnits).toBe("N/A");
	});

	it("should provide API operation usage costs", () => {
		const ops = getAllOperationCosts();
		expect(ops.length).toBeGreaterThanOrEqual(10);

		const recordLoad = ops.find((o) => o.operation === "record.load()");
		expect(recordLoad).toBeDefined();
		expect(recordLoad?.units).toBe(5);

		const recordSave = ops.find((o) => o.operation === "record.save()");
		expect(recordSave).toBeDefined();
		expect(recordSave?.units).toBe(20);

		const lookupFields = ops.find(
			(o) => o.operation === "search.lookupFields()",
		);
		expect(lookupFields).toBeDefined();
		expect(lookupFields?.units).toBe(1);

		const submitFields = ops.find(
			(o) => o.operation === "record.submitFields()",
		);
		expect(submitFields).toBeDefined();
		expect(submitFields?.units).toBe(2);

		const searchRun = ops.find((o) => o.operation === "search.create().run()");
		expect(searchRun).toBeDefined();
		expect(searchRun?.units).toBe(10);
	});

	it("should format governance markdown reference", () => {
		const md = formatGovernanceUnitsMarkdown();
		expect(md).toContain(
			"# Oracle NetSuite SAFE Guide Official Governance Units & Limits Reference",
		);
		expect(md).toContain("1. Script Type Governance Limits");
		expect(md).toContain("2. API Operation Usage Unit Costs");
		expect(md).toContain("3. Oracle SAFE Guide Core Optimization Patterns");
		expect(md).toContain("SAFE-GOV-001");
		expect(md).toContain("SAFE-GOV-002");
	});
});
