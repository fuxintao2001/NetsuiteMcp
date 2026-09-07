import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolErrorEntry } from "./toolErrorLogger.js";
import {
	findRelevantLogFiles,
	formatSummaryToMarkdown,
	generateRecommendations,
	loadErrorEntries,
	summarizeToolErrors,
} from "./toolErrorSummarizer.js";

describe("toolErrorSummarizer", () => {
	const testDir = path.resolve("./tmp-test-summarizer");

	beforeEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	const sampleEntries: ToolErrorEntry[] = [
		{
			id: "err-1",
			timestamp: new Date().toISOString(),
			tool: "ns_runCustomSuiteQL",
			accountId: "5848789_SB1",
			environment: "Sandbox",
			durationMs: 120,
			category: "SUITEQL_SYNTAX",
			errorMessage: "Table or view does not exist: unknown_table",
			parameters: { sqlQuery: "SELECT * FROM unknown_table" },
		},
		{
			id: "err-2",
			timestamp: new Date().toISOString(),
			tool: "ns_runCustomSuiteQL",
			accountId: "5848789_SB1",
			environment: "Sandbox",
			durationMs: 95,
			category: "SUITEQL_SYNTAX",
			errorMessage: "Table or view does not exist: another_fake_tbl",
			parameters: { sqlQuery: "SELECT * FROM another_fake_tbl" },
		},
		{
			id: "err-3",
			timestamp: new Date().toISOString(),
			tool: "ns_getRecord",
			accountId: "5848789_SB1",
			environment: "Sandbox",
			durationMs: 30,
			category: "ARGUMENT_VALIDATION",
			errorMessage: "Invalid arguments: missing id parameter",
			parameters: { recordType: "customer" },
		},
		{
			id: "err-4",
			timestamp: new Date().toISOString(),
			tool: "ns_createRecord",
			accountId: "5848789",
			environment: "Production",
			durationMs: 5,
			category: "PRODUCTION_WRITE_BLOCKED",
			errorMessage:
				"⛔ [Production Safety Violation] Operation strictly blocked in Production",
			parameters: { recordType: "customer" },
		},
		{
			id: "err-5",
			timestamp: new Date().toISOString(),
			tool: "ns_getRecord",
			accountId: "5848789_SB1",
			environment: "Sandbox",
			durationMs: 250,
			category: "PERMISSION_DENIED",
			errorMessage: "INSUFFICIENT_PERMISSION to view salesorder",
			parameters: { recordType: "salesorder", id: 123 },
		},
	];

	function writeSampleLogs(fileName: string, entries: ToolErrorEntry[]) {
		const filePath = path.join(testDir, fileName);
		const lines = entries.map((e) => JSON.stringify(e)).join("\n");
		fs.writeFileSync(filePath, lines, "utf-8");
		return filePath;
	}

	it("should find relevant log files and load entries correctly", async () => {
		writeSampleLogs("tool-errors.2026-09-07.1.jsonl", sampleEntries);
		writeSampleLogs("tool-errors.2026-09-06.1.jsonl", [sampleEntries[0]]);
		fs.writeFileSync(path.join(testDir, "ignored.txt"), "some text");

		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - 3);

		const files = findRelevantLogFiles(testDir, cutoff);
		expect(files.length).toBe(2);
		expect(files.every((f) => f.includes("tool-errors"))).toBe(true);

		const loaded = await loadErrorEntries(files, cutoff);
		expect(loaded.length).toBe(6);
	});

	it("should filter entries by tool and category", async () => {
		writeSampleLogs("tool-errors.2026-09-07.1.jsonl", sampleEntries);
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - 1);
		const files = findRelevantLogFiles(testDir, cutoff);

		const suiteqlOnly = await loadErrorEntries(files, cutoff, {
			tool: "ns_runCustomSuiteQL",
		});
		expect(suiteqlOnly.length).toBe(2);
		expect(suiteqlOnly.every((e) => e.tool === "ns_runCustomSuiteQL")).toBe(
			true,
		);

		const validationOnly = await loadErrorEntries(files, cutoff, {
			category: "ARGUMENT_VALIDATION",
		});
		expect(validationOnly.length).toBe(1);
		expect(validationOnly[0].category).toBe("ARGUMENT_VALIDATION");
	});

	it("should generate actionable recommendations across error categories", () => {
		const byCategory = {
			ARGUMENT_VALIDATION: 1,
			SUITEQL_SYNTAX: 2,
			PERMISSION_DENIED: 1,
			RECORD_NOT_FOUND: 0,
			PRODUCTION_WRITE_BLOCKED: 1,
			NETWORK_OR_TIMEOUT: 0,
			NETSUITE_API_ERROR: 0,
			SYSTEM_EXCEPTION: 0,
		};
		const byTool = {
			ns_runCustomSuiteQL: 2,
			ns_getRecord: 2,
			ns_createRecord: 1,
		};

		const recs = generateRecommendations(sampleEntries, byCategory, byTool);
		expect(recs.length).toBe(4);

		const areas = recs.map((r) => r.area);
		expect(areas).toContain("SCHEMA_DEFINITION");
		expect(areas).toContain("SUITEQL_TEMPLATES");
		expect(areas).toContain("ROLE_PERMISSIONS");
		expect(areas).toContain("ENVIRONMENT_CONFIG");

		const suiteqlRec = recs.find((r) => r.area === "SUITEQL_TEMPLATES");
		expect(suiteqlRec?.priority).toBe("HIGH");
		expect(suiteqlRec?.actionableFix).toContain("ns_getSuiteQLMetadata");
	});

	it("should compute full summary and format to Markdown", async () => {
		writeSampleLogs("tool-errors.2026-09-07.1.jsonl", sampleEntries);

		const summary = await summarizeToolErrors({
			logsDir: testDir,
			days: 7,
		});

		expect(summary.totalErrors).toBe(5);
		expect(summary.byTool.ns_runCustomSuiteQL).toBe(2);
		expect(summary.byEnvironment.Sandbox).toBe(4);
		expect(summary.byEnvironment.Production).toBe(1);
		expect(summary.recommendations.length).toBeGreaterThan(0);

		const markdown = formatSummaryToMarkdown(summary);
		expect(markdown).toContain(
			"# 📊 NetSuite MCP 工具调用错误分析与智能优化报告",
		);
		expect(markdown).toContain("`ns_runCustomSuiteQL`");
		expect(markdown).toContain("SUITEQL_SYNTAX");
		expect(markdown).toContain("ARGUMENT_VALIDATION");
		expect(markdown).toContain("依据实际调用的针对性优化建议");
		expect(markdown).toContain("最新错误抽样");
	});

	it("should handle empty log directory gracefully", async () => {
		const summary = await summarizeToolErrors({
			logsDir: testDir,
			days: 7,
		});
		expect(summary.totalErrors).toBe(0);
		const markdown = formatSummaryToMarkdown(summary);
		expect(markdown).toContain("近期未发现任何工具调用错误记录");
	});
});
