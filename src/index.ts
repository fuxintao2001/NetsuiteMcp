#!/usr/bin/env node
import "./utils/envLoader.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { cacheService } from "./cache/cache.js";
import {
	NoOpCacheProvider,
	TieredCacheProvider,
} from "./cache/cacheProvider.js";
import { RedisCacheProvider } from "./cache/redisCacheProvider.js";
import { registerPromptHandlers } from "./handlers/prompts.js";
import { registerResourceHandlers } from "./handlers/resources.js";
import type { ToolHandlerDeps } from "./handlers/tools.js";
// Import handlers
import { registerToolHandlers, textResult } from "./handlers/tools.js";
import { NetSuiteMCPTools } from "./mcp/tools.js";
import { OAuthManager } from "./oauth/manager.js";
import { McpSupervisor } from "./supervisor/supervisor.js";
import { installGlobalErrorHandlers } from "./telemetry/globalErrorHandlers.js";
import { flushToolErrorLogger } from "./telemetry/toolErrorLogger.js";
import { resolveSessionPath } from "./utils/config.js";
import { getKnownClientId, SERVER_NAME } from "./utils/constants.js";
import { validateEnv } from "./utils/envValidator.js";
import { resolveCustomRecordRectype as resolveRectypeHelper } from "./utils/metadata.js";

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------
let globalShutdownHandler: (() => Promise<void>) | undefined;
installGlobalErrorHandlers(process, console, () => {
	if (globalShutdownHandler) {
		void globalShutdownHandler();
	}
});

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

// Read version from package.json at startup
const packageJson = JSON.parse(
	readFileSync(join(projectRoot, "package.json"), "utf-8"),
) as { version: string };
const SERVER_VERSION = packageJson.version;

import { createLogger } from "./utils/logger.js";

const logger = createLogger("server");

// ---------------------------------------------------------------------------
// Server class
// ---------------------------------------------------------------------------
class NetSuiteMCPServer {
	private readonly oauthManager: OAuthManager;
	private readonly mcpTools: NetSuiteMCPTools;
	private readonly cacheProvider: RedisCacheProvider;
	private readonly tieredCacheProvider: TieredCacheProvider;
	private readonly server: Server;
	private readonly enablePrompts: boolean;
	private isAuthenticated = false;
	private isShuttingDown = false;

	constructor() {
		// Validate environment variables at startup
		const envConfig = validateEnv();
		const callbackPort = envConfig.OAUTH_CALLBACK_PORT;

		if (!envConfig.NETSUITE_ACCOUNT_ID) {
			logger.warn(
				"NETSUITE_ACCOUNT_ID not set. User must provide accountId during authentication.",
			);
		}
		if (!envConfig.NETSUITE_CLIENT_ID) {
			logger.warn(
				"NETSUITE_CLIENT_ID not set. User must provide clientId during authentication.",
			);
		}

		// Configure cache provider with Redis URL and Tiered Cache (L1 LRU + L2 Redis)
		const redisUrl = envConfig.REDIS_URL;
		this.cacheProvider = new RedisCacheProvider(redisUrl);
		this.tieredCacheProvider = new TieredCacheProvider(this.cacheProvider);
		cacheService.configure(this.tieredCacheProvider);

		const sessionsPath = resolveSessionPath(
			envConfig.NETSUITE_ACCOUNT_ID,
			envConfig.NETSUITE_SESSION_PATH,
		);

		this.oauthManager = new OAuthManager({
			storagePath: sessionsPath,
			callbackPort,
		});
		this.mcpTools = new NetSuiteMCPTools(this.oauthManager);

		this.enablePrompts =
			process.env.ENABLE_MCP_PROMPTS === "true" ||
			process.env.ENABLE_MCP_PROMPTS === "1";

		this.server = new Server(
			{ name: SERVER_NAME, version: SERVER_VERSION },
			{
				capabilities: {
					tools: {},
					resources: {},
					...(this.enablePrompts ? { prompts: {} } : {}),
				},
			},
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
			resolveCustomRecordRectype: this.resolveCustomRecordRectype.bind(this),
		};

		registerToolHandlers(deps);
		registerResourceHandlers(this.server, projectRoot);
		if (this.enablePrompts) {
			registerPromptHandlers(this.server);
		}
	}

	// -------------------------------------------------------------------------
	// Authentication lifecycle
	// -------------------------------------------------------------------------

	private async handleAuthentication(args: Record<string, unknown>) {
		const accountId =
			(args.accountId as string) || process.env.NETSUITE_ACCOUNT_ID;
		let clientId = (args.clientId as string) || process.env.NETSUITE_CLIENT_ID;

		if (
			!clientId ||
			clientId === "my-client-id" ||
			clientId === "default_client_id"
		) {
			const fallback = getKnownClientId(accountId);
			if (fallback) {
				clientId = fallback;
			}
		}

		if (!accountId || !clientId) {
			return textResult(
				"❌ Missing required credentials. Provide accountId and clientId, or set NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables.",
				true,
			);
		}

		try {
			console.error("\n🔐 Starting NetSuite authentication...");
			await this.oauthManager.startAuthFlow({ accountId, clientId });
			this.isAuthenticated = true;
			await this.mcpTools.clearCache();

			// Start proactive token refresh
			this.oauthManager.startProactiveRefresh();

			// Background: fetch custom record mappings then prefetch common metadata
			this.backgroundPrefetch();

			return textResult("✅ Successfully authenticated with NetSuite!");
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
			return textResult("✅ Successfully logged out from NetSuite!");
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			return textResult(`❌ Logout failed: ${message}`, true);
		}
	}

	private async handleCacheRefresh(args: Record<string, unknown>) {
		try {
			const rawTable =
				typeof args.table === "string" ? args.table.trim().toLowerCase() : "";
			if (rawTable) {
				await this.mcpTools.clearTableMetadataCache(rawTable);
				return textResult(
					`✅ Successfully cleared cache for table/recordType: ${rawTable}`,
				);
			}

			// Clear local cache first so it's guaranteed to run
			await this.mcpTools.clearMetadataCache();

			let restRefreshed = false;
			let restError = "";
			try {
				await this.mcpTools.refreshSessionCache();
				restRefreshed = true;
			} catch (err: unknown) {
				restError = err instanceof Error ? err.message : String(err);
			}

			if (restRefreshed) {
				return textResult("✅ Successfully cleared and refreshed all cache!");
			} else {
				return textResult(
					`⚠️ Local cache cleared successfully, but NetSuite session cache refresh failed/skipped: ${restError}`,
				);
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			return textResult(`❌ Failed to refresh cache: ${message}`, true);
		}
	}

	private async resolveCustomRecordRectype(
		recordType: string,
	): Promise<number | null> {
		return resolveRectypeHelper(
			this.mcpTools,
			this.oauthManager,
			cacheService,
			recordType,
		);
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
				logger.warn(`Background prefetch failed: ${message}`);
			}
		})();
	}

	// -------------------------------------------------------------------------
	// Server startup
	// -------------------------------------------------------------------------

	async start(): Promise<void> {
		logger.info("NetSuite MCP Server starting...");

		// Connect to Redis with graceful degradation to NoOpCacheProvider
		try {
			await this.tieredCacheProvider.connect();
			// Initialize Redis lock provider now that Redis is connected
			const lockProvider = this.cacheProvider.createLockProvider();
			if (lockProvider) {
				this.oauthManager.setLockProvider(lockProvider);
				logger.info("Redis distributed lock provider initialized");
			}
		} catch (err) {
			logger.warn(
				{ err },
				"Failed to connect to Redis on startup. Running in degraded no-cache mode.",
			);
			cacheService.configure(new NoOpCacheProvider());
		}

		// Load custom record mappings cache from storage after cache provider is ready
		try {
			await this.mcpTools.loadCustomRecordMappingsCache();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn(`Failed to load custom record mappings cache: ${msg}`);
		}

		// Check for existing authentication and log diagnostics
		this.isAuthenticated = await this.oauthManager.hasValidSession();
		if (!this.isAuthenticated) {
			try {
				logger.info(
					"Session expired or unauthenticated on startup. Attempting auto-recovery...",
				);
				await this.oauthManager.tryAutoRecover(2);
				this.isAuthenticated = await this.oauthManager.hasValidSession();
				if (this.isAuthenticated) {
					logger.info("✅ Auto-recovery on startup succeeded!");
				}
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn(`Startup auto-recovery skipped/failed: ${message}`);
			}
		}

		const sessionDiag = await this.oauthManager.getSessionDiagnostics();
		if (sessionDiag) {
			const expiresIn = sessionDiag.expiresAt
				? `${Math.round((sessionDiag.expiresAt - Date.now()) / 1000)}s`
				: "unknown";
			logger.info(`[Startup] Session: ${sessionDiag.storagePath}`);
			logger.info(
				`[Startup] Account: ${sessionDiag.accountId || "none"} | Authenticated: ${sessionDiag.authenticated} | Token expires in: ${expiresIn}`,
			);
		}

		// Register handlers BEFORE connecting (prevents race condition)
		this.setupHandlers();

		// Connect stdio transport
		const transport = new StdioServerTransport();
		await this.server.connect(transport);

		// ALWAYS start proactive refresh scheduler — it will self-heal even if
		// the current session is invalid by attempting auto-recovery on tick
		this.oauthManager.startProactiveRefresh();

		// If already authenticated, start background prefetch
		if (this.isAuthenticated) {
			this.backgroundPrefetch();
		}

		logger.info("NetSuite MCP Server ready!");
	}

	async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		logger.info("Shutting down NetSuite MCP Server...");
		this.oauthManager.stopProactiveRefresh();
		try {
			await this.tieredCacheProvider.disconnect();
		} catch (err) {
			logger.warn(
				{ err },
				"Error disconnecting cache provider during shutdown",
			);
		}
		await flushToolErrorLogger();
	}
}

// ---------------------------------------------------------------------------
// Main
async function main(): Promise<void> {
	// --- Hot-Reload Supervisor vs Worker ---
	const isWorker = process.env.__NETSUITE_MCP_WORKER__ === "true";
	const noReload =
		process.env.NETSUITE_MCP_NO_RELOAD === "true" ||
		process.env.NODE_ENV === "test";

	if (!isWorker && !noReload) {
		const scriptPath = fileURLToPath(import.meta.url);
		const distDir = dirname(scriptPath);
		const supervisor = new McpSupervisor({
			scriptPath,
			distDir,
		});
		supervisor.start();
		return;
	}

	try {
		const server = new NetSuiteMCPServer();

		let isShuttingDownProcess = false;
		const shutdown = async (signal?: string) => {
			if (isShuttingDownProcess) return;
			isShuttingDownProcess = true;

			// Fallback 3s watchdog timer to prevent process hang
			const forceExitTimer = setTimeout(() => {
				process.exit(0);
			}, 3000);
			forceExitTimer.unref();

			try {
				logger.info(
					`Initiating graceful shutdown (trigger: ${signal ?? "unknown"})...`,
				);
				await server.shutdown();
			} catch (err) {
				logger.error({ err }, "Error during shutdown");
			}
			process.exit(0);
		};

		globalShutdownHandler = shutdown;

		process.on("SIGINT", () => void shutdown("SIGINT"));
		process.on("SIGTERM", () => void shutdown("SIGTERM"));

		// Prevent zombie processes when parent client closes stdio connection
		process.stdin.on("close", () => {
			void shutdown("stdin.close");
		});
		process.stdin.on("end", () => {
			void shutdown("stdin.end");
		});
		process.stdout.on("error", (err: unknown) => {
			if ((err as { code?: string })?.code === "EPIPE") {
				void shutdown("stdout.EPIPE");
			}
		});

		await server.start();
	} catch (error) {
		logger.error({ err: error }, "Fatal error starting MCP server");
		process.exit(1);
	}
}

main();
