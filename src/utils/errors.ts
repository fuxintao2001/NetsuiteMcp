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

    // 1. Check for NetSuite o:errorDetails structure
    if (data && typeof data === 'object') {
      const errorDetails = data['o:errorDetails'] || data.o_errorDetails;
      if (Array.isArray(errorDetails)) {
        const details = errorDetails
          .map((d: NetSuiteErrorDetail) => {
            const code = d['o:errorCode'] || d.o_errorCode || 'ERROR';
            const msg = d.detail || d.message || '';
            return `[${code}] ${msg}`;
          })
          .filter(Boolean)
          .join('; ');

        if (details) {
          return new Error(`NetSuite API Error: ${details}`);
        }
      }

      // 2. Check for OAuth error structure (standard OAuth 2.0 error body)
      if (data.error) {
        const errCode = data.error;
        const errDesc = data.error_description || data.errorDescription || '';
        return new Error(`OAuth Error [${errCode}]: ${errDesc || 'No details provided'}`);
      }

      // 3. Check if it's general JSON but doesn't match above, serialize it
      try {
        return new Error(`NetSuite Error Response: ${JSON.stringify(data)}`);
      } catch {
        // Ignore serialization failure
      }
    }
  }

  // 4. Fallback if it is an Axios error with status but no response body details
  if (err.response?.status) {
    return new Error(`HTTP ${err.response.status}: ${err.message || 'Request failed'}`);
  }

  // 5. Fallback to standard error or String representation
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
