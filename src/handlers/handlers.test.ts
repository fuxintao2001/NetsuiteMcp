import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { registerToolHandlers } from './tools.js';
import { registerResourceHandlers } from './resources.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';

describe('MCP Handler Wires', () => {
  let mockServer: any;
  let mockOAuthManager: any;
  let mockMCPTools: any;
  let registeredHandlers: Map<any, Function>;

  const testRoot = path.join(process.cwd(), '.test-handlers-root');

  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(testRoot, { recursive: true });

    registeredHandlers = new Map();
    mockServer = {
      setRequestHandler: jest.fn((schema: any, handler: Function) => {
        registeredHandlers.set(schema, handler);
      })
    };

    mockOAuthManager = {
      getAccountId: jest.fn().mockResolvedValue('123456_SB1'),
      hasValidSession: jest.fn().mockResolvedValue(true)
    };

    mockMCPTools = {
      fetchTools: jest.fn().mockResolvedValue([
        { name: 'ns_getRecord', description: 'Fetch NetSuite records' },
        { name: 'ns_createRecord', description: 'Create NetSuite records' },
        { name: 'ns_updateRecord', description: 'Update NetSuite records' },
        { name: 'ns_runCustomSuiteQL', description: 'Run SuiteQL queries' }
      ]),
      executeTool: jest.fn().mockResolvedValue({ id: '101', type: 'customer', name: 'Acme Corp' }),
      customRecordMappings: new Map(),
      extractDataArray: (result: any) => {
        if (result && Array.isArray(result.data)) return result.data;
        return [];
      }
    };
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  describe('Tools Handler Wiring', () => {
    let authCb: any;
    let logoutCb: any;
    let refreshCb: any;

    beforeEach(() => {
      authCb = jest.fn();
      logoutCb = jest.fn();
      refreshCb = jest.fn();

      registerToolHandlers({
        server: mockServer,
        oauthManager: mockOAuthManager,
        mcpTools: mockMCPTools,
        projectRoot: testRoot,
        handleAuthentication: authCb,
        handleLogout: logoutCb,
        handleCacheRefresh: refreshCb,
        resolveCustomRecordRectype: async (type: string) => {
          if (type.toLowerCase() === 'customrecord_etissl_carrier') return 54;
          return null;
        }
      });
    });

    it('should register tool list and call schemas', () => {
      expect(registeredHandlers.has(ListToolsRequestSchema)).toBe(true);
      expect(registeredHandlers.has(CallToolRequestSchema)).toBe(true);
    });

    it('should list all tools when in Sandbox environment', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('9260916_SB3');
      const listFn = registeredHandlers.get(ListToolsRequestSchema);

      const result = await listFn!();
      const names = result.tools.map((t: any) => t.name);

      expect(names).toContain('ns_createRecord');
      expect(names).toContain('ns_updateRecord');
      expect(names).toContain('ns_getRecord');
      expect(names).toContain('netsuite_get_record_link');
    });

    it('should filter out write tools when in Production environment', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456');
      const listFn = registeredHandlers.get(ListToolsRequestSchema);

      const result = await listFn!();
      const names = result.tools.map((t: any) => t.name);

      expect(names).toContain('ns_getRecord');
      expect(names).not.toContain('ns_createRecord');
      expect(names).not.toContain('ns_updateRecord');
    });

    it('should block ns_createRecord calls when in Production environment', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456');
      const callFn = registeredHandlers.get(CallToolRequestSchema);

      await expect(
        callFn!({
          params: {
            name: 'ns_createRecord',
            arguments: { recordType: 'customer', record: {} }
          }
        })
      ).rejects.toThrow('Write operations are disabled in production environments');
    });

    it('should allow ns_createRecord calls when in Sandbox environment and append deep links', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456_SB1');
      const callFn = registeredHandlers.get(CallToolRequestSchema);

      const res = await callFn!({
        params: {
          name: 'ns_createRecord',
          arguments: { recordType: 'customer', record: {} }
        }
      });

      expect(res.content[0].text).toContain('🔗 **NetSuite UI Link (Current Environment):**');
      expect(res.content[0].text).toContain('https://123456-sb1.app.netsuite.com/app/common/entity/custjob.nl?id=101');
    });

    it('should route authenticate, logout, and status tools without active session checks', async () => {
      mockOAuthManager.hasValidSession.mockResolvedValue(false);
      const callFn = registeredHandlers.get(CallToolRequestSchema);

      await callFn!({
        params: {
          name: 'netsuite_authenticate',
          arguments: { accountId: 'acc', clientId: 'cli' }
        }
      });
      expect(authCb).toHaveBeenCalled();
    });

    it('should hydrate custom record type metadata using CustomField SuiteQL fallback', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456');
      const callFn = registeredHandlers.get(CallToolRequestSchema);

      mockMCPTools.executeTool.mockImplementation(async (name: string, args: any) => {
        if (name === 'ns_getRecordTypeMetadata') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                metadata: {
                  type: 'object',
                  properties: {
                    refName: { title: 'Reference Name', type: 'string' }
                  }
                }
              })
            }]
          };
        }
        if (name === 'ns_runCustomSuiteQL' && args.sqlQuery?.includes('CustomField')) {
          return {
            data: [{
              name: 'Carrier Description',
              scriptid: 'CUSTRECORD_ETISSL_CARRIER_DESCRIPTION',
              fieldtype: 'RECORD',
              ismandatory: 'F'
            }]
          };
        }
        return {};
      });

      const res = await callFn!({
        params: {
          name: 'ns_getRecordTypeMetadata',
          arguments: { recordType: 'customrecord_etissl_carrier' }
        }
      });

      expect(res.content[0].text).toContain('custrecord_etissl_carrier_description');
      expect(res.content[0].text).toContain('Carrier Description');
      expect(res.content[0].text).toContain('isinactive');
    });

    it('should normalize recordType and tableName to lowercase', async () => {
      mockOAuthManager.hasValidSession.mockResolvedValue(true);
      const callFn = registeredHandlers.get(CallToolRequestSchema);

      mockMCPTools.executeTool.mockImplementation(async (name: string, args: any) => {
        return {
          success: true,
          recordType: args.recordType,
          tableName: args.tableName
        };
      });

      const res = await callFn!({
        params: {
          name: 'ns_getRecord',
          arguments: { recordType: 'customRecord_ETISSL_Carrier', tableName: 'SalesOrder' }
        }
      });

      const parsed = JSON.parse(res.content[0].text.split('\n\n🔗')[0]);
      expect(parsed.recordType).toBe('customrecord_etissl_carrier');
    });

    describe('netsuite_batch_execute tool', () => {
      it('should execute multiple tools in parallel and return partial results', async () => {
        mockOAuthManager.getAccountId.mockResolvedValue('123456_SB1');
        const callFn = registeredHandlers.get(CallToolRequestSchema);

        mockMCPTools.executeTool.mockImplementation(async (name: string, args: any) => {
          if (name === 'ns_getRecord') {
            return { id: args.recordId, recordType: args.recordType, entity: 'Acme', links: [] };
          }
          if (name === 'ns_runCustomSuiteQL') {
            return { data: [{ internalid: '1' }] };
          }
          throw new Error('Unknown tool');
        });

        const res = await callFn!({
          params: {
            name: 'netsuite_batch_execute',
            arguments: {
              tasks: [
                { toolName: 'ns_getRecord', arguments: { recordType: 'customer', recordId: '101' } },
                { toolName: 'ns_runCustomSuiteQL', arguments: { sqlQuery: 'SELECT 1' } },
                { toolName: 'invalid_tool', arguments: {} }
              ]
            }
          }
        });

        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.totalTasks).toBe(3);
        expect(parsed.successfulTasks).toBe(2);
        expect(parsed.failedTasks).toBe(1);

        const recordRes = parsed.individualResults[0];
        expect(recordRes.success).toBe(true);
        expect(recordRes.result.entity).toBe('Acme');
        expect(recordRes.result.links).toBeUndefined(); // Should be cleaned

        const sqlRes = parsed.individualResults[1];
        expect(sqlRes.success).toBe(true);
        expect(sqlRes.result.data[0].internalid).toBe('1');

        const failedRes = parsed.individualResults[2];
        expect(failedRes.success).toBe(false);
        expect(failedRes.error).toContain('Unknown tool');
      });

      it('should fail only write tasks in production', async () => {
        mockOAuthManager.getAccountId.mockResolvedValue('123456'); // Production
        const callFn = registeredHandlers.get(CallToolRequestSchema);

        mockMCPTools.executeTool.mockImplementation(async (name: string, args: any) => {
          if (name === 'ns_getRecord') {
            return { id: args.recordId };
          }
          return { success: true };
        });

        const res = await callFn!({
          params: {
            name: 'netsuite_batch_execute',
            arguments: {
              tasks: [
                { toolName: 'ns_getRecord', arguments: { recordType: 'customer', recordId: '101' } },
                { toolName: 'ns_createRecord', arguments: { recordType: 'customer', record: {} } }
              ]
            }
          }
        });

        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.totalTasks).toBe(2);
        expect(parsed.successfulTasks).toBe(1);
        expect(parsed.failedTasks).toBe(1);

        expect(parsed.individualResults[0].success).toBe(true);
        expect(parsed.individualResults[1].success).toBe(false);
        expect(parsed.individualResults[1].error).toContain('Write operations are disabled in production');
      });

      it('should reject if tasks exceeds 10', async () => {
        const callFn = registeredHandlers.get(CallToolRequestSchema);
        const tasks = Array.from({ length: 11 }, () => ({ toolName: 'ns_getRecord', arguments: {} }));

        const res = await callFn!({
          params: {
            name: 'netsuite_batch_execute',
            arguments: { tasks }
          }
        });

        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('tasks array exceeds maximum limit of 10');
      });
    });
  });


  describe('Resources Handler Wiring', () => {
    beforeEach(() => {
      registerResourceHandlers(mockServer, testRoot);
    });

    it('should register resources list and read schemas', () => {
      expect(registeredHandlers.has(ListResourcesRequestSchema)).toBe(true);
      expect(registeredHandlers.has(ReadResourceRequestSchema)).toBe(true);
    });

    it('should read the suiteql guide file content successfully', async () => {
      const parentDir = path.join(testRoot, 'skills', 'netsuite-ai-connector-instructions', 'references');
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(path.join(parentDir, 'SUITEQL_GUIDE.md'), '# SuiteQL Guide Content', 'utf-8');

      const readFn = registeredHandlers.get(ReadResourceRequestSchema);
      const res = await readFn!({
        params: { uri: 'netsuite://guides/suiteql' }
      });

      expect(res.contents[0].text).toBe('# SuiteQL Guide Content');
    });
  });
});
