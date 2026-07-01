import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { TokenRefreshScheduler, retryWithBackoff, getRetryAfterMs, ConcurrencyLimiter } from './resilience.js';

describe('Resilience Utilities', () => {
  describe('retryWithBackoff', () => {
    it('should resolve immediately if function succeeds first time', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('success');
      const result = await retryWithBackoff(fn, () => true, { retries: 3 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry up to limit and throw on final failure', async () => {
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('failure'));
      const isRetryable = jest.fn().mockReturnValue(true);

      await expect(
        retryWithBackoff(fn, isRetryable, { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 5, jitter: false })
      ).rejects.toThrow('failure');

      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it('should respect Retry-After header if present', () => {
      const error = {
        response: {
          headers: {
            'retry-after': '3'
          }
        }
      };
      expect(getRetryAfterMs(error)).toBe(3000);

      const errorMixedCase = {
        response: {
          headers: {
            'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'
          }
        }
      };
      jest.useFakeTimers();
      jest.setSystemTime(new Date('Wed, 21 Oct 2026 07:27:50 GMT'));
      expect(getRetryAfterMs(errorMixedCase)).toBe(10000);
      jest.useRealTimers();
    });
  });

  describe('ConcurrencyLimiter', () => {
    it('should limit active concurrent operations and execute in order', async () => {
      const limiter = new ConcurrencyLimiter(2);
      const activeJobs: number[] = [];
      const order: number[] = [];
      const resolves: (() => void)[] = [];

      const job = async (id: number) => {
        await limiter.run(async () => {
          activeJobs.push(id);
          expect(activeJobs.length).toBeLessThanOrEqual(2);
          await new Promise<void>(resolve => {
            resolves.push(resolve);
          });
          activeJobs.splice(activeJobs.indexOf(id), 1);
          order.push(id);
        });
      };

      const promise = Promise.all([job(1), job(2), job(3)]);

      // Wait a tiny bit to let all run() calls reach their limit/queues
      await new Promise(resolve => setTimeout(resolve, 5));

      // Resolve job 2 first (resolves[1])
      resolves[1]();
      await new Promise(resolve => setTimeout(resolve, 5));

      // Resolve job 3 (resolves[2]) which was queued and starts after job 2 finished
      resolves[2]();
      await new Promise(resolve => setTimeout(resolve, 5));

      // Resolve job 1 (resolves[0])
      resolves[0]();

      await promise;
      expect(order).toEqual([2, 3, 1]);
    });
  });

  describe('TokenRefreshScheduler', () => {
    let mockTarget: any;
    let scheduler: TokenRefreshScheduler;

    beforeEach(() => {
      mockTarget = {
        hasValidSession: jest.fn().mockResolvedValue(true),
        ensureValidToken: jest.fn().mockResolvedValue('token'),
        forceRefreshToken: jest.fn().mockResolvedValue('new-token'),
        tryAutoRecover: jest.fn().mockResolvedValue(undefined)
      };
      scheduler = new TokenRefreshScheduler(mockTarget, 100);
    });

    afterEach(() => {
      scheduler.stop();
    });

    it('should run tick immediately on start and check validity', async () => {
      scheduler.start();
      expect(mockTarget.hasValidSession).toHaveBeenCalled();
      // Tick was async, wait a moment
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockTarget.ensureValidToken).toHaveBeenCalled();
    });

    it('should invoke tryAutoRecover if session is lost', async () => {
      mockTarget.hasValidSession.mockResolvedValue(false);
      scheduler.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockTarget.tryAutoRecover).toHaveBeenCalledWith(1);
    });
  });
});
