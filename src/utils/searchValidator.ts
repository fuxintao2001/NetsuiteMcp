import fs from "node:fs";
import path from "node:path";
import { getSkillsDir } from "./environment.js";

export interface SearchValidationResult {
	valid: boolean;
	error?: string;
	suggestion?: string;
}

interface RecordFieldDef {
	internalId: string;
	label?: string;
	type?: string;
}

interface RecordTypeDef {
	internalId?: string;
	fields?: RecordFieldDef[];
	searchFilters?: RecordFieldDef[];
	searchColumns?: RecordFieldDef[];
}

const COMMON_HALLUCINATION_MAP: Record<string, string> = {
	customerid: "entityid",
	customername: "companyname",
	totalrevenue: "balance",
	createddate: "datecreated",
	salesorderid: "tranid",
	orderamount: "total",
	orderdate: "trandate",
	statusname: "status",
	itemid: "item",
};

const TRANSACTION_SHORTCODE_MAP: Record<string, string> = {
	"sales order": "SalesOrd",
	invoice: "CustInvc",
	"purchase order": "PurchOrd",
	"vendor bill": "VendBill",
	"journal entry": "Journal",
	"credit memo": "CustCred",
	"item fulfillment": "ItemShip",
	"item receipt": "ItemRcpt",
	"cash sale": "CashSale",
	"customer payment": "CustPymt",
	"vendor payment": "VendPymt",
};

const VALID_TRANSACTION_CODES = new Set([
	"SalesOrd",
	"CustInvc",
	"PurchOrd",
	"VendBill",
	"Journal",
	"CustCred",
	"ItemRcpt",
	"ItemShip",
	"CashSale",
	"VendPymt",
	"CustPymt",
	"Estimate",
	"RtnAuth",
	"Check",
	"Deposit",
	"Transfer",
]);

let recordsCache: Record<string, RecordTypeDef> | null = null;

function loadRecords(): Record<string, RecordTypeDef> | null {
	if (recordsCache) return recordsCache;
	try {
		const skillsDir = getSkillsDir();
		const homedir = process.env.HOME || process.env.USERPROFILE || "";
		const candidates = [
			path.join(
				skillsDir,
				"netsuite-suitescript-records-reference",
				"references",
				"records.json",
			),
			path.join(
				homedir,
				".gemini",
				"config",
				"skills",
				"netsuite-suitescript-records-reference",
				"references",
				"records.json",
			),
		];
		for (const recordsPath of candidates) {
			if (fs.existsSync(recordsPath)) {
				const raw = fs.readFileSync(recordsPath, "utf-8");
				recordsCache = JSON.parse(raw).records || {};
				break;
			}
		}
	} catch {
		recordsCache = {};
	}
	return recordsCache;
}

export const suiteScriptSearchValidator = {
	/**
	 * Validate whether a search column or filter field ID is valid.
	 */
	validateField(
		recordType: string,
		fieldId: string,
		isFilter = false,
	): SearchValidationResult {
		const recType = recordType.toLowerCase().trim();
		const field = fieldId.toLowerCase().trim();

		// Allow all custom fields (custbody_, custcol_, custrecord_, custentity_, etc.)
		if (/^cust(body|col|record|entity|item|event)_/i.test(field)) {
			return { valid: true };
		}

		if (field === "internalid" || field === "id") {
			return { valid: true };
		}

		const records = loadRecords();
		if (!records?.[recType]) {
			return { valid: true };
		}

		const rec = records[recType];
		const targetList = isFilter
			? (rec.searchFilters || []).map((f) => f.internalId.toLowerCase())
			: (rec.searchColumns || []).map((c) => c.internalId.toLowerCase());
		const allFields = (rec.fields || []).map((f) => f.internalId.toLowerCase());

		const exists = targetList.includes(field) || allFields.includes(field);
		if (!exists) {
			const suggestion = COMMON_HALLUCINATION_MAP[field]
				? `建议修正为官方标准字段 '${COMMON_HALLUCINATION_MAP[field]}'`
				: `请查阅 netsuite-suitescript-records-reference 中的 ${recType} 字段列表`;

			return {
				valid: false,
				error: `SSS_INVALID_SRCH_${isFilter ? "FILTER" : "COL"}: 字段 '${fieldId}' 不存在于 ${recordType} 官方元数据中`,
				suggestion,
			};
		}

		return { valid: true };
	},

	/**
	 * Validate transaction type filter values (prevent UI label hallucinations like 'Sales Order').
	 */
	validateTransactionType(typeValue: string): SearchValidationResult {
		const trimmed = typeValue.trim();
		if (VALID_TRANSACTION_CODES.has(trimmed)) {
			return { valid: true };
		}

		const corrected = TRANSACTION_SHORTCODE_MAP[trimmed.toLowerCase()];
		return {
			valid: false,
			error: `SSS_INVALID_SRCH_FILTER: 交易类型过滤值 '${typeValue}' 非法 (严禁使用 UI 文本)`,
			suggestion: corrected
				? `必须使用 NetSuite 官方短代码 '${corrected}'`
				: "请使用标准 Shortcode",
		};
	},

	/**
	 * Detect legacy SuiteScript 1.0 mixing in 2.1 code.
	 */
	checkLegacyApiMixing(codeString: string): SearchValidationResult {
		const legacyPatterns = [
			{ pattern: /\bnlapi\w+\b/g, name: "nlapi* (SuiteScript 1.0 函数)" },
			{
				pattern: /\bnew\s+nlobjSearchFilter\b/g,
				name: "nlobjSearchFilter (SuiteScript 1.0 对象)",
			},
			{
				pattern: /\bnew\s+nlobjSearchColumn\b/g,
				name: "nlobjSearchColumn (SuiteScript 1.0 对象)",
			},
		];

		for (const { pattern, name } of legacyPatterns) {
			if (pattern.test(codeString)) {
				return {
					valid: false,
					error: `API 混用漏洞: 检测到 2.1 脚本中引用了 ${name}`,
					suggestion:
						"必须统一使用 SuiteScript 2.1 N/search 模块 (search.create / search.createColumn)",
				};
			}
		}

		return { valid: true };
	},

	/**
	 * Validate search summary aggregation types (SUM, COUNT, GROUP, MAX, MIN, AVG).
	 */
	validateSummaryType(summaryValue: string): SearchValidationResult {
		const trimmed = summaryValue.trim().toUpperCase();
		const validSummaries = new Set([
			"SUM",
			"COUNT",
			"GROUP",
			"MAX",
			"MIN",
			"AVG",
		]);
		if (validSummaries.has(trimmed)) {
			return { valid: true };
		}
		const correctionMap: Record<string, string> = {
			TOTAL: "SUM",
			SUMMATION: "SUM",
			ADD: "SUM",
			COUNT_DISTINCT: "COUNT",
			AVERAGE: "AVG",
			MAXIMUM: "MAX",
			MINIMUM: "MIN",
		};
		const suggestion = correctionMap[trimmed]
			? `建议修正为标准枚举 'search.Summary.${correctionMap[trimmed]}' (${correctionMap[trimmed]})`
			: "支持的汇总类型包括: SUM, COUNT, GROUP, MAX, MIN, AVG";
		return {
			valid: false,
			error: `SSS_INVALID_SRCH_SUMMARY: 汇总类型 '${summaryValue}' 非法`,
			suggestion,
		};
	},

	/**
	 * Validate search formula column names (formulatext, formulanumeric, formulacurrency, etc.).
	 */
	validateFormulaField(formulaField: string): SearchValidationResult {
		const trimmed = formulaField.toLowerCase().trim();
		const validFormulas = new Set([
			"formulatext",
			"formulanumeric",
			"formulacurrency",
			"formuladate",
			"formuladatetime",
			"formulapercent",
		]);
		if (validFormulas.has(trimmed)) {
			return { valid: true };
		}
		const typoMap: Record<string, string> = {
			formula_text: "formulatext",
			textformula: "formulatext",
			formula_currency: "formulacurrency",
			currencyformula: "formulacurrency",
			formula_numeric: "formulanumeric",
			numberformula: "formulanumeric",
			numericformula: "formulanumeric",
		};
		const suggestion = typoMap[trimmed]
			? `建议修正为标准公式字段名 '${typoMap[trimmed]}'`
			: "公式字段名格式应为: formulatext, formulanumeric, formulacurrency, formuladate 等";
		return {
			valid: false,
			error: `SSS_INVALID_SRCH_FORMULA: 公式列名 '${formulaField}' 非法`,
			suggestion,
		};
	},

	/**
	 * Validate record type string casing (must be lowercase, not camelCase or PascalCase).
	 */
	validateRecordTypeString(recordTypeStr: string): SearchValidationResult {
		const trimmed = recordTypeStr.trim();
		// If it has uppercase letters and is not all caps enum
		if (/[A-Z]/.test(trimmed) && trimmed !== trimmed.toUpperCase()) {
			const lower = trimmed.toLowerCase();
			return {
				valid: false,
				error: `INVALID_RECORD_TYPE_CASING: 记录类型字符串 '${recordTypeStr}' 包含大写字符`,
				suggestion: `SuiteScript 记录类型字符串必须全部小写，请使用 '${lower}' (或使用常量 search.Type / record.Type)`,
			};
		}
		return { valid: true };
	},

	/**
	 * Validate sublist field IDs (e.g. quantity vs qty, rate vs unitprice).
	 */
	validateSublistField(
		_recordType: string,
		sublistId: string,
		fieldId: string,
	): SearchValidationResult {
		const sublist = sublistId.toLowerCase().trim();
		const field = fieldId.toLowerCase().trim();

		// Common sublist field hallucination corrections
		const commonSublistMistakes: Record<string, string> = {
			qty: "quantity",
			unitprice: "rate",
			unit_price: "rate",
			pricelevel: "price",
			price_level: "price",
			tax_code: "taxcode",
			line_id: "line",
			item_id: "item",
		};

		if (commonSublistMistakes[field]) {
			return {
				valid: false,
				error: `SSS_INVALID_SUBLIST_FIELD: 子列表 '${sublist}' 中的字段 '${fieldId}' 非法`,
				suggestion: `建议修正为官方标准子列表字段 '${commonSublistMistakes[field]}'`,
			};
		}

		return { valid: true };
	},

	/**
	 * Validate boolean conjunctions in search filter expressions (AND, OR, NOT).
	 */
	validateFilterConnector(connector: string): SearchValidationResult {
		const trimmed = connector.trim();
		const validConnectors = new Set(["AND", "OR", "NOT"]);
		if (validConnectors.has(trimmed)) {
			return { valid: true };
		}
		if (["and", "or", "not", "&&", "||"].includes(trimmed.toLowerCase())) {
			return {
				valid: false,
				error: `SSS_INVALID_SRCH_FILTER_EXPR: 过滤连接符 '${connector}' 格式错误`,
				suggestion: `SuiteScript 过滤连接符必须是大写字符串 'AND' 或 'OR' 或 'NOT'`,
			};
		}
		return { valid: true };
	},
};

export const SuiteScriptSearchValidator = suiteScriptSearchValidator;
