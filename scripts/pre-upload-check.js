#!/usr/bin/env node
/**
 * pre-upload-check.js — Antigravity PreToolUse safety gate.
 *
 * Verifies code syntax and blocks accidental upload of sensitive files.
 * Adheres strictly to the Antigravity PreToolUse hook contract:
 * - stdin:  { toolCall: { name: "netsuite_upload_file", args: { paths: ... } } }
 * - stdout: { "decision": "allow" } | { "decision": "deny", "reason": "..." }
 * - stderr: Human-readable diagnostic and audit logs
 *
 * Usage:
 *   node scripts/pre-upload-check.js [filePath1] [filePath2] ...
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const sensitivePatterns = [
	/\.env(\..+)?$/i,
	/id_rsa/i,
	/\.pem$/i,
	/session(\..+)?\.json$/i,
	/credentials/i,
	/secrets?/i,
	/token.*\.json$/i,
];

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

async function main() {
	let filesToCheck = process.argv.slice(2);
	let isHookMode = false;

	// Antigravity hook protocol: parse stdin for toolCall.args.paths
	if (filesToCheck.length === 0) {
		try {
			const rawInput = await readStdin();
			if (rawInput.trim()) {
				const parsed = JSON.parse(rawInput);
				if (parsed?.toolCall || parsed?.stepIdx !== undefined) {
					isHookMode = true;
				}
				const paths =
					parsed?.toolCall?.args?.paths ||
					parsed?.toolCall?.args?.filePaths ||
					[];
				if (Array.isArray(paths) && paths.length > 0) {
					filesToCheck = paths;
				} else if (typeof parsed?.toolCall?.args?.paths === "string") {
					filesToCheck = [parsed.toolCall.args.paths];
				} else if (typeof parsed?.toolCall?.args?.path === "string") {
					filesToCheck = [parsed.toolCall.args.path];
				}
			}
		} catch {
			// stdin not JSON or not available — fall through to standalone mode
		}
	}

	if (filesToCheck.length === 0) {
		console.error(
			"🛡️ [Pre-Upload Check] No target files passed; performing general environment sanity check...",
		);
		const sensitiveInRoot = fs
			.readdirSync(process.cwd())
			.filter(
				(f) => sensitivePatterns.some((p) => p.test(f)) && f !== ".env.example",
			);

		if (sensitiveInRoot.length > 0) {
			console.error(
				`ℹ️ [Pre-Upload Check] Local sensitive files detected (protected from upload): ${sensitiveInRoot.join(", ")}`,
			);
		}
		console.error("✅ [Pre-Upload Check] General sanity check passed.");
		if (isHookMode) {
			process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
		}
		process.exit(0);
	}

	const errors = [];

	for (const rawFile of filesToCheck) {
		const filePath = path.resolve(rawFile);
		const base = path.basename(filePath);

		// 1. Sensitive file check
		if (sensitivePatterns.some((p) => p.test(base))) {
			const errMsg = `🚨 [Security Hard-Stop] Attempted to upload sensitive/credential file: ${filePath}`;
			console.error(errMsg);
			errors.push(errMsg);
			continue;
		}

		if (!fs.existsSync(filePath)) {
			console.error(
				`⚠️ [Pre-Upload Check] Target file does not exist: ${filePath}`,
			);
			continue;
		}

		// 2. Syntax check for JavaScript files
		if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
			try {
				execSync(`node --check "${filePath}"`, { stdio: "pipe" });
			} catch (err) {
				const errMsg = `❌ [Syntax Error] Invalid JavaScript in ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
				console.error(errMsg);
				errors.push(errMsg);
			}
		}

		// 3. SuiteCloud SDF project structure check (if file belongs to an SDF project)
		let currentDir = path.dirname(filePath);
		for (let i = 0; i < 4; i++) {
			const manifestCandidate = path.join(currentDir, "manifest.xml");
			if (fs.existsSync(manifestCandidate)) {
				try {
					const manifestXml = fs.readFileSync(manifestCandidate, "utf-8");
					if (!manifestXml.includes("<manifest") || !manifestXml.includes("</manifest>")) {
						const errMsg = `❌ [SDF Validation Error] Malformed manifest.xml detected at ${manifestCandidate}. Missing root <manifest> tag.`;
						console.error(errMsg);
						errors.push(errMsg);
					}
				} catch (err) {
					const errMsg = `❌ [SDF Validation Error] Unable to read manifest.xml at ${manifestCandidate}: ${err instanceof Error ? err.message : String(err)}`;
					console.error(errMsg);
					errors.push(errMsg);
				}
				break;
			}
			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}

	if (errors.length > 0) {
		console.error(
			"🛑 [Pre-Upload Check] Safety check failed. Upload blocked.",
		);
		if (isHookMode) {
			process.stdout.write(
				JSON.stringify({
					decision: "deny",
					reason: errors.join("\n"),
				}) + "\n",
			);
			process.exit(0);
		} else {
			process.exit(1);
		}
	}

	console.error(
		"✅ [Pre-Upload Check] All target files passed pre-flight security and syntax checks.",
	);
	if (isHookMode) {
		process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
	}
	process.exit(0);
}

main();
