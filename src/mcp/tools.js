import axios from 'axios';

/**
 * NetSuite MCP Tools Client
 * Communicates with NetSuite MCP REST API using JSON-RPC 2.0
 */
export class NetSuiteMCPTools {
  constructor(oauthManager) {
    this.oauthManager = oauthManager;
    this.toolsCache = null;
    this.lastToolsFetch = null;
    this.toolsCacheTTL = 1000; // 1 second cache for instant updates in development
  }

  /**
   * Get NetSuite MCP API endpoint URL
   */
  async getMCPEndpoint() {
    const accountId = await this.oauthManager.getAccountId();
    if (!accountId) {
      throw new Error('Account ID not found. Please authenticate first.');
    }
    return `https://${accountId}.suitetalk.api.netsuite.com/services/mcp/v1/all`;
  }

  /**
   * Fetch available tools from NetSuite MCP API
   * Returns tools in MCP protocol format
   */
  async fetchTools() {
    // Return cached tools if still valid
    if (this.toolsCache && this.lastToolsFetch) {
      const age = Date.now() - this.lastToolsFetch;
      if (age < this.toolsCacheTTL) {
        console.error(`📦 Using cached tools (${Math.round(age / 1000)}s old)`);
        return this.toolsCache;
      }
    }

    const accessToken = await this.oauthManager.ensureValidToken();
    const endpoint = await this.getMCPEndpoint();

    console.error('🔍 Fetching available tools from NetSuite...');

    try {
      const response = await axios.post(endpoint, {
        jsonrpc: '2.0',
        id: this.generateRequestId(),
        method: 'tools/list',
        params: {}
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        },
        timeout: 30000
      });

      if (response.data.error) {
        throw new Error(response.data.error.message || 'Failed to fetch tools');
      }

      if (response.data.result && response.data.result.tools) {
        this.toolsCache = response.data.result.tools;
        this.lastToolsFetch = Date.now();
        console.error(`✅ Fetched ${this.toolsCache.length} tools from NetSuite`);
        return this.toolsCache;
      }

      return [];

    } catch (error) {
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed - token may be expired');
        throw new Error('NetSuite authentication failed. Please re-authenticate.');
      }

      console.error('❌ Error fetching tools:', error.response?.data || error.message);
      throw new Error(`Failed to fetch tools: ${error.message}`);
    }
  }

  /**
   * Execute a NetSuite MCP tool
   * @param {string} toolName - Name of the tool to execute
   * @param {object} parameters - Tool parameters
   * @returns {object} Tool execution result
   */
  async executeTool(toolName, parameters) {
    const accessToken = await this.oauthManager.ensureValidToken();
    const endpoint = await this.getMCPEndpoint();

    console.error(`🔧 Executing tool: ${toolName}`);

    try {
      const response = await axios.post(endpoint, {
        jsonrpc: '2.0',
        id: this.generateRequestId(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: parameters || {}
        }
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        },
        timeout: 60000 // 60 second timeout for tool execution
      });

      if (response.data.error) {
        const errorMsg = response.data.error.message || 'Tool execution failed';
        console.error(`❌ Tool execution error: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      console.error(`✅ Tool executed successfully`);
      return response.data.result;

    } catch (error) {
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed during tool execution');
        throw new Error('NetSuite authentication failed. Please re-authenticate.');
      }

      console.error('❌ Tool execution error:', error.response?.data || error.message);
      throw new Error(`Tool execution failed: ${error.message}`);
    }
  }

  /**
   * Get tool by name from cache
   */
  async getTool(toolName) {
    if (!this.toolsCache) {
      await this.fetchTools();
    }

    return this.toolsCache?.find(tool => tool.name === toolName);
  }

  /**
   * Validate tool parameters against tool schema
   */
  validateParameters(tool, parameters) {
    if (!tool || !tool.inputSchema) {
      return true; // No schema to validate against
    }

    const schema = tool.inputSchema;
    const required = schema.required || [];

    // Check required parameters
    for (const param of required) {
      if (!(param in parameters)) {
        throw new Error(`Missing required parameter: ${param}`);
      }
    }

    return true;
  }

  /**
   * Generate unique request ID for JSON-RPC
   */
  generateRequestId() {
    return `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clear tools cache (useful after re-authentication)
   */
  clearCache() {
    this.toolsCache = null;
    this.lastToolsFetch = null;
    console.error('🗑️  Tools cache cleared');
  }

  /**
   * Get cache status
   */
  getCacheStatus() {
    if (!this.toolsCache) {
      return { cached: false };
    }

    const age = Date.now() - this.lastToolsFetch;
    return {
      cached: true,
      toolCount: this.toolsCache.length,
      ageSeconds: Math.round(age / 1000),
      expiresIn: Math.round((this.toolsCacheTTL - age) / 1000)
    };
  }

  /**
   * Force refresh NetSuite REST session filter set cache
   */
  async refreshSessionCache() {
    const accessToken = await this.oauthManager.ensureValidToken();
    const accountId = await this.oauthManager.getAccountId();
    const refreshUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/v1/session/cache/refresh`;

    console.error('🔄 Refreshing NetSuite REST session cache...');

    try {
      await axios.post(refreshUrl, {}, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        },
        timeout: 10000
      });
      console.error('✅ NetSuite REST session cache refreshed successfully');
      return true;
    } catch (error) {
      console.error('❌ Cache refresh failed:', error.response?.data || error.message);
      throw new Error(`Failed to refresh NetSuite REST session cache: ${error.message}`);
    }
  }
}
