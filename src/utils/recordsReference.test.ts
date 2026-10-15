import { describe, expect, it } from "vitest";
import { recordsReferenceService } from "./recordsReference.js";

describe("RecordsReferenceService", () => {
	it("should list standard record types and core views", () => {
		const types = recordsReferenceService.listRecordTypes();
		expect(Array.isArray(types)).toBe(true);
		expect(types.length).toBeGreaterThanOrEqual(272);
		expect(types).toContain("salesorder");
		expect(types).toContain("customer");
		expect(types).toContain("invoice");
		expect(types).toContain("transactionaccountingline");
		expect(types).toContain("billingrevenueevent");
		expect(types).toContain("transactionline");
		expect(types).toContain("systemnote");
	});

	it("should return definition for salesorder with sublists and relations", () => {
		const def = recordsReferenceService.getRecordDefinition("salesorder");
		expect(def?.found).toBe(true);
		if (def?.found) {
			expect(def.recordType).toBe("salesorder");
			expect(def.totalFields).toBeGreaterThan(30);
			expect(def.fields.some((f) => f.internalId === "entity")).toBe(true);
			expect(def.sublists).toBeDefined();
			expect(def.sublists?.some((s) => s.name === "item")).toBe(true);
			expect(def.relations).toBeDefined();
			expect(def.relations?.some((r) => r.field === "entity")).toBe(true);
		}
	});

	it("should return definition for transactionaccountingline with GL fields and foreign keys", () => {
		const def = recordsReferenceService.getRecordDefinition(
			"transactionaccountingline",
		);
		expect(def?.found).toBe(true);
		if (def?.found) {
			expect(def.recordType).toBe("transactionaccountingline");
			expect(def.fields.some((f) => f.internalId === "account")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "posting")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "debit")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "credit")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "amount")).toBe(true);
			expect(def.relations).toBeDefined();
			expect(def.relations?.some((r) => r.field === "account")).toBe(true);
			expect(def.relations?.some((r) => r.field === "transaction")).toBe(true);
		}
	});

	it("should return definition for billingrevenueevent with ARM fields and relations", () => {
		const def = recordsReferenceService.getRecordDefinition(
			"billingrevenueevent",
		);
		expect(def?.found).toBe(true);
		if (def?.found) {
			expect(def.recordType).toBe("billingrevenueevent");
			expect(def.fields.some((f) => f.internalId === "eventtype")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "amount")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "subsidiary")).toBe(true);
			expect(def.relations).toBeDefined();
			expect(def.relations?.some((r) => r.field === "transaction")).toBe(true);
			expect(def.relations?.some((r) => r.field === "revenueelement")).toBe(
				true,
			);
		}
	});

	it("should return definition for transactionline with mainline and lineage", () => {
		const def = recordsReferenceService.getRecordDefinition("transactionline");
		expect(def?.found).toBe(true);
		if (def?.found) {
			expect(def.recordType).toBe("transactionline");
			expect(def.fields.some((f) => f.internalId === "mainline")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "item")).toBe(true);
			expect(def.fields.some((f) => f.internalId === "createdfrom")).toBe(true);
			expect(def.relations?.some((r) => r.field === "createdfrom")).toBe(true);
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
