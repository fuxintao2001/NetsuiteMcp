/**
 * Connection Resilience Utilities
 * Provides proactive token refresh scheduling to maintain session validity.
 */

import pLimit, { type LimitFunction } from "p-limit";

/** Minimal interface for the OAuthManager used by the scheduler */
interface TokenRefreshTarget {
	hasValidSession(): Promise<boolean>;
	ensureValidToken(): Promise<string>;
	forceRefreshToken(failedToken?: string): Promise<string>;
	tryAutoRecover(maxRetries?: number): Promise<void>;
	touchHeartbeat?(): Promise<void>;
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
		intervalMs: number = parseInt(
			process.env.MCP_TOKEN_CHECK_INTERVAL_MS || "60000",
			10,
		),
	) {
		this.target = target;
		this.intervalMs = intervalMs;
	}

	/** Start the periodic refresh check. Idempotent. */
	start(): void {
		if (this.intervalId) return;

		this.lastTickTime = Date.now();
		console.error(
			`🔄 [TokenRefreshScheduler] Started — checking every ${this.intervalMs / 1000}s`,
		);

		// Run first tick immediately to handle startup/wake state
		void this.tick();

		this.intervalId = setInterval(() => {
			void this.tick();
		}, this.intervalMs);

		// Ensure the timer never prevents Node.js from exiting
		if (
			this.intervalId &&
			typeof this.intervalId === "object" &&
			"unref" in this.intervalId
		) {
			this.intervalId.unref();
		}
	}

	/** Stop the periodic refresh check. */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			console.error("🔄 [TokenRefreshScheduler] Stopped");
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
			// Touch heartbeat to signal that this session is actively managed by a running MCP server
			await this.target.touchHeartbeat?.().catch(() => {});

			// Detect sleep/wake: if elapsed time >> intervalMs, system likely just woke up
			const now = Date.now();
			const elapsed = now - this.lastTickTime;
			const wasSleeping = elapsed > this.intervalMs * 3;
			this.lastTickTime = now;

			if (wasSleeping) {
				console.error(
					`⏰ [TokenRefreshScheduler] System woke from sleep (elapsed ${Math.round(elapsed / 1000)}s)`,
				);
			}

			const hasSession = await this.target.hasValidSession();

			if (!hasSession) {
				// No valid session — attempt auto-recovery using stored refresh token
				console.error(
					"🔄 [TokenRefreshScheduler] No valid session. Attempting auto-recovery...",
				);
				await this.target.tryAutoRecover(1);
				await this.target.touchHeartbeat?.().catch(() => {});
				return;
			}

			// Normal path: ensureValidToken() auto-refreshes if within the 5-minute window
			// If we just woke from sleep, it'll naturally refresh here if needed, but only if the network is ready.
			await this.target.ensureValidToken();

			await this.target.touchHeartbeat?.().catch(() => {});
		} catch (error: unknown) {
			// Intentionally swallowed. This is a background maintenance task.
			// Logging is the only action — we never rethrow from a setInterval callback.
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`⚠️ [TokenRefreshScheduler] Proactive refresh failed: ${message}`,
			);
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
	onRetry?: (error: unknown, attempt: number, delayMs: number) => void,
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
			let delay =
				getRetryAfterMs(error) ?? minTimeout * factor ** (attempt - 1);
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

export function getRetryAfterMs(error: unknown): number | null {
	const err = error as {
		response?: { headers?: Record<string, string | undefined> };
	};
	const headers = err.response?.headers;
	if (!headers) return null;
	const retryAfter = headers["retry-after"] || headers["Retry-After"];
	if (!retryAfter) return null;

	const seconds = parseInt(retryAfter, 10);
	if (!Number.isNaN(seconds)) return seconds * 1000;

	const dateMs = Date.parse(retryAfter);
	if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

	return null;
}

/**
 * 全局并发控制，使用 p-limit 限制并行请求数，防止并发超出 NetSuite 账户上限。
 */
export class ConcurrencyLimiter {
	private readonly limiter: LimitFunction;

	constructor(maxConcurrency: number) {
		this.limiter = pLimit(maxConcurrency);
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		return this.limiter(fn);
	}
}
