# NetSuite MCP Server — AI 编程助手权威行动指南与代码生成规约 (AGENTS.md)

> 🤖 **角色与定位**：本文档为大语言模型编程智能体（AI Coding Agents，如 Claude Code、Cursor、Windsurf、Antigravity）开发、维护与重构 **NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`) 的权威工程指南与代码生成规约。
>
> 🎯 **核心目标**：指导 AI Agent 在本仓库中编写高质量、高韧性的 Node.js / TypeScript 服务端代码，高效扩展与维护 MCP 工具集、运行时安全守卫（`suiteqlGuard`）、Redis 缓存与 Redlock 分布式锁，并持续保障 100/100 分的系统架构质量。

---

## 🏛️ 1. 标杆项目矩阵 (Benchmark Reference Matrix)

在设计、编写与重构本 MCP 服务端的工具集、类型系统、运行时防护及可观测性架构时，AI Agent 必须严格对标以下 8 大业界顶级 MCP 标杆项目的最佳实践：

| **#** | **项目** | **GitHub URL** | **星标** | **参照价值与本仓库落地对齐** |
| :---: | :--- | :--- | :---: | :--- |
| ① | **MCP Official Servers** | `github.com/modelcontextprotocol/servers` | ~90k★ | **工具设计的“黄金标准”**：工具命名动名词规范（如 `netsuite_get_record`）、精准的 description 描述（明确输入与输出预期）、严格的 Zod inputSchema 范式、标准错误返回格式（`textResult({ isError: true })`）。参考实现：`filesystem`、`git`、`memory`。 |
| ② | **MCP TypeScript SDK** | `github.com/modelcontextprotocol/typescript-sdk` | ~13k★ | **SDK 层工程最佳实践**：Stdio Transport 抽象生命周期、Zod schema 与 TypeScript 静态类型推导（`z.infer<typeof Schema>`）、无锁且高效的 JSON-RPC 协议封装。 |
| ③ | **GitHub MCP Server** | `github.com/github/github-mcp-server` | ~17k★ | **企业级大型工具集治理**：分域管理策略（Auth, Query, Record, Deployment, Diagnostics）、8 大权威工具正交设计（Zero-Bloat，物理剔除过时别名）、生产/沙箱权限分级契约。 |
| ④ | **Supabase MCP** | `github.com/supabase/mcp` | — | **数据库/ERP 集成范本**：Feature Group 分组、环境写安全保护（生产环境物理阻断写操作）、统一数据透视与实体字典反查。 |
| ⑤ | **Sentry MCP** | `github.com/getsentry/sentry-mcp` | — | **全链路可观测性标杆**：每次 Tool 调用的自动化指标采集（耗时 `durationMs`、有效负载 `payloadChars`、错误分类 `errorCategory`）、脱敏日志追踪、基于频次分析的自愈诊断（`netsuite_status`）。 |
| ⑥ | **Playwright MCP** | `github.com/microsoft/playwright-mcp` | — | **复杂工具集 UX 设计**：Description 采用“前 5 词动词 + 资源”精准写法，避免大模型幻觉与误触发；按需曝光工具，杜绝交互死锁。 |
| ⑦ | **Context7 MCP** | `github.com/upstash/context7-mcp` | — | **Context 经济性极致优化**：极简响应载荷、噪点裁剪（`contextSlimmer` 自动剥离 `null`/`undefined`）、自动格式化为高密度 Markdown 表格，降低 50%+ LLM Token 消耗。 |
| ⑧ | **ERPNext MCP Server** | `github.com/rakeshgangwar/erpnext-mcp-server` | — | **同类 ERP 业务抽象范式**：针对 ERP 复杂实体模型的元数据反查（`netsuite_get_metadata`）、自然键（tranid）与内部键（id）自动解析、Web UI 直达链接生成。 |

### 1.1 动态标杆检索与前沿对标机制 (Dynamic Benchmark Research)

虽然上述 8 大标杆矩阵覆盖了 MCP 核心架构范式，但在面临复杂垂直领域、新型协议扩展或特定技术深水区时，静态清单可能无法涵盖全部具体需求：

- **主动前沿对标原则 (Proactive Benchmark Research)**：
  - 当既有标杆矩阵无法直接指导当前具体任务（如：复杂 SQL AST 语法校验、海量文件分块传输、Node.js 优雅退出与信号治理等）时，AI Agent **严禁闭门造车或凭空臆想**。
  - **必须主动利用联网搜索（Web Search）与 GitHub 检索**，查阅业内同类最著名的顶级开源项目（高星 MCP Server、知名 ERP/数据库中间件、主流 TypeScript 架构）的成熟方案。
  - 深入研究业界事实标准（Industry De Facto Standard）的设计思路、数据模型与容错机制，将其精髓吸收并转化为本服务端的单一权威实现。
- **推荐动态对标维度**：
  1. **顶级 MCP 生态演进**：检索 `modelcontextprotocol` 官方组织及知名厂商（如 Cloudflare, Docker, PostgreSQL, Redis 等）官方 MCP 实现，跟踪 Transport 生命周期管理、动态能力协商与长连接容灾。
  2. **高可用数据网关与 AST 防线**：对标成熟数据库中间件与 ORM（如 Prisma Engine, Hasura, Apache Calcite, Cube.js）的 SQL 语法守卫、防注入与慢查询熔断实践。
  3. **TypeScript 严格工程与运行时安全**：对标一流 Node.js/TypeScript 基础库（如 Fastify, tRPC, Zod, BullMQ），参考其类型安全收窄、分布式任务治理与零开销可观测性模式。

---

## 🧼 2. 代码工艺与反兼容膨胀禁令 (Anti-Compatibility Bloat)

AI Agent 在编写、审查或重构本 MCP 服务端代码（TypeScript、JavaScript、SQL Guard）时，必须严格贯彻**单一权威实现（Single Authoritative Implementation）**原则：

1. **彻底干净替换，严禁双轨并行**：
   - ❌ **严禁**：因新旧方案兼容而写 `try { newWay(); } catch (e) { oldWay(); }`。
   - ❌ **严禁**：添加分支嗅探 `if (supportsNewWay) { ... } else { ... }` 维系旧缺陷代码。
   - ❌ **严禁**：因元数据定义不确定而链式回退（如 `val = newProp ?? oldProp ?? fallback`）。
   - ✅ **强制要求**：查证唯一权威标准，执行 **100% 彻底干净的替换**。
2. **立即物理删除死代码**：
   - 废弃的实现、过时的方法、无效的参数必须**立即从源码中物理删除**。
   - 严禁将死代码以注释形式留存，杜绝任何“以防万一”的防御性代码膨胀。
3. **直面报错根因，严禁消极掩盖**：
   - 报错意味着类型缺陷、字段不匹配或假设错误。必须精准定位根因并从源头彻底修复，严禁使用盲目的 try-catch 吞没异常。
4. **仅描述当前最新状态（零版本演进叙事）**：
   - ❌ **严禁**：在代码注释、回复或文档中叙述历史变迁流水账（如“以前版本是 X，现在重构成 Y”，“相比之前我们优化了 Z”）。
   - ✅ **强制要求**：**仅描述当前最新代码的确定性状态与逻辑**。将当前代码库视为唯一的独立权威基准，直接阐述其最新架构与业务逻辑。

---

## 🛠️ 3. 本仓库 TypeScript MCP 服务端开发规约

### 3.1 架构分层与职责边界

```
src/
├── index.ts                # 服务端入口：CLI 参数解析、Stdio 传输初始化
├── mcp/                    # NetSuite 底层业务通讯层
│   └── tools.ts            # NetSuiteMCPTools：封装 SuiteQL、REST WS、HTTP 边界
├── handlers/               # MCP 协议调度层
│   ├── tools.ts            # 8 大权威工具注册表（LOCAL_TOOLS）与请求总分发器
│   ├── toolSchemas.ts      # 所有权威工具的 Zod 参数模式与类型推导
│   ├── recordHandlers.ts   # 记录透视、自然键解析、元数据字典与系统审计
│   ├── queryHandlers.ts    # 实时脚本执行日志与排错跟踪
│   ├── authHandlers.ts     # OAuth 鉴权状态、注销、诊断看板
│   ├── deployHandlers.ts   # SuiteCloud 部署上传与生产写屏障
│   ├── prompts.ts          # MCP Prompts 提示词模板
│   └── resources.ts        # MCP 只读资源注册与检索
├── oauth/                  # OAuth 2.0 PKCE 鉴权子系统（Token 轮换、会话隔离）
├── cache/                  # Redis 缓存与 Redlock 分布式锁
├── telemetry/              # 结构化调用遥测与错误自愈诊断器
└── utils/                  # 运行时防线：suiteqlGuard、环境隔离、上下文瘦身
```

### 3.2 语言标准与类型安全

- **运行环境**：Node.js ≥ 18，TypeScript 严格模式（`strict: true`）。
- **ESM 模块规范**：所有模块内部导入必须显式包含 `.js` 扩展名（如 `import { foo } from "./bar.js"`）。
- **禁止 `any`**：严禁在源码或测试中使用 `any` 类型。未知数据使用 `unknown`，并通过 Zod Schema 或自定义 Type Guards 进行安全收窄。

### 3.3 新增与重构 MCP 工具标准范式 (Standard Recipe)

任何在 NetSuite MCP Server 中新增或修改工具，必须严格遵循以下 4 步标准闭环：

#### 步骤 1：在 `src/handlers/toolSchemas.ts` 中定义 Zod Schema
```typescript
export const GetRecordArgsSchema = z.object({
  recordType: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "recordType is required")
    .describe("NetSuite record type ID (e.g. salesorder, customer, customrecord_xxx)."),
  id: z
    .string()
    .trim()
    .min(1, "id is required")
    .describe("Internal ID or document number (tranid) of the record."),
  includeSublists: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include line item sublists summary."),
  format: z
    .enum(["markdown", "compact_json"])
    .optional()
    .default("markdown")
    .describe("Output format."),
});
export type GetRecordArgs = z.infer<typeof GetRecordArgsSchema>;
```

#### 步骤 2：在 `src/handlers/tools.ts` 中注册 Tool 元数据
遵循 Playwright MCP 动名词规范与“前 5 词动词 + 资源”精准 description 规则：
```typescript
{
  name: "netsuite_get_record",
  description: "Get and inspect NetSuite records by internal ID or document number (tranid). Automatically resolves natural keys, purges empty noise, formats markdown table, and provides Web UI direct links.",
  inputSchema: zodToJsonSchema(GetRecordArgsSchema),
}
```

#### 步骤 3：编写独立 Handler 业务逻辑
- 参数归一化（去除首尾空格、小写化）
- 结构化捕获异常，记录调用遥测指标
- 结果经由 `contextSlimmer` 自动剔除 `null`/`undefined` 并格式化为 Markdown 表格
- 统一通过 `textResult()` 返回标准 MCP 结果

```typescript
export async function handleGetRecord(
  args: Record<string, unknown>,
  mcpTools: NetSuiteMCPTools,
  oauthManager: OAuthManager,
  resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<CallToolResult> {
  // 1. Zod 解析与校验
  // 2. 自然键（tranid）自动解析为 internal ID
  // 3. 调用底层 API 获取记录
  // 4. 清洗 null/undefined 噪声并格式化
  // 5. 附带 NetSuite Web UI 直达链接
}
```

#### 步骤 4：编写 Vitest 单元测试
在对应的 `*.test.ts` 中覆盖正常流程、参数边界及异常场景（如网络超时、无权限、账号类型阻断），并 Mock 外部网络与 Redis 依赖。

### 3.4 纯 Redis 缓存与 Redlock 分布式锁规范

- 本服务全面使用纯 Redis（`ioredis`）提供缓存能力，废弃不稳定内存缓存。
- 账号元数据与会话状态由 Redis 按账号 key 隔离（`ns:<accountId>:*`）。
- 多实例并发刷新 Token 时，必须通过 Redlock (`src/cache/redisLock.ts`) 获取分布式锁，严禁在未加锁状态下执行破坏性 Session 重写。

---

## 🛡️ 4. NetSuite 网关与安全防护层开发规约

AI Agent 在维护或扩展本服务端与 NetSuite 的交互层（`src/utils/suiteqlGuard.ts`、`src/utils/environment.ts`、`src/mcp/tools.ts`）时，必须严格遵守以下守卫契约：

### 4.1 SuiteQL 运行时守卫防御契约 (`src/utils/suiteqlGuard.ts`)

所有通过本服务端执行的 SuiteQL 查询，必须通过运行时 AST 语法树与正则双重静态检验：

1. **零底层隐式改写 (Zero Implicit Dialect Rewriting)**：严禁在底层悄悄自动改写方言或偷加条件。必须在工具 Description 中前置硬编码 7 大官方语法铁律，并在 AI 编写非法方言（如裸 `LIMIT`、裸 `OFFSET`）时硬拦截抛错，引导 AI 严格遵循 Oracle NetSuite 官方标准语法。
2. **通配符投影硬拦截**：严禁放行 `SELECT *`，防止宽表全字段投影撑爆大模型 Token 上下文。
3. **强制 `mainline` 过滤检验**：涉及 `transactionline` 表关联时，必须校验并约束包含 `tl.mainline = 'F'` 或 `'T'`，杜绝行数与金额翻倍畸高。
4. **强制自动保底分页**：单次查询若未显式包含分页约束，守卫盾安全注入保底限制（`FETCH FIRST 100 ROWS ONLY`）。
5. **慢查询硬拦截 (SAFE Pitfall 11)**：严禁放行跨表关联 `JOIN systemnote`（亿级审计日志全表扫描必引发 45s+ 超时崩溃），引导调用专用审计工具 `netsuite_get_system_notes`。
6. **核心模式不变量校验**：
   - 纠偏 `item.recordtype` ➔ 引导使用 `itemtype` 与 `subtype`。
   - 纠偏 `transaction.createdfrom` ➔ 引导使用 `transactionline.createdfrom`。

### 4.2 双重沙箱生产写保护屏障 (`src/utils/environment.ts`)

- **环境类型权威判定**：以 `isSandboxAccount(accountId)` 为唯一判定标准（含 `_sb`, `-sb`, `tstdrv` 为沙箱，其余均为生产）。
- **脚本部署二次确认**：`netsuite_deploy_script` 针对生产环境必须强制要求传入 `allowProduction: true` 显式确认，否则坚决阻断。

---

## 🚦 5. 质量门禁与交付验证流水线

任何代码变更完成后，AI Agent 必须依次执行以下自动化验证命令，确保维持卓越评级：

```bash
# 1. 严格 TypeScript 编译与类型检查
npm run typecheck

# 2. Biome 代码风格与静态分析 (0 错误 0 告警)
npm run lint

# 3. Vitest 单元与集成测试 (100% 通过)
npm test

# 4. ISO/IEC 25010 & Oracle SAFE 综合系统架构客观基准评分 (真实物理测度 95+ 分)
npm run score

# 5. Oracle NetSuite 官方权威文档合规性对抗评测 (100% 官方合规)
npm run test:compliance
```

---

## 🔄 6. 结构化错误诊断与自愈 SOP

当 MCP 工具返回错误时，AI Agent 必须识别结构化诊断标签并执行针对性自愈修复，严禁未经调整的盲目重试：

| 诊断标签 / 错误特征 | 根因分类 | 强制自愈动作 (Mandated Self-Healing Action) |
| :--- | :--- | :--- |
| `[Self-Healing Action]: Call netsuite_get_metadata` | 字段或表名不存在 | 立即调用 `netsuite_get_metadata` 反查合法列名，修正 SQL 后重新执行。 |
| `[suiteqlGuard] Missing 'mainline' filter` | 交易行缺少标志位 | 在 WHERE 条件中补充 `tl.mainline = 'F'` 或 `'T'`。 |
| `[suiteqlGuard] Use FETCH FIRST N ROWS ONLY` | 使用了非法方言（LIMIT） | 改用 `FETCH FIRST 100 ROWS ONLY` 或 `ROWNUM <= 100`。 |
| `PERMISSION DENIED — HARD STOP` | 权限不足 (403) | **立即硬停止！** 严禁伪造数据，直接向用户报告缺失的角色权限代码。 |
| `[Production Safety Violation]` | 生产环境写拦截 | 停止操作，明确告知用户变更操作仅允许在沙箱（Sandbox）执行或需显式生产授权。 |
| `NETWORK_OR_TIMEOUT` | 网络瞬时抖动或网关超时 | **不要修改 SQL**，在控制重试次数（≤2次）的前提下进行指数退避重试或缩减分页大小。 |

---

## 💬 7. 交互与沟通规范

1. **语言风格**：
   - 交互解释、分析摘要与排错建议必须使用**自然流利的简体中文**。
   - 所有代码标识符、TypeScript 类型、SQL 关键字、表名字段名必须保持**纯正标准英文**。
2. **专注当前状态**：
   - 永远只解释最新代码的设计与运行逻辑，彻底禁止引入历史版本迭代叙事。
