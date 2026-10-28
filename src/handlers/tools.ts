import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
	classifyError,
	recordToolError,
} from "../telemetry/toolErrorLogger.js";
import { normalizeStandardArgs } from "../utils/args.js";
import { formatSuiteQLToCompactMarkdown } from "../utils/contextSlimmer.js";
import { buildEnvSuffix, isSandboxAccount } from "../utils/environment.js";
import {
	assertNoMcpError,
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
} from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import {
	formatProbeResults,
	probeSuspiciousColumns,
} from "../utils/suiteqlColumnProbe.js";
import {
	formatSuiteQLErrorResponse,
	splitSuiteQLStatements,
} from "../utils/suiteqlGuard.js";
import {
	SUITEQL_TEMPLATES,
	suiteqlTemplateService,
} from "../utils/suiteqlTemplates.js";
import { handleAuth, handleStatus } from "./authHandlers.js";
import { handleCallOfficial } from "./officialHandlers.js";
import { handleGetScriptLogs } from "./queryHandlers.js";
import {
	handleCreateRecord,
	handleGetMetadata,
	handleGetRecord,
	handleGetSystemNotes,
	handleUpdateRecord,
} from "./recordHandlers.js";
import {
	AuthArgsSchema,
	type CallOfficialArgs,
	CallOfficialArgsSchema,
	CreateRecordArgsSchema,
	GetMetadataArgsSchema,
	GetRecordArgsSchema,
	GetScriptLogsArgsSchema,
	GetSystemNotesArgsSchema,
	LOCAL_TOOLS,
	RunSuiteQLArgsSchema,
	SANDBOX_MUTATION_TOOLS,
	StatusArgsSchema,
	UpdateRecordArgsSchema,
	UploadFileArgsSchema,
} from "./toolSchemas.js";
import { type ToolHandlerDeps, textResult } from "./types.js";
import { handleUploadFile } from "./uploadHandlers.js";

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
	"netsuite_upload_file",
	"netsuite_create_record",
	"netsuite_update_record",
]);

const IDEMPOTENT_TOOLS = new Set([
	...READ_ONLY_TOOLS,
	"netsuite_auth",
	"netsuite_call_official",
]);

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
// Declarative Tool Definition Registry
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
	deps: ToolHandlerDeps;
	reportProgress: (
		progress: number,
		total: number,
		message?: string,
	) => Promise<void>;
	accountId?: string | undefined;
	isSandbox: boolean;
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
	name: string;
	schema: TSchema;
	requiresAuth?: boolean;
	sandboxOnly?: boolean;
	execute: (
		args: z.infer<TSchema>,
		ctx: ToolExecutionContext,
	) => Promise<CallToolResult>;
}

export interface AnyToolDefinition {
	name: string;
	schema: z.ZodTypeAny;
	requiresAuth?: boolean | undefined;
	sandboxOnly?: boolean | undefined;
	execute: (
		args: unknown,
		ctx: ToolExecutionContext,
	) => Promise<CallToolResult>;
}

export function defineTool<TSchema extends z.ZodTypeAny>(
	def: ToolDefinition<TSchema>,
): AnyToolDefinition {
	return {
		name: def.name,
		schema: def.schema,
		requiresAuth: def.requiresAuth,
		sandboxOnly: def.sandboxOnly,
		execute: (args: unknown, ctx: ToolExecutionContext) =>
			def.execute(args as z.infer<TSchema>, ctx),
	};
}

const TOOL_DEFINITIONS: AnyToolDefinition[] = [
	defineTool({
		name: "netsuite_auth",
		schema: AuthArgsSchema,
		requiresAuth: false,
		execute: async (args, ctx) =>
			handleAuth(
				args as unknown as Record<string, unknown>,
				ctx.deps.handleAuthentication,
				ctx.deps.handleLogout,
				ctx.deps.handleCacheRefresh,
			),
	}),
	defineTool({
		name: "netsuite_status",
		schema: StatusArgsSchema,
		requiresAuth: false,
		execute: async (args, ctx) =>
			handleStatus(
				ctx.deps.oauthManager,
				args as unknown as Record<string, unknown>,
			),
	}),
	defineTool({
		name: "netsuite_run_suiteql",
		schema: RunSuiteQLArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) => {
			const {
				sqlQuery,
				sqlQueries,
				templateId,
				templateParams,
				customRecordMappings,
			} = args;

			let singleQuery = sqlQuery;
			if (templateId) {
				const template = suiteqlTemplateService.getTemplate(templateId);
				if (!template) {
					const available = SUITEQL_TEMPLATES.map((t) => `'${t.id}'`).join(
						", ",
					);
					return textResult(
						`❌ [Invalid Template ID] Unknown templateId: '${templateId}'. Available verified templates: ${available}`,
						true,
					);
				}
				singleQuery = suiteqlTemplateService.renderTemplate(
					template,
					templateParams,
				);
			}

			const queriesFromSingle = singleQuery
				? splitSuiteQLStatements(singleQuery)
				: [];
			const queriesFromArray = Array.isArray(sqlQueries)
				? sqlQueries
						.filter(
							(q): q is string => typeof q === "string" && q.trim().length > 0,
						)
						.flatMap((q) => splitSuiteQLStatements(q))
				: [];
			const queriesToRun = [...queriesFromSingle, ...queriesFromArray];

			if (queriesToRun.length === 0) {
				const receivedKeys = Object.keys(
					args as Record<string, unknown>,
				).filter((k) => (args as Record<string, unknown>)[k] !== undefined);
				const keysInfo =
					receivedKeys.length > 0
						? ` (received parameter keys: [${receivedKeys.join(", ")}])`
						: "";
				return textResult(
					`❌ 'sqlQuery', 'sqlQueries', or 'templateId' parameter is required and cannot be empty${keysInfo}.`,
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
			const resolvedMappings = customRecordMappings
				? structuredClone(customRecordMappings)
				: undefined;
			if (resolvedMappings) {
				await Promise.all(
					resolvedMappings.map(
						async (mapping: {
							rectype: string | number;
							scriptId?: string | undefined;
						}) => {
							if (mapping && typeof mapping.rectype === "string") {
								const resolvedId = await ctx.deps.resolveCustomRecordRectype(
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
						},
					),
				);
			}

			// Parallel multi-query execution
			if (queriesToRun.length > 1) {
				await ctx.reportProgress(
					1,
					queriesToRun.length + 1,
					`Executing ${queriesToRun.length} SuiteQL queries in parallel...`,
				);

				const parallelResults = await Promise.all(
					queriesToRun.map(async (queryStr, index) => {
						try {
							const queryParams: Record<string, unknown> = {
								sqlQuery: queryStr,
							};
							if (resolvedMappings) {
								queryParams.customRecordMappings = resolvedMappings;
							}
							const queryRes = await ctx.deps.mcpTools.executeTool(
								"ns_runCustomSuiteQL",
								queryParams,
							);
							assertNoMcpError(queryRes);
							const formatted = formatSuiteQLToCompactMarkdown(queryRes);
							return {
								index: index + 1,
								query: queryStr,
								success: true,
								formatted,
							};
						} catch (err: unknown) {
							const errorMsg = err instanceof Error ? err.message : String(err);
							if (isPermissionError(errorMsg)) {
								throw err;
							}
							let errorOutput = formatSuiteQLErrorResponse(errorMsg, queryStr);
							if (
								errorMsg.includes("unexpected SuiteScript error") &&
								ctx.accountId
							) {
								try {
									const probedIssues = await probeSuspiciousColumns(
										queryStr,
										ctx.accountId,
										ctx.deps.mcpTools,
									);
									if (probedIssues.length > 0) {
										errorOutput += formatProbeResults(probedIssues);
									}
								} catch {
									// Probe is non-fatal
								}
							}
							return {
								index: index + 1,
								query: queryStr,
								success: false,
								error: errorOutput,
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

				if (failCount > 0 && failCount < parallelResults.length) {
					telemetryLogger.warn(
						{
							tool: "netsuite_run_suiteql",
							totalQueries: parallelResults.length,
							failCount,
							successCount: parallelResults.length - failCount,
						},
						"Partial batch failure in SuiteQL execution",
					);
				}

				return textResult(
					combinedMarkdown.trim(),
					failCount === parallelResults.length,
				);
			}

			// Single query execution (faithful execution, no auto-rewriting)
			await ctx.reportProgress(
				1,
				2,
				"Executing SuiteQL query against NetSuite...",
			);
			const queryParams: Record<string, unknown> = {
				sqlQuery: queriesToRun[0],
			};
			if (resolvedMappings) {
				queryParams.customRecordMappings = resolvedMappings;
			}
			const queryRes = await ctx.deps.mcpTools.executeTool(
				"ns_runCustomSuiteQL",
				queryParams,
			);
			assertNoMcpError(queryRes);
			return textResult(formatSuiteQLToCompactMarkdown(queryRes));
		},
	}),
	defineTool({
		name: "netsuite_get_metadata",
		schema: GetMetadataArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) =>
			handleGetMetadata(
				args as unknown as Record<string, unknown>,
				ctx.deps.mcpTools,
			),
	}),
	defineTool({
		name: "netsuite_get_record",
		schema: GetRecordArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) =>
			handleGetRecord(
				args as unknown as Record<string, unknown>,
				ctx.deps.mcpTools,
				ctx.deps.oauthManager,
				ctx.deps.resolveCustomRecordRectype,
			),
	}),
	defineTool({
		name: "netsuite_get_script_logs",
		schema: GetScriptLogsArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) =>
			handleGetScriptLogs(
				args as unknown as Record<string, unknown>,
				ctx.deps.mcpTools,
			),
	}),
	defineTool({
		name: "netsuite_get_system_notes",
		schema: GetSystemNotesArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) =>
			handleGetSystemNotes(
				args as unknown as Record<string, unknown>,
				ctx.deps.mcpTools,
				ctx.deps.resolveCustomRecordRectype,
			),
	}),
	defineTool({
		name: "netsuite_upload_file",
		schema: UploadFileArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) =>
			handleUploadFile(
				args as unknown as Record<string, unknown>,
				ctx.deps.oauthManager,
				ctx.deps.projectRoot,
				ctx.deps.mcpTools,
			),
	}),
	defineTool({
		name: "netsuite_create_record",
		schema: CreateRecordArgsSchema,
		requiresAuth: true,
		sandboxOnly: true,
		execute: async (args, ctx) =>
			handleCreateRecord(
				args as unknown as Record<string, unknown>,
				ctx.deps.mcpTools,
				ctx.deps.oauthManager,
				ctx.deps.resolveCustomRecordRectype,
			),
	}),
	defineTool({
		name: "netsuite_update_record",
		schema: UpdateRecordArgsSchema,
		requiresAuth: true,
		sandboxOnly: true,
		execute: async (args, ctx) =>
			handleUpdateRecord(
				args as unknown as Record<string, unknown>,
				ctx.deps.mcpTools,
				ctx.deps.oauthManager,
				ctx.deps.resolveCustomRecordRectype,
			),
	}),
	defineTool({
		name: "netsuite_call_official",
		schema: CallOfficialArgsSchema,
		requiresAuth: true,
		execute: async (args, ctx) =>
			handleCallOfficial(
				args as unknown as CallOfficialArgs,
				ctx.deps.mcpTools,
				ctx.accountId,
				ctx.isSandbox,
			),
	}),
];

const TOOL_MAP = new Map<string, AnyToolDefinition>(
	TOOL_DEFINITIONS.map((def) => [def.name, def]),
);

// ---------------------------------------------------------------------------
// Handler Registration (8 Authoritative Tools)
// ---------------------------------------------------------------------------

export function registerToolHandlers(deps: ToolHandlerDeps): void {
	const { server, oauthManager } = deps;

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
				const diagMatch = /🔍 \*\*Diagnostic:\*\* ([^\n]+)/.exec(errorText);
				const diagnosis = diagMatch?.[1]?.trim();
				const category = classifyError(name, errorText);
				recordToolError({
					tool: name,
					accountId: currentAccountId,
					environment: currentEnv,
					durationMs: Date.now() - callStartTime,
					category,
					errorMessage: errorText,
					diagnosis,
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

		let detectedId: string | undefined;

		try {
			const tool = TOOL_MAP.get(name);
			if (!tool) {
				return await recordErrorIfPresent(
					textResult(
						`❌ Unknown tool: '${name}'. Available tools: ${LOCAL_TOOLS.map((t) => t.name).join(", ")}`,
						true,
					),
				);
			}

			// Pre-flight authentication check
			if (tool.requiresAuth !== false) {
				const isAuthenticated = await oauthManager.hasValidSession();
				if (!isAuthenticated) {
					return await recordErrorIfPresent(
						textResult(
							"❌ Not authenticated. Please use the 'netsuite_auth' tool to log in first.",
							true,
						),
					);
				}
			}

			// Detect NetSuite account ID and Sandbox environment for mutation guards
			let isSandbox = false;

			if (tool.sandboxOnly || tool.name === "netsuite_call_official") {
				try {
					detectedId =
						(await oauthManager.getAccountId()) ||
						process.env.NETSUITE_ACCOUNT_ID;
				} catch {
					// Non-fatal
				}
				isSandbox = detectedId ? isSandboxAccount(detectedId) : false;

				// Dual-gate production write protection for sandbox-only mutation tools
				if (tool.sandboxOnly && !isSandbox) {
					return await recordErrorIfPresent(
						textResult(
							`⛔ [Production Safety Violation] Tool '${name}' is restricted strictly to Sandbox environments. Writing to Production via MCP mutation tools is physically prohibited.`,
							true,
						),
					);
				}
			}

			// Zod schema parsing
			const parsed = tool.schema.safeParse(safeArgs);
			if (!parsed.success) {
				return await recordErrorIfPresent(
					textResult(
						`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
						true,
					),
				);
			}

			const context: ToolExecutionContext = {
				deps,
				reportProgress,
				accountId: detectedId,
				isSandbox,
			};

			const result = await tool.execute(parsed.data, context);
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
				let errOutput = formatSuiteQLErrorResponse(message, sqlQuery);
				const accId =
					detectedId ||
					(await oauthManager.getAccountId().catch(() => undefined));
				if (
					message.includes("unexpected SuiteScript error") &&
					accId &&
					sqlQuery
				) {
					try {
						const issues = await probeSuspiciousColumns(
							sqlQuery,
							accId,
							deps.mcpTools,
						);
						if (issues.length > 0) {
							errOutput += formatProbeResults(issues);
						}
					} catch {
						// Non-fatal
					}
				}
				return await recordErrorIfPresent(textResult(errOutput, true), stack);
			}

			return await recordErrorIfPresent(
				textResult(`❌ Error: ${message}`, true),
				stack,
			);
		}
	});
}
