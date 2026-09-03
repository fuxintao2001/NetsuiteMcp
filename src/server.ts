import "./utils/envLoader.js";
import fs from "node:fs/promises";
import path from "node:path";
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
import { getKnownClientId } from "./utils/constants.js";
import { resolveCustomRecordRectype } from "./utils/metadata.js";
import { RedisCacheProvider } from "./utils/redisCacheProvider.js";
import type { RedisLockProvider } from "./utils/redisLock.js";
import { suitecloudRunnerService } from "./utils/suitecloudRunner.js";

interface AccountConfig {
	accountId: string;
	clientId: string;
	sessionPath: string;
	callbackPort: number;
}

const ACCOUNT_CONFIGS: Record<string, AccountConfig> = {
	"5848789": {
		accountId: "5848789",
		clientId:
			process.env.NETSUITE_CLIENT_ID_5848789 ||
			process.env.NETSUITE_CLIENT_ID ||
			getKnownClientId("5848789") ||
			"",
		sessionPath:
			process.env.NETSUITE_SESSION_PATH_5848789 ||
			path.join(process.env.HOME || "", ".gemini/antigravity/sessions/5848789"),
		callbackPort: 8080,
	},
	"5848789_sb1": {
		accountId: "5848789-sb1",
		clientId:
			process.env.NETSUITE_CLIENT_ID_5848789_SB1 ||
			process.env.NETSUITE_CLIENT_ID ||
			getKnownClientId("5848789_sb1") ||
			"",
		sessionPath:
			process.env.NETSUITE_SESSION_PATH_5848789_SB1 ||
			path.join(
				process.env.HOME || "",
				".gemini/antigravity/sessions/5848789_sb1",
			),
		callbackPort: 8081,
	},
	"9260916": {
		accountId: "9260916",
		clientId:
			process.env.NETSUITE_CLIENT_ID_9260916 ||
			process.env.NETSUITE_CLIENT_ID ||
			getKnownClientId("9260916") ||
			"",
		sessionPath:
			process.env.NETSUITE_SESSION_PATH_9260916 ||
			path.join(process.env.HOME || "", ".gemini/antigravity/sessions/9260916"),
		callbackPort: 8082,
	},
	"9260916_sb1": {
		accountId: "9260916-sb1",
		clientId:
			process.env.NETSUITE_CLIENT_ID_9260916_SB1 ||
			process.env.NETSUITE_CLIENT_ID ||
			getKnownClientId("9260916_sb1") ||
			"",
		sessionPath:
			process.env.NETSUITE_SESSION_PATH_9260916_SB1 ||
			path.join(
				process.env.HOME || "",
				".gemini/antigravity/sessions/9260916_sb1",
			),
		callbackPort: 8083,
	},
	"9260916_sb3": {
		accountId: "9260916-sb3",
		clientId:
			process.env.NETSUITE_CLIENT_ID_9260916_SB3 ||
			process.env.NETSUITE_CLIENT_ID ||
			getKnownClientId("9260916_sb3") ||
			"",
		sessionPath:
			process.env.NETSUITE_SESSION_PATH_9260916_SB3 ||
			path.join(
				process.env.HOME || "",
				".gemini/antigravity/sessions/9260916_sb3",
			),
		callbackPort: 8084,
	},
};

class NetSuiteHTTPServer {
	public app: Hono;
	private serverInstance: ServerType | null = null;
	private cacheProvider: RedisCacheProvider;
	private handlers: Map<string, ReturnType<typeof createMcpHandler>> =
		new Map();
	private oauthManagers: Map<string, OAuthManager> = new Map();

	private lockProvider: RedisLockProvider | null = null;

	constructor() {
		this.cacheProvider = new RedisCacheProvider();
		this.app = new Hono();
		this.setupRoutes();
	}

	private setupRoutes(): void {
		// Health check endpoint
		this.app.get("/health", (c: Context) => {
			return c.json({
				status: "ok",
				accounts: Object.keys(ACCOUNT_CONFIGS),
				redis: this.lockProvider ? "connected" : "disconnected",
			});
		});

		// One-click web confirmation endpoint for SuiteCloud file uploads
		this.app.get("/confirm-upload", async (c: Context) => {
			const token = c.req.query("token");
			if (!token) {
				return c.html(
					`<!DOCTYPE html>
					<html>
					<head><meta charset="utf-8"><title>NetSuite MCP - 错误</title></head>
					<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #fff5f5; color: #991b1b;">
						<h2>❌ 错误：缺少确认令牌 (Confirmation Token)</h2>
						<p>请返回 IDE 或客户端重新发起上传。</p>
					</body>
					</html>`,
					400,
				);
			}

			const result = await suitecloudRunnerService.executeByToken(token);

			if (!result.success) {
				return c.html(
					`<!DOCTYPE html>
					<html>
					<head><meta charset="utf-8"><title>NetSuite MCP - 上传失败</title></head>
					<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #fff5f5; color: #991b1b; line-height: 1.5;">
						<h2>❌ SuiteCloud 文件上传失败 / 令牌无效</h2>
						<p><strong>原因:</strong> ${result.message}</p>
						${
							result.details
								? `<pre style="background: #fee2e2; padding: 16px; border-radius: 8px; overflow-x: auto; color: #7f1d1d;">${result.details.stderr || result.details.stdout}</pre>`
								: ""
						}
						<p style="margin-top: 24px;"><a href="javascript:window.close()" style="color: #2563eb; text-decoration: none; font-weight: 500;">✕ 关闭此页面</a></p>
					</body>
					</html>`,
					400,
				);
			}

			return c.html(
				`<!DOCTYPE html>
				<html>
				<head><meta charset="utf-8"><title>NetSuite MCP - 上传成功</title></head>
				<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; background: #f0fdf4; color: #166534; line-height: 1.6;">
					<div style="max-width: 680px; margin: 0 auto; background: #ffffff; border: 1px solid #bbf7d0; border-radius: 12px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
						<div style="display: flex; align-items: center; margin-bottom: 20px;">
							<span style="font-size: 32px; margin-right: 12px;">✅</span>
							<h2 style="margin: 0; color: #15803d; font-size: 24px;">SuiteCloud 文件上传成功！</h2>
						</div>
						<p style="color: #374151; font-size: 15px;">文件已成功部署至 NetSuite File Cabinet。</p>
						<table style="width: 100%; margin: 20px 0; border-collapse: collapse; font-size: 14px;">
							<tr><td style="padding: 8px 0; color: #6b7280; width: 140px;"><strong>目标路径:</strong></td><td style="color: #111827; font-family: monospace;">${result.payload?.paths}</td></tr>
							<tr><td style="padding: 8px 0; color: #6b7280;"><strong>目标账号:</strong></td><td style="color: #111827;">${result.payload?.accountId?.toUpperCase()}</td></tr>
							<tr><td style="padding: 8px 0; color: #6b7280;"><strong>执行耗时:</strong></td><td style="color: #111827;">${result.details?.executionTimeMs} ms</td></tr>
						</table>
						${
							result.details?.stdout
								? `<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-top: 20px;">
										<pre style="margin: 0; font-size: 13px; color: #334155; white-space: pre-wrap;">${result.details.stdout}</pre>
									</div>`
								: ""
						}
						<div style="margin-top: 28px; text-align: right;">
							<button onclick="window.close()" style="background: #16a34a; color: #ffffff; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer;">完成并关闭页面</button>
						</div>
					</div>
				</body>
				</html>`,
			);
		});

		const handleMcpRoute = async (c: Context) => {
			const accountKey = c.req.param("accountId");

			if (!accountKey) {
				return c.json({ error: "Missing accountId parameter" }, 400);
			}

			let handler = this.handlers.get(accountKey);

			// Dynamic fallback for unconfigured account or lazy initialization
			if (!handler) {
				const configured = ACCOUNT_CONFIGS[accountKey];
				const envAccountId =
					configured?.accountId ||
					process.env.NETSUITE_ACCOUNT_ID ||
					accountKey;
				const clientId =
					configured?.clientId ||
					process.env.NETSUITE_CLIENT_ID ||
					"default_client_id";
				const sessionPath =
					configured?.sessionPath ||
					process.env.NETSUITE_SESSION_PATH ||
					path.join(
						process.env.HOME || "",
						`.gemini/antigravity/sessions/${accountKey}`,
					);
				const callbackPort =
					configured?.callbackPort ||
					parseInt(process.env.OAUTH_CALLBACK_PORT || "8080", 10);

				await fs.mkdir(sessionPath, { recursive: true });
				const cfg: AccountConfig = {
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
		cfg: AccountConfig,
		lockProvider: RedisLockProvider | null,
	): OAuthManager {
		let manager = this.oauthManagers.get(accountKey);
		if (!manager) {
			manager = new OAuthManager({
				storagePath: cfg.sessionPath,
				callbackPort: cfg.callbackPort,
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
		cfg: AccountConfig,
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
		for (const [key, cfg] of Object.entries(ACCOUNT_CONFIGS)) {
			await fs.mkdir(cfg.sessionPath, { recursive: true });

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
				for (const key of Object.keys(ACCOUNT_CONFIGS)) {
					console.error(`   - http://localhost:${port}/mcp/${key}/sse`);
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
