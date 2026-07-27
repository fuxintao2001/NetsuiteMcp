import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { RedisLockProvider } from './redisLock.js';
import { Redis } from 'ioredis';
import Redlock from 'redlock';

describe('RedisLockProvider', () => {
  let mockRedis: any;
  let lockProvider: RedisLockProvider;

  beforeEach(() => {
    mockRedis = {};
    lockProvider = new RedisLockProvider(mockRedis as unknown as Redis);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('should acquire a lock and return a non-null lock object', async () => {
    const mockLock = { release: jest.fn() };
    const acquireSpy = jest.spyOn(Redlock.prototype, 'acquire').mockResolvedValue(mockLock as any);

    const lock = await lockProvider.acquire('my-resource', 1000);

    expect(lock).toBe(mockLock);
    expect(acquireSpy).toHaveBeenCalledWith(['nsmcp:lock:my-resource'], 1000);
  });

  it('should return null when acquire fails', async () => {
    jest.spyOn(Redlock.prototype, 'acquire').mockRejectedValue(new Error('Lock failed'));

    const lock = await lockProvider.acquire('my-resource', 1000);

    expect(lock).toBeNull();
  });

  it('should return true on release success', async () => {
    const mockLock = { release: jest.fn().mockResolvedValue(undefined) };

    const result = await lockProvider.release('my-resource', mockLock as any);

    expect(result).toBe(true);
    expect(mockLock.release).toHaveBeenCalled();
  });

  it('should return false on release failure', async () => {
    const mockLock = { release: jest.fn().mockRejectedValue(new Error('Release failed')) };

    const result = await lockProvider.release('my-resource', mockLock as any);

    expect(result).toBe(false);
  });
});
