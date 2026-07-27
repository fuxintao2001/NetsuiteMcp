import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { registerToolHandlers } from './tools.js';
import { registerResourceHandlers } from './resources.js';
import fs from 'fs/promises';
import path from 'path';

describe('MCP Handler Wires', () => {
  let mockServer: any;
  let mockOAuthManager: any;
  let mockMCPTools: any;
  let registeredHandlers: Map<string, Function>;

  const testRoot = path.join(process.cwd(), '.test-handlers-root');

  beforeEach(async () => {
    jest.clearAllMocks();
    await fs.rm(testRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(testRoot, 'skills/netsuite-ai-connector-instructions/references'), { recursive: true });
    await fs.writeFile(
      path.join(testRoot, 'skills/netsuite-ai-connector-instructions/references/SUITEQL_GUIDE.md'),
      '# SuiteQL Guidelines'
    );

    registeredHandlers = new Map();
    mockServer = {
      setRequestHandler: jest.fn((method: string, handler: Function) => {
        registeredHandlers.set(method, handler);
      })
    };

    mockOAuthManager = {
      getAccountId: (jest.fn() as any).mockResolvedValue('123456_SB1'),
      hasValidSession: (jest.fn() as any).mockResolvedValue(true),
      getSessionInfo: (jest.fn() as any).mockResolvedValue({ authenticated: true, accountId: '123456_SB1' })
    };

    mockMCPTools = {
      fetchTools: (jest.fn() as any).mockResolvedValue([
        { name: 'ns_getRecord', description: 'Fetch NetSuite records' },
        { name: 'ns_createRecord', description: 'Create NetSuite records' },
        { name: 'ns_updateRecord', description: 'Update NetSuite records' },
        { name: 'ns_runCustomSuiteQL', description: 'Run SuiteQL queries' }
      ]),
      executeTool: (jest.fn() as any).mockImplementation((name: string, args: any) => {
        if (name === 'ns_runCustomSuiteQL' && args.customRecordMappings) {
          if (args.customRecordMappings.some((m: any) => typeof m.rectype === 'string' && m.rectype.includes('unknown'))) {
            throw new Error('Could not resolve rectype ID');
          }
        }
        return Promise.resolve({ id: '101', type: 'customer', name: 'Acme Corp' });
      }),
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
      authCb = (jest.fn() as any).mockResolvedValue({ content: [{ type: 'text', text: 'Authentication process initiated' }] });
      logoutCb = (jest.fn() as any).mockResolvedValue({ content: [{ type: 'text', text: 'Logged out successfully' }] });
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
      expect(registeredHandlers.has('tools/list')).toBe(true);
      expect(registeredHandlers.has('tools/call')).toBe(true);
    });

    it('should list all tools when in Sandbox environment', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('9260916_SB3');
      const listFn = registeredHandlers.get('tools/list');

      const result = await listFn!();
      const names = result.tools.map((t: any) => t.name);

      expect(names).toContain('ns_createRecord');
      expect(names).toContain('ns_updateRecord');
      expect(names).toContain('ns_getRecord');
      expect(names).toContain('netsuite_get_record_link');
    });

    it('should filter out write tools when in Production environment', async () => {
      mockOAuthManager.getAccountId.mockResolvedValue('123456');
      const listFn = registeredHandlers.get('tools/list');

      const result = await listFn!();
      const names = result.tools.map((t: any) => t.name);

      expect(names).not.toContain('ns_createRecord');
      expect(names).not.toContain('ns_updateRecord');
      expect(names).toContain('ns_getRecord');
    });

    it('should return unauthenticated toolset when session is invalid', async () => {
      mockOAuthManager.hasValidSession.mockResolvedValue(false);
      const listFn = registeredHandlers.get('tools/list');

      const result = await listFn!();
      const names = result.tools.map((t: any) => t.name);

      expect(names).toEqual(['netsuite_authenticate', 'netsuite_logout', 'netsuite_status']);
    });

    it('should delegate tool execution to mcpTools.executeTool', async () => {
      const callFn = registeredHandlers.get('tools/call');

      const res = await callFn!({
        params: {
          name: 'ns_getRecord',
          arguments: { recordType: 'customer', id: '101' }
        }
      });

      expect(mockMCPTools.executeTool).toHaveBeenCalledWith('ns_getRecord', { recordType: 'customer', id: '101' });
      expect(res.content[0].text).toContain('Acme Corp');
    });

    it('should resolve custom record string rectype in ns_runCustomSuiteQL', async () => {
      const callFn = registeredHandlers.get('tools/call');

      await callFn!({
        params: {
          name: 'ns_runCustomSuiteQL',
          arguments: {
            sql: "SELECT * FROM customrecord_etissl_carrier",
            customRecordMappings: [
              { rectype: 'customrecord_etissl_carrier', scriptId: 'customrecord_etissl_carrier' }
            ]
          }
        }
      });

      expect(mockMCPTools.executeTool).toHaveBeenCalledWith('ns_runCustomSuiteQL', {
        sql: "SELECT * FROM customrecord_etissl_carrier",
        customRecordMappings: [
          { rectype: 'customrecord_etissl_carrier', scriptId: 'customrecord_etissl_carrier' }
        ]
      });
    });

    it('should throw error when custom record rectype cannot be resolved', async () => {
      const callFn = registeredHandlers.get('tools/call');

      const res = await callFn!({
        params: {
          name: 'ns_runCustomSuiteQL',
          arguments: {
            sql: "SELECT * FROM customrecord_unknown",
            customRecordMappings: [
              { rectype: 'customrecord_unknown', scriptId: 'customrecord_unknown' }
            ]
          }
        }
      });

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Could not resolve rectype ID');
    });

    it('should handle local authentication tool call', async () => {
      const callFn = registeredHandlers.get('tools/call');

      const res = await callFn!({
        params: {
          name: 'netsuite_authenticate',
          arguments: {}
        }
      });

      expect(authCb).toHaveBeenCalled();
      expect(res.content[0].text).toContain('Authentication process initiated');
    });

    it('should handle local logout tool call', async () => {
      const callFn = registeredHandlers.get('tools/call');

      const res = await callFn!({
        params: {
          name: 'netsuite_logout',
          arguments: {}
        }
      });

      expect(logoutCb).toHaveBeenCalled();
      expect(res.content[0].text).toContain('Logged out successfully');
    });

    it('should handle local status tool call', async () => {
      const callFn = registeredHandlers.get('tools/call');

      const res = await callFn!({
        params: {
          name: 'netsuite_status',
          arguments: {}
        }
      });

      expect(res.content[0].text).toContain('netsuite-mcp');
    });

    describe('netsuite_batch_execute tool', () => {
      it('should execute multiple tools in parallel and return partial results', async () => {
        const callFn = registeredHandlers.get('tools/call');

        mockMCPTools.executeTool
          .mockResolvedValueOnce({ id: '1', name: 'Cust 1' })
          .mockRejectedValueOnce(new Error('Record not found'));

        const res = await callFn!({
          params: {
            name: 'netsuite_batch_execute',
            arguments: {
              tasks: [
                { toolName: 'ns_getRecord', arguments: { recordType: 'customer', id: '1' } },
                { toolName: 'ns_getRecord', arguments: { recordType: 'customer', id: '99' } }
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
      });

      it('should fail only write tasks in production', async () => {
        mockOAuthManager.getAccountId.mockResolvedValue('123456');
        const callFn = registeredHandlers.get('tools/call');

        const res = await callFn!({
          params: {
            name: 'netsuite_batch_execute',
            arguments: {
              tasks: [
                { toolName: 'ns_createRecord', arguments: { recordType: 'customer' } }
              ]
            }
          }
        });

        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.individualResults[0].success).toBe(false);
        expect(parsed.individualResults[0].error).toContain('disabled in production');
      });

      it('should reject if tasks exceeds 10', async () => {
        const callFn = registeredHandlers.get('tools/call');
        const tasks = Array.from({ length: 11 }, () => ({ toolName: 'ns_getRecord', arguments: {} }));

        const res = await callFn!({
          params: {
            name: 'netsuite_batch_execute',
            arguments: { tasks }
          }
        });

        expect(res.isError).toBe(true);
        expect(res.content[0].text).toContain('maximum limit of 10');
      });
    });
  });

  describe('Resources Handler Wiring', () => {
    beforeEach(() => {
      registerResourceHandlers(mockServer, testRoot);
    });

    it('should register resources list and read schemas', () => {
      expect(registeredHandlers.has('resources/list')).toBe(true);
      expect(registeredHandlers.has('resources/read')).toBe(true);
    });

    it('should read the suiteql guide file content successfully', async () => {
      const readFn = registeredHandlers.get('resources/read');
      const res = await readFn!({
        params: { uri: 'netsuite://guides/suiteql' }
      });

      expect(res.contents[0].uri).toBe('netsuite://guides/suiteql');
      expect(res.contents[0].text).toContain('SuiteQL Guidelines');
    });
  });
});
