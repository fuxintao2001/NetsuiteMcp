/**
 * NetSuite error response detail structure
 */
interface NetSuiteErrorDetail {
  detail?: string;
  message?: string;
  'o:errorCode'?: string;
  o_errorCode?: string;
}

/**
 * Returns actionable advice for common NetSuite errors to assist the AI agent.
 */
function getActionableAdvice(code: string, message: string): string {
  const normalizedCode = code.toUpperCase();
  const normalizedMessage = message.toLowerCase();

  // SuiteQL / SQL / Field name errors
  if (
    normalizedCode.includes('INVALID_SEARCH_SELECT_FIELD') ||
    normalizedCode.includes('INVALID_SQL') ||
    normalizedMessage.includes('sql') ||
    normalizedMessage.includes('select') ||
    normalizedMessage.includes('query')
  ) {
    let advice = '\n💡 [Troubleshooting Advice - SuiteQL/SQL]:';
    advice += '\n  - Ensure you explicitly list all required fields (do NOT use "SELECT *").';
    advice += '\n  - Make sure all table and field names match the NetSuite Schema exactly (case-sensitive).';
    advice += '\n  - Note: Primary keys are usually "id" (not "internalid").';
    advice += '\n  - Note: Date parameters must use TO_DATE(\'YYYY-MM-DD\', \'YYYY-MM-DD\') formatted strings.';
    advice += '\n  - Note: "LIMIT" is not supported. Use "FETCH FIRST N ROWS ONLY" for pagination.';
    advice += '\n  - Recommended: Call `ns_getSuiteQLMetadata` to verify the table schema before querying.';
    return advice;
  }

  // Permissions / Access errors
  if (
    normalizedCode.includes('INSUFFICIENT_PERMISSION') ||
    normalizedCode.includes('PERMISSION') ||
    normalizedMessage.includes('permission') ||
    normalizedMessage.includes('privilege') ||
    normalizedMessage.includes('access denied')
  ) {
    let advice = '\n💡 [Troubleshooting Advice - Permissions]:';
    advice += '\n  - Check that the active integration role has "Web Services" and "REST Web Services" permissions enabled.';
    advice += '\n  - Verify that the active role has permissions to view/modify the target record type.';
    return advice;
  }

  // Concurrency / Rate limit errors
  if (
    normalizedCode.includes('LIMIT_EXCEEDED') ||
    normalizedCode.includes('CONCURRENT') ||
    normalizedMessage.includes('concurrent') ||
    normalizedMessage.includes('too many requests')
  ) {
    let advice = '\n💡 [Troubleshooting Advice - Concurrency]:';
    advice += '\n  - You have exceeded NetSuite\'s concurrent request limit.';
    advice += '\n  - Recommended: For multiple independent SuiteQL queries, use `netsuite_run_parallel_queries` to run them concurrently (up to 5).';
    advice += '\n  - Otherwise, reduce the frequency of your requests or add retries.';
    return advice;
  }

  return '';
}

/**
 * Parses axios or generic error into a readable NetSuite-specific error message.
 */
export function parseNetSuiteError(error: unknown): Error {
  if (!error) {
    return new Error('Unknown error');
  }

  const err = error as any;

  // Check if error has response data (AxiosError structure)
  if (err.response?.data) {
    const data = err.response.data;

    // Detect HTML response and truncate to avoid raw HTML dump in context window
    if (
      typeof data === 'string' &&
      (data.includes('<!DOCTYPE html>') || data.includes('<html') || data.includes('<HTML'))
    ) {
      const status = err.response.status || 'Unknown';
      const statusText = err.response.statusText || '';
      const titleMatch = data.match(/<title>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';
      return new Error(
        `HTTP ${status} (${statusText || 'Error'}): Server returned HTML response instead of JSON. ${
          title ? `Title: "${title}"` : ''
        } (Truncated raw HTML)`
      );
    }

    // 1. Check for NetSuite o:errorDetails structure
    if (data && typeof data === 'object') {
      const errorDetails = data['o:errorDetails'] || data.o_errorDetails;
      if (Array.isArray(errorDetails)) {
        let advice = '';
        const details = errorDetails
          .map((d: NetSuiteErrorDetail) => {
            const code = d['o:errorCode'] || d.o_errorCode || 'ERROR';
            const msg = d.detail || d.message || '';
            const itemAdvice = getActionableAdvice(code, msg);
            if (itemAdvice && !advice.includes(itemAdvice)) {
              advice += itemAdvice;
            }
            return `[${code}] ${msg}`;
          })
          .filter(Boolean)
          .join('; ');

        if (details) {
          return new Error(`NetSuite API Error: ${details}${advice}`);
        }
      }

      // 2. Check for OAuth error structure (standard OAuth 2.0 error body)
      if (data.error) {
        const errCode = data.error;
        const errDesc = data.error_description || data.errorDescription || '';
        const advice = getActionableAdvice(errCode, errDesc);
        return new Error(`OAuth Error [${errCode}]: ${errDesc || 'No details provided'}${advice}`);
      }

      // 3. Check if it's general JSON but doesn't match above, serialize it
      try {
        const advice = getActionableAdvice(data.code || '', data.message || '');
        return new Error(`NetSuite Error Response: ${JSON.stringify(data)}${advice}`);
      } catch {
        // Ignore serialization failure
      }
    }
  }

  // 4. Fallback if it is an Axios error with status but no response body details
  if (err.response?.status) {
    const status = err.response.status;
    let advice = '';
    if (status === 429) {
      advice = '\n💡 [Troubleshooting Advice - Concurrency]:\n  - You have exceeded NetSuite\'s concurrent request limit.\n  - Recommended: Use `netsuite_run_parallel_queries` or reduce request frequency.';
    } else if (status === 403) {
      advice = '\n💡 [Troubleshooting Advice - Permissions]:\n  - Access denied. Verify authentication status and permissions.';
    }
    return new Error(`HTTP ${status}: ${err.message || 'Request failed'}${advice}`);
  }

  // 5. Fallback to standard error or String representation
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

