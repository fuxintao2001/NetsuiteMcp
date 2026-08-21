import { SuiteScriptSearchValidator } from '../src/utils/searchValidator.js';

console.log('='.repeat(80));
console.log('🧪 SuiteScript 2.1 search.create 全场景字段幻觉与防偷懒深度压测 Benchmark');
console.log('='.repeat(80) + '\n');

const testCases = [
  {
    name: '用例 1 [Customer 字段幻觉]: LLM 臆造 customerId / customerName / totalRevenue 字段',
    run: () => {
      const hallucinatedFields = ['customerId', 'customerName', 'totalRevenue'];
      const errors: string[] = [];
      for (const f of hallucinatedFields) {
        const res = SuiteScriptSearchValidator.validateField('customer', f, false);
        if (!res.valid) errors.push(`${f} ➔ ${res.suggestion}`);
      }
      return {
        passed: errors.length === 3,
        message: errors.length === 3 
          ? `✅ 成功识别并拦截 3 个幻觉字段:\n      • ${errors.join('\n      • ')}`
          : '❌ 存在未识别字段'
      };
    }
  },
  {
    name: '用例 2 [Customer 官方标准字段]: 使用 entityid / companyname / email / balance',
    run: () => {
      const validFields = ['entityid', 'companyname', 'email', 'balance', 'datecreated'];
      const allValid = validFields.every(f => SuiteScriptSearchValidator.validateField('customer', f, false).valid);
      return {
        passed: allValid,
        message: allValid 
          ? `✅ 官方标准字段 [${validFields.join(', ')}] 100% 校验通过` 
          : '❌ 合法字段被误杀'
      };
    }
  },
  {
    name: '用例 3 [Transaction 过滤值偷懒]: 使用 UI 显示名 "Sales Order" 代替短代码',
    run: () => {
      const res = SuiteScriptSearchValidator.validateTransactionType('Sales Order');
      return {
        passed: !res.valid,
        message: !res.valid 
          ? `✅ 成功硬拦截非法 UI 名称: "${res.error}"\n      💡 修复建议: ${res.suggestion}`
          : '❌ 漏洞：放行了非法交易类型'
      };
    }
  },
  {
    name: '用例 4 [Transaction 官方短代码]: 使用 SalesOrd / CustInvc / PurchOrd',
    run: () => {
      const validCodes = ['SalesOrd', 'CustInvc', 'PurchOrd'];
      const allValid = validCodes.every(c => SuiteScriptSearchValidator.validateTransactionType(c).valid);
      return {
        passed: allValid,
        message: allValid 
          ? `✅ 官方标准 Shortcodes [${validCodes.join(', ')}] 100% 校验通过`
          : '❌ 合法短代码被误判'
      };
    }
  },
  {
    name: '用例 5 [自定义字段规范放行]: custbody_approval_status / custentity_tax_id',
    run: () => {
      const customFields = ['custbody_approval_status', 'custentity_tax_id', 'custcol_discount_code'];
      const allValid = customFields.every(f => SuiteScriptSearchValidator.validateField('salesorder', f, false).valid);
      return {
        passed: allValid,
        message: allValid 
          ? `✅ 自定义字段 (custbody/custentity/custcol) 正常识别并放行`
          : '❌ 自定义字段被误杀'
      };
    }
  },
  {
    name: '用例 6 [SuiteScript 1.0/2.1 混用拦截]: 2.1 脚本中偷懒混入 nlobjSearchFilter',
    run: () => {
      const badCode = `
        const mySearch = search.create({
          type: search.Type.CUSTOMER,
          filters: [new nlobjSearchFilter('email', null, 'is', 'test@test.com')]
        });
      `;
      const res = SuiteScriptSearchValidator.checkLegacyApiMixing(badCode);
      return {
        passed: !res.valid,
        message: !res.valid 
          ? `✅ 成功硬拦截 1.0 混用: "${res.error}"\n      💡 修复建议: ${res.suggestion}`
          : '❌ 漏洞：未能检测出 1.0/2.1 API 混用'
      };
    }
  },
  {
    name: '用例 7 [纯净 SuiteScript 2.1 规范代码]: 验证标准 search.create 模块调用',
    run: () => {
      const goodCode = `
        define(['N/search'], function(search) {
          return {
            execute: function() {
              return search.create({
                type: search.Type.TRANSACTION,
                filters: [
                  ['type', 'anyof', 'SalesOrd'],
                  'AND',
                  ['mainline', 'is', 'T']
                ],
                columns: ['tranid', 'entity', 'amount', 'trandate']
              }).run().getRange({ start: 0, end: 50 });
            }
          };
        });
      `;
      const res = SuiteScriptSearchValidator.checkLegacyApiMixing(goodCode);
      return {
        passed: res.valid,
        message: res.valid 
          ? '✅ 标准 SuiteScript 2.1 代码检测完全合规'
          : '❌ 纯净代码被误判'
      };
    }
  },
  {
    name: '用例 8 [搜索汇总类型偷懒]: 使用非法汇总名称 TOTAL / SUMMATION',
    run: () => {
      const res1 = SuiteScriptSearchValidator.validateSummaryType('TOTAL');
      const res2 = SuiteScriptSearchValidator.validateSummaryType('SUM');
      const passed = !res1.valid && res2.valid;
      return {
        passed,
        message: passed 
          ? `✅ 成功拦截非法汇总 TOTAL 并提示: ${res1.suggestion}`
          : '❌ 汇总校验失败'
      };
    }
  },
  {
    name: '用例 9 [公式列名拼写错误]: 使用 formula_currency / textformula 错误命名',
    run: () => {
      const res1 = SuiteScriptSearchValidator.validateFormulaField('formula_currency');
      const res2 = SuiteScriptSearchValidator.validateFormulaField('formulacurrency');
      const passed = !res1.valid && res2.valid;
      return {
        passed,
        message: passed 
          ? `✅ 成功拦截 formula_currency 并修正为: ${res1.suggestion}`
          : '❌ 公式字段名校验失败'
      };
    }
  },
  {
    name: '用例 10 [记录类型大小写错误]: 传入驼峰命名 salesOrder / PurchaseOrder',
    run: () => {
      const res1 = SuiteScriptSearchValidator.validateRecordTypeString('salesOrder');
      const res2 = SuiteScriptSearchValidator.validateRecordTypeString('salesorder');
      const passed = !res1.valid && res2.valid;
      return {
        passed,
        message: passed 
          ? `✅ 成功拦截驼峰大小写并提示: ${res1.suggestion}`
          : '❌ 记录类型大小写校验失败'
      };
    }
  },
  {
    name: '用例 11 [子列表字段缩写偷懒]: 在 item 子列表中使用 qty / unitprice',
    run: () => {
      const res1 = SuiteScriptSearchValidator.validateSublistField('salesorder', 'item', 'qty');
      const res2 = SuiteScriptSearchValidator.validateSublistField('salesorder', 'item', 'unitprice');
      const res3 = SuiteScriptSearchValidator.validateSublistField('salesorder', 'item', 'quantity');
      const passed = !res1.valid && !res2.valid && res3.valid;
      return {
        passed,
        message: passed 
          ? `✅ 成功拦截缩写 qty (建议: quantity) 和 unitprice (建议: rate)`
          : '❌ 子列表字段校验失败'
      };
    }
  },
  {
    name: '用例 12 [过滤连接符格式错误]: 在 Filter 表达式中使用小写 "and" 或 "&&"',
    run: () => {
      const res1 = SuiteScriptSearchValidator.validateFilterConnector('and');
      const res2 = SuiteScriptSearchValidator.validateFilterConnector('&&');
      const res3 = SuiteScriptSearchValidator.validateFilterConnector('AND');
      const passed = !res1.valid && !res2.valid && res3.valid;
      return {
        passed,
        message: passed 
          ? `✅ 成功拦截小写 and 与符号 &&，强制要求大写 'AND' / 'OR'`
          : '❌ 过滤连接符校验失败'
      };
    }
  }
];

let passedCount = 0;
for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const res = tc.run();
  console.log(`[${i + 1}] ${tc.name}`);
  console.log(`   ${res.message}`);
  console.log('-'.repeat(80));
  if (res.passed) passedCount++;
}

const score = Math.round((passedCount / testCases.length) * 100);
console.log(`\n📈 SuiteScript search.create 全场景专项压测统计:`);
console.log(`   总测试项: ${testCases.length}`);
console.log(`   通过项: ${passedCount}`);
console.log(`   未通过项: ${testCases.length - passedCount}`);
console.log(`   最终得分: ${score} / 100\n`);
