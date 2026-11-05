#!/usr/bin/env node

/**
 * check-skills-update.mjs
 *
 * 检查并同步 Oracle 官方 NetSuite Agent Skills (oracle/netsuite-suitecloud-sdk)
 *
 * 用法:
 *   node scripts/check-skills-update.mjs          # 仅检查是否有新更新
 *   node scripts/check-skills-update.mjs --sync   # 检查并同步最新 skills
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const localSkillsDir = path.join(projectRoot, "skills");

const GITHUB_API_URL =
	"https://api.github.com/repos/oracle/netsuite-suitecloud-sdk/commits?path=packages/agent-skills&per_page=1";
const REPO_URL = "https://github.com/oracle/netsuite-suitecloud-sdk.git";

async function checkLatestCommit() {
	try {
		const res = await fetch(GITHUB_API_URL, {
			headers: { "User-Agent": "Antigravity-Skills-Checker" },
		});
		if (!res.ok) {
			throw new Error(`GitHub API HTTP ${res.status}: ${res.statusText}`);
		}
		const data = await res.json();
		if (Array.isArray(data) && data.length > 0) {
			const latest = data[0];
			return {
				sha: latest.sha.substring(0, 7),
				fullSha: latest.sha,
				date: latest.commit.committer.date,
				message: latest.commit.message.split("\n")[0],
				author: latest.commit.author.name,
			};
		}
	} catch (err) {
		console.warn("⚠️ 无法直接访问 GitHub API，尝试通过本地 git 获取信息...");
	}
	return null;
}

async function main() {
	const shouldSync = process.argv.includes("--sync");

	console.log("🔍 正在检查 Oracle 官方 NetSuite Agent Skills 最新动态...\n");
	const info = await checkLatestCommit();

	if (info) {
		console.log(`📌 官方仓库最新相关提交:`);
		console.log(`   - Commit:  ${info.sha}`);
		console.log(`   - 日期:    ${info.date}`);
		console.log(`   - 提交人:  ${info.author}`);
		console.log(`   - 说明:    ${info.message}\n`);
	}

	if (!shouldSync) {
		console.log("💡 提示: 若需要拉取最新内容覆盖同步，请执行: npm run skills:update\n");
		return;
	}

	console.log("📥 开始同步官方最新 skills...");
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-sdk-"));
	try {
		execSync(`git clone --depth 1 ${REPO_URL} "${tempDir}"`, {
			stdio: "pipe",
		});
		const sourceDir = path.join(tempDir, "packages", "agent-skills");
		if (!fs.existsSync(sourceDir)) {
			throw new Error(`未找到 agent-skills 目录: ${sourceDir}`);
		}

		const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
		let updatedCount = 0;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillName = entry.name;
			const srcSkillPath = path.join(sourceDir, skillName);
			const destSkillPath = path.join(localSkillsDir, skillName);

			fs.cpSync(srcSkillPath, destSkillPath, { recursive: true });
			updatedCount++;
		}

		console.log(`✅ 成功同步 ${updatedCount} 个 NetSuite 官方技能到 skills/ 目录！\n`);
	} catch (err) {
		console.error("❌ 同步失败:", err.message);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

main();
