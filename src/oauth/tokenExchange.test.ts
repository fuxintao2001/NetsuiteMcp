import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { exchangeCodeForTokens, refreshAccessToken, shouldRefreshToken, TokenRefreshError } from './tokenExchange.js';
import { httpClient } from '../utils/httpClient.js';

describe('TokenExchange', () => {
  let postSpy: any;

  beforeEach(() => {
    postSpy = jest.spyOn(httpClient, 'post');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('shouldRefreshToken', () => {
    it('should return true if token expires in less than 5 minutes', () => {
      const tokens = {
        access_token: 'acc',
        refresh_token: 'ref',
        expires_in: 3600,
        expires_at: Date.now() + 4 * 60 * 1000, // 4 mins from now
        accountId: '123',
        clientId: '456'
      };
      expect(shouldRefreshToken(tokens)).toBe(true);
    });

    it('should return false if token expires in more than 5 minutes', () => {
      const tokens = {
        access_token: 'acc',
        refresh_token: 'ref',
        expires_in: 3600,
        expires_at: Date.now() + 6 * 60 * 1000, // 6 mins from now
        accountId: '123',
        clientId: '456'
      };
      expect(shouldRefreshToken(tokens)).toBe(false);
    });
  });

  describe('exchangeCodeForTokens', () => {
    it('should successfully exchange authorization code for tokens', async () => {
      postSpy.mockResolvedValueOnce({
        data: {
          access_token: 'access_123',
          refresh_token: 'refresh_123',
          expires_in: 3600
        }
      });

      const config = { accountId: '123456_SB1', clientId: 'client_id', redirectUri: 'http://localhost' };
      const tokens = await exchangeCodeForTokens('code_123', config, 'verifier_123');

      expect(tokens.access_token).toBe('access_123');
      expect(tokens.refresh_token).toBe('refresh_123');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.expires_at).toBeGreaterThan(Date.now());
      expect(postSpy).toHaveBeenCalled();
    });

    it('should throw on API exchange failure', async () => {
      const mockErr = new Error('Exchange failed');
      Object.assign(mockErr, { response: { status: 400, data: { error: 'invalid_grant' } } });
      postSpy.mockRejectedValueOnce(mockErr);

      const config = { accountId: '123456_SB1', clientId: 'client_id', redirectUri: 'http://localhost' };
      await expect(exchangeCodeForTokens('code_123', config, 'verifier_123')).rejects.toThrow('Failed to exchange authorization code');
    });
  });

  describe('refreshAccessToken', () => {
    it('should refresh token successfully', async () => {
      postSpy.mockResolvedValueOnce({
        data: {
          access_token: 'new_access',
          refresh_token: 'new_refresh',
          expires_in: 3600
        }
      });

      const oldTokens = {
        access_token: 'old_access',
        refresh_token: 'old_refresh',
        expires_in: 3600,
        expires_at: Date.now(),
        accountId: '123456_SB1',
        clientId: 'client_id'
      };

      const result = await refreshAccessToken(oldTokens);
      expect(result.access_token).toBe('new_access');
      expect(result.refresh_token).toBe('new_refresh');
    });

    it('should classify 400/401 token refresh failure as unrecoverable', async () => {
      const mockErr = new Error('Invalid refresh token');
      Object.assign(mockErr, { response: { status: 400, data: { error: 'invalid_grant' } } });
      postSpy.mockRejectedValueOnce(mockErr);

      const oldTokens = {
        access_token: 'old_access',
        refresh_token: 'old_refresh',
        expires_in: 3600,
        expires_at: Date.now(),
        accountId: '123456_SB1',
        clientId: 'client_id'
      };

      try {
        await refreshAccessToken(oldTokens);
        fail('Should have thrown an error');
      } catch (err: any) {
        expect(err).toBeInstanceOf(TokenRefreshError);
        expect(err.recoverable).toBe(false);
      }
    });

    it('should classify 503 token refresh failure as recoverable', async () => {
      const mockErr = new Error('Service Unavailable');
      Object.assign(mockErr, { response: { status: 503 } });
      // Reject then resolve on retry
      postSpy
        .mockRejectedValueOnce(mockErr)
        .mockResolvedValueOnce({
          data: {
            access_token: 'new_access',
            expires_in: 3600
          }
        });

      const oldTokens = {
        access_token: 'old_access',
        refresh_token: 'old_refresh',
        expires_in: 3600,
        expires_at: Date.now(),
        accountId: '123456_SB1',
        clientId: 'client_id'
      };

      const result = await refreshAccessToken(oldTokens);
      expect(result.access_token).toBe('new_access');
      expect(postSpy).toHaveBeenCalledTimes(2); // Initial reject + retry success
    });
  });
});
