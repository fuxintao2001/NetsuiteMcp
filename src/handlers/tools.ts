import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import {
	ProtocolError,
	ProtocolErrorCode,
	type Server,
} from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";
import { processParallelBatch } from "../utils/batchProcessor.js";
import { cacheService } from "../utils/cache.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import { buildEnvSuffix, isSandboxAccount } from "../utils/environment.js";
import { asyncJsonParse } from "../utils/json.js";
import {
	type JsonSchemaProperty,
	mapFieldType,
	sanitizeIntegerId,
	unwrapMcpContent,
} from "../utils/metadata.js";
import { generateNetSuiteUrl } from "../utils/netsuiteUrls.js";
import {
	AUTH_TOOL,
	BatchExecuteArgsSchema,
	GetRecordLinkArgsSchema,
	GetScriptLogsArgsSchema,
	LOCAL_TOOLS,
	LOGOUT_TOOL,
	METADATA_RULES_SUFFIX,
	STATUS_TOOL,
	SUITEQL_RULES_SUFFIX,
} from "./toolSchemas.js";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Create a text content response matching the MCP SDK CallToolResult shape. */
export function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

type ToolResponse = CallToolResult;

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface ToolHandlerDeps {
	server: Server;
	oauthManager: OAuthManager;
	mcpTools: NetSuiteMCPTools;
	projectRoot: string;
	handleAuthentication: (
		args: Record<string, unknown>,
	) => Promise<ToolResponse>;
	handleLogout: () => Promise<ToolResponse>;
	handleCacheRefresh: (args: Record<string, unknown>) => Promise<ToolResponse>;
	resolveCustomRecordRectype: (
		type: string,
	) => number | null | Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Local tool handlers
// ---------------------------------------------------------------------------

async function handleGetRecordLink(
	args: Record<string, unknown>,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<ToolResponse> {
	const parsed = GetRecordLinkArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const {
		recordId,
		recordType,
		accountId: targetAccId,
		rectype: explicitRectype,
	} = parsed.data;

	const currentAccountId = await oauthManager.getAccountId();
	const targetAccountId = targetAccId || currentAccountId;

	if (!targetAccountId) {
		return textResult("❌ Account ID not found.", true);
	}

	let rectype = explicitRectype;
	const isCustomRecord = recordType?.toLowerCase().startsWith("customrecord");

	if (!rectype && recordType && isCustomRecord) {
		rectype = (await resolveRectype(recordType)) ?? undefined;
	}

	// Detect if recordId might be a document number (tranid) instead of internal numeric ID
	const isNumericId = /^\d+$/.test(recordId.trim());
	let idWarning = "";
	if (!isNumericId) {
		idWarning = `\n\n⚠️ **Warning:** The provided recordId ('${recordId}') appears to be a document number (tranid) rather than a numeric internal ID. NetSuite UI links require the numeric internal ID (e.g. '123456'). If this link fails to open the record, query its internal ID first via SuiteQL (e.g. \`SELECT id FROM transaction WHERE tranid = '${recordId}'\`).`;
	}

	const url = generateNetSuiteUrl(
		targetAccountId,
		recordType,
		recordId,
		rectype,
	);

	if (!url) {
		if (isCustomRecord && !rectype) {
			return textResult(
				`❌ Failed to generate NetSuite UI Link for custom record '${recordType}': NetSuite custom record URLs strictly require the numeric custom record type ID (rectype). Automatic resolution via SuiteQL failed (ensure your NetSuite integration role has 'Custom Record Types' permission under Permissions > Setup, or provide the numeric 'rectype' parameter explicitly).`,
				true,
			);
		}
		return textResult(
			"❌ Failed to generate NetSuite UI Link: invalid or missing parameters.",
			true,
		);
	}

	let responseText = `🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`;
	if (idWarning) {
		responseText += idWarning;
	}
	return textResult(responseText);
}

async function handleGetScriptLogs(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = GetScriptLogsArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(`❌ ${parsed.error.issues[0]?.message}`, true);
	}
	const {
		scriptId,
		type: logType,
		dateFrom,
		dateTo,
		title,
		detail,
		deploymentId,
		limit,
	} = parsed.data;

	// Build SELECT with Script info joined for complete visibility
	let sql = `SELECT sn.date, sn.type, sn.title, sn.detail, s.scriptid AS scriptScriptId, s.name AS scriptName FROM ScriptNote AS sn LEFT JOIN Script AS s ON sn.scripttype = s.id`;

	// Build WHERE clauses
	const conditions: string[] = [];

	if (scriptId) {
		const escapedScriptId = scriptId.replace(/'/g, "''");
		conditions.push(`s.scriptid = '${escapedScriptId}'`);
	}
	if (deploymentId) {
		const escapedDeploymentId = deploymentId.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype IN (SELECT sd.script FROM ScriptDeployment sd WHERE sd.scriptid = '${escapedDeploymentId}')`,
		);
	}
	if (logType) {
		conditions.push(`sn.type = '${logType.toUpperCase()}'`);
	}
	if (dateFrom) {
		conditions.push(`sn.date >= TO_DATE('${dateFrom}', 'YYYY-MM-DD')`);
	}
	if (dateTo) {
		// Include the full day of dateTo (up to 23:59:59) by checking < dateTo + 1
		conditions.push(`sn.date < TO_DATE('${dateTo}', 'YYYY-MM-DD') + 1`);
	}
	if (title) {
		const escapedTitle = title.replace(/'/g, "''");
		conditions.push(`UPPER(sn.title) LIKE UPPER('%${escapedTitle}%')`);
	}
	if (detail) {
		const escapedDetail = detail.replace(/'/g, "''");
		conditions.push(`UPPER(sn.detail) LIKE UPPER('%${escapedDetail}%')`);
	}

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	sql += ` ORDER BY sn.date DESC FETCH FIRST ${limit} ROWS ONLY`;

	try {
		const result = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: sql,
		});

		// Check if SuiteQL returned a NetSuite-level error JSON payload
		const parsedResult = unwrapMcpContent(result) as Record<
			string,
			unknown
		> | null;

		if (parsedResult && typeof parsedResult === "object") {
			if (parsedResult.error || parsedResult.success === false) {
				const errorMsg = String(
					parsedResult.error ||
						parsedResult.message ||
						JSON.stringify(parsedResult),
				);
				if (
					errorMsg.includes("Record 'ScriptNote' was not found") ||
					errorMsg.includes("Record 'Script' was not found")
				) {
					return textResult(
						`❌ NetSuite Error: ${errorMsg}\n\n💡 Tip: Accessing script execution logs (ScriptNote table) requires the current NetSuite role to have the 'SuiteScript' (ADMI_CUSTOMSCRIPT) permission with at least 'View' level under Permissions > Setup.`,
						true,
					);
				}
				return textResult(`❌ Failed to query script logs: ${errorMsg}`, true);
			}
		}

		const data = mcpTools.extractDataArray(result);

		return textResult(
			JSON.stringify(
				{
					totalResults: data.length,
					query: sql,
					data,
				},
				null,
				2,
			),
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ Failed to query script logs: ${msg}`, true);
	}
}

async function handleBatchExecute(
	args: Record<string, unknown>,
	deps: ToolHandlerDeps,
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

	const accountId = await oauthManager.getAccountId();
	const isSandbox = accountId ? isSandboxAccount(accountId) : false;

	const batchResult = await processParallelBatch(
		tasks,
		async (task) => {
			if (!task || typeof task.toolName !== "string") {
				throw new Error("Invalid task: missing or invalid toolName");
			}

			const { toolName, arguments: toolArgs = {} } = task;
			const safeArgs = (toolArgs || {}) as Record<string, unknown>;

			// Normalize parameters
			if (safeArgs.recordType && typeof safeArgs.recordType === "string") {
				safeArgs.recordType = safeArgs.recordType.toLowerCase().trim();
			}
			if (safeArgs.tableName && typeof safeArgs.tableName === "string") {
				safeArgs.tableName = safeArgs.tableName.toLowerCase().trim();
			}

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

/**
 * netsuite_status — Diagnostic tool
 */
async function handleStatus(oauthManager: OAuthManager): Promise<ToolResponse> {
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

/** Append a NetSuite UI deep link to a record operation response. */
async function appendRecordLink(
	responseText: string,
	args: Record<string, unknown>,
	result: unknown,
	oauthManager: OAuthManager,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<string> {
	const resObj =
		typeof result === "object" && result !== null
			? (result as Record<string, unknown>)
			: null;
	const recordId =
		(args.recordId as string) ||
		(resObj && (resObj.id || resObj.internalid)
			? String(resObj.id || resObj.internalid)
			: undefined);
	const recordType =
		(args.recordType as string) ||
		(resObj?.recordType ? String(resObj.recordType) : undefined);

	if (!recordId) return responseText;

	const currentAccountId = await oauthManager.getAccountId();
	if (!currentAccountId) return responseText;

	let rectype = args.rectype as number | string | undefined;
	const isCustomRecord = recordType?.toLowerCase().startsWith("customrecord");

	if (!rectype && recordType && isCustomRecord) {
		rectype = (await resolveRectype(recordType)) ?? undefined;
	}

	const url = generateNetSuiteUrl(
		currentAccountId,
		recordType,
		recordId,
		rectype,
	);
	if (url) {
		responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
	} else if (isCustomRecord && !rectype) {
		responseText += `\n\n⚠️ **Note:** Could not auto-resolve numeric record type ID for custom record '${recordType}'. UI deep link omitted (ensure your NetSuite integration role has 'Custom Record Types' permission under Permissions > Setup).`;
	}
	return responseText;
}

// ---------------------------------------------------------------------------
// Tool description enhancement helpers
// ---------------------------------------------------------------------------

/** Append suffix to a tool's description string. */
function enhanceDescription(
	tool: Record<string, unknown>,
	suffix: string,
): Record<string, unknown> {
	const desc = (tool.description as string) || "";
	return { ...tool, description: desc ? `${desc}${suffix}` : suffix };
}

/** Enhance fetched NetSuite tool descriptions with SuiteQL rules. */
function enhanceToolDescriptions(
	tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return tools.map((t) => {
		if (t.name === "ns_runCustomSuiteQL") {
			return enhanceDescription(t, SUITEQL_RULES_SUFFIX);
		}
		if (t.name === "ns_getSuiteQLMetadata") {
			return enhanceDescription(t, METADATA_RULES_SUFFIX);
		}
		return t;
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all MCP tool handlers on the server.
 *
 * Error handling contract:
 * - McpError → rethrown to MCP SDK (protocol-level error)
 * - All other errors → returned as textResult with isError: true
 */
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

	// --- List Tools ---
	server.setRequestHandler("tools/list", async () => {
		try {
			const accountId =
				(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
			const envSuffix = buildEnvSuffix(accountId ?? null);

			const isAuthenticated = await oauthManager.hasValidSession();
			if (!isAuthenticated) {
				const unauthTools = [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map((t) =>
					enhanceDescription(t, envSuffix),
				);
				return { tools: unauthTools as unknown as Tool[] };
			}

			const tools = (await mcpTools.fetchTools()) as Array<
				Record<string, unknown>
			>;

			// Filter write tools in production
			const isSandbox = accountId ? isSandboxAccount(accountId) : false;
			const filteredTools = isSandbox
				? tools
				: tools.filter(
						(t) => t.name !== "ns_createRecord" && t.name !== "ns_updateRecord",
					);

			// Enhance SuiteQL tool descriptions with rules
			const enhancedTools = enhanceToolDescriptions(filteredTools);

			// Combine with local tools and append env suffix
			const finalTools = [...enhancedTools, ...LOCAL_TOOLS].map((t) =>
				enhanceDescription(t, envSuffix),
			);

			return { tools: finalTools as unknown as Tool[] };
		} catch {
			const accountId =
				(await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
			const envSuffix = buildEnvSuffix(accountId ?? null);
			const fallbackTools = [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map((t) =>
				enhanceDescription(t, envSuffix),
			);
			return { tools: fallbackTools as unknown as Tool[] };
		}
	});

	// --- Call Tool ---
	server.setRequestHandler("tools/call", async (request) => {
		const { name, arguments: args } = request.params;
		const safeArgs = (args || {}) as Record<string, unknown>;

		// Normalize recordType/tableName parameters to lowercase for case-sensitive NetSuite REST API
		if (safeArgs.recordType && typeof safeArgs.recordType === "string") {
			safeArgs.recordType = safeArgs.recordType.toLowerCase().trim();
		}
		if (safeArgs.tableName && typeof safeArgs.tableName === "string") {
			safeArgs.tableName = safeArgs.tableName.toLowerCase().trim();
		}

		try {
			// --- Tools that do NOT require authentication ---
			if (name === "netsuite_authenticate") {
				return await handleAuthentication(safeArgs);
			}
			if (name === "netsuite_logout") {
				return await handleLogout();
			}
			if (name === "netsuite_status") {
				return await handleStatus(oauthManager);
			}

			// --- All remaining tools require authentication ---
			const isAuthenticated = await oauthManager.hasValidSession();
			if (!isAuthenticated) {
				return textResult(
					"❌ Not authenticated. Please use the netsuite_authenticate tool first.",
					true,
				);
			}

			// --- Local tools (authenticated) ---
			if (name === "netsuite_refresh_cache") {
				return await handleCacheRefresh(safeArgs);
			}
			if (name === "netsuite_get_record_link") {
				return await handleGetRecordLink(
					safeArgs,
					oauthManager,
					resolveCustomRecordRectype,
				);
			}
			if (name === "netsuite_batch_execute") {
				return await handleBatchExecute(safeArgs, deps);
			}
			if (name === "netsuite_get_script_logs") {
				return await handleGetScriptLogs(safeArgs, mcpTools);
			}

			// --- Block write operations in production ---
			if (name === "ns_createRecord" || name === "ns_updateRecord") {
				const accountId = await oauthManager.getAccountId();
				if (accountId && !isSandboxAccount(accountId)) {
					throw new ProtocolError(
						ProtocolErrorCode.InvalidRequest,
						`Write operations are disabled in production environments: ${name}`,
					);
				}
			}

			// --- Proxy to NetSuite MCP API ---
			let result: unknown;
			let executeError: unknown = null;

			try {
				result = await mcpTools.executeTool(name, safeArgs);
			} catch (err: unknown) {
				if (
					name === "ns_getRecordTypeMetadata" ||
					name === "ns_getSuiteQLMetadata"
				) {
					executeError = err;
				} else {
					throw err;
				}
			}

			if (
				name === "ns_getRecordTypeMetadata" ||
				name === "ns_getSuiteQLMetadata"
			) {
				const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
				const hydratedResult = await hydrateMetadataIfNeeded(
					name,
					recordTypeRaw,
					result ?? null,
					mcpTools,
					resolveCustomRecordRectype,
				);

				if (hydratedResult) {
					const parsed = unwrapMcpContent(hydratedResult) as Record<
						string,
						unknown
					> | null;

					if (
						parsed &&
						typeof parsed === "object" &&
						parsed.success === false
					) {
						const errorMsg =
							parsed.error || parsed.message || JSON.stringify(parsed);
						return textResult(`❌ NetSuite Error: ${errorMsg}`, true);
					}

					const compactMarkdown =
						formatMetadataToCompactMarkdown(hydratedResult);
					return textResult(compactMarkdown);
				}

				if (executeError) {
					throw executeError;
				}

				const compactMarkdown = formatMetadataToCompactMarkdown(result);
				return textResult(compactMarkdown);
			}

			// Check if the record tool call returned a NetSuite-level error
			const parsedRecordResult = unwrapMcpContent(result) as Record<
				string,
				unknown
			> | null;

			if (
				parsedRecordResult &&
				typeof parsedRecordResult === "object" &&
				parsedRecordResult.success === false
			) {
				const errorMsg =
					parsedRecordResult.error ||
					parsedRecordResult.message ||
					JSON.stringify(parsedRecordResult);
				const guidance =
					"\n\n💡 [Self-Healing Action]: Call `ns_getRecordTypeMetadata` to check schema constraints and valid field IDs.";
				return textResult(`❌ NetSuite Error: ${errorMsg}${guidance}`, true);
			}

			if (name === "ns_runCustomSuiteQL") {
				return textResult(formatSuiteQLToCompactMarkdown(result));
			}

			if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				result = cleanRecordPayload(result);
			}

			let responseText =
				typeof result === "string" ? result : JSON.stringify(result, null, 2);

			// Auto-append UI deep link for record operations
			if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				responseText = await appendRecordLink(
					responseText,
					safeArgs,
					result,
					oauthManager,
					resolveCustomRecordRectype,
				);
			}

			return textResult(responseText);
		} catch (error: unknown) {
			// Let McpError propagate directly to the MCP SDK
			if (error instanceof ProtocolError) {
				throw error;
			}
			// All other errors: return as tool-level error response
			const message = error instanceof Error ? error.message : String(error);
			let guidance = "";
			if (name === "ns_runCustomSuiteQL") {
				guidance =
					"\n\n💡 [Self-Healing Action]: 1) Call `ns_getSuiteQLMetadata` for referenced tables to verify exact column names and case-sensitivity. 2) Revise your SuiteQL query and retry (Retry up to 3 times before asking the user).";
			} else if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				guidance =
					"\n\n💡 [Self-Healing Action]: Call `ns_getRecordTypeMetadata` to check schema constraints and valid field IDs.";
			}
			return textResult(`❌ Error: ${message}${guidance}`, true);
		}
	});
}

/** Hydrates NetSuite custom record metadata with custom fields from SuiteQL if needed. */
async function hydrateMetadataIfNeeded(
	_toolName: string,
	recordTypeRaw: unknown,
	originalResult: unknown,
	mcpTools: NetSuiteMCPTools,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<unknown> {
	const recordType =
		typeof recordTypeRaw === "string" ? recordTypeRaw.trim() : "";
	if (!recordType?.toLowerCase().startsWith("customrecord")) {
		return originalResult;
	}

	try {
		const rawRectype = await resolveRectype(recordType);
		if (!rawRectype) {
			return originalResult;
		}

		const rectype = sanitizeIntegerId(rawRectype);

		console.error(
			`🔍 Hydrating custom record metadata for ${recordType} (rectype: ${rectype})...`,
		);
		const qFields = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: `SELECT Name, ScriptID, FieldType, IsMandatory FROM CustomField WHERE RecordType = ${rectype}`,
		});
		const fields = mcpTools.extractDataArray(qFields);

		if (!fields || fields.length === 0) {
			return originalResult;
		}

		const properties: Record<string, JsonSchemaProperty> = {
			id: { title: "Internal ID", type: "string", nullable: true },
			name: { title: "Name", type: "string", nullable: true },
			externalId: { title: "External ID", type: "string", nullable: true },
			isinactive: { title: "Is Inactive", type: "boolean", nullable: true },
			owner: {
				title: "Owner",
				type: "object",
				properties: {
					id: { title: "Internal identifier", type: "string" },
					refName: { title: "Reference Name", type: "string" },
				},
				nullable: true,
			},
		};

		for (const field of fields) {
			const scriptId = String(field.scriptid || field.scriptId || "")
				.toLowerCase()
				.trim();
			if (scriptId) {
				properties[scriptId] = {
					title: String(field.name || field.label || scriptId),
					nullable: field.ismandatory !== "T",
					...mapFieldType(field.fieldtype as string | undefined),
				};
			}
		}

		let originalProperties: Record<string, JsonSchemaProperty> = {};
		const parsedOriginal = unwrapMcpContent(originalResult) as Record<
			string,
			unknown
		> | null;

		if (parsedOriginal && typeof parsedOriginal === "object") {
			const meta = (parsedOriginal.metadata || parsedOriginal) as Record<
				string,
				unknown
			>;
			if (
				meta &&
				typeof meta.properties === "object" &&
				meta.properties !== null
			) {
				originalProperties = meta.properties as Record<
					string,
					JsonSchemaProperty
				>;
			}
		}

		const finalProperties = { ...properties, ...originalProperties };

		const hydratedResponse = {
			success: true,
			metadata: {
				type: "object",
				properties: finalProperties,
			},
		};

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(hydratedResponse),
				},
			],
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`⚠️ Failed to hydrate custom record metadata: ${msg}`);
		return originalResult;
	}
}
