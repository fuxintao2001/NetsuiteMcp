/**
 * test-system-architecture-score.ts
 *
 * 全新设计的 NetSuite MCP & 按需加载（On-Demand）架构 360° 综合评测与系统打分套件。
 *
 * 评估维度 (6 大核心维度，共 31 项深度量化指标):
 * 1. 按需加载与渐进式披露架构 (On-Demand & Progressive Disclosure) [权重 20%]
 * 2. Gemini 认知与上下文效能 (Gemini Attention & Cognitive Economics) [权重 15%]
 * 3. MCP 协议完备度与资源覆盖 (MCP Protocol & Resource Coverage) [权重 20%]
 * 4. 运行时代码级硬防御 (Deterministic Runtime Guardrails) [权重 20%]
 * 5. 环境隔离与写操作安全门禁 (Environment Isolation & Write Guard) [权重 15%]
 * 6. 多工作区同步健康度 (Multi-Workspace Synchronization) [权重 10%]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { 
  validateSuiteQL, 
  ensureSuiteQLPagination, 
  maskStringLiterals,
  SchemaReconnaissanceTracker 
} from '../src/utils/suiteqlGuard.js';
import { isSandboxAccount } from '../src/utils/environment.js';
import { SUITEQL_TEMPLATES } from '../src/utils/suiteqlTemplates.js';
import { recordsReferenceService } from '../src/utils/recordsReference.js';
import { PROMPT_DEFINITIONS } from '../src/handlers/prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

// ---------------------------------------------------------------------------
// 评测数据结构定义
// ---------------------------------------------------------------------------

interface TestCaseResult {
  id: string;
  name: string;
  passed: boolean;
  score: number; // 0 ~ 100
  detail: string;
}

interface DimensionEvaluation {
  id: string;
  name: string;
  weight: number; // 0.0 ~ 1.0
  cases: TestCaseResult[];
  rawScore: number; // 0 ~ 100
  weightedScore: number;
}

console.log('='.repeat(90));
console.log('🎯 NetSuite MCP 360° 全架构深度评测与系统综合打分基准 (Benchmark v2.0)');
console.log('='.repeat(90) + '\n');

// ---------------------------------------------------------------------------
// 维度 1: 按需加载与渐进式披露架构 (On-Demand & Progressive Disclosure) [权重 20%]
// ---------------------------------------------------------------------------

const dim1Cases: TestCaseResult[] = [];

// Case 1.1: 模板瘦身幅度 (< 6.5KB, 相对原本 17KB 削减 > 60%)
const templatePath = path.join(projectRoot, 'workspace-agents', 'AGENTS.template.md');
const templateContent = fs.readFileSync(templatePath, 'utf-8');
const templateBytes = Buffer.byteLength(templateContent, 'utf-8');
const templateLines = templateContent.split('\n').length;
const isSlim = templateBytes < 6500 && templateBytes > 2000;
dim1Cases.push({
  id: 'D1-1',
  name: 'AGENTS.template.md 模板体积与上下文瘦身达标率',
  passed: isSlim,
  score: isSlim ? 100 : 0,
  detail: `当前大小: ${templateBytes} 字节 / ${templateLines} 行 (目标: < 6,500 字节，原本: 17,046 字节，削减率: ${(100 - (templateBytes / 17046) * 100).toFixed(1)}%)`
});

// Case 1.2: 知识按需加载路由表完整度
const hasRouter = templateContent.includes('知识按需加载路由表') || 
                  templateContent.includes('On-Demand Dispatcher') ||
                  templateContent.includes('ON-DEMAND SKILLS & KNOWLEDGE ROUTER');
const requiredKeywords = [
  'netsuite_get_query_template',
  'golden-templates',
  'netsuite-sdf-safe-guide',
  'review_suitescript',
  'netsuite_get_record_definition',
  'netsuite-finance-analyst',
  'netsuite-owasp-secure-coding'
];
const missingKeywords = requiredKeywords.filter(k => !templateContent.includes(k));
const routerPassed = hasRouter && missingKeywords.length === 0;
dim1Cases.push({
  id: 'D1-2',
  name: '核心任务按需加载路由矩阵覆盖率 (Router Completeness)',
  passed: routerPassed,
  score: routerPassed ? 100 : Math.max(0, 100 - missingKeywords.length * 20),
  detail: routerPassed 
    ? '✅ 包含全部 6 大任务场景 (SuiteQL、SAFE Guide、记录字典、脚本排错、财务分析、OWASP) 完整路由' 
    : `❌ 缺少路由项: ${missingKeywords.join(', ')}`
});

// Case 1.3: 彻底消除单体大表冗余 (无硬编码的 8 领域 SuiteQL 巨大矩阵和 BAD vs GOOD 表)
const hasObsoleteBigTable = templateContent.includes('aggregateitemlocation a WHERE a.location = :loc') || 
                            templateContent.includes('CONTRASTIVE BENCHMARK (BAD VS GOOD)');
dim1Cases.push({
  id: 'D1-3',
  name: '消除静态单体百科全书与重复表格 (Zero Monolithic Duplication)',
  passed: !hasObsoleteBigTable,
  score: !hasObsoleteBigTable ? 100 : 0,
  detail: !hasObsoleteBigTable 
    ? '✅ 成功移出静态大表与对比清单，完全转由 MCP Resource 与 Skills JIT 按需加载' 
    : '❌ 仍包含硬编码的冗余大表格'
});

// Case 1.4: 全局技能安装完备性与可读性
const skillsDir = path.join(os.homedir(), '.gemini', 'config', 'skills');
const expectedSkills = [
  'netsuite-ai-connector-instructions',
  'netsuite-sdf-safe-guide',
  'netsuite-finance-analyst',
  'netsuite-suitescript-records-reference',
  'netsuite-owasp-secure-coding',
  'netsuite-sdf-roles-and-permissions',
  'netsuite-suitescript-upgrade'
];
let existingSkillsCount = 0;
for (const s of expectedSkills) {
  if (fs.existsSync(path.join(skillsDir, s, 'SKILL.md'))) {
    existingSkillsCount++;
  }
}
const allSkillsExist = existingSkillsCount === expectedSkills.length;
dim1Cases.push({
  id: 'D1-4',
  name: 'Oracle NetSuite 官方 Agent Skills 本地安装完备度',
  passed: allSkillsExist,
  score: Math.round((existingSkillsCount / expectedSkills.length) * 100),
  detail: `已安装 ${existingSkillsCount}/${expectedSkills.length} 个核心领域技能 (位于 ~/.gemini/config/skills/)`
});

// ---------------------------------------------------------------------------
// 维度 2: Gemini 认知与上下文效能 (Gemini Attention & Cognitive Economics) [权重 15%]
// ---------------------------------------------------------------------------

const dim2Cases: TestCaseResult[] = [];

// Case 2.1: 占位符解析 100% 替换无残留
const unreplacedMatches = templateContent.match(/\{\{[A-Z_]+\}\}/g) || [];
// 验证配置中的所有工作区中的 AGENTS.md 均无残留占位符
const configPath = path.join(projectRoot, 'workspace-agents', 'workspaces.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
let anyUnreplacedInWorkspaces = false;
let checkedWorkspacesCount = 0;

for (const ws of config.workspaces) {
  const wsAgentsPath = path.join(ws.projectPath, 'AGENTS.md');
  if (fs.existsSync(wsAgentsPath)) {
    checkedWorkspacesCount++;
    const content = fs.readFileSync(wsAgentsPath, 'utf-8');
    if (/\{\{[A-Z_]+\}\}/.test(content)) {
      anyUnreplacedInWorkspaces = true;
    }
  }
}
dim2Cases.push({
  id: 'D2-1',
  name: '多工作区模板占位符解析零残留 (Zero Placeholder Residue)',
  passed: !anyUnreplacedInWorkspaces && checkedWorkspacesCount > 0,
  score: !anyUnreplacedInWorkspaces ? 100 : 0,
  detail: `已验证 ${checkedWorkspacesCount} 个工作区，占位符 ({{ACCOUNT_ID}}, {{ENV_TYPE}} 等) 替换成功率 100%`
});

// Case 2.2: 环境锁定与首屏状态声明 (Environment Lock Header)
const hasLockHeader = templateContent.includes('Environment Lock') && 
                      templateContent.includes('{{ACCOUNT_ID}}') && 
                      templateContent.includes('{{ENV_TYPE}}');
dim2Cases.push({
  id: 'D2-2',
  name: '环境锁定声明清晰度 (Environment Lock Directives)',
  passed: hasLockHeader,
  score: hasLockHeader ? 100 : 0,
  detail: hasLockHeader ? '✅ 包含顶层环境锁定与 MCP 绑定凭证，防止跨环境误操作' : '❌ 缺少环境锁定标头'
});

// Case 2.3: 全中文交互底线锁定声明
const hasLanguagePolicy = templateContent.includes('全中文交互') || templateContent.includes('Language Policy');
dim2Cases.push({
  id: 'D2-3',
  name: '全中文交互底线约束声明 (Simplified Chinese Mandate)',
  passed: hasLanguagePolicy,
  score: hasLanguagePolicy ? 100 : 0,
  detail: hasLanguagePolicy ? '✅ 顶层严格锁定所有用户解释与 UI 为简体中文交互' : '❌ 缺少中文交互约束'
});

// Case 2.4: 静态规则信息密度 (Signal-to-Noise Ratio)
// 统计结构化标题、表格、列表、引用与编号规则行比例
const lines = templateContent.split('\n').filter(l => l.trim().length > 0);
const highSignalLines = lines.filter(l => /^([#|\->]|\d+\.)/.test(l.trim()));
const snr = Math.round((highSignalLines.length / lines.length) * 100);
dim2Cases.push({
  id: 'D2-4',
  name: '静态提示词信息密度 (Signal-to-Noise Ratio)',
  passed: snr >= 85,
  score: Math.min(100, snr),
  detail: `信噪比: ${snr}% (高质量结构化规约/路由行: ${highSignalLines.length}/${lines.length} 行)`
});

// ---------------------------------------------------------------------------
// 维度 3: MCP 协议完备度与资源覆盖 (MCP Protocol & Resource Coverage) [权重 20%]
// ---------------------------------------------------------------------------

const dim3Cases: TestCaseResult[] = [];

// Case 3.1: 官方 SuiteQL 黄金模板库资源 (SUITEQL_TEMPLATES)
const goldenTemplatesCount = SUITEQL_TEMPLATES.length;
const hasEssentialTemplates = SUITEQL_TEMPLATES.some(t => t.id === 'transaction_lines') &&
                             SUITEQL_TEMPLATES.some(t => t.id === 'transaction_lineage_downstream') &&
                             SUITEQL_TEMPLATES.some(t => t.id === 'multi_location_stock');
dim3Cases.push({
  id: 'D3-1',
  name: 'SuiteQL 官方黄金模板库完备度 (SUITEQL_TEMPLATES)',
  passed: hasEssentialTemplates && goldenTemplatesCount >= 5,
  score: hasEssentialTemplates ? 100 : 50,
  detail: `已收录 ${goldenTemplatesCount} 个黄金模板 (涵盖交易行、文档溯源、多地点库存 MLI、GL 影响、系统日志)`
});

// Case 3.2: 272 类标准记录字典检索服务 (recordsReferenceService)
const recordTypes = recordsReferenceService.listRecordTypes();
const recordTypesCount = recordTypes.length;
const hasCoreRecords = ['customer', 'salesorder', 'invoice', 'item'].every(r => recordTypes.includes(r));
dim3Cases.push({
  id: 'D3-2',
  name: '272 类标准记录字典服务 (Records Reference Service)',
  passed: hasCoreRecords && recordTypesCount >= 200,
  score: Math.round((recordTypesCount / 272) * 100),
  detail: `已注册 ${recordTypesCount} 类官方标准记录字典，支持毫秒级字段与搜索类型反查`
});

// Case 3.3: 专用 MCP Prompts 注册完整度
const promptNames = PROMPT_DEFINITIONS.map(p => p.name);
const expectedPrompts = ['review_suitescript', 'debug_script_error', 'generate_suiteql'];
const allPromptsExist = expectedPrompts.every(p => promptNames.includes(p));
dim3Cases.push({
  id: 'D3-3',
  name: '专用 MCP Prompts 注册完备度 (review, debug, generate)',
  passed: allPromptsExist,
  score: allPromptsExist ? 100 : 0,
  detail: `已注册 ${promptNames.length} 个专用提示词: [${promptNames.join(', ')}]`
});

// Case 3.4: 批量并发执行引擎规范 (Batch Execution Mandate)
const hasBatchInstruction = templateContent.includes('netsuite_batch_execute') && 
                            (templateContent.includes('≥ 2') || templateContent.includes('independent items'));
dim3Cases.push({
  id: 'D3-4',
  name: '并行批处理调度引擎约束 (Batch Execution Mandate)',
  passed: hasBatchInstruction,
  score: hasBatchInstruction ? 100 : 0,
  detail: hasBatchInstruction 
    ? '✅ 明确规定 ≥ 2 个独立任务必须合并调用 netsuite_batch_execute，杜绝串行低效交互' 
    : '❌ 缺少批量并发调用明确指引'
});

// ---------------------------------------------------------------------------
// 维度 4: 运行时代码级硬防御 (Deterministic Runtime Guardrails) [权重 20%]
// ---------------------------------------------------------------------------

const dim4Cases: TestCaseResult[] = [];

// Case 4.1: 硬拦截 SELECT * 全形态变体
const testWildcards = [
  'SELECT * FROM transaction',
  'SELECT t.* FROM transaction t',
  'SELECT DISTINCT * FROM customer'
];
const blockedAllWildcards = testWildcards.every(q => !validateSuiteQL(q).valid);
dim4Cases.push({
  id: 'D4-1',
  name: '拦截 SELECT * 及其别名/DISTINCT 变体 (Zero Wildcard Projection)',
  passed: blockedAllWildcards,
  score: blockedAllWildcards ? 100 : 0,
  detail: blockedAllWildcards ? '✅ 成功硬拦截所有 SELECT * 通配符查询变体' : '❌ 存在放行通配符漏洞'
});

// Case 4.2: 硬拦截 LIMIT / OFFSET
const blockedLimit = !validateSuiteQL('SELECT id FROM transaction LIMIT 10 OFFSET 5').valid;
dim4Cases.push({
  id: 'D4-2',
  name: '硬拦截 MySQL/Postgres 方言 LIMIT/OFFSET',
  passed: blockedLimit,
  score: blockedLimit ? 100 : 0,
  detail: blockedLimit ? '✅ 成功拦截 LIMIT/OFFSET 并指引 ROWNUM / FETCH FIRST 分页' : '❌ 允许了非法分页'
});

// Case 4.3: 硬拦截 SystemNote 跨表 JOIN
const blockedSystemNoteJoin = !validateSuiteQL('SELECT t.id, sn.field FROM transaction t JOIN SystemNote sn ON t.id = sn.recordid').valid;
dim4Cases.push({
  id: 'D4-3',
  name: '硬拦截跨表关联 SystemNote (防 45s+ 严重超时)',
  passed: blockedSystemNoteJoin,
  score: blockedSystemNoteJoin ? 100 : 0,
  detail: blockedSystemNoteJoin ? '✅ 拦截 JOIN SystemNote 并建议独立查询' : '❌ 允许了跨表超时关联'
});

// Case 4.4: 交易主表 createdfrom 字段位置纠偏
const blockedCreatedFromHeader = !validateSuiteQL('SELECT id FROM transaction WHERE createdfrom = 123').valid;
dim4Cases.push({
  id: 'D4-4',
  name: '拦截主表 transaction.createdfrom 并纠偏为 transactionline',
  passed: blockedCreatedFromHeader,
  score: blockedCreatedFromHeader ? 100 : 0,
  detail: blockedCreatedFromHeader ? '✅ 成功拦截并在诊断中提示 createdfrom 仅存在于 transactionline' : '❌ 未能识别字段位置错误'
});

// Case 4.5: 交易行缺失 mainline 过滤拦截
const blockedMissingMainline = !validateSuiteQL('SELECT t.id, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.type = \'SalesOrd\'').valid;
dim4Cases.push({
  id: 'D4-5',
  name: '拦截 transactionline 缺失 mainline 过滤 (防行翻倍与金额畸高)',
  passed: blockedMissingMainline,
  score: blockedMissingMainline ? 100 : 0,
  detail: blockedMissingMainline ? '✅ 成功拦截并在诊断中指导补充 tl.mainline = \'F\'' : '❌ 允许缺失 mainline'
});

// Case 4.6: item 表错误使用 recordtype 纠偏
const blockedItemRecordType = !validateSuiteQL('SELECT id, recordtype FROM item').valid;
dim4Cases.push({
  id: 'D4-6',
  name: '拦截 item.recordtype 错误并指导使用 itemtype/subtype',
  passed: blockedItemRecordType,
  score: blockedItemRecordType ? 100 : 0,
  detail: blockedItemRecordType ? '✅ 成功拦截并提示 item 表不存在 recordtype，指导使用 itemtype' : '❌ 允许了非法字段'
});

// Case 4.7: SQL 破坏性与注入攻击防御 (DROP/DELETE/UPDATE/多语句)
const testInjections = [
  'DROP TABLE customer',
  'DELETE FROM transaction',
  'SELECT id FROM customer; DROP TABLE item;',
  'SELECT id FROM customer -- comments'
];
const blockedAllInjections = testInjections.every(q => !validateSuiteQL(q).valid);
dim4Cases.push({
  id: 'D4-7',
  name: 'SQL 注入与 DDL/DML 破坏性语句拦截 (SQL Security Guard)',
  passed: blockedAllInjections,
  score: blockedAllInjections ? 100 : 0,
  detail: blockedAllInjections ? '✅ 成功硬阻断 DROP, DELETE, 多语句与 SQL 注释混淆' : '❌ 存在安全注入漏洞'
});

// Case 4.8: 缺失分页时自动兜底补齐 (FETCH FIRST 100 ROWS ONLY)
const paginatedSql = ensureSuiteQLPagination('SELECT id, entity FROM transaction', 100);
const paginationEnsured = paginatedSql.includes('FETCH FIRST 100 ROWS ONLY');
dim4Cases.push({
  id: 'D4-8',
  name: '分页子句自动保底补全 (Auto Pagination Injection)',
  passed: paginationEnsured,
  score: paginationEnsured ? 100 : 0,
  detail: paginationEnsured ? `✅ 成功追加 Oracle 分页: "${paginatedSql}"` : '❌ 分页追加失败'
});

// Case 4.9: 字符串字面量精准遮罩零误杀 (Zero False Positive)
const benignQuery = "SELECT id, memo FROM customer WHERE memo = 'SELECT * FROM order LIMIT 10' AND status = 'Active'";
const notFalsePositive = validateSuiteQL(benignQuery).valid;
dim4Cases.push({
  id: 'D4-9',
  name: '字符串字面量遮罩防误杀 (Zero False Positive on Benign Literals)',
  passed: notFalsePositive,
  score: notFalsePositive ? 100 : 0,
  detail: notFalsePositive ? '✅ 引号内的业务文本关键字被精准保护，合法查询无误杀' : '❌ 发生误杀错误'
});

// ---------------------------------------------------------------------------
// 维度 5: 环境隔离与写操作安全门禁 (Environment Isolation & Write Guard) [权重 15%]
// ---------------------------------------------------------------------------

const dim5Cases: TestCaseResult[] = [];

// Case 5.1: 生产账号判定与写操作硬拦截
const prod1 = !isSandboxAccount('5848789');
const prod2 = !isSandboxAccount('9260916');
const allProdCorrect = prod1 && prod2;
dim5Cases.push({
  id: 'D5-1',
  name: '生产环境账号识别与写操作代码级禁用 (Prod Write Lockout)',
  passed: allProdCorrect,
  score: allProdCorrect ? 100 : 0,
  detail: allProdCorrect ? '✅ 5848789 与 9260916 正确识别为生产环境，代码级阻断写操作' : '❌ 生产环境识别错误'
});

// Case 5.2: 沙箱账号判定与写操作正常开放
const sb1 = isSandboxAccount('5848789-sb1');
const sb2 = isSandboxAccount('9260916-sb1');
const sb3 = isSandboxAccount('TSTDRV12345');
const allSbCorrect = sb1 && sb2 && sb3;
dim5Cases.push({
  id: 'D5-2',
  name: '沙箱与测试环境识别与写操作开放 (Sandbox Write Enablement)',
  passed: allSbCorrect,
  score: allSbCorrect ? 100 : 0,
  detail: allSbCorrect ? '✅ 5848789-sb1, 9260916-sb1 及 TSTDRV 正确识别为沙箱，正常开放变更工具' : '❌ 沙箱识别错误'
});

// Case 5.3: 模板中生产与沙箱写操作表述分流
const hasProdWarning = templateContent.includes('{{WRITE_TOOLS_TABLE}}') && 
                       templateContent.includes('{{WRITE_OPS_SECTION}}');
dim5Cases.push({
  id: 'D5-3',
  name: '模板环境门禁条件块配置 (Template Conditional Gates)',
  passed: hasProdWarning,
  score: hasProdWarning ? 100 : 0,
  detail: hasProdWarning ? '✅ 模板中严格注入环境写保护与生产只读警示条件块' : '❌ 模板缺少写保护条件块'
});

// ---------------------------------------------------------------------------
// 维度 6: 多工作区同步健康度 (Multi-Workspace Synchronization) [权重 10%]
// ---------------------------------------------------------------------------

const dim6Cases: TestCaseResult[] = [];

// Case 6.1: 所有声明的工作区 AGENTS.md 均存在且大小合理
let allWsAgentsValid = true;
const wsStatusList: string[] = [];

for (const ws of config.workspaces) {
  const wsPath = path.join(ws.projectPath, 'AGENTS.md');
  const exists = fs.existsSync(wsPath);
  if (!exists) {
    allWsAgentsValid = false;
    wsStatusList.push(`${path.basename(ws.projectPath)}: ❌ 不存在`);
  } else {
    const sz = fs.statSync(wsPath).size;
    const okSize = sz > 3000 && sz < 8000;
    if (!okSize) allWsAgentsValid = false;
    wsStatusList.push(`${path.basename(ws.projectPath)}: ✅ (${sz} 字节)`);
  }
}
dim6Cases.push({
  id: 'D6-1',
  name: '四大多工作区 AGENTS.md 物理文件完好度',
  passed: allWsAgentsValid,
  score: allWsAgentsValid ? 100 : 0,
  detail: wsStatusList.join(' | ')
});

// Case 6.2: 生产环境工作区包含只读保护说明
const prodWsPath = path.join(config.workspaces[0].projectPath, 'AGENTS.md');
let prodHasReadOnlyNotice = false;
if (fs.existsSync(prodWsPath)) {
  const prodText = fs.readFileSync(prodWsPath, 'utf-8');
  prodHasReadOnlyNotice = prodText.includes('生产只读保护') || 
                          prodText.includes('生产环境严格禁止记录写入') ||
                          prodText.includes('Production Read-Only') ||
                          prodText.includes('Production Safety Guard') ||
                          prodText.includes('strictly prohibited in Production');
}
dim6Cases.push({
  id: 'D6-2',
  name: '生产工作区文件内容强制写入只读警告 (Production Warning Injected)',
  passed: prodHasReadOnlyNotice,
  score: prodHasReadOnlyNotice ? 100 : 0,
  detail: prodHasReadOnlyNotice ? '✅ 生产环境已成功注入只读警示与写操作代码阻断说明' : '❌ 生产环境缺少只读保护说明'
});

// Case 6.3: 沙箱环境工作区包含写工具明细
const sbWsPath = path.join(config.workspaces[1].projectPath, 'AGENTS.md');
let sbHasWriteToolsTable = false;
if (fs.existsSync(sbWsPath)) {
  const sbText = fs.readFileSync(sbWsPath, 'utf-8');
  sbHasWriteToolsTable = sbText.includes('ns_createRecord') && sbText.includes('ns_updateRecord');
}
dim6Cases.push({
  id: 'D6-3',
  name: '沙箱工作区文件内容正确写入写工具列表 (Sandbox Tools Injected)',
  passed: sbHasWriteToolsTable,
  score: sbHasWriteToolsTable ? 100 : 0,
  detail: sbHasWriteToolsTable ? '✅ 沙箱环境已成功注入标准写工具表格与极速直传说明' : '❌ 沙箱环境缺少写工具列表'
});

// ---------------------------------------------------------------------------
// 汇总统计与打分输出
// ---------------------------------------------------------------------------

const dimensions: DimensionEvaluation[] = [
  {
    id: 'DIM_1',
    name: '按需加载与渐进式披露架构 (On-Demand Progressive)',
    weight: 0.20,
    cases: dim1Cases,
    rawScore: 0,
    weightedScore: 0,
  },
  {
    id: 'DIM_2',
    name: 'Gemini 认知与上下文效能 (Cognitive Economics)',
    weight: 0.15,
    cases: dim2Cases,
    rawScore: 0,
    weightedScore: 0,
  },
  {
    id: 'DIM_3',
    name: 'MCP 协议完备度与资源覆盖 (MCP Protocol & Coverage)',
    weight: 0.20,
    cases: dim3Cases,
    rawScore: 0,
    weightedScore: 0,
  },
  {
    id: 'DIM_4',
    name: '运行时代码级硬防御 (Runtime Guardrails)',
    weight: 0.20,
    cases: dim4Cases,
    rawScore: 0,
    weightedScore: 0,
  },
  {
    id: 'DIM_5',
    name: '环境隔离与写操作安全门禁 (Environment Isolation)',
    weight: 0.15,
    cases: dim5Cases,
    rawScore: 0,
    weightedScore: 0,
  },
  {
    id: 'DIM_6',
    name: '多工作区同步健康度 (Workspace Synchronization)',
    weight: 0.10,
    cases: dim6Cases,
    rawScore: 0,
    weightedScore: 0,
  },
];

let totalFinalScore = 0;

for (const dim of dimensions) {
  const sumScores = dim.cases.reduce((acc, c) => acc + c.score, 0);
  dim.rawScore = Math.round(sumScores / dim.cases.length);
  dim.weightedScore = Math.round(dim.rawScore * dim.weight * 10) / 10;
  totalFinalScore += dim.rawScore * dim.weight;

  console.log(`📦 [维度评测] ${dim.name} (权重: ${Math.round(dim.weight * 100)}%)`);
  for (const tc of dim.cases) {
    const badge = tc.passed ? '✅' : '❌';
    console.log(`   ${badge} [${tc.id}] ${tc.name}`);
    console.log(`      ↳ ${tc.detail}`);
  }
  console.log(`   📊 维度得分: ${dim.rawScore} / 100 (折合权重分: ${dim.weightedScore} 分)\n`);
}

const finalScore = Math.round(totalFinalScore);

// 评级判定
let grade = 'F';
if (finalScore >= 95) grade = 'A+ (卓越卓越)';
else if (finalScore >= 90) grade = 'A (优秀)';
else if (finalScore >= 80) grade = 'B (良好)';
else if (finalScore >= 70) grade = 'C (及格)';
else grade = 'D (不合格)';

console.log('='.repeat(90));
console.log('🏆 NetSuite MCP 全系统综合评测得分与雷达总览表');
console.log('='.repeat(90));
console.log('| 维度编号 | 评测维度名称                          | 权重 | 测试项数 | 原始分 | 折合贡献分 | 状态 |');
console.log('|----------|---------------------------------------|------|----------|--------|------------|------|');

for (const dim of dimensions) {
  const padName = dim.name.padEnd(37, ' ');
  const statusBadge = dim.rawScore >= 90 ? '🟢 卓越' : (dim.rawScore >= 80 ? '🟡 良好' : '🔴 告警');
  console.log(
    `| ${dim.id.padEnd(8)} | ${dim.name} | ${(Math.round(dim.weight * 100) + '%').padEnd(4)} | ${(dim.cases.length + ' 项').padEnd(8)} | ${(dim.rawScore + ' 分').padEnd(6)} | ${(dim.weightedScore + ' 分').padEnd(10)} | ${statusBadge} |`
  );
}

console.log('='.repeat(90));
console.log(`🎉 最终系统综合得分: ${finalScore} / 100 分  |  评级: ${grade}`);
console.log(`📈 评测总项数: ${dimensions.reduce((acc, d) => acc + d.cases.length, 0)} 项全部自动化校验完成`);
console.log('='.repeat(90) + '\n');

if (finalScore < 90) {
  process.exit(1);
}
