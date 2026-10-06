import crypto from "node:crypto";
import type { RedisLockProvider } from "../cache/redisLock.js";
import { openBrowser } from "../utils/browserLauncher.js";
import { getKnownClientId } from "../utils/constants.js";
import { formatNetSuiteAccountHost } from "../utils/environment.js";
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
		this.refreshPromise = (async () => {
			const accountId =
				session?.config?.accountId || session?.tokens?.accountId || "unknown";
			const lockResource = `token_refresh:${formatNetSuiteAccountHost(accountId)}`;
			let lockId: unknown = null;

			try {
				// Acquire Redis distributed lock
				if (this.lockProvider) {
					lockId = await this.lockProvider.acquire(lockResource);
					if (!lockId) {
						throw new TokenRefreshError(
							"Failed to acquire Redis lock for token refresh",
							true,
						);
					}
				}

				// Reload session from disk after lock is acquired to check for concurrent updates
				const currentSession = await this.storage.load();
				if (currentSession?.tokens) {
					const currentToken = currentSession.tokens.access_token;
					// If the token has already been refreshed by another process, reuse it
					if (
						tokenToRefresh !== currentToken &&
						!shouldRefreshToken(currentSession.tokens)
					) {
						console.error(
							"🔄 Token was refreshed by another process concurrently.",
						);
						return currentToken;
					}
					// Also check if refresh_token changed (rotation by another process)
					if (
						session.tokens?.refresh_token &&
						currentSession.tokens.refresh_token !== session.tokens.refresh_token
					) {
						console.error(
							"🔄 Refresh token was rotated by another process. Using their result.",
						);
						return currentSession.tokens.access_token;
					}
					// Update the session in our scope
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
				console.error(
					`🔄 Token rotation: old_rt=...${oldRT} → new_rt=...${newRT}`,
				);

				// Token Rotation safety: verify refresh_token hasn't been rotated during our HTTP request
				const preWriteSession = await this.storage.load();
				if (
					preWriteSession?.tokens?.refresh_token &&
					session.tokens?.refresh_token &&
					preWriteSession.tokens.refresh_token !== session.tokens.refresh_token
				) {
					console.error(
						"⚠️ Refresh token was rotated by another process during our refresh. Using their result.",
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
					console.error(
						"🔒 Refresh token expired — marking session unauthenticated",
					);
					// Mark session as unauthenticated while preserving config for potential re-auth
					const current = await this.storage.load();
					if (current && current.authenticated !== false) {
						await this.storage.save({
							...current,
							authenticated: false,
						});
					}
				}
				throw error;
			} finally {
				if (lockId && this.lockProvider) {
					await this.lockProvider.release(lockResource, lockId);
				}
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
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
			console.error(
				`🔄 [OAuthManager] Attempting silent browser re-authentication for account ${accountId}...`,
			);
			await this.startAuthFlow({ accountId, clientId }, timeoutMs);
			const refreshed = await this.storage.load();
			return !!(refreshed?.authenticated && refreshed?.tokens);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`⚠️ [OAuthManager] Silent re-authentication did not complete: ${message}`,
			);
			return false;
		}
	}

	/**
	 * Ensure token is valid, auto-refresh if expiring soon
	 */
	async ensureValidToken(): Promise<string> {
		// 1. Instantly return running promise to resolve concurrent race condition
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		// 2. Wrap load, expiration check, and validation inside a single cached promise
		this.refreshPromise = (async () => {
			try {
				let session = await this.storage.load();

				// If not authenticated or no tokens, attempt silent re-authentication before failing
				if (!session?.tokens || !session.authenticated) {
					console.error(
						"⚠️ No active authenticated session, attempting silent re-authentication...",
					);
					const silentSuccess = await this.trySilentReauth(60000);
					if (silentSuccess) {
						session = await this.storage.load();
					}
				}

				if (!session?.tokens || !session.authenticated) {
					throw new Error(
						"Not authenticated. Please run authentication first.",
					);
				}

				if (shouldRefreshToken(session.tokens)) {
					console.error("⚠️ Token expiring soon, refreshing...");
					try {
						return await this.executeTokenRefresh(
							session,
							session.tokens.access_token,
						);
					} catch (refreshError: unknown) {
						if (
							refreshError instanceof TokenRefreshError &&
							!refreshError.recoverable
						) {
							console.error(
								"🔄 Refresh token expired/invalid, attempting silent re-authentication via browser SSO...",
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
			console.error("🔄 Token was already refreshed by another request.");
			return currentToken;
		}

		// If a refresh is already in progress, wait for it
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		console.error("🔄 Force-refreshing access token...");
		return this.executeTokenRefresh(session, currentToken);
	}

	/**
	 * Check if has valid authenticated session
	 */
	async hasValidSession(): Promise<boolean> {
		const isAuth = await this.storage.isAuthenticated();
		if (isAuth) return true;

		// If tokens exist with refresh_token, attempt quick auto-recovery
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
		let session = await this.storage.load();
		if (!session?.tokens?.refresh_token) return;

		let lockId: unknown = null;
		const accountId =
			session?.config?.accountId || session?.tokens?.accountId || "unknown";
		const lockResource = `token_refresh:${formatNetSuiteAccountHost(accountId)}`;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.error(`🔄 Auto-recovery attempt ${attempt}/${maxRetries}...`);

				if (this.lockProvider) {
					lockId = await this.lockProvider.acquire(lockResource);
					if (!lockId) {
						throw new TokenRefreshError(
							"Failed to acquire Redis lock for auto-recovery",
							true,
						);
					}
				}

				// Reload session from disk after lock is acquired to check if another process recovered it
				const currentSession = await this.storage.load();
				if (currentSession?.tokens && currentSession.authenticated) {
					if (!shouldRefreshToken(currentSession.tokens)) {
						console.error(
							"🔄 Session was already recovered by another process concurrently.",
						);
						return;
					}
					// Update the session in our scope
					session = currentSession;
				}

				const tokensToRefresh = currentSession?.tokens || session.tokens;
				if (!tokensToRefresh) return;

				const oldRT = tokensToRefresh.refresh_token?.slice(-8) || "unknown";
				const newTokens = await refreshAccessToken(tokensToRefresh);
				const newRT = newTokens.refresh_token?.slice(-8) || "unchanged";
				console.error(
					`🔄 Auto-recovery token rotation: old_rt=...${oldRT} → new_rt=...${newRT}`,
				);

				// Token Rotation safety: verify refresh_token hasn't been rotated during our HTTP request
				const preWriteSession = await this.storage.load();
				if (
					preWriteSession?.tokens?.refresh_token &&
					tokensToRefresh.refresh_token &&
					preWriteSession.tokens.refresh_token !== tokensToRefresh.refresh_token
				) {
					console.error(
						"⚠️ Refresh token was rotated by another process during our auto-recovery. Using their result.",
					);
					return;
				}

				await this.storage.save({
					...(currentSession || session),
					previous_tokens: (currentSession || session).tokens,
					tokens: newTokens,
					authenticated: true,
					unrecoverable: false,
				});
				console.error("✅ Auto-recovery successful");
				return;
			} catch (error: unknown) {
				// Unrecoverable: refresh token itself is expired/invalid — don't retry in this loop
				if (error instanceof TokenRefreshError && !error.recoverable) {
					console.error(
						"🔒 Refresh token expired or invalid — auto-recovery stopped",
					);
					const current = await this.storage.load();
					if (current && current.authenticated !== false) {
						await this.storage.save({
							...current,
							authenticated: false,
						});
					}
					throw error;
				}
				// Transient: network timeout, DNS failure, etc. — retry after exponential backoff
				if (attempt < maxRetries) {
					// Exponential backoff: 3s, 6s, 12s, capped at 15s
					const delay = Math.min(3000 * 2 ** (attempt - 1), 15000);
					console.error(
						`⚠️ Auto-recovery attempt ${attempt} failed (transient error), retrying in ${delay / 1000}s...`,
					);
					if (lockId && this.lockProvider) {
						await this.lockProvider.release(lockResource, lockId);
						lockId = null;
					}
					await new Promise((resolve) => setTimeout(resolve, delay));

					// Re-check session before next attempt — daemon may have refreshed it
					const refreshedSession = await this.storage.load();
					if (
						refreshedSession?.authenticated &&
						refreshedSession.tokens &&
						!shouldRefreshToken(refreshedSession.tokens)
					) {
						console.error(
							"🔄 Session recovered by keepalive daemon during backoff wait.",
						);
						return;
					}
				} else {
					console.error(`⚠️ Auto-recovery failed after ${maxRetries} attempts`);
					throw error;
				}
			} finally {
				if (lockId && this.lockProvider) {
					await this.lockProvider.release(lockResource, lockId);
					lockId = null;
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

	/**
	 * Clear session data for logout
	 */
	async logout(): Promise<void> {
		await this.storage.clear();
	}
}
