import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function main() {
  const accountId = '5848789_sb1';
  console.log(`Connecting to NetSuite MCP Server (Account: ${accountId}) via Streamable HTTP...`);
  
  // Create an HTTP transport pointing to our MCP endpoint
  const url = new URL(`http://localhost:3000/mcp/${accountId}`);
  const transport = new StreamableHTTPClientTransport(url);
  
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  try {
    await client.connect(transport);
    console.log('✅ Connected to MCP Server via SSE successfully!');
    
    console.log('Fetching available tools...');
    const tools = await client.listTools();
    console.log(`✅ Server reported ${tools.tools.length} tools available.`);
    
    const targetTool = tools.tools.find(t => t.name === 'netsuite_status');
    if (targetTool) {
      console.log('Calling netsuite_status tool...');
      const result = await client.callTool({
        name: 'netsuite_status',
        arguments: {}
      });
      console.log('✅ netsuite_status result:', JSON.stringify(result, null, 2));
    } else {
      console.log('netsuite_status tool not found in tool list.');
    }
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

main().catch(console.error);
