import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OAuthManager } from "../oauth/manager.js";
import { cacheService } from "../utils/cache.js";
import { isSandboxAccount } from "../utils/environment.js";
import {
	formatSummaryToMarkdown,
	summarizeToolErrors,
} from "../utils/toolErrorSummarizer.js";
import { GetErrorSummaryArgsSchema } from "./toolSchemas.js";

type ToolResponse = CallToolResult;

function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

/**
 * netsuite_status — Diagnostic tool
 */
export async function handleStatus(
	oauthManager: OAuthManager,
): Promise<ToolResponse> {
	const sessionInfo = await oauthManager.getSessionInfo();
	const cacheStats = await cacheService.getStats();

	const status: Record<string, unknown> = {
		server: "netsuite-mcp",
		version: "1.0.0",
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

	return textResult(JSON.stringify(status, null, 2));
}

/**
 * netsuite_get_error_summary — Error aggregation tool
 */
export async function handleGetErrorSummary(
	args: Record<string, unknown>,
): Promise<ToolResponse> {
	const parsed = GetErrorSummaryArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	try {
		const summary = await summarizeToolErrors({
			days: parsed.data.days,
			tool: parsed.data.tool,
			category: parsed.data.category,
		});
		return textResult(formatSummaryToMarkdown(summary));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return textResult(`❌ Failed to summarize error logs: ${message}`, true);
	}
}
