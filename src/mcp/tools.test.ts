import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { NetSuiteMCPTools } from './tools.js';
import { cacheService } from '../utils/cache.js';
import { httpClient } from '../utils/httpClient.js';

describe('NetSuiteMCPTools', () => {
  let mockOAuthManager: any;
  let client: NetSuiteMCPTools;
  let httpPostSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOAuthManager = {
      getAccountId: jest.fn().mockResolvedValue('test-acc'),
      ensureValidToken: jest.fn().mockResolvedValue('token-111'),
      forceRefreshToken: jest.fn().mockResolvedValue('token-222')
    };

    httpPostSpy = jest.spyOn(httpClient, 'post').mockResolvedValue({
      data: {
        result: {
          tools: []
        }
      }
    } as any);

    client = new NetSuiteMCPTools(mockOAuthManager);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('fetchTools', () => {
    it('should return cached tools if present', async () => {
      const mockTools = [{ name: 'ns_getRecord', description: 'desc' }];
      jest.spyOn(cacheService, 'get').mockResolvedValue(mockTools);

      const result = await client.fetchTools();
      expect(result).toEqual(mockTools);
      expect(cacheService.get).toHaveBeenCalledWith('test-acc', 'toolsCache');
    });

    it('should fetch tools from JSON-RPC and write to cache if empty', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValue(null);
      const cacheSetSpy = jest.spyOn(cacheService, 'set').mockResolvedValue(undefined);

      const mockTools = [{ name: 'ns_getRecord', description: 'desc' }];
      httpPostSpy.mockResolvedValueOnce({
        data: {
          result: {
            tools: mockTools
          }
        }
      });

      const result = await client.fetchTools();
      expect(result).toEqual(mockTools);
      expect(cacheSetSpy).toHaveBeenCalledWith('test-acc', 'toolsCache', mockTools, 3600);
    });
  });

  describe('executeTool', () => {
    it('should return cached metadata for metadata tools', async () => {
      const cached = { success: true, metadata: {} };
      jest.spyOn(cacheService, 'get').mockResolvedValue(cached);

      const result = await client.executeTool('ns_getRecordTypeMetadata', { recordType: 'customer' });
      expect(result).toEqual(cached);
      expect(cacheService.get).toHaveBeenCalledWith('test-acc', 'ns_getRecordTypeMetadata_customer');
    });

    it('should execute API call and cache metadata on success', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValue(null);
      const cacheSetSpy = jest.spyOn(cacheService, 'set').mockResolvedValue(undefined);

      const mockResult = { success: true };
      httpPostSpy.mockResolvedValueOnce({
        data: {
          result: mockResult
        }
      });

      const result = await client.executeTool('ns_getRecordTypeMetadata', { recordType: 'customer' });
      expect(result).toEqual(mockResult);
      expect(cacheSetSpy).toHaveBeenCalledWith('test-acc', 'ns_getRecordTypeMetadata_customer', mockResult);
    });

    it('should invalidate cache for related tables on SuiteQL error (self-heal)', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValue(null);
      const cacheDelSpy = jest.spyOn(cacheService, 'delete').mockResolvedValue(undefined);

      const err = new Error('SuiteQL syntax error');
      Object.assign(err, { response: { status: 400, data: { error: { message: 'Invalid query' } } } });
      httpPostSpy.mockRejectedValueOnce(err);

      await expect(
        client.executeTool('ns_runCustomSuiteQL', { sqlQuery: 'SELECT * FROM customer JOIN salesorder' })
      ).rejects.toThrow();

      // Expect deleted caches for customer and salesorder tables
      expect(cacheDelSpy).toHaveBeenCalledWith('test-acc', 'ns_getSuiteQLMetadata_customer');
      expect(cacheDelSpy).toHaveBeenCalledWith('test-acc', 'ns_getSuiteQLMetadata_salesorder');
    });

    it('should retry once on 401 unauthorized errors with a forced refresh token', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValue(null);
      
      const err401 = new Error('Unauthorized');
      Object.assign(err401, { response: { status: 401 } });

      const mockResult = { data: [1, 2] };
      httpPostSpy
        .mockRejectedValueOnce(err401)
        .mockResolvedValueOnce({
          data: {
            result: mockResult
          }
        });

      const result = await client.executeTool('ns_runCustomSuiteQL', { sqlQuery: 'SELECT id FROM customer' });
      expect(result).toEqual(mockResult);
      expect(mockOAuthManager.forceRefreshToken).toHaveBeenCalledWith('token-111');
      expect(httpPostSpy).toHaveBeenCalledTimes(2);
    });

    it('should retry on transient HTTP 502 and 504 errors', async () => {
      jest.spyOn(cacheService, 'get').mockResolvedValue(null);
      
      const err502 = new Error('Bad Gateway');
      Object.assign(err502, { response: { status: 502 } });

      const mockResult = { data: [1] };
      httpPostSpy
        .mockRejectedValueOnce(err502)
        .mockResolvedValueOnce({
          data: {
            result: mockResult
          }
        });

      const result = await client.executeTool('ns_runCustomSuiteQL', { sqlQuery: 'SELECT id FROM customer' });
      expect(result).toEqual(mockResult);
      expect(httpPostSpy).toHaveBeenCalledTimes(2);
    });
  });
});
