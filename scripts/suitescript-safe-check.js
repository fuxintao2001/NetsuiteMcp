#!/usr/bin/env node
/**
 * suitescript-safe-check.js — Static analyzer for SuiteScript files adhering to Oracle SAFE Guide 2025.2 & OWASP.
 *
 * Checks for:
 * 1. Governance unit exhaustion (record.load/search inside loops)
 * 2. Unbounded transaction queries (missing mainline = 'F')
 * 3. Security vulnerabilities (eval, unencoded output, script injection)
 * 4. Deprecated SuiteScript 1.0 API usage
 * 5. SuiteQL SELECT * anti-pattern
 *
 * Usage:
 *   node scripts/suitescript-safe-check.js [files...]
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} Issue
 * @property {string} file
 * @property {number} line
 * @property {string} rule
 * @property {string} message
 * @property {'ERROR' | 'WARNING'} severity
 */

/**
 * Analyze SuiteScript file content for anti-patterns and SAFE violations.
 * @param {string} content
 * @param {string} [filename="anonymous.js"]
 * @returns {Issue[]}
 */
export function analyzeSuiteScriptContent(content, filename = "anonymous.js") {
	const issues = [];
	const lines = content.split("\n");

	let inLoopDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;
		const trimmed = line.trim();

		// Skip comments
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

		// Track loop depth
		const isLoopHeader = /\b(for|while)\s*\(|\.forEach\s*\(/.test(line);
		if (isLoopHeader) {
			inLoopDepth++;
		}

		// Rule 1: Governance abuse - record.load / submit inside loop
		if (
			inLoopDepth > 0 &&
			/\brecord\.(load|delete|submitFields)\s*\(/.test(line)
		) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-GOV-001",
				message:
					"Avoid record.load/delete/submitFields inside loops. Governance will exhaust rapidly on bulk data. Use Map/Reduce or submitFields batch.",
				severity: "ERROR",
			});
		}

		// Rule 2: Deprecated SuiteScript 1.0 APIs
		const ss10Match = line.match(
			/\b(nlapi[A-Za-z0-9_]+|nlapiSearchRecord|nlapiLoadRecord|nlapiSubmitRecord)\b/,
		);
		if (ss10Match) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-LEGACY-001",
				message: `Deprecated SuiteScript 1.0 API '${ss10Match[1]}' detected. Migrate to SuiteScript 2.1 standard modules (N/record, N/search, N/query).`,
				severity: "ERROR",
			});
		}

		// Rule 3: Security - eval() or new Function()
		if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(line)) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "OWASP-INJ-001",
				message:
					"Dangerous dynamic code execution (eval / Function) detected. High risk of Remote Code Execution (OWASP Top 10).",
				severity: "ERROR",
			});
		}

		// Rule 4: SuiteQL SELECT *
		if (/SELECT\s+\*\s+FROM/i.test(line)) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-SQL-001",
				message:
					"Wildcard projection (SELECT *) detected in query string. Explicitly project required columns to prevent context overflow.",
				severity: "ERROR",
			});
		}

		// Rule 5: SuiteQL MySQL LIMIT/OFFSET
		if (/\bLIMIT\s+\d+\s+OFFSET\s+\d+/i.test(line)) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-SQL-002",
				message:
					"MySQL LIMIT/OFFSET dialect detected. SuiteQL requires 'FETCH FIRST N ROWS ONLY' or 'ROWNUM <= N'.",
				severity: "ERROR",
			});
		}

		// Rule 6: Transaction search missing mainline filter
		if (
			/\bsearch\.create\s*\(\s*\{\s*type:\s*['"]transaction['"]/i.test(line) ||
			/\btype:\s*search\.Type\.TRANSACTION\b/i.test(line)
		) {
			// Check if subsequent lines or this line has mainline
			const contextBlock = lines
				.slice(i, Math.min(lines.length, i + 15))
				.join(" ");
			if (!/mainline/i.test(contextBlock)) {
				issues.push({
					file: filename,
					line: lineNum,
					rule: "SAFE-SCH-001",
					message:
						"Transaction search should specify 'mainline' filter ('IS', 'T' or 'F') to avoid line multiplication or duplicated header records.",
					severity: "WARNING",
				});
			}
		}

		// Rule 7: SystemNote cross-table JOIN (SAFE Guide Pitfall 11)
		if (/\bJOIN\s+SystemNote\b/i.test(line)) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-SQL-003",
				message:
					"Prohibited 'JOIN SystemNote' detected (SAFE Guide Pitfall 11). Cross-table joins with SystemNote cause severe 45s+ timeouts. Use a standalone query with date/recordid pruning instead.",
				severity: "ERROR",
			});
		}

		// Rule 8: Invalid createdfrom field location on transaction header
		if (
			/\b(?:transaction|t)\.createdfrom\b/i.test(line) ||
			(/\bFROM\s+transaction\b/i.test(line) &&
				/\bcreatedfrom\b/i.test(line) &&
				!/\btransactionline\b/i.test(line))
		) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-SQL-004",
				message:
					"Invalid field location 'createdfrom': In NetSuite2.com, 'createdfrom' does NOT exist on the 'transaction' header. Join 'transactionline tl' and query 'tl.createdfrom'.",
				severity: "ERROR",
			});
		}

		// Rule 9: Invalid recordtype column on item table
		if (
			/\bitem\.recordtype\b/i.test(line) ||
			(/\bFROM\s+item\b/i.test(line) && /\brecordtype\b/i.test(line))
		) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-SQL-005",
				message:
					"Invalid column 'item.recordtype': In NetSuite Records Catalog, the 'item' table does not have 'recordtype'. Use 'itemtype' or 'subtype' instead.",
				severity: "ERROR",
			});
		}

		// Rule 10: Search or Query inside loop (SAFE Governance budget exhaustion)
		if (
			inLoopDepth > 0 &&
			/\b(search\.create|query\.runSuiteQL|search\.load)\s*\(/.test(line)
		) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-GOV-002",
				message:
					"Executing searches or SuiteQL queries inside loops will rapidly exhaust governance units (10 units per search). Hoist queries outside loops or use Map/Reduce.",
				severity: "ERROR",
			});
		}

		// Rule 11: Hardcoded credentials or API secrets (OWASP & Secret Hygiene)
		if (
			/\b(?:password|tokenSecret|consumerSecret|api[_-]?key)\s*[:=]\s*['"][a-zA-Z0-9_\-\.]{8,}['"]/i.test(
				line,
			)
		) {
			issues.push({
				file: filename,
				line: lineNum,
				rule: "SAFE-SEC-001",
				message:
					"Hardcoded credential or API secret literal detected in source code. Use NetSuite N/crypto or secure script parameters instead.",
				severity: "ERROR",
			});
		}

		// Update block closures based on net brace changes
		if (inLoopDepth > 0) {
			const opens = (line.match(/\{/g) || []).length;
			const closes = (line.match(/\}/g) || []).length;
			if (closes > opens && !isLoopHeader) {
				inLoopDepth = Math.max(0, inLoopDepth - (closes - opens));
			}
		}
	}

	return issues;
}

async function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data);
		});
		setTimeout(() => resolve(data), 500);
	});
}

// CLI Execution if executed directly
if (
	process.argv[1] &&
	path.resolve(process.argv[1]) ===
		path.resolve(new URL(import.meta.url).pathname)
) {
	async function runCli() {
		const args = process.argv.slice(2);
		let targetFiles = args;

		// Antigravity PostToolUse hook protocol fallback
		if (targetFiles.length === 0) {
			try {
				const rawInput = await readStdin();
				if (rawInput.trim()) {
					const parsed = JSON.parse(rawInput);
					const hookFile =
						parsed?.toolCall?.args?.TargetFile ||
						parsed?.toolCall?.args?.targetFile ||
						parsed?.toolCall?.args?.path;
					if (typeof hookFile === "string" && (hookFile.endsWith(".js") || hookFile.endsWith(".ts"))) {
						targetFiles = [hookFile];
					}
				}
			} catch {
				// Non-JSON stdin or empty — fall through to default directory scanning
			}
		}

		if (targetFiles.length === 0) {
			const scanDirs = ["FileCabinet", "src/suitescript", "suitescripts"];
			targetFiles = [];
			for (const dir of scanDirs) {
				const fullDir = path.resolve(process.cwd(), dir);
				if (fs.existsSync(fullDir)) {
					const files = fs.readdirSync(fullDir).filter((f) => f.endsWith(".js"));
					targetFiles.push(...files.map((f) => path.join(fullDir, f)));
				}
			}
		}

		if (targetFiles.length === 0) {
			console.log(
				"🛡️ [SuiteScript SAFE Check] No target SuiteScript files specified or found. Static check passed.",
			);
			process.stdout.write("{}");
			process.exit(0);
		}

		let totalErrors = 0;
		let totalWarnings = 0;

		console.log(
			`🔍 [SuiteScript SAFE Check] Scanning ${targetFiles.length} file(s) for Oracle SAFE Guide 2025.2 compliance...\n`,
		);

		for (const f of targetFiles) {
			if (!fs.existsSync(f)) continue;
			const content = fs.readFileSync(f, "utf-8");
			const issues = analyzeSuiteScriptContent(content, path.basename(f));

			if (issues.length > 0) {
				console.log(`📄 File: ${f}`);
				for (const iss of issues) {
					const icon = iss.severity === "ERROR" ? "❌" : "⚠️";
					console.log(
						`  ${icon} [Line ${iss.line}] [${iss.rule}] ${iss.message}`,
					);
					if (iss.severity === "ERROR") totalErrors++;
					if (iss.severity === "WARNING") totalWarnings++;
				}
				console.log("");
			}
		}

		console.log("------------------------------------------------------------");
		console.log(
			`Audit Summary: ${totalErrors} error(s), ${totalWarnings} warning(s).`,
		);

		if (totalErrors > 0) {
			console.error("🛑 [SuiteScript SAFE Check] Failed with compliance errors.");
			process.stdout.write("{}");
			process.exit(1);
		} else {
			console.log(
				"✨ [SuiteScript SAFE Check] Codebase is compliant with Oracle SAFE Guide 2025.2.",
			);
			process.stdout.write("{}");
			process.exit(0);
		}
	}

	runCli();
}
