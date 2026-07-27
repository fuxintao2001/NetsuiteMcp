import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NetSuiteMCPTools } from './mcp/tools.js';
import { OAuthManager } from './oauth/manager.js';
import { RedisCacheProvider } from './utils/redisCacheProvider.js';
import { registerToolHandlers } from './handlers/tools.js';
import { registerResourceHandlers } from './handlers/resources.js';

interface AccountConfig {
  accountId: string;
  clientId: string;
  sessionPath: string;
  callbackPort: number;
}

const ACCOUNT_CONFIGS: Record<string, AccountConfig> = {
  '5848789': {
    accountId: '5848789',
    clientId: process.env.NETSUITE_CLIENT_ID_5848789 || 'a1b2d7195f6788a9c751d8107c5b79d9c8f9ac07eccf3ad910b744002597001e',
    sessionPath: process.env.NETSUITE_SESSION_PATH_5848789 || path.join(process.env.HOME || '', '.gemini/antigravity/sessions/5848789'),
    callbackPort: 8080
  },
  '5848789_sb1': {
    accountId: '5848789-sb1',
    clientId: process.env.NETSUITE_CLIENT_ID_5848789_SB1 || '0236ead47a3111e43ef133494c12b55c7a83b4f0ad72cc7c2cb2787af636768a',
    sessionPath: process.env.NETSUITE_SESSION_PATH_5848789_SB1 || path.join(process.env.HOME || '', '.gemini/antigravity/sessions/5848789_sb1'),
    callbackPort: 8081
  },
  '9260916': {
    accountId: '9260916',
    clientId: process.env.NETSUITE_CLIENT_ID_9260916 || 'a464dbc30452bd27cde365f221ebe2b28e5fe2edb5d00880aef4f276dcbe6383',
    sessionPath: process.env.NETSUITE_SESSION_PATH_9260916 || path.join(process.env.HOME || '', '.gemini/antigravity/sessions/9260916'),
    callbackPort: 8082
  },
  '9260916_sb1': {
    accountId: '9260916-sb1',
    clientId: process.env.NETSUITE_CLIENT_ID_9260916_SB1 || '23b3717bc449aa331fc9867222b86f5f8324713abd56076d74f62450de6cf310',
    sessionPath: process.env.NETSUITE_SESSION_PATH_9260916_SB1 || path.join(process.env.HOME || '', '.gemini/antigravity/sessions/9260916_sb1'),
    callbackPort: 8083
  },
  '9260916_sb3': {
    accountId: '9260916-sb3',
    clientId: process.env.NETSUITE_CLIENT_ID_9260916_SB3 || '3a651cfac0d8de2d1c93c0a7c53b38e6627a6e55a1ad602bc759f64c95a2d425',
    sessionPath: process.env.NETSUITE_SESSION_PATH_9260916_SB3 || path.join(process.env.HOME || '', '.gemini/antigravity/sessions/9260916_sb3'),
    callbackPort: 8084
  }
};

/** Convert Express req to Web Standard Request */
function createWebRequest(req: Request): globalThis.Request {
  const protocol = req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const fullUrl = `${protocol}://${host}${req.originalUrl || req.url}`;

  const headers = new globalThis.Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        value.forEach(v => headers.append(key, v));
      } else {
        headers.set(key, value);
      }
    }
  }

  const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase());
  const reqInit: RequestInit = {
    method: req.method,
    headers,
    duplex: 'half'
  } as RequestInit;

  if (hasBody) {
    reqInit.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
  }

  return new globalThis.Request(fullUrl, reqInit);
}

/** Pipe Web Standard Response to Express res */
async function sendWebResponse(webRes: globalThis.Response, expressRes: Response): Promise<void> {
  expressRes.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    expressRes.setHeader(key, value);
  });

  if (webRes.body) {
    const reader = webRes.body.getReader();
    expressRes.on('close', () => {
      reader.cancel().catch(() => {});
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          expressRes.write(value);
        }
      }
    } catch (err) {
      // Ignored stream error
    }
  }
  expressRes.end();
}

class NetSuiteHTTPServer {
  private app = createMcpExpressApp();
  private cacheProvider: RedisCacheProvider;
  private handlers: Map<string, ReturnType<typeof createMcpHandler>> = new Map();

  constructor() {
    this.cacheProvider = new RedisCacheProvider();
  }

  private createServerInstance(accountKey: string, cfg: AccountConfig, lockProvider: any): Server {
    const oauthManager = new OAuthManager({
      storagePath: cfg.sessionPath,
      callbackPort: cfg.callbackPort,
      lockProvider: lockProvider
    });

    const mcpTools = new NetSuiteMCPTools(oauthManager);
    const server = new Server(
      {
        name: `netsuite-mcp-${accountKey}`,
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        }
      }
    );

    const projectRoot = process.cwd();

    registerToolHandlers({
      server,
      oauthManager,
      mcpTools,
      projectRoot,
      handleAuthentication: async () => {
        const authUrl = await oauthManager.startAuthFlow({
          accountId: cfg.accountId,
          clientId: cfg.clientId
        });
        return {
          content: [{
            type: 'text',
            text: `🔐 NetSuite OAuth 2.0 PKCE Authorization Required:\n\nPlease open the following URL in your browser to complete authorization:\n\n${authUrl}`
          }]
        };
      },
      handleLogout: async () => {
        await oauthManager.logout();
        return {
          content: [{ type: 'text', text: 'Logged out successfully.' }]
        };
      },
      handleCacheRefresh: async () => {
        await mcpTools.clearMetadataCache();
        return {
          content: [{ type: 'text', text: 'Cache cleared successfully.' }]
        };
      },
      resolveCustomRecordRectype: async (rectype: string) => {
        return mcpTools.customRecordMappings.get(rectype.toLowerCase()) || null;
      }
    });

    registerResourceHandlers(server, projectRoot);
    return server;
  }

  public async start(port: number = 3000): Promise<void> {
    try {
      await this.cacheProvider.connect();
    } catch (err: any) {
      console.error(`⚠️ Redis connection failed: ${err.message}. Running without Redis cache.`);
    }

    const lockProvider = this.cacheProvider.createLockProvider();

    // Pre-create McpHandlers for all configured accounts
    for (const [key, cfg] of Object.entries(ACCOUNT_CONFIGS)) {
      await fs.mkdir(cfg.sessionPath, { recursive: true });

      const handler = createMcpHandler(async () => {
        return this.createServerInstance(key, cfg, lockProvider);
      });

      this.handlers.set(key, handler);
    }

    // Health check endpoint
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        accounts: Object.keys(ACCOUNT_CONFIGS),
        redis: lockProvider ? 'connected' : 'disconnected'
      });
    });

    // Streamable HTTP MCP Handler endpoint per account
    const handleMcpRoute = async (req: Request, res: Response) => {
      const rawAccountId = req.params.accountId;
      const accountKey = Array.isArray(rawAccountId) ? rawAccountId[0] : rawAccountId;

      if (!accountKey) {
        res.status(400).json({ error: 'Missing accountId parameter' });
        return;
      }

      let handler = this.handlers.get(accountKey);

      // Dynamic fallback for unconfigured account
      if (!handler) {
        const envAccountId = process.env.NETSUITE_ACCOUNT_ID || accountKey;
        const clientId = process.env.NETSUITE_CLIENT_ID || 'default_client_id';
        const sessionPath = process.env.NETSUITE_SESSION_PATH || path.join(process.env.HOME || '', `.gemini/antigravity/sessions/${accountKey}`);
        const callbackPort = parseInt(process.env.OAUTH_CALLBACK_PORT || '8080', 10);

        await fs.mkdir(sessionPath, { recursive: true });
        const cfg: AccountConfig = { accountId: envAccountId, clientId, sessionPath, callbackPort };

        handler = createMcpHandler(async () => {
          return this.createServerInstance(accountKey, cfg, lockProvider);
        });

        this.handlers.set(accountKey, handler);
      }

      const webReq = createWebRequest(req);
      const webRes = await handler.fetch(webReq);
      await sendWebResponse(webRes, res);
    };

    this.app.post('/mcp/:accountId', handleMcpRoute);
    this.app.get('/mcp/:accountId', handleMcpRoute);

    this.app.listen(port, () => {
      console.error(`🚀 NetSuite MCP Streamable HTTP Server running on http://localhost:${port}`);
      console.error(`📡 Active endpoints:`);
      for (const key of Object.keys(ACCOUNT_CONFIGS)) {
        console.error(`   - http://localhost:${port}/mcp/${key}`);
      }
    });
  }
}

// Start HTTP server if executed directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = new NetSuiteHTTPServer();
  server.start(port).catch((err) => {
    console.error('Fatal error starting Streamable HTTP Server:', err);
    process.exit(1);
  });
}

export { NetSuiteHTTPServer };
