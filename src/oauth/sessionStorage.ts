import fs from 'fs/promises';
import path from 'path';

export interface SessionData {
  pkce?: string | null;
  state?: string;
  config?: {
    accountId: string;
    clientId: string;
    redirectUri: string;
  };
  tokens?: TokenData;
  timestamp?: number;
  authenticated?: boolean;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  accountId: string;
  clientId: string;
}

/**
 * Session storage for OAuth tokens
 * Handles reading and writing session data to disk
 */
export class SessionStorage {
  private storagePath: string;
  private sessionFile: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.sessionFile = path.join(storagePath, 'session.json');
  }

  /**
   * Get storage path
   */
  getStoragePath(): string {
    return this.storagePath;
  }

  /**
   * Clear session file
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.sessionFile);
    } catch {
      // Ignored
    }
  }

  /**
   * Save session data to file
   */
  async save(data: SessionData): Promise<void> {
    try {
      await fs.mkdir(this.storagePath, { recursive: true });
      // 限制父目录权限为 0o700 (所有者读写执行)
      await fs.chmod(this.storagePath, 0o700).catch(() => {});

      const tempFile = `${this.sessionFile}.tmp`;
      // 以明文 JSON 持久化 session，保证本地 MCP 服务重启后仍可复用 refresh token。
      await fs.writeFile(tempFile, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.chmod(tempFile, 0o600);
      await fs.rename(tempFile, this.sessionFile);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('❌ Failed to save session:', message);
      throw error;
    }
  }

  /**
   * Load session data from file
   */
  async load(): Promise<SessionData | null> {
    try {
      const fileContent = await fs.readFile(this.sessionFile, 'utf-8');
      const trimmed = fileContent.trim();
      if (!trimmed) return null;

      try {
        return JSON.parse(fileContent) as SessionData;
      } catch (parseError: unknown) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        const corruptedBackup = path.join(
          this.storagePath,
          `session.corrupted.${Date.now()}.json`
        );
        console.error(`⚠️ Session file is corrupted, renaming to ${path.basename(corruptedBackup)}: ${message}`);
        try {
          await fs.rename(this.sessionFile, corruptedBackup);
        } catch (renameError) {
          console.error('⚠️ Failed to rename corrupted session file:', renameError);
          await this.clear(); // fallback to delete if rename fails
        }
        return null;
      }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return null; // Session file doesn't exist
      }
      throw error;
    }
  }

  /**
   * Check if session exists and is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    try {
      const session = await this.load();
      return !!(session && session.authenticated && session.tokens);
    } catch {
      return false;
    }
  }

  /**
   * Touch heartbeat file to signal that an active MCP server instance is actively maintaining this session.
   */
  async touchHeartbeat(): Promise<void> {
    try {
      await fs.mkdir(this.storagePath, { recursive: true });
      const heartbeatFile = path.join(this.storagePath, 'session.heartbeat');
      await fs.writeFile(heartbeatFile, String(Date.now()), { mode: 0o600 });
    } catch {
      // Ignored
    }
  }

  /**
   * Check if the session heartbeat is fresh (e.g. updated within maxAgeMs).
   */
  async isHeartbeatFresh(maxAgeMs = 120000): Promise<boolean> {
    try {
      const heartbeatFile = path.join(this.storagePath, 'session.heartbeat');
      const content = await fs.readFile(heartbeatFile, 'utf-8');
      const lastBeat = parseInt(content.trim(), 10);
      if (isNaN(lastBeat)) return false;
      return Date.now() - lastBeat < maxAgeMs;
    } catch {
      return false;
    }
  }
}

