#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OAuthManager } from './oauth/manager.js';
import { NetSuiteMCPTools } from './mcp/tools.js';
import { cacheService } from './utils/cache.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';
import https from 'https';
import axios from 'axios';

// Import handlers
import { registerToolHandlers, textResult } from './handlers/tools.js';
import { registerResourceHandlers } from './handlers/resources.js';
import type { ToolHandlerDeps } from './handlers/tools.js';
import { validateEnv } from './utils/envValidator.js';

// ---------------------------------------------------------------------------
// Global error handlers — LOG ONLY, NEVER EXIT
//
// For a stdio MCP server, killing the process on transient errors (network
// timeouts, DNS failures, etc.) causes the MCP client to see a disconnect.
// Instead we log the error and let the event loop continue.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (error) => {
  console.error('[MCP] uncaughtException:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[MCP] unhandledRejection:', reason);
});

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

// ---------------------------------------------------------------------------
// Server class
// ---------------------------------------------------------------------------
class NetSuiteMCPServer {
  private readonly oauthManager: OAuthManager;
  private readonly mcpTools: NetSuiteMCPTools;
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

    // Configure cache with stable project root
    cacheService.configure(projectRoot);

    // Session storage path — scoped by account ID to prevent cross-environment pollution
    const sessionsPath = envConfig.NETSUITE_SESSION_PATH
      || (envConfig.NETSUITE_ACCOUNT_ID
        ? join(projectRoot, 'sessions', envConfig.NETSUITE_ACCOUNT_ID.toLowerCase())
        : join(projectRoot, 'sessions'));

    this.oauthManager = new OAuthManager({ storagePath: sessionsPath, callbackPort });
    this.mcpTools = new NetSuiteMCPTools(this.oauthManager);

    this.server = new Server(
      { name: 'netsuite-mcp', version: '1.0.0' },
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

  private async handleCacheRefresh() {
    try {
      await this.mcpTools.refreshSessionCache();
      await this.mcpTools.clearMetadataCache();
      return textResult('✅ Successfully cleared and refreshed cache!');
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

    // Check for existing authentication
    this.isAuthenticated = await this.oauthManager.hasValidSession();

    // Register handlers BEFORE connecting (prevents race condition)
    this.setupHandlers();

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // If already authenticated, start background tasks
    if (this.isAuthenticated) {
      this.oauthManager.startProactiveRefresh();
      this.backgroundPrefetch();
    }

    console.error('✅ NetSuite MCP Server ready!\n');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  try {
    const server = new NetSuiteMCPServer();
    await server.start();
  } catch (error) {
    console.error('❌ Fatal error starting MCP server:', error);
    process.exit(1);
  }
}

main();
