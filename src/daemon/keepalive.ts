import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Redis } from "ioredis";
import { shouldRefreshToken } from "../oauth/tokenExchange.js";
import { RedisLockProvider } from "../utils/redisLock.js";

export interface TokenData {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	expires_at: number;
	accountId: string;
	clientId: string;
}

export interface SessionData {
	pkce?: string | null;
	state?: string;
	config?: {
		accountId: string;
		clientId: string;
		redirectUri: string;
	};
	tokens?: TokenData;
	timestamp?: number;
	authenticated?: boolean;
}

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
 * Format NetSuite Account ID to API host format (e.g. 9260916_SB1 -> 9260916-sb1)
 */
function formatNetSuiteAccountHost(accountId: string): string {
	return accountId.toLowerCase().replace(/_/g, "-");
}

/**
 * Checks if basic network connectivity is up by resolving a well-known NetSuite API hostname.
 * Prevents firing token requests right as macOS wakes up from sleep when Wi-Fi/TLS socket is not yet ready.
 */
async function checkNetworkReadiness(timeoutMs = 5000): Promise<boolean> {
	try {
		await lookup("suitetalk.api.netsuite.com");
		return await new Promise<boolean>((resolve) => {
			const req = https.request(
				{
					hostname: "suitetalk.api.netsuite.com",
					port: 443,
					method: "HEAD",
					timeout: timeoutMs,
				},
				() => {
					resolve(true);
				},
			);
			req.on("error", () => resolve(false));
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
			req.end();
		});
	} catch {
		return false;
	}
}

/**
 * File lock acquisition
 */
async function acquireLock(
	lockPath: string,
	timeoutMs = 25000,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			await fs.mkdir(lockPath);
			return true;
		} catch (err: unknown) {
			const nodeErr = err as { code?: string };
			if (nodeErr.code === "EEXIST") {
				try {
					const stats = await fs.stat(lockPath);
					const age = Date.now() - stats.mtimeMs;
					if (age > 20000) {
						logWarn(
							`Lock is stale (${Math.round(age / 1000)}s old), breaking lock: ${lockPath}`,
						);
						await fs.rmdir(lockPath);
						continue;
					}
				} catch {
					// stats failed, maybe lock was just released
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			} else {
				throw err;
			}
		}
	}
	return false;
}

/**
 * File lock release
 */
async function releaseLock(lockPath: string): Promise<void> {
	try {
		await fs.rmdir(lockPath);
	} catch (_err) {
		// Ignore release errors
	}
}

/**
 * Performs HTTP POST using standard Node.js https module
 */
function postRequest(
	urlStr: string,
	body: string,
): Promise<{ status: number; data: string }> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlStr);
		const options = {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": Buffer.byteLength(body),
			},
			timeout: 15000,
		};

		const req = https.request(url, options, (res) => {
			let responseBody = "";
			res.on("data", (chunk) => {
				responseBody += chunk;
			});
			res.on("end", () => {
				resolve({
					status: res.statusCode || 0,
					data: responseBody,
				});
			});
		});

		req.on("error", (err) => {
			reject(err);
		});

		req.on("timeout", () => {
			req.destroy();
			reject(new Error("Request timeout"));
		});

		req.write(body);
		req.end();
	});
}

/**
 * Performs token refresh call to NetSuite token endpoint
 */
async function refreshTokens(
	accountId: string,
	clientId: string,
	refreshToken: string,
): Promise<Partial<TokenData>> {
	const accountHost = formatNetSuiteAccountHost(accountId);
	const tokenUrl = `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	}).toString();

	// Retry up to 4 times with exponential backoff on transient errors
	let attempt = 0;
	const maxAttempts = 4;

	while (true) {
		attempt++;
		try {
			const res = await postRequest(tokenUrl, body);
			if (res.status === 200) {
				const payload = JSON.parse(res.data);
				return {
					access_token: String(payload.access_token),
					refresh_token: payload.refresh_token
						? String(payload.refresh_token)
						: refreshToken,
					expires_in: Number(payload.expires_in),
				};
			}

			const errorMsg = `HTTP ${res.status}: ${res.data}`;
			if (res.status === 400 || res.status === 401) {
				throw new Error(`Unrecoverable error refreshing tokens: ${errorMsg}`);
			}

			// ONLY retry on safe HTTP statuses (rejected before processing)
			if (res.status === 429 || res.status === 503) {
				if (attempt < maxAttempts) {
					const delay = Math.min(3000 * 2 ** (attempt - 1), 20000);
					logWarn(
						`Transient refresh error (${errorMsg}). Retrying in ${delay / 1000}s...`,
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				}
			}
			throw new Error(`Failed after ${maxAttempts} attempts: ${errorMsg}`);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);

			// ONLY retry on safe, pre-flight errors where we know the request didn't reach NetSuite
			const isSafeNetworkError =
				message.includes("ENOTFOUND") ||
				message.includes("ECONNREFUSED") ||
				message.includes("ENETUNREACH") ||
				message.includes("EAI_AGAIN");

			if (
				attempt < maxAttempts &&
				!message.includes("Unrecoverable") &&
				isSafeNetworkError
			) {
				const delay = Math.min(3000 * 2 ** (attempt - 1), 20000);
				logWarn(
					`Safe pre-flight network exception (${message}). Retrying in ${delay / 1000}s...`,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			throw err;
		}
	}
}

/**
 * Scans directories and runs the keepalive daemon logic once
 */
export async function runKeepAlive(): Promise<void> {
	logInfo("Starting token keepalive execution scan...");

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
	let lockProvider: RedisLockProvider | null = null;
	try {
		await redis.connect();
		lockProvider = new RedisLockProvider(redis);
		logInfo("Redis connected for distributed locking");
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		logWarn(
			`Redis connection failed: ${message}. Using file locks as fallback.`,
		);
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

				let lockAcquired = false;
				let lockId: unknown = null;
				const lockPath = path.join(sessionDir, "session.lock");

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

					const lockResource = `token_refresh:${accountId}`;
					if (lockProvider) {
						lockId = await lockProvider.acquire(lockResource);
						if (!lockId) {
							logWarn(
								`[${accountId}] Could not acquire Redis lock, skipping this round...`,
							);
							failedAccounts++;
							continue;
						}
					} else {
						// Fallback to file lock
						lockAcquired = await acquireLock(lockPath);
						if (!lockAcquired) {
							logWarn(
								`[${accountId}] Could not acquire session lock, skipping this round...`,
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
					const newTokens = await refreshTokens(
						lockedSession.config.accountId,
						lockedSession.config.clientId,
						currentTokens.refresh_token,
					);

					const expiresInSeconds = newTokens.expires_in ?? 3600;
					const updatedTokens: TokenData = {
						...currentTokens,
						access_token: newTokens.access_token ?? currentTokens.access_token,
						refresh_token:
							newTokens.refresh_token ?? currentTokens.refresh_token,
						expires_in: expiresInSeconds,
						expires_at: Date.now() + expiresInSeconds * 1000,
					};

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

					const updatedSession: SessionData = {
						...lockedSession,
						tokens: updatedTokens,
						authenticated: true,
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
					const newRTFingerprint = newTokens.refresh_token
						? String(newTokens.refresh_token).slice(-8)
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
					// If refresh token is truly expired and not caused by a post-network-drop rotation mismatch, mark session unauthenticated
					try {
						if (
							message.includes("Unrecoverable") &&
							!message.includes("post-network-drop rotation mismatch")
						) {
							const fileContent = await fs.readFile(sessionFile, "utf-8");
							const session = JSON.parse(fileContent) as SessionData;
							if (session.authenticated !== false) {
								session.authenticated = false;
								await fs.writeFile(
									sessionFile,
									JSON.stringify(session, null, 2),
									{ mode: 0o600 },
								);
								logWarn(
									`[${accountId}] Session marked unauthenticated due to unrecoverable token expiration.`,
								);
							}
						} else if (
							message.includes("post-network-drop rotation mismatch")
						) {
							logWarn(
								`[${accountId}] Preserving session configuration despite network drop rotation mismatch. Will attempt auto-recovery next round.`,
							);
						}
					} catch {
						// Ignore sub-errors
					}
				} finally {
					if (lockId && lockProvider) {
						await lockProvider.release(`token_refresh:${accountId}`, lockId);
					} else if (lockAcquired) {
						await releaseLock(path.join(sessionDir, "session.lock"));
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
