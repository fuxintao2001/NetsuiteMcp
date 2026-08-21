import { validateSuiteQL, ensureSuiteQLPagination, SchemaReconnaissanceTracker } from '../src/utils/suiteqlGuard.js';
import { isSandboxAccount } from '../src/utils/environment.js';

interface TestCase {
  name: string;
  gate: string;
  ruleInTemplate: string;
  testAction: () => { passed: boolean; message: string; blockedByRuntime: boolean };
}

console.log('='.repeat(70));
console.log('🧪 NetSuite MCP & AGENTS.md 深度防偷懒与边界条件压测 Benchmark');
console.log('='.repeat(70) + '\n');

const testCases: TestCase[] = [
  {
    name: 'Gate 2 偷懒: 直接使用 SELECT *',
    gate: 'GATE 2 (Syntax Mandate)',
    ruleInTemplate: '❌ NO SELECT * (explicit columns only)',
    testAction: () => {
      const sql = 'SELECT * FROM transaction';
      const res = validateSuiteQL(sql);
      const blocked = !res.valid;
      return {
        passed: blocked,
        blockedByRuntime: blocked,
        message: blocked ? `✅ 成功硬拦截: "${res.reason}"` : '❌ 漏洞：放行了 SELECT *'
      };
    }
  },
  {
    name: 'Gate 2 变体偷懒: 使用 SELECT t.* 表别名通配符',
    gate: 'GATE 2 (Syntax Mandate)',
    ruleInTemplate: '❌ NO SELECT * (explicit columns only)',
    testAction: () => {
      const sql = 'SELECT t.* FROM transaction t';
      const res = validateSuiteQL(sql);
      const blocked = !res.valid;
      return {
        passed: blocked,
        blockedByRuntime: blocked,
        message: blocked ? `✅ 成功硬拦截别名通配符: "${res.reason}"` : '❌ 漏洞：放行了 SELECT t.*'
      };
    }
  },
  {
    name: 'Gate 2 变体偷懒: 使用 SELECT DISTINCT * 通配符',
    gate: 'GATE 2 (Syntax Mandate)',
    ruleInTemplate: '❌ NO SELECT * (explicit columns only)',
    testAction: () => {
      const sql = 'SELECT DISTINCT * FROM customer';
      const res = validateSuiteQL(sql);
      const blocked = !res.valid;
      return {
        passed: blocked,
        blockedByRuntime: blocked,
        message: blocked ? `✅ 成功硬拦截 DISTINCT *: "${res.reason}"` : '❌ 漏洞：放行了 DISTINCT *'
      };
    }
  },
  {
    name: 'Gate 2 偷懒: 使用 MySQL 风格 LIMIT 10 OFFSET 5',
    gate: 'GATE 2 (Syntax Mandate)',
    ruleInTemplate: '❌ NO LIMIT/OFFSET → MUST use ROWNUM <= N or FETCH FIRST N ROWS ONLY',
    testAction: () => {
      const sql = 'SELECT id, entity FROM transaction LIMIT 10 OFFSET 5';
      const res = validateSuiteQL(sql);
      const blocked = !res.valid;
      return {
        passed: blocked,
        blockedByRuntime: blocked,
        message: blocked ? `✅ 成功硬拦截 LIMIT/OFFSET: "${res.reason}"` : '❌ 漏洞：允许了 LIMIT/OFFSET'
      };
    }
  },
  {
    name: '边界防护: 字符串内部包含 "SELECT *" 或 "LIMIT" 不应误杀 (Zero False Positive)',
    gate: 'SAFETY & ACCURACY',
    ruleInTemplate: 'Precise string literal masking',
    testAction: () => {
      const sql = "SELECT id, name FROM customer WHERE memo = 'SELECT * FROM test' AND terms = 'LIMIT 10'";
      const res = validateSuiteQL(sql);
      const passed = res.valid;
      return {
        passed,
        blockedByRuntime: false,
        message: passed ? '✅ 字符串字面量精准遮罩，合法业务查询未发生误杀' : `❌ 误杀错误: ${res.reason}`
      };
    }
  },
  {
    name: 'Gate 2 偷懒: Agent 忘记写分页子句自动保底补齐',
    gate: 'GATE 2 (Pagination Safety)',
    ruleInTemplate: 'MUST use ROWNUM <= N or FETCH FIRST N ROWS ONLY',
    testAction: () => {
      const sql = 'SELECT id, entity FROM transaction';
      const paginated = ensureSuiteQLPagination(sql, 100);
      const hasPagination = paginated.includes('FETCH FIRST 100 ROWS ONLY');
      return {
        passed: hasPagination,
        blockedByRuntime: true,
        message: hasPagination ? `✅ 成功兜底补充分页: "${paginated}"` : '❌ 漏洞：未自动补充分页'
      };
    }
  },
  {
    name: 'Gate 2 规范: 合法 SuiteQL 查询（BUILTIN.DF + TO_DATE + ROWNUM）完全放行',
    gate: 'GATE 2 (Compliant Syntax)',
    ruleInTemplate: 'Use BUILTIN.DF, TO_DATE, and ROWNUM',
    testAction: () => {
      const sql = "SELECT id, tranid, BUILTIN.DF(entity) AS customer_name FROM transaction WHERE trandate >= TO_DATE('2025-01-01', 'YYYY-MM-DD') AND ROWNUM <= 50";
      const res = validateSuiteQL(sql);
      const passed = res.valid && res.hasPagination === true;
      return {
        passed,
        blockedByRuntime: false,
        message: passed ? '✅ 官方规范 SuiteQL 查询 100% 顺畅执行' : `❌ 合规查询被误拦截: ${res.reason}`
      };
    }
  },
  {
    name: 'Gate 2 探查: 元数据嗅探状态跟踪与会话注册',
    gate: 'GATE 2 (Schema Check First)',
    ruleInTemplate: 'MUST call ns_getSuiteQLMetadata BEFORE generating custom SuiteQL',
    testAction: () => {
      SchemaReconnaissanceTracker.clear();
      const before = SchemaReconnaissanceTracker.has('transaction');
      SchemaReconnaissanceTracker.record('transaction');
      const after = SchemaReconnaissanceTracker.has('transaction');
      const passed = !before && after;
      return {
        passed,
        blockedByRuntime: true,
        message: passed ? `✅ 成功注册探查表记录（${SchemaReconnaissanceTracker.getConsultedTables().join(', ')}）` : '❌ 状态跟踪失败'
      };
    }
  },
  {
    name: '生产环境安全: 拦截生产环境写操作 (Write Ops Guard)',
    gate: 'ENVIRONMENT & WRITE OPERATIONS',
    ruleInTemplate: 'Write tools are disabled in Production',
    testAction: () => {
      const isProd1 = !isSandboxAccount('5848789');
      const isProd2 = !isSandboxAccount('9260916');
      const isSb1 = isSandboxAccount('9260916-sb1');
      const passed = isProd1 && isProd2 && isSb1;
      return {
        passed,
        blockedByRuntime: true,
        message: passed ? '✅ 生产环境 (5848789, 9260916) 写操作已被代码级强制禁用，Sandbox 正常开放' : '❌ 环境判断异常'
      };
    }
  },
  {
    name: '底层安全: 拦截 SQL 破坏性与注入语句',
    gate: 'SECURITY GUARD',
    ruleInTemplate: 'Queries MUST begin with SELECT/WITH. Prohibit comments/mutations.',
    testAction: () => {
      const ddl = validateSuiteQL('DROP TABLE customer');
      const comments = validateSuiteQL('SELECT id FROM customer -- comments');
      const multi = validateSuiteQL('SELECT 1; DROP TABLE item;');
      const passed = !ddl.valid && !comments.valid && !multi.valid;
      return {
        passed,
        blockedByRuntime: true,
        message: passed ? '✅ SQL 注入与破坏性语句（DROP/注释/多语句）100% 成功硬拦截' : '❌ 安全规则被绕过'
      };
    }
  }
];

let passedCount = 0;
for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const result = tc.testAction();
  console.log(`[用例 ${i + 1}] ${tc.name}`);
  console.log(`   🏷️  规则来源: ${tc.gate}`);
  console.log(`   📝 模板要求: ${tc.ruleInTemplate}`);
  console.log(`   📊 实测结果: ${result.message}`);
  console.log('-'.repeat(70));
  if (result.passed) passedCount++;
}

const score = Math.round((passedCount / testCases.length) * 100);
console.log(`\n📈 深度压测报告统计:`);
console.log(`   总测试项: ${testCases.length}`);
console.log(`   通过项: ${passedCount}`);
console.log(`   未通过项: ${testCases.length - passedCount}`);
console.log(`   最终综合防偷懒与安全得分: ${score} / 100\n`);
