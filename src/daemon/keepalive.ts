import "../utils/envLoader.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import { RedisLockProvider } from "../cache/redisLock.js";
import type { SessionData } from "../oauth/sessionStorage.js";
import {
	refreshAccessToken,
	shouldRefreshToken,
	TokenRefreshError,
} from "../oauth/tokenExchange.js";
import { formatNetSuiteAccountHost } from "../utils/environment.js";
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
		sessionRoots = [
			path.join(os.homedir(), ".gemini", "antigravity", "sessions"),
		];
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

				let lockId: unknown = null;

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
						`[${accountId}] Needs refresh (expiry in ${Math.round(timeUntilExpiry / 1000)}s, authenticated: ${session.authenticated}). Acquiring lock...`,
					);

					const lockResource = `token_refresh:${formatNetSuiteAccountHost(accountId)}`;
					if (lockProvider) {
						lockId = await lockProvider.acquire(lockResource);
						if (!lockId) {
							logWarn(
								`[${accountId}] Could not acquire Redis lock, skipping this round...`,
							);
							failedAccounts++;
							continue;
						}
					}

					// Re-load under lock
					const lockedContent = await fs.readFile(sessionFile, "utf-8");
					const lockedSession = JSON.parse(lockedContent) as SessionData;

					if (!lockedSession.tokens || !lockedSession.config) {
						skippedAccounts++;
						continue;
					}

					const currentTokens = lockedSession.tokens;
					if (
						!shouldRefreshToken(currentTokens) &&
						lockedSession.authenticated
					) {
						logInfo(
							`[${accountId}] Session refreshed by another process concurrently`,
						);
						skippedAccounts++;
						continue;
					}

					logInfo(`[${accountId}] Refreshing token...`);
					const updatedTokens = await refreshAccessToken(currentTokens);

					// Token Rotation safety: verify refresh_token hasn't been rotated by another process
					const preWriteContent = await fs.readFile(sessionFile, "utf-8");
					const preWriteSession = JSON.parse(preWriteContent) as SessionData;
					if (
						preWriteSession.tokens?.refresh_token !==
						currentTokens.refresh_token
					) {
						logWarn(
							`[${accountId}] Refresh token was rotated by another process during our refresh. Discarding our result to prevent rotation conflict.`,
						);
						skippedAccounts++;
						continue;
					}

					const updatedSession: SessionData & { consecutiveFailures?: number } =
						{
							...lockedSession,
							previous_tokens: lockedSession.tokens,
							tokens: updatedTokens,
							authenticated: true,
							unrecoverable: false,
							consecutiveFailures: 0,
						};

					// Save atomic
					const tempFile = `${sessionFile}.tmp`;
					await fs.writeFile(
						tempFile,
						JSON.stringify(updatedSession, null, 2),
						{ mode: 0o600 },
					);
					await fs.chmod(tempFile, 0o600);
					await fs.rename(tempFile, sessionFile);

					const oldRTFingerprint = currentTokens.refresh_token.slice(-8);
					const newRTFingerprint = updatedTokens.refresh_token
						? String(updatedTokens.refresh_token).slice(-8)
						: "unchanged";
					logInfo(
						`[${accountId}] Token rotation: old_rt=...${oldRTFingerprint} → new_rt=...${newRTFingerprint}`,
					);
					logSuccess(`[${accountId}] Token refreshed successfully!`);
					refreshedAccounts++;
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					logError(
						`[${accountId}] Failed during refresh operation: ${message}`,
					);
					failedAccounts++;
					// If refresh token has an unrecoverable response, track consecutive failures
					try {
						const isUnrecoverable =
							(err instanceof TokenRefreshError && !err.recoverable) ||
							message.includes("Unrecoverable");
						if (isUnrecoverable) {
							const fileContent = await fs.readFile(sessionFile, "utf-8");
							const session = JSON.parse(fileContent) as SessionData & {
								consecutiveFailures?: number;
							};
							const failures = (session.consecutiveFailures ?? 0) + 1;
							session.authenticated = false;
							session.consecutiveFailures = failures;
							// Only mark unrecoverable after 5 consecutive failures (~50 minutes)
							session.unrecoverable = failures >= 5;
							await fs.writeFile(
								sessionFile,
								JSON.stringify(session, null, 2),
								{ mode: 0o600 },
							);
							if (session.unrecoverable) {
								logWarn(
									`[${accountId}] Session marked unrecoverable after ${failures} consecutive failed refresh attempts.`,
								);
							} else {
								logWarn(
									`[${accountId}] Session marked unauthenticated (${failures}/5 failed attempts). Will retry next scan.`,
								);
							}
						}
					} catch {
						// Ignore sub-errors
					}
				} finally {
					if (lockId && lockProvider) {
						await lockProvider.release(lockId);
						lockId = null;
					}
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
