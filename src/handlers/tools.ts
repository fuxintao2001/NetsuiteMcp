import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { NetSuiteMCPTools } from '../mcp/tools.js';
import { OAuthManager } from '../oauth/manager.js';
import { generateNetSuiteUrl } from '../utils/netsuiteUrls.js';
import { asyncJsonParse } from '../utils/json.js';
import { cacheService } from '../utils/cache.js';
import { isSandboxAccount, buildEnvSuffix } from '../utils/environment.js';
import { cleanRecordPayload, formatMetadataToCompactMarkdown } from '../utils/contextSlimmer.js';
import {
  AUTH_TOOL, LOGOUT_TOOL, LOCAL_TOOLS, STATUS_TOOL,
  SUITEQL_RULES_SUFFIX, METADATA_RULES_SUFFIX
} from './toolSchemas.js';

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

/** Create a text content response matching the MCP SDK CallToolResult shape. */
export function textResult(text: string, isError?: boolean): CallToolResult {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) };
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
  handleAuthentication: (args: Record<string, unknown>) => Promise<ToolResponse>;
  handleLogout: () => Promise<ToolResponse>;
  handleCacheRefresh: (args: Record<string, unknown>) => Promise<ToolResponse>;
  resolveCustomRecordRectype: (type: string) => number | null | Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Local tool handlers
// ---------------------------------------------------------------------------

async function handleGetRecordLink(
  args: Record<string, unknown>,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null | Promise<number | null>
): Promise<ToolResponse> {
  const currentAccountId = await oauthManager.getAccountId();
  const targetAccountId = (args.accountId as string) || currentAccountId;

  if (!targetAccountId) {
    return textResult('❌ Account ID not found.', true);
  }

  let rectype = args.rectype as number | string | undefined;
  const recordType = args.recordType as string | undefined;
  let hasMappingWarning = false;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = (await resolveRectype(recordType)) ?? undefined;
    if (!rectype) {
      hasMappingWarning = true;
    }
  }

  const url = generateNetSuiteUrl(targetAccountId, recordType, args.recordId as string, rectype);
  let responseText = `🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`;
  if (hasMappingWarning) {
    responseText += `\n\n⚠️ **Note:** Could not auto-resolve numeric record type ID for custom record '${recordType}'. The generated link uses the string ID, which might not load correctly unless you explicitly provide the numeric 'rectype' parameter or grant your NetSuite integration role the "Custom Record Types" setup permission.`;
  }
  return textResult(responseText);
}

async function handleRunParallelQueries(
  args: Record<string, unknown>,
  mcpTools: NetSuiteMCPTools
): Promise<ToolResponse> {
  const { queries } = args;
  if (!Array.isArray(queries) || queries.length === 0) {
    return textResult('❌ Invalid arguments: queries must be a non-empty array.', true);
  }

  const startTime = Date.now();
  const concurrencyLimit = 5;
  const results: Array<Record<string, unknown>> = new Array(queries.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < queries.length) {
      const index = nextIndex++;
      const sqlQuery = queries[index] as string;
      const queryStart = Date.now();
      try {
        const result = await mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery });
        results[index] = {
          index, success: true, durationMs: Date.now() - queryStart,
          query: sqlQuery,
          result: typeof result === 'string' ? await asyncJsonParse(result) : result
        };
      } catch (err: unknown) {
        results[index] = {
          index, success: false, durationMs: Date.now() - queryStart,
          query: sqlQuery,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrencyLimit, queries.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return textResult(JSON.stringify({
    totalQueries: queries.length,
    successfulQueries: results.filter(r => r.success).length,
    failedQueries: results.filter(r => !r.success).length,
    totalDurationMs: Date.now() - startTime,
    individualResults: results
  }, null, 2));
}

interface RecordToFetch {
  recordType: string;
  recordId: string;
  fields?: string;
}

async function handleGetParallelRecords(
  args: Record<string, unknown>,
  mcpTools: NetSuiteMCPTools
): Promise<ToolResponse> {
  const records = args.records as RecordToFetch[] | undefined;
  if (!Array.isArray(records) || records.length === 0) {
    return textResult('❌ Invalid arguments: records must be a non-empty array.', true);
  }

  const startTime = Date.now();
  const concurrencyLimit = 5;
  const results: Array<Record<string, unknown>> = new Array(records.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < records.length) {
      const index = nextIndex++;
      const item = records[index];
      if (!item) continue;
      const queryStart = Date.now();
      try {
        const result = await mcpTools.executeTool('ns_getRecord', {
          recordType: item.recordType,
          recordId: item.recordId,
          fields: item.fields
        });
        const parsedResult = typeof result === 'string' ? await asyncJsonParse(result) : result;
        results[index] = {
          index,
          success: true,
          durationMs: Date.now() - queryStart,
          recordType: item.recordType,
          recordId: item.recordId,
          result: cleanRecordPayload(parsedResult)
        };
      } catch (err: unknown) {
        results[index] = {
          index,
          success: false,
          durationMs: Date.now() - queryStart,
          recordType: item.recordType,
          recordId: item.recordId,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrencyLimit, records.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return textResult(JSON.stringify({
    totalRecords: records.length,
    successfulRecords: results.filter(r => r.success).length,
    failedRecords: results.filter(r => !r.success).length,
    totalDurationMs: Date.now() - startTime,
    individualResults: results
  }, null, 2));
}

async function handleGetParallelMetadata(
  args: Record<string, unknown>,
  mcpTools: NetSuiteMCPTools
): Promise<ToolResponse> {
  const recordTypes = args.recordTypes as string[] | undefined;
  const metaType = (args.type || 'record') as 'record' | 'suiteql';

  if (!Array.isArray(recordTypes) || recordTypes.length === 0) {
    return textResult('❌ Invalid arguments: recordTypes must be a non-empty array.', true);
  }

  const toolName = metaType === 'suiteql' ? 'ns_getSuiteQLMetadata' : 'ns_getRecordTypeMetadata';
  const startTime = Date.now();
  const concurrencyLimit = 5;
  const results: Array<Record<string, unknown>> = new Array(recordTypes.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < recordTypes.length) {
      const index = nextIndex++;
      const recordType = recordTypes[index];
      if (!recordType) continue;
      const queryStart = Date.now();
      try {
        const result = await mcpTools.executeTool(toolName, { recordType });
        const parsedResult = typeof result === 'string' ? await asyncJsonParse(result) : result;
        results[index] = {
          index,
          success: true,
          durationMs: Date.now() - queryStart,
          recordType,
          result: formatMetadataToCompactMarkdown(parsedResult)
        };
      } catch (err: unknown) {
        results[index] = {
          index,
          success: false,
          durationMs: Date.now() - queryStart,
          recordType,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrencyLimit, recordTypes.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return textResult(JSON.stringify({
    totalMetadataRequests: recordTypes.length,
    type: metaType,
    successfulRequests: results.filter(r => r.success).length,
    failedRequests: results.filter(r => !r.success).length,
    totalDurationMs: Date.now() - startTime,
    individualResults: results
  }, null, 2));
}

/**
 * netsuite_status — Diagnostic tool
 */
async function handleStatus(
  oauthManager: OAuthManager
): Promise<ToolResponse> {
  const sessionInfo = await oauthManager.getSessionInfo();
  const cacheStats = await cacheService.getStats();

  const status: Record<string, unknown> = {
    server: 'netsuite-mcp',
    version: '1.0.0',
    authenticated: sessionInfo.authenticated,
    refreshSchedulerActive: sessionInfo.refreshSchedulerActive,
    cache: cacheStats
  };

  if (sessionInfo.authenticated) {
    status.accountId = sessionInfo.accountId;
    status.clientId = sessionInfo.clientId ? `${sessionInfo.clientId.substring(0, 8)}...` : undefined;
    status.tokenExpiresIn = sessionInfo.tokenExpiresIn !== undefined
      ? `${sessionInfo.tokenExpiresIn}s`
      : 'unknown';
    status.tokenExpiresAt = sessionInfo.tokenExpiresAt
      ? new Date(sessionInfo.tokenExpiresAt).toISOString()
      : 'unknown';

    const sandbox = sessionInfo.accountId ? isSandboxAccount(sessionInfo.accountId) : false;
    status.environment = sandbox ? 'Sandbox/Test' : 'Production';
    status.writeOperations = sandbox ? 'enabled' : 'disabled';
  }

  return textResult(JSON.stringify(status, null, 2));
}

/** Append a NetSuite UI deep link to a record operation response. */
async function appendRecordLink(
  responseText: string,
  args: Record<string, unknown>,
  result: any,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null | Promise<number | null>
): Promise<string> {
  const recordId = args.recordId || (result && (result.id || result.internalid));
  const recordType = args.recordType || (result && result.recordType);

  if (!recordId) return responseText;

  const currentAccountId = await oauthManager.getAccountId();
  if (!currentAccountId) return responseText;

  let rectype = args.rectype as number | string | undefined;
  let hasMappingWarning = false;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = (await resolveRectype(recordType)) ?? undefined;
    if (!rectype) {
      hasMappingWarning = true;
    }
  }

  const url = generateNetSuiteUrl(currentAccountId, recordType, recordId, rectype);
  if (url) {
    responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
    if (hasMappingWarning) {
      responseText += `\n\n⚠️ **Note:** Could not auto-resolve numeric record type ID for custom record '${recordType}'. The generated link uses the string ID, which might not load correctly unless you explicitly provide the numeric 'rectype' parameter or grant your NetSuite integration role the "Custom Record Types" setup permission.`;
    }
  }
  return responseText;
}

// ---------------------------------------------------------------------------
// Tool description enhancement helpers
// ---------------------------------------------------------------------------

/** Append suffix to a tool's description string. */
function enhanceDescription(tool: Record<string, unknown>, suffix: string): Record<string, unknown> {
  const desc = (tool.description as string) || '';
  return { ...tool, description: desc ? `${desc}${suffix}` : suffix };
}

/** Enhance fetched NetSuite tool descriptions with SuiteQL rules. */
function enhanceToolDescriptions(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map(t => {
    if (t.name === 'ns_runCustomSuiteQL') {
      return enhanceDescription(t, SUITEQL_RULES_SUFFIX);
    }
    if (t.name === 'ns_getSuiteQLMetadata') {
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
    server, oauthManager, mcpTools, handleAuthentication,
    handleLogout, handleCacheRefresh, resolveCustomRecordRectype
  } = deps;

  // --- List Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const accountId = (await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
      const envSuffix = buildEnvSuffix(accountId ?? null);

      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        const unauthTools = [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map(t => enhanceDescription(t, envSuffix));
        return { tools: unauthTools };
      }

      const tools = await mcpTools.fetchTools() as Array<Record<string, unknown>>;

      // Filter write tools in production
      const isSandbox = accountId ? isSandboxAccount(accountId) : false;
      const filteredTools = isSandbox
        ? tools
        : tools.filter(t => t.name !== 'ns_createRecord' && t.name !== 'ns_updateRecord');

      // Enhance SuiteQL tool descriptions with rules
      const enhancedTools = enhanceToolDescriptions(filteredTools);

      // Combine with local tools and append env suffix
      const finalTools = [...enhancedTools, ...LOCAL_TOOLS].map(t => enhanceDescription(t, envSuffix));

      return { tools: finalTools };
    } catch {
      const accountId = (await oauthManager.getAccountId()) || process.env.NETSUITE_ACCOUNT_ID;
      const envSuffix = buildEnvSuffix(accountId ?? null);
      const fallbackTools = [AUTH_TOOL, LOGOUT_TOOL, STATUS_TOOL].map(t => enhanceDescription(t, envSuffix));
      return { tools: fallbackTools };
    }
  });

  // --- Call Tool ---
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args || {}) as Record<string, unknown>;

    // Normalize recordType/tableName parameters to lowercase for case-sensitive NetSuite REST API
    if (safeArgs.recordType && typeof safeArgs.recordType === 'string') {
      safeArgs.recordType = safeArgs.recordType.toLowerCase().trim();
    }
    if (safeArgs.tableName && typeof safeArgs.tableName === 'string') {
      safeArgs.tableName = safeArgs.tableName.toLowerCase().trim();
    }

    try {
      // --- Tools that do NOT require authentication ---
      if (name === 'netsuite_authenticate') {
        return await handleAuthentication(safeArgs);
      }
      if (name === 'netsuite_logout') {
        return await handleLogout();
      }
      if (name === 'netsuite_status') {
        return await handleStatus(oauthManager);
      }

      // --- All remaining tools require authentication ---
      const isAuthenticated = await oauthManager.hasValidSession();
      if (!isAuthenticated) {
        return textResult('❌ Not authenticated. Please use the netsuite_authenticate tool first.', true);
      }

      // --- Local tools (authenticated) ---
      if (name === 'netsuite_refresh_cache') {
        return await handleCacheRefresh(safeArgs);
      }
      if (name === 'netsuite_get_record_link') {
        return await handleGetRecordLink(safeArgs, oauthManager, resolveCustomRecordRectype);
      }
      if (name === 'netsuite_run_parallel_queries') {
        return await handleRunParallelQueries(safeArgs, mcpTools);
      }
      if (name === 'netsuite_get_parallel_records') {
        return await handleGetParallelRecords(safeArgs, mcpTools);
      }
      if (name === 'netsuite_get_parallel_metadata') {
        return await handleGetParallelMetadata(safeArgs, mcpTools);
      }

      // --- Block write operations in production ---
      if (name === 'ns_createRecord' || name === 'ns_updateRecord') {
        const accountId = await oauthManager.getAccountId();
        if (accountId && !isSandboxAccount(accountId)) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Write operations are disabled in production environments: ${name}`
          );
        }
      }

      // --- Proxy to NetSuite MCP API ---
      let result: any;
      let executeError: any = null;

      try {
        result = await mcpTools.executeTool(name, safeArgs);
      } catch (err: unknown) {
        if (name === 'ns_getRecordTypeMetadata' || name === 'ns_getSuiteQLMetadata') {
          executeError = err;
        } else {
          throw err;
        }
      }

      if (name === 'ns_getRecordTypeMetadata' || name === 'ns_getSuiteQLMetadata') {
        const recordTypeRaw = safeArgs.recordType || safeArgs.tableName;
        const hydratedResult = await hydrateMetadataIfNeeded(
          name,
          recordTypeRaw,
          result || null,
          mcpTools,
          resolveCustomRecordRectype
        );

        if (hydratedResult) {
          let parsed: any = null;
          if (Array.isArray(hydratedResult.content)) {
            const first = hydratedResult.content[0];
            if (first && first.text && typeof first.text === 'string') {
              try {
                parsed = JSON.parse(first.text);
              } catch { /* ignore */ }
            }
          } else if (typeof hydratedResult === 'object') {
            parsed = hydratedResult;
          }

          if (parsed && parsed.success === false) {
            const errorMsg = parsed.error || parsed.message || JSON.stringify(parsed);
            return textResult(`❌ NetSuite Error: ${errorMsg}`, true);
          }

          const compactMarkdown = formatMetadataToCompactMarkdown(hydratedResult);
          return textResult(compactMarkdown);
        }

        if (executeError) {
          throw executeError;
        }

        const compactMarkdown = formatMetadataToCompactMarkdown(result);
        return textResult(compactMarkdown);
      }

      // Check if the record tool call returned a NetSuite-level error
      let parsedRecordResult: any = null;
      if (result) {
        if (typeof result === 'string') {
          try {
            parsedRecordResult = JSON.parse(result);
          } catch { /* ignore */ }
        } else if (typeof result === 'object') {
          parsedRecordResult = result;
        }
      }

      if (parsedRecordResult && parsedRecordResult.success === false) {
        const errorMsg = parsedRecordResult.error || parsedRecordResult.message || JSON.stringify(parsedRecordResult);
        return textResult(`❌ NetSuite Error: ${errorMsg}`, true);
      }

      if (name === 'ns_getRecord' || name === 'ns_createRecord' || name === 'ns_updateRecord') {
        result = cleanRecordPayload(result);
      }

      let responseText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // Auto-append UI deep link for record operations
      if (name === 'ns_getRecord' || name === 'ns_createRecord' || name === 'ns_updateRecord') {
        responseText = await appendRecordLink(responseText, safeArgs, result, oauthManager, resolveCustomRecordRectype);
      }

      return textResult(responseText);
    } catch (error: unknown) {
      // Let McpError propagate directly to the MCP SDK
      if (error instanceof McpError) {
        throw error;
      }
      // All other errors: return as tool-level error response
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`❌ Error: ${message}`, true);
    }
  });
}

/** Hydrates NetSuite custom record metadata with custom fields from SuiteQL if needed. */
async function hydrateMetadataIfNeeded(
  toolName: string,
  recordTypeRaw: unknown,
  originalResult: any,
  mcpTools: NetSuiteMCPTools,
  resolveRectype: (type: string) => number | null | Promise<number | null>
): Promise<any> {
  const recordType = typeof recordTypeRaw === 'string' ? recordTypeRaw.trim() : '';
  if (!recordType || !recordType.toLowerCase().startsWith('customrecord')) {
    return originalResult;
  }

  try {
    const rectype = await resolveRectype(recordType);
    if (!rectype) {
      return originalResult;
    }

    console.error(`🔍 Hydrating custom record metadata for ${recordType} (rectype: ${rectype})...`);
    const qFields = await mcpTools.executeTool('ns_runCustomSuiteQL', {
      sqlQuery: `SELECT Name, ScriptID, FieldType, IsMandatory FROM CustomField WHERE RecordType = ${rectype}`
    });
    const fields = (mcpTools as any).extractDataArray(qFields);

    if (!fields || fields.length === 0) {
      return originalResult;
    }

    const mapFieldType = (fieldType: string | undefined): Record<string, any> => {
      const type = (fieldType || 'TEXT').toUpperCase();
      if (type === 'CHECKBOX' || type === 'BOOLEAN') return { type: 'boolean' };
      if (type === 'INTEGER') return { type: 'integer' };
      if (type === 'FLOAT' || type === 'DOUBLE' || type === 'CURRENCY' || type === 'PERCENT') {
        return { type: 'number', format: 'double' };
      }
      if (type === 'DATE') return { type: 'string', format: 'date' };
      if (type === 'DATETIME') return { type: 'string', format: 'date-time' };
      if (type === 'SELECT' || type === 'MULTISELECT' || type === 'RECORD') {
        return {
          type: 'object',
          properties: {
            id: { title: 'Internal identifier', type: 'string' },
            refName: { title: 'Reference Name', type: 'string' }
          }
        };
      }
      return { type: 'string' };
    };

    const properties: Record<string, any> = {
      id: { title: 'Internal ID', type: 'string', nullable: true },
      name: { title: 'Name', type: 'string', nullable: true },
      externalId: { title: 'External ID', type: 'string', nullable: true },
      isinactive: { title: 'Is Inactive', type: 'boolean', nullable: true },
      owner: {
        title: 'Owner',
        type: 'object',
        properties: {
          id: { title: 'Internal identifier', type: 'string' },
          refName: { title: 'Reference Name', type: 'string' }
        },
        nullable: true
      }
    };

    for (const field of fields) {
      const scriptId = String(field.scriptid || field.scriptId || '').toLowerCase().trim();
      if (scriptId) {
        properties[scriptId] = {
          title: field.name || field.name,
          nullable: field.ismandatory !== 'T',
          ...mapFieldType(field.fieldtype)
        };
      }
    }

    let originalProperties: Record<string, any> = {};
    let parsedOriginal: any = null;

    if (originalResult) {
      if (Array.isArray(originalResult.content)) {
        const first = originalResult.content[0];
        if (first && first.text && typeof first.text === 'string') {
          try {
            parsedOriginal = JSON.parse(first.text);
          } catch { /* ignore */ }
        }
      } else if (typeof originalResult === 'object') {
        parsedOriginal = originalResult;
      }
    }

    if (parsedOriginal) {
      const meta = parsedOriginal.metadata || parsedOriginal;
      if (meta && typeof meta.properties === 'object') {
        originalProperties = meta.properties;
      }
    }

    const finalProperties = { ...properties, ...originalProperties };

    const hydratedResponse = {
      success: true,
      metadata: {
        type: 'object',
        properties: finalProperties
      }
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(hydratedResponse)
        }
      ]
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ Failed to hydrate custom record metadata: ${msg}`);
    return originalResult;
  }
}

