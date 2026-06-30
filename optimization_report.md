# NetSuite MCP Server — 代码库优化与加固报告

本报告对 NetSuite MCP Server (`@suiteinsider/netsuite-mcp`) 进行了全面的架构与安全审查。它汇总了在六个探索领域（缓存、并发、网络、OAuth 与会话、错误处理与日志记录、以及 TypeScript 严格性）中完成的静态分析发现、性能审计和安全漏洞审查结果，并整合了同行评审与验证团队的反馈意见。

---

## 📊 建议矩阵摘要

以下是所有已识别问题的优先级矩阵，概述了它们的影响、实施成本以及受影响的具体模块。

| 编号 | 类别 | 描述 | 优先级 | 性能/安全影响 | 实施成本 | 受影响的模块 |
|:---|:---|:---|:---|:---|:---|:---|
| **R1** | 安全 | 在日志和错误中，从 Axios 拒绝信息中脱敏/隐藏凭证（访问/刷新 Token）以及主机路径 | **紧急** | 防止明文 Token 和路径泄露到日志流中 | 低 | `src/utils/errors.ts`, `src/index.ts` |
| **R2** | 安全 | 将 OAuth 回调 HTTP 服务器严格绑定到回环接口 (`127.0.0.1`)，而不是通配符 (`0.0.0.0`) | **高** | 防止局域网（LAN）用户访问本地授权监听器 | 低 | `src/oauth/callbackServer.ts` |
| **R3** | 安全 | 对本地 HTTP 服务器返回的 HTML 错误消息进行 HTML 转义 | **高** | 消除回调页面中的反射型 XSS 漏洞 | 低 | `src/oauth/callbackServer.ts` |
| **R4** | 安全 | 在磁盘上加密存储的会话 Token (AES-256-GCM)，并强制执行仅所有者可读写的文件权限 (`0o600`) | **高** | 防止本地用户或未授权软件窃取凭证 | 中 | `src/oauth/sessionStorage.ts` |
| **R5** | 可靠性 | 解决 Token 验证与主动刷新过程中的竞态条件/重复加载与锁定执行问题 | **高** | 避免重复的 Token 续期、文件锁定以及返回无效 Token | 低 | `src/oauth/manager.ts` |
| **R6** | 性能 | 在 Axios HTTP 客户端上启用 HTTP Keep-Alive 连接池 | **高** | 通过复用 TCP/TLS 连接减少网络开销（每次请求约节省 200ms 延迟） | 低 | `src/mcp/tools.ts`, `src/oauth/tokenExchange.ts` |
| **R7** | 可靠性 | 解析 NetSuite 的 `Retry-After` 响应头，并对瞬时 HTTP 429/503 错误应用带抖动的指数退避重试 | **高** | 消除惊群效应导致的失败；优雅地处理 API 速率限制 | 中 | `src/utils/resilience.ts`, `src/mcp/tools.ts` |
| **R8** | 类型安全 | 在 MCP 工具请求处理程序内部强制执行 Zod 参数验证 | **高** | 防止格式错误的参数进入运行时执行；自动拒绝无效输入 | 中 | `src/handlers/tools.ts`, `src/handlers/toolSchemas.ts` |
| **R9** | 可靠性 | 重构全局 `uncaughtException` 处理程序，使其执行进程退出而不是吞掉异常 | **高** | 避免进入不可恢复的“僵尸”状态；使系统监管程序能够干净地重启服务 | 低 | `src/index.ts` |
| **R10**| 一致性 | 对元数据表名/缓存键强制执行大小写归一化（转换为小写） | **中** | 解决因大小写不匹配导致的自愈失效故障 | 低 | `src/mcp/tools.ts`, `src/utils/cache.ts` |
| **R11**| 可靠性 | 重构缓存系统，使其包含带有 TTL 的元数据信封，并对缓存键进行哈希处理以避免文件名冲突 | **中** | 保证自定义 TTL 到期合规性，并防止文件名冲突引起的模式污染 | 中 | `src/utils/cache.ts` |
| **R12**| 性能 | 压缩 L2 缓存的 JSON 字符串并过渡到非阻塞式序列化 | **中** | 减少磁盘序列化开销，避免在大体量 SuiteQL 负载下阻塞 CPU 事件循环 | 中 | `src/utils/cache.ts`, `src/utils/json.ts` |
| **R13**| 类型安全 | 加强 `tsconfig.json` 中的 TypeScript 编译配置 | **中** | 开启编译器对遗漏 switch 分支、隐式返回和未检查索引访问的早期检测 | 低 | `tsconfig.json` |
| **R14**| 并发 | 实现客户端级别的全局信号量（Semaphore）以限制发送至 NetSuite 的并发请求数 | **中** | 保护 NetSuite 账户额度，防止因并发重叠的工具调用导致超限 | 中 | `src/utils/resilience.ts`, `src/mcp/tools.ts` |

---

## 🔍 各领域详细发现与解决方案

### 1. 缓存基础设施与缓存服务 (`src/utils/cache.ts`)

#### 识别出的瓶颈与问题：
- **自定义 TTL 差异与晋升 Bug**：L2 文件缓存将数据作为原始 JSON 写入磁盘，而没有存储自定义 of the TTL 或过期时间戳。当在 1 小时内从 L2 读取某项数据时，它会被重新晋升回 L1 内存中，但没有传递自定义的 TTL，导致它的 L1 过期时间被重置为默认的 1 小时。这破坏了短生命周期的缓存（例如 60 秒），并且如果在 1 小时内重启了进程，长生命周期的缓存（例如 24 小时）也会提前失效。
- **缓存键文件名冲突**：清理缓存键的正则（`key.replace(/[^a-zA-Z0-9_-]/g, '_')`）会将不同的字符压缩为同一个字符。这会导致类似 `customrecord.my_table`、`customrecord/my_table` 和 `customrecord_my_table` 的不同缓存键都解析为同一个文件（`ns_getRecordTypeMetadata_customrecord_my_table.json`），从而导致模式数据污染和错误的返回结果。
- **自愈失效机制中的大小写敏感度不一致**：从自定义 SuiteQL 查询中提取的表名已转换为小写（例如 `customer`）。然而，元数据缓存键保留了原始参数的大小写（例如 `ns_getSuiteQLMetadata_Customer`）。因此，缓存自愈失效机制删除的是 `ns_getSuiteQLMetadata_customer`，未能删除内存中的实际键，使得过期的缓存继续残留。
- **阻塞事件循环**：写出 L2 缓存时，在主线程上同步使用 `JSON.stringify(data, null, 2)` 进行格式化缩进，而读取时在大文件上执行阻塞的 JSON 解析。对于数兆字节的数据集，这会冻结单线程的 Node.js 事件循环。

#### 代码优化方案：
我们建议将 L2 缓存的数据结构重构为**缓存信封 (Cache Envelope) 包装模式**，该信封可以保存到期元数据；使用 SHA-256 对缓存键进行哈希处理以生成安全且防冲突的文件名；将元数据键及前缀全部转换为小写进行归一化，以防在区分大小写的文件系统上产生失效遗漏；并取消 JSON 的格式化缩进（pretty-print）以加快序列化。

##### 优化后实现代码：
```typescript
import NodeCache from 'node-cache';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { asyncJsonParse } from './json.js';

interface CacheEnvelope<T> {
  expiration: number;   // UTC 毫秒时间戳
  ttlSeconds: number;   // 原始 TTL
  data: T;
}

export class CacheService {
  private memoryCache: NodeCache;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.memoryCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
    this.projectRoot = projectRoot ?? process.cwd();
  }

  configure(projectRoot: string): void {
    this.projectRoot = projectRoot;
  }

  /**
   * 生成确定性、防冲突且完全小写的文件路径，防止在区分大小写的文件系统上漏删
   */
  private getFileSystemCachePath(accountId: string, key: string): string {
    const normalizedKey = key.toLowerCase();
    const hash = createHash('sha256').update(normalizedKey).digest('hex');
    const safePrefix = normalizedKey.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safePrefix}_${hash.slice(0, 16)}.json`;
    return path.join(this.projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), filename);
  }

  async get<T>(accountId: string, key: string): Promise<T | null> {
    // 将内存缓存键归一化为小写，确保 L1/L2 大小写处理的一致性
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    
    // L1 内存缓存检查
    const memResult = this.memoryCache.get<T>(memKey);
    if (memResult !== undefined) {
      console.error(`⚡ [Cache Hit L1] Memory cache hit for ${key}`);
      return memResult;
    }

    // L2 文件系统缓存检查
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      const stats = await fs.stat(fsPath);
      const fileData = await fs.readFile(fsPath, 'utf-8');
      const envelope = await asyncJsonParse<any>(fileData);
      
      if (envelope && typeof envelope === 'object' && 'expiration' in envelope && 'data' in envelope) {
        const now = Date.now();
        if (now < envelope.expiration) {
          const remainingTtl = Math.max(1, Math.round((envelope.expiration - now) / 1000));
          // 使用剩余的 TTL 晋升回 L1 内存缓存
          this.memoryCache.set(memKey, envelope.data, remainingTtl);
          console.error(`⚡ [Cache Hit L2] File cache hit for ${key}. Promoted to L1 (remaining TTL: ${remainingTtl}s).`);
          return envelope.data;
        } else {
          // 已过期，异步删除 L2 缓存文件
          fs.unlink(fsPath).catch(() => {});
        }
      } else {
        // 对旧版缓存格式的向前兼容回退处理
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < 3600 * 1000) {
          this.memoryCache.set(memKey, envelope);
          console.error(`⚡ [Cache Hit L2 Legacy] File cache hit for legacy key ${key}. Promoted to L1.`);
          return envelope as T;
        } else {
          fs.unlink(fsPath).catch(() => {});
        }
      }
    } catch {
      // 忽略读取错误
    }
    return null;
  }

  async set<T>(accountId: string, key: string, data: T, ttlSeconds: number = 3600): Promise<void> {
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    this.memoryCache.set(memKey, data, ttlSeconds);

    const fsPath = this.getFileSystemCachePath(accountId, key);
    const envelope: CacheEnvelope<T> = {
      expiration: Date.now() + (ttlSeconds * 1000),
      ttlSeconds,
      data
    };

    try {
      await fs.mkdir(path.dirname(fsPath), { recursive: true });
      // 压缩 JSON（无多余空格缩进）以优化性能并减少磁盘占用
      await fs.writeFile(fsPath, JSON.stringify(envelope), 'utf-8');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to write L2 cache for ${key}: ${message}`);
    }
  }

  async delete(accountId: string, key: string): Promise<void> {
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    this.memoryCache.del(memKey);
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      await fs.unlink(fsPath);
    } catch {}
  }

  /**
   * 清除指定账户的所有 L1 与 L2 缓存
   */
  async clearAccountCache(accountId: string): Promise<void> {
    // 清理 L1 内存
    const keys = this.memoryCache.keys();
    const accountKeys = keys.filter(k => k.toLowerCase().startsWith(`${accountId.toLowerCase()}::`));
    this.memoryCache.del(accountKeys);

    // 清理 L2 磁盘缓存
    const fsPath = this.getFileSystemCachePath(accountId, 'dummy');
    const fsDir = path.dirname(fsPath);
    try {
      await fs.rm(fsDir, { recursive: true, force: true });
      console.error(`🗑️ L1 and L2 Cache cleared for account ${accountId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to clear L2 cache for ${accountId}: ${message}`);
    }
  }

  /**
   * 获取缓存诊断状态指标
   */
  getStats(): { l1KeyCount: number; l2CacheDir: string } {
    return {
      l1KeyCount: this.memoryCache.keys().length,
      l2CacheDir: path.join(this.projectRoot, '.cache')
    };
  }
}

// 导出 CacheService 的单例实例，供全局引用
export const cacheService = new CacheService();
```

##### 针对 `src/mcp/tools.ts` 中键名大小写的一致性修复：
```typescript
// 在 src/mcp/tools.ts 中，对参数加入类型防御，安全地将记录/表名统一转换为小写以匹配哈希键
private metadataCacheKey(toolName: string, params: Record<string, unknown>): string {
  const recordTypeRaw = params.recordType ?? params.tableName ?? 'all';
  const recordType = typeof recordTypeRaw === 'string' ? recordTypeRaw.toLowerCase() : 'all';
  return `${toolName}_${recordType}`;
}
```

---

### 2. 网络操作与并发控制 (`src/mcp/tools.ts`, `src/utils/resilience.ts`)

#### 识别出的瓶颈与问题：
- **Axios Socket/TLS 握手延迟**：项目使用了一个未配置的默认 `axios` 实例进行 HTTP 请求，未指定自定义的 HTTP/HTTPS Agent，这导致 Socket 在每次请求后立即被关闭。每次向 NetSuite 发起 API 请求都必须重新经历 TCP 三次握手和 TLS 握手，产生约 200ms - 500ms 的额外延迟。
- **简陋的瞬时错误重试逻辑**：在遇到网络故障或限流（HTTP 429/503）时，客户端只是硬编码等待 2 秒并精确重试一次。若网络抖动超过 2 秒则会直接报错，且对于需要更长退避时间的限流操作也会直接失败。
- **忽略了限流退避头**：NetSuite 在触发 API 速率限制时会返回一个 `Retry-After` 响应头，而客户端目前完全忽略了这一关键重试指示。
- **缺少全局客户端级信号量限制**：虽然在并行工具处理（如 `handleRunParallelQueries`）中硬编码了并发数限制（最大 5 ），但跨越多个并行工具调用或并发的独立工具请求会完全绕过这一局部限制，从而容易在 NetSuite 端触发 429 速率限制错误。

#### 代码优化方案：
1. 初始化一个共享的、配置了 Keep-Alive 的 HTTPS Agent 以实现 TCP 连接池复用，并在编译期排除非法的 `freeSocketTimeout` 配置项。
2. 实现一个结合了随机抖动（Jitter）和自适应识别 `Retry-After` 头的指数退避重试工具函数。
3. 构建一个全局信号量（Semaphore），在进程内进行排队。**更新的 `ConcurrencyLimiter` 必须直接传递 Slot**，即在 `finally` 块中获取下一项并同步执行 `next()`，而**不修改 `activeCount`**，防止微任务排队间隙（Race Condition）导致并发穿透超出 `maxConcurrency` 限制。

##### 优化后实现代码：
```typescript
// 创建 src/utils/httpClient.ts 并配置长连接池
import axios from 'axios';
import http from 'http';
import https from 'https';

export const httpAgent = new http.Agent({ keepAlive: true });

// 排除非 https.AgentOptions 支持的 freeSocketTimeout
export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000
});

// 全局配置了 Keep-Alive 连接池的 Axios 实例
export const httpClient = axios.create({
  httpAgent,
  httpsAgent
});
```

```typescript
// src/utils/resilience.ts (添加指数退避重试与强隔离并发限流)
export interface RetryOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
  factor?: number;
  jitter?: boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions = {},
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
): Promise<T> {
  const retries = options.retries ?? 3;
  const minTimeout = options.minTimeoutMs ?? 1000;
  const maxTimeout = options.maxTimeoutMs ?? 15000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      if (attempt > retries || !isRetryable(error)) {
        throw error;
      }

      // 优先解析并遵从 NetSuite 返回的 Retry-After 头部时间
      let delay = getRetryAfterMs(error) ?? (minTimeout * Math.pow(factor, attempt - 1));
      delay = Math.min(delay, maxTimeout);
      
      if (jitter && !getRetryAfterMs(error)) {
        // 应用随机抖动，防止波峰重合（惊群效应）
        delay = (Math.random() * 0.5 + 0.5) * delay;
      }

      if (onRetry) {
        onRetry(error, attempt, delay);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function getRetryAfterMs(error: any): number | null {
  const headers = error.response?.headers;
  if (!headers) return null;
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (!retryAfter) return null;

  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;

  const dateMs = Date.parse(retryAfter);
  if (!isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return null;
}

/**
 * 全局信号量控制，严格防止并发请求数超出 NetSuite 的账户承载上限。
 * 采用直接 Slot 转移逻辑，避免 activeCount 增减与微任务调度的竞态条件。
 */
export class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];
  private readonly maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.activeCount++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        // 关键点：直接将 Slot 传递给队列中的下一项，保持 activeCount 不变
        // 消除 activeCount-- 后再异步 resolve() 导致短暂 activeCount 降低引发的穿透
        next();
      } else {
        this.activeCount--;
      }
    }
  }
}
```

##### 针对 `src/mcp/tools.ts` 集成并发限制器与重试退避的实现示例：

以下代码展示了如何在 `src/mcp/tools.ts` 的 `NetSuiteMCPTools` 客户端中实例化 `ConcurrencyLimiter`，并在具体工具请求中配合 `retryWithBackoff()` 对底层的 NetSuite HTTP 调用进行并发排队与指数退避重试：

```typescript
import { ConcurrencyLimiter, retryWithBackoff } from '../utils/resilience.js';
import { httpClient } from '../utils/httpClient.js';

// 初始化全局并发限制器，控制发送至 NetSuite API 的并发请求量（限制为最多 5 个并发请求）
const netsuiteLimiter = new ConcurrencyLimiter(5);

// 定义重试条件判断函数
const isRetryableError = (error: any): boolean => {
  // 当发生网络超时、连接错误，或者 NetSuite 返回 429 (Too Many Requests)、503 (Service Unavailable) 状态码时允许重试
  if (error.code === 'ECONNABORTED' || error.message?.includes('Network Error')) {
    return true;
  }
  const status = error.response?.status;
  return status === 429 || status === 503;
};

export class NetSuiteMCPTools {
  // ... 其他属性与方法 ...

  /**
   * 通用的 NetSuite REST API 调用包装方法，自动包含并发限制与指数退避重试
   */
  async callNetSuiteApi<T>(requestFn: () => Promise<T>): Promise<T> {
    // 1. 通过并发限制器包装，确保最多只有 5 个请求同时被执行，超出的请求将在内存队列中排队
    return netsuiteLimiter.run(async () => {
      // 2. 结合重试机制，应对瞬间网络波动及 API 限制
      return retryWithBackoff(
        requestFn,
        isRetryableError,
        {
          retries: 3,          // 最大重试 3 次
          minTimeoutMs: 1000,  // 最小初始等待 1s
          maxTimeoutMs: 15000, // 最大等待 15s
          factor: 2,           // 指数倍数 2
          jitter: true         // 启用随机抖动，防止重试波峰重合
        },
        (error: any, attempt: number, delayMs: number) => {
          console.error(
            `⚠️ [NetSuite Request Retry] Attempt ${attempt} failed. ` +
            `Retrying in ${Math.round(delayMs)}ms... Error: ${error.message || error}`
          );
        }
      );
    });
  }

  /**
   * 具体工具请求调用示例（例如 SuiteQL 查询）
   */
  async runSuiteQL(query: string, limit: number = 10, offset: number = 0): Promise<any> {
    return this.callNetSuiteApi(async () => {
      const response = await httpClient.post('/services/rest/query/v1/suiteql', {
        q: query
      }, {
        headers: {
          'Prefer': 'transient',
        },
        params: {
          limit,
          offset
        }
      });
      return response.data;
    });
  }
}
```

#### Jest Mock 泄露问题与测试重构建议：
当底层将全局 `axios` 调用重构为 `axios.create` 生成的 `httpClient` 实例后，单元测试中原本针对全局 `axios` 的 mock 监视器（如 `jest.spyOn(axios, 'post')`）将失效，导致单元测试时泄露真实的 HTTP 请求并引发报错。

**解决方案：**
1. **导出实例并直接 Mock 实例方法：**
   In 单元测试中直接导入 `httpClient` 实例，并针对其进行 mock 劫持：
   ```typescript
   import { httpClient } from '../utils/httpClient.js';
   
   jest.spyOn(httpClient, 'post').mockResolvedValue({
     status: 200,
     data: { /* mock data */ }
   });
   ```
2. **使用 `axios-mock-adapter` 针对实例进行集成拦截：**
   ```typescript
   import MockAdapter from 'axios-mock-adapter';
   import { httpClient } from '../utils/httpClient.js';

   const mock = new MockAdapter(httpClient);
   mock.onPost('/some-endpoint').reply(200, {
     /* mock data */
   });
   ```

---

### 3. OAuth 与会话安全 (`src/oauth/*`)

#### 识别出的瓶颈与问题：
- **通配符主机端口绑定**：用于 OAuth 本地重定向回调的 HTTP 服务器是用 `this.server.listen(this.port)` 启动的，未指定明确的主机 IP。Node.js 默认会将其绑定 to 通配符接口（`0.0.0.0` 或 `::`），导致该回调端口直接向局域网（LAN）暴露。
- **反射型跨站脚本 (XSS)**：认证失败时，系统通过 URL 的 `error` 参数获取错误信息，并使用未经过滤的字符串模板直接拼接至 HTML 中通过 `sendErrorPage` 输出。攻击者可构造带有恶意 Script 的链接，诱导用户点击并在本地回环域执行代码。
- **易被破坏的回调服务器生命周期（DoS）**：如果收到带有不匹配 state 参数的恶意 HTTP 请求（或受浏览器扩展的安全扫描扫描），服务器会执行 `settle('reject', ...)` 并解绑注销 HTTP 监听，这会导致后续用户真正的合法认证重定向直接失败。
- **不安全的本地文件权限与明文存储**：缓存及会话目录在创建时未指定文件模式掩码，采用了系统的默认值 `0o644`。同时，`access_token` 和 `refresh_token` 被明文以 JSON 字符串形式保存在磁盘中，可被主机上的其他恶意软件直接窃取。
- **Token 刷新竞态条件**：当有高并发的工具调用同时触发时，它们会在执行异步的 `storage.load()` 后检查 `this.refreshPromise` 状态。在首个请求将刷新的 Promise 挂载到实例之前，后面的请求已通过了检查，从而并发发起了多次重复的 Token 刷新交换，并在写文件时造成写冲突。

#### 代码优化方案：
1. 将本地回调服务器的监听地址严格限制在 `127.0.0.1` 本地回环。
2. 引入 HTML 转义过滤工具函数，确保在 error 渲染页面转义 HTML 特殊字符，防止 XSS 攻击。且在遇到非 fatal 的非法请求时不要关闭回调服务器，允许其继续运行直至超时。
3. 磁盘 session 文件使用 **AES-256-GCM** 算法进行对称加密，避免使用硬编码字符串作为密钥，并在将 Session 保存至本地时，限制目录和文件的访问权限为仅所有者可读写（`0o700`/`0o600`）。
4. 在读取加密会话时，**使用严格的密文特征匹配**（不以 `{` 开头，或者满足 `iv:authTag:encrypted` 的 hex 格式正则），以防普通明文 JSON 报错，实现平滑的自适应升级。
5. 在 `ensureValidToken` 中，将读取文件、判断过期和挂载 Promise 作为一个整体的原子异步链锁定，阻断竞态条件。
6. **提供无 MCP_SESSION_SECRET 时的会话过期警告**：当未配置该环境变量时，日志中会打印警告，指出 sessions 无法跨服务重启持久化（因为每次重启会产生不同的随机密钥，导致之前落盘的 Token 无法成功解密）。
7. **遵守 RFC 5116 使用 12 字节 GCM IV** 确保最佳的安全性和性能，取代 suboptimal 的 16 字节 IV。
8. **显式强制文件权限**：在 `fs.writeFile` 后显式调用 `fs.chmod(this.sessionFile, 0o600)` 以防止预先存在的宽松文件权限未被修改。

##### 优化后实现代码：
```typescript
// src/oauth/callbackServer.ts (严格绑定、HTML 转义安全防范、请求过滤)
import http from 'http';

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (m) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return map[m] || m;
  });
}

// 绑定 127.0.0.1 回环口
this.server.listen(this.port, '127.0.0.1', () => {
  console.error(`🌐 OAuth callback server listening strictly on http://127.0.0.1:${this.port}`);
});

// 在 handleRequest 中过滤非致命的无效 state 错误请求，不触发 settle() 关闭
if (state !== expectedState) {
  this.sendErrorPage(res, 'Invalid State', 'CSRF validation failed. Please try again.');
  return; // 直接返回，不破坏当前服务器生命周期，允许真实认证请求重试
}

private sendErrorPage(res: http.ServerResponse, title: string, message: string): void {
  const statusCode = title.includes('Invalid') ? 400 : 500;
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui;text-align:center;padding:50px;">
<h1>❌ ${escapeHtml(title)}</h1>
<p style="color:#d32f2f;font-size:1.1em;">${escapeHtml(message)}</p>
<p style="color:#666;margin-top:30px;">您现在可以关闭此窗口了。</p>
</body></html>`);
}
```

```typescript
// src/oauth/sessionStorage.ts (AES-256-GCM 强加密与所有者读写权限隔离)
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

let processFallbackKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (process.env.MCP_SESSION_SECRET) {
    return crypto.createHash('sha256').update(process.env.MCP_SESSION_SECRET).digest();
  }
  // 未配置 MCP_SESSION_SECRET 时，向用户输出警告，说明 sessions 在重启后将失效
  console.warn(
    '⚠️ Warning: MCP_SESSION_SECRET environment variable is not defined. ' +
    'Generating a process-lifetime random key. Saved sessions will expire and become unreadable when the server restarts.'
  );
  if (!processFallbackKey) {
    processFallbackKey = crypto.randomBytes(32);
  }
  return processFallbackKey;
}

function encrypt(text: string): string {
  // 使用 RFC 5116 推荐的 12 字节 IV
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(cipherText: string): string {
  const [ivHex, authTagHex, encrypted] = cipherText.split(':');
  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid cipher text format');
  }
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// 在 SessionStorage 类中：
async save(data: SessionData): Promise<void> {
  try {
    await fs.mkdir(this.storagePath, { recursive: true });
    // 限制目录权限（0o700：仅所有者可读、写、执行）
    await fs.chmod(this.storagePath, 0o700).catch(() => {});

    const payload = JSON.stringify(data);
    const encrypted = encrypt(payload);

    // 仅以所有者可读写权限 (0o600) 写入加密文件，并显式修改已有文件的权限以覆盖原本更宽松的权限
    await fs.writeFile(this.sessionFile, encrypted, { mode: 0o600 });
    await fs.chmod(this.sessionFile, 0o600);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Failed to save session:', message);
    throw error;
  }
}

async load(): Promise<SessionData | null> {
  try {
    const fileContent = await fs.readFile(this.sessionFile, 'utf-8');
    const trimmed = fileContent.trim();
    if (!trimmed) return null;

    let decryptedData = fileContent;
    
    // 严格识别加密：由于明文 JSON 以 '{' 开头，凡是不以 '{' 开头的非空内容均视为 AES-256-GCM 密文
    const isEncrypted = !trimmed.startsWith('{');

    if (isEncrypted) {
      try {
        decryptedData = decrypt(trimmed);
      } catch (decErr) {
        console.error('⚠️ Failed to decrypt session file:', decErr);
        return null;
      }
    }
    
    try {
      return JSON.parse(decryptedData) as SessionData;
    } catch {
      await this.clear();
      return null;
    }
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  }
}
```

```typescript
// src/oauth/manager.ts (原子 Promise 刷新锁)
async ensureValidToken(): Promise<string> {
  // 1. 立即返回已存在的刷新 promise，以解决并发判断竞态条件
  if (this.refreshPromise) {
    return this.refreshPromise;
  }

  // 2. 将加载、过期判断、刷新等异步链路包裹在同一个被缓存的 Promise 块中
  this.refreshPromise = (async () => {
    try {
      const session = await this.storage.load();
      if (!session || !session.tokens) {
        throw new Error('未认证。请先运行认证流程。');
      }

      if (shouldRefreshToken(session.tokens) || this.shouldProactivelyRenew(session.tokens)) {
        console.error('⚠️ Token 即将过期或触发主动续期，正在刷新...');
        return await this.executeTokenRefresh(session, session.tokens.access_token);
      }

      return session.tokens.access_token;
    } finally {
      this.refreshPromise = null;
    }
  })();

  return this.refreshPromise;
}
```

#### 单元测试与加密存储冲突解决方案：
现有的单元测试在测试 OAuth Flow 时，会直接利用 `fs.readFile` 读取 `session.json` 并试图直接通过 `JSON.parse` 解析出明文 Token，开启 AES-256-GCM 强加密存储后，这会导致现有的测试套件（如 `manager.test.ts` 和 `sessionStorage.test.ts`）崩溃。

**推荐解决方案：**
1. **重构测试为通过 `SessionStorage` 接口进行访问：**
   将测试代码中所有直接调用 `fs.readFile(sessionFile)` 或 `fs.writeFile(sessionFile)` 的逻辑，重构为通过 `SessionStorage` 实例的 `load()` 和 `save()` 方法操作。因为该接口内部包含了加解密逻辑，对测试完全透明。
2. **使用 Jest 对加解密模块进行拦截 mock：**
   在测试开头加入 Jest 劫持，将 `encrypt` 和 `decrypt` mock 为原样返回明文（Identity Function），使测试所写出的内容依旧是纯 JSON 字符串：
   ```typescript
   jest.mock('./sessionStorage.js', () => {
     const original = jest.requireActual('./sessionStorage.js');
     return {
       ...original,
       encrypt: (text: string) => text,
       decrypt: (text: string) => text
     };
   });
   ```

---

### 4. 错误处理、日志记录与进程安全 (`src/index.ts`, `src/utils/errors.ts`)

#### 识别出的瓶颈与问题：
- **日志中的 Token 凭证泄露**：当 Axios 请求失败时，Axios 抛出的错误会附带请求的完整配置块（config），将请求头中的明文 Bearer Token 等敏感信息暴露到服务器日志终端中。
- **系统敏感物理路径暴露**：与文件系统相关的错误会透露宿主系统下的绝对目录结构（例如 `/Users/username/...`），暴露了宿主的敏感路径。
- **僵尸进程常驻风险**：当前的全局 `uncaughtException` 监听器只打印了错误却放任进程继续运行，这会导致服务处于不可控“僵尸”状态。
- **NetSuite 详细报错内容丢失**：原版 `sanitizeError` 会直接舍弃 Axios 错误对象并只返回状态码及 URL，从而直接把 NetSuite 的 API 错误体（包含如 `INVALID_SQL` 语法报错等关键诊断信息）过滤丢弃，大幅削弱了故障诊断能力。

#### 代码优化方案：
1. 建立全局错误脱敏过滤函数，过滤一切可疑凭证和操作系统绝对路径。
2. 优化 `sanitizeError` 结构，**优先执行 `parseNetSuiteError` 解析错误体以获取 NetSuite 报错明细**，然后再将文本交由 `sanitizeMessage` 过滤路径与凭证。
3. 对 `uncaughtException` 执行红牌离场退出（以 exit 1 状态码），让守护进程得以自动重新拉起。

##### 优化后实现代码：
```typescript
// src/utils/errors.ts (引入敏感信息与敏感路径脱敏过滤)

export function sanitizeMessage(message: string): string {
  if (!message) return message;
  let sanitized = message;

  // 正则过滤各种凭证敏感串
  sanitized = sanitized.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/refresh_token=[a-zA-Z0-9_\-\.]+/gi, 'refresh_token=[REDACTED]');
  sanitized = sanitized.replace(/client_id=[a-zA-Z0-9_\-\.]+/gi, 'client_id=[REDACTED]');
  sanitized = sanitized.replace(/code_verifier=[a-zA-Z0-9_\-\.]+/gi, 'code_verifier=[REDACTED]');
  sanitized = sanitized.replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[REDACTED]"');
  sanitized = sanitized.replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[REDACTED]"');

  // 正则过滤操作系统的绝对工作目录与用户物理路径
  const cwd = process.cwd();
  if (cwd) {
    const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escapedCwd, 'g'), '<PROJECT_ROOT>');
  }
  sanitized = sanitized.replace(/\/Users\/[a-zA-Z0-9_\-\.]+/gi, '/Users/<USER>');
  sanitized = sanitized.replace(/\/home\/[a-zA-Z0-9_\-\.]+/gi, '/home/<USER>');

  return sanitized;
}

/**
 * 脱敏错误信息：优先提取 NetSuite 具体的 API 返回体（如 INVALID_SQL 详情），
 * 然后对其做脱敏，同时避免 Axios 大对象泄露敏感 config 凭证。
 */
export function sanitizeError(error: unknown): Error {
  if (!error) return new Error('Unknown error');

  // 1. 提取 NetSuite 精确内部报错详情以防止 INVALID_SQL 等信息流失
  const parsedError = parseNetSuiteError(error);

  // 2. 对返回 of the 报错 message 进行敏感路径与 credential 脱敏
  const cleanMsg = sanitizeMessage(parsedError.message);
  const cleanErr = new Error(cleanMsg);
  
  if (parsedError.stack) {
    cleanErr.stack = sanitizeMessage(parsedError.stack);
  }
  
  return cleanErr;
}
```

---

### 5. TypeScript 类型严格度与类型安全 (`tsconfig.json`, Zod 参数验证)

#### 识别出的瓶颈与问题：
- **过于宽松的 TS 编译器配置**：原始的 `tsconfig.json` 配置中缺少严防死角防御策略，例如允许隐式返回（`noImplicitReturns`）、允许不安全的索引读取值（未开启 `noUncheckedIndexedAccess`）以及 Switch Case 的直通掉落漏检。
- **手写参数校验逻辑**：部分并行工具里依靠手动判断（如 `if (!Array.isArray(queries))`）。这种手写方式非常不稳健、繁琐且不利于与 MCP Tool 的元数据 Schema 声明统一维护，也无法输出结构化的入参错误信息。

#### 代码优化方案：
1. 开启编译器的全部主要严格校验选项（包括 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`）。
2. 引入 `Zod` 开源强类型验证器，在逻辑开始前定义明确的 Schema。
3. 在 MCP 处理分发路由的最外层拦截所有未通过 Zod 校验 of the 异常，向客户端输出精准的出错字段。

##### 优化后 `tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "**/*.test.ts"]
}
```

#### TypeScript 严格模式优化详情

在开启严格编译选项后，现有代码库会触发多处编译报错。以下是受影响的文件以及我们需要采取的具体代码改造建议：

##### 1. 数组/字典索引安全 (`noUncheckedIndexedAccess: true`)

该选项下，通过索引获取元素或对象属性时，返回值的类型会被隐式推导为 `T | undefined`，必须进行存在性防御或类型边界收窄。

- **`src/handlers/resources.ts`**
  * *报错位置*：`parseFrontmatter()` 方法中通过 `content.split('---')[1]` 解析 Frontmatter 文本。
  * *解决方案*：增加边界保护：
    ```typescript
    const frontmatterText = parts[1];
    if (frontmatterText === undefined) return {};
    ```
  * *报错位置*：通过正则匹配 `line.match(/^name:\s*(.*)/)[1]` 提取字段。
  * *解决方案*：校验匹配成功且捕获组定义明确：
    ```typescript
    if (nameMatch && nameMatch[1] !== undefined) {
      result.name = nameMatch[1].trim();
    }
    ```

- **`src/mcp/tools.ts`**
  * *报错位置*：`extractTableNames()` 提取 SQL 的表名时对 `match[1]` 进行操作。
  * *解决方案*：
    ```typescript
    const tableName = match[1];
    if (tableName !== undefined) {
      tables.add(tableName);
    }
    ```
  * *报错位置*：反序列化工具响应时，通过 `resObj.content[0]` 及 `data.content[0]` 直接读取首个文本项。
  * *解决方案*：
    ```typescript
    const contentList = resObj.content as Array<{ text?: string }>;
    const firstContent = contentList[0];
    if (firstContent && firstContent.text !== undefined) {
      // 核心读取逻辑...
    }
    ```
  * *报错位置*：读取 `data.records[recordType]` 时，因 `records` 字段为 Map 字典而导致类型检查不通过。
  * *解决方案*：
    ```typescript
    const recordInfo = data.records[recordType];
    if (!recordInfo) {
      throw new Error(`Metadata for record type ${recordType} is missing`);
    }
    ```

- **`src/handlers/tools.ts`**
  * *报错位置*：在并行获取记录及获取元数据等并发工具分发中，通过 `records[index]` 和 `recordTypes[index]` 获取的元素被推断为 `undefined`。
  * *解决方案*：增加边界保护：
    ```typescript
    const item = records[index];
    if (!item) continue;
    ```
    和：
    ```typescript
    const recordType = recordTypes[index];
    if (!recordType) continue;
    ```

##### 2. 精确可选属性控制 (`exactOptionalPropertyTypes: true`)

该选项下，一个被声明为 `key?: Type` 的可选属性在实例化或赋值时，不允许被显式赋予 `undefined`，要么在对象中**忽略该键**，要么将其类型拓宽为 `Type | undefined`。

- **`src/oauth/manager.ts`**
  * *报错位置*：`getSessionInfo()` 方法返回的 Session 状态诊断对象中：
    ```typescript
    tokenExpiresIn: expiresInMs ? Math.max(0, Math.round(expiresInMs / 1000)) : undefined
    ```
  * *解决方案*：
    * **方式一：拓宽属性的声明类型：**
      ```typescript
      export interface SessionInfo {
        authenticated: boolean;
        tokenExpiresIn?: number | undefined; // 显式允许 undefined 类型
      }
      ```
    * **方式二：在创建对象时动态声明并忽略 undefined 键：**
      ```typescript
      const info: Record<string, any> = {
        authenticated: true,
        refreshSchedulerActive: this.tokenRefreshScheduler.isRunning()
      };
      if (expiresInMs !== undefined) {
        info.tokenExpiresIn = Math.max(0, Math.round(expiresInMs / 1000));
      }
      ```

---

## 🏗️ 生产环境韧性高阶设计模式

为了使该项目能够顺利部署至严苛的生产环境，我们建议采纳以下高阶设计架构：

### 1. 分层缓存信封模式 (Layered Cache Envelope Pattern)
缓存文件应该避免直接存放裸 JSON，而是将真实的 Payload 包装在携带有效元数据的信封中：
```typescript
interface Envelope<T> {
  expiration: number; // 过期的 UTC 毫秒值
  metadata: {
    ttlSeconds: number;
    created: number;
    version: string;
  };
  data: T;
}
```
*收益*：让 L2 缓存文件具备自解释的生存期特征，解决从磁盘晋升至内存时的 TTL 归零及重置缺陷。

### 2. 零信任本地环回绑定模式 (Zero-Trust Loopback Binding Pattern)
在部署或本地调试时开启的任何用于 OAuth 重定向的回调 HTTP 侦听端口，必须显式指明绑定到 `127.0.0.1` 环回口，而不是通配任意 IP。
*收益*：从源头屏蔽本机的临时侦听端口直接向外网或整个局域网暴露带来的风险。

### 3. 凭证的落盘强加密保护 (Cryptographic Token Protection at Rest)
通过调用系统环境变量或派生安全指纹生成对称密钥，在将 Session 文件保存至本地时使用 AES-256-GCM 算法加密，且限制文件权限掩码为 `0o600`。
*收益*：杜绝同服务器下其他未授权操作系统用户窃取 NetSuite 访问凭证的可能性。

### 4. 共享长连接池模式 (Shared Connection Pool Pattern)
确保向 NetSuite REST 发起网络通信的底层 Axios/Got 采用同一个 HTTPS Agent，并统一设定 Keep-Alive 及 Socket 复用参数。
*收益*：省去每次请求都要重新进行 TLS 握手的网络开销，提高工具接口的响应效率。

### 5. 统一入口边界架构 (Automated Schema Boundaries)
利用 Zod 这类工程化的参数声明 Schema 对外层参数进行编译期和运行时的双重约束检测，将格式异常挡在真正的核心业务层之外。
*收益*：免去了具体 Handler 中的各种类型断言和不稳健的冗余检查。

### 6. 守护下的优雅崩溃 (Supervised Graceful Exit Pattern)
对于同步致命错误不应该选择忽略，而是执行安全日志脱敏后，强行执行系统进程关闭。
*收益*：防止出现已泄露资源的死锁“僵尸进程”，方便 PM2 等守护容器重启以恢复正常状态。
