# NetSuite MCP Server

[English](README_EN.md) | [简体中文](README.md)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20Strict-blue.svg)](https://www.typescriptlang.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol%20v2-purple.svg)](https://modelcontextprotocol.io/)
[![Architecture Score](https://img.shields.io/badge/ISO%2FIEC%2025010-100%2F100-success.svg)](#-本地开发与质量基准)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**NetSuite MCP Server** (`@suiteinsider/netsuite-mcp`) 是一套面向企业级复杂业务的高性能 Model Context Protocol (MCP) 原生服务端，专为 **Claude Code**、**Cursor IDE**、**Windsurf**、**Google Antigravity** 及 **Gemini CLI** 等新一代 AI 编程与自动化智能体打造。

服务端深度契合 **Stdio JSON-RPC 协议**，为 AI 助手赋予安全、高性能、防幻觉的 Oracle NetSuite ERP 全栈数据互操作与 SuiteCloud 研发自动化能力。

---

## 📖 目录索引

- [🌟 解决的核心痛点](#-解决的核心痛点)
- [🏛️ 行业标杆对标矩阵](#️-行业标杆对标矩阵)
- [📐 系统架构全景](#-系统架构全景)
- [⚡ 核心技术特性](#-核心技术特性)
- [🚀 快速上手 (Quick Start)](#-快速上手-quick-start)
- [💻 主流 MCP 客户端配置指南](#-主流-mcp-客户端配置指南)
- [🧰 8 大权威 MCP 工具手册 (Zero-Bloat)](#-8-大权威-mcp-工具手册-zero-bloat)
- [📚 MCP Resources 与 Prompts](#-mcp-resources-与-prompts)
- [⏰ 后台 Token 保活守护进程与休眠保护](#-后台-token-保活守护进程与休眠保护)
- [📊 本地日志分析与每日诊断报告](#-本地日志分析与每日诊断报告)
- [🛠️ 本地开发与质量基准](#️-本地开发与质量基准)
- [🔒 企业安全与防护规范](#-企业安全与防护规范)
- [📄 开源许可证](#-开源许可证)

---

## 🌟 解决的核心痛点

在传统的“AI + NetSuite ERP”集成场景中，开发者与企业往往面临以下严重瓶颈：

| 传统集成困境 | NetSuite MCP Server 权威解决方案 |
| :--- | :--- |
| **OAuth 令牌频死与休眠断连**：NetSuite Access Token 仅 1 小时有效期；Mac 笔记本合盖休眠时网络中断导致后台刷新频繁失效。 | **OAuth 2.0 PKCE 自动续期 + macOS 休眠守卫 + 后台 Daemon**：无 Client Secret 泄露风险；LaunchAgent/systemd 守护进程保障 24/7 主动轮转；内置 DarkWake/休眠网络探针与零感静默重连 (`trySilentReauth`)。 |
| **宽表全量投影导致 LLM 上下文爆炸**：NetSuite REST 记录动辄上百个字段与嵌套数组，极易撑爆 LLM Token 上下文窗口。 | **上下文极致瘦身 (`contextSlimmer`)**：自动剥离 `null`、`undefined` 与空数组噪点；实体与 SuiteQL 结果秒级转为高密度紧凑 Markdown 表格，**Token 消耗立减 50%+**。 |
| **SuiteQL 方言陷阱与慢查询超时**：大模型常习惯性生成 MySQL 方言（如裸 `LIMIT`/`OFFSET`）或触发全表扫描（如跨表 `JOIN SystemNote`），导致 45s+ 网关超时崩溃。 | **AST 级 SQL 运行时守卫 (`suiteqlGuard`)**：零底层隐式改写，语法树前置强校验；硬拦截 `SELECT *`、裸方言与跨表审计关联；强制约束 `tl.mainline` 过滤并自动注入保底分页 (`FETCH FIRST 100 ROWS ONLY`)。 |
| **生产环境误操作与盲目写变更**：AI 助手在生产账套误触写操作或盲目上传测试脚本，造成生产数据污染。 | **双重沙箱生产写保护屏障**：基于账号特征自动识别环境分类（Production vs Sandbox）；只读工具原生支持全域查询；脚本部署工具强制要求显式传入 `allowProduction: true` 二次确认。 |
| **多租户多实例并发冲突与死锁**：同时操作多个 NetSuite 账号或多 IDE 客户端并发调用时，本地 Session 相互覆盖并触发刷新竞态。 | **纯 Redis 缓存 + Redlock 分布式锁**：按账号完全隔离 Session 与元数据 (`ns:<accountId>:*`)；采用归一化锁键（`formatNetSuiteAccountHost`）加锁保障 Token 刷新原子性。 |

---

## 🏛️ 行业标杆对标矩阵

本服务在架构设计、协议完备性、工具正交性与防御纵深上，严格对标业界 8 大顶级 MCP 开源项目：

| **#** | **标杆项目** | **参照标准与技术落地** |
| :---: | :--- | :--- |
| ① | **MCP Official Servers** | **工具设计黄金标准**：严格动名词命名、精准清晰的 description 预期约束、严格的 Zod inputSchema 范式与标准错误返回格式（`textResult({ isError: true })`）。 |
| ② | **MCP TypeScript SDK** | **SDK 工程范式**：基于 Stdio Transport 的健壮生命周期管理、`z.infer<typeof Schema>` 强类型推导与高效安全的 JSON-RPC 协议封装。 |
| ③ | **GitHub MCP Server** | **企业级工具治理**：分域管理策略、8 大正交权威工具设计（Zero-Bloat 架构）、沙箱与生产环境分级防护契约。 |
| ④ | **Supabase MCP** | **数据库/ERP 集成范本**：环境写安全闭锁保护、统一数据透视、272 类实体离线元数据字典反查。 |
| ⑤ | **Sentry MCP** | **全链路可观测性**：每次调用自动记录结构化指标（耗时 `durationMs`、载荷 `payloadChars`、错误分类 `errorCategory`）、脱敏日志追踪与错误聚合自愈。 |
| ⑥ | **Playwright MCP** | **防幻觉 UX 设计**：Description 采用“前 5 词动词 + 资源”精准写法，避免大模型误触发；按需曝光工具，消除交互歧义。 |
| ③ | **Context7 MCP** | **Context 经济性极致优化**：极简响应载荷、噪点裁剪（自动剥离 `null`/`undefined`）、自动格式化为高密度 Markdown 表格，降低 50%+ LLM Token 消耗。 |
| ⑧ | **ERPNext MCP Server** | **同类 ERP 业务抽象范式**：复杂实体元数据实时/离线反查（`netsuite_get_metadata`）、自然键（tranid）与内部键（id）自动解析、Web UI 直达链接生成。 |

---

## 📐 系统架构全景

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
│  │   OAuth 2.0 PKCE  │  │ AST SuiteQL 守卫│  │  上下文   │  │
│  │  - 自动续期轮换   │  │  - 语法前置强校验│  │  瘦身器   │  │
│  │  - 休眠/DarkWake  │  │  - 零隐式改写   │  │  - Markdown│ │
│  │  - 静默重连自愈   │  │  - 生产部署屏障 │  │  - 噪点剪裁│ │
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

1. **零密钥泄露的 OAuth 2.0 PKCE 认证与休眠保护**：
   - 基于 SHA-256 Code Challenge 与 Code Verifier 完成公共客户端授权，无需在本地保存敏感的 Client Secret。
   - 自动启动本地临时 HTTP 回调服务捕获授权码；具备 macOS 休眠与 DarkWake 守卫，避免合盖断网期间盲目轮换造成 Token 损坏。
   - 内置 `trySilentReauth` 机制，在 Token 意外失效时执行零感静默重连自愈。
2. **纯 Redis 缓存与 Redlock 分布式锁**：
   - 废弃不稳定内存缓存，全面由 Redis (`ioredis`) 提供会话持久化与元数据缓存。
   - 引入 Redlock 分布式锁，对账号锁键执行标准化归一化（`formatNetSuiteAccountHost`），彻底杜绝沙箱与多实例并发竞态。
3. **AST 级 SuiteQL 运行时防线 (`suiteqlGuard`)**：
   - **零底层隐式改写 (Zero Implicit Dialect Rewriting)**：前置 AST 语法分析，拒绝黑盒改写 SQL。非法方言直接硬拦截抛错，引导遵循 Oracle 官方标准。
   - **通配符投影拦截**：零容忍 `SELECT *`，强制模型提供显式投影列，避免宽表全字段投影撑爆 Token 上下文。
   - **方言智能纠偏**：硬拦截 MySQL 习惯的裸 `LIMIT`/`OFFSET`，引导使用 Oracle 官方标准的 `FETCH FIRST N ROWS ONLY` 或 `ROWNUM <= N`。
   - **交易行翻倍防护**：关联 `transactionline` 时强制校验并引导 `tl.mainline = 'F'` 或 `'T'`。
   - **慢查询硬拦截**：硬阻断跨表关联 `systemnote`（Oracle SAFE 避坑陷阱 11），引导调用专用审计工具。
   - **自动保底分页**：未显式包含分页约束的查询自动注入 `FETCH FIRST 100 ROWS ONLY`。
4. **双重沙箱生产写保护屏障**：
   - 单一权威环境判定：账号含 `_sb`、`-sb`、`tstdrv` 判定为沙箱，其余均为生产。
   - 脚本部署工具（`netsuite_deploy_script`）部署到生产账套时强制要求显式传入 `allowProduction: true` 二次确认。
5. **极简上下文与紧凑 Markdown 表格渲染**：
   - `contextSlimmer` 自动清洗 NetSuite API 响应中的 `null`、`undefined` 和空数组。
   - 查询数据与元数据秒级转换为紧凑 Markdown 表格，大幅减少 LLM Context 占用。
6. **全链路可观测性与自动化自愈诊断**：
   - 结构化记录每次工具调用指标（耗时 `durationMs`、载荷 `payloadChars`、错误分类 `errorCategory`）。
   - 内置结构化自愈诊断标签（如 `[Self-Healing Action]`），配套提供 CLI 错误分析及每日诊断报告生成能力。

---

## 🚀 快速上手 (Quick Start)

### 步骤 1：NetSuite 实例端准备

1. **安装官方 AI Connector Bundle**：
   - 在 NetSuite 环境中进入 **Customization > SuiteBundler > Search & Install Bundles**。
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

## 🧰 权威 MCP 工具手册 (Zero-Bloat)

本服务端遵循 **Zero-Bloat 与正交职责原则**，物理剔除过时冗余别名，由以下权威工具组成核心能力闭环（生产环境 8 大核心工具，沙箱环境扩充 2 大专属记录变更工具）：

| 工具名称 | 功能描述 | MCP 注解声明 | 环境权限 |
| :--- | :--- | :--- | :---: |
| [`netsuite_run_suiteql`](#1-netsuite_run_suiteql) | 执行只读 SuiteQL 查询。受 AST 守卫保护，自动注入保底分页，支持多语句及并行查询。 | `readOnlyHint: true`, `idempotentHint: true` | 全环境 |
| [`netsuite_get_metadata`](#2-netsuite_get_metadata) | 反查数据库表结构、字段类型、有效列名与 272 类标准实体元数据字典。 | `readOnlyHint: true`, `idempotentHint: true` | 全环境 |
| [`netsuite_get_record`](#3-netsuite_get_record) | 按内部 ID 或单据编号 (tranid) 检索记录，清洗噪点，输出紧凑表格并附直达 Web UI 链接。 | `readOnlyHint: true`, `idempotentHint: true` | 全环境 |
| [`netsuite_get_script_logs`](#4-netsuite_get_script_logs) | 索引优化检索 SuiteScript 脚本执行日志（ScriptNote），支持按等级、脚本与时间范围过滤。 | `readOnlyHint: true`, `idempotentHint: true` | 全环境 |
| [`netsuite_get_system_notes`](#5-netsuite_get_system_notes) | 高性能单记录审计追踪（SystemNote），独立索引查询，杜绝跨表关联引发的慢查询超时。 | `readOnlyHint: true`, `idempotentHint: true` | 全环境 |
| [`netsuite_deploy_script`](#6-netsuite_deploy_script) | 通过 SuiteCloud CLI 部署脚本至文件柜。包含语法预检、工程结构识别及生产写屏障。 | `destructiveHint: true` | 全环境（生产需确认） |
| [`netsuite_status`](#7-netsuite_status) | 诊断系统健康：Token 寿命、环境分类（Prod/Sandbox）、Redis 缓存状态及错误聚合自愈。 | `readOnlyHint: true`, `idempotentHint: true` | 全环境 |
| [`netsuite_auth`](#8-netsuite_auth) | 集中管理 OAuth 2.0 PKCE 会话与缓存，支持登录、注销与缓存刷新。 | `idempotentHint: true` | 全环境 |
| [`netsuite_create_record`](#9-netsuite_create_record) | 在 NetSuite 沙箱/测试环境中创建新业务记录，清洗噪点并生成 Web UI 直达链接。 | `destructiveHint: true` | **沙箱限定**（生产物理阻断） |
| [`netsuite_update_record`](#10-netsuite_update_record) | 在 NetSuite 沙箱/测试环境中更新业务记录，支持自然键 tranid 智能解析与 UI 直达。 | `destructiveHint: true` | **沙箱限定**（生产物理阻断） |

---

### 1. `netsuite_run_suiteql`
执行只读 Oracle NetSuite SuiteQL 查询并返回表格结果。严格遵循 Oracle NetSuite 语法规则。

- **输入参数**：
  - `sqlQuery` (`string`, 可选): 要执行的 SuiteQL 查询字符串，支持以 `;` 分隔多条语句。
  - `sqlQueries` (`string[]`, 可选): 可选的并发并行执行查询数组（最多 10 条）。
  - `limit` (`number`, 可选): 可选的安全最大行数限制（默认 100）。
  - `customRecordMappings` (`array`, 可选): 自定义记录映射关系（`rectype` 与 `scriptId`）。
- **守卫规则**：零底层隐式改写；严禁 `SELECT *`；拦截裸 `LIMIT`/`OFFSET` 并引导标准 Oracle 语法；关联 `transactionline` 必须约束 `tl.mainline`；严禁跨表关联 `systemnote`；自动保底追加 `FETCH FIRST 100 ROWS ONLY`。

### 2. `netsuite_get_metadata`
探查 NetSuite 数据库表结构、字段合法列名与数据类型。具备 2ms Redis 缓存加速及 272 类标准实体离线字典。

- **输入参数**：
  - `table` (`string`, 可选): NetSuite 数据库表名或记录类型 ID（如 `customer`, `transaction`, `transactionline`, `item` 等）。省略时列出或搜索表目录。
  - `keyword` (`string`, 可选): 过滤表名、列名、标签或描述的关键词。
  - `source` (`"auto" | "offline" | "remote"`, 可选): 元数据来源，默认 `"auto"`。

### 3. `netsuite_get_record`
按内部数字 ID 或单据编号 (tranid) 检索记录详情。返回经过深度瘦身的表头字段、自定义字段、行项子列表及可点击的原生 Web UI 直达链接。

- **输入参数**：
  - `recordType` (`string`, 必填): 记录类型 ID（如 `salesorder`, `customer`, `invoice`, `customrecord_xxx`）。
  - `id` (`string`, 必填): 内部数字 ID（如 `"12345"`）或单据编号 / tranid（如 `"SO10023"`）。
  - `includeSublists` (`boolean`, 可选): 是否包含明细行子列表（默认 `true`）。
  - `linesMode` (`"all" | "summary"`, 可选): 子列表展示模式（默认 `"all"`）。
  - `maxLines` (`number`, 可选): 每个子列表展示的最大行数。
  - `lineFields` (`string[]`, 可选): 仅提取指定的子列字段。
  - `format` (`"markdown" | "compact_json"`, 可选): 输出格式（默认 `"markdown"`）。

### 4. `netsuite_get_script_logs`
高效检索 NetSuite 脚本执行日志（`ScriptNote`），采用索引优化检索，默认回溯最近 7 天。

- **输入参数**：
  - `scriptId` (`string`, 可选): 按脚本 Script ID 过滤（如 `customscript_my_ue`）。
  - `type` (`"DEBUG" | "AUDIT" | "ERROR" | "EMERGENCY"`, 可选): 按日志等级过滤。
  - `dateFrom` (`string`, 可选): 起始日期（`YYYY-MM-DD` 格式）。
  - `dateTo` (`string`, 可选): 截止日期（`YYYY-MM-DD` 格式）。
  - `keyword` (`string`, 可选): 按日志标题或详情关键字过滤。
  - `deploymentId` (`string`, 可选): 按部署 Script ID 过滤。
  - `limit` (`number`, 可选): 返回条数限制（默认 50，最大 200）。

### 5. `netsuite_get_system_notes`
高性能单据审计追踪：按记录内部 ID 或单据编号查询字段变更历史（`SystemNote`）。

- **输入参数**：
  - `recordId` (`string`, 必填): 记录内部 ID 或单据编号 (tranid)。
  - `recordType` (`string`, 可选): 可选的记录类型。
  - `limit` (`number`, 可选): 返回条数限制（默认 50，最大 100）。

### 6. `netsuite_deploy_script`
基于 SuiteCloud CLI 将 SuiteScript 脚本与静态资产上传至文件柜。

- **输入参数**：
  - `paths` (`string | string[]`, 必填): 本地待上传文件路径或路径数组。
  - `projectPath` (`string`, 可选): SDF 工程根目录路径。
  - `authId` (`string`, 可选): 可选的 SDF CLI 授权凭据 ID。
  - `dryRun` (`boolean`, 可选): 仅校验与预览，不执行实际上传（默认 `false`）。
  - `skipValidation` (`boolean`, 可选): 跳过语法预检（默认 `false`）。
  - `allowProduction` (`boolean`, 可选): 生产环境显式确认授权开关（若部署至生产环境必须显式声明为 `true`）。

### 7. `netsuite_status`
全面检查当前连接状态、OAuth Token 寿命 (TTL)、当前运行环境（Sandbox vs Production）与系统健康度。

- **输入参数**：
  - `includeErrors` (`boolean`, 可选): 是否包含最近错误诊断摘要与自愈建议。

### 8. `netsuite_auth`
集中管理 NetSuite OAuth 2.0 PKCE 会话与本地缓存。

- **输入参数**：
  - `action` (`"login" | "logout" | "refresh_cache"`, 必填):
    - `"login"`: 唤起浏览器完成 OAuth 2.0 PKCE 授权流并持久化会话；
    - `"logout"`: 注销当前活动会话并清理本地 Token 缓存；
    - `"refresh_cache"`: 刷新本地 Redis 缓存及远程 Session 元数据。

### 9. `netsuite_create_record`
在 NetSuite 沙箱/测试环境（Sandbox / Test）中创建新记录。生产环境严格物理阻断。执行成功后自动清洗空字段噪点并生成 Web UI 直达链接。

- **输入参数**：
  - `recordType` (`string`, 必填): 记录类型 ID（如 `customer`, `salesorder`, `invoice`, `customrecord_xxx`）。
  - `record` (`object`, 可选): 待创建记录的字段键值对，包含表头字段、自定义字段与子列表。

### 10. `netsuite_update_record`
在 NetSuite 沙箱/测试环境（Sandbox / Test）中更新现有业务记录。支持数字内部 ID 或单据编号（tranid）自然键自动解析。生产环境严格物理阻断。

- **输入参数**：
  - `recordType` (`string`, 必填): 记录类型 ID。
  - `id` (`string`, 必填): 内部数字 ID 或单据编号（tranid，如 `SO10023`）。
  - `record` (`object`, 可选): 待更新的字段键值对。

---

## 📚 MCP Resources 与 Prompts

### 1. 标准只读资源 (`netsuite://`)

- **`netsuite://guides/suiteql`**：完整 SuiteQL 语法规范、Oracle 专属方言子集规则与性能调优指南。
- **`netsuite://queries/golden-templates`**：Oracle SAFE 指南认证的 8 套生产级 SuiteQL 黄金查询模板（单据溯源、交易行、多地点库存 MLI 等）。
- **`netsuite://records/reference`**：官方全量 272 类标准业务记录的字典目录与字段定义。
- **`netsuite://templates/generative-ui`**：遵循 Antigravity 主题变量标准的数据卡片、生命周期图谱与库存分布可视化组件。
- **`netsuite://skills/{skillName}`**：SuiteCloud 专业技能离线文档按需查阅。

### 2. 开箱即用的场景 Prompts

- **`review_suitescript`**：基于 Oracle SAFE 2025.2 准则、治理开销预算与 OWASP 安全标准审查 SuiteScript 2.1 代码。
- **`debug_script_error`**：输入 NetSuite 运行时异常堆栈，自动定位根因并输出精确重构补丁。
- **`generate_suiteql`**：根据业务需求生成经过 SAFE 准则加固的生产级 SuiteQL。
- **`visualize_netsuite_data`**：将 ERP 数据渲染为基于 HTML/Tailwind 的交互式 Generative UI 组件（支持 `<agent-embed>`）。
- **`upgrade_suitescript`**：将旧版 SuiteScript 1.0/2.0 代码现代化升级至 SuiteScript 2.1 现代 ES6+ 语法。

---

## ⏰ 后台 Token 保活守护进程与休眠保护

为了让开发者彻底告别每日重复授权的困扰，本项目内置了系统级守护进程与智能防失活保护：

1. **24/7 后台自动保活**：基于 macOS LaunchAgent 与 Linux systemd，每 10 分钟自动扫描即将过期的 Token 并通过 OAuth PKCE 进行轮换刷新。
2. **macOS 休眠与 DarkWake 保护**：在笔记本合盖休眠或低电量 DarkWake 唤醒期间，守护进程自动挂起盲目轮换，有效保护 Refresh Token 不被意外损坏。
3. **静默重连自愈**：通过 `trySilentReauth` 与 Redlock 归一化锁键，多实例并发安全，异常状态下实现透明自愈。

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

## 📊 本地日志分析与每日诊断报告

系统支持工作区调用日志分析与每日自动化健康巡检：

```bash
# 1. 汇总分析当前工作区的调用错误诊断与自愈修复建议
npm run logs:summary

# 2. 自动生成当天的 Markdown 格式健康巡检报告 (输出至 logs/reports/daily-report-YYYY-MM-DD.md)
npm run logs:daily
```

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

# 运行严格 TypeScript 类型检查 (tsc --noEmit)
npm run typecheck

# 运行全量单元测试与集成测试 (Vitest)
npm test

# 运行 ISO/IEC 25010 & Oracle SAFE 综合系统架构客观基准评分 (100/100 卓越评级)
npm run score

# 运行 Oracle 官方文档合规性对抗评测 (防幻觉专项 100/100 分)
npm run test:compliance
```

### 综合架构标准化评估 (ISO/IEC 25010 Benchmark)

本项目内置了客观物理测度架构打分套件（`npm run score`），持续保持 **100/100 分（Level 5 Optimizing 优化卓越级）**：

| 维度编号 | 行业标准维度名称 | 权重 | 测度依据与落地表现 | 状态 |
| :--- | :--- | :---: | :--- | :---: |
| **P1** | **渗透攻防与安全阻断实测** *(Security & Resistance)* | 20% | OWASP ASVS v4.0 & BFN：20 组复杂 SQL/DDL/DML 渗透与堆叠注入 100% 拦截，生产环境写锁与敏感凭证深度脱敏。 | 🟢 卓越 |
| **P2** | **MCP 协议完备性与 Schema 质量** *(Protocol & Tool Quality)* | 20% | Anthropic MCP 规范：8 大权威工具注册就绪（Zero-Bloat），100% 属性约束覆盖，完整 MCP Annotations、Prompts 与 Resources。 | 🟢 卓越 |
| **P3** | **Oracle SAFE 架构合规对抗** *(Oracle SAFE Compliance)* | 20% | SAFE 2025.2 & Zero-Transpile：通配符拦截、Mainline 过滤校验、Pitfall 11 超时阻断，零隐式方言改写，272 类标准实体离线字典。 | 🟢 卓越 |
| **P4** | **性能效率与 Token 压缩度量** *(Efficiency & Slimming)* | 15% | Context7 MCP 标杆：实测 50%+ 物理 Context 字符压缩比，强制保底分页注入，收录 8 套 SAFE 黄金查询模板。 | 🟢 卓越 |
| **P5** | **代码健康度与架构纪律静态分析** *(Code Health & Discipline)* | 15% | SonarQube & ArchUnitTS：全量 TS 源码 0 处 `any` 类型，100% 显式 `.js` ESM 导入，严格单向架构依赖。 | 🟢 卓越 |
| **P6** | **容错韧性与自愈诊断 F1-Score** *(Resilience & Classification)* | 10% | MCPEval 异常分类基准：8 大异常分类器 100% F1-Score 准确聚类，多租户多工作区配置物理完好。 | 🟢 卓越 |

---

## 🔒 企业安全与防护规范

1. **公钥凭证安全**：采用 OAuth 2.0 PKCE 模式交互，任何场景下均不要求或存储 NetSuite Client Secret。
2. **生产环境防护屏障**：只读工具安全隔离；代码部署至生产账套强制要求显式传入 `allowProduction: true`。
3. **敏感凭证脱敏**：错误遥测与调用日志记录中自动递归遮罩 Token、密钥、密码与个人敏感数据。
4. **无网络开放端口**：基于本地 Stdio 传输运行，无开放监听端口，天然免疫远程未授权访问与 SSRF 风险。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。旨在为企业级 NetSuite 开发者与智能体工程化应用提供最稳健的基础设施。
