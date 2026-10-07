import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { cacheService } from "../cache/cache.js";
import type { OAuthManager } from "../oauth/manager.js";
import {
	formatSummaryToMarkdown,
	summarizeToolErrors,
} from "../telemetry/toolErrorSummarizer.js";
import { isSandboxAccount } from "../utils/environment.js";
import { AuthArgsSchema, StatusArgsSchema } from "./toolSchemas.js";
import { textResult } from "./types.js";

type ToolResponse = CallToolResult;

const __filename_auth = fileURLToPath(import.meta.url);
const __dirname_auth = dirname(__filename_auth);
const PKG_VERSION: string = (() => {
	try {
		const pkg = JSON.parse(
			readFileSync(join(__dirname_auth, "../../package.json"), "utf-8"),
		);
		return pkg.version || "unknown";
	} catch {
		return "unknown";
	}
})();

/**
 * netsuite_status — Comprehensive health, environment & error diagnostic dashboard
 */
export async function handleStatus(
	oauthManager: OAuthManager,
	args: Record<string, unknown> = {},
): Promise<ToolResponse> {
	const parsed = StatusArgsSchema.safeParse(args);
	const includeErrors = parsed.success
		? parsed.data.includeErrors || parsed.data.includeDiagnostics
		: false;

	const sessionInfo = await oauthManager.getSessionInfo();
	const cacheStats = await cacheService.getStats();

	const status: Record<string, unknown> = {
		server: "netsuite-mcp",
		version: PKG_VERSION,
		authenticated: sessionInfo.authenticated,
		refreshSchedulerActive: sessionInfo.refreshSchedulerActive,
		cache: cacheStats,
	};

	if (sessionInfo.authenticated) {
		status.accountId = sessionInfo.accountId;
		status.clientId = sessionInfo.clientId
			? `${sessionInfo.clientId.substring(0, 8)}...`
			: undefined;
		status.tokenExpiresIn =
			sessionInfo.tokenExpiresIn !== undefined
				? `${sessionInfo.tokenExpiresIn}s`
				: "unknown";
		status.tokenExpiresAt = sessionInfo.tokenExpiresAt
			? new Date(sessionInfo.tokenExpiresAt).toISOString()
			: "unknown";

		const sandbox = sessionInfo.accountId
			? isSandboxAccount(sessionInfo.accountId)
			: false;
		status.environment = sandbox ? "Sandbox/Test" : "Production";
		status.writeOperations = sandbox ? "enabled" : "disabled";
	}

	let output = JSON.stringify(status, null, 2);

	if (includeErrors) {
		try {
			const summary = await summarizeToolErrors({ days: 7 });
			output += `\n\n---\n${formatSummaryToMarkdown(summary)}`;
		} catch {
			/* non-fatal */
		}
	}

	return textResult(output);
}

/**
 * netsuite_auth — Authoritative tool for OAuth 2.0 PKCE authentication and cache control
 */
export async function handleAuth(
	args: Record<string, unknown>,
	handleAuthentication: (
		args: Record<string, unknown>,
	) => Promise<ToolResponse>,
	handleLogout: () => Promise<ToolResponse>,
	handleCacheRefresh: (args: Record<string, unknown>) => Promise<ToolResponse>,
): Promise<ToolResponse> {
	const parsed = AuthArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}

	const { action } = parsed.data;
	switch (action) {
		case "login":
			return await handleAuthentication(args);
		case "logout":
			return await handleLogout();
		case "refresh_cache":
			return await handleCacheRefresh(args);
	}
}
