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
  resolveCustomRecordRectype: (type: string) => number | null;
}

// ---------------------------------------------------------------------------
// Local tool handlers
// ---------------------------------------------------------------------------

async function handleGetRecordLink(
  args: Record<string, unknown>,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null
): Promise<ToolResponse> {
  const currentAccountId = await oauthManager.getAccountId();
  const targetAccountId = (args.accountId as string) || currentAccountId;

  if (!targetAccountId) {
    return textResult('❌ Account ID not found.', true);
  }

  let rectype = args.rectype as number | string | undefined;
  const recordType = args.recordType as string | undefined;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = resolveRectype(recordType) ?? undefined;
  }

  const url = generateNetSuiteUrl(targetAccountId, recordType, args.recordId as string, rectype);
  return textResult(`🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`);
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

/**
 * netsuite_status — Diagnostic tool
 */
async function handleStatus(
  oauthManager: OAuthManager
): Promise<ToolResponse> {
  const sessionInfo = await oauthManager.getSessionInfo();
  const cacheStats = cacheService.getStats();

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
  result: unknown,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null
): Promise<string> {
  const resultObj = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
  const recordId = (args.id || args.recordId || resultObj.id || resultObj.internalId) as string | undefined;
  const recordType = (args.recordType || args.type || resultObj.type || resultObj.recordType) as string | undefined;

  if (!recordId) return responseText;

  const currentAccountId = await oauthManager.getAccountId();
  if (!currentAccountId) return responseText;

  let rectype = args.rectype as number | string | undefined;
  if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
    rectype = resolveRectype(recordType) ?? undefined;
  }

  const url = generateNetSuiteUrl(currentAccountId, recordType, recordId, rectype);
  if (url) {
    responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
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
      const result = await mcpTools.executeTool(name, safeArgs);
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
