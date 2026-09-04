#!/usr/bin/env node

import "../src/utils/envLoader.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuthManager } from "../src/oauth/manager.js";
import { resolveSessionPath } from "../src/utils/config.js";
import { getKnownClientId } from "../src/utils/constants.js";
import { getDefaultSessionsDir } from "../src/utils/environment.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

interface AccountConfig {
	accountId: string;
	clientId: string;
	sessionPath: string;
	callbackPort: number;
	authenticated?: boolean;
	tokenExpiresIn?: number;
}

const DEFAULT_CALLBACK_PORTS: Record<string, number> = {
	"5848789": 8080,
	"5848789-sb1": 8081,
	"5848789_sb1": 8081,
	"9260916": 8082,
	"9260916-sb1": 8083,
	"9260916_sb1": 8083,
	"9260916-sb3": 8084,
	"9260916_sb3": 8084,
};

async function discoverAccounts(): Promise<AccountConfig[]> {
	const accounts: Map<string, AccountConfig> = new Map();

	// 1. Discover from workspace-agents/workspaces.json
	const workspacesFile = path.join(
		projectRoot,
		"workspace-agents",
		"workspaces.json",
	);
	try {
		const raw = await fs.readFile(workspacesFile, "utf-8");
		const data = JSON.parse(raw);
		if (Array.isArray(data.workspaces)) {
			for (const ws of data.workspaces) {
				const accId = String(ws.accountId || "").trim();
				if (!accId) continue;
				const normKey = accId.toLowerCase().replace(/_/g, "-");
				const sessionDir = resolveSessionPath(accId);
				const clientId = getKnownClientId(accId) || "";
				const callbackPort =
					DEFAULT_CALLBACK_PORTS[normKey] ||
					DEFAULT_CALLBACK_PORTS[accId] ||
					8080;
				accounts.set(normKey, {
					accountId: accId,
					clientId,
					sessionPath: sessionDir,
					callbackPort,
				});
			}
		}
	} catch {
		// workspaces.json not found or unreadable
	}

	// 2. Discover from session directories
	const sessionRoots = [
		process.env.NETSUITE_SESSION_PATH,
		process.env.DAEMON_SESSION_ROOTS,
		getDefaultSessionsDir(),
	].filter(Boolean) as string[];

	for (const root of sessionRoots) {
		try {
			await fs.access(root);
			const entries = await fs.readdir(root, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory());

			for (const dir of dirs) {
				const dirName = dir.name;
				const normKey = dirName.toLowerCase().replace(/_/g, "-");
				const sessionDir = path.join(root, dirName);
				const sessionFile = path.join(sessionDir, "session.json");

				let storedAccId = dirName;
				let storedClientId = "";
				let isAuthenticated = false;
				let tokenExpiresIn = 0;

				try {
					const content = await fs.readFile(sessionFile, "utf-8");
					const session = JSON.parse(content);
					if (session?.config?.accountId) {
						storedAccId = session.config.accountId;
					}
					if (
						session?.config?.clientId &&
						session.config.clientId !== "my-client-id" &&
						session.config.clientId !== "default_client_id"
					) {
						storedClientId = session.config.clientId;
					}
					if (
						session?.tokens?.clientId &&
						session.tokens.clientId !== "my-client-id" &&
						session.tokens.clientId !== "default_client_id"
					) {
						storedClientId = session.tokens.clientId;
					}
					if (session?.authenticated && session?.tokens) {
						isAuthenticated = true;
						tokenExpiresIn = Math.max(
							0,
							Math.round((session.tokens.expires_at - Date.now()) / 1000),
						);
					}
				} catch {
					// Ignore unreadable session files
				}

				const existing = accounts.get(normKey);
				const clientId =
					storedClientId ||
					getKnownClientId(storedAccId) ||
					existing?.clientId ||
					"";
				const callbackPort =
					existing?.callbackPort ||
					DEFAULT_CALLBACK_PORTS[normKey] ||
					DEFAULT_CALLBACK_PORTS[storedAccId] ||
					8080;

				accounts.set(normKey, {
					accountId: existing?.accountId || storedAccId,
					clientId,
					sessionPath: sessionDir,
					callbackPort,
					authenticated: isAuthenticated,
					tokenExpiresIn,
				});
			}
		} catch {
			// Ignore unreadable root
		}
	}

	return Array.from(accounts.values());
}

async function main() {
	const args = process.argv.slice(2);
	const forceAll =
		args.includes("--all") || args.includes("--force") || args.includes("-f");
	const targetFilter = args
		.filter((a) => !a.startsWith("-"))
		.map((a) => a.toLowerCase().replace(/_/g, "-"));

	console.log("\n🔍 正在扫描 NetSuite 账号授权状态...");
	let allAccounts = await discoverAccounts();

	if (allAccounts.length === 0) {
		console.error(
			"❌ 未找到任何 NetSuite 账号配置。请检查 .env 或 session 目录。",
		);
		process.exit(1);
	}

	if (targetFilter.length > 0) {
		allAccounts = allAccounts.filter((a) => {
			const norm = a.accountId.toLowerCase().replace(/_/g, "-");
			return targetFilter.some((tf) => norm.includes(tf));
		});
		if (allAccounts.length === 0) {
			console.error(
				`❌ 未找到匹配指定筛选条件的账号: ${targetFilter.join(", ")}`,
			);
			process.exit(1);
		}
	}

	console.log(`\n📋 扫描到 ${allAccounts.length} 个 NetSuite 账号配置：`);
	for (const acc of allAccounts) {
		const statusText = acc.authenticated
			? `🟢 已授权 (Token 剩余 ${acc.tokenExpiresIn}s)`
			: `🔴 未授权 / 已掉线`;
		console.log(`   • [${acc.accountId.toUpperCase()}] ${statusText}`);
	}
	console.log("");

	const accountsToAuth = forceAll
		? allAccounts
		: allAccounts.filter((a) => !a.authenticated);

	if (accountsToAuth.length === 0) {
		console.log("✨ 所有账号均已处于有效授权状态！无需重复登录。");
		console.log(
			"💡 若需强制重新授权全部账号，请附加参数: npx tsx scripts/bulk-auth.ts --force\n",
		);
		return;
	}

	console.log(
		`🚀 即将开始对 ${accountsToAuth.length} 个账号进行浏览器 OAuth 2.0 登录授权...\n`,
	);

	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < accountsToAuth.length; i++) {
		const acc = accountsToAuth[i];
		console.log(
			"======================================================================",
		);
		console.log(
			`🔑 [${i + 1}/${accountsToAuth.length}] 正在为账号 [${acc.accountId.toUpperCase()}] 发起授权...`,
		);
		console.log(`   Session 存储路径: ${acc.sessionPath}`);
		console.log(`   Callback 端口: ${acc.callbackPort}`);

		if (!acc.clientId) {
			console.error(
				`❌ 错误: 未找到该账号对应的 Client ID，请在 .env 中配置 NETSUITE_CLIENT_ID_${acc.accountId.toUpperCase().replace(/-/g, "_")}`,
			);
			failCount++;
			continue;
		}

		const oauthManager = new OAuthManager({
			storagePath: acc.sessionPath,
			callbackPort: acc.callbackPort,
		});

		try {
			await oauthManager.startAuthFlow({
				accountId: acc.accountId,
				clientId: acc.clientId,
			});
			console.log(`✅ [${acc.accountId.toUpperCase()}] 授权成功！\n`);
			successCount++;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`❌ [${acc.accountId.toUpperCase()}] 授权失败: ${msg}\n`);
			failCount++;
		}
	}

	console.log(
		"======================================================================",
	);
	console.log(`🎉 批量授权完成！`);
	console.log(`   ✅ 成功: ${successCount} 个`);
	console.log(`   ❌ 失败: ${failCount} 个`);
	console.log(
		"======================================================================\n",
	);
}

main().catch((err) => {
	console.error("Fatal error during bulk authentication:", err);
	process.exit(1);
});
