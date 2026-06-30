import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';

import { SessionStorage } from './sessionStorage.js';


describe('SessionStorage', () => {
  const testStoragePath = path.join(process.cwd(), '.test-session-storage');
  const sessionFile = path.join(testStoragePath, 'session.json');
  let sessionStorage: SessionStorage;

  beforeEach(async () => {
    // Clean up any existing directory
    await fs.rm(testStoragePath, { recursive: true, force: true });
    sessionStorage = new SessionStorage(testStoragePath);
  });

  afterEach(async () => {
    // Clean up afterwards
    await fs.rm(testStoragePath, { recursive: true, force: true });
  });

  describe('save', () => {
    it('should create directory and write session file correctly', async () => {
      const mockData = { authenticated: true, tokens: { access_token: '123' } };
      
      await sessionStorage.save(mockData);

      // Verify directory was created and file exists
      const fileExists = await fs.stat(sessionFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);

      // Verify content
      const content = await fs.readFile(sessionFile, 'utf-8');
      expect(JSON.parse(content)).toEqual(mockData);
    });
  });

  describe('load', () => {
    it('should load and parse session file if it exists', async () => {
      const mockData = { authenticated: true, tokens: { access_token: 'abc' } };
      
      // Manually set up session
      await fs.mkdir(testStoragePath, { recursive: true });
      await fs.writeFile(sessionFile, JSON.stringify(mockData), 'utf-8');

      const result = await sessionStorage.load();
      expect(result).toEqual(mockData);
    });

    it('should return null if session file does not exist', async () => {
      const result = await sessionStorage.load();
      expect(result).toBeNull();
    });

    it('should rename corrupted session file instead of deleting it', async () => {
      // Setup file with invalid JSON content
      await fs.mkdir(testStoragePath, { recursive: true });
      await fs.writeFile(sessionFile, 'invalid-json-content', 'utf-8');

      const result = await sessionStorage.load();
      expect(result).toBeNull();

      // Verify session file no longer exists (it was renamed)
      const fileExists = await fs.stat(sessionFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);

      // Verify a backup corrupted file was created in the storage directory
      const files = await fs.readdir(testStoragePath);
      const corruptedFile = files.find(f => f.startsWith('session.corrupted.'));
      expect(corruptedFile).toBeDefined();

      const corruptedContent = await fs.readFile(path.join(testStoragePath, corruptedFile!), 'utf-8');
      expect(corruptedContent).toBe('invalid-json-content');
    });
  });

  describe('clear', () => {
    it('should unlink the session file', async () => {
      // Setup file
      await fs.mkdir(testStoragePath, { recursive: true });
      await fs.writeFile(sessionFile, '{}', 'utf-8');

      let fileExists = await fs.stat(sessionFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);

      await sessionStorage.clear();

      fileExists = await fs.stat(sessionFile).then(() => true).catch(() => false);
      expect(fileExists).toBe(false);
    });

    it('should suppress error if session file does not exist', async () => {
      await expect(sessionStorage.clear()).resolves.toBeUndefined();
    });
  });

  describe('isAuthenticated', () => {
    it('should return true if session is authenticated and has tokens', async () => {
      const mockData = { authenticated: true, tokens: { access_token: 'xyz' } };
      await sessionStorage.save(mockData);

      const authenticated = await sessionStorage.isAuthenticated();
      expect(authenticated).toBe(true);
    });

    it('should return false if session is not authenticated', async () => {
      const mockData = { authenticated: false, tokens: { access_token: 'xyz' } };
      await sessionStorage.save(mockData);

      const authenticated = await sessionStorage.isAuthenticated();
      expect(authenticated).toBe(false);
    });

    it('should return false if session does not have tokens', async () => {
      const mockData = { authenticated: true };
      await sessionStorage.save(mockData);

      const authenticated = await sessionStorage.isAuthenticated();
      expect(authenticated).toBe(false);
    });

    it('should return false if session storage is empty', async () => {
      const authenticated = await sessionStorage.isAuthenticated();
      expect(authenticated).toBe(false);
    });
  });
});
