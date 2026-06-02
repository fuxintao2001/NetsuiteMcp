import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

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
    this.customRecordMappings = new Map(); // Store dynamic scriptid -> internalid mapping
    this.hasFetchedMappings = false; // Prevent infinite recursion on background fetching
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
    // Load local custom record mappings cache if exists
    try {
      await this.loadCustomRecordMappingsCache();
    } catch {}

    // Fetch fresh dynamic custom record mappings in the background
    this.fetchCustomRecordMappings().catch(() => {});

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
    // Intercept metadata tools for schema caching
    if (toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata') {
      try {
        const cachedResult = await this.readMetadataCache(toolName, parameters);
        if (cachedResult) {
          console.error(`⚡ [Cache Hit] Serving ${toolName} for ${parameters?.recordType || 'all'} from local metadata cache`);
          return cachedResult;
        }
      } catch (err) {
        console.error(`⚠️ Failed to read metadata cache: ${err.message}`);
      }
    }

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
      const result = response.data.result;

      // Save to cache after successful execution
      if (toolName === 'ns_getSuiteQLMetadata' || toolName === 'ns_getRecordTypeMetadata') {
        try {
          await this.writeMetadataCache(toolName, parameters, result);
        } catch (err) {
          console.error(`⚠️ Failed to write metadata cache: ${err.message}`);
        }
      }

      return result;

    } catch (error) {
      if (error.response?.status === 401) {
        console.error('❌ Authentication failed during tool execution');
        throw new Error('NetSuite authentication failed. Please re-authenticate.');
      }

      // Self-Healing Cache Invalidation: clear local cache on any SuiteQL execution error
      if (toolName === 'ns_runCustomSuiteQL') {
        console.error('⚠️ SuiteQL error encountered. Automatically clearing metadata cache to ensure fresh schema...');
        try {
          await this.clearMetadataCache();
        } catch (err) {
          console.error(`⚠️ Failed to self-heal/clear metadata cache: ${err.message}`);
        }
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

  /**
   * Get metadata cache file path
   */
  async getMetadataCachePath(toolName, parameters) {
    const accountId = await this.oauthManager.getAccountId();
    if (!accountId) return null;
    
    const recordType = parameters?.recordType ? parameters.recordType.toLowerCase().trim() : 'all';
    
    // Resolve project root
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.dirname(path.dirname(__dirname));
    
    return path.join(projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), `${toolName}_${recordType}.json`);
  }

  /**
   * Read metadata from local cache
   */
  async readMetadataCache(toolName, parameters) {
    try {
      const cachePath = await this.getMetadataCachePath(toolName, parameters);
      if (!cachePath) return null;

      const stats = await fs.stat(cachePath);
      const age = Date.now() - stats.mtimeMs;
      const ttl = 24 * 60 * 60 * 1000; // 24 hours TTL

      if (age < ttl) {
        const data = await fs.readFile(cachePath, 'utf-8');
        return JSON.parse(data);
      }
      
      // Expired cache
      return null;
    } catch {
      return null; // Cache file doesn't exist or error reading
    }
  }

  /**
   * Write metadata to local cache
   */
  async writeMetadataCache(toolName, parameters, result) {
    try {
      const cachePath = await this.getMetadataCachePath(toolName, parameters);
      if (!cachePath) return;

      const cacheDir = path.dirname(cachePath);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(result, null, 2), 'utf-8');
    } catch (err) {
      console.error(`⚠️ Failed to write cache file: ${err.message}`);
    }
  }

  /**
   * Clear metadata cache for current account
   */
  async clearMetadataCache() {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (!accountId) return;

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const projectRoot = path.dirname(path.dirname(__dirname));
      
      const accountCacheDir = path.join(projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'));
      
      await fs.rm(accountCacheDir, { recursive: true, force: true });
      console.error(`🗑️ Metadata cache cleared for account ${accountId}`);
    } catch (err) {
      console.error(`⚠️ Failed to clear metadata cache: ${err.message}`);
    }
  }

  /**
   * Load custom record mappings from local cache file
   */
  async loadCustomRecordMappingsCache() {
    try {
      const accountId = await this.oauthManager.getAccountId();
      if (!accountId) return;

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const projectRoot = path.dirname(path.dirname(__dirname));
      const cachePath = path.join(projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), 'customrecord_mappings.json');

      const data = await fs.readFile(cachePath, 'utf-8');
      const mappingsObj = JSON.parse(data);
      
      this.customRecordMappings = new Map(Object.entries(mappingsObj));
      console.error(`⚡ Loaded ${this.customRecordMappings.size} custom record mappings from local cache`);
    } catch {
      // Ignore if cache file doesn't exist
    }
  }

  /**
   * Fetch fresh custom record mappings from NetSuite and save to cache
   */
  async fetchCustomRecordMappings() {
    if (this.hasFetchedMappings) return;
    this.hasFetchedMappings = true;

    try {
      console.error('🔍 Fetching dynamic custom record mappings from NetSuite...');
      
      // Query customrecordtype table
      const sqlQuery = 'SELECT internalId, scriptId FROM customrecordtype';
      const result = await this.executeTool('ns_runCustomSuiteQL', { sqlQuery });
      
      let data = result;
      if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
        data = JSON.parse(result.content[0].text);
      } else if (typeof result === 'string') {
        data = JSON.parse(result);
      }
      
      const records = data.data || data.records || [];
      if (records.length > 0) {
        const newMappings = {};
        for (const record of records) {
          const scriptId = (record.scriptid || record.scriptId || '').toUpperCase().trim();
          const internalId = parseInt(record.internalid || record.internalId, 10);
          if (scriptId && !isNaN(internalId)) {
            this.customRecordMappings.set(scriptId, internalId);
            newMappings[scriptId] = internalId;
          }
        }
        
        // Save to cache file
        const accountId = await this.oauthManager.getAccountId();
        if (accountId) {
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = path.dirname(__filename);
          const projectRoot = path.dirname(path.dirname(__dirname));
          const cachePath = path.join(projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), 'customrecord_mappings.json');
          
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, JSON.stringify(newMappings, null, 2), 'utf-8');
          console.error(`✅ Saved ${this.customRecordMappings.size} custom record mappings to cache`);
        }
      }
    } catch (err) {
      console.error(`⚠️ Failed to fetch custom record mappings: ${err.message}`);
    }
  }
}
