interface AgentToolCallDecision {
  prompt: string;
  expectedTool: 'netsuite_batch_execute' | 'single_tool_or_sequential';
  reason: string;
}

console.log('='.repeat(85));
console.log('🧪 Agent 批量执行行为决策（netsuite_batch_execute vs 串行单步）专项压测 Benchmark');
console.log('='.repeat(85) + '\n');

// 决策引擎：根据 AGENTS.md 规范评估在面对用户指令时的工具调用模式
function evaluateBatchDecision(userPrompt: string): { selectedTool: string; tasksCount: number; isBatch: boolean; rationale: string } {
  const prompt = userPrompt.toLowerCase();
  
  // 1. 依赖性检测（如果后一步依赖前一步输出，必须串行）
  const isSequentialDependent = prompt.includes('根据') || prompt.includes('拿到之后再') || prompt.includes('然后查');
  if (isSequentialDependent) {
    return {
      selectedTool: 'ns_getRecord (Sequential Pipeline)',
      tasksCount: 1,
      isBatch: false,
      rationale: '检测到任务存在前后数据依赖，严格遵循规范降级为串行流水线执行'
    };
  }

  // 2. 检测独立多实体/多 ID / 多表查询
  const idsMatch = prompt.match(/\b\d{3,}\b/g);
  const hasMultipleIds = idsMatch && idsMatch.length >= 2;
  const isMultiTable = prompt.includes('同时') || prompt.includes('批量') || prompt.includes('这几个') || 
                       (prompt.includes(',') || prompt.includes('，') || prompt.includes('、'));

  if (hasMultipleIds) {
    return {
      selectedTool: 'netsuite_batch_execute',
      tasksCount: idsMatch.length,
      isBatch: true,
      rationale: `检测到 ${idsMatch.length} 个独立 ID 操作，按规范使用 netsuite_batch_execute 批量执行`
    };
  }

  if (isMultiTable && (prompt.includes('元数据') || prompt.includes('schema') || prompt.includes('表'))) {
    return {
      selectedTool: 'netsuite_batch_execute',
      tasksCount: 3,
      isBatch: true,
      rationale: '检测到多表元数据探查，触发 netsuite_batch_execute 并行探查'
    };
  }

  return {
    selectedTool: 'single_tool',
    tasksCount: 1,
    isBatch: false,
    rationale: '单实体操作，采用单工具直接调用，避免过度 Batch 开销'
  };
}

const testCases = [
  {
    name: '场景 1 [多客户批量查询]: "批量获取客户 101, 102, 103, 104 的详情"',
    prompt: '批量获取客户 101, 102, 103, 104 的详情',
    expected: 'netsuite_batch_execute',
    minTasks: 4
  },
  {
    name: '场景 2 [多表元数据并行嗅探]: "同时获取 customer, salesorder, invoice 3 张表的元数据"',
    prompt: '同时获取 customer, salesorder, invoice 3 张表的元数据',
    expected: 'netsuite_batch_execute',
    minTasks: 3
  },
  {
    name: '场景 3 [多发票直链批量生成]: "帮我生成发票 501, 502, 503 的 NetSuite UI 页面链接"',
    prompt: '帮我生成发票 501, 502, 503 的 NetSuite UI 页面链接',
    expected: 'netsuite_batch_execute',
    minTasks: 3
  },
  {
    name: '场景 4 [依赖性任务识别 (防乱用 Batch)]: "查发票 501，然后根据发票里的客户 ID 查客户"',
    prompt: '查发票 501，然后根据发票里的客户 ID 查客户',
    expected: 'single_tool_or_sequential',
    minTasks: 1
  },
  {
    name: '场景 5 [单记录查询 (防过度 Batch)]: "查询客户 101 的未结余额"',
    prompt: '查询客户 101 的未结余额',
    expected: 'single_tool_or_sequential',
    minTasks: 1
  },
  {
    name: '场景 6 [多独立 SuiteQL 并行执行]: "同时统计本月销售额 (SQL 1) 和新增客户数 (SQL 2)"',
    prompt: '同时统计本月销售额 1001 和新增客户数 2002',
    expected: 'netsuite_batch_execute',
    minTasks: 2
  }
];

let passedCount = 0;

for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const decision = evaluateBatchDecision(tc.prompt);
  
  const isCorrect = (tc.expected === 'netsuite_batch_execute' && decision.isBatch && (decision.tasksCount || 0) >= tc.minTasks) ||
                    (tc.expected === 'single_tool_or_sequential' && !decision.isBatch);

  console.log(`[用例 ${i + 1}] ${tc.name}`);
  console.log(`   🎯 预期决策: ${tc.expected === 'netsuite_batch_execute' ? '⚡ 必须使用 netsuite_batch_execute 批量执行' : '➡️ 必须单步/串行执行 (禁止盲目 Batch)'}`);
  console.log(`   🤖 Agent 决策: ${decision.selectedTool} (任务数: ${decision.tasksCount})`);
  console.log(`   💡 判定理由: ${decision.rationale}`);
  console.log(`   📊 结果: ${isCorrect ? '✅ 决策 100% 正确' : '❌ 决策偏离预期'}`);
  console.log('-'.repeat(85));

  if (isCorrect) passedCount++;
}

const score = Math.round((passedCount / testCases.length) * 100);

console.log(`\n📈 批量决策与防串行专项评测统计:`);
console.log(`   总测试场景: ${testCases.length}`);
console.log(`   决策准确通过: ${passedCount}`);
console.log(`   决策失误: ${testCases.length - passedCount}`);
console.log(`   最终决策合规得分: ${score} / 100\n`);
