#!/usr/bin/env node
/**
 * post-tool-sync.js — Antigravity PostToolUse lifecycle hook.
 *
 * Automatically triggers `node scripts/sync-agents.js --push` whenever
 * files under `workspace-agents/` are modified by agent tool calls.
 * Adheres strictly to the PostToolUse contract by returning `{}` to stdout.
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

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
		// Non-blocking timeout if stdin is not piped
		setTimeout(() => resolve(data), 500);
	});
}

async function main() {
	try {
		const rawInput = await readStdin();
		let targetFile = "";
		if (rawInput.trim()) {
			try {
				const parsed = JSON.parse(rawInput);
				targetFile = parsed?.toolCall?.args?.TargetFile || "";
			} catch {
				// Ignore JSON parse error
			}
		}

		let shouldSync = false;
		if (targetFile) {
			const normalized = targetFile.replace(/\\/g, "/");
			if (
				normalized.includes("/workspace-agents/") ||
				normalized.endsWith("AGENTS.template.md")
			) {
				shouldSync = true;
			}
		} else {
			// Fallback: check git status of workspace-agents/
			try {
				const status = execSync("git status --porcelain workspace-agents/", {
					cwd: projectRoot,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				});
				if (status.trim().length > 0) {
					shouldSync = true;
				}
			} catch {
				// Non-fatal
			}
		}

		if (shouldSync) {
			console.error(
				"\n🔄 [Antigravity Hook] 检测到 workspace-agents 变动，自动同步并推送到各环境远端...",
			);
			execSync("node scripts/sync-agents.js --push", {
				cwd: projectRoot,
				stdio: "inherit",
			});
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`⚠️ [Antigravity Hook Warning]: ${message}`);
	} finally {
		// PostToolUse contract strictly requires an empty JSON object on stdout
		process.stdout.write("{}\n");
		process.exit(0);
	}
}

main();
