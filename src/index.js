#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OAuthManager } from './oauth/manager.js';
import { NetSuiteMCPTools } from './mcp/tools.js';
import { generateNetSuiteUrl } from './utils/netsuiteUrls.js';
import { installSkills } from './utils/installSkills.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

// Get the directory where the script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname); // Go up one level from src/ to project root

/**
 * NetSuite MCP Server
 * Provides NetSuite tools to Claude Code via MCP protocol with OAuth 2.0 PKCE authentication
 */
class NetSuiteMCPServer {
  constructor() {
    // Use absolute path for sessions directory, prioritizing NETSUITE_SESSION_PATH to match user config, then falling back to account ID segmentation
    const sessionsPath = process.env.NETSUITE_SESSION_PATH || (process.env.NETSUITE_ACCOUNT_ID 
      ? join(projectRoot, 'sessions', process.env.NETSUITE_ACCOUNT_ID.toLowerCase()) 
      : join(projectRoot, 'sessions'));

    // Get callback port from environment or use default
    const callbackPort = parseInt(process.env.OAUTH_CALLBACK_PORT || '8080', 10);

    this.oauthManager = new OAuthManager({
      storagePath: sessionsPath,
      callbackPort
    });

    this.mcpTools = new NetSuiteMCPTools(this.oauthManager);
    this.isAuthenticated = false;

    // Create MCP server
    this.server = new Server({
      name: 'netsuite-mcp',
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {}
      }
    });

    // Note: Handlers will be set up after server starts
  }

  /**
   * Setup MCP protocol handlers
   */
  setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        // Check if authenticated
        this.isAuthenticated = await this.oauthManager.hasValidSession();

        // If not authenticated, return special authentication tool
        if (!this.isAuthenticated) {
          console.error('⚠️  Not authenticated - returning authentication tool');
          return {
            tools: [
              {
                name: 'netsuite_authenticate',
                description: 'Authenticate with NetSuite to access MCP tools. Required before using any NetSuite tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    accountId: {
                      type: 'string',
                      description: 'NetSuite Account ID (e.g., 1234567 or 1234567_SB1 for sandbox). Optional if NETSUITE_ACCOUNT_ID env var is set.'
                    },
                    clientId: {
                      type: 'string',
                      description: 'OAuth 2.0 Client ID from NetSuite integration record. Optional if NETSUITE_CLIENT_ID env var is set.'
                    }
                  },
                  required: []
                }
              },
              {
                name: 'netsuite_logout',
                description: 'Clear NetSuite authentication session',
                inputSchema: {
                  type: 'object',
                  properties: {}
                }
              }
            ]
          };
        }

        // Fetch and return NetSuite MCP tools
        console.error('✅ Authenticated - fetching NetSuite tools');
        const tools = await this.mcpTools.fetchTools();

        // Add logout, cache refresh, and link generator tools to the list
        const allTools = [
          ...tools,
          {
            name: 'netsuite_get_record_link',
            description: 'Generate a direct NetSuite UI browser link to view/access a specific record in NetSuite. Useful when you need to see the real page for a transaction or record.',
            inputSchema: {
              type: 'object',
              properties: {
                recordId: {
                  type: 'string',
                  description: 'The internal ID of the record (e.g., 12345)'
                },
                recordType: {
                  type: 'string',
                  description: 'The record type (e.g., salesorder, customer, invoice, vendor, customrecord_my_custom_type). If omitted, falls back to transaction.'
                },
                accountId: {
                  type: 'string',
                  description: 'NetSuite Account ID (e.g., 1234567 or 1234567_SB1). If omitted, uses the current authenticated account ID.'
                },
                rectype: {
                  type: 'integer',
                  description: 'The numeric custom record type ID (e.g., 104). Required only for custom records if you want a direct link, otherwise falls back to the general transaction path.'
                }
              },
              required: ['recordId']
            }
          },
          {
            name: 'netsuite_refresh_cache',
            description: 'Force NetSuite to clear and refresh its internal REST session filter set cache. Use this tool if you recently made changes in the NetSuite UI (like adding or modifying records) but other NetSuite tools are still returning old/stale data from before the last login. Calling this will ensure all subsequent queries return the absolute latest data.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'netsuite_logout',
            description: 'Clear NetSuite authentication session and logout',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'netsuite_get_sql_memory',
            description: 'Reads the workspace-specific SQL/SuiteQL cheat sheet, error logs, and lessons learned to prevent repeating past database query errors. Always call this tool before writing or refactoring any SQL/SuiteQL query.',
            inputSchema: {
              type: 'object',
              properties: {
                workspacePath: {
                  type: 'string',
                  description: 'Optional custom workspace path. If omitted, uses current working directory.'
                }
              }
            }
          },
          {
            name: 'netsuite_save_sql_error',
            description: 'Appends a newly discovered SQL/SuiteQL error, its correction, and the rule to the workspace memory file (.gemini_sql_memory.md) so the AI remembers it in future chats.',
            inputSchema: {
              type: 'object',
              properties: {
                errorDescription: {
                  type: 'string',
                  description: 'Brief summary of what went wrong (e.g. "Casing issue with transaction ID column")'
                },
                incorrectSql: {
                  type: 'string',
                  description: 'The query that caused the error'
                },
                correctSql: {
                  type: 'string',
                  description: 'The final working query'
                },
                rule: {
                  type: 'string',
                  description: 'The rule to avoid this error in the future'
                },
                workspacePath: {
                  type: 'string',
                  description: 'Optional custom workspace path. If omitted, uses current working directory.'
                }
              },
              required: ['errorDescription', 'incorrectSql', 'correctSql', 'rule']
            }
          },
          {
            name: 'netsuite_run_parallel_queries',
            description: 'Executes multiple SuiteQL queries in parallel using Promise.all and returns timing stats alongside query results to test NetSuite concurrent request performance.',
            inputSchema: {
              type: 'object',
              properties: {
                queries: {
                  type: 'array',
                  items: {
                    type: 'string'
                  },
                  description: 'List of SuiteQL query strings to run in parallel'
                }
              },
              required: ['queries']
            }
          }
        ];

        return { tools: allTools };

      } catch (error) {
        console.error('❌ Error in tools/list:', error.message);
        // Return authentication tool on error
        return {
          tools: [
            {
              name: 'netsuite_authenticate',
              description: 'Authenticate with NetSuite to access MCP tools. If NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID environment variables are set, they will be used automatically.',
              inputSchema: {
                type: 'object',
                properties: {
                  accountId: { type: 'string', description: 'NetSuite Account ID. Optional if NETSUITE_ACCOUNT_ID env var is set.' },
                  clientId: { type: 'string', description: 'OAuth Client ID. Optional if NETSUITE_CLIENT_ID env var is set.' }
                },
                required: []
              }
            }
          ]
        };
      }
    });

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Handle authentication tool
        if (name === 'netsuite_authenticate') {
          return await this.handleAuthentication(args);
        }

        // Handle logout tool
        if (name === 'netsuite_logout') {
          return await this.handleLogout();
        }

        // Handle cache refresh tool
        if (name === 'netsuite_refresh_cache') {
          return await this.handleCacheRefresh();
        }

        // Handle getting SQL memory guide and 错题本
        if (name === 'netsuite_get_sql_memory') {
          const workspace = args.workspacePath || process.cwd();
          const memoryFilePath = join(workspace, '.gemini_sql_memory.md');
          
          try {
            let content;
            try {
              content = await fs.readFile(memoryFilePath, 'utf-8');
            } catch (err) {
              if (err.code === 'ENOENT') {
                const defaultTemplate = `# Gemini SuiteQL 错题本与避坑记忆库\n\n` +
                  `> [!IMPORTANT]\n` +
                  `> 每次在编写或修改 SuiteQL 之前，必须先读取本文件，严格遵守以下已验证的规则，避免重复犯错。\n\n` +
                  `## NetSuite SuiteQL 核心通用规则\n` +
                  `1. **【禁止盲猜】** 绝对不能仅凭经验猜测 NetSuite 的表名和字段名。\n` +
                  `2. **【Schema先行】** 编写任何查询前，必须先调用 \`ns_getSuiteQLMetadata\` 获取相关 Record 类型的真实字段定义。\n` +
                  `3. **【验证JOIN】** 只有当元数据中字段明确标有 \`x-n:joinable: true\` 时，才允许使用该字段进行 JOIN。\n` +
                  `4. **【利用BUILTIN】** 优先使用 \`BUILTIN.DF(field)\` 函数获取关联字段的显示文本，避免繁琐且易错的 JOIN 逻辑。\n` +
                  `5. **【防错闭环】** 在开发过程中如果遇到 SQL 执行报错，请先分析报错信息，重新验证 Schema，并在解决后使用 \`netsuite_save_sql_error\` 工具记录。\n\n` +
                  `## 历史错误与正确示范 (已验证规则)\n` +
                  `*暂无自定义记录。当您在调试过程中解决报错后，AI 会使用 \`netsuite_save_sql_error\` 将其自动追加记录于此。*\n`;
                
                await fs.writeFile(memoryFilePath, defaultTemplate, 'utf-8');
                content = defaultTemplate;
              } else {
                throw err;
              }
            }
            
            return {
              content: [
                {
                  type: 'text',
                  text: `📖 **已成功读取 SQL 记忆库与规则 (.gemini_sql_memory.md):**\n\n${content}`
                }
              ]
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `❌ 读取 SQL 记忆库失败: ${error.message}`
                }
              ],
              isError: true
            };
          }
        }

        // Handle saving new SQL error entry
        if (name === 'netsuite_save_sql_error') {
          const { errorDescription, incorrectSql, correctSql, rule } = args;
          const workspace = args.workspacePath || process.cwd();
          const memoryFilePath = join(workspace, '.gemini_sql_memory.md');
          
          try {
            let content = '';
            try {
              content = await fs.readFile(memoryFilePath, 'utf-8');
            } catch (err) {
              if (err.code !== 'ENOENT') throw err;
              content = `# Gemini SuiteQL 错题本与避坑记忆库\n\n` +
                `> [!IMPORTANT]\n` +
                `> 每次在编写或修改 SuiteQL 之前，必须先读取本文件，严格遵守以下已验证的规则，避免重复犯错。\n\n` +
                `## NetSuite SuiteQL 核心通用规则\n` +
                `1. **【禁止盲猜】** 绝对不能仅凭经验猜测 NetSuite 的表名和字段名。\n` +
                `2. **【Schema先行】** 编写任何查询前，必须先调用 \`ns_getSuiteQLMetadata\` 获取相关 Record 类型的真实字段定义。\n` +
                `3. **【验证JOIN】** 只有当元数据中字段明确标有 \`x-n:joinable: true\` 时，才允许使用该字段进行 JOIN。\n` +
                `4. **【利用BUILTIN】** 优先使用 \`BUILTIN.DF(field)\` 函数获取关联字段的显示文本，避免繁琐且易错的 JOIN 逻辑。\n` +
                `5. **【防错闭环】** 在开发过程中如果遇到 SQL 执行报错，请先分析报错信息，重新验证 Schema，并在解决后使用 \`netsuite_save_sql_error\` 工具记录。\n\n` +
                `## 历史错误与正确示范 (已验证规则)\n`;
            }
            
            content = content.replace('*暂无自定义记录。当您在调试过程中解决报错后，AI 会使用 `netsuite_save_sql_error` 将其自动追加记录于此。*\n', '');
            
            const dateStr = new Date().toISOString().split('T')[0];
            const newEntry = `\n### 📝 错误记录: ${errorDescription} (${dateStr})\n` +
              `- **错误 SQL**：\`${incorrectSql.replace(/`/g, '\\`').trim()}\`\n` +
              `- **正确 SQL**：\`${correctSql.replace(/`/g, '\\`').trim()}\`\n` +
              `- **防错规则**：${rule.trim()}\n`;
              
            content += newEntry;
            await fs.writeFile(memoryFilePath, content, 'utf-8');
            
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ **错题记忆已成功追加到本地的 .gemini_sql_memory.md 文件中！**\n\n新增记录：\n- 描述: ${errorDescription}\n- 规则: ${rule}`
                }
              ]
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `❌ 保存错题失败: ${error.message}`
                }
              ],
              isError: true
            };
          }
        }

        // Handle running parallel queries
        if (name === 'netsuite_run_parallel_queries') {
          const { queries } = args;
          if (!Array.isArray(queries) || queries.length === 0) {
            return {
              content: [{ type: 'text', text: '❌ Invalid arguments: queries must be a non-empty array.' }],
              isError: true
            };
          }

          console.error(`\n⚡ Running ${queries.length} queries in parallel (concurrency limit: 5)...`);
          const startTime = Date.now();

          const concurrencyLimit = 5;
          const results = new Array(queries.length);
          let currentQueryIndex = 0;

          const worker = async () => {
            while (currentQueryIndex < queries.length) {
              const index = currentQueryIndex++;
              const sqlQuery = queries[index];
              const queryStart = Date.now();
              try {
                // Execute the query via our internal execution engine (ns_runCustomSuiteQL tool)
                const result = await this.mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery });
                const duration = Date.now() - queryStart;
                results[index] = {
                  index,
                  success: true,
                  durationMs: duration,
                  query: sqlQuery,
                  result: typeof result === 'string' ? JSON.parse(result) : result
                };
              } catch (err) {
                const duration = Date.now() - queryStart;
                results[index] = {
                  index,
                  success: false,
                  durationMs: duration,
                  query: sqlQuery,
                  error: err.message
                };
              }
            }
          };

          const workers = [];
          for (let i = 0; i < Math.min(concurrencyLimit, queries.length); i++) {
            workers.push(worker());
          }
          await Promise.all(workers);
          const totalDuration = Date.now() - startTime;

          const summary = {
            totalQueries: queries.length,
            successfulQueries: results.filter(r => r.success).length,
            failedQueries: results.filter(r => r.success === false).length,
            totalDurationMs: totalDuration,
            individualResults: results
          };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(summary, null, 2)
              }
            ]
          };
        }

        // Check authentication for NetSuite tools
        this.isAuthenticated = await this.oauthManager.hasValidSession();
        if (!this.isAuthenticated) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Not authenticated. Please use the netsuite_authenticate tool first.\n\n' +
                      'Example:\n' +
                      '{\n' +
                      '  "accountId": "1234567",\n' +
                      '  "clientId": "your-client-id"\n' +
                      '}'
              }
            ],
            isError: true
          };
        }

        // Handle record link generation tool
        if (name === 'netsuite_get_record_link') {
          const currentAccountId = await this.oauthManager.getAccountId();
          const targetAccountId = args.accountId || currentAccountId;
          
          if (!targetAccountId) {
            return {
              content: [
                {
                  type: 'text',
                  text: '❌ Account ID not found. Please authenticate or provide a specified accountId.'
                }
              ],
              isError: true
            };
          }

          // Resolve custom record rectype if script ID is passed
          let rectype = args.rectype;
          if (!rectype && args.recordType && args.recordType.toLowerCase().startsWith('customrecord')) {
            rectype = this.resolveCustomRecordRectype(args.recordType);
          }
          
          const url = generateNetSuiteUrl(targetAccountId, args.recordType, args.recordId, rectype);
          return {
            content: [
              {
                type: 'text',
                text: `🔗 **NetSuite UI Link (${targetAccountId.toUpperCase()}):**\n${url}`
              }
            ]
          };
        }

        // Execute NetSuite tool
        console.error(`\n🔧 Executing NetSuite tool: ${name}`);
        const result = await this.mcpTools.executeTool(name, args);

        let responseText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

        // Auto-append URL for record-related tools
        if (name === 'ns_getRecord' || name === 'ns_createRecord' || name === 'ns_updateRecord') {
          const recordId = args.id || args.recordId || (result && typeof result === 'object' && (result.id || result.internalId));
          const recordType = args.recordType || args.type || (result && typeof result === 'object' && (result.type || result.recordType));
          
          if (recordId) {
            const currentAccountId = await this.oauthManager.getAccountId();
            if (currentAccountId) {
              // Resolve custom record rectype if script ID is passed
              let rectype = args.rectype;
              if (!rectype && recordType && recordType.toLowerCase().startsWith('customrecord')) {
                rectype = this.resolveCustomRecordRectype(recordType);
              }
              
              const url = generateNetSuiteUrl(currentAccountId, recordType, recordId, rectype);
              if (url) {
                responseText += `\n\n🔗 **NetSuite UI Link (Current Environment):**\n${url}`;
              }
            }
          }
        }

        // Format result for MCP protocol
        return {
          content: [
            {
              type: 'text',
              text: responseText
            }
          ]
        };

      } catch (error) {
        console.error(`❌ Tool execution error:`, error.message);
        return {
          content: [
            {
              type: 'text',
              text: `❌ Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }

  /**
   * Handle NetSuite authentication
   */
  async handleAuthentication(args) {
    // Use environment variables if available, fallback to arguments
    const accountId = args.accountId || process.env.NETSUITE_ACCOUNT_ID;
    const clientId = args.clientId || process.env.NETSUITE_CLIENT_ID;

    // Validate that we have both values
    if (!accountId || !clientId) {
      return {
        content: [
          {
            type: 'text',
            text: '❌ Missing required credentials.\n\n' +
                  'Please provide credentials in one of two ways:\n\n' +
                  '1. Via arguments:\n' +
                  '   {\n' +
                  '     "accountId": "your-account-id",\n' +
                  '     "clientId": "your-client-id"\n' +
                  '   }\n\n' +
                  '2. Via environment variables (set in ~/.claude.json):\n' +
                  '   NETSUITE_ACCOUNT_ID\n' +
                  '   NETSUITE_CLIENT_ID'
          }
        ],
        isError: true
      };
    }

    try {
      console.error('\n🔐 Starting NetSuite authentication...');
      console.error(`📋 Account ID: ${accountId}`);
      console.error(`📋 Client ID: ${clientId?.substring(0, 8)}...`);

      // Indicate if using environment variables
      if (process.env.NETSUITE_ACCOUNT_ID || process.env.NETSUITE_CLIENT_ID) {
        console.error('✅ Using credentials from environment variables');
      }

      // Start OAuth flow (this will wait for user to complete authentication)
      await this.oauthManager.startAuthFlow({
        accountId,
        clientId
      });

      // Update authentication status
      this.isAuthenticated = true;

      // Clear tools cache to fetch fresh tools
      this.mcpTools.clearCache();

      return {
        content: [
          {
            type: 'text',
            text: '✅ Successfully authenticated with NetSuite!\n\n' +
                  'You can now use NetSuite MCP tools. Try asking:\n' +
                  '- "List all saved searches"\n' +
                  '- "Run a SuiteQL query to get customer data"\n' +
                  '- "Show me available reports"'
          }
        ]
      };

    } catch (error) {
      console.error('❌ Authentication failed:', error.message);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Authentication failed: ${error.message}\n\n` +
                  'Please check:\n' +
                  '1. Your NetSuite Account ID is correct\n' +
                  '2. Your OAuth Client ID is correct\n' +
                  '3. The integration record has PKCE enabled\n' +
                  `4. The redirect URI is set to: http://localhost:${this.oauthManager.callbackServer.port}/callback\n` +
                  `5. Port ${this.oauthManager.callbackServer.port} is not in use by another application`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handle logout
   */
  async handleLogout() {
    try {
      await this.oauthManager.clearSession();
      this.mcpTools.clearCache();
      this.isAuthenticated = false;

      console.error('✅ Logged out successfully');

      return {
        content: [
          {
            type: 'text',
            text: '✅ Successfully logged out from NetSuite.\n\n' +
                  'Use netsuite_authenticate to login again.'
          }
        ]
      };

    } catch (error) {
      console.error('❌ Logout error:', error.message);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Logout failed: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Handle cache refresh
   */
  async handleCacheRefresh() {
    try {
      console.error('\n🔄 Triggering NetSuite REST session cache refresh...');
      await this.mcpTools.refreshSessionCache();
      
      console.error('🗑️ Clearing local metadata cache...');
      await this.mcpTools.clearMetadataCache();

      return {
        content: [
          {
            type: 'text',
            text: '✅ Successfully cleared and refreshed NetSuite REST session cache and local metadata schema cache! Subsequent queries will now fetch the latest data.'
          }
        ]
      };
    } catch (error) {
      console.error('❌ Cache refresh error:', error.message);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to refresh cache: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }

  /**
   * Resolve custom record type script ID to numeric internal ID
   */
  resolveCustomRecordRectype(recordType) {
    if (!recordType) return null;
    const upperType = recordType.toUpperCase().trim();
    if (this.mcpTools.customRecordMappings.has(upperType)) {
      const numericId = this.mcpTools.customRecordMappings.get(upperType);
      console.error(`⚡ [Link Resolution] Successfully mapped ${recordType} -> rectype ${numericId}`);
      return numericId;
    }
    return null;
  }

  /**
   * Start the MCP server
   */
  async start() {
    console.error('🚀 NetSuite MCP Server starting...');
    console.error('📦 Version: 1.0.0');
    console.error('🔌 Transport: stdio (MCP Client)');
    console.error(`🌐 Callback Port: ${this.oauthManager.callbackServer.port}`);
    console.error(`📁 Sessions Directory: ${this.oauthManager.storage.storagePath}`);

    // Check if already authenticated
    this.isAuthenticated = await this.oauthManager.hasValidSession();
    if (this.isAuthenticated) {
      console.error('✅ Already authenticated with NetSuite');
      const accountId = await this.oauthManager.getAccountId();
      console.error(`📋 Account ID: ${accountId}`);
    } else {
      console.error('⚠️  Not authenticated - authentication required');
    }

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Set up handlers after connection
    this.setupHandlers();

    console.error('✅ NetSuite MCP Server ready!\n');
  }
}

// Start the server
async function main() {
  // Check if we are running the skill installation CLI
  if (process.argv.includes('install-skills')) {
    try {
      const isLocal = process.argv.includes('--local') || process.argv.includes('-l');
      await installSkills({ local: isLocal });
      process.exit(0);
    } catch (error) {
      process.exit(1);
    }
  }

  try {
    const server = new NetSuiteMCPServer();
    await server.start();
  } catch (error) {
    console.error('❌ Fatal error starting MCP server:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
  process.exit(1);
});

// Start the server
main();
