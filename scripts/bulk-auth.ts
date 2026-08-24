#!/usr/bin/env node

import "../src/utils/envLoader.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OAuthManager } from "../src/oauth/manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

interface AccountConfig {
	accountId: string;
	clientId: string;
	sessionPath: string;
}

async function discoverAccounts(): Promise<AccountConfig[]> {
	const sessionRoots = [
		process.env.NETSUITE_SESSION_PATH,
		process.env.DAEMON_SESSION_ROOTS,
		path.join(os.homedir(), ".gemini", "antigravity", "sessions"),
		path.join(projectRoot, "sessions"),
	].filter(Boolean) as string[];

	const accounts: AccountConfig[] = [];
	const seenAccountIds = new Set<string>();

	for (const root of sessionRoots) {
		try {
			await fs.access(root);
			const entries = await fs.readdir(root, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory());

			for (const dir of dirs) {
				const accountId = dir.name;
				if (seenAccountIds.has(accountId)) continue;

				const sessionDir = path.join(root, accountId);
				const sessionFile = path.join(sessionDir, "session.json");

				try {
					const content = await fs.readFile(sessionFile, "utf-8");
					const session = JSON.parse(content);

					if (session?.config?.accountId && session?.config?.clientId) {
						accounts.push({
							accountId: session.config.accountId,
							clientId: session.config.clientId,
							sessionPath: sessionDir,
						});
						seenAccountIds.add(accountId);
					}
				} catch {
					// Ignore invalid or missing session files
				}
			}
		} catch {
			// Ignore unreadable roots
		}
	}

	return accounts;
}

async function main() {
	console.log("\n🔍 Scanning for previously authenticated NetSuite accounts...");
	const accounts = await discoverAccounts();

	if (accounts.length === 0) {
		console.log(
			"❌ No previously authenticated accounts found. You must authenticate at least once manually via Cursor/Claude to generate the initial configuration.",
		);
		process.exit(1);
	}

	console.log(
		`✅ Found ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}\n`,
	);

	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < accounts.length; i++) {
		const { accountId, clientId, sessionPath } = accounts[i];
		console.log(
			`==================================================\n🚀 [${i + 1}/${accounts.length}] Authenticating: ${accountId}`,
		);

		const oauthManager = new OAuthManager({
			storagePath: sessionPath,
			callbackPort: parseInt(process.env.OAUTH_CALLBACK_PORT || "8080", 10),
		});

		try {
			// This will start the callback server, open the browser, and block until the user finishes
			await oauthManager.startAuthFlow({ accountId, clientId });
			console.log(`✅ Successfully authenticated ${accountId}!\n`);
			successCount++;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`❌ Failed to authenticate ${accountId}: ${message}\n`);
			failCount++;
		}
	}

	console.log("==================================================");
	console.log(`🎉 Batch Authentication Complete!`);
	console.log(`   Successful: ${successCount}`);
	console.log(`   Failed:     ${failCount}`);
	console.log("==================================================\n");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
