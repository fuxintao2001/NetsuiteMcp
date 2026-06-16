import { TokenRefreshScheduler } from './resilience.js';
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('TokenRefreshScheduler', () => {
  let mockTarget: {
    hasValidSession: jest.Mock<() => Promise<boolean>>;
    ensureValidToken: jest.Mock<() => Promise<string>>;
    forceRefreshToken: jest.Mock<(failedToken?: string) => Promise<string>>;
    tryAutoRecover: jest.Mock<(maxRetries?: number) => Promise<void>>;
  };
  let scheduler: TokenRefreshScheduler;

  beforeEach(() => {
    mockTarget = {
      hasValidSession: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      ensureValidToken: jest.fn<() => Promise<string>>().mockResolvedValue('valid-token'),
      forceRefreshToken: jest.fn<(failedToken?: string) => Promise<string>>().mockResolvedValue('refreshed-token'),
      tryAutoRecover: jest.fn<(maxRetries?: number) => Promise<void>>().mockResolvedValue(),
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

    // Wait for the immediate async tick to complete
    await jest.advanceTimersByTimeAsync(0);

    expect(mockTarget.hasValidSession).toHaveBeenCalledTimes(1);
    expect(mockTarget.ensureValidToken).toHaveBeenCalledTimes(1);

    // Advance timers by 1 second (triggers second tick)
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockTarget.hasValidSession).toHaveBeenCalledTimes(2);
    expect(mockTarget.ensureValidToken).toHaveBeenCalledTimes(2);
  });

  it('should attempt auto-recovery when no valid session exists', async () => {
    mockTarget.hasValidSession.mockResolvedValue(false);
    scheduler = new TokenRefreshScheduler(mockTarget, 1000);
    scheduler.start();

    // Wait for the immediate async tick to complete
    await jest.advanceTimersByTimeAsync(0);

    expect(mockTarget.hasValidSession).toHaveBeenCalledTimes(1);
    expect(mockTarget.tryAutoRecover).toHaveBeenCalledWith(1);
    expect(mockTarget.ensureValidToken).not.toHaveBeenCalled();
  });

  it('should catch and swallow errors in tick', async () => {
    mockTarget.ensureValidToken.mockRejectedValue(new Error('Refresh failed'));
    scheduler = new TokenRefreshScheduler(mockTarget, 1000);
    
    // Should not throw on start/immediate tick
    await expect(Promise.resolve().then(() => scheduler.start())).resolves.not.toThrow();

    // Wait for immediate async tick to execute and swallow the error
    await jest.advanceTimersByTimeAsync(0);
    expect(mockTarget.ensureValidToken).toHaveBeenCalled();
  });

  it('should catch and swallow auto-recovery errors', async () => {
    mockTarget.hasValidSession.mockResolvedValue(false);
    mockTarget.tryAutoRecover.mockRejectedValue(new Error('Recovery failed'));
    scheduler = new TokenRefreshScheduler(mockTarget, 1000);
    scheduler.start();

    // Wait for immediate async tick to execute and swallow the error
    await jest.advanceTimersByTimeAsync(0);
    expect(mockTarget.tryAutoRecover).toHaveBeenCalledWith(1);
  });
});

