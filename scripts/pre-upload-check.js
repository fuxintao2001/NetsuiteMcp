#!/usr/bin/env node
/**
 * pre-upload-check.js — Antigravity PreToolUse safety gate.
 *
 * Verifies code syntax and blocks accidental deployment of sensitive files.
 * Usage:
 *   node scripts/pre-upload-check.js [filePath1] [filePath2] ...
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sensitivePatterns = [
	/\.env(\..+)?$/i,
	/id_rsa/i,
	/\.pem$/i,
	/session(\..+)?\.json$/i,
	/credentials/i,
	/secrets?/i,
	/token.*\.json$/i,
];

const filesToCheck = process.argv.slice(2);

if (filesToCheck.length === 0) {
	// Standalone test run
	console.log(
		"🛡️ [Pre-Upload Check] No target files passed; performing general environment sanity check...",
	);
	const sensitiveInRoot = fs
		.readdirSync(process.cwd())
		.filter(
			(f) => sensitivePatterns.some((p) => p.test(f)) && f !== ".env.example",
		);

	if (sensitiveInRoot.length > 0) {
		console.log(
			`ℹ️ [Pre-Upload Check] Local sensitive files detected (protected from deployment): ${sensitiveInRoot.join(", ")}`,
		);
	}
	console.log("✅ [Pre-Upload Check] General sanity check passed.");
	process.exit(0);
}

let hasErrors = false;

for (const rawFile of filesToCheck) {
	const filePath = path.resolve(rawFile);
	const base = path.basename(filePath);

	// 1. Sensitive file check
	if (sensitivePatterns.some((p) => p.test(base))) {
		console.error(
			`🚨 [Security Hard-Stop] Attempted to deploy sensitive/credential file: ${filePath}`,
		);
		hasErrors = true;
		continue;
	}

	if (!fs.existsSync(filePath)) {
		console.warn(
			`⚠️ [Pre-Upload Check] Target file does not exist: ${filePath}`,
		);
		continue;
	}

	// 2. Syntax check for JavaScript files
	if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
		try {
			execSync(`node --check "${filePath}"`, { stdio: "pipe" });
		} catch (err) {
			console.error(
				`❌ [Syntax Error] Invalid JavaScript in ${filePath}:`,
				err.message,
			);
			hasErrors = true;
		}
	}
}

if (hasErrors) {
	console.error(
		"🛑 [Pre-Upload Check] Safety check failed. Deployment blocked.",
	);
	process.exit(1);
}

console.log(
	"✅ [Pre-Upload Check] All target files passed pre-flight security and syntax checks.",
);
process.exit(0);
