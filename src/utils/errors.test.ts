import { describe, it, expect } from '@jest/globals';
import { parseNetSuiteError, sanitizeMessage, sanitizeError } from './errors.js';

describe('Error Utilities', () => {
  describe('sanitizeMessage', () => {
    it('should redact sensitive OAuth parameters and tokens', () => {
      const original = 'Failed: Bearer target_token_xyz&refresh_token=refresh_123&client_id=client_987&code_verifier=verifier_abc';
      const expected = 'Failed: Bearer [REDACTED]&refresh_token=[REDACTED]&client_id=[REDACTED]&code_verifier=[REDACTED]';
      expect(sanitizeMessage(original)).toBe(expected);
    });

    it('should redact tokens from json strings', () => {
      const original = '{"access_token" : "some_secret_token", "refresh_token":"another_secret"}';
      const expected = '{"access_token":"[REDACTED]", "refresh_token":"[REDACTED]"}';
      expect(sanitizeMessage(original)).toBe(expected);
    });

    it('should redact local home and users paths', () => {
      const original = 'Error occurred at /Users/fuxintao/WebstormProjects/NetsuiteMcp/src/index.ts';
      expect(sanitizeMessage(original)).toContain('<PROJECT_ROOT>/src/index.ts');
    });
  });

  describe('parseNetSuiteError', () => {
    it('should handle standard NetSuite o:errorDetails array', () => {
      const mockError = {
        response: {
          status: 400,
          data: {
            'o:errorDetails': [
              {
                'o:errorCode': 'INVALID_SQL',
                'detail': 'Syntax error in SuiteQL query.'
              }
            ]
          }
        }
      };

      const result = parseNetSuiteError(mockError);
      expect(result.message).toContain('NetSuite API Error: [INVALID_SQL] Syntax error in SuiteQL query.');
      expect(result.message).toContain('Troubleshooting Advice - SuiteQL/SQL');
    });

    it('should parse OAuth error responses', () => {
      const mockError = {
        response: {
          status: 400,
          data: {
            error: 'invalid_grant',
            error_description: 'Refresh token has expired.'
          }
        }
      };

      const result = parseNetSuiteError(mockError);
      expect(result.message).toContain('OAuth Error [invalid_grant]: Refresh token has expired.');
    });

    it('should truncate HTML error pages', () => {
      const html = '<!DOCTYPE html><html><head><title>504 Gateway Timeout</title></head><body>Timeout</body></html>';
      const mockError = {
        response: {
          status: 504,
          statusText: 'Gateway Timeout',
          data: html
        }
      };

      const result = parseNetSuiteError(mockError);
      expect(result.message).toContain('HTTP 504 (Gateway Timeout)');
      expect(result.message).toContain('Title: "504 Gateway Timeout"');
      expect(result.message).not.toContain('<body>Timeout</body>');
    });

    it('should fall back to standard response status message', () => {
      const mockError = {
        response: {
          status: 403,
          statusText: 'Forbidden'
        },
        message: 'Request failed with 403'
      };

      const result = parseNetSuiteError(mockError);
      expect(result.message).toContain('HTTP 403: Request failed with 403');
    });
  });

  describe('sanitizeError', () => {
    it('should extract NetSuite error details and redact stack traces', () => {
      const innerErr = new Error('Auth error with Bearer token_xyz');
      innerErr.stack = 'at Object.test (/Users/fuxintao/test.ts:1:1)';

      const result = sanitizeError(innerErr);
      expect(result.message).toBe('Auth error with Bearer [REDACTED]');
      expect(result.stack).toContain('/Users/<USER>/test.ts');
    });
  });
});
