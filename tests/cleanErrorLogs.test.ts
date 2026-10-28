import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanErrorLogs } from "../scripts/clean-error-logs.js";

describe("cleanErrorLogs Script & Utility", () => {
	let tempDir: string;
	let tempLogsDir: string;
	let tempReportsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-clean-test-"));
		tempLogsDir = path.join(tempDir, "logs");
		tempReportsDir = path.join(tempLogsDir, "reports");

		fs.mkdirSync(tempReportsDir, { recursive: true });
		fs.writeFileSync(path.join(tempLogsDir, ".gitkeep"), "");
		fs.writeFileSync(path.join(tempReportsDir, ".gitkeep"), "");
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("should delete jsonl, log, and report md files while preserving .gitkeep", () => {
		// Populate test files
		fs.writeFileSync(
			path.join(tempLogsDir, "tool-errors.2026-10-28.1.jsonl"),
			'{"test":1}',
		);
		fs.writeFileSync(path.join(tempLogsDir, "audit.log"), "sample log");
		fs.writeFileSync(
			path.join(tempReportsDir, "daily-summary-2026-10-28.md"),
			"# Summary",
		);
		fs.writeFileSync(
			path.join(tempReportsDir, "daily-summary-latest.md"),
			"# Latest",
		);

		const result = cleanErrorLogs({
			logsDir: tempLogsDir,
			silent: true,
		});

		expect(result.deletedCount).toBe(4);

		// Verified deleted
		expect(
			fs.existsSync(path.join(tempLogsDir, "tool-errors.2026-10-28.1.jsonl")),
		).toBe(false);
		expect(fs.existsSync(path.join(tempLogsDir, "audit.log"))).toBe(false);
		expect(
			fs.existsSync(path.join(tempReportsDir, "daily-summary-2026-10-28.md")),
		).toBe(false);
		expect(
			fs.existsSync(path.join(tempReportsDir, "daily-summary-latest.md")),
		).toBe(false);

		// Verified preserved
		expect(fs.existsSync(path.join(tempLogsDir, ".gitkeep"))).toBe(true);
		expect(fs.existsSync(path.join(tempReportsDir, ".gitkeep"))).toBe(true);
	});

	it("should support dry-run mode without deleting any files", () => {
		const jsonlPath = path.join(
			tempLogsDir,
			"tool-errors.2026-10-28.1.jsonl",
		);
		fs.writeFileSync(jsonlPath, '{"test":1}');

		const result = cleanErrorLogs({
			logsDir: tempLogsDir,
			dryRun: true,
			silent: true,
		});

		expect(result.deletedCount).toBe(1);
		expect(fs.existsSync(jsonlPath)).toBe(true);
	});

	it("should recreate .gitkeep if missing", () => {
		fs.unlinkSync(path.join(tempLogsDir, ".gitkeep"));
		fs.unlinkSync(path.join(tempReportsDir, ".gitkeep"));

		cleanErrorLogs({
			logsDir: tempLogsDir,
			silent: true,
		});

		expect(fs.existsSync(path.join(tempLogsDir, ".gitkeep"))).toBe(true);
		expect(fs.existsSync(path.join(tempReportsDir, ".gitkeep"))).toBe(true);
	});

	it("should handle empty or non-existent directories gracefully", () => {
		const emptyDir = path.join(tempDir, "non_existent_logs");
		const result = cleanErrorLogs({
			logsDir: emptyDir,
			silent: true,
		});

		expect(result.deletedCount).toBe(0);
	});
});
