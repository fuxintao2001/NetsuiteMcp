import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SessionStorage, type SessionData } from './sessionStorage.js';
import fs from 'fs/promises';
import path from 'path';

describe('SessionStorage', () => {
  const tempDir = path.join(process.cwd(), '.test-session-storage');
  let storage: SessionStorage;

  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    storage = new SessionStorage(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should return null if session file does not exist', async () => {
    const data = await storage.load();
    expect(data).toBeNull();
  });

  it('should save and load session data correctly', async () => {
    const session: SessionData = {
      authenticated: true,
      state: 'state-123',
      tokens: {
        access_token: 'access-tok',
        refresh_token: 'refresh-tok',
        expires_in: 3600,
        expires_at: Date.now() + 3600000,
        accountId: '123456',
        clientId: 'client-123'
      }
    };

    await storage.save(session);
    const loaded = await storage.load();
    expect(loaded).toEqual(session);
    expect(await storage.isAuthenticated()).toBe(true);
  });

  it('should clear the session file', async () => {
    const session: SessionData = { authenticated: true };
    await storage.save(session);
    expect(await storage.load()).toEqual(session);

    await storage.clear();
    expect(await storage.load()).toBeNull();
    expect(await storage.isAuthenticated()).toBe(false);
  });

  it('should back up and return null if the session file is corrupted JSON', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const sessionFile = path.join(tempDir, 'session.json');
    await fs.writeFile(sessionFile, '{ corrupted json : ', 'utf-8');

    const loaded = await storage.load();
    expect(loaded).toBeNull();

    // Check that a corrupted backup file was created
    const files = await fs.readdir(tempDir);
    const backupFile = files.find(f => f.startsWith('session.corrupted.'));
    expect(backupFile).toBeDefined();
  });
});
