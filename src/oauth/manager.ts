import crypto from "node:crypto";
import type { RedisLockProvider } from "../cache/redisLock.js";
import { openBrowser } from "../utils/browserLauncher.js";
import { getKnownClientId } from "../utils/constants.js";
import { formatNetSuiteAccountHost } from "../utils/environment.js";
import { createLogger } from "../utils/logger.js";
import { TokenRefreshScheduler } from "../utils/resilience.js";
import { CallbackServer } from "./callbackServer.js";
import type { PKCEChallenge } from "./pkce.js";
import { generatePKCE } from "./pkce.js";
import { type SessionData, SessionStorage } from "./sessionStorage.js";
import {
	exchangeCodeForTokens,
	refreshAccessToken,
	shouldRefreshToken,
	TokenRefreshError,
} from "./tokenExchange.js";

const logger = createLogger("oauth");

interface OAuthManagerConfig {
	storagePath?: string;
	callbackPort?: number;
	lockProvider?: RedisLockProvider | null;
}

interface AuthFlowConfig {
	accountId: string;
	clientId: string;
}

/**
 * OAuth Manager for NetSuite OAuth 2.0 with PKCE
 * Handles authorization flow, token exchange, and automatic token refresh
 */
export class OAuthManager {
	private callbackPort: number;
	private storage: SessionStorage;
	private callbackServer: CallbackServer;
	private tokenRefreshScheduler: TokenRefreshScheduler;
	private refreshPromise: Promise<string> | null = null;
	private authPromise: Promise<string> | null = null;
	private lockProvider: RedisLockProvider | null;

	constructor(config: OAuthManagerConfig = {}) {
		this.callbackPort = config.callbackPort || 8080;
		this.storage = new SessionStorage(config.storagePath || "./sessions");
		this.callbackServer = new CallbackServer(this.callbackPort);
		this.tokenRefreshScheduler = new TokenRefreshScheduler(this);
		this.lockProvider = config.lockProvider || null;
	}

	/**
	 * Set or update the Redis lock provider (e.g., after Redis connects)
	 */
	setLockProvider(provider: RedisLockProvider): void {
		this.lockProvider = provider;
	}

	/**
	 * Start OAuth flow with local callback server
	 */
	async startAuthFlow(
		config: Partial<AuthFlowConfig> = {},
		timeoutMs?: number,
	): Promise<string> {
		if (this.authPromise) {
			return this.authPromise;
		}

		this.authPromise = (async () => {
			try {
				const existingSession = await this.storage.load();
				const accountId =
					config.accountId ||
					existingSession?.config?.accountId ||
					process.env.NETSUITE_ACCOUNT_ID;
				let clientId =
					config.clientId ||
					existingSession?.config?.clientId ||
					process.env.NETSUITE_CLIENT_ID;

				if (
					!clientId ||
					clientId === "my-client-id" ||
					clientId === "default_client_id"
				) {
					if (
						existingSession?.config?.clientId &&
						existingSession.config.clientId !== "my-client-id"
					) {
						clientId = existingSession.config.clientId;
					} else if (
						existingSession?.tokens?.clientId &&
						existingSession.tokens.clientId !== "my-client-id"
					) {
						clientId = existingSession.tokens.clientId;
					} else if (accountId) {
						const fallback = getKnownClientId(accountId);
						if (fallback) {
							clientId = fallback;
						}
					}
				}

				if (!accountId || !clientId) {
					throw new Error("accountId and clientId are required");
				}

				const pkce = generatePKCE();
				const state = crypto.randomBytes(16).toString("hex");
				const redirectUri = `http://localhost:${this.callbackPort}/callback`;

				// Preserve existing tokens and authenticated state — don't destroy a recoverable session
				await this.storage.save({
					...existingSession,
					pkce: pkce.code_verifier,
					state,
					config: { accountId, clientId, redirectUri },
					timestamp: Date.now(),
				});

				// Generate authorization URL
				const authUrl = this.buildAuthorizationUrl(
					accountId,
					clientId,
					redirectUri,
					state,
					pkce,
				);

				console.error(`\n🔐 NetSuite Authentication Required`);
				console.error(`📋 Opening browser for authentication...\n`);

				// Automatically open browser
				await openBrowser(authUrl);

				console.error(`📋 If browser didn't open, use this URL:\n`);
				console.error(`   ${authUrl}\n`);
				console.error(`⏳ Waiting for authentication...`);

				// Start callback server and wait for OAuth callback
				try {
					await this.callbackServer.start(
						state,
						async (code: string) => {
							await this.handleAuthorizationCode(code);
						},
						timeoutMs,
					);
					console.error(`✅ Authentication successful!\n`);
				} catch (error: unknown) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`❌ Authentication failed: ${message}\n`);
					// Restore existing session if it had tokens, clearing PKCE/state
					if (existingSession?.tokens) {
						await this.storage.save(existingSession);
					} else {
						await this.storage.save(existingSession || {});
					}
					throw error;
				}

				return authUrl;
			} finally {
				this.authPromise = null;
			}
		})();

		return this.authPromise;
	}

	/**
	 * Build authorization URL for NetSuite OAuth
	 */
	private buildAuthorizationUrl(
		accountId: string,
		clientId: string,
		redirectUri: string,
		state: string,
		pkce: PKCEChallenge,
	): string {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			scope: "mcp",
			state: state,
			code_challenge: pkce.code_challenge,
			code_challenge_method: pkce.code_challenge_method,
		});

		return `https://${formatNetSuiteAccountHost(accountId)}.app.netsuite.com/app/login/oauth2/authorize.nl?${params}`;
	}

	/**
	 * Handle authorization code from OAuth callback
	 */
	private async handleAuthorizationCode(code: string): Promise<void> {
		const session = await this.storage.load();

		if (!session?.pkce) {
			throw new Error(
				"Invalid session or PKCE challenge not found. Please try connecting again.",
			);
		}

		const { pkce: verifier, config } = session;

		if (!config || !verifier) {
			throw new Error(
				"Session is missing required OAuth config. Please try connecting again.",
			);
		}

		// Exchange code for tokens
		const tokens = await exchangeCodeForTokens(code, config, verifier);

		// Store tokens in session
		await this.storage.save({
			...session,
			tokens,
			pkce: null, // Clear PKCE after successful exchange
			authenticated: true,
			unrecoverable: false,
		});
	}

	private async executeTokenRefresh(
		session: SessionData,
		tokenToRefresh: string,
	): Promise<string> {
		const accountId =
			session?.config?.accountId || session?.tokens?.accountId || "unknown";
		const lockResource = `token_refresh:${formatNetSuiteAccountHost(accountId)}`;
		let redisLock: unknown = null;
		let releaseFileLock: (() => Promise<void>) | null = null;

		try {
			// 1. Acquire local cross-process file lock (barrier for multi-instance / daemons)
			try {
				releaseFileLock = await this.storage.acquireLock(20000);
			} catch (fileLockErr) {
				logger.warn(
					`File lock acquisition warning: ${fileLockErr instanceof Error ? fileLockErr.message : String(fileLockErr)}`,
				);
			}

			// 2. Acquire Redis distributed lock
			if (this.lockProvider) {
				redisLock = await this.lockProvider.acquire(lockResource, 25000);
				if (!redisLock) {
					// Wait-Reload-Reuse: Before giving up, re-check session if another process refreshed it
					const checkedSession = await this.storage.load(true);
					if (
						checkedSession?.tokens &&
						(checkedSession.tokens.access_token !== tokenToRefresh ||
							!shouldRefreshToken(checkedSession.tokens))
					) {
						logger.info(
							"Token was refreshed by another process while waiting for Redis lock. Reusing new token.",
						);
						return checkedSession.tokens.access_token;
					}
					throw new TokenRefreshError(
						"Failed to acquire Redis lock for token refresh",
						true,
					);
				}
			}

			// 3. Reload session from disk after lock is acquired to check for concurrent updates (Wait-Reload-Reuse)
			const currentSession = await this.storage.load(true);
			if (currentSession?.tokens) {
				const currentToken = currentSession.tokens.access_token;
				// If the token has already been refreshed by another process, reuse it
				if (
					tokenToRefresh !== currentToken &&
					!shouldRefreshToken(currentSession.tokens)
				) {
					logger.info("Token was refreshed by another process concurrently.");
					return currentToken;
				}
				// Also check if refresh_token changed (rotation by another process)
				if (
					session.tokens?.refresh_token &&
					currentSession.tokens.refresh_token !== session.tokens.refresh_token
				) {
					logger.info(
						"Refresh token was rotated by another process. Using their result.",
					);
					return currentSession.tokens.access_token;
				}
				session = currentSession;
			}

			if (!session.tokens) {
				throw new TokenRefreshError(
					"No tokens available to refresh in session",
					false,
				);
			}

			const oldRT = session.tokens.refresh_token?.slice(-8) || "unknown";
			const newTokens = await refreshAccessToken(session.tokens);
			const newRT = newTokens.refresh_token?.slice(-8) || "unchanged";
			logger.info(`Token rotation: old_rt=...${oldRT} → new_rt=...${newRT}`);

			// Token Rotation safety: verify refresh_token hasn't been rotated during our HTTP request
			const preWriteSession = await this.storage.load(true);
			if (
				preWriteSession?.tokens?.refresh_token &&
				session.tokens?.refresh_token &&
				preWriteSession.tokens.refresh_token !== session.tokens.refresh_token
			) {
				logger.warn(
					"Refresh token was rotated by another process during our refresh. Using their result.",
				);
				return preWriteSession.tokens.access_token;
			}

			await this.storage.save({
				...session,
				previous_tokens: session.tokens,
				tokens: newTokens,
				authenticated: true,
				unrecoverable: false,
			});
			return newTokens.access_token;
		} catch (error: unknown) {
			if (error instanceof TokenRefreshError && !error.recoverable) {
				logger.warn(
					"Refresh token expired or invalid — marking session unauthenticated and unrecoverable",
				);
				// Mark session as unauthenticated and unrecoverable while preserving config
				const current = await this.storage.load(true);
				if (current) {
					await this.storage.save({
						...current,
						authenticated: false,
						unrecoverable: true,
					});
				}
			}
			throw error;
		} finally {
			if (redisLock && this.lockProvider) {
				await this.lockProvider.release(redisLock).catch(() => {});
			}
			if (releaseFileLock) {
				await releaseFileLock().catch(() => {});
			}
		}
	}

	/**
	 * Attempt silent re-authentication via browser SSO.
	 * If the user's browser has an active NetSuite login session, this completes
	 * in 1-3 seconds without prompting for credentials.
	 */
	async trySilentReauth(timeoutMs = 60000): Promise<boolean> {
		const session = await this.storage.load();
		const accountId = session?.config?.accountId || session?.tokens?.accountId;
		let clientId = session?.config?.clientId || session?.tokens?.clientId;

		if (
			!clientId ||
			clientId === "my-client-id" ||
			clientId === "default_client_id"
		) {
			if (accountId) {
				const fallback = getKnownClientId(accountId);
				if (fallback) clientId = fallback;
			}
		}

		if (!accountId || !clientId) {
			return false;
		}

		try {
			logger.info(
				`Attempting silent browser re-authentication for account ${accountId}...`,
			);
			await this.startAuthFlow({ accountId, clientId }, timeoutMs);
			const refreshed = await this.storage.load();
			return !!(refreshed?.authenticated && refreshed?.tokens);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(`Silent re-authentication did not complete: ${message}`);
			return false;
		}
	}

	/**
	 * Ensure token is valid, auto-refresh if expiring soon.
	 * When allowInteractive is false, background tasks will never trigger browser windows.
	 */
	async ensureValidToken(options?: {
		allowInteractive?: boolean;
	}): Promise<string> {
		const allowInteractive = options?.allowInteractive ?? true;

		// 1. Instantly return running promise to resolve concurrent race condition
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		// 2. Wrap load, expiration check, and validation inside a single cached promise
		this.refreshPromise = (async () => {
			try {
				let session = await this.storage.load();

				// If not authenticated or no tokens, attempt silent re-authentication before failing (only if interactive allowed)
				if (!session?.tokens || !session.authenticated) {
					if (allowInteractive && !session?.unrecoverable) {
						logger.info(
							"No active authenticated session, attempting silent re-authentication...",
						);
						const silentSuccess = await this.trySilentReauth(60000);
						if (silentSuccess) {
							session = await this.storage.load();
						}
					}
				}

				if (!session?.tokens || !session.authenticated) {
					throw new Error(
						"Not authenticated. Please run authentication first.",
					);
				}

				if (shouldRefreshToken(session.tokens)) {
					logger.info("Token expiring soon, refreshing...");
					try {
						return await this.executeTokenRefresh(
							session,
							session.tokens.access_token,
						);
					} catch (refreshError: unknown) {
						if (
							allowInteractive &&
							refreshError instanceof TokenRefreshError &&
							!refreshError.recoverable
						) {
							logger.info(
								"Refresh token expired/invalid, attempting silent re-authentication via browser SSO...",
							);
							const silentSuccess = await this.trySilentReauth(60000);
							if (silentSuccess) {
								const reloaded = await this.storage.load();
								if (reloaded?.tokens?.access_token) {
									return reloaded.tokens.access_token;
								}
							}
						}
						throw refreshError;
					}
				}

				return session.tokens.access_token;
			} finally {
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
	}

	/**
	 * Force refresh the access token (used by retry logic after 401)
	 */
	async forceRefreshToken(failedToken?: string): Promise<string> {
		let session = await this.storage.load();
		if (!session?.tokens) {
			const silentSuccess = await this.trySilentReauth(60000);
			if (silentSuccess) {
				session = await this.storage.load();
			}
		}

		if (!session?.tokens) {
			throw new Error("Not authenticated. Please run authentication first.");
		}

		const currentToken = session.tokens.access_token;

		// If the token was already refreshed by another concurrent request, return it immediately
		if (failedToken && currentToken !== failedToken) {
			logger.info("Token was already refreshed by another request.");
			return currentToken;
		}

		// If a refresh is already in progress, wait for it
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		logger.info("Force-refreshing access token...");
		this.refreshPromise = this.executeTokenRefresh(
			session,
			currentToken,
		).finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	/**
	 * Check if has valid authenticated session
	 */
	async hasValidSession(): Promise<boolean> {
		const isAuth = await this.storage.isAuthenticated();
		if (isAuth) return true;

		// If tokens exist with refresh_token and session is not unrecoverable, attempt quick auto-recovery
		const session = await this.storage.load();
		if (session?.tokens?.refresh_token && !session.unrecoverable) {
			try {
				await this.tryAutoRecover(1);
				return await this.storage.isAuthenticated();
			} catch {
				return false;
			}
		}
		return false;
	}

	/**
	 * Get account ID from session
	 */
	async getAccountId(): Promise<string | undefined> {
		const session = await this.storage.load();
		return session?.tokens?.accountId;
	}

	/**
	 * Get diagnostic info about the current session.
	 * Used by the netsuite_status tool.
	 */
	async getSessionInfo(): Promise<{
		authenticated: boolean;
		accountId?: string;
		clientId?: string;
		tokenExpiresAt?: number;
		tokenExpiresIn?: number | undefined;
		refreshSchedulerActive: boolean;
	}> {
		const session = await this.storage.load();
		const authenticated = !!(session?.authenticated && session?.tokens);

		if (!authenticated || !session?.tokens) {
			return {
				authenticated: false,
				refreshSchedulerActive: this.tokenRefreshScheduler.isRunning(),
			};
		}

		const now = Date.now();
		const expiresAt = session.tokens.expires_at;
		const expiresInMs = expiresAt ? expiresAt - now : undefined;

		return {
			authenticated: true,
			accountId: session.tokens.accountId,
			clientId: session.tokens.clientId,
			tokenExpiresAt: expiresAt,
			tokenExpiresIn: expiresInMs
				? Math.max(0, Math.round(expiresInMs / 1000))
				: undefined,
			refreshSchedulerActive: this.tokenRefreshScheduler.isRunning(),
		};
	}

	/**
	 * Clear session (logout)
	 */
	async clearSession(): Promise<void> {
		this.stopProactiveRefresh();
		await this.storage.clear();
	}

	/**
	 * Attempt to auto-recover an expired session using the refresh token.
	 * Called during server startup and by the scheduler when the session is lost.
	 *
	 * Retries up to `maxRetries` times for transient network errors with exponential backoff.
	 * Immediately gives up on unrecoverable errors (e.g. expired refresh token).
	 * Before each retry, re-reads the session file — the keepalive daemon may have
	 * already refreshed the token while we were waiting.
	 */
	async tryAutoRecover(maxRetries = 8): Promise<void> {
		const initialSession = await this.storage.load();
		if (
			!initialSession?.tokens?.refresh_token ||
			initialSession.unrecoverable
		) {
			return;
		}

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				logger.info(`Auto-recovery attempt ${attempt}/${maxRetries}...`);
				const latestSession = await this.storage.load();
				if (
					!latestSession?.tokens?.refresh_token ||
					latestSession.unrecoverable
				) {
					return;
				}
				if (
					latestSession.authenticated &&
					!shouldRefreshToken(latestSession.tokens)
				) {
					logger.info(
						"Session was already recovered by another process concurrently.",
					);
					return;
				}

				await this.executeTokenRefresh(
					latestSession,
					latestSession.tokens.access_token,
				);
				logger.info("Auto-recovery successful");
				return;
			} catch (error: unknown) {
				// Unrecoverable: refresh token itself is expired/invalid — don't retry in this loop
				if (error instanceof TokenRefreshError && !error.recoverable) {
					logger.warn(
						"Refresh token expired or invalid — auto-recovery stopped",
					);
					throw error;
				}

				// Transient: network timeout, DNS failure, etc. — retry after exponential backoff
				if (attempt < maxRetries) {
					const delay = Math.min(3000 * 2 ** (attempt - 1), 15000);
					logger.warn(
						`Auto-recovery attempt ${attempt} failed (transient error), retrying in ${delay / 1000}s...`,
					);
					await new Promise((resolve) => setTimeout(resolve, delay));

					// Re-check session before next attempt — daemon may have refreshed it
					const refreshedSession = await this.storage.load();
					if (
						refreshedSession?.authenticated &&
						refreshedSession.tokens &&
						!shouldRefreshToken(refreshedSession.tokens)
					) {
						logger.info(
							"Session recovered by keepalive daemon during backoff wait.",
						);
						return;
					}
				} else {
					logger.warn(`Auto-recovery failed after ${maxRetries} attempts`);
					throw error;
				}
			}
		}
	}

	/**
	 * Start the proactive token refresh scheduler
	 */
	startProactiveRefresh(): void {
		this.tokenRefreshScheduler.start();
	}

	/**
	 * Touch heartbeat file for session coordination
	 */
	async touchHeartbeat(): Promise<void> {
		await this.storage.touchHeartbeat();
	}

	/**
	 * Stop the proactive token refresh scheduler
	 */
	stopProactiveRefresh(): void {
		this.tokenRefreshScheduler.stop();
	}

	/**
	 * Retrieve diagnostics information about the current session.
	 */
	async getSessionDiagnostics() {
		try {
			const session = await this.storage.load();
			return {
				storagePath: this.storage.getStoragePath(),
				accountId: session?.config?.accountId || null,
				authenticated: !!session?.authenticated,
				expiresAt: session?.tokens?.expires_at || null,
			};
		} catch {
			return {
				storagePath: this.storage.getStoragePath(),
				accountId: null,
				authenticated: false,
				expiresAt: null,
			};
		}
	}
}
