import type { Redis } from "ioredis";
import Redlock, { type Lock } from "redlock";

/**
 * Provides distributed locking capabilities using Redis.
 */
export class RedisLockProvider {
	private readonly redlock: Redlock;
	private readonly keyPrefix = "ns:lock:";

	/**
	 * Creates a new RedisLockProvider.
	 * @param redis The ioredis client instance.
	 */
	constructor(redis: Redis) {
		this.redlock = new Redlock([redis], {
			driftFactor: 0.01,
			retryCount: 40,
			retryDelay: 400, // 40 * 400ms = 16-24s wait for lock (exceeds 15s token HTTP timeout)
			retryJitter: 200,
			automaticExtensionThreshold: 500,
		});
		this.redlock.on("error", (err: unknown) => {
			console.error("⚠️ [Redlock Error]", err);
		});
	}

	/**
	 * Acquires a lock on a specific resource.
	 *
	 * @param resource The identifier of the resource to lock.
	 * @param ttlMs Time to live for the lock in milliseconds (default: 25000ms).
	 * @returns A promise that resolves to the lock object if successful, or null if the lock couldn't be acquired.
	 */
	async acquire(resource: string, ttlMs: number = 25000): Promise<Lock | null> {
		const key = `${this.keyPrefix}${resource}`;
		try {
			const lockObj = await this.redlock.acquire([key], ttlMs);
			return lockObj;
		} catch (_err) {
			// redlock throws an error if it fails to acquire the lock after retries
			return null;
		}
	}

	/**
	 * Releases a previously acquired lock.
	 *
	 * @param lock The lock object returned by acquire().
	 * @returns A promise that resolves to true if the lock was successfully released, false otherwise.
	 */
	async release(lock: unknown): Promise<boolean> {
		if (!lock || typeof lock !== "object") return false;
		try {
			await (lock as { release: () => Promise<unknown> }).release();
			return true;
		} catch (_err) {
			return false;
		}
	}
}
