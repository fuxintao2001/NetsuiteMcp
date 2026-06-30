import { cacheService } from './cache.js';
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('CacheService', () => {
  const accountId = 'test-account-123';
  const key = 'test-key';
  const data = { foo: 'bar' };

  beforeEach(async () => {
    await cacheService.clearAccountCache(accountId);
  });

  afterEach(async () => {
    await cacheService.clearAccountCache(accountId);
  });

  it('should set data in both L1 and L2 caches', async () => {
    await cacheService.set(accountId, key, data);

    // Should be in memory (L1) immediately
    const l1Result = await cacheService.get(accountId, key);
    expect(l1Result).toEqual(data);
  });

  it('should fallback to L2 if L1 is empty', async () => {
    await cacheService.set(accountId, key, data);
    
    // Reach into the class to clear just the memory cache to test L2 fallback
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    cacheService['memoryCache'].del(memKey);

    const result = await cacheService.get(accountId, key);
    expect(result).toEqual(data);
  });
});
