import { describe, expect, it } from "vitest";
import {
	PermissionsReferenceService,
	permissionsReferenceService,
} from "./permissionsReference.js";

describe("PermissionsReferenceService", () => {
	it("should allow custom instances with custom data", () => {
		const customService = new PermissionsReferenceService([
			{
				id: "TRAN_CUSTOM",
				name: "Custom Transaction",
				category: "TRAN",
				categoryLabel: "Transactions",
			},
		]);
		expect(customService.getAllPermissions().length).toBe(1);
		expect(customService.getPermissionById("TRAN_CUSTOM")?.name).toBe(
			"Custom Transaction",
		);
	});

	it("should initialize with 680 standard permissions across 5 categories", () => {
		const allPerms = permissionsReferenceService.getAllPermissions();
		expect(allPerms.length).toBe(680);

		const categories = permissionsReferenceService.listCategories();
		expect(categories.length).toBe(5);

		const catCodes = categories.map((c) => c.category);
		expect(catCodes).toContain("ADMI");
		expect(catCodes).toContain("LIST");
		expect(catCodes).toContain("TRAN");
		expect(catCodes).toContain("REPO");
		expect(catCodes).toContain("REGT");

		const totalCount = categories.reduce((sum, c) => sum + c.count, 0);
		expect(totalCount).toBe(680);
	});

	it("should look up permissions by ID case-insensitively", () => {
		const soPerm =
			permissionsReferenceService.getPermissionById("TRAN_SALESORD");
		expect(soPerm).toBeDefined();
		expect(soPerm?.name).toBe("Sales Order");
		expect(soPerm?.category).toBe("TRAN");
		expect(soPerm?.categoryLabel).toBe("Transactions");

		const custPerm =
			permissionsReferenceService.getPermissionById("list_custjob");
		expect(custPerm).toBeDefined();
		expect(custPerm?.name).toBe("Customers");
		expect(custPerm?.category).toBe("LIST");

		const adminPerm =
			permissionsReferenceService.getPermissionById("ADMI_ACCOUNTING");
		expect(adminPerm).toBeDefined();
		expect(adminPerm?.name).toBe("Accounting Management");
		expect(adminPerm?.category).toBe("ADMI");

		const nonExistent =
			permissionsReferenceService.getPermissionById("UNKNOWN_PERM_123");
		expect(nonExistent).toBeUndefined();
	});

	it("should filter permissions by category", () => {
		const tranPerms =
			permissionsReferenceService.getPermissionsByCategory("TRAN");
		expect(tranPerms.length).toBe(159);
		expect(tranPerms.every((p) => p.category === "TRAN")).toBe(true);

		const listPerms =
			permissionsReferenceService.getPermissionsByCategory("LIST");
		expect(listPerms.length).toBe(224);
		expect(listPerms.every((p) => p.category === "LIST")).toBe(true);

		const admiPerms =
			permissionsReferenceService.getPermissionsByCategory("ADMI");
		expect(admiPerms.length).toBe(209);
		expect(admiPerms.every((p) => p.category === "ADMI")).toBe(true);
	});

	it("should search permissions by keyword", () => {
		const invoicePerms =
			permissionsReferenceService.searchPermissions("invoice");
		expect(invoicePerms.length).toBeGreaterThan(0);
		expect(
			invoicePerms.some(
				(p) => p.id === "TRAN_CUSTINVC" || p.name.includes("Invoice"),
			),
		).toBe(true);

		const accountingPerms =
			permissionsReferenceService.searchPermissions("accounting");
		expect(accountingPerms.length).toBeGreaterThan(0);
		expect(accountingPerms.some((p) => p.id === "ADMI_ACCOUNTING")).toBe(true);
	});

	it("should map record types to required NetSuite permissions", () => {
		const soPerms =
			permissionsReferenceService.lookupPermissionForRecordType("salesorder");
		expect(soPerms.length).toBeGreaterThan(0);
		expect(soPerms.some((p) => p.id === "TRAN_SALESORD")).toBe(true);

		const custPerms =
			permissionsReferenceService.lookupPermissionForRecordType("customer");
		expect(custPerms.length).toBeGreaterThan(0);
		expect(custPerms.some((p) => p.id === "LIST_CUSTJOB")).toBe(true);

		const poPerms =
			permissionsReferenceService.lookupPermissionForRecordType(
				"purchaseorder",
			);
		expect(poPerms.length).toBeGreaterThan(0);
		expect(poPerms.some((p) => p.id === "TRAN_PURCHORD")).toBe(true);

		const customRecordPerms =
			permissionsReferenceService.lookupPermissionForRecordType(
				"customrecord_test_entity",
			);
		expect(customRecordPerms.length).toBeGreaterThan(0);
		expect(customRecordPerms.some((p) => p.id === "ADMI_CUSTRECORD")).toBe(
			true,
		);
	});

	it("should format markdown reference with 403 Self-Healing Diagnostic SOP", () => {
		const md = permissionsReferenceService.formatPermissionsMarkdown();
		expect(md).toContain(
			"# Oracle NetSuite Official Standard Permissions Matrix Dictionary",
		);
		expect(md).toContain("680 Official Standard Permissions");
		expect(md).toContain(
			"403 Permission Denied Self-Healing Diagnostic & Remediation SOP",
		);
		expect(md).toContain("TRAN_SALESORD");
		expect(md).toContain("LIST_CUSTJOB");
		expect(md).toContain("ADMI_ACCOUNTING");
	});

	it("should support filtered markdown formatting", () => {
		const md =
			permissionsReferenceService.formatPermissionsMarkdown("salesorder");
		expect(md).toContain('Filtered by: "salesorder"');
		expect(md).toContain("TRAN_SALESORD");
	});
});
