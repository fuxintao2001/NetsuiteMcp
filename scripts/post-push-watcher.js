#!/usr/bin/env node

/**
 * post-push-watcher.js — Background daemon spawned by Git pre-push hook.
 *
 * Monitors the parent `git push` process. Once `git push` finishes successfully,
 * clears old error logs (logs/*.jsonl and logs/reports/*.md) because code is updated.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import { cleanErrorLogs } from "./clean-error-logs.js";

async function main() {
	const rawPpid = process.argv[2];
	const remote = process.argv[3] || "origin";
	const _remoteUrl = process.argv[4] || "";
	const refsInput = process.argv[5] || "";

	const ppid = Number.parseInt(rawPpid, 10);
	if (!ppid || Number.isNaN(ppid)) {
		return;
	}

	// 1. Wait for parent `git push` process to exit
	const startTime = Date.now();
	const MAX_WAIT_MS = 120_000; // 2 minutes max

	while (Date.now() - startTime < MAX_WAIT_MS) {
		let isAlive = false;
		try {
			process.kill(ppid, 0);
			isAlive = true;
		} catch {
			isAlive = false;
		}

		if (!isAlive) {
			break;
		}

		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	// 2. Small grace period for git to finish updating remote refs on disk
	await new Promise((resolve) => setTimeout(resolve, 350));

	// 3. Verify whether push succeeded by checking local tracking refs
	const lines = refsInput.trim().split("\n").filter(Boolean);
	if (lines.length === 0) {
		return;
	}

	let pushSucceeded = false;

	for (const line of lines) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue;
		const [_localRef, localSha, remoteRef, remoteSha] = parts;

		// Deleting a remote branch
		if (/^0+$/.test(localSha)) {
			pushSucceeded = true;
			break;
		}

		// If no commits changed between local and remote sha
		if (localSha === remoteSha) {
			continue;
		}

		// Inspect target branch
		const branchMatch = remoteRef.match(/^refs\/heads\/(.+)$/);
		if (branchMatch?.[1]) {
			const branch = branchMatch[1];
			try {
				const currentRemoteSha = execSync(
					`git rev-parse refs/remotes/${remote}/${branch}`,
					{ encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
				).trim();

				if (currentRemoteSha === localSha) {
					pushSucceeded = true;
					break;
				}
			} catch {
				// Tracking ref might not have been created or push was aborted
			}
		} else {
			// Tag or custom ref
			pushSucceeded = true;
			break;
		}
	}

	// 4. If push succeeded, clear error logs
	if (pushSucceeded) {
		const { deletedCount } = cleanErrorLogs({ silent: true });

		const notifyMsg =
			deletedCount > 0
				? `\n🧹 [Git Hook: post-push] 远程代码推送成功，已清空历史错误日志 (${deletedCount} 个日志文件)\n`
				: "\n✨ [Git Hook: post-push] 远程代码推送成功，错误日志目录无需清理\n";

		try {
			if (fs.existsSync("/dev/tty")) {
				fs.appendFileSync("/dev/tty", notifyMsg);
			} else {
				console.log(notifyMsg);
			}
		} catch {
			console.log(notifyMsg);
		}
	}
}

main().catch(() => {
	// Silent exit on background watcher error
	process.exit(0);
});
