import type { Redis } from "ioredis";
// @ts-expect-error
import Redlock from "redlock";

/**
 * Provides distributed locking capabilities using Redis.
 */
export class RedisLockProvider {
	private redlock: any;
	private readonly keyPrefix = "nsmcp:lock:";

	/**
	 * Creates a new RedisLockProvider.
	 * @param redis The ioredis client instance.
	 */
	constructor(redis: Redis) {
		this.redlock = new Redlock([redis], {
			driftFactor: 0.01,
			retryCount: 10,
			retryDelay: 200, // 10 * 200ms = 2s max wait for lock
			retryJitter: 200,
			automaticExtensionThreshold: 500,
		});
	}

	/**
	 * Acquires a lock on a specific resource.
	 *
	 * @param resource The identifier of the resource to lock.
	 * @param ttlMs Time to live for the lock in milliseconds (default: 10000ms).
	 * @returns A promise that resolves to the lock object if successful, or null if the lock couldn't be acquired.
	 */
	async acquire(resource: string, ttlMs: number = 10000): Promise<any | null> {
		const key = `${this.keyPrefix}${resource}`;
		try {
			return await this.redlock.acquire([key], ttlMs);
		} catch (err) {
			// redlock throws an error if it fails to acquire the lock after retries
			return null;
		}
	}

	/**
	 * Releases a previously acquired lock.
	 *
	 * @param resource The identifier of the locked resource (ignored for redlock as lock handles its own key).
	 * @param lock The lock object returned by acquire().
	 * @returns A promise that resolves to true if the lock was successfully released, false otherwise.
	 */
	async release(resource: string, lock: any): Promise<boolean> {
		try {
			await lock.release();
			return true;
		} catch (err) {
			return false;
		}
	}
}
