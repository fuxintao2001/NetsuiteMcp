import type { CallToolResult, Server } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";

export interface ToolHandlerDeps {
	server: Server;
	oauthManager: OAuthManager;
	mcpTools: NetSuiteMCPTools;
	projectRoot: string;
	handleAuthentication: (
		args: Record<string, unknown>,
	) => Promise<CallToolResult>;
	handleLogout: () => Promise<CallToolResult>;
	handleCacheRefresh: (
		args: Record<string, unknown>,
	) => Promise<CallToolResult>;
	resolveCustomRecordRectype: (
		type: string,
	) => number | null | Promise<number | null>;
}
