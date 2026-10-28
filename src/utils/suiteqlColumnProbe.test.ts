import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheService } from "../cache/cache.js";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import {
	extractAliasedColumns,
	extractTableAliases,
	formatProbeResults,
	probeSuspiciousColumns,
} from "./suiteqlColumnProbe.js";

describe("suiteqlColumnProbe", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("extractTableAliases", () => {
		it("should extract table aliases from FROM and JOIN clauses", () => {
			const sql =
				"SELECT t.id, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE tl.mainline = 'F'";
			const aliases = extractTableAliases(sql);
			expect(aliases.get("t")).toBe("transaction");
			expect(aliases.get("tl")).toBe("transactionline");
		});

		it("should ignore SQL keywords as aliases", () => {
			const sql = "SELECT * FROM transaction WHERE id = 1";
			const aliases = extractTableAliases(sql);
			expect(aliases.get("transaction")).toBe("transaction");
			expect(aliases.has("where")).toBe(false);
		});
	});

	describe("extractAliasedColumns", () => {
		it("should extract unique alias.column pairs matching registered table aliases", () => {
			const tableAliases = new Map([
				["tl", "transactionline"],
				["t", "transaction"],
			]);
			const sql =
				"SELECT tl.transaction, t.tranid, tl.lineuniquekey, tl.item, tl.lineuniquekey FROM transactionline tl JOIN transaction t ON tl.transaction = t.id";
			const cols = extractAliasedColumns(sql, tableAliases);

			expect(cols).toEqual([
				{ table: "transactionline", column: "transaction", alias: "tl" },
				{ table: "transaction", column: "tranid", alias: "t" },
				{ table: "transactionline", column: "lineuniquekey", alias: "tl" },
				{ table: "transactionline", column: "item", alias: "tl" },
				{ table: "transaction", column: "id", alias: "t" },
			]);
		});
	});

	describe("probeSuspiciousColumns & formatProbeResults", () => {
		it("should probe invalid columns concurrently and attach hints", async () => {
			vi.spyOn(cacheService, "get").mockResolvedValue(null);
			const setSpy = vi.spyOn(cacheService, "set").mockResolvedValue();

			const mockMcpTools = {
				executeTool: vi.fn().mockImplementation((_name, params) => {
					const sql = params?.sqlQuery || "";
					if (sql.includes("intercotransaction")) {
						throw new Error(
							"Search error occurred: An unexpected SuiteScript error has occurred",
						);
					}
					return Promise.resolve({ result: [] });
				}),
			} as unknown as NetSuiteMCPTools;

			const sql =
				"SELECT tl.line, tl.intercotransaction FROM transactionline tl WHERE tl.transaction = 123";
			const issues = await probeSuspiciousColumns(
				sql,
				"9260916_sb1",
				mockMcpTools,
			);

			expect(issues.length).toBe(1);
			expect(issues[0].table).toBe("transactionline");
			expect(issues[0].column).toBe("intercotransaction");
			expect(issues[0].hint).toBeDefined();
			expect(issues[0].hint?.fix).toBe("transaction.intercotransaction");

			expect(setSpy).toHaveBeenCalledWith(
				"9260916_sb1",
				"colprobe:transactionline:intercotransaction",
				"invalid",
				86400,
			);

			const formatted = formatProbeResults(issues);
			expect(formatted).toContain("Automated Column Diagnostics");
			expect(formatted).toContain("transactionline.intercotransaction");
			expect(formatted).toContain("transaction.intercotransaction");
		});

		it("should return empty string when issues list is empty", () => {
			expect(formatProbeResults([])).toBe("");
		});
	});
});
