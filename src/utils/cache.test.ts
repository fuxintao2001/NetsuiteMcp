import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CacheService } from './cache.js';
import fs from 'fs/promises';
import path from 'path';

describe('CacheService', () => {
  const testDir = path.join(process.cwd(), '.test-cache-dir');
  let cache: CacheService;

  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
    cache = new CacheService(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should set and get values in memory (L1)', async () => {
    await cache.set('acc1', 'myKey', { foo: 'bar' }, 60);
    const result = await cache.get<any>('acc1', 'myKey');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should promote L2 filesystem cache to L1 memory cache on hit', async () => {
    // 1. Write direct to disk (mocking L2 cache existence without L1 memory trace)
    await cache.set('acc1', 'filesystemKey', { hello: 'world' }, 3600);
    
    // Create new CacheService instance pointing to the same folder to clear memory (L1)
    const cache2 = new CacheService(testDir);
    
    const result = await cache2.get<any>('acc1', 'filesystemKey');
    expect(result).toEqual({ hello: 'world' });
    
    // Check statistics of L1 memory keys
    const stats = cache2.getStats();
    expect(stats.l1KeyCount).toBe(1); // Promoted to L1
  });

  it('should return null and clean up file if L2 cache is expired', async () => {
    await cache.set('acc1', 'expiredKey', 'oldData', -10); // Negative TTL
    
    const cache2 = new CacheService(testDir);
    const result = await cache2.get('acc1', 'expiredKey');
    expect(result).toBeNull();
  });

  it('should delete keys from L1 and L2 cache', async () => {
    await cache.set('acc1', 'deleteKey', 'someValue', 60);
    await cache.delete('acc1', 'deleteKey');
    
    const result = await cache.get('acc1', 'deleteKey');
    expect(result).toBeNull();
  });

  it('should clear all cache for a specific account', async () => {
    await cache.set('acc1', 'key1', 'val1', 60);
    await cache.set('acc2', 'key2', 'val2', 60);
    
    await cache.clearAccountCache('acc1');
    
    expect(await cache.get('acc1', 'key1')).toBeNull();
    expect(await cache.get('acc2', 'key2')).toEqual('val2');
  });

  it('should migrate from legacy unhashed format files', async () => {
    const accDir = path.join(testDir, '.cache', 'acc-legacy');
    await fs.mkdir(accDir, { recursive: true });
    
    // Legacy file (no hash suffix)
    const legacyPath = path.join(accDir, 'mykey.json');
    await fs.writeFile(legacyPath, JSON.stringify({ data: 'legacy' }), 'utf-8');
    
    // Modern file (with hash suffix)
    const modernPath = path.join(accDir, 'mykey_0123456789abcdef.json');
    await fs.writeFile(modernPath, JSON.stringify({ expiration: Date.now() + 60000, ttlSeconds: 60, data: 'modern' }), 'utf-8');

    await cache.migrateFromLegacyFormat('acc-legacy');

    // Legacy file should be unlinked
    await expect(fs.access(legacyPath)).rejects.toThrow();
    // Modern file should remain
    await expect(fs.access(modernPath)).resolves.not.toThrow();
  });
});
