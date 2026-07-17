import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import https from 'https';
import dns from 'dns/promises';
import { fileURLToPath } from 'url';

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  accountId: string;
  clientId: string;
}

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

/**
 * Helper to get ISO timestamp for logs
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Log message helper
 */
function logInfo(msg: string) {
  console.error(`[${getTimestamp()}] 🔄 [Keepalive] ${msg}`);
}

function logSuccess(msg: string) {
  console.error(`[${getTimestamp()}] ✅ [Keepalive] ${msg}`);
}

function logWarn(msg: string) {
  console.error(`[${getTimestamp()}] ⚠️  [Keepalive] ${msg}`);
}

function logError(msg: string) {
  console.error(`[${getTimestamp()}] ❌ [Keepalive] ${msg}`);
}

/**
 * Format NetSuite Account ID to API host format (e.g. 9260916_SB1 -> 9260916-sb1)
 */
function formatNetSuiteAccountHost(accountId: string): string {
  return accountId.toLowerCase().replace(/_/g, '-');
}

/**
 * Checks if basic network connectivity is up by resolving a well-known NetSuite API hostname.
 * Prevents firing token requests right as macOS wakes up from sleep when Wi-Fi/TLS socket is not yet ready.
 */
async function checkNetworkReadiness(timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    await dns.lookup('suitetalk.api.netsuite.com');
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

/**
 * File lock acquisition
 */
async function acquireLock(lockPath: string, timeoutMs = 25000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.mkdir(lockPath);
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        try {
          const stats = await fs.stat(lockPath);
          const age = Date.now() - stats.mtimeMs;
          if (age > 20000) {
            logWarn(`Lock is stale (${Math.round(age / 1000)}s old), breaking lock: ${lockPath}`);
            await fs.rmdir(lockPath);
            continue;
          }
        } catch {
          // stats failed, maybe lock was just released
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      } else {
        throw err;
      }
    }
  }
  return false;
}

/**
 * File lock release
 */
async function releaseLock(lockPath: string): Promise<void> {
  try {
    await fs.rmdir(lockPath);
  } catch (err) {
    // Ignore release errors
  }
}

/**
 * Performs HTTP POST using standard Node.js https module
 */
function postRequest(urlStr: string, body: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    };

    const req = https.request(url, options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          data: responseBody,
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Performs token refresh call to NetSuite token endpoint
 */
async function refreshTokens(
  accountId: string,
  clientId: string,
  refreshToken: string
): Promise<Partial<TokenData>> {
  const accountHost = formatNetSuiteAccountHost(accountId);
  const tokenUrl = `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString();

  // Retry up to 4 times with exponential backoff on transient errors
  let attempt = 0;
  const maxAttempts = 4;
  let lastTransientError: string | null = null;

  while (true) {
    attempt++;
    try {
      const res = await postRequest(tokenUrl, body);
      if (res.status === 200) {
        const payload = JSON.parse(res.data);
        return {
          access_token: String(payload.access_token),
          refresh_token: payload.refresh_token ? String(payload.refresh_token) : refreshToken,
          expires_in: Number(payload.expires_in),
        };
      }
      
      const errorMsg = `HTTP ${res.status}: ${res.data}`;
      if (res.status === 400 || res.status === 401) {
        // If we just suffered a network/TLS socket disconnect on attempt 1, and on attempt 2 we get HTTP 400,
        // it means NetSuite likely processed the rotation during the dropped socket.
        if (lastTransientError) {
          throw new Error(`Unrecoverable (post-network-drop rotation mismatch): ${errorMsg} (Prior network error: ${lastTransientError})`);
        }
        throw new Error(`Unrecoverable error refreshing tokens: ${errorMsg}`);
      }

      if (attempt < maxAttempts) {
        const delay = Math.min(3000 * Math.pow(2, attempt - 1), 20000);
        logWarn(`Transient refresh error (${errorMsg}). Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error(`Failed after ${maxAttempts} attempts: ${errorMsg}`);
    } catch (err: any) {
      if (attempt < maxAttempts && !err.message.includes('Unrecoverable')) {
        lastTransientError = err.message;
        const delay = Math.min(3000 * Math.pow(2, attempt - 1), 20000);
        logWarn(`Transient refresh exception (${err.message}). Retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Scans directories and runs the keepalive daemon logic once
 */
export async function runKeepAlive(): Promise<void> {
  logInfo('Starting token keepalive execution scan...');

  // Wait for network readiness (especially critical immediately after wake from sleep)
  // Skip during unit tests to avoid DNS lookup timeout when testing local file processing
  if (!process.env.DAEMON_SESSION_ROOTS && !process.env.JEST_WORKER_ID && process.env.NODE_ENV !== 'test') {
    if (!(await checkNetworkReadiness())) {
      logWarn('Network not ready right after wake/startup. Waiting 10s for Wi-Fi/TLS stabilization...');
      await new Promise((resolve) => setTimeout(resolve, 10000));
      if (!(await checkNetworkReadiness())) {
        logWarn('Network still unreachable after wait. Proceeding with scan with resilient backoff...');
      } else {
        logSuccess('Network stabilized!');
      }
    }
  }

  let sessionRoots: string[] = [];
  if (process.env.DAEMON_SESSION_ROOTS) {
    sessionRoots = process.env.DAEMON_SESSION_ROOTS.split(',').map(p => p.trim());
  } else {
    sessionRoots = [path.join(os.homedir(), '.gemini', 'antigravity', 'sessions')];
  }

  let totalAccounts = 0;
  let refreshedAccounts = 0;
  let skippedAccounts = 0;
  let failedAccounts = 0;

  for (const root of sessionRoots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory());

      for (const dir of dirs) {
        const accountId = dir.name;
        const sessionDir = path.join(root, accountId);
        const sessionFile = path.join(sessionDir, 'session.json');

        try {
          await fs.access(sessionFile);
        } catch {
          // No session file, skip
          continue;
        }

        totalAccounts++;
        let lockAcquired = false;
        const lockPath = path.join(sessionDir, 'session.lock');

        try {
          // Read session file (unlocked read for quick check)
          const content = await fs.readFile(sessionFile, 'utf-8');
          const session = JSON.parse(content) as SessionData;

          if (!session.tokens || !session.config || !session.tokens.refresh_token) {
            logInfo(`[${accountId}] Skipped (no tokens or credentials in session file)`);
            skippedAccounts++;
            continue;
          }

          // Check if token has passed 25% of its lifetime (i.e., less than 75% remaining), or if authenticated is false
          const tokens = session.tokens;
          const timeUntilExpiry = tokens.expires_at - Date.now();
          const refreshThreshold = (tokens.expires_in * 1000) * 0.75;
          const needsRefresh = timeUntilExpiry < refreshThreshold || !session.authenticated;

          if (!needsRefresh) {
            const timeStr = Math.round(timeUntilExpiry / 1000);
            logInfo(`[${accountId}] Skipped (token is still fresh, expires in ${timeStr}s)`);
            skippedAccounts++;
            continue;
          }

          logInfo(`[${accountId}] Needs refresh (expiry in ${Math.round(timeUntilExpiry / 1000)}s, authenticated: ${session.authenticated}). Acquiring lock...`);

          lockAcquired = await acquireLock(lockPath);
          if (!lockAcquired) {
            logWarn(`[${accountId}] Could not acquire session lock, skipping this round...`);
            failedAccounts++;
            continue;
          }

          // Re-load under lock
          const lockedContent = await fs.readFile(sessionFile, 'utf-8');
          const lockedSession = JSON.parse(lockedContent) as SessionData;

          if (!lockedSession.tokens || !lockedSession.config) {
            skippedAccounts++;
            continue;
          }

          const currentTokens = lockedSession.tokens;
          const currentExpiry = currentTokens.expires_at - Date.now();
          if (currentExpiry >= refreshThreshold && lockedSession.authenticated) {
            logInfo(`[${accountId}] Session refreshed by another process concurrently`);
            skippedAccounts++;
            continue;
          }

          logInfo(`[${accountId}] Refreshing token...`);
          const newTokens = await refreshTokens(
            lockedSession.config.accountId,
            lockedSession.config.clientId,
            currentTokens.refresh_token
          );

          const updatedTokens: TokenData = {
            ...currentTokens,
            access_token: newTokens.access_token!,
            refresh_token: newTokens.refresh_token!,
            expires_in: newTokens.expires_in!,
            expires_at: Date.now() + newTokens.expires_in! * 1000,
          };

          const updatedSession: SessionData = {
            ...lockedSession,
            tokens: updatedTokens,
            authenticated: true,
          };

          // Save atomic
          const tempFile = `${sessionFile}.tmp`;
          await fs.writeFile(tempFile, JSON.stringify(updatedSession, null, 2), { mode: 0o600 });
          await fs.chmod(tempFile, 0o600);
          await fs.rename(tempFile, sessionFile);

          logSuccess(`[${accountId}] Token refreshed successfully!`);
          refreshedAccounts++;
        } catch (err: any) {
          logError(`[${accountId}] Failed during refresh operation: ${err.message}`);
          failedAccounts++;
          // If refresh token is truly expired and not caused by a post-network-drop rotation mismatch, mark session unauthenticated
          try {
            if (err.message.includes('Unrecoverable') && !err.message.includes('post-network-drop rotation mismatch')) {
              const fileContent = await fs.readFile(sessionFile, 'utf-8');
              const session = JSON.parse(fileContent) as SessionData;
              if (session.authenticated !== false) {
                session.authenticated = false;
                await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), { mode: 0o600 });
                logWarn(`[${accountId}] Session marked unauthenticated due to unrecoverable token expiration.`);
              }
            } else if (err.message.includes('post-network-drop rotation mismatch')) {
              logWarn(`[${accountId}] Preserving session configuration despite network drop rotation mismatch. Will attempt auto-recovery next round.`);
            }
          } catch {
            // Ignore sub-errors
          }
        } finally {
          if (lockAcquired) {
            await releaseLock(lockPath);
          }
        }
      }
    } catch (err: any) {
      logError(`Failed to scan root directory "${root}": ${err.message}`);
    }
  }

  logInfo(`Keepalive scan finished. Accounts: ${totalAccounts} total | ${refreshedAccounts} refreshed | ${skippedAccounts} skipped | ${failedAccounts} failed.`);
}

// Execute if run directly
const nodePath = process.argv[1];
if (nodePath && (nodePath.endsWith('keepalive.js') || nodePath.endsWith('keepalive.ts'))) {
  void runKeepAlive();
}
