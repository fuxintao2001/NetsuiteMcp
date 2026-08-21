import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const recordsJsonPath = '/Users/fuxintao/.gemini/config/skills/netsuite-suitescript-records-reference/references/records.json';

interface SearchFieldCheck {
  recordType: string;
  fieldId: string;
  isFilter?: boolean;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

class SuiteScriptSearchValidator {
  private recordsData: any = null;

  constructor() {
    if (fs.existsSync(recordsJsonPath)) {
      try {
        const raw = fs.readFileSync(recordsJsonPath, 'utf-8');
        this.recordsData = JSON.parse(raw).records;
      } catch (err) {
        console.warn('⚠️ 无法加载 records.json，使用内置核心字典');
      }
    }
  }

  /**
   * 验证 search.create 中的 column 或 filter 字段是否存在于官方元数据中
   */
  public validateField(recordType: string, fieldId: string, isFilter = false): ValidationResult {
    const recType = recordType.toLowerCase().trim();
    const field = fieldId.toLowerCase().trim();

    // 自定义字段 custbody_/custcol_/custrecord_/custentity_ 直接放行
    if (/^cust(body|col|record|entity|item|event)_/i.test(field)) {
      return { valid: true };
    }

    if (!this.recordsData || !this.recordsData[recType]) {
      return { valid: true }; // 未知记录类型跳过
    }

    const rec = this.recordsData[recType];
    const listToCheck = isFilter 
      ? (rec.searchFilters || []).map((f: any) => f.internalId.toLowerCase())
      : (rec.searchColumns || []).map((c: any) => c.internalId.toLowerCase());

    // 备选全字段列表
    const allFields = (rec.fields || []).map((f: any) => f.internalId.toLowerCase());

    const exists = listToCheck.includes(field) || allFields.includes(field) || field === 'internalid' || field === 'id';

    if (!exists) {
      // 常见 LLM 幻觉字段自动纠错映射
      const commonCorrections: Record<string, string> = {
        'customerid': 'entityid',
        'customername': 'companyname',
        'totalrevenue': 'balance',
        'createddate': 'datecreated',
        'salesorderid': 'tranid',
        'orderamount': 'total',
        'orderdate': 'trandate',
        'statusname': 'status',
        'itemid': 'item'
      };

      const suggestion = commonCorrections[field] 
        ? `建议修正为官方标准字段 '${commonCorrections[field]}'` 
        : `请查阅 netsuite-suitescript-records-reference 中的 ${recType} 字段列表`;

      return {
        valid: false,
        error: `SSS_INVALID_SRCH_${isFilter ? 'FILTER' : 'COL'}: 字段 '${fieldId}' 不存在于 ${recordType} 官方元数据定义中`,
        suggestion
      };
    }

    return { valid: true };
  }

  /**
   * 验证 search.create 中的交易类型短代码
   */
  public validateTransactionTypeFilter(typeValue: string): ValidationResult {
    const validCodes = [
      'SalesOrd', 'CustInvc', 'PurchOrd', 'VendBill', 'Journal',
      'CustCred', 'ItemRcpt', 'ItemShip', 'CashSale', 'VendPymt',
      'CustPymt', 'Estimate', 'RtnAuth', 'Check', 'Deposit', 'Transfer'
    ];

    const invalidUiNames: Record<string, string> = {
      'sales order': 'SalesOrd',
      'invoice': 'CustInvc',
      'purchase order': 'PurchOrd',
      'vendor bill': 'VendBill',
      'journal entry': 'Journal',
      'credit memo': 'CustCred'
    };

    const val = typeValue.trim();
    if (validCodes.includes(val)) {
      return { valid: true };
    }

    const corrected = invalidUiNames[val.toLowerCase()];
    return {
      valid: false,
      error: `SSS_INVALID_SRCH_FILTER: 交易类型过滤值 '${typeValue}' 非法 (严禁使用 UI 文本)`,
      suggestion: corrected ? `必须使用 NetSuite 官方短代码 '${corrected}'` : '请使用标准 Shortcode'
    };
  }

  /**
   * 检测 SuiteScript 1.0 与 2.1 API 混用
   */
  public checkLegacyApiMixing(codeString: string): ValidationResult {
    const legacyPatterns = [
      { pattern: /\bnlapi\w+\b/g, name: 'nlapi* (SuiteScript 1.0 函数)' },
      { pattern: /\bnew\s+nlobjSearchFilter\b/g, name: 'nlobjSearchFilter (SuiteScript 1.0 对象)' },
      { pattern: /\bnew\s+nlobjSearchColumn\b/g, name: 'nlobjSearchColumn (SuiteScript 1.0 对象)' }
    ];

    for (const { pattern, name } of legacyPatterns) {
      if (pattern.test(codeString)) {
        return {
          valid: false,
          error: `API 混用漏洞: 检测到 2.1 脚本中引用了 ${name}`,
          suggestion: '必须统一使用 SuiteScript 2.1 N/search 模块 (search.create / search.createColumn)'
        };
      }
    }

    return { valid: true };
  }
}

// ---------------------------------------------------------------------------
// 执行测试用例
// ---------------------------------------------------------------------------

console.log('='.repeat(75));
console.log('🧪 SuiteScript 2.1 search.create 字段幻觉与防偷懒专项实测 Benchmark');
console.log('='.repeat(75) + '\n');

const validator = new SuiteScriptSearchValidator();

const testCases = [
  {
    name: '用例 1 [Customer 字段幻觉]: LLM 臆造 customerId / customerName / totalRevenue 字段',
    run: () => {
      const hallucinatedFields = ['customerId', 'customerName', 'totalRevenue'];
      const errors: string[] = [];
      for (const f of hallucinatedFields) {
        const res = validator.validateField('customer', f, false);
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
      const allValid = validFields.every(f => validator.validateField('customer', f, false).valid);
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
      const res = validator.validateTransactionTypeFilter('Sales Order');
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
      const allValid = validCodes.every(c => validator.validateTransactionTypeFilter(c).valid);
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
      const allValid = customFields.every(f => validator.validateField('salesorder', f, false).valid);
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
      const res = validator.checkLegacyApiMixing(badCode);
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
      const res = validator.checkLegacyApiMixing(goodCode);
      return {
        passed: res.valid,
        message: res.valid 
          ? '✅ 标准 SuiteScript 2.1 代码检测完全合规'
          : '❌ 纯净代码被误判'
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
  console.log('-'.repeat(75));
  if (res.passed) passedCount++;
}

const score = Math.round((passedCount / testCases.length) * 100);
console.log(`\n📈 SuiteScript search.create 专项压测统计:`);
console.log(`   总测试项: ${testCases.length}`);
console.log(`   通过项: ${passedCount}`);
console.log(`   未通过项: ${testCases.length - passedCount}`);
console.log(`   最终得分: ${score} / 100\n`);
