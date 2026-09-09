import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { normalizeStandardArgs } from "../utils/args.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "../utils/contextSlimmer.js";
import { buildEnvSuffix, isSandboxAccount } from "../utils/environment.js";
import {
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
} from "../utils/errors.js";
import {
	formatTableCatalogMarkdown,
	searchSuiteQLCatalog,
	unwrapMcpContent,
} from "../utils/metadata.js";
import { formatSuiteQLErrorResponse } from "../utils/suiteqlGuard.js";
import { classifyError, recordToolError } from "../utils/toolErrorLogger.js";
import { handleGetErrorSummary, handleStatus } from "./authHandlers.js";
import { handleBatchExecute } from "./batchHandler.js";
import { handleSuitecloudUpload } from "./deployHandlers.js";
import { hydrateMetadataIfNeeded } from "./metadataHydrator.js";
import {
	handleGetQueryTemplate,
	handleGetScriptLogs,
} from "./queryHandlers.js";
import {
	appendRecordLink,
	handleGetRecordDefinition,
	handleGetRecordLink,
	handleGetSystemNotes,
	handleInspectRecord,
} from "./recordHandlers.js";
import {
	AUTH_TOOL,
	LOCAL_TOOLS,
	LOGOUT_TOOL,
	METADATA_RULES_SUFFIX,
	STATUS_TOOL,
	SUITEQL_RULES_SUFFIX,
} from "./toolSchemas.js";
import type { ToolHandlerDeps } from "./types.js";

export type { ToolHandlerDeps };

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

// ---------------------------------------------------------------------------
// Tool description & annotation enhancement helpers
// ---------------------------------------------------------------------------

/**
 * Generate standard MCP tool annotations.
 * - readOnlyHint: Indicates tool produces no side effects or data mutations.
 * - destructiveHint: Indicates tool mutates or deletes data.
 * - idempotentHint: Indicates calling repeatedly with identical arguments produces identical results.
 */
export function getToolAnnotations(name: string): Record<string, boolean> {
	const READ_ONLY_TOOLS = new Set([
		"ns_runCustomSuiteQL",
		"ns_getRecord",
		"ns_getRecordTypeMetadata",
		"ns_getSuiteQLMetadata",
		"ns_runReport",
		"ns_listAllReports",
		"ns_listSavedSearches",
		"ns_runSavedSearch",
		"ns_getSubsidiaries",
		"ns_getAccountingBooks",
		"ns_getAccountingContexts",
		"ns_getNexusIds",
		"netsuite_status",
		"netsuite_get_record_link",
		"netsuite_get_script_logs",
		"netsuite_inspect_record",
		"netsuite_get_record_definition",
		"netsuite_get_query_template",
		"netsuite_get_system_notes",
		"netsuite_get_error_summary",
	]);

	const DESTRUCTIVE_TOOLS = new Set([
		"ns_createRecord",
		"ns_updateRecord",
		"netsuite_suitecloud_upload",
		"netsuite_logout",
	]);

	const IDEMPOTENT_TOOLS = new Set([
		...READ_ONLY_TOOLS,
		"netsuite_refresh_cache",
		"netsuite_logout",
	]);

	const isReadOnly = READ_ONLY_TOOLS.has(name);
	const isDestructive = DESTRUCTIVE_TOOLS.has(name);
	const isIdempotent = IDEMPOTENT_TOOLS.has(name);

	return {
		readOnlyHint: isReadOnly,
		...(isDestructive ? { destructiveHint: true } : {}),
		...(isIdempotent ? { idempotentHint: true } : {}),
	};
}

/** Append suffix to a tool's description string and attach MCP annotations. */
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

/**
 * Enhance fetched NetSuite tool descriptions with SuiteQL rules and parameter-level guidance.
 */
function enhanceToolDescriptions(
	tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return tools.map((t) => {
		const toolName = (t.name as string) || "";
		const annotations = getToolAnnotations(toolName);
		let enhanced: Record<string, unknown> = { ...t, annotations };

		if (t.name === "ns_runCustomSuiteQL") {
			enhanced = enhanceDescription(enhanced, SUITEQL_RULES_SUFFIX);
			if (enhanced.inputSchema && typeof enhanced.inputSchema === "object") {
				const schema = { ...(enhanced.inputSchema as Record<string, unknown>) };
				if (schema.properties && typeof schema.properties === "object") {
					const props = { ...(schema.properties as Record<string, unknown>) };
					if (props.sqlQuery && typeof props.sqlQuery === "object") {
						props.sqlQuery = {
							...(props.sqlQuery as Record<string, unknown>),
							description:
								"The SuiteQL query string to execute. UNIVERSAL RULES: (1) Reconnaissance: Verify exact table and column names via 'ns_getSuiteQLMetadata' before querying unfamiliar schemas. (2) Dialect: Explicit columns only (no SELECT *), use ROWNUM <= N or FETCH FIRST N ROWS ONLY (no LIMIT/OFFSET), wrap dates in TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD'), and use BUILTIN.DF(field) for labels. (3) Table Granularity: Distinguish header from line tables (filter line items with mainline='F'; relationship/upstream fields like createdfrom live on line tables); prefer domain-specialized tables over monolithic base tables for aggregations; never JOIN SystemNote directly. (4) Indexing: High-volume queries must include indexed filters (id, tranid, trandate, type, entity, subsidiary).",
						};
					}
					schema.properties = props;
				}
				enhanced.inputSchema = schema;
			}
			return enhanced;
		}

		if (t.name === "ns_getSuiteQLMetadata") {
			enhanced = enhanceDescription(enhanced, METADATA_RULES_SUFFIX);
			if (enhanced.inputSchema && typeof enhanced.inputSchema === "object") {
				const schema = { ...(enhanced.inputSchema as Record<string, unknown>) };
				const props = {
					...((schema.properties as Record<string, unknown>) || {}),
				};
				props.keyword = {
					type: "string",
					description:
						"Optional search keyword to discover available NetSuite SuiteQL tables across all business domains (e.g. 'inventory', 'transaction', 'invoice', 'order', 'account', 'customer', 'bom'). If provided without recordType, returns matching table names and descriptions in milliseconds without network timeout.",
				};
				schema.properties = props;
				enhanced.inputSchema = schema;
			}
			return enhanced;
		}

		if (t.name === "ns_getRecordTypeMetadata") {
			enhanced = enhanceDescription(enhanced, METADATA_RULES_SUFFIX);
			return enhanced;
		}

		// Document number guidance for record operations
		if (
			t.name === "ns_getRecord" ||
			t.name === "ns_updateRecord" ||
			t.name === "netsuite_get_record_link" ||
			t.name === "netsuite_get_system_notes"
		) {
			enhanced = enhanceDescription(
				enhanced,
				"\n\n💡 [Tranid Support]: Both numeric internal ID (e.g. 12345) and document number tranid (e.g. 'SO1002', 'INV-2025-01') are supported and will be automatically resolved.",
			);
			return enhanced;
		}

		return enhanced;
	});
}

/**
 * Interactive web-browser app tools to prune in headless agent environments.
 */
const PRUNED_TOOLS = new Set([
	"ns_prompt_library_app",
	"ns_selector_app",
	"ns_report_filters_app",
	"ns_getAccountingContexts",
	"ns_getNexusIds",
]);

// ---------------------------------------------------------------------------
// Handler Registration
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
		const envSuffix = buildEnvSuffix(accountId ?? null);

		// Unauthenticated: only expose authentication, logout and status
		if (!isAuthenticated) {
			return {
				tools: [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map((t) =>
					enhanceDescription(
						t as unknown as Record<string, unknown>,
						envSuffix,
					),
				) as unknown as Tool[],
			};
		}

		// Authenticated: fetch remote tools + merge local tools
		const listStartTime = Date.now();
		let remoteTools: unknown[] = [];
		try {
			remoteTools = await mcpTools.fetchTools();
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			recordToolError({
				tool: "tools/list",
				accountId,
				environment: accountId
					? isSandboxAccount(accountId)
						? "Sandbox"
						: "Production"
					: "Unknown",
				durationMs: Date.now() - listStartTime,
				category: "NETWORK_OR_TIMEOUT",
				errorMessage: `Failed to fetch tools from NetSuite API: ${message}`,
				parameters: {},
			});
			return {
				tools: [...LOCAL_TOOLS, LOGOUT_TOOL].map((t) =>
					enhanceDescription(
						t as unknown as Record<string, unknown>,
						envSuffix,
					),
				) as unknown as Tool[],
			};
		}

		const isSandbox = accountId ? isSandboxAccount(accountId) : false;

		const filteredRemote = (remoteTools as Array<Record<string, unknown>>)
			.filter((t) => typeof t.name === "string" && !PRUNED_TOOLS.has(t.name))
			.filter(
				(t) =>
					!LOCAL_TOOLS.some((local) => local.name === t.name) &&
					t.name !== "netsuite_authenticate",
			)
			.filter((t) => {
				if (
					!isSandbox &&
					(t.name === "ns_createRecord" || t.name === "ns_updateRecord")
				) {
					return false;
				}
				return true;
			});

		const enhancedRemote = enhanceToolDescriptions(filteredRemote);

		const allTools = [...LOCAL_TOOLS, LOGOUT_TOOL, ...enhancedRemote].map((t) =>
			enhanceDescription(t as unknown as Record<string, unknown>, envSuffix),
		);

		return {
			tools: allTools as unknown as Tool[],
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
			if (res.isError && name !== "netsuite_get_error_summary") {
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
			return res;
		};

		try {
			const result = await (async (): Promise<CallToolResult> => {
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
				if (name === "netsuite_get_error_summary") {
					return await handleGetErrorSummary(safeArgs);
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
					return await handleBatchExecute(safeArgs, deps, reportProgress);
				}
				if (name === "netsuite_get_script_logs") {
					return await handleGetScriptLogs(safeArgs, mcpTools);
				}
				if (name === "netsuite_inspect_record") {
					return await handleInspectRecord(safeArgs, mcpTools);
				}
				if (name === "netsuite_get_record_definition") {
					return await handleGetRecordDefinition(safeArgs);
				}
				if (name === "netsuite_get_query_template") {
					return await handleGetQueryTemplate(safeArgs);
				}
				if (name === "netsuite_get_system_notes") {
					return await handleGetSystemNotes(safeArgs, mcpTools);
				}
				if (name === "netsuite_suitecloud_upload") {
					return await handleSuitecloudUpload(
						safeArgs,
						oauthManager,
						deps.projectRoot,
					);
				}

				// --- Fast metadata discovery for ns_getSuiteQLMetadata without recordType ---
				if (name === "ns_getSuiteQLMetadata") {
					const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
					if (!recordTypeRaw) {
						const keywordRaw = safeArgs.keyword || safeArgs.search;
						const keyword =
							typeof keywordRaw === "string" ? keywordRaw.trim() : undefined;
						const entries = searchSuiteQLCatalog(keyword);
						return textResult(formatTableCatalogMarkdown(entries, keyword));
					}
				}

				// --- Defense for interactive _app tools in headless/coding environment ---
				if (
					name === "ns_prompt_library_app" ||
					name === "ns_selector_app" ||
					name === "ns_report_filters_app"
				) {
					return textResult(
						`⛔ [Interactive App Unsupported] The tool '${name}' is an interactive UI widget designed strictly for NetSuite web browser environments. It is not supported in headless agent environments to prevent task hanging. Please use 'ns_runCustomSuiteQL' or 'netsuite_inspect_record' instead.`,
						true,
					);
				}

				// --- Dual-Gate Defense: Strictly block write operations in production ---
				if (name === "ns_createRecord" || name === "ns_updateRecord") {
					const accountId =
						(await oauthManager.getAccountId()) ||
						process.env.NETSUITE_ACCOUNT_ID;
					if (!accountId || !isSandboxAccount(accountId)) {
						return textResult(
							`⛔ [Production Safety Violation] Operation '${name}' is strictly blocked in Production environment (${accountId || "unknown"}). ` +
								`Record create and update operations are only permitted in Sandbox / Test environments (accounts containing '_SB' or 'TSTDRV').`,
							true,
						);
					}
				}

				// --- Zero-friction document number (tranid) resolution for ns_getRecord ---
				if (name === "ns_getRecord") {
					const rawRecordId = String(
						safeArgs.recordId || safeArgs.id || "",
					).trim();
					if (rawRecordId && !/^\d+$/.test(rawRecordId)) {
						try {
							const safeTranid = rawRecordId.replace(/'/g, "''");
							const lookupSql = `SELECT id, recordtype FROM transaction WHERE tranid = '${safeTranid}' FETCH FIRST 1 ROWS ONLY`;
							const lookupRes = await mcpTools.executeTool(
								"ns_runCustomSuiteQL",
								{
									sqlQuery: lookupSql,
								},
							);
							const rows = mcpTools.extractDataArray(lookupRes);
							if (rows.length > 0 && rows[0]?.id) {
								safeArgs.recordId = String(rows[0].id);
								safeArgs.id = String(rows[0].id);
								if (rows[0].recordtype) {
									safeArgs.recordType = String(
										rows[0].recordtype,
									).toLowerCase();
								}
							}
						} catch {
							// Continue with original recordId if lookup fails
						}
					}
				}

				// --- Proxy to NetSuite MCP API ---
				let result: unknown;
				let executeError: unknown = null;

				if (name === "ns_runCustomSuiteQL") {
					await reportProgress(
						1,
						3,
						"Validating & optimizing SuiteQL query...",
					);
				}

				try {
					if (name === "ns_runCustomSuiteQL") {
						await reportProgress(
							2,
							3,
							"Executing SuiteQL query against NetSuite...",
						);
					}
					result = await mcpTools.executeTool(name, safeArgs);
					if (name === "ns_runCustomSuiteQL") {
						await reportProgress(
							3,
							3,
							"Formatting & slimming response payload...",
						);
					}
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
							if (isPermissionError(String(errorMsg))) {
								return textResult(
									`❌ NetSuite Permission Error: ${errorMsg}\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`,
									true,
								);
							}
							if (name === "ns_getSuiteQLMetadata") {
								return textResult(
									formatSuiteQLErrorResponse(String(errorMsg)),
									true,
								);
							}
							return textResult(`❌ NetSuite Error: ${errorMsg}`, true);
						}

						const compactMarkdown =
							formatMetadataToCompactMarkdown(hydratedResult);
						return textResult(compactMarkdown);
					}

					if (executeError) {
						const errMsg =
							executeError instanceof Error
								? executeError.message
								: String(executeError);
						if (name === "ns_getSuiteQLMetadata") {
							return textResult(formatSuiteQLErrorResponse(errMsg), true);
						}
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
					const errorMsg = String(
						parsedRecordResult.error ||
							parsedRecordResult.message ||
							JSON.stringify(parsedRecordResult),
					);
					if (isPermissionError(errorMsg)) {
						return textResult(
							`❌ NetSuite Permission Error: ${errorMsg}\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`,
							true,
						);
					}
					if (name === "ns_runCustomSuiteQL") {
						const sqlQuery = (safeArgs.sqlQuery ||
							safeArgs.query ||
							safeArgs.sql ||
							"") as string;
						return textResult(
							formatSuiteQLErrorResponse(errorMsg, sqlQuery),
							true,
						);
					}
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
			})();

			return await recordErrorIfPresent(result);
		} catch (error: unknown) {
			// Let McpError propagate directly to the MCP SDK
			if (error instanceof ProtocolError) {
				throw error;
			}
			// All other errors: return as tool-level error response
			const message = error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			let guidance = "";
			let finalRes: CallToolResult;
			if (isPermissionError(message)) {
				// DO NOT attach self-healing guidance on permission errors
				if (!message.includes("PERMISSION DENIED — HARD STOP REQUIRED")) {
					guidance = `\n\n${PERMISSION_HARD_STOP_ADVICE.trim()}`;
				}
				finalRes = textResult(`❌ Error: ${message}${guidance}`, true);
			} else if (name === "ns_runCustomSuiteQL") {
				const sqlQuery = (safeArgs.sqlQuery ||
					safeArgs.query ||
					safeArgs.sql ||
					"") as string;
				finalRes = textResult(
					formatSuiteQLErrorResponse(message, sqlQuery),
					true,
				);
			} else if (
				name === "ns_getRecord" ||
				name === "ns_createRecord" ||
				name === "ns_updateRecord"
			) {
				guidance =
					"\n\n💡 [Self-Healing Action]: Call `ns_getRecordTypeMetadata` to check schema constraints and valid field IDs.";
				finalRes = textResult(`❌ Error: ${message}${guidance}`, true);
			} else {
				finalRes = textResult(`❌ Error: ${message}`, true);
			}
			return await recordErrorIfPresent(finalRes, stack);
		}
	});
}
