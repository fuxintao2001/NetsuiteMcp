/**
 * Connection Resilience Utilities
 * Provides proactive token refresh scheduling to maintain session validity.
 */

/** Minimal interface for the OAuthManager used by the scheduler */
interface TokenRefreshTarget {
  hasValidSession(): Promise<boolean>;
  ensureValidToken(): Promise<string>;
  forceRefreshToken(failedToken?: string): Promise<string>;
  tryAutoRecover(maxRetries?: number): Promise<void>;
}

/**
 * Proactive Token Refresh Scheduler
 *
 * Periodically checks if the OAuth token is expiring soon and refreshes it
 * proactively, preventing silent token expiration during idle periods.
 *
 * Design contract:
 * - All exceptions are caught internally — nothing escapes to global scope.
 * - The interval timer is unref'd so it never prevents process exit.
 * - Calling start() multiple times is safe (idempotent).
 * - When no valid session is found, attempts auto-recovery via refresh token.
 */
export class TokenRefreshScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly target: TokenRefreshTarget;
  private readonly intervalMs: number;
  private lastTickTime: number = Date.now();

  constructor(
    target: TokenRefreshTarget,
    intervalMs: number = parseInt(process.env.MCP_TOKEN_CHECK_INTERVAL_MS || '60000', 10)
  ) {
    this.target = target;
    this.intervalMs = intervalMs;
  }

  /** Start the periodic refresh check. Idempotent. */
  start(): void {
    if (this.intervalId) return;

    this.lastTickTime = Date.now();
    console.error(`🔄 [TokenRefreshScheduler] Started — checking every ${this.intervalMs / 1000}s`);

    // Run first tick immediately to handle startup/wake state
    void this.tick();

    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Ensure the timer never prevents Node.js from exiting
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
  }

  /** Stop the periodic refresh check. */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.error('🔄 [TokenRefreshScheduler] Stopped');
    }
  }

  /** Check if the scheduler is currently running. */
  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Single tick: check session validity and refresh token if needed.
   * If no valid session exists, attempts auto-recovery via refresh token.
   * ALL exceptions are caught here — nothing escapes to global scope.
   */
  private async tick(): Promise<void> {
    try {
      // Detect sleep/wake: if elapsed time >> intervalMs, system likely just woke up
      const now = Date.now();
      const elapsed = now - this.lastTickTime;
      const wasSleeping = elapsed > this.intervalMs * 3;
      this.lastTickTime = now;

      const hasSession = await this.target.hasValidSession();

      if (!hasSession) {
        // No valid session — attempt auto-recovery using stored refresh token
        console.error('🔄 [TokenRefreshScheduler] No valid session. Attempting auto-recovery...');
        await this.target.tryAutoRecover(1);
        return;
      }

      if (wasSleeping) {
        // Force refresh after sleep — token is very likely expired
        console.error(`🔄 [TokenRefreshScheduler] System wake detected (${Math.round(elapsed / 1000)}s since last tick). Force-refreshing token...`);
        await this.target.forceRefreshToken();
      } else {
        // Normal path: ensureValidToken() auto-refreshes if within the 5-minute window
        await this.target.ensureValidToken();
      }
    } catch (error: unknown) {
      // Intentionally swallowed. This is a background maintenance task.
      // Logging is the only action — we never rethrow from a setInterval callback.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠️ [TokenRefreshScheduler] Proactive refresh failed: ${message}`);
    }
  }
}
