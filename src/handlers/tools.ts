import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import {
	classifyError,
	recordToolError,
} from "../telemetry/toolErrorLogger.js";
import { normalizeStandardArgs } from "../utils/args.js";
import { formatSuiteQLToCompactMarkdown } from "../utils/contextSlimmer.js";
import { buildEnvSuffix, isSandboxAccount } from "../utils/environment.js";
import {
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
} from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import {
	formatSuiteQLErrorResponse,
	splitSuiteQLStatements,
} from "../utils/suiteqlGuard.js";
import { handleAuth, handleStatus } from "./authHandlers.js";
import { handleSuitecloudUpload } from "./deployHandlers.js";
import { handleGetScriptLogs } from "./queryHandlers.js";
import {
	handleCreateRecord,
	handleGetMetadata,
	handleGetRecord,
	handleGetSystemNotes,
	handleUpdateRecord,
} from "./recordHandlers.js";
import { LOCAL_TOOLS, SANDBOX_MUTATION_TOOLS } from "./toolSchemas.js";
import { type ToolHandlerDeps, textResult } from "./types.js";

export type { ToolHandlerDeps };
export { textResult };

// ---------------------------------------------------------------------------
// Tool Annotations & Description Helpers
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
	"netsuite_run_suiteql",
	"netsuite_get_metadata",
	"netsuite_get_record",
	"netsuite_get_script_logs",
	"netsuite_get_system_notes",
	"netsuite_status",
]);

const DESTRUCTIVE_TOOLS = new Set([
	"netsuite_deploy_script",
	"netsuite_create_record",
	"netsuite_update_record",
]);

const IDEMPOTENT_TOOLS = new Set([...READ_ONLY_TOOLS, "netsuite_auth"]);

/**
 * Generate standard MCP tool annotations.
 */
export function getToolAnnotations(name: string): Record<string, boolean> {
	const isReadOnly = READ_ONLY_TOOLS.has(name);
	const isDestructive = DESTRUCTIVE_TOOLS.has(name);
	const isIdempotent = IDEMPOTENT_TOOLS.has(name);

	return {
		readOnlyHint: isReadOnly,
		...(isDestructive ? { destructiveHint: true } : {}),
		...(isIdempotent ? { idempotentHint: true } : {}),
	};
}

/** Append environment suffix and attach standard MCP annotations. */
function enhanceDescription(
	tool: Record<string, unknown>,
	suffix: string,
): Record<string, unknown> {
	const toolName = (tool.name as string) || "";
	const desc = (tool.description as string) || "";
	const annotations = getToolAnnotations(toolName);
	return {
		...tool,
		description: desc ? `${desc}${suffix}` : suffix,
		annotations,
	};
}

const telemetryLogger = createLogger("telemetry");

// ---------------------------------------------------------------------------
// Handler Registration (8 Authoritative Tools)
// ---------------------------------------------------------------------------

export function registerToolHandlers(deps: ToolHandlerDeps): void {
	const {
		server,
		oauthManager,
		mcpTools,
		handleAuthentication,
		handleLogout,
		handleCacheRefresh,
		resolveCustomRecordRectype,
	} = deps;

	// --- tools/list handler ---
	server.setRequestHandler("tools/list", async () => {
		const isAuthenticated = await oauthManager.hasValidSession();
		let accountId: string | undefined;
		if (isAuthenticated) {
			accountId =
				(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
		}
		const isSandbox = accountId ? isSandboxAccount(accountId) : false;
		const envSuffix = buildEnvSuffix(accountId ?? null);

		// Expose 10 tools in Sandbox (8 Core + 2 Sandbox Mutation), or 8 Core tools in Production
		const activeTools = isSandbox
			? LOCAL_TOOLS
			: LOCAL_TOOLS.filter((t) => !SANDBOX_MUTATION_TOOLS.has(t.name));

		return {
			tools: activeTools.map((t) =>
				enhanceDescription(t as unknown as Record<string, unknown>, envSuffix),
			) as unknown as Tool[],
		};
	});

	// --- tools/call handler ---
	server.setRequestHandler("tools/call", async (request) => {
		const { name, arguments: rawArgs = {} } = request.params;
		const safeArgs = normalizeStandardArgs(
			(rawArgs || {}) as Record<string, unknown>,
		);
		const callStartTime = Date.now();

		const reportProgress = async (
			progress: number,
			total: number,
			message?: string,
		) => {
			const progressToken = request.params._meta?.progressToken;
			if (progressToken !== undefined) {
				try {
					await server.notification({
						method: "notifications/progress",
						params: {
							progressToken,
							progress,
							total,
							...(message ? { message } : {}),
						},
					});
				} catch {
					// Non-fatal
				}
			}
		};

		const recordErrorIfPresent = async (
			res: CallToolResult,
			errorStack?: string,
		): Promise<CallToolResult> => {
			if (res.isError) {
				let currentAccountId: string | undefined;
				let currentEnv: "Sandbox" | "Production" | "Unknown" = "Unknown";
				try {
					const detectedId =
						(await oauthManager.getAccountId()) ||
						process.env.NETSUITE_ACCOUNT_ID;
					if (detectedId) {
						currentAccountId = detectedId;
						currentEnv = isSandboxAccount(detectedId)
							? "Sandbox"
							: "Production";
					}
				} catch {
					// Non-fatal
				}

				const errorText =
					res.content
						?.filter(
							(c): c is { type: "text"; text: string } => c.type === "text",
						)
						.map((c) => c.text)
						.join("\n") || "Unknown error";
				const category = classifyError(name, errorText);
				recordToolError({
					tool: name,
					accountId: currentAccountId,
					environment: currentEnv,
					durationMs: Date.now() - callStartTime,
					category,
					errorMessage: errorText,
					errorStack,
					parameters: safeArgs,
				});
			}

			const durationMs = Date.now() - callStartTime;
			const payloadChars =
				res.content?.reduce(
					(acc, c) => acc + (c.type === "text" ? c.text.length : 0),
					0,
				) || 0;
			telemetryLogger.info(
				{
					tool: name,
					durationMs,
					isError: !!res.isError,
					payloadChars,
				},
				"Tool call completed",
			);

			return res;
		};

		try {
			const result = await (async (): Promise<CallToolResult> => {
				// 1. netsuite_auth — Login, Logout & Cache Refresh
				if (name === "netsuite_auth") {
					return await handleAuth(
						safeArgs,
						handleAuthentication,
						handleLogout,
						handleCacheRefresh,
					);
				}

				// 2. netsuite_status — Comprehensive diagnostic health dashboard
				if (name === "netsuite_status") {
					return await handleStatus(oauthManager, safeArgs);
				}

				// All other tools require an authenticated NetSuite session
				const isAuthenticated = await oauthManager.hasValidSession();
				if (!isAuthenticated) {
					return textResult(
						"❌ Not authenticated. Please use the 'netsuite_auth' tool to log in first.",
						true,
					);
				}

				// 3. netsuite_run_suiteql — Single authoritative SuiteQL execution tool
				if (name === "netsuite_run_suiteql") {
					const rawQuery =
						typeof safeArgs.sqlQuery === "string" ? safeArgs.sqlQuery : "";
					let queriesToRun = splitSuiteQLStatements(rawQuery);
					if (queriesToRun.length === 0 && Array.isArray(safeArgs.sqlQueries)) {
						queriesToRun = (safeArgs.sqlQueries as unknown[])
							.filter(
								(q): q is string =>
									typeof q === "string" && q.trim().length > 0,
							)
							.map((q) => q.trim());
					}

					if (queriesToRun.length === 0) {
						return textResult(
							"❌ 'sqlQuery' parameter is required and cannot be empty.",
							true,
						);
					}

					if (queriesToRun.length > 10) {
						return textResult(
							`❌ [Batch Limit Exceeded] A maximum of 10 queries can be executed in parallel (received ${queriesToRun.length}).`,
							true,
						);
					}

					// Custom record rectype resolution if provided
					if (Array.isArray(safeArgs.customRecordMappings)) {
						for (const mapping of safeArgs.customRecordMappings as Array<{
							rectype: unknown;
							scriptId?: string;
						}>) {
							if (mapping && typeof mapping.rectype === "string") {
								const resolvedId = await resolveCustomRecordRectype(
									mapping.rectype,
								);
								if (resolvedId !== null && resolvedId !== undefined) {
									mapping.rectype = resolvedId;
								} else {
									throw new Error(
										`Could not resolve rectype ID for custom record: ${mapping.rectype}`,
									);
								}
							}
						}
					}

					// Parallel multi-query execution
					if (queriesToRun.length > 1) {
						await reportProgress(
							1,
							queriesToRun.length + 1,
							`Executing ${queriesToRun.length} SuiteQL queries in parallel...`,
						);

						const parallelResults = await Promise.all(
							queriesToRun.map(async (queryStr, index) => {
								try {
									const queryRes = await mcpTools.executeTool(
										"ns_runCustomSuiteQL",
										{ sqlQuery: queryStr },
									);
									const formatted = formatSuiteQLToCompactMarkdown(queryRes);
									return {
										index: index + 1,
										query: queryStr,
										success: true,
										formatted,
									};
								} catch (err: unknown) {
									const errorMsg =
										err instanceof Error ? err.message : String(err);
									return {
										index: index + 1,
										query: queryStr,
										success: false,
										error: formatSuiteQLErrorResponse(errorMsg, queryStr),
									};
								}
							}),
						);

						let combinedMarkdown = `## 📊 Parallel SuiteQL Batch Execution (${queriesToRun.length} Queries)\n\n`;
						let failCount = 0;
						for (const res of parallelResults) {
							combinedMarkdown += `### 🔹 Query #${res.index}\n\`\`\`sql\n${res.query}\n\`\`\`\n\n`;
							if (res.success) {
								combinedMarkdown += `${res.formatted}\n\n`;
							} else {
								failCount++;
								combinedMarkdown += `${res.error}\n\n`;
							}
						}
						return textResult(
							combinedMarkdown.trim(),
							failCount === parallelResults.length,
						);
					}

					// Single query execution (faithful execution, no auto-rewriting)
					await reportProgress(
						1,
						2,
						"Executing SuiteQL query against NetSuite...",
					);
					const queryParams: Record<string, unknown> = {
						sqlQuery: queriesToRun[0],
					};
					if (safeArgs.customRecordMappings) {
						queryParams.customRecordMappings = safeArgs.customRecordMappings;
					}
					const queryRes = await mcpTools.executeTool(
						"ns_runCustomSuiteQL",
						queryParams,
					);
					return textResult(formatSuiteQLToCompactMarkdown(queryRes));
				}

				// 4. netsuite_get_metadata — Single authoritative table & schema reconnaissance
				if (name === "netsuite_get_metadata") {
					return await handleGetMetadata(safeArgs, mcpTools);
				}

				// 5. netsuite_get_record — Single authoritative record fetch & inspection
				if (name === "netsuite_get_record") {
					return await handleGetRecord(
						safeArgs,
						mcpTools,
						oauthManager,
						resolveCustomRecordRectype,
					);
				}

				// 6. netsuite_get_script_logs — SuiteScript logs debugging
				if (name === "netsuite_get_script_logs") {
					return await handleGetScriptLogs(safeArgs, mcpTools);
				}

				// 7. netsuite_get_system_notes — Standalone audit trail (Pitfall 11)
				if (name === "netsuite_get_system_notes") {
					return await handleGetSystemNotes(safeArgs, mcpTools);
				}

				// 8. netsuite_deploy_script — SuiteCloud deployment with syntax pre-flight
				if (name === "netsuite_deploy_script") {
					return await handleSuitecloudUpload(
						safeArgs,
						oauthManager,
						deps.projectRoot,
					);
				}

				// 9. netsuite_create_record — Record creation in Sandbox
				if (name === "netsuite_create_record") {
					return await handleCreateRecord(
						safeArgs,
						mcpTools,
						oauthManager,
						resolveCustomRecordRectype,
					);
				}

				// 10. netsuite_update_record — Record update in Sandbox
				if (name === "netsuite_update_record") {
					return await handleUpdateRecord(
						safeArgs,
						mcpTools,
						oauthManager,
						resolveCustomRecordRectype,
					);
				}

				// Unknown tool rejection
				return textResult(
					`❌ Unknown tool: '${name}'. Available tools: ${LOCAL_TOOLS.map((t) => t.name).join(", ")}`,
					true,
				);
			})();

			return await recordErrorIfPresent(result);
		} catch (error: unknown) {
			if (error instanceof ProtocolError) {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;

			if (isPermissionError(message)) {
				const guidance = message.includes(
					"PERMISSION DENIED — HARD STOP REQUIRED",
				)
					? ""
					: `\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`;
				return await recordErrorIfPresent(
					textResult(
						`❌ NetSuite Permission Error: ${message}${guidance}`,
						true,
					),
					stack,
				);
			}

			if (name === "netsuite_run_suiteql") {
				const sqlQuery =
					typeof safeArgs.sqlQuery === "string" ? safeArgs.sqlQuery : "";
				return await recordErrorIfPresent(
					textResult(formatSuiteQLErrorResponse(message, sqlQuery), true),
					stack,
				);
			}

			return await recordErrorIfPresent(
				textResult(`❌ Error: ${message}`, true),
				stack,
			);
		}
	});
}
