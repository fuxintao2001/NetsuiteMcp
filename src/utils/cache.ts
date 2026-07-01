import { CacheProvider, CacheStats, NoopCacheProvider } from './cacheProvider.js';

export class CacheService {
  private provider: CacheProvider = new NoopCacheProvider();

  configure(provider: CacheProvider): void {
    this.provider = provider;
  }

  async get<T>(accountId: string, key: string): Promise<T | null> {
    return this.provider.get<T>(accountId, key);
  }

  async set<T>(accountId: string, key: string, data: T, ttlSeconds: number = 0): Promise<void> {
    await this.provider.set(accountId, key, data, ttlSeconds);
  }

  async delete(accountId: string, key: string): Promise<void> {
    await this.provider.delete(accountId, key);
  }

  async clearAccountCache(accountId: string): Promise<void> {
    await this.provider.clearAccountCache(accountId);
  }

  async getStats(): Promise<CacheStats> {
    return this.provider.getStats();
  }
}

export const cacheService = new CacheService();
