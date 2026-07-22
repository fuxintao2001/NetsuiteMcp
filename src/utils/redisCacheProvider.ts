import { Redis } from 'ioredis';
import { CacheProvider, CacheStats } from './cacheProvider.js';

export class RedisCacheProvider implements CacheProvider {
  private redis: Redis | null = null;
  private readonly redisUrl: string;
  private readonly isMock: boolean = false;

  constructor(redisUrl?: string, mockClient?: any) {
    this.redisUrl = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    if (mockClient) {
      this.redis = mockClient;
      this.isMock = true;
    }
  }

  async connect(): Promise<void> {
    if (this.isMock) return;
    if (this.redis) return;
    console.error(`🔌 Connecting to Redis at ${this.redisUrl}...`);
    this.redis = new Redis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await this.redis.connect();
    console.error('✅ Connected to Redis successfully');
  }

  async disconnect(): Promise<void> {
    if (this.isMock) return;
    if (!this.redis) return;
    console.error('🔌 Disconnecting from Redis...');
    await this.redis.quit();
    this.redis = null;
    console.error('✅ Disconnected from Redis');
  }

  private getRedisKey(accountId: string, key: string): string {
    return `nsmcp:${accountId.toLowerCase()}:${key.toLowerCase()}`;
  }

  private ensureConnected(): Redis {
    if (!this.redis) {
      throw new Error('Redis client not connected. Call connect() first.');
    }
    return this.redis;
  }

  async get<T>(accountId: string, key: string): Promise<T | null> {
    const client = this.ensureConnected();
    const redisKey = this.getRedisKey(accountId, key);
    const data = await client.get(redisKey);
    if (!data) return null;
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      console.error(`⚠️ Failed to parse cached JSON for key ${redisKey}:`, err);
      return null;
    }
  }

  async set<T>(accountId: string, key: string, data: T, ttlSeconds?: number): Promise<void> {
    const client = this.ensureConnected();
    const redisKey = this.getRedisKey(accountId, key);
    const serialized = JSON.stringify(data);
    if (ttlSeconds && ttlSeconds > 0) {
      await client.set(redisKey, serialized, 'EX', ttlSeconds);
    } else {
      await client.set(redisKey, serialized);
    }
  }

  async delete(accountId: string, key: string): Promise<void> {
    const client = this.ensureConnected();
    const redisKey = this.getRedisKey(accountId, key);
    await client.del(redisKey);
  }

  async clearAccountCache(accountId: string): Promise<void> {
    const client = this.ensureConnected();
    const pattern = `nsmcp:${accountId.toLowerCase()}:*`;
    
    let cursor = '0';
    let keysDeleted = 0;
    do {
      const reply = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = reply[0];
      const keys = reply[1];
      if (keys && keys.length > 0) {
        // Chunk keys to prevent stack overflow from function argument spreading
        const batchSize = 500;
        for (let i = 0; i < keys.length; i += batchSize) {
          const chunk = keys.slice(i, i + batchSize);
          if (typeof (client as any).unlink === 'function') {
            await (client as any).unlink(...chunk);
          } else {
            await client.del(...chunk);
          }
        }
        keysDeleted += keys.length;
      }
    } while (cursor !== '0');
    console.error(`🗑️ Deleted ${keysDeleted} Redis cache keys for account ${accountId}`);
  }

  async getStats(): Promise<CacheStats> {
    const connected = this.redis !== null;
    let keyCount = 0;
    if (this.redis) {
      try {
        let cursor = '0';
        do {
          const reply = await this.redis.scan(cursor, 'MATCH', 'nsmcp:*', 'COUNT', 100);
          cursor = reply[0];
          if (reply[1]) {
            keyCount += reply[1].length;
          }
        } while (cursor !== '0');
      } catch (err) {
        console.error('⚠️ Failed to count Redis keys:', err);
      }
    }
    return {
      provider: 'redis',
      connected,
      keyCount
    };
  }
}
