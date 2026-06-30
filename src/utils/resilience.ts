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
        // Wait 5s before refreshing to allow macOS network/Wi-Fi adapter to reconnect after waking up
        console.error(`🔄 [TokenRefreshScheduler] System wake detected (${Math.round(elapsed / 1000)}s since last tick). Waiting 5s for network to stabilize...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
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

export interface RetryOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  factor?: number;
  jitter?: boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions = {},
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
): Promise<T> {
  const retries = options.retries ?? 3;
  const minTimeout = options.minTimeoutMs ?? 1000;
  const maxTimeout = options.maxTimeoutMs ?? 15000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt > retries || !isRetryable(error)) {
        throw error;
      }

      // 优先解析并遵从 NetSuite 返回的 Retry-After 头部时间
      let delay = getRetryAfterMs(error) ?? (minTimeout * Math.pow(factor, attempt - 1));
      delay = Math.min(delay, maxTimeout);
      
      if (jitter && !getRetryAfterMs(error)) {
        // 应用随机抖动，防止波峰重合（惊群效应）
        delay = (Math.random() * 0.5 + 0.5) * delay;
      }

      if (onRetry) {
        onRetry(error, attempt, delay);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function getRetryAfterMs(error: any): number | null {
  const headers = error.response?.headers;
  if (!headers) return null;
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (!retryAfter) return null;

  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;

  const dateMs = Date.parse(retryAfter);
  if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

/**
 * 全局信号量控制，严格防止并发请求数超出 NetSuite 的账户承载上限。
 * 采用直接 Slot 转移逻辑，避免 activeCount 增减与微任务调度的竞态条件。
 */
export class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];
  private readonly maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.activeCount++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        // 关键点：直接将 Slot 传递给队列中的下一项，保持 activeCount 不变
        // 消除 activeCount-- 后再异步 resolve() 导致短暂 activeCount 降低引发的穿透
        next();
      } else {
        this.activeCount--;
      }
    }
  }
}

