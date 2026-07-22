import axios from 'axios';
import http from 'http';
import https from 'https';

export const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000
});

// 排除非 https.AgentOptions 支持的 freeSocketTimeout
export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000
});

// 全局配置了 Keep-Alive 连接池与请求超时的 Axios 实例
export const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 30000
});
