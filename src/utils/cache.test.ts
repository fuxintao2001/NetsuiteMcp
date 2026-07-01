import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CacheService } from './cache.js';
import { RedisCacheProvider } from './redisCacheProvider.js';

describe('CacheService with RedisCacheProvider (DI Mock)', () => {
  let mockRedisInstance: any;
  let provider: RedisCacheProvider;
  let cache: CacheService;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRedisInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      scan: jest.fn(),
    };

    provider = new RedisCacheProvider('redis://localhost:6379', mockRedisInstance);
    cache = new CacheService();
    cache.configure(provider);
  });

  it('should get stats based on mock instance connection status', async () => {
    mockRedisInstance.scan.mockResolvedValueOnce(['0', ['nsmcp:acc1:key1']]);
    const stats = await cache.getStats();
    expect(stats).toEqual({
      provider: 'redis',
      connected: true,
      keyCount: 1
    });
  });

  it('should set and get values in Redis', async () => {
    mockRedisInstance.get.mockResolvedValue(JSON.stringify({ foo: 'bar' }));

    await cache.set('acc1', 'myKey', { foo: 'bar' }, 60);
    expect(mockRedisInstance.set).toHaveBeenCalledWith(
      'nsmcp:acc1:mykey',
      JSON.stringify({ foo: 'bar' }),
      'EX',
      60
    );

    const result = await cache.get<any>('acc1', 'myKey');
    expect(mockRedisInstance.get).toHaveBeenCalledWith('nsmcp:acc1:mykey');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should set without EX if ttl is 0', async () => {
    await cache.set('acc1', 'myKey', 'val', 0);
    expect(mockRedisInstance.set).toHaveBeenCalledWith('nsmcp:acc1:mykey', JSON.stringify('val'));
  });

  it('should delete keys from Redis', async () => {
    await cache.delete('acc1', 'deleteKey');
    expect(mockRedisInstance.del).toHaveBeenCalledWith('nsmcp:acc1:deletekey');
  });

  it('should scan and clear all cache for a specific account', async () => {
    mockRedisInstance.scan.mockResolvedValueOnce(['0', ['nsmcp:acc1:key1', 'nsmcp:acc1:key2']]);

    await cache.clearAccountCache('acc1');

    expect(mockRedisInstance.scan).toHaveBeenCalledWith('0', 'MATCH', 'nsmcp:acc1:*', 'COUNT', 100);
    expect(mockRedisInstance.del).toHaveBeenCalledWith('nsmcp:acc1:key1', 'nsmcp:acc1:key2');
  });
});
