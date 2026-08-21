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
};

export const SuiteScriptSearchValidator = suiteScriptSearchValidator;
