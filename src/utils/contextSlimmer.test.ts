import { describe, expect, it } from "vitest";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "./contextSlimmer.js";

describe("Context Slimmer", () => {
	describe("cleanRecordPayload", () => {
		it("should recursively remove null, undefined, empty strings, and links key", () => {
			const payload = {
				id: "123",
				name: "John Doe",
				email: "",
				parent: null,
				links: [{ rel: "self", href: "/url" }],
				nested: {
					active: true,
					value: undefined,
					links: { href: "/another-url" },
				},
				items: [{ sku: "A", discount: null, links: [] }],
			};

			const result = cleanRecordPayload(payload);
			expect(result).toEqual({
				id: "123",
				name: "John Doe",
				nested: {
					active: true,
				},
				items: [{ sku: "A" }],
			});
		});

		it("should fall back to empty object/array when everything is cleaned", () => {
			expect(cleanRecordPayload({ links: [], temp: null })).toEqual({});
			expect(cleanRecordPayload([null, undefined])).toEqual([]);
		});
	});

	describe("formatMetadataToCompactMarkdown", () => {
		it("should convert standard JSON Schema properties into a Markdown table", () => {
			const schema = {
				properties: {
					id: { title: "Internal ID", type: "string", nullable: false },
					name: { title: "Name", type: "string", description: "Customer name" },
					company: {
						title: "Company Reference",
						type: "object",
						properties: { id: { type: "string" }, refName: { type: "string" } },
					},
				},
			};

			const markdown = formatMetadataToCompactMarkdown(schema);
			expect(markdown).toContain("| Field | Type | Description | Nullable |");
			expect(markdown).toContain("| id | string | Internal ID | No |");
			expect(markdown).toContain("| name | string | Customer name | Yes |");
			expect(markdown).toContain(
				"| company | object (id, refName) | Company Reference | Yes |",
			);
		});

		it("should unwrap schema when nested in success/metadata or content formats", () => {
			const mcpFormat = {
				content: [
					{
						text: JSON.stringify({
							success: true,
							metadata: {
								properties: {
									sku: { title: "SKU", type: "string" },
								},
							},
						}),
					},
				],
			};

			const markdown = formatMetadataToCompactMarkdown(mcpFormat);
			expect(markdown).toContain("| sku | string | SKU | Yes |");
		});

		it("should return stringified fallback on non-object inputs", () => {
			expect(formatMetadataToCompactMarkdown("plain string")).toBe(
				"plain string",
			);
			expect(formatMetadataToCompactMarkdown(null)).toBe("null");
		});
	});

	describe("formatSuiteQLToCompactMarkdown", () => {
		it("should format a standard SuiteQL result array into a Markdown table", () => {
			const suiteqlResult = {
				totalResults: 2,
				numberOfPages: 1,
				data: [
					{ id: "101", tranid: "SO1001", trandate: "2025-01-01", amount: 5000 },
					{ id: "102", tranid: "SO1002", trandate: "2025-01-02", amount: 3200 },
				],
			};

			const markdown = formatSuiteQLToCompactMarkdown(suiteqlResult);
			expect(markdown).toContain("| id | tranid | trandate | amount |");
			expect(markdown).toContain("| 101 | SO1001 | 2025-01-01 | 5000 |");
			expect(markdown).toContain("| 102 | SO1002 | 2025-01-02 | 3200 |");
		});

		it("should escape pipe characters and newlines in column values", () => {
			const data = [
				{
					id: "1",
					memo: "Contract | Phase 1\nNotes here",
					status: null,
				},
			];

			const markdown = formatSuiteQLToCompactMarkdown(data);
			expect(markdown).toContain("| id | memo | status |");
			expect(markdown).toContain("Contract \\| Phase 1 Notes here");
			expect(markdown).toContain(" - |");
		});

		it("should handle empty results gracefully", () => {
			expect(formatSuiteQLToCompactMarkdown([])).toBe("No rows returned.");
			expect(formatSuiteQLToCompactMarkdown({ data: [] })).toBe(
				"No rows returned.",
			);
			expect(formatSuiteQLToCompactMarkdown(null)).toBe("No results returned.");
		});

		it("should display total results notice when paginated", () => {
			const paginatedResult = {
				totalResults: 150,
				data: [
					{ id: "1", name: "Row 1" },
					{ id: "2", name: "Row 2" },
				],
			};

			const markdown = formatSuiteQLToCompactMarkdown(paginatedResult);
			expect(markdown).toContain("*Total Results: 150 (Showing 2 rows)*");
			expect(markdown).toContain("| 1 | Row 1 |");
		});
	});
});
