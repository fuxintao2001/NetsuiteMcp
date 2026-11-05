import { LRUCache } from "lru-cache";
import type { CacheProvider, CacheStats } from "./cacheProvider.js";

export interface TieredCacheOptions {
	l1MaxItems?: number;
	l1TtlMs?: number;
}

/**
 * Multi-tier Cache Provider:
 * - L1: In-memory LRU cache (fast zero-latency local lookups)
 * - L2: Shared distributed cache (RedisCacheProvider)
 */
export class TieredCacheProvider implements CacheProvider {
	private readonly l1: LRUCache<string, object>;
	private readonly l2: CacheProvider;
	private readonly l1TtlMs: number;

	constructor(l2Provider: CacheProvider, options?: TieredCacheOptions) {
		this.l2 = l2Provider;
		this.l1TtlMs = options?.l1TtlMs ?? 5 * 60 * 1000; // 5 minutes default
		this.l1 = new LRUCache<string, object>({
			max: options?.l1MaxItems ?? 500,
			ttl: this.l1TtlMs,
		});
	}

	async connect(): Promise<void> {
		await this.l2.connect();
	}

	async disconnect(): Promise<void> {
		this.l1.clear();
		await this.l2.disconnect();
	}

	private getL1Key(accountId: string, key: string): string {
		return `${accountId.toLowerCase()}:${key.toLowerCase()}`;
	}

	async get<T>(accountId: string, key: string): Promise<T | null> {
		const l1Key = this.getL1Key(accountId, key);
		const cachedL1 = this.l1.get(l1Key) as T | undefined;
		if (cachedL1 !== undefined) {
			return cachedL1;
		}

		// L1 miss: Query L2 (Redis)
		const data = await this.l2.get<T>(accountId, key);
		if (data !== null && data !== undefined) {
			this.l1.set(l1Key, data as unknown as object, { ttl: this.l1TtlMs });
		}
		return data;
	}

	async set<T>(
		accountId: string,
		key: string,
		data: T,
		ttlSeconds?: number,
	): Promise<void> {
		const l1Key = this.getL1Key(accountId, key);
		const ttlMs =
			ttlSeconds !== undefined && ttlSeconds > 0
				? Math.min(ttlSeconds * 1000, this.l1TtlMs)
				: this.l1TtlMs;
		if (data !== null && data !== undefined) {
			this.l1.set(l1Key, data as unknown as object, { ttl: ttlMs });
		}
		await this.l2.set(accountId, key, data, ttlSeconds);
	}

	async delete(accountId: string, key: string): Promise<void> {
		const l1Key = this.getL1Key(accountId, key);
		this.l1.delete(l1Key);
		await this.l2.delete(accountId, key);
	}

	async clearAccountCache(accountId: string): Promise<void> {
		const prefix = `${accountId.toLowerCase()}:`;
		for (const k of this.l1.keys()) {
			if (k.startsWith(prefix)) {
				this.l1.delete(k);
			}
		}
		await this.l2.clearAccountCache(accountId);
	}

	async getStats(): Promise<CacheStats> {
		const l2Stats = await this.l2.getStats();
		return {
			provider: `tiered(l1:lru,l2:${l2Stats.provider})`,
			connected: l2Stats.connected,
			keyCount: this.l1.size + l2Stats.keyCount,
		};
	}

	getL1Size(): number {
		return this.l1.size;
	}
}
