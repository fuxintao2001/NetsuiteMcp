import type { CacheProvider, CacheStats } from "./cacheProvider.js";

export class CacheService {
	private provider: CacheProvider | null = null;

	configure(provider: CacheProvider): void {
		this.provider = provider;
	}

	async get<T>(accountId: string, key: string): Promise<T | null> {
		return this.provider ? this.provider.get<T>(accountId, key) : null;
	}

	async set<T>(
		accountId: string,
		key: string,
		data: T,
		ttlSeconds = 0,
	): Promise<void> {
		if (this.provider) {
			await this.provider.set(accountId, key, data, ttlSeconds);
		}
	}

	async delete(accountId: string, key: string): Promise<void> {
		if (this.provider) {
			await this.provider.delete(accountId, key);
		}
	}

	async clearAccountCache(accountId: string): Promise<void> {
		if (this.provider) {
			await this.provider.clearAccountCache(accountId);
		}
	}

	async getStats(): Promise<CacheStats> {
		return this.provider
			? this.provider.getStats()
			: {
					provider: "unconfigured",
					connected: false,
					keyCount: 0,
				};
	}
}

export const cacheService = new CacheService();
