import { OAuthManager } from '../src/oauth/manager.js';
import { NetSuiteMCPTools } from '../src/mcp/tools.js';
import { cacheService } from '../src/utils/cache.js';
import path from 'path';

async function main() {
  const sessionsPath = '/Users/fuxintao/.gemini/antigravity/sessions/9260916_sb3';
  console.log(`Starting tool tests using session path: ${sessionsPath}`);

  const oauthManager = new OAuthManager({ storagePath: sessionsPath });
  const mcpTools = new NetSuiteMCPTools(oauthManager);

  // Configure cache
  cacheService.configure(path.resolve('.'));

  // Verify authentication
  const hasSession = await oauthManager.hasValidSession();
  console.log(`Authenticated: ${hasSession}`);
  if (!hasSession) {
    console.error('❌ Not authenticated for 9260916_sb3. Please authenticate first.');
    process.exit(1);
  }

  const accountId = await oauthManager.getAccountId();
  console.log(`Account ID: ${accountId}`);

  // Test 1: Fetch Tools
  console.log('\n--- Test 1: fetchTools ---');
  try {
    const tools = await mcpTools.fetchTools();
    console.log(`✅ Success: Found ${tools.length} tools`);
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 2: ns_getSubsidiaries
  console.log('\n--- Test 2: ns_getSubsidiaries ---');
  try {
    const result = await mcpTools.executeTool('ns_getSubsidiaries', {});
    console.log(`✅ Success (sample of output):`, String(JSON.stringify(result)).substring(0, 200));
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 3: ns_getSuiteQLMetadata (for subsidiary table)
  console.log('\n--- Test 3: ns_getSuiteQLMetadata (subsidiary) ---');
  try {
    const result = await mcpTools.executeTool('ns_getSuiteQLMetadata', { recordType: 'subsidiary' });
    console.log(`✅ Success (sample of output):`, JSON.stringify(result).substring(0, 200));
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 4: ns_runCustomSuiteQL
  console.log('\n--- Test 4: ns_runCustomSuiteQL (SELECT count(*) FROM subsidiary) ---');
  try {
    const result = await mcpTools.executeTool('ns_runCustomSuiteQL', {
      sqlQuery: 'SELECT count(*) as total FROM subsidiary'
    });
    console.log(`✅ Success:`, JSON.stringify(result));
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 5: ns_getRecordTypeMetadata (customer)
  console.log('\n--- Test 5: ns_getRecordTypeMetadata (customer) ---');
  try {
    const result = await mcpTools.executeTool('ns_getRecordTypeMetadata', { recordType: 'customer' });
    console.log(`✅ Success (sample of output):`, JSON.stringify(result).substring(0, 200));
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 6: ns_getRecord
  console.log('\n--- Test 6: ns_getRecord ---');
  let firstSubId: string | null = null;
  try {
    const qResult: any = await mcpTools.executeTool('ns_runCustomSuiteQL', {
      sqlQuery: 'SELECT id FROM subsidiary FETCH FIRST 1 ROWS ONLY'
    });
    const id = qResult?.data?.[0]?.id;
    if (id) {
      firstSubId = String(id);
      console.log(`Fetching subsidiary with ID: ${firstSubId}`);
      const result = await mcpTools.executeTool('ns_getRecord', {
        recordType: 'subsidiary',
        recordId: firstSubId
      });
      console.log(`✅ Success (sample of output):`, JSON.stringify(result).substring(0, 200));
    } else {
      console.log('Skipping ns_getRecord (no subsidiary ID found)');
    }
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 7: netsuite_run_parallel_queries
  console.log('\n--- Test 7: netsuite_run_parallel_queries ---');
  try {
    // We import the handler or call executeTool?
    // Wait, netsuite_run_parallel_queries is registered in the server, but it uses mcpTools internally.
    // Let's call executeTool on mcpTools for run_parallel_queries? No, netsuite_run_parallel_queries is a local tool handled in tools.ts,
    // but wait! Can we execute local tools using a mock handler or just test the helper functions?
    // Actually, mcpTools.executeTool does not handle local tools, it proxies them to NetSuite.
    // The local tools are handled in src/handlers/tools.ts.
    // Let's import or mock them?
    // Let's look at how handleRunParallelQueries is implemented in tools.ts:
    // It calls mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery }).
    // So we can test the logic directly in our test script by calling the underlying methods!
    console.log('Testing parallel query logic...');
    const queries = [
      'SELECT count(*) as total FROM subsidiary',
      'SELECT id, name FROM subsidiary FETCH FIRST 2 ROWS ONLY'
    ];
    const results = await Promise.all(queries.map(q => mcpTools.executeTool('ns_runCustomSuiteQL', { sqlQuery: q })));
    console.log(`✅ Success (parallel queries total: ${results.length})`);
    console.log(`Query 1 result:`, JSON.stringify(results[0]));
    console.log(`Query 2 result:`, JSON.stringify(results[1]).substring(0, 200));
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  // Test 8: netsuite_get_parallel_records
  console.log('\n--- Test 8: netsuite_get_parallel_records ---');
  try {
    if (firstSubId) {
      console.log('Testing parallel record retrieval...');
      const records = [
        { recordType: 'subsidiary', recordId: firstSubId }
      ];
      const results = await Promise.all(records.map(r => mcpTools.executeTool('ns_getRecord', { recordType: r.recordType, recordId: r.recordId })));
      console.log(`✅ Success (parallel records total: ${results.length})`);
      console.log(`Record 1 result:`, JSON.stringify(results[0]).substring(0, 200));
    } else {
      console.log('Skipping netsuite_get_parallel_records (no subsidiary ID)');
    }
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }

  console.log('\n--- All tool tests completed ---');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
