import "../utils/envLoader.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import { RedisLockProvider } from "../cache/redisLock.js";
import { OAuthManager } from "../oauth/manager.js";
import type { SessionData } from "../oauth/sessionStorage.js";
import { shouldRefreshToken } from "../oauth/tokenExchange.js";
import {
	getDefaultConfigDir,
	getDefaultSessionsDir,
} from "../utils/environment.js";
import {
	checkNetworkReadiness,
	isUserActiveOnMacOS,
} from "../utils/resilience.js";

/**
 * Helper to get ISO timestamp for logs
 */
function getTimestamp(): string {
	return new Date().toISOString();
}

/**
 * Log message helper
 */
function logInfo(msg: string) {
	console.error(`[${getTimestamp()}] 🔄 [Keepalive] ${msg}`);
}

function logSuccess(msg: string) {
	console.error(`[${getTimestamp()}] ✅ [Keepalive] ${msg}`);
}

function logWarn(msg: string) {
	console.error(`[${getTimestamp()}] ⚠️  [Keepalive] ${msg}`);
}

function logError(msg: string) {
	console.error(`[${getTimestamp()}] ❌ [Keepalive] ${msg}`);
}

/**
 * Scans directories and runs the keepalive daemon logic once
 */
export async function runKeepAlive(): Promise<void> {
	logInfo("Starting token keepalive execution scan...");

	// macOS Sleep / DarkWake guard:
	// If the user is not actively using macOS (lid closed, sleeping, or DarkWake maintenance),
	// skip the entire keepalive scan. This protects the 7~30 day refresh token from being rotated
	// during a severed socket or imminent sleep.
	const userActive = await isUserActiveOnMacOS();
	if (!userActive) {
		logInfo(
			"macOS is in sleep / DarkWake mode (UserIsActive = 0). Skipping keepalive scan to protect refresh tokens.",
		);
		return;
	}

	// Wait for network readiness (especially critical immediately after wake from sleep)
	// Skip during unit tests to avoid DNS lookup timeout when testing local file processing
	if (
		!process.env.DAEMON_SESSION_ROOTS &&
		!process.env.JEST_WORKER_ID &&
		process.env.NODE_ENV !== "test"
	) {
		if (!(await checkNetworkReadiness())) {
			logWarn(
				"Network not ready right after wake/startup. Waiting 10s for Wi-Fi/TLS stabilization...",
			);
			await new Promise((resolve) => setTimeout(resolve, 10000));
			if (!(await checkNetworkReadiness())) {
				logError(
					"Network still unreachable after wait. Aborting keepalive scan to prevent token rotation mismatches.",
				);
				return;
			} else {
				logSuccess("Network stabilized!");
			}
		}
	}

	// Connect to Redis for distributed locking
	const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
	const redis = new Redis(redisUrl, {
		lazyConnect: true,
		maxRetriesPerRequest: 1,
	});
	redis.on("error", (err) => {
		// Log warning to prevent unhandled error event when Redis daemon is absent
		logWarn(`Redis background error: ${err.message}`);
	});
	let lockProvider: RedisLockProvider | null = null;
	try {
		await redis.connect();
		lockProvider = new RedisLockProvider(redis);
		logInfo("Redis connected for distributed locking");
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		logWarn(`Redis connection failed: ${message}.`);
	}

	let sessionRoots: string[] = [];
	if (process.env.DAEMON_SESSION_ROOTS) {
		sessionRoots = process.env.DAEMON_SESSION_ROOTS.split(",").map((p) =>
			p.trim(),
		);
	} else {
		const candidateRoots = [
			getDefaultSessionsDir(),
			path.join(getDefaultConfigDir(), "sessions"),
			path.join(os.homedir(), ".gemini", "antigravity", "sessions"),
		];
		sessionRoots = Array.from(new Set(candidateRoots));
	}

	let totalAccounts = 0;
	let refreshedAccounts = 0;
	let skippedAccounts = 0;
	let failedAccounts = 0;

	for (const root of sessionRoots) {
		try {
			const entries = await fs.readdir(root, { withFileTypes: true });
			const dirs = entries.filter((e) => e.isDirectory());

			for (const dir of dirs) {
				const accountId = dir.name;
				const sessionDir = path.join(root, accountId);
				const sessionFile = path.join(sessionDir, "session.json");

				try {
					await fs.access(sessionFile);
				} catch {
					// No session file, skip
					continue;
				}

				totalAccounts++;

				// Check if an active MCP Server process is running and actively maintaining this session via heartbeat
				const heartbeatFile = path.join(sessionDir, "session.heartbeat");
				try {
					const hbContent = await fs.readFile(heartbeatFile, "utf-8");
					const lastBeat = parseInt(hbContent.trim(), 10);
					if (!Number.isNaN(lastBeat) && Date.now() - lastBeat < 180000) {
						logInfo(
							`[${accountId}] Skipped (actively managed by running MCP server via heartbeat)`,
						);
						skippedAccounts++;
						continue;
					}
				} catch {
					// No heartbeat file or error reading, proceed with keepalive scan
				}

				try {
					// Read session file (unlocked read for quick check)
					const content = await fs.readFile(sessionFile, "utf-8");
					const session = JSON.parse(content) as SessionData;

					if (
						!session.tokens ||
						!session.config ||
						!session.tokens.refresh_token
					) {
						logInfo(
							`[${accountId}] Skipped (no tokens or credentials in session file)`,
						);
						skippedAccounts++;
						continue;
					}

					// If session is marked unrecoverable (e.g. invalid_grant), skip automatic keepalive to avoid hammering NetSuite
					if (session.unrecoverable) {
						logInfo(
							`[${accountId}] Skipped (session is unrecoverable, requires manual re-authentication via netsuite_auth)`,
						);
						skippedAccounts++;
						continue;
					}

					// Check if token needs refresh (< 75% lifetime remaining), or if authenticated is false
					const tokens = session.tokens;
					const timeUntilExpiry = tokens.expires_at - Date.now();
					const needsRefresh =
						shouldRefreshToken(tokens) || !session.authenticated;

					if (!needsRefresh) {
						const timeStr = Math.round(timeUntilExpiry / 1000);
						logInfo(
							`[${accountId}] Skipped (token is still fresh, expires in ${timeStr}s)`,
						);
						skippedAccounts++;
						continue;
					}

					logInfo(
						`[${accountId}] Needs refresh (expiry in ${Math.round(timeUntilExpiry / 1000)}s, authenticated: ${session.authenticated}). Refreshing token...`,
					);

					// Reuse OAuthManager for robust lock handling, rotation validation, and unrecoverable error marking
					const manager = new OAuthManager({ storagePath: sessionDir });
					if (lockProvider) {
						manager.setLockProvider(lockProvider);
					}

					await manager.ensureValidToken({ allowInteractive: false });
					logSuccess(`[${accountId}] Token refreshed successfully!`);
					refreshedAccounts++;
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					logError(
						`[${accountId}] Failed during refresh operation: ${message}`,
					);
					failedAccounts++;
				}
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			logError(`Failed to scan root directory "${root}": ${message}`);
		}
	}

	logInfo(
		`Keepalive scan finished. Accounts: ${totalAccounts} total | ${refreshedAccounts} refreshed | ${skippedAccounts} skipped | ${failedAccounts} failed.`,
	);

	// Cleanup Redis connection
	if (redis.status === "ready") {
		try {
			await redis.quit();
		} catch {
			// Ignore cleanup errors
		}
	}
}

// Execute if run directly
const nodePath = process.argv[1];
if (
	nodePath &&
	(nodePath.endsWith("keepalive.js") || nodePath.endsWith("keepalive.ts"))
) {
	void runKeepAlive();
}
