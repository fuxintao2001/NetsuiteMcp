import { httpClient } from '../utils/httpClient.js';
import type { TokenData } from './sessionStorage.js';
import { parseNetSuiteError } from '../utils/errors.js';
import { formatNetSuiteAccountHost } from '../utils/environment.js';
import { retryWithBackoff } from '../utils/resilience.js';
import { z } from 'zod';

const TokenApiResponseSchema = z.object({
  access_token: z.string().min(1, 'access_token is empty or missing'),
  refresh_token: z.string().optional(),
  expires_in: z.union([z.number(), z.string().transform((v) => parseInt(v, 10))]),
});

/**
 * NetSuite OAuth token exchange utilities
 * Handles token exchange and refresh operations
 */

/**
 * Custom error class for token refresh failures.
 * `recoverable` indicates whether the caller should retry or force re-authentication.
 */
export class TokenRefreshError extends Error {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = 'TokenRefreshError';
    this.recoverable = recoverable;
  }
}

interface OAuthConfig {
  accountId: string;
  clientId: string;
  redirectUri: string;
}

function isRetryableTokenError(error: unknown): boolean {
  const err = error as { code?: string; message?: string; response?: { status?: number } };
  if (err.code === 'ECONNABORTED' || err.message?.includes('Network Error')) {
    return true;
  }

  const status = err.response?.status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function postTokenRequest(
  tokenUrl: string,
  params: Record<string, string>
): Promise<{ data: Record<string, unknown> }> {
  return retryWithBackoff(
    () => httpClient.post(tokenUrl, new URLSearchParams(params), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    }),
    isRetryableTokenError,
    {
      retries: 3,
      minTimeoutMs: 1000,
      maxTimeoutMs: 8000,
      factor: 2,
      jitter: true
    },
    (error: unknown, attempt: number, delayMs: number) => {
      const parsed = parseNetSuiteError(error);
      console.error(
        `⚠️ Token endpoint retry ${attempt} in ${Math.round(delayMs)}ms: ${parsed.message}`
      );
    }
  );
}

/**
 * Exchange authorization code for access/refresh tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  config: OAuthConfig,
  codeVerifier: string
): Promise<TokenData> {
  const accountHost = formatNetSuiteAccountHost(config.accountId);
  const tokenUrl = `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  // CRITICAL: For Public Client with PKCE - all params in body, NO Authorization header
  const params = {
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier
  };

  console.error('🔄 Exchanging authorization code for tokens...');

  try {
    const response = await postTokenRequest(tokenUrl, params);
    const parsedData = TokenApiResponseSchema.parse(response.data);

    const tokens: TokenData = {
      access_token: parsedData.access_token,
      refresh_token: parsedData.refresh_token || '',
      expires_in: parsedData.expires_in,
      expires_at: Date.now() + (parsedData.expires_in * 1000),
      accountId: config.accountId,
      clientId: config.clientId
    };

    console.error('✅ Tokens obtained successfully');
    return tokens;

  } catch (error: unknown) {
    const parsed = parseNetSuiteError(error);
    console.error('❌ Token exchange error:', parsed.message);
    throw new Error(`Failed to exchange authorization code: ${parsed.message}`);
  }
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(tokens: TokenData): Promise<TokenData> {
  const { refresh_token, accountId, clientId } = tokens;
  const accountHost = formatNetSuiteAccountHost(accountId);
  const tokenUrl = `https://${accountHost}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

  // For Public Client: include client_id in body
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refresh_token,
    client_id: clientId
  };

  console.error('🔄 Refreshing access token...');

  try {
    const response = await postTokenRequest(tokenUrl, params);
    const parsedData = TokenApiResponseSchema.parse(response.data);

    const newTokens: TokenData = {
      ...tokens,
      access_token: parsedData.access_token,
      refresh_token: parsedData.refresh_token ? parsedData.refresh_token : refresh_token,
      expires_in: parsedData.expires_in,
      expires_at: Date.now() + (parsedData.expires_in * 1000)
    };

    console.error('✅ Token refreshed successfully');
    return newTokens;

  } catch (error: unknown) {
    const parsed = parseNetSuiteError(error);
    console.error('❌ Token refresh failed:', parsed.message);
    const err = error as { response?: { status?: number } };
    const status = err.response?.status;
    // 400/401 means the refresh_token itself is invalid/expired — unrecoverable
    const recoverable = !(status === 400 || status === 401);
    throw new TokenRefreshError(
      `Failed to refresh access token: ${parsed.message}. Please re-authenticate.`,
      recoverable
    );
  }
}

/**
 * Check if token needs refresh (expires in less than 75% of lifetime, e.g. < 45 minutes remaining for a 60m token)
 */
export function shouldRefreshToken(tokens: TokenData): boolean {
  const timeUntilExpiry = tokens.expires_at - Date.now();
  const threshold = (tokens.expires_in * 1000) * 0.75;
  return timeUntilExpiry < threshold;
}
