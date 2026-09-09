#!/usr/bin/env node
/**
 * watch-agents.js — Watches workspace-agents/ directory for changes,
 * debouncing and auto-executing `npm run sync:push`.
 *
 * Usage:
 *   npm run watch:agents
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);
const watchDir = path.join(projectRoot, "workspace-agents");

console.log(`👀 [Watch Agents] 正在监听目录: ${watchDir}`);
console.log("💡 每次保存文件后，将自动执行同步并推送到各环境远程仓库 (防抖 2 秒)...\n");

let timeoutId = null;
let isSyncing = false;

function triggerSync(filename) {
	if (timeoutId) {
		clearTimeout(timeoutId);
	}
	timeoutId = setTimeout(() => {
		if (isSyncing) return;
		isSyncing = true;
		console.log(`\n🔔 检测到变更 [${filename}]，开始执行自动同步与推送...`);
		try {
			execSync("node scripts/sync-agents.js --push", {
				cwd: projectRoot,
				stdio: "inherit",
			});
			console.log("✅ 自动同步与推送完成！\n");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`❌ 同步失败: ${message}\n`);
		} finally {
			isSyncing = false;
		}
	}, 2000);
}

try {
	fs.watch(watchDir, { recursive: true }, (_eventType, filename) => {
		if (!filename) return;
		// Ignore temporary swap files or hidden files
		if (
			filename.startsWith(".") ||
			filename.endsWith("~") ||
			filename.includes(".tmp")
		) {
			return;
		}
		triggerSync(filename);
	});
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`❌ 无法监听目录 ${watchDir}: ${message}`);
	process.exit(1);
}
