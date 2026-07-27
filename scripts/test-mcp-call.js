async function testMCP(accountId) {
  console.log(`\n🧪 测试环境 [${accountId}] 的 MCP Streamable HTTP 服务...`);
  try {
    const res = await fetch(`http://localhost:3000/mcp/${accountId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ns_runCustomSuiteQL',
          arguments: {
            sqlQuery: "SELECT id, entityid FROM customer WHERE ROWNUM <= 1"
          }
        }
      })
    });

    const textPayload = await res.text();
    console.log(`📡 [${accountId}] HTTP Status: ${res.status}`);
    
    // Parse SSE payload
    const dataLine = textPayload.split('\n').find(l => l.startsWith('data: '));
    let parsedData = null;
    if (dataLine) {
      try {
        parsedData = JSON.parse(dataLine.replace('data: ', '').trim());
      } catch {}
    } else {
      try {
        parsedData = JSON.parse(textPayload);
      } catch {}
    }

    if (parsedData?.result?.content?.[0]?.text) {
      console.log(`✅ [${accountId}] 真实数据返回成功！`);
      console.log(parsedData.result.content[0].text.substring(0, 300) + '...');
    } else {
      console.log(`ℹ️ [${accountId}] 原始响应:`, textPayload.substring(0, 200));
    }
  } catch (err) {
    console.error(`❌ [${accountId}] 测试失败:`, err.message);
  }
}

async function runTests() {
  await testMCP('5848789_sb1');
  await testMCP('9260916_sb1');
}

runTests();
