import type { CallToolResult } from "@modelcontextprotocol/server";
import { normalizeStandardArgs } from "../utils/args.js";
import { processParallelBatch } from "../utils/batchProcessor.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import { isSandboxAccount } from "../utils/environment.js";
import {
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
} from "../utils/errors.js";
import { asyncJsonParse } from "../utils/json.js";
import { unwrapMcpContent } from "../utils/metadata.js";
import { hydrateMetadataIfNeeded } from "./metadataHydrator.js";
import { handleGetScriptLogs } from "./queryHandlers.js";
import { handleGetRecordLink } from "./recordHandlers.js";
import { BatchExecuteArgsSchema } from "./toolSchemas.js";
import type { ToolHandlerDeps } from "./types.js";

type ToolResponse = CallToolResult;

function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

export async function handleBatchExecute(
	args: Record<string, unknown>,
	deps: ToolHandlerDeps,
	onProgress?: (
		completed: number,
		total: number,
		message?: string,
	) => Promise<void>,
): Promise<ToolResponse> {
	const parsed = BatchExecuteArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const { tasks } = parsed.data;
	const { mcpTools, oauthManager, resolveCustomRecordRectype } = deps;

	const accountId =
		(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
	const isSandbox = accountId ? isSandboxAccount(accountId) : false;

	const batchResult = await processParallelBatch(
		tasks,
		async (task) => {
			if (!task || typeof task.toolName !== "string") {
				throw new Error("Invalid task: missing or invalid toolName");
			}

			const { toolName, arguments: toolArgs = {} } = task;
			const safeArgs = normalizeStandardArgs(
				(toolArgs || {}) as Record<string, unknown>,
			);

			// Enforce production write-protection guardrail
			if (
				(toolName === "ns_createRecord" || toolName === "ns_updateRecord") &&
				!isSandbox
			) {
				throw new Error(
					`Write operations are disabled in production environments: ${toolName}`,
				);
			}

			// Support local tools inside batch
			if (toolName === "netsuite_get_record_link") {
				const linkRes = await handleGetRecordLink(
					safeArgs,
					oauthManager,
					resolveCustomRecordRectype,
				);
				return linkRes.content[0]?.type === "text"
					? linkRes.content[0].text
					: linkRes;
			}
			if (toolName === "netsuite_get_script_logs") {
				const logsRes = await handleGetScriptLogs(safeArgs, mcpTools);
				if (logsRes.isError) {
					throw new Error(
						logsRes.content[0]?.type === "text"
							? logsRes.content[0].text
							: "Failed to get script logs",
					);
				}
				const text =
					logsRes.content[0]?.type === "text" ? logsRes.content[0].text : "";
				return await asyncJsonParse(text);
			}
			if (toolName === "netsuite_refresh_cache") {
				const refreshRes = await deps.handleCacheRefresh(safeArgs);
				return refreshRes.content[0]?.type === "text"
					? refreshRes.content[0].text
					: refreshRes;
			}

			let result = await mcpTools.executeTool(toolName, safeArgs);

			// Run hydration if metadata tool
			if (
				toolName === "ns_getRecordTypeMetadata" ||
				toolName === "ns_getSuiteQLMetadata"
			) {
				const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
				result = await hydrateMetadataIfNeeded(
					toolName,
					recordTypeRaw,
					result ?? null,
					mcpTools,
					resolveCustomRecordRectype,
				);
			}

			const parsedResult =
				typeof result === "string" ? await asyncJsonParse(result) : result;

			// Detect NetSuite-level error payloads in batch items
			const unwrapped = unwrapMcpContent(parsedResult);
			if (
				unwrapped &&
				typeof unwrapped === "object" &&
				(unwrapped as Record<string, unknown>).success === false
			) {
				const errObj = unwrapped as Record<string, unknown>;
				const errMsg = String(
					errObj.error || errObj.message || JSON.stringify(errObj),
				);
				if (isPermissionError(errMsg)) {
					throw new Error(
						`NetSuite Permission Error: ${errMsg}\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`,
					);
				}
				throw new Error(`NetSuite Error: ${errMsg}`);
			}

			// Clean/slim the results
			if (toolName === "ns_getRecord") {
				return cleanRecordPayload(parsedResult);
			}
			if (
				toolName === "ns_getRecordTypeMetadata" ||
				toolName === "ns_getSuiteQLMetadata"
			) {
				return formatMetadataToCompactMarkdown(parsedResult);
			}
			if (toolName === "ns_runCustomSuiteQL") {
				return formatSuiteQLToCompactMarkdown(parsedResult);
			}

			return parsedResult;
		},
		5,
		async (completed, total, result) => {
			if (onProgress) {
				const task = tasks[result.index];
				await onProgress(
					completed,
					total,
					`Executed ${task?.toolName || "tool"} (${completed}/${total})`,
				);
			}
		},
	);

	return textResult(
		JSON.stringify(
			{
				totalTasks: batchResult.total,
				successfulTasks: batchResult.successful,
				failedTasks: batchResult.failed,
				totalDurationMs: batchResult.totalDurationMs,
				individualResults: batchResult.individualResults.map((r, i) => ({
					index: r.index,
					toolName: tasks[i]?.toolName,
					success: r.success,
					durationMs: r.durationMs,
					...(r.success ? { result: r.result } : { error: r.error }),
				})),
			},
			null,
			2,
		),
	);
}
