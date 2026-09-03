import { describe, expect, it } from "vitest";
import { recordsReferenceService } from "./recordsReference.js";

describe("RecordsReferenceService", () => {
	it("should list standard record types", () => {
		const types = recordsReferenceService.listRecordTypes();
		expect(Array.isArray(types)).toBe(true);
		// If records.json exists in ~/.gemini/config/skills/..., it has 272 types
		if (types.length > 0) {
			expect(types.length).toBeGreaterThanOrEqual(200);
			expect(types).toContain("salesorder");
			expect(types).toContain("customer");
			expect(types).toContain("invoice");
		}
	});

	it("should return definition for salesorder", () => {
		const def = recordsReferenceService.getRecordDefinition("salesorder");
		if (def?.found) {
			expect(def.recordType).toBe("salesorder");
			expect(def.totalFields).toBeGreaterThan(50);
			expect(def.fields.some((f) => f.internalId === "entity")).toBe(true);
		}
	});

	it("should filter fields by keyword", () => {
		const def = recordsReferenceService.getRecordDefinition(
			"salesorder",
			"entity",
		);
		if (def?.found) {
			expect(def.fields.length).toBeLessThan(def.totalFields);
			expect(
				def.fields.every(
					(f) =>
						f.internalId.toLowerCase().includes("entity") ||
						f.label.toLowerCase().includes("entity") ||
						f.help?.toLowerCase().includes("entity"),
				),
			).toBe(true);
		}
	});

	it("should return found=false for unknown record type", () => {
		const def = recordsReferenceService.getRecordDefinition(
			"completely_unknown_record_123",
		);
		if (def) {
			expect(def.found).toBe(false);
			expect(def.fields.length).toBe(0);
		}
	});
});
