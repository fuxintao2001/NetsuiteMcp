import { exec } from 'child_process';

const accounts = [
  '5848789',
  '5848789_sb1',
  '9260916',
  '9260916_sb1',
  '9260916_sb3'
];

async function authAccount(accountId) {
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
          name: 'netsuite_authenticate',
          arguments: {}
        }
      })
    });

    const textPayload = await res.text();
    // Parse SSE format: data: {...}
    let data;
    const dataLine = textPayload.split('\n').find(line => line.startsWith('data: '));
    if (dataLine) {
      try {
        data = JSON.parse(dataLine.replace('data: ', '').trim());
      } catch {
        data = null;
      }
    } else {
      try {
        data = JSON.parse(textPayload);
      } catch {
        data = null;
      }
    }

    const textContent = data?.result?.content?.[0]?.text || textPayload;
    const match = textContent.match(/https:\/\/[^\s]+/);

    if (match && match[0]) {
      const url = match[0];
      console.log(`\n========================================`);
      console.log(`🔑 [${accountId}] 授权链接:`);
      console.log(url);
      console.log(`========================================\n`);
      
      // Open URL in macOS browser
      exec(`open "${url}"`);
    } else {
      console.log(`ℹ️ [${accountId}] 已发送认证指令。响应:`, textContent.substring(0, 100));
    }
  } catch (err) {
    console.error(`❌ [${accountId}] 请求异常:`, err.message);
  }
}

async function main() {
  console.log('🚀 正在依次为 5 个 NetSuite 环境发起 OAuth 2.0 PKCE 认证请求...\n');
  for (const acc of accounts) {
    await authAccount(acc);
    // 间隔 1.5 秒
    await new Promise(r => setTimeout(r, 1500));
  }
}

main();
