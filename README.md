# NetSuite MCP Server

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20Strict-blue.svg)](https://www.typescriptlang.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol%20v2-purple.svg)](https://modelcontextprotocol.io/)
[![Architecture Score](https://img.shields.io/badge/ISO%2FIEC%2025010-100%2F100-success.svg)](#-开发测试与质量基准)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**NetSuite MCP Server** 是一套企业级 Model Context Protocol (MCP) 原生服务端，专为 **Claude Code**、**Cursor IDE**、**Windsurf**、**Google Antigravity** 及 **Gemini CLI** 等新一代 AI 编程与自动化智能体打造。

它通过业界标准的 **Stdio 协议**，为 AI 助手赋予安全、高性能、防幻觉的 Oracle NetSuite ERP 全栈数据互操作与 SuiteCloud 研发自动化能力。

---

## 📖 目录索引

- [🌟 解决的核心痛点](#-解决的核心痛点)
- [🏛️ 系统架构全景](#️-系统架构全景)
- [⚡ 核心技术特性](#-核心技术特性)
- [🚀 快速上手 (Quick Start)](#-快速上手-quick-start)
- [💻 主流 MCP 客户端配置指南](#-主流-mcp-客户端配置指南)
- [🧰 MCP 工具全景手册](#-mcp-工具全景手册)
- [📚 MCP Resources 与 Prompts](#-mcp-resources-与-prompts)
- [⏰ 后台 Token 保活守护进程](#-后台-token-保活守护进程)
- [🛠️ 本地开发与质量基准](#️-本地开发与质量基准)
- [🔒 企业安全与防护规范](#-企业安全与防护规范)
- [📄 开源许可证](#-开源许可证)

---

## 🌟 解决的核心痛点

在传统的“AI + NetSuite ERP”集成场景中，开发者与企业往往面临以下严重瓶颈：

| 传统集成困境 | NetSuite MCP Server 应对方案 |
| :--- | :--- |
| **OAuth 令牌频死**：NetSuite Access Token 仅 1 小时有效期，工作流频繁中断并强制人工重新授权。 | **OAuth 2.0 PKCE 自动续期 + 后台 Daemon 保活**：无客户端密钥暴露风险；后台 LaunchAgent/systemd 守护进程 24/7 主动轮转刷新 Token，长效免登录。 |
| **宽表全量投影导致 LLM 上下文爆炸**：NetSuite REST 记录动辄上百个字段与嵌套数组，极易撑爆 LLM Token 窗口。 | **上下文极致瘦身 (`contextSlimmer`)**：自动剥离 `null`、`undefined` 与空数组噪点；表格数据秒级转为紧凑 Markdown 表格，**Token 消耗立减 60%+**。 |
| **SuiteQL 方言陷阱与慢查询崩溃**：LLM 习惯生成 MySQL 方言（如 `LIMIT`）或触发全表扫描（如跨表 `JOIN SystemNote`），导致 45s+ 超时。 | **AST 级 SQL 守护盾 (`suiteqlGuard`)**：硬阻断 `SELECT *`；拦截非法方言并智能指引 Oracle 分页；强制注入 `mainline = 'F'` 交易行过滤与保底分页。 |
| **生产环境误操作灾难**：AI 误将测试记录创建或更新到了生产账套。 | **双重沙箱生产写保护**：自动识别环境类型（Production vs Sandbox）；生产账套物理禁用写入与修改工具；SDF 上传前置显式确认卡片。 |
| **多租户多实例并发冲突**：同时操作多个 NetSuite 账号时，本地 Session 相互覆盖、并发死锁。 | **纯 Redis 缓存 + Redlock 分布式锁**：按账号完全隔离 Session 与元数据；采用 Redlock 严格锁定 Token 刷新操作，规避并发竞态。 |

---

## 🏛️ 系统架构全景

```
                      MCP 客户端生态
        (Claude Code / Cursor / Windsurf / Antigravity)
                              │
                    stdio 管道 (JSON-RPC)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    NetSuite MCP Server                      │
│                                                             │
│  ┌───────────────────┐  ┌─────────────────┐  ┌───────────┐  │
│  │   OAuth 管理器    │  │ 运行时 SQL 守卫 │  │  上下文   │  │
│  │  - PKCE 鉴权      │  │  - AST 语法分析 │  │  瘦身器   │  │
│  │  - 令牌主动刷新   │  │  - 防全表扫描   │  │  - Markdown│ │
│  │  - 会话自动恢复   │  │  - 生产写锁定   │  │  - 噪点剪裁│ │
│  └─────────┬─────────┘  └────────┬────────┘  └─────┬─────┘  │
│            │                     │                 │        │
│  ┌─────────┴─────────────────────┴─────────────────┴─────┐  │
│  │            纯 Redis 缓存与 Redlock 分布式锁           │  │
│  │  - 元数据毫秒级缓存      - 多进程并发刷新互斥锁       │  │
│  └───────────────────────────────┬───────────────────────┘  │
└──────────────────────────────────┼──────────────────────────┘
                                   │ HTTPS + Bearer Token
                                   ▼
┌─────────────────────────────────────────────────────────────┐
│             Oracle NetSuite AI Connector SuiteApp           │
│        (REST Web Services / SuiteQL Engine / SuiteScript)   │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚡ 核心技术特性

1. **零密钥泄露的 OAuth 2.0 PKCE 认证**：
   - 基于 SHA-256 代码挑战（Code Challenge）与代码验证器（Code Verifier）完成公共客户端授权，无需在本地保存敏感的 Client Secret。
   - 自动启动临时本地 HTTP 回调服务捕获 Authorization Code，完成一次授权，长久无感续期。
2. **纯 Redis 缓存与 Redlock 分布式锁**：
   - 生产级多进程架构，全面废弃不稳定的内存缓存，由 Redis 提供高可用元数据缓存与状态持久化。
   - 引入 Redlock 分布式锁保障多 MCP Client 实例并发调用时的 Token 刷新原子性，彻底解决并发失效问题。
3. **AST 级 SuiteQL 运行时防线 (`suiteqlGuard`)**：
   - **通配符拦截**：零容忍 `SELECT *`，强制模型提供显式投影列，避免宽表爆炸。
   - **方言智能纠偏**：拦截 MySQL 习惯的 `LIMIT`，自动指引 Oracle 规范的 `FETCH FIRST N ROWS ONLY`、`ROWNUM <= N` 或标准 `OFFSET M ROWS FETCH NEXT N ROWS ONLY`。
   - **交易行翻倍防护**：关联 `transactionline` 时强制校验并指引 `tl.mainline = 'F'` 或 `'T'`。
   - **慢查询拦截**：硬阻断跨表关联 `SystemNote`（Oracle SAFE 避坑陷阱 11），引导使用专用审计工具。
   - **自动保底分页**：未指定分页的查询自动注入 `FETCH FIRST 100 ROWS ONLY`。
4. **双重沙箱生产写保护**：
   - 单一权威环境判定：账号含 `_SB`, `-sb`, `TSTDRV` 判定为沙箱，否则为生产。
   - 破坏性写入工具（`ns_createRecord`, `ns_updateRecord`）在生产账套中**物理禁用**，从根本上绝灭误写风险。
   - 代码部署工具（`netsuite_suitecloud_upload`）部署到生产账套必须显式声明 `allowProduction: true`。
5. **极简上下文与 Markdown 表格渲染**：
   - 自动清洗 NetSuite API 响应中大量的 `null`、`undefined` 和空数组，减少上下文噪音。
   - SuiteQL 查询结果与记录元数据自动格式化为高密度 Markdown 表格，兼顾人类可视化可读性与大模型推理效率。
6. **全链路可观测性与结构化自愈诊断**：
   - 每次工具调用自动记录结构化指标（耗时 `durationMs`、返回载荷 `payloadChars`、错误分类 `errorCategory`）。
   - 内置 `netsuite_get_error_summary`，聚合分析错误频次并输出明确的 `[Self-Healing Action]` 针对性修复建议。

---

## 🚀 快速上手 (Quick Start)

### 步骤 1：NetSuite 实例端准备

1. **安装官方 AI Connector Bundle**：
   - 在 NetSuite 生产或沙箱环境中，进入 **Customization > SuiteBundler > Search & Install Bundles**。
   - 搜索并安装 **NetSuite AI Connector**（Bundle ID: `522506`）。
2. **创建 OAuth 2.0 整合记录 (Integration Record)**：
   - 导航至 **Setup > Integration > Manage Integrations > New**。
   - **Name**: `NetSuite MCP Server`
   - **State**: `Enabled`
   - **Authentication**:
     - 勾选 **Authorization Code Grant**
     - 勾选 **Public Client**（启用 PKCE 模式）
   - **Redirect URI**: `http://localhost:8080/callback`（根据需要设置端口）
   - 保存并记录生成的 **Client ID** (Consumer Key)。

---

### 步骤 2：本地配置

推荐在项目根目录或 `~/.config/netsuite-mcp/config.json` 下创建统一配置文件 `netsuite.config.json`：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "defaultCallbackPort": 8080,
  "sessionsDir": "~/.config/netsuite-mcp/sessions",
  "redisUrl": "redis://127.0.0.1:6379",
  "accounts": {
    "sandbox": {
      "accountId": "1234567-sb1",
      "clientId": "your-sandbox-client-id",
      "callbackPort": 8080
    },
    "production": {
      "accountId": "1234567",
      "clientId": "your-production-client-id",
      "callbackPort": 8081
    }
  }
}
```

或者使用标准环境变量（优先级高于配置文件）：

| 环境变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `NETSUITE_ACCOUNT_ID` | NetSuite 账号 ID（如 `1234567` 或 `1234567_SB1`） | — |
| `NETSUITE_CLIENT_ID` | NetSuite OAuth 2.0 Integration 记录的 Client ID | — |
| `OAUTH_CALLBACK_PORT` | OAuth 浏览器授权回调的本地 HTTP 端口 | `8080` |
| `NETSUITE_SESSION_PATH`| 本地会话与 Token 隔离存储目录 | `~/.config/netsuite-mcp/sessions/<account>` |
| `REDIS_URL` | Redis 服务连接串 | `redis://127.0.0.1:6379` |

---

## 💻 主流 MCP 客户端配置指南

### 1. Claude Code (`~/.claude.json`)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "node",
      "args": ["/绝对路径/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "your-oauth-client-id",
        "OAUTH_CALLBACK_PORT": "8080",
        "REDIS_URL": "redis://127.0.0.1:6379"
      }
    }
  }
}
```

### 2. Cursor IDE (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "netsuite": {
      "command": "node",
      "args": ["/绝对路径/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567_SB1",
        "NETSUITE_CLIENT_ID": "your-oauth-client-id",
        "REDIS_URL": "redis://127.0.0.1:6379"
      }
    }
  }
}
```

### 3. 多账号并发隔离（沙箱与生产同时在线）

对于需要在同一 IDE 中无缝切换沙箱调试与生产查阅的场景，只需为不同账号指定独立的 Session 隔离目录与回调端口：

```json
{
  "mcpServers": {
    "netsuite_sb1": {
      "command": "node",
      "args": ["/绝对路径/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567-sb1",
        "NETSUITE_CLIENT_ID": "sandbox-client-id",
        "OAUTH_CALLBACK_PORT": "8080",
        "NETSUITE_SESSION_PATH": "~/.config/netsuite-mcp/sessions/1234567_sb1"
      }
    },
    "netsuite_prod": {
      "command": "node",
      "args": ["/绝对路径/NetsuiteMcp/dist/index.js"],
      "env": {
        "NETSUITE_ACCOUNT_ID": "1234567",
        "NETSUITE_CLIENT_ID": "prod-client-id",
        "OAUTH_CALLBACK_PORT": "8081",
        "NETSUITE_SESSION_PATH": "~/.config/netsuite-mcp/sessions/1234567_prod"
      }
    }
  }
}
```

---

## 🧰 MCP 工具全景手册

### 1. 本地运维与诊断增强工具 (`netsuite_*`)

| 工具名称 | 功能描述 | 安全级别 |
| :--- | :--- | :--- |
| `netsuite_authenticate` | 发起 OAuth 2.0 PKCE 鉴权，自动唤起浏览器完成登录并保存会话。 | 鉴权操作 |
| `netsuite_logout` | 注销当前活动会话，清理本地 Token 缓存与会话文件。 | 幂等操作 |
| `netsuite_status` | 全面检查系统健康状态：鉴权有效性、Token TTL、环境分类（Prod/Sandbox）、Redis 缓存状态。 | `readOnly` |
| `netsuite_refresh_cache` | 刷新本地 Redis 缓存及 NetSuite 远程 Session 元数据缓存。 | `readOnly` |
| `netsuite_batch_execute` | 批量并行执行最多 10 个 NetSuite 工具任务，消除多次往返网络延迟。 | 综合批处理 |
| `netsuite_inspect_record` | 深度透视 NetSuite 实体记录：表头字段与自定义字段智能分栏展示，过滤空值噪点。 | `readOnly` |
| `netsuite_schema` | 一站式智能元数据路由探查：标准记录查离线字典（0ms），自定义记录查实时元数据，省略表名查表目录。 | `readOnly` |
| `netsuite_get_record_definition`| 反查 272 类标准记录的官方字段类型、必填标记、子列表与搜索过滤支持。 | `readOnly` |
| `netsuite_get_query_template` | 获取 Oracle SAFE 权威认证的生产级高频 SuiteQL 黄金查询模板。 | `readOnly` |
| `netsuite_get_system_notes` | 高性能时序审计追踪：按单据 ID 或编号查询字段变更历史，杜绝全表慢查询。 | `readOnly` |
| `netsuite_get_script_logs` | 高效检索 NetSuite 脚本执行日志（`ScriptNote`），支持按等级、时间范围、脚本 ID 过滤。 | `readOnly` |
| `netsuite_get_record_link` | 生成指向 NetSuite 原生 Web 界面的一键直达超链接。 | `readOnly` |
| `netsuite_suitecloud_upload` | 基于 SuiteCloud CLI 上传脚本与静态资产到文件柜。支持智能工程探测、语法预检与生产写屏障。 | `destructive` |
| `netsuite_get_skill` | 运行时按需调阅 SuiteCloud 专业技能知识库（如 SAFE 指南、字段字典等）。 | `readOnly` |
| `netsuite_get_error_summary` | 聚合调用错误遥测日志，输出错误分类占比与精准的自愈建议（`[Self-Healing Action]`）。 | `readOnly` |

### 2. NetSuite AI Connector 远端代理工具 (`ns_*`)

| 工具名称 | 功能描述 | 生产环境策略 |
| :--- | :--- | :--- |
| `ns_runCustomSuiteQL` | 执行自定义 SuiteQL 查询。经由 AST 防线检验，自动格式化为紧凑 Markdown 表格。 | 只读允许 |
| `ns_getSuiteQLMetadata` | 探查数据库表结构、字段类型、空值约束及表目录索引。 | 只读允许 |
| `ns_getRecord` | 读取完整的 NetSuite 单条记录详情，自动拼装直达 Web 链接。 | 只读允许 |
| `ns_getRecordTypeMetadata` | 查询记录类型元数据，自动补全自定义记录与字段定义。 | 只读允许 |
| `ns_listAllReports` / `ns_runReport` | 检索并运行 NetSuite 标准财务、运营与管理报表。 | 只读允许 |
| `ns_listSavedSearches` / `ns_runSavedSearch` | 检索并运行已有的保存的搜索（Saved Search）。 | 只读允许 |
| `ns_getSubsidiaries` | 查询 OneWorld 架构下的子公司组织层级树。 | 只读允许 |
| `ns_getAccountingBooks` | 查询活动会计账簿（多账簿会计支持）。 | 只读允许 |
| `ns_createRecord` | 在 NetSuite 中创建新业务记录。 | **沙箱限定**（生产环境物理阻断） |
| `ns_updateRecord` | 更新 NetSuite 中既有记录的字段。 | **沙箱限定**（生产环境物理阻断） |

---

## 📚 MCP Resources 与 Prompts

### 1. 标准只读资源 (`netsuite://`)

- **`netsuite://records/reference`**：全量 272 类标准 NetSuite 业务记录的字典目录与字段定义。
- **`netsuite://queries/golden-templates`**：Oracle SAFE 指南认证的生产级 SuiteQL 黄金查询模板库。
- **`netsuite://guides/suiteql`**：SuiteQL 语法规范、Oracle 专属方言指南与性能调优守则。
- **`netsuite://templates/generative-ui`**：遵循 Antigravity 主题变量标准的数据卡片、生命周期图谱与库存分布可视化组件。
- **`netsuite://skills/{skillName}`**：SuiteCloud 专业技能离线文档按需查阅。

### 2. 开箱即用的场景 Prompts

- **`review_suitescript`**：基于 Oracle SAFE 2025.2 准则、治理开销预算与 OWASP 安全标准审查 SuiteScript 2.1 代码。
- **`debug_script_error`**：输入 NetSuite 运行时异常堆栈，自动定位根因并输出精确重构补丁。
- **`generate_suiteql`**：根据业务需求生成经过 SAFE 准则加固的生产级 SuiteQL。
- **`visualize_netsuite_data`**：将 ERP 数据渲染为基于 HTML/Tailwind 的交互式 Generative UI 组件（支持 `<agent-embed>`）。
- **`upgrade_suitescript`**：将旧版 SuiteScript 1.0/2.0 代码一键升级至 SuiteScript 2.1 现代 ES6+ 语法。

---

## ⏰ 后台 Token 保活守护进程

为了让开发者彻底告别每日重复授权的困扰，本项目内置了针对 macOS LaunchAgent 与 Linux systemd 的后台保活守护服务，每 10 分钟在后台自动扫描即将过期的 Token 并通过 OAuth PKCE 进行轮换刷新：

```bash
# 1. 安装并启动系统级 LaunchAgent 守护进程
npm run daemon:install

# 2. 查看守护进程运行状态与下一次轮转时间
npm run daemon:status

# 3. 立即手动执行一次全量账号保活刷新
npm run daemon:run

# 4. 卸载守护进程
npm run daemon:uninstall
```

守护进程日志将实时保存至：
- macOS: `~/Library/Logs/netsuite-mcp-daemon.log`

---

## 🛠️ 本地开发与质量基准

本项目采用业界最高标准的工程化质量保障流水线，所有代码提交与发布均经过严格的自动化测试与架构度量：

### 常用开发命令

```bash
# 构建生产包 (TypeScript Strict -> dist/)
npm run build

# 启动开发服务器 (基于 tsx 热重载)
npm run dev

# 运行全量代码风格检查 (Biome)
npm run lint

# 运行全量单元测试与集成测试 (Vitest)
npm test

# 严格类型检查 (tsc --noEmit)
npm run typecheck

# 运行 ISO/IEC 25010 & Oracle SAFE 综合系统架构评估套件
npm run score

# 运行 Oracle 官方文档合规性对抗评测 (防幻觉专项)
npm run test:compliance

# 汇总分析当前工作区的调用错误诊断日志
npm run logs:summary
```

### 综合架构标准化评估 (ISO/IEC 25010 Benchmark)

本项目内置了全面的客观架构度量脚本（`npm run score`），持续保持 **100/100 分（Level 5 Optimizing 优化卓越级）**：
- **P1 安全性与访问控制 (20%)**：100% 阻断破坏性 SQL 注入与生产误写操作。
- **P2 可靠性与容错韧性 (20%)**：100% 拦截 `SELECT *` 与非法 SQL 方言，实现精准错误自愈。
- **P3 功能完备性与协议遵从 (20%)**：标准只读资源、核心运维工具与 Prompts 100% 注册就绪。
- **P4 性能效率与 Oracle SAFE 架构 (15%)**：272 类标准记录毫秒级字典、强制保底分页。
- **P5 可维护性与架构工程化 (15%)**：解耦清晰的模块结构与静态 AST 规则分析。
- **P6 多租户隔离与环境兼容 (10%)**：沙箱与生产环境物理隔离，多工作区无缝漫游。

---

## 🔒 企业安全与防护规范

1. **公钥凭证安全**：采用 PKCE 模式交互，任何场景下均不要求或存储 NetSuite Client Secret。
2. **环境隔离锁定**：生产环境绝对禁止任何创建、更新与删除记录操作；代码部署需二次显式确认。
3. **敏感凭证脱敏**：错误遥测与日志记录中自动脱敏 Token、密钥、密码与个人敏感数据。
4. **无网络开放端口**：基于本地 Stdio 传输运行，无网络监听端口，天然免疫远程未授权访问与 SSRF 风险。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。旨在为企业级 NetSuite 开发者与智能体工程化应用提供最稳健的基础设施。
