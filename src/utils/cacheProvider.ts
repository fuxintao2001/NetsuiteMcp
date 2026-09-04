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
