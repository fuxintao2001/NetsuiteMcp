import http from 'http';

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return map[m] || m;
  });
}

/**
 * OAuth callback server for receiving authorization codes.
 * Handles the redirect from NetSuite after user authentication.
 *
 * Design contract:
 * - The returned Promise settles exactly once (settled flag guard).
 * - The 5-minute timeout is always cleaned up.
 * - The HTTP server is always closed after the flow completes.
 */
export class CallbackServer {
  private readonly port: number;
  private server: http.Server | null = null;

  constructor(port: number) {
    this.port = port;
  }

  /**
   * Start HTTP server and wait for OAuth callback.
   * Resolves on successful token exchange, rejects on error or timeout.
   */
  start(
    expectedState: string,
    onCodeReceived: (code: string) => Promise<void>
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (action: 'resolve' | 'reject', error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.close();
        if (action === 'resolve') {
          resolve();
        } else {
          reject(error);
        }
      };

      // Close any pre-existing server
      if (this.server) {
        this.server.close();
        this.server = null;
      }

      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res, expectedState, onCodeReceived, settle);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`❌ Port ${this.port} is already in use.`);
        }
        settle('reject', error);
      });

      // 绑定 127.0.0.1 回环口，防止局域网暴露
      this.server.listen(this.port, '127.0.0.1', () => {
        console.error(`🌐 OAuth callback server listening strictly on http://127.0.0.1:${this.port}`);
      });

      // 5-minute authentication timeout
      const timeoutId = setTimeout(() => {
        settle('reject', new Error('Authentication timeout (5 minutes)'));
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Handle an incoming HTTP request on the callback server.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    expectedState: string,
    onCodeReceived: (code: string) => Promise<void>,
    settle: (action: 'resolve' | 'reject', error?: Error) => void
  ): Promise<void> {
    try {
      const url = new URL(req.url || '/', `http://localhost:${this.port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      // OAuth error from NetSuite
      if (error) {
        this.sendErrorPage(res, 'Authentication Failed', error);
        settle('reject', new Error(error));
        return;
      }

      // CSRF validation - 过滤非致命的无效 state 错误请求，不触发 settle() 关闭
      if (state !== expectedState) {
        this.sendErrorPage(res, 'Invalid State', 'CSRF validation failed. Please try again.');
        return; // 直接返回，不破坏当前服务器生命周期，允许真实认证请求重试
      }

      if (!code) {
        this.sendErrorPage(res, 'Missing Code', 'No authorization code received.');
        settle('reject', new Error('No authorization code received'));
        return;
      }

      // Exchange authorization code for tokens
      await onCodeReceived(code);
      this.sendSuccessPage(res);

      // Short delay to let browser render success page before closing server
      setTimeout(() => settle('resolve'), 1000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        this.sendErrorPage(res, 'Token Exchange Failed', message);
      } catch {
        // Response may already be sent
      }
      settle('reject', err instanceof Error ? err : new Error(message));
    }
  }

  private sendSuccessPage(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Authentication Successful</title></head>
<body style="font-family:system-ui;text-align:center;padding:50px;">
<h1>✅ Authentication Successful!</h1>
<p>You can close this window and return to your IDE.</p>
</body></html>`);
  }

  private sendErrorPage(res: http.ServerResponse, title: string, message: string): void {
    const statusCode = title.includes('Invalid') ? 400 : 500;
    res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui;text-align:center;padding:50px;">
<h1>❌ ${escapeHtml(title)}</h1>
<p style="color:#d32f2f;font-size:1.1em;">${escapeHtml(message)}</p>
<p style="color:#666;margin-top:30px;">You can close this window.</p>
</body></html>`);
  }

  /** Close the HTTP server. Safe to call multiple times. */
  close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
