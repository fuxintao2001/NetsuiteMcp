export interface CacheStats {
	provider: string;
	connected: boolean;
	keyCount: number;
}

export interface CacheProvider {
	/**
	 * Connect to the cache backend.
	 */
	connect(): Promise<void>;

	/**
	 * Disconnect from the cache backend.
	 */
	disconnect(): Promise<void>;

	/**
	 * Get a cached value by account ID and key.
	 */
	get<T>(accountId: string, key: string): Promise<T | null>;

	/**
	 * Set a cached value with optional TTL in seconds.
	 */
	set<T>(
		accountId: string,
		key: string,
		data: T,
		ttlSeconds?: number,
	): Promise<void>;

	/**
	 * Delete a cached value.
	 */
	delete(accountId: string, key: string): Promise<void>;

	/**
	 * Clear all cache entries for a specific account.
	 */
	clearAccountCache(accountId: string): Promise<void>;

	/**
	 * Get cache diagnostics stats.
	 */
	getStats(): Promise<CacheStats>;
}

export class NoOpCacheProvider implements CacheProvider {
	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}
	async get<T>(_accountId: string, _key: string): Promise<T | null> {
		return null;
	}
	async set<T>(
		_accountId: string,
		_key: string,
		_data: T,
		_ttlSeconds?: number,
	): Promise<void> {}
	async delete(_accountId: string, _key: string): Promise<void> {}
	async clearAccountCache(_accountId: string): Promise<void> {}
	async getStats(): Promise<CacheStats> {
		return {
			provider: "noop",
			connected: false,
			keyCount: 0,
		};
	}
}

export {
	type TieredCacheOptions,
	TieredCacheProvider,
} from "./tieredCacheProvider.js";
