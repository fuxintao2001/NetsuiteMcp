import { parseNetSuiteError } from './errors.js';

describe('parseNetSuiteError', () => {
  it('should parse NetSuite o:errorDetails structure and append advice', () => {
    const apiError = {
      response: {
        data: {
          'o:errorDetails': [
            {
              'o:errorCode': 'INVALID_SEARCH_SELECT_FIELD',
              detail: 'The field "internalid" is invalid.'
            }
          ]
        }
      }
    };
    const parsed = parseNetSuiteError(apiError);
    expect(parsed.message).toContain('NetSuite API Error: [INVALID_SEARCH_SELECT_FIELD] The field "internalid" is invalid.');
    expect(parsed.message).toContain('[Troubleshooting Advice - SuiteQL/SQL]');
    expect(parsed.message).toContain('Primary keys are usually "id" (not "internalid")');
  });

  it('should parse NetSuite permission error and append permission advice', () => {
    const apiError = {
      response: {
        data: {
          'o:errorDetails': [
            {
              'o:errorCode': 'INSUFFICIENT_PERMISSION',
              detail: 'You do not have permission to view this record.'
            }
          ]
        }
      }
    };
    const parsed = parseNetSuiteError(apiError);
    expect(parsed.message).toContain('INSUFFICIENT_PERMISSION');
    expect(parsed.message).toContain('[Troubleshooting Advice - Permissions]');
  });

  it('should handle HTML responses by truncating them and extracting title', () => {
    const htmlError = {
      response: {
        status: 502,
        statusText: 'Bad Gateway',
        data: `
          <!DOCTYPE html>
          <html>
            <head>
              <title>502 Bad Gateway - Cloudflare</title>
            </head>
            <body>
              <h1>502 Bad Gateway</h1>
            </body>
          </html>
        `
      }
    };
    const parsed = parseNetSuiteError(htmlError);
    expect(parsed.message).toBe('HTTP 502 (Bad Gateway): Server returned HTML response instead of JSON. Title: "502 Bad Gateway - Cloudflare" (Truncated raw HTML)');
  });

  it('should fallback to HTTP status if response body is empty', () => {
    const simpleHttpError = {
      response: {
        status: 403,
        message: 'Forbidden'
      }
    };
    const parsed = parseNetSuiteError(simpleHttpError);
    expect(parsed.message).toContain('HTTP 403');
    expect(parsed.message).toContain('[Troubleshooting Advice - Permissions]');
  });

  it('should return standard error message if not an HTTP error', () => {
    const standardError = new Error('Generic file error');
    const parsed = parseNetSuiteError(standardError);
    expect(parsed.message).toBe('Generic file error');
  });
});
