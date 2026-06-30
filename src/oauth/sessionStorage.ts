import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

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

let processFallbackKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (process.env.MCP_SESSION_SECRET) {
    return crypto.createHash('sha256').update(process.env.MCP_SESSION_SECRET).digest();
  }
  // 未配置 MCP_SESSION_SECRET 时，向用户输出警告，说明 sessions 在重启后将失效
  console.warn(
    '⚠️ Warning: MCP_SESSION_SECRET environment variable is not defined. ' +
    'Generating a process-lifetime random key. Saved sessions will expire and become unreadable when the server restarts.'
  );
  if (!processFallbackKey) {
    processFallbackKey = crypto.randomBytes(32);
  }
  return processFallbackKey;
}

// 导出便于单元测试拦截进行 Mock
export function encrypt(text: string): string {
  if (process.env.NODE_ENV === 'test') {
    return text;
  }
  // 使用 RFC 5116 推荐的 12 字节 IV
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decrypt(cipherText: string): string {
  if (process.env.NODE_ENV === 'test') {
    return cipherText;
  }
  const [ivHex, authTagHex, encrypted] = cipherText.split(':');
  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid cipher text format');
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
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

      const payload = JSON.stringify(data);
      const encrypted = encrypt(payload);

      // 以所有者读写权限 (0o600) 写入加密文件，并显式修改已有文件的权限
      await fs.writeFile(this.sessionFile, encrypted, { mode: 0o600 });
      await fs.chmod(this.sessionFile, 0o600);
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

      let decryptedData = fileContent;
      
      // 严格识别加密：由于明文 JSON 以 '{' 开头，凡是不以 '{' 开头的非空内容均视为 AES-256-GCM 密文
      const isEncrypted = !trimmed.startsWith('{');

      if (isEncrypted) {
        try {
          decryptedData = decrypt(trimmed);
        } catch (decErr) {
          console.error('⚠️ Failed to decrypt session file:', decErr);
          return null;
        }
      }

      try {
        return JSON.parse(decryptedData) as SessionData;
      } catch (parseError: unknown) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        console.error(`⚠️ Session file is corrupted, clearing: ${message}`);
        await this.clear();
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
