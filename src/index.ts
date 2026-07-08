#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OAuthManager } from './oauth/manager.js';
import { NetSuiteMCPTools } from './mcp/tools.js';
import { cacheService } from './utils/cache.js';
import { RedisCacheProvider } from './utils/redisCacheProvider.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import http from 'http';
import https from 'https';
import axios from 'axios';
import { installGlobalErrorHandlers } from './utils/globalErrorHandlers.js';

// Import handlers
import { registerToolHandlers, textResult } from './handlers/tools.js';
import { registerResourceHandlers } from './handlers/resources.js';
import type { ToolHandlerDeps } from './handlers/tools.js';
import { validateEnv } from './utils/envValidator.js';

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------
installGlobalErrorHandlers();

// ---------------------------------------------------------------------------
// Configure Axios connection pooling
// ---------------------------------------------------------------------------
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

// Read version from package.json at startup
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as { version: string };
const SERVER_VERSION = packageJson.version;

// ---------------------------------------------------------------------------
// Server class
// ---------------------------------------------------------------------------
class NetSuiteMCPServer {
  private readonly oauthManager: OAuthManager;
  private readonly mcpTools: NetSuiteMCPTools;
  private readonly cacheProvider: RedisCacheProvider;
  private readonly server: Server;
  private isAuthenticated = false;

  constructor() {
    // Validate environment variables at startup
    const envConfig = validateEnv();
    const callbackPort = envConfig.OAUTH_CALLBACK_PORT;

    if (!envConfig.NETSUITE_ACCOUNT_ID) {
      console.error('⚠️  NETSUITE_ACCOUNT_ID not set. User must provide accountId during authentication.');
    }
    if (!envConfig.NETSUITE_CLIENT_ID) {
      console.error('⚠️  NETSUITE_CLIENT_ID not set. User must provide clientId during authentication.');
    }

    // Configure cache provider with Redis URL
    const redisUrl = envConfig.REDIS_URL;
    this.cacheProvider = new RedisCacheProvider(redisUrl);
    cacheService.configure(this.cacheProvider);

    const sessionsPath = envConfig.NETSUITE_SESSION_PATH
      || (envConfig.NETSUITE_ACCOUNT_ID
        ? join(projectRoot, 'sessions', envConfig.NETSUITE_ACCOUNT_ID.toLowerCase())
        : join(projectRoot, 'sessions'));

    this.oauthManager = new OAuthManager({ storagePath: sessionsPath, callbackPort });
    this.mcpTools = new NetSuiteMCPTools(this.oauthManager);

    this.server = new Server(
      { name: 'netsuite-mcp', version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } }
    );
  }

  /**
   * Register all MCP protocol handlers.
   */
  private setupHandlers(): void {
    const deps: ToolHandlerDeps = {
      server: this.server,
      oauthManager: this.oauthManager,
      mcpTools: this.mcpTools,
      projectRoot,
      handleAuthentication: this.handleAuthentication.bind(this),
      handleLogout: this.handleLogout.bind(this),
      handleCacheRefresh: this.handleCacheRefresh.bind(this),
      resolveCustomRecordRectype: this.resolveCustomRecordRectype.bind(this)
    };

    registerToolHandlers(deps);
    registerResourceHandlers(this.server, projectRoot);
  }

  // -------------------------------------------------------------------------
  // Authentication lifecycle
  // -------------------------------------------------------------------------

  private async handleAuthentication(args: Record<string, unknown>) {
    const accountId = (args.accountId as string) || process.env.NETSUITE_ACCOUNT_ID;
    const clientId = (args.clientId as string) || process.env.NETSUITE_CLIENT_ID;

    if (!accountId || !clientId) {
      return textResult(
        '❌ Missing required credentials. Provide accountId and clientId, or set NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables.',
        true
      );
    }

    try {
      console.error('\n🔐 Starting NetSuite authentication...');
      await this.oauthManager.startAuthFlow({ accountId, clientId });
      this.isAuthenticated = true;
      await this.mcpTools.clearCache();

      // Start proactive token refresh
      this.oauthManager.startProactiveRefresh();

      // Background: fetch custom record mappings then prefetch common metadata
      this.backgroundPrefetch();

      return textResult('✅ Successfully authenticated with NetSuite!');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Authentication failed: ${message}`, true);
    }
  }

  private async handleLogout() {
    try {
      await this.oauthManager.clearSession();
      await this.mcpTools.clearCache();
      this.isAuthenticated = false;
      return textResult('✅ Successfully logged out from NetSuite!');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Logout failed: ${message}`, true);
    }
  }

  private async handleCacheRefresh(args: Record<string, unknown>) {
    try {
      const tableName = (args.tableName || args.table || args.recordType || '') as string;
      if (tableName) {
        await this.mcpTools.clearTableMetadataCache(tableName);
        return textResult(`✅ Successfully cleared cache for table/recordType: ${tableName}`);
      }

      // Clear local cache first so it's guaranteed to run
      await this.mcpTools.clearMetadataCache();

      let restRefreshed = false;
      let restError = '';
      try {
        await this.mcpTools.refreshSessionCache();
        restRefreshed = true;
      } catch (err: unknown) {
        restError = err instanceof Error ? err.message : String(err);
      }

      if (restRefreshed) {
        return textResult('✅ Successfully cleared and refreshed all cache!');
      } else {
        return textResult(`⚠️ Local cache cleared successfully, but NetSuite session cache refresh failed/skipped: ${restError}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Failed to refresh cache: ${message}`, true);
    }
  }

  private resolveCustomRecordRectype(recordType: string): number | null {
    if (!recordType) return null;
    const upperType = recordType.toUpperCase().trim();
    return this.mcpTools.customRecordMappings.get(upperType) ?? null;
  }

  // -------------------------------------------------------------------------
  // Background prefetch (fully guarded — no exceptions escape)
  // -------------------------------------------------------------------------

  private backgroundPrefetch(): void {
    (async () => {
      try {
        await this.mcpTools.fetchCustomRecordMappings();
        await this.mcpTools.prefetchCommonMetadata();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`⚠️ Background prefetch failed: ${message}`);
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Server startup
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    console.error('🚀 NetSuite MCP Server starting...');

    // Connect to Redis
    try {
      await this.cacheProvider.connect();
    } catch (err) {
      console.error('❌ Failed to connect to Redis on startup:', err);
      throw err;
    }

    // Check for existing authentication and log diagnostics
    this.isAuthenticated = await this.oauthManager.hasValidSession();
    const sessionDiag = await this.oauthManager.getSessionDiagnostics();
    if (sessionDiag) {
      const expiresIn = sessionDiag.expiresAt
        ? `${Math.round((sessionDiag.expiresAt - Date.now()) / 1000)}s`
        : 'unknown';
      console.error(`📋 [Startup] Session: ${sessionDiag.storagePath}`);
      console.error(`📋 [Startup] Account: ${sessionDiag.accountId || 'none'} | Authenticated: ${sessionDiag.authenticated} | Token expires in: ${expiresIn}`);
    }

    // Register handlers BEFORE connecting (prevents race condition)
    this.setupHandlers();

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // If session exists but token expired, try auto-recovery via refresh token in background
    if (!this.isAuthenticated) {
      (async () => {
        try {
          await this.oauthManager.tryAutoRecover();
          this.isAuthenticated = await this.oauthManager.hasValidSession();
          if (this.isAuthenticated) {
            console.error('🔄 Session auto-recovered from expired token');
            this.backgroundPrefetch();
          }
        } catch {
          // Auto-recovery failed (e.g. refresh token also expired) — user must manually authenticate
          console.error('⚠️ Auto-recovery failed on startup. Will keep retrying via scheduler.');
        }
      })();
    }

    // ALWAYS start proactive refresh scheduler — it will self-heal even if
    // the current session is invalid by attempting auto-recovery each tick
    this.oauthManager.startProactiveRefresh();

    // If already authenticated, also start background prefetch
    if (this.isAuthenticated) {
      this.backgroundPrefetch();
    }

    console.error('✅ NetSuite MCP Server ready!\n');
  }

  async shutdown(): Promise<void> {
    console.error('🔌 Shutting down NetSuite MCP Server...');
    this.oauthManager.stopProactiveRefresh();
    await this.cacheProvider.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Main
async function main(): Promise<void> {
  try {
    const server = new NetSuiteMCPServer();

    const shutdown = async () => {
      try {
        await server.shutdown();
      } catch (err) {
        console.error('Error during shutdown:', err);
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await server.start();
  } catch (error) {
    console.error('❌ Fatal error starting MCP server:', error);
    process.exit(1);
  }
}

main();
