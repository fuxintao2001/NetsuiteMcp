import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { OAuthManager } from './manager.js';
import { CallbackServer } from './callbackServer.js';
import { httpClient } from '../utils/httpClient.js';
import fs from 'fs/promises';
import path from 'path';

describe('OAuthManager Integration tests', () => {
  const testStoragePath = path.join(process.cwd(), '.test-manager-storage-rewritten');
  let manager: OAuthManager;
  let startSpy: any;
  let httpPostSpy: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.rm(testStoragePath, { recursive: true, force: true });
    
    manager = new OAuthManager({ storagePath: testStoragePath });

    // Mock CallbackServer.prototype.start
    startSpy = jest.spyOn(CallbackServer.prototype, 'start');

    // Mock httpClient.post
    httpPostSpy = jest.spyOn(httpClient, 'post');
  });

  afterEach(async () => {
    manager.stopProactiveRefresh();
    await fs.rm(testStoragePath, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('startAuthFlow', () => {
    it('should orchestrate start, launch browser, and wait for callback', async () => {
      startSpy.mockImplementation(async (state: string, callback: (code: string) => Promise<void>) => {
        // Execute callback
        await callback('new-auth-code');
      });

      httpPostSpy.mockResolvedValue({
        data: {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600
        }
      } as any);

      await manager.startAuthFlow({ accountId: '123456_SB1', clientId: 'my-client-id' });

      expect(startSpy).toHaveBeenCalled();
      expect(httpPostSpy).toHaveBeenCalled();

      const finalSession = JSON.parse(
        await fs.readFile(path.join(testStoragePath, 'session.json'), 'utf-8')
      );
      expect(finalSession.tokens.access_token).toBe('new-access-token');
      expect(finalSession.authenticated).toBe(true);
    });
  });

  describe('ensureValidToken', () => {
    it('should return current token without refresh if valid', async () => {
      const mockSession = {
        authenticated: true,
        tokens: {
          access_token: 'valid-access-token',
          refresh_token: 'my-refresh-token',
          expires_in: 3600,
          expires_at: Date.now() + 3000 * 1000, // valid
          accountId: '123456',
          clientId: 'my-client-id'
        }
      };

      await fs.mkdir(testStoragePath, { recursive: true });
      await fs.writeFile(
        path.join(testStoragePath, 'session.json'),
        JSON.stringify(mockSession),
        'utf-8'
      );

      const token = await manager.ensureValidToken();
      expect(token).toBe('valid-access-token');
      expect(httpPostSpy).not.toHaveBeenCalled();
    });

    it('should refresh token if expired or proactively renew', async () => {
      const mockSession = {
        authenticated: true,
        tokens: {
          access_token: 'expired-access-token',
          refresh_token: 'my-refresh-token',
          expires_in: 3600,
          expires_at: Date.now() - 100, // expired
          accountId: '123456',
          clientId: 'my-client-id'
        }
      };

      await fs.mkdir(testStoragePath, { recursive: true });
      await fs.writeFile(
        path.join(testStoragePath, 'session.json'),
        JSON.stringify(mockSession),
        'utf-8'
      );

      httpPostSpy.mockResolvedValue({
        data: {
          access_token: 'refreshed-access-token',
          refresh_token: 'my-refresh-token',
          expires_in: 3600
        }
      } as any);

      const token = await manager.ensureValidToken();
      expect(token).toBe('refreshed-access-token');
      expect(httpPostSpy).toHaveBeenCalled();
    });
  });

  describe('tryAutoRecover', () => {
    it('should attempt recovery via refresh token if session is not authenticated but refresh token exists', async () => {
      const mockSession = {
        authenticated: false,
        tokens: {
          access_token: 'expired-access-token',
          refresh_token: 'my-refresh-token',
          expires_in: 3600,
          expires_at: Date.now() - 100,
          accountId: '123456',
          clientId: 'my-client-id'
        }
      };

      await fs.mkdir(testStoragePath, { recursive: true });
      await fs.writeFile(
        path.join(testStoragePath, 'session.json'),
        JSON.stringify(mockSession),
        'utf-8'
      );

      httpPostSpy.mockResolvedValue({
        data: {
          access_token: 'recovered-access-token',
          refresh_token: 'my-refresh-token',
          expires_in: 3600
        }
      } as any);

      await manager.tryAutoRecover(1);
      expect(httpPostSpy).toHaveBeenCalled();

      const finalSession = JSON.parse(
        await fs.readFile(path.join(testStoragePath, 'session.json'), 'utf-8')
      );
      expect(finalSession.authenticated).toBe(true);
      expect(finalSession.tokens.access_token).toBe('recovered-access-token');
    });
  });
});
