import fs from "node:fs/promises";
import path from "node:path";
import {
	localhostHostValidation,
	localhostOriginValidation,
} from "@modelcontextprotocol/express";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import express, { type Request, type Response } from "express";
import { registerResourceHandlers } from "./handlers/resources.js";
import { registerToolHandlers } from "./handlers/tools.js";
import { NetSuiteMCPTools } from "./mcp/tools.js";
import { OAuthManager } from "./oauth/manager.js";
import { cacheService } from "./utils/cache.js";
import { resolveCustomRecordRectype } from "./utils/metadata.js";
import { RedisCacheProvider } from "./utils/redisCacheProvider.js";

import type { RedisLockProvider } from "./utils/redisLock.js";

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

/**
 * Convert Express req to a bodiless Web Standard Request.
 *
 * The request body is NOT included here — it is passed separately via
 * handler.fetch()'s `parsedBody` option. This avoids the Undici
 * "Response body object should not be disturbed or locked" TypeError
 * that occurs when express.json() or any other body-reading middleware
 * has already consumed the IncomingMessage stream.
 */
function createWebRequest(req: Request): globalThis.Request {
	const protocol = req.protocol || "http";
	const host = req.get("host") || "localhost:3000";
	const fullUrl = `${protocol}://${host}${req.originalUrl || req.url}`;

	const headers = new globalThis.Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value !== undefined) {
			if (Array.isArray(value)) {
				value.forEach((v) => headers.append(key, v));
			} else {
				headers.set(key, value);
			}
		}
	}

	// Never pass a body — handler.fetch() receives it via parsedBody instead
	return new globalThis.Request(fullUrl, {
		method: req.method,
		headers,
	});
}

/** Pipe Web Standard Response to Express res */
async function sendWebResponse(
	webRes: globalThis.Response,
	expressRes: Response,
): Promise<void> {
	expressRes.status(webRes.status);
	webRes.headers.forEach((value, key) => {
		expressRes.setHeader(key, value);
	});

	if (webRes.body) {
		const reader = webRes.body.getReader();
		expressRes.on("close", () => {
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
		} catch (_err) {
			// Ignored stream error
		}
	}
	expressRes.end();
}

class NetSuiteHTTPServer {
	private app: ReturnType<typeof express>;
	private cacheProvider: RedisCacheProvider;
	private handlers: Map<string, ReturnType<typeof createMcpHandler>> =
		new Map();
	private oauthManagers: Map<string, OAuthManager> = new Map();

	constructor() {
		this.cacheProvider = new RedisCacheProvider();

		// Use a plain Express app instead of createMcpExpressApp() to avoid the
		// built-in express.json() body parser consuming the request stream before
		// we can pass the body to handler.fetch(). We add express.json() ourselves
		// so that req.body is available, then pass it as parsedBody to handler.fetch().
		this.app = express();
		this.app.use(express.json({ limit: "10mb" }));
		this.app.use(localhostHostValidation());
		this.app.use(localhostOriginValidation());
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
			handleCacheRefresh: async () => {
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
		return server;
	}

	public async start(port: number = 3000): Promise<void> {
		try {
			await this.cacheProvider.connect();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`⚠️ Redis connection failed: ${message}. Running without Redis cache.`,
			);
		}

		const lockProvider = this.cacheProvider.createLockProvider();

		// Pre-create McpHandlers and OAuthManagers for all configured accounts
		for (const [key, cfg] of Object.entries(ACCOUNT_CONFIGS)) {
			await fs.mkdir(cfg.sessionPath, { recursive: true });

			// Initialize OAuthManager & start proactive refresh for pre-configured accounts
			this.getOrCreateOAuthManager(key, cfg, lockProvider);

			const handler = createMcpHandler(async () => {
				return this.createServerInstance(key, cfg, lockProvider);
			});

			this.handlers.set(key, handler);
		}

		// Health check endpoint
		this.app.get("/health", (_req: Request, res: Response) => {
			res.json({
				status: "ok",
				accounts: Object.keys(ACCOUNT_CONFIGS),
				redis: lockProvider ? "connected" : "disconnected",
			});
		});

		const handleMcpRoute = async (req: Request, res: Response) => {
			const rawAccountId = req.params.accountId;
			const accountKey = Array.isArray(rawAccountId)
				? rawAccountId[0]
				: rawAccountId;

			if (!accountKey) {
				res.status(400).json({ error: "Missing accountId parameter" });
				return;
			}

			let handler = this.handlers.get(accountKey);

			// Dynamic fallback for unconfigured account
			if (!handler) {
				const envAccountId = process.env.NETSUITE_ACCOUNT_ID || accountKey;
				const clientId = process.env.NETSUITE_CLIENT_ID || "default_client_id";
				const sessionPath =
					process.env.NETSUITE_SESSION_PATH ||
					path.join(
						process.env.HOME || "",
						`.gemini/antigravity/sessions/${accountKey}`,
					);
				const callbackPort = parseInt(
					process.env.OAUTH_CALLBACK_PORT || "8080",
					10,
				);

				await fs.mkdir(sessionPath, { recursive: true });
				const cfg: AccountConfig = {
					accountId: envAccountId,
					clientId,
					sessionPath,
					callbackPort,
				};

				handler = createMcpHandler(async () => {
					return this.createServerInstance(accountKey, cfg, lockProvider);
				});

				this.handlers.set(accountKey, handler);
			}

			const webReq = createWebRequest(req);
			// Pass Express's already-parsed body as parsedBody to handler.fetch().
			// This avoids handler.fetch() trying to read the body from the Request
			// object (whose underlying stream was already consumed by express.json()).
			const fetchOptions: Record<string, unknown> = {};
			if (
				req.body &&
				typeof req.body === "object" &&
				Object.keys(req.body as object).length > 0
			) {
				fetchOptions.parsedBody = req.body;
			}
			const webRes = await handler.fetch(webReq, fetchOptions);
			await sendWebResponse(webRes, res);
		};

		// Explicitly route paths for MCP Express handler
		this.app.get("/mcp/:accountId", handleMcpRoute);
		this.app.post("/mcp/:accountId", handleMcpRoute);
		this.app.get("/mcp/:accountId/sse", handleMcpRoute);
		this.app.post("/mcp/:accountId/messages", handleMcpRoute);

		this.app.listen(port, () => {
			console.error(
				`🚀 NetSuite MCP Streamable HTTP Server running on http://localhost:${port}`,
			);
			console.error(`📡 Active endpoints:`);
			for (const key of Object.keys(ACCOUNT_CONFIGS)) {
				console.error(`   - http://localhost:${port}/mcp/${key}/sse`);
			}
		});
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
	server.start(port).catch((err) => {
		console.error("Fatal error starting Streamable HTTP Server:", err);
		process.exit(1);
	});
}

export { NetSuiteHTTPServer };
