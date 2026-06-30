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
   * Clear session file (logout)
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.sessionFile);
      console.error('✅ Session cleared');
    } catch {
      // Session file doesn't exist, ignore
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
}
