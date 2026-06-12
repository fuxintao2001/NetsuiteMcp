import { TokenRefreshScheduler } from './resilience.js';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('TokenRefreshScheduler', () => {
  let mockTarget: {
    hasValidSession: jest.Mock<() => Promise<boolean>>;
    ensureValidToken: jest.Mock<() => Promise<string>>;
  };
  let scheduler: TokenRefreshScheduler;

  beforeEach(() => {
    mockTarget = {
      hasValidSession: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      ensureValidToken: jest.fn<() => Promise<string>>().mockResolvedValue('valid-token'),
    };
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (scheduler) {
      scheduler.stop();
    }
    jest.useRealTimers();
  });

  it('should start and run periodic checks', async () => {
    scheduler = new TokenRefreshScheduler(mockTarget, 1000);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    // Advance timers by 1 second
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockTarget.hasValidSession).toHaveBeenCalledTimes(1);
    expect(mockTarget.ensureValidToken).toHaveBeenCalledTimes(1);
  });

  it('should not call ensureValidToken if no session exists', async () => {
    mockTarget.hasValidSession.mockResolvedValue(false);
    scheduler = new TokenRefreshScheduler(mockTarget, 1000);
    scheduler.start();

    await jest.advanceTimersByTimeAsync(1000);

    expect(mockTarget.hasValidSession).toHaveBeenCalled();
    expect(mockTarget.ensureValidToken).not.toHaveBeenCalled();
  });

  it('should catch and swallow errors in tick', async () => {
    mockTarget.ensureValidToken.mockRejectedValue(new Error('Refresh failed'));
    scheduler = new TokenRefreshScheduler(mockTarget, 1000);
    scheduler.start();

    // Should not throw
    await expect(jest.advanceTimersByTimeAsync(1000)).resolves.not.toThrow();
    expect(mockTarget.ensureValidToken).toHaveBeenCalled();
  });
});
