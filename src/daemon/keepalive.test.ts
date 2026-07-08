import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { runKeepAlive } from './keepalive.js';
import { jest } from '@jest/globals';

// Simple unit tests for keepalive daemon logic using temporary session files
describe('Token Keepalive Daemon', () => {
  const testSessionRoot = path.join(os.tmpdir(), `netsuite-mcp-test-sessions-${Date.now()}`);

  beforeEach(async () => {
    await fs.mkdir(testSessionRoot, { recursive: true });
    process.env.DAEMON_SESSION_ROOTS = testSessionRoot;
  });

  afterEach(async () => {
    delete process.env.DAEMON_SESSION_ROOTS;
    try {
      await fs.rm(testSessionRoot, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it('should skip a session if token is fresh', async () => {
    const accountDir = path.join(testSessionRoot, '111111');
    await fs.mkdir(accountDir, { recursive: true });
    
    const freshExpiry = Date.now() + 3000 * 1000; // 50 mins left
    const sessionData = {
      config: {
        accountId: '111111',
        clientId: 'client_111',
        redirectUri: 'http://localhost:8080/callback',
      },
      tokens: {
        access_token: 'acc_111',
        refresh_token: 'ref_111',
        expires_in: 3600,
        expires_at: freshExpiry,
        accountId: '111111',
        clientId: 'client_111',
      },
      authenticated: true,
    };

    const sessionFile = path.join(accountDir, 'session.json');
    await fs.writeFile(sessionFile, JSON.stringify(sessionData));

    // Run keepalive (should skip)
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await runKeepAlive();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipped (token is still fresh')
    );

    // File contents should be untouched
    const content = await fs.readFile(sessionFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.tokens.access_token).toBe('acc_111');

    consoleErrorSpy.mockRestore();
  });

  it('should skip session if no configuration is present', async () => {
    const accountDir = path.join(testSessionRoot, '222222');
    await fs.mkdir(accountDir, { recursive: true });

    const sessionData = {
      authenticated: true,
    };

    const sessionFile = path.join(accountDir, 'session.json');
    await fs.writeFile(sessionFile, JSON.stringify(sessionData));

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await runKeepAlive();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipped (no tokens or credentials')
    );

    consoleErrorSpy.mockRestore();
  });
});
