import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { generatePKCE } from './pkce.js';
import type { PKCEChallenge } from './pkce.js';
import { CallbackServer } from './callbackServer.js';
import { SessionStorage } from './sessionStorage.js';
import type { TokenData } from './sessionStorage.js';
import { exchangeCodeForTokens, refreshAccessToken, shouldRefreshToken, TokenRefreshError } from './tokenExchange.js';
import { TokenRefreshScheduler } from '../utils/resilience.js';
import { openBrowser } from '../utils/browserLauncher.js';
import { formatNetSuiteAccountHost } from '../utils/environment.js';

/**
 * Acquire a cross-process file-based lock by creating a directory.
 * Autorecovers from stale locks after 20 seconds.
 */
async function acquireLock(lockPath: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.mkdir(lockPath);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Check lock age to prevent deadlocks from crashed processes
        try {
          const stats = await fs.stat(lockPath);
          const age = Date.now() - stats.mtimeMs;
          if (age > 20000) {
            console.error(`⚠️  Lock is stale (${Math.round(age / 1000)}s old), breaking lock: ${lockPath}`);
            await fs.rmdir(lockPath);
            continue; // Retry immediately after breaking lock
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
 * Release a cross-process file-based lock by removing the directory.
 */
async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.rmdir(lockPath);
  } catch {
    // Ignore error if lock already deleted
  }
}

interface OAuthManagerConfig {
  storagePath?: string;
  callbackPort?: number;
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

  constructor(config: OAuthManagerConfig = {}) {
    this.callbackPort = config.callbackPort || 8080;
    this.storage = new SessionStorage(config.storagePath || './sessions');
    this.callbackServer = new CallbackServer(this.callbackPort);
    this.tokenRefreshScheduler = new TokenRefreshScheduler(this);
  }

  /**
   * Start OAuth flow with local callback server
   */
  async startAuthFlow(config: AuthFlowConfig): Promise<string> {
    const { accountId, clientId } = config;

    if (!accountId || !clientId) {
      throw new Error('accountId and clientId are required');
    }

    const pkce = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = `http://localhost:${this.callbackPort}/callback`;

    // Preserve existing tokens and authenticated state — don't destroy a recoverable session
    const existingSession = await this.storage.load();
    await this.storage.save({
      ...existingSession,
      pkce: pkce.code_verifier,
      state,
      config: { accountId, clientId, redirectUri },
      timestamp: Date.now()
    });

    // Generate authorization URL
    const authUrl = this.buildAuthorizationUrl(accountId, clientId, redirectUri, state, pkce);

    console.error(`\n🔐 NetSuite Authentication Required`);
    console.error(`📋 Opening browser for authentication...\n`);

    // Automatically open browser
    await openBrowser(authUrl);

    console.error(`📋 If browser didn't open, use this URL:\n`);
    console.error(`   ${authUrl}\n`);
    console.error(`⏳ Waiting for authentication...`);

    // Start callback server and wait for OAuth callback
    try {
      await this.callbackServer.start(state, async (code: string) => {
        await this.handleAuthorizationCode(code);
      });
      console.error(`✅ Authentication successful!\n`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ Authentication failed: ${message}\n`);
      // Restore existing session if it had tokens, clearing PKCE/state
      if (existingSession && existingSession.tokens) {
        await this.storage.save(existingSession);
      } else {
        await this.storage.save(existingSession || {});
      }
      throw error;
    }

    return authUrl;
  }

  /**
   * Build authorization URL for NetSuite OAuth
   */
  private buildAuthorizationUrl(
    accountId: string,
    clientId: string,
    redirectUri: string,
    state: string,
    pkce: PKCEChallenge
  ): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'mcp',
      state: state,
      code_challenge: pkce.code_challenge,
      code_challenge_method: pkce.code_challenge_method
    });

    return `https://${formatNetSuiteAccountHost(accountId)}.app.netsuite.com/app/login/oauth2/authorize.nl?${params}`;
  }

  /**
   * Handle authorization code from OAuth callback
   */
  private async handleAuthorizationCode(code: string): Promise<void> {
    const session = await this.storage.load();

    if (!session || !session.pkce) {
      throw new Error('Invalid session or PKCE challenge not found. Please try connecting again.');
    }

    const { pkce: verifier, config } = session;

    if (!config || !verifier) {
      throw new Error('Session is missing required OAuth config. Please try connecting again.');
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, config, verifier);

    // Store tokens in session
    await this.storage.save({
      ...session,
      tokens,
      pkce: null, // Clear PKCE after successful exchange
      authenticated: true
    });
  }

  private async executeTokenRefresh(session: any, tokenToRefresh: string): Promise<string> {
    this.refreshPromise = (async () => {
      const lockPath = path.join(this.storage.getStoragePath(), 'session.lock');
      let lockAcquired = false;
      try {
        lockAcquired = await acquireLock(lockPath);
        if (!lockAcquired) {
          console.error('⚠️  Failed to acquire session lock for token refresh, proceeding without lock...');
        }

        // Reload session from disk after lock is acquired to check for concurrent updates
        const currentSession = await this.storage.load();
        if (currentSession && currentSession.tokens) {
          const currentToken = currentSession.tokens.access_token;
          // If the token has already been refreshed by another process, reuse it
          if (tokenToRefresh !== currentToken && !shouldRefreshToken(currentSession.tokens)) {
            console.error('🔄 Token was refreshed by another process concurrently.');
            return currentToken;
          }
          // Update the session in our scope
          session = currentSession;
        }

        const newTokens = await refreshAccessToken(session.tokens);
        await this.storage.save({
          ...session,
          tokens: newTokens
        });
        return newTokens.access_token;
      } catch (error: unknown) {
        if (error instanceof TokenRefreshError && !error.recoverable) {
          console.error('🔒 Refresh token expired — session requires re-authentication');
          // Mark session as unauthenticated while preserving config for potential re-auth
          const current = await this.storage.load();
          if (current) {
            await this.storage.save({ ...current, authenticated: false });
          }
        }
        throw error;
      } finally {
        if (lockAcquired) {
          await releaseLock(lockPath);
        }
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
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
        const session = await this.storage.load();
        if (!session || !session.tokens) {
          throw new Error('Not authenticated. Please run authentication first.');
        }

        if (shouldRefreshToken(session.tokens) || this.shouldProactivelyRenew(session.tokens)) {
          console.error('⚠️ Token expiring soon or proactive renewal triggered, refreshing...');
          return await this.executeTokenRefresh(session, session.tokens.access_token);
        }

        return session.tokens.access_token;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Check if we should proactively refresh to keep the refresh token alive.
   * Returns true when the access token is past halfway through its lifetime.
   * This ensures refresh tokens get renewed frequently (~every 30 min for a
   * 60-min access token) and never expire from disuse.
   */
  private shouldProactivelyRenew(tokens: TokenData): boolean {
    const issuedAt = tokens.expires_at - tokens.expires_in * 1000;
    const elapsed = Date.now() - issuedAt;
    const halfLife = (tokens.expires_in * 1000) / 2;
    return elapsed > halfLife;
  }

  /**
   * Force refresh the access token (used by retry logic after 401)
   */
  async forceRefreshToken(failedToken?: string): Promise<string> {
    const session = await this.storage.load();
    if (!session || !session.tokens) {
      throw new Error('Not authenticated. Please run authentication first.');
    }

    const currentToken = session.tokens.access_token;

    // If the token was already refreshed by another concurrent request, return it immediately
    if (failedToken && currentToken !== failedToken) {
      console.error('🔄 Token was already refreshed by another request.');
      return currentToken;
    }

    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    console.error('🔄 Force-refreshing access token...');
    return this.executeTokenRefresh(session, currentToken);
  }

  /**
   * Check if has valid authenticated session
   */
  async hasValidSession(): Promise<boolean> {
    return await this.storage.isAuthenticated();
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
      return { authenticated: false, refreshSchedulerActive: this.tokenRefreshScheduler.isRunning() };
    }

    const now = Date.now();
    const expiresAt = session.tokens.expires_at;
    const expiresInMs = expiresAt ? expiresAt - now : undefined;

    return {
      authenticated: true,
      accountId: session.tokens.accountId,
      clientId: session.tokens.clientId,
      tokenExpiresAt: expiresAt,
      tokenExpiresIn: expiresInMs ? Math.max(0, Math.round(expiresInMs / 1000)) : undefined,
      refreshSchedulerActive: this.tokenRefreshScheduler.isRunning()
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

    const lockPath = path.join(this.storage.getStoragePath(), 'session.lock');
    let lockAcquired = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.error(`🔄 Auto-recovery attempt ${attempt}/${maxRetries}...`);
        
        lockAcquired = await acquireLock(lockPath);
        if (!lockAcquired) {
          console.error('⚠️  Failed to acquire session lock for auto-recovery, proceeding without lock...');
        }

        // Reload session from disk after lock is acquired to check if another process recovered it
        const currentSession = await this.storage.load();
        if (currentSession && currentSession.tokens && currentSession.authenticated) {
          if (!shouldRefreshToken(currentSession.tokens)) {
            console.error('🔄 Session was already recovered by another process concurrently.');
            return;
          }
          // Update the session in our scope
          session = currentSession;
        }

        const tokensToRefresh = currentSession?.tokens || session.tokens;
        if (!tokensToRefresh) return;

        const newTokens = await refreshAccessToken(tokensToRefresh);
        await this.storage.save({
          ...(currentSession || session),
          tokens: newTokens,
          authenticated: true
        });
        console.error('✅ Auto-recovery successful');
        return;
      } catch (error: unknown) {
        // Unrecoverable: refresh token itself is expired/invalid — don't retry
        if (error instanceof TokenRefreshError && !error.recoverable) {
          console.error('🔒 Refresh token expired — re-authentication required');
          const current = await this.storage.load();
          if (current) {
            await this.storage.save({ ...current, authenticated: false });
          }
          throw error;
        }
        // Transient: network timeout, DNS failure, etc. — retry after exponential backoff
        if (attempt < maxRetries) {
          // Exponential backoff: 3s, 6s, 12s, capped at 15s
          const delay = Math.min(3000 * Math.pow(2, attempt - 1), 15000);
          console.error(`⚠️ Auto-recovery attempt ${attempt} failed (transient error), retrying in ${delay / 1000}s...`);
          if (lockAcquired) {
            await releaseLock(lockPath);
            lockAcquired = false;
          }
          await new Promise(resolve => setTimeout(resolve, delay));

          // Re-check session before next attempt — daemon may have refreshed it
          const refreshedSession = await this.storage.load();
          if (refreshedSession?.authenticated && refreshedSession.tokens && !shouldRefreshToken(refreshedSession.tokens)) {
            console.error('🔄 Session recovered by keepalive daemon during backoff wait.');
            return;
          }
        } else {
          console.error(`⚠️ Auto-recovery failed after ${maxRetries} attempts`);
          throw error;
        }
      } finally {
        if (lockAcquired) {
          await releaseLock(lockPath);
          lockAcquired = false;
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
