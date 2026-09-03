import "./utils/envLoader.js";
import fs from "node:fs/promises";
import { type ServerType, serve } from "@hono/node-server";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { registerPromptHandlers } from "./handlers/prompts.js";
import { registerResourceHandlers } from "./handlers/resources.js";
import { registerToolHandlers } from "./handlers/tools.js";

import { NetSuiteMCPTools } from "./mcp/tools.js";
import { OAuthManager } from "./oauth/manager.js";
import { cacheService } from "./utils/cache.js";
import {
	type AppAccountConfig,
	type AppConfig,
	loadAppConfig,
	resolveSessionPath,
} from "./utils/config.js";
import { getKnownClientId } from "./utils/constants.js";
import { resolveCustomRecordRectype } from "./utils/metadata.js";
import { RedisCacheProvider } from "./utils/redisCacheProvider.js";
import type { RedisLockProvider } from "./utils/redisLock.js";

class NetSuiteHTTPServer {
	public app: Hono;
	public readonly appConfig: AppConfig;
	public readonly accountConfigs: Record<string, AppAccountConfig>;
	private serverInstance: ServerType | null = null;
	private cacheProvider: RedisCacheProvider;
	private handlers: Map<string, ReturnType<typeof createMcpHandler>> =
		new Map();
	private oauthManagers: Map<string, OAuthManager> = new Map();

	private lockProvider: RedisLockProvider | null = null;

	constructor(configFilePath?: string) {
		this.appConfig = loadAppConfig(configFilePath);
		this.accountConfigs = this.appConfig.accounts;
		this.cacheProvider = new RedisCacheProvider(this.appConfig.redisUrl);
		this.app = new Hono();
		this.setupRoutes();
	}

	private setupRoutes(): void {
		// Health check endpoint
		this.app.get("/health", (c: Context) => {
			return c.json({
				status: "ok",
				accounts: Object.keys(this.accountConfigs),
				redis: this.lockProvider ? "connected" : "disconnected",
			});
		});

		const handleMcpRoute = async (c: Context) => {
			const accountKey = c.req.param("accountId");

			if (!accountKey) {
				return c.json({ error: "Missing accountId parameter" }, 400);
			}

			let handler = this.handlers.get(accountKey);

			// Dynamic fallback for unconfigured account or lazy initialization
			if (!handler) {
				const configured = this.accountConfigs[accountKey];
				const envAccountId =
					configured?.accountId ||
					process.env.NETSUITE_ACCOUNT_ID ||
					accountKey;
				const clientId =
					configured?.clientId ||
					getKnownClientId(accountKey) ||
					process.env.NETSUITE_CLIENT_ID ||
					"default_client_id";
				const sessionPath =
					configured?.sessionPath ||
					resolveSessionPath(accountKey, undefined, this.appConfig.sessionsDir);
				const callbackPort =
					configured?.callbackPort ||
					this.appConfig.defaultCallbackPort ||
					8080;

				await fs.mkdir(sessionPath, { recursive: true });
				const cfg: AppAccountConfig = {
					accountId: envAccountId,
					clientId,
					sessionPath,
					callbackPort,
				};

				handler = createMcpHandler(async () => {
					return this.createServerInstance(accountKey, cfg, this.lockProvider);
				});

				this.handlers.set(accountKey, handler);
			}

			// c.req.raw is a native Web Standard Request object
			return handler.fetch(c.req.raw);
		};

		// Explicitly route paths for MCP Hono handler
		this.app.all("/mcp/:accountId", handleMcpRoute);
		this.app.all("/mcp/:accountId/*", handleMcpRoute);
	}

	private getOrCreateOAuthManager(
		accountKey: string,
		cfg: AppAccountConfig,
		lockProvider: RedisLockProvider | null,
	): OAuthManager {
		let manager = this.oauthManagers.get(accountKey);
		if (!manager) {
			manager = new OAuthManager({
				...(cfg.sessionPath ? { storagePath: cfg.sessionPath } : {}),
				...(cfg.callbackPort ? { callbackPort: cfg.callbackPort } : {}),
				lockProvider: lockProvider,
			});
			// Start proactive token refresh scheduler in HTTP Server mode
			manager.startProactiveRefresh();

			this.oauthManagers.set(accountKey, manager);
		}
		return manager;
	}

	private createServerInstance(
		accountKey: string,
		cfg: AppAccountConfig,
		lockProvider: RedisLockProvider | null,
	): Server {
		const oauthManager = this.getOrCreateOAuthManager(
			accountKey,
			cfg,
			lockProvider,
		);

		const mcpTools = new NetSuiteMCPTools(oauthManager);
		const server = new Server(
			{
				name: `netsuite-mcp-${accountKey}`,
				version: "1.0.0",
			},
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
				},
			},
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
					clientId: cfg.clientId,
				});
				return {
					content: [
						{
							type: "text",
							text: `🔐 NetSuite OAuth 2.0 PKCE Authorization Required:\n\nPlease open the following URL in your browser to complete authorization:\n\n${authUrl}`,
						},
					],
				};
			},
			handleLogout: async () => {
				await oauthManager.logout();
				return {
					content: [{ type: "text", text: "Logged out successfully." }],
				};
			},
			handleCacheRefresh: async (args: Record<string, unknown> = {}) => {
				const rawTable =
					args.tableName ??
					args.table_name ??
					args.recordType ??
					args.record_type ??
					args.table;
				const tableName =
					typeof rawTable === "string" ? rawTable.trim().toLowerCase() : "";
				if (tableName) {
					await mcpTools.clearTableMetadataCache(tableName);
					return {
						content: [
							{
								type: "text",
								text: `✅ Successfully cleared cache for table/recordType: ${tableName}`,
							},
						],
					};
				}
				await mcpTools.clearMetadataCache();
				return {
					content: [{ type: "text", text: "Cache cleared successfully." }],
				};
			},
			resolveCustomRecordRectype: async (rectype: string) => {
				return resolveCustomRecordRectype(
					mcpTools,
					oauthManager,
					cacheService,
					rectype,
				);
			},
		});

		registerResourceHandlers(server, projectRoot);
		registerPromptHandlers(server);
		return server;
	}

	public async start(port: number = 3000): Promise<void> {
		try {
			await this.cacheProvider.connect();
			cacheService.configure(this.cacheProvider);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`⚠️ Redis connection failed: ${message}. Running without Redis cache.`,
			);
		}

		this.lockProvider = this.cacheProvider.createLockProvider();

		// Pre-create McpHandlers and OAuthManagers for all configured accounts
		for (const [key, cfg] of Object.entries(this.accountConfigs)) {
			if (cfg.sessionPath) {
				await fs.mkdir(cfg.sessionPath, { recursive: true });
			}

			// Initialize OAuthManager & start proactive refresh for pre-configured accounts
			const manager = this.getOrCreateOAuthManager(key, cfg, this.lockProvider);

			const handler = createMcpHandler(async () => {
				return this.createServerInstance(key, cfg, this.lockProvider);
			});

			this.handlers.set(key, handler);

			// Background prefetch / seeding for authenticated accounts
			(async () => {
				try {
					const isAuth = await manager.hasValidSession();
					if (isAuth) {
						const tools = new NetSuiteMCPTools(manager);
						await tools.fetchCustomRecordMappings();
						await tools.prefetchCommonMetadata();
					}
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`⚠️ Background prefetch failed for ${key}: ${msg}`);
				}
			})();
		}

		this.serverInstance = serve(
			{
				fetch: this.app.fetch,
				port,
			},
			() => {
				console.error(
					`🚀 NetSuite MCP Streamable HTTP Server (Hono) running on http://localhost:${port}`,
				);
				console.error(`📡 Active endpoints:`);
				const keys = Object.keys(this.accountConfigs);
				if (keys.length === 0) {
					console.error(
						"   (No pre-configured accounts. Dynamic /mcp/:accountId available)",
					);
				} else {
					for (const key of keys) {
						console.error(`   - http://localhost:${port}/mcp/${key}/sse`);
					}
				}
			},
		);
	}

	public async shutdown(): Promise<void> {
		console.error("🔌 Shutting down NetSuite HTTP Server...");
		if (this.serverInstance) {
			this.serverInstance.close();
		}
		for (const manager of this.oauthManagers.values()) {
			manager.stopProactiveRefresh();
		}
		await this.cacheProvider.disconnect();
	}
}

// Start HTTP server if executed directly
if (
	process.argv[1] &&
	(process.argv[1].endsWith("server.js") ||
		process.argv[1].endsWith("server.ts"))
) {
	const port = parseInt(process.env.PORT || "3000", 10);
	const server = new NetSuiteHTTPServer();

	const shutdown = async () => {
		try {
			await server.shutdown();
		} catch (err) {
			console.error("Error during shutdown:", err);
		}
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	server.start(port).catch((err) => {
		console.error("Fatal error starting Streamable HTTP Server:", err);
		process.exit(1);
	});
}

export { NetSuiteHTTPServer };
