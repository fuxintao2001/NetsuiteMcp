#!/usr/bin/env node

/**
 * clean-error-logs.js — Clear NetSuite MCP error logs and diagnostic reports.
 *
 * Deletes:
 * - logs/*.jsonl
 * - logs/*.log
 * - logs/reports/*.md
 * - logs/reports/*.json
 *
 * Preserves:
 * - logs/.gitkeep
 * - logs/reports/.gitkeep
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultProjectRoot = path.resolve(__dirname, "..");

export function cleanErrorLogs(options = {}) {
	const projectRoot = options.projectRoot || defaultProjectRoot;
	const logsDir = options.logsDir || path.join(projectRoot, "logs");
	const reportsDir = path.join(logsDir, "reports");
	const silent = Boolean(options.silent);
	const dryRun = Boolean(options.dryRun);

	let deletedCount = 0;
	const deletedFiles = [];

	if (fs.existsSync(logsDir)) {
		const logEntries = fs.readdirSync(logsDir, { withFileTypes: true });
		for (const entry of logEntries) {
			if (entry.isFile()) {
				const name = entry.name;
				if (name === ".gitkeep") continue;
				if (
					name.endsWith(".jsonl") ||
					name.endsWith(".log") ||
					name.endsWith(".tmp")
				) {
					const filePath = path.join(logsDir, name);
					deletedFiles.push(filePath);
					if (!dryRun) {
						try {
							fs.unlinkSync(filePath);
							deletedCount++;
						} catch (err) {
							if (!silent) {
								const msg = err instanceof Error ? err.message : String(err);
								console.warn(`⚠️ Failed to remove ${name}:`, msg);
							}
						}
					} else {
						deletedCount++;
					}
				}
			}
		}
	}

	if (fs.existsSync(reportsDir)) {
		const reportEntries = fs.readdirSync(reportsDir, { withFileTypes: true });
		for (const entry of reportEntries) {
			if (entry.isFile()) {
				const name = entry.name;
				if (name === ".gitkeep") continue;
				if (name.endsWith(".md") || name.endsWith(".json")) {
					const filePath = path.join(reportsDir, name);
					deletedFiles.push(filePath);
					if (!dryRun) {
						try {
							fs.unlinkSync(filePath);
							deletedCount++;
						} catch (err) {
							if (!silent) {
								const msg = err instanceof Error ? err.message : String(err);
								console.warn(`⚠️ Failed to remove report ${name}:`, msg);
							}
						}
					} else {
						deletedCount++;
					}
				}
			}
		}
	}

	// Ensure .gitkeep markers are intact
	if (!dryRun) {
		try {
			if (!fs.existsSync(logsDir)) {
				fs.mkdirSync(logsDir, { recursive: true });
			}
			const logGitkeep = path.join(logsDir, ".gitkeep");
			if (!fs.existsSync(logGitkeep)) {
				fs.writeFileSync(logGitkeep, "");
			}

			if (!fs.existsSync(reportsDir)) {
				fs.mkdirSync(reportsDir, { recursive: true });
			}
			const reportGitkeep = path.join(reportsDir, ".gitkeep");
			if (!fs.existsSync(reportGitkeep)) {
				fs.writeFileSync(reportGitkeep, "");
			}
		} catch {
			// Non-fatal
		}
	}

	if (!silent) {
		if (dryRun) {
			console.log(
				`🔍 [Dry-Run] 发现待清理日志/报告文件 ${deletedCount} 个:\n${deletedFiles.map((f) => `   - ${f}`).join("\n")}`,
			);
		} else if (deletedCount > 0) {
			console.log(
				`🧹 [Clean Error Logs] 已成功清空 ${deletedCount} 个历史错误日志与诊断报告文件。`,
			);
		} else {
			console.log("✨ [Clean Error Logs] 错误日志目录已是清空状态，无需清理。");
		}
	}

	return { deletedCount, deletedFiles };
}

// Direct execution from CLI
if (process.argv[1] === __filename) {
	const dryRun = process.argv.includes("--dry-run");
	const silent =
		process.argv.includes("--silent") || process.argv.includes("-s");
	cleanErrorLogs({ dryRun, silent });
}
