/**
 * Connection Resilience Utilities
 * Provides proactive token refresh scheduling to maintain session validity.
 */

/** Minimal interface for the OAuthManager used by the scheduler */
interface TokenRefreshTarget {
  hasValidSession(): Promise<boolean>;
  ensureValidToken(): Promise<string>;
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
 */
export class TokenRefreshScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly target: TokenRefreshTarget;
  private readonly intervalMs: number;

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

    console.error(`🔄 [TokenRefreshScheduler] Started — checking every ${this.intervalMs / 1000}s`);

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

  /**
   * Single tick: check session validity and refresh token if needed.
   * ALL exceptions are caught here — nothing escapes to global scope.
   */
  private async tick(): Promise<void> {
    try {
      const hasSession = await this.target.hasValidSession();
      if (!hasSession) return;

      // ensureValidToken() auto-refreshes if within the 5-minute window
      await this.target.ensureValidToken();
    } catch (error: unknown) {
      // Intentionally swallowed. This is a background maintenance task.
      // Logging is the only action — we never rethrow from a setInterval callback.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`⚠️ [TokenRefreshScheduler] Proactive refresh failed: ${message}`);
    }
  }
}
