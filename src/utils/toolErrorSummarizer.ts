import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getDefaultLogsDir } from "./environment.js";
import type { ToolErrorCategory, ToolErrorEntry } from "./toolErrorLogger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SummarizerOptions {
	logsDir?: string | undefined;
	days?: number | undefined;
	tool?: string | undefined;
	category?: ToolErrorCategory | undefined;
	limit?: number | undefined;
}

export interface OptimizationRecommendation {
	area:
		| "SCHEMA_DEFINITION"
		| "SUITEQL_TEMPLATES"
		| "ROLE_PERMISSIONS"
		| "ENVIRONMENT_CONFIG"
		| "SYSTEM_STABILITY";
	priority: "HIGH" | "MEDIUM" | "LOW";
	title: string;
	description: string;
	actionableFix: string;
	affectedTools: string[];
	occurrences: number;
}

export interface ToolErrorSummaryResult {
	timeRange: {
		days: number;
		startDate: string;
		endDate: string;
	};
	totalErrors: number;
	byTool: Record<string, number>;
	byCategory: Record<ToolErrorCategory, number>;
	byEnvironment: Record<string, number>;
	topErrorMessages: Array<{
		message: string;
		count: number;
		tool: string;
		category: ToolErrorCategory;
	}>;
	recommendations: OptimizationRecommendation[];
	recentErrors: ToolErrorEntry[];
}

// ---------------------------------------------------------------------------
// Parser & Collector
// ---------------------------------------------------------------------------

/**
 * Finds log files in the given directory modified or dated within the cutoff window.
 */
export function findRelevantLogFiles(
	logsDir: string,
	cutoffDate: Date,
): string[] {
	if (!fs.existsSync(logsDir)) {
		return [];
	}

	const files = fs.readdirSync(logsDir);
	const matched: string[] = [];

	for (const file of files) {
		if (!file.startsWith("tool-errors") || !/\.(jsonl|log)$/.test(file)) {
			continue;
		}

		const fullPath = path.join(logsDir, file);
		try {
			const stats = fs.statSync(fullPath);
			// Check file mtime against cutoff with 1 day buffer
			if (stats.mtime.getTime() >= cutoffDate.getTime() - 86400000) {
				matched.push(fullPath);
			}
		} catch {
			// Ignore unreadable files
		}
	}

	return matched.sort();
}

/**
 * Parses JSONL log files line-by-line into structured ToolErrorEntry objects.
 */
export async function loadErrorEntries(
	filePaths: string[],
	cutoffDate: Date,
	options: {
		tool?: string | undefined;
		category?: ToolErrorCategory | undefined;
		limit?: number | undefined;
	} = {},
): Promise<ToolErrorEntry[]> {
	const entries: ToolErrorEntry[] = [];
	const limit = options.limit || 5000;

	for (const filePath of filePaths) {
		if (entries.length >= limit) break;

		const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
		const rl = readline.createInterface({
			input: fileStream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of rl) {
			if (!line?.trim()) continue;
			try {
				const raw = JSON.parse(line);
				// Pino attaches fields directly to root or as metadata
				const timestamp = raw.timestamp || raw.time || new Date().toISOString();
				const entryDate = new Date(timestamp);
				if (entryDate < cutoffDate) {
					continue;
				}

				const tool = raw.tool || "unknown_tool";
				const category = (raw.category ||
					"SYSTEM_EXCEPTION") as ToolErrorCategory;

				if (options.tool && tool !== options.tool) {
					continue;
				}
				if (options.category && category !== options.category) {
					continue;
				}

				const entry: ToolErrorEntry = {
					id: raw.id || "unknown_id",
					timestamp:
						typeof timestamp === "string"
							? timestamp
							: new Date(timestamp).toISOString(),
					tool,
					accountId: raw.accountId,
					environment: raw.environment || "Unknown",
					durationMs: raw.durationMs || 0,
					category,
					errorMessage: raw.errorMessage || raw.msg || "Unknown error",
					errorStack: raw.errorStack,
					errorCode: raw.errorCode,
					parameters: (raw.parameters || {}) as Record<string, unknown>,
					guidanceAttached: raw.guidanceAttached,
				};

				entries.push(entry);
				if (entries.length >= limit) break;
			} catch {
				// Skip corrupted lines
			}
		}
	}

	return entries;
}

// ---------------------------------------------------------------------------
// Recommendation Engine
// ---------------------------------------------------------------------------

export function generateRecommendations(
	entries: ToolErrorEntry[],
	byCategory: Record<ToolErrorCategory, number>,
	byTool: Record<string, number>,
): OptimizationRecommendation[] {
	const recs: OptimizationRecommendation[] = [];

	// 1. Argument validation errors
	const valCount = byCategory.ARGUMENT_VALIDATION || 0;
	if (valCount > 0) {
		const valTools = Object.keys(byTool).filter((t) =>
			entries.some((e) => e.tool === t && e.category === "ARGUMENT_VALIDATION"),
		);
		const sampleErr = entries.find(
			(e) => e.category === "ARGUMENT_VALIDATION",
		)?.errorMessage;

		recs.push({
			area: "SCHEMA_DEFINITION",
			priority: "HIGH",
			title: "强化工具入参 Zod 校验与 Prompt 字段描述 (Schema Optimization)",
			description: `检测到 ${valCount} 次参数校验拦截，主要集中于 [${valTools.join(", ")}]。典型错误：${sampleErr || "参数类型或必填项缺失"}。`,
			actionableFix:
				"检查 `src/handlers/toolSchemas.ts` 中的参数描述与 Zod 校验规则，补充参数别名（如 tableName / recordType）或在描述中提供标准 JSON 示例，降低 AI 传参幻觉。",
			affectedTools: valTools,
			occurrences: valCount,
		});
	}

	// 2. SuiteQL syntax & schema reconnaissance
	const suiteqlCount = byCategory.SUITEQL_SYNTAX || 0;
	if (suiteqlCount > 0) {
		const sampleSqlErr = entries.find(
			(e) => e.category === "SUITEQL_SYNTAX",
		)?.errorMessage;

		recs.push({
			area: "SUITEQL_TEMPLATES",
			priority: "HIGH",
			title: "沉淀 SuiteQL 黄金查询模板与预检机制 (Golden Templates)",
			description: `SuiteQL 执行出现 ${suiteqlCount} 次语法或表/字段不存在报错。典型错误：${sampleSqlErr || "字段或表名无效"}。`,
			actionableFix:
				"在 `src/utils/suiteqlTemplates.ts` 中补强常用业务查询模板；提醒 AI 在执行未知表的查询前，优先调用 `ns_getSuiteQLMetadata` 完成表结构勘探（Reconnaissance First）。",
			affectedTools: ["ns_runCustomSuiteQL", "ns_getSuiteQLMetadata"],
			occurrences: suiteqlCount,
		});
	}

	// 3. Permission denied
	const permCount = byCategory.PERMISSION_DENIED || 0;
	if (permCount > 0) {
		const permTools = Object.keys(byTool).filter((t) =>
			entries.some((e) => e.tool === t && e.category === "PERMISSION_DENIED"),
		);

		recs.push({
			area: "ROLE_PERMISSIONS",
			priority: "HIGH",
			title: "补全 NetSuite 集成角色权限清单 (Permissions Audit)",
			description: `记录到 ${permCount} 次 NetSuite 权限拒绝 (403 / INSUFFICIENT_PERMISSION)。涉及工具：[${permTools.join(", ")}]。`,
			actionableFix:
				"参考 `AGENTS.md` 权限硬停止规则，检查 NetSuite 登录角色所赋予的权限。若操作涉及事务表，需确保具备对应事务（如 TRAN_SALESORD）或记录（LIST_CUSTRECORDENTRY）的 View/Edit 权限。",
			affectedTools: permTools,
			occurrences: permCount,
		});
	}

	// 4. Production write block
	const prodBlockCount = byCategory.PRODUCTION_WRITE_BLOCKED || 0;
	if (prodBlockCount > 0) {
		recs.push({
			area: "ENVIRONMENT_CONFIG",
			priority: "MEDIUM",
			title: "核实运行环境与双门禁拦截 (Environment Isolation)",
			description: `检测到 ${prodBlockCount} 次生产环境写入拦截（双门禁防护已成功阻断危险操作）。`,
			actionableFix:
				"确认当前账号 ID 是否正确。如需执行创建或修改记录，请切换至含有 `_SB` 或 `TSTDRV` 的 Sandbox 沙箱环境。",
			affectedTools: ["ns_createRecord", "ns_updateRecord"],
			occurrences: prodBlockCount,
		});
	}

	// 5. Network / Timeout
	const netCount = byCategory.NETWORK_OR_TIMEOUT || 0;
	if (netCount > 0) {
		recs.push({
			area: "SYSTEM_STABILITY",
			priority: "MEDIUM",
			title: "优化网络重试策略与并发限制 (Resilience & Concurrency)",
			description: `检测到 ${netCount} 次网络断连或网关超时报错。`,
			actionableFix:
				"检查 `src/utils/resilience.ts` 中的重试退避配置与并发控制器 `ConcurrencyLimiter`，针对耗时较长的报表查询适当放大超时等待上限。",
			affectedTools: ["ns_runReport", "ns_runCustomSuiteQL"],
			occurrences: netCount,
		});
	}

	// 6. Record not found
	const notFoundCount = byCategory.RECORD_NOT_FOUND || 0;
	if (notFoundCount > 0) {
		recs.push({
			area: "SCHEMA_DEFINITION",
			priority: "LOW",
			title: "记录检索前置存在性校验 (Pre-Lookup Verification)",
			description: `检测到 ${notFoundCount} 次指定主键/RecordId 查无数据报错。`,
			actionableFix:
				"引导 AI 代理在调用 `ns_getRecord` 之前，先利用 SuiteQL 确认主键 ID 的有效性，避免盲目检索已删除记录。",
			affectedTools: ["ns_getRecord", "ns_updateRecord"],
			occurrences: notFoundCount,
		});
	}

	return recs;
}

// ---------------------------------------------------------------------------
// Main Summarizer Function
// ---------------------------------------------------------------------------

/**
 * Summarizes tool execution error logs across a time window and produces actionable recommendations.
 */
export async function summarizeToolErrors(
	options: SummarizerOptions = {},
): Promise<ToolErrorSummaryResult> {
	const days = options.days || 30;
	const logsDir = options.logsDir || getDefaultLogsDir();
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - days);

	const logFiles = findRelevantLogFiles(logsDir, cutoffDate);
	const entries = await loadErrorEntries(logFiles, cutoffDate, options);

	const byTool: Record<string, number> = {};
	const byCategory: Record<ToolErrorCategory, number> = {
		ARGUMENT_VALIDATION: 0,
		SUITEQL_SYNTAX: 0,
		PERMISSION_DENIED: 0,
		RECORD_NOT_FOUND: 0,
		PRODUCTION_WRITE_BLOCKED: 0,
		NETWORK_OR_TIMEOUT: 0,
		NETSUITE_API_ERROR: 0,
		SYSTEM_EXCEPTION: 0,
	};
	const byEnvironment: Record<string, number> = {};
	const messageCounts: Record<
		string,
		{ count: number; tool: string; category: ToolErrorCategory }
	> = {};

	for (const entry of entries) {
		byTool[entry.tool] = (byTool[entry.tool] || 0) + 1;
		byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
		const env = entry.environment || "Unknown";
		byEnvironment[env] = (byEnvironment[env] || 0) + 1;

		// Clean and group message pattern (truncate at 120 chars to cluster)
		const cleanMsg = (entry.errorMessage || "Unknown error")
			.replace(/[\n\r]+/g, " ")
			.slice(0, 120)
			.trim();
		if (!messageCounts[cleanMsg]) {
			messageCounts[cleanMsg] = {
				count: 0,
				tool: entry.tool,
				category: entry.category,
			};
		}
		messageCounts[cleanMsg].count++;
	}

	const topErrorMessages = Object.entries(messageCounts)
		.map(([message, data]) => ({ message, ...data }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 10);

	const recommendations = generateRecommendations(entries, byCategory, byTool);

	// Sort recent errors desc
	const recentErrors = [...entries]
		.sort(
			(a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		)
		.slice(0, 20);

	return {
		timeRange: {
			days,
			startDate: cutoffDate.toISOString().slice(0, 10),
			endDate: new Date().toISOString().slice(0, 10),
		},
		totalErrors: entries.length,
		byTool,
		byCategory,
		byEnvironment,
		topErrorMessages,
		recommendations,
		recentErrors,
	};
}

// ---------------------------------------------------------------------------
// Markdown Report Formatter
// ---------------------------------------------------------------------------

/**
 * Formats the summary result into an enterprise-grade Markdown analysis and optimization report.
 */
export function formatSummaryToMarkdown(
	summary: ToolErrorSummaryResult,
): string {
	const lines: string[] = [];

	lines.push("# 📊 NetSuite MCP 工具调用错误分析与智能优化报告");
	lines.push("");
	lines.push(
		`> **统计周期**：${summary.timeRange.startDate} ~ ${summary.timeRange.endDate}（近 ${summary.timeRange.days} 天） | **累计捕获错误**：\`${summary.totalErrors}\` 次`,
	);
	lines.push("");

	if (summary.totalErrors === 0) {
		lines.push("🎉 **近期未发现任何工具调用错误记录！系统运行状态非常健康。**");
		return lines.join("\n");
	}

	// 1. Overview Table
	lines.push("## 📈 概览统计");
	lines.push("");
	lines.push("| 核心指标 | 统计数值 | 说明 |");
	lines.push("| :--- | :--- | :--- |");
	lines.push(
		`| **错误发生总量** | \`${summary.totalErrors}\` 次 | 工具执行失败或拦截次数 |`,
	);
	lines.push(
		`| **受影响工具数** | \`${Object.keys(summary.byTool).length}\` 个 | 产生过调用报错的 MCP 工具种类 |`,
	);
	lines.push(
		`| **沙箱环境错误** | \`${summary.byEnvironment.Sandbox || 0}\` 次 | Sandbox / Test 环境报错 |`,
	);
	lines.push(
		`| **生产环境错误** | \`${summary.byEnvironment.Production || 0}\` 次 | Production 环境报错（含拦截） |`,
	);
	lines.push("");

	// 2. Breakdown by Tool
	lines.push("## 🔍 工具维度报错排行 (Top Affected Tools)");
	lines.push("");
	lines.push("| MCP 工具名称 | 报错频次 | 占比 |");
	lines.push("| :--- | :--- | :--- |");
	const sortedTools = Object.entries(summary.byTool).sort(
		(a, b) => b[1] - a[1],
	);
	for (const [tool, count] of sortedTools) {
		const pct = ((count / summary.totalErrors) * 100).toFixed(1);
		lines.push(`| \`${tool}\` | **${count}** 次 | ${pct}% |`);
	}
	lines.push("");

	// 3. Breakdown by Category
	lines.push("## 🏷️ 错误类型分类 (Error Categorization)");
	lines.push("");
	lines.push("| 错误分类 | 频次 | 说明 / 场景 |");
	lines.push("| :--- | :--- | :--- |");
	const categoryLabels: Record<ToolErrorCategory, string> = {
		ARGUMENT_VALIDATION: "入参校验失败（Zod 拦截 / 参数格式有误）",
		SUITEQL_SYNTAX: "SuiteQL 语法错误 / 表名列名不存在",
		PERMISSION_DENIED: "NetSuite 权限不足（403 / INSUFFICIENT_PERMISSION）",
		RECORD_NOT_FOUND: "记录不存在 / 无效 ID",
		PRODUCTION_WRITE_BLOCKED: "双门禁阻断（严禁生产环境写入记录）",
		NETWORK_OR_TIMEOUT: "网络超时 / 链接重置",
		NETSUITE_API_ERROR: "NetSuite 业务 API 报错",
		SYSTEM_EXCEPTION: "未捕获的运行时异常",
	};

	const sortedCategories = (
		Object.entries(summary.byCategory) as [ToolErrorCategory, number][]
	)
		.filter(([_, count]) => count > 0)
		.sort((a, b) => b[1] - a[1]);

	for (const [category, count] of sortedCategories) {
		lines.push(
			`| **\`${category}\`** | **${count}** 次 | ${categoryLabels[category] || category} |`,
		);
	}
	lines.push("");

	// 4. Top Error Messages
	if (summary.topErrorMessages.length > 0) {
		lines.push("## ⚠️ 高频错误聚类 (Top Error Patterns)");
		lines.push("");
		lines.push("| 频次 | 所属工具 | 类别 | 错误摘要片段 |");
		lines.push("| :--- | :--- | :--- | :--- |");
		for (const item of summary.topErrorMessages) {
			lines.push(
				`| **${item.count}** | \`${item.tool}\` | \`${item.category}\` | ${item.message} |`,
			);
		}
		lines.push("");
	}

	// 5. Actionable Optimization Recommendations
	lines.push("## 💡 依据实际调用的针对性优化建议 (Actionable Recommendations)");
	lines.push("");
	if (summary.recommendations.length === 0) {
		lines.push("当前暂无特定规则触发，系统整体调用符合预期。");
	} else {
		for (const rec of summary.recommendations) {
			const badge =
				rec.priority === "HIGH"
					? "🔴 HIGH"
					: rec.priority === "MEDIUM"
						? "🟡 MEDIUM"
						: "🟢 LOW";
			lines.push(`### [${badge}] ${rec.title}`);
			lines.push(
				`- **涉及工具**：${rec.affectedTools.map((t) => `\`${t}\``).join(", ")}`,
			);
			lines.push(`- **问题描述**：${rec.description}`);
			lines.push(`- **🔧 具体优化方案**：${rec.actionableFix}`);
			lines.push("");
		}
	}

	// 6. Recent Error Samples
	if (summary.recentErrors.length > 0) {
		lines.push("## ⏱️ 最新错误抽样 (Recent Samples)");
		lines.push("");
		lines.push("<details>");
		lines.push("<summary>点击展开最近 5 条错误详细上下文</summary>");
		lines.push("");
		for (const err of summary.recentErrors.slice(0, 5)) {
			lines.push(
				`#### \`[${err.timestamp}]\` \`${err.tool}\` (${err.category})`,
			);
			lines.push(`- **错误信息**：${err.errorMessage}`);
			lines.push(
				`- **耗时**：${err.durationMs}ms | **环境**：${err.environment} (${err.accountId || "N/A"})`,
			);
			lines.push("```json");
			lines.push(JSON.stringify(err.parameters, null, 2));
			lines.push("```");
			lines.push("");
		}
		lines.push("</details>");
		lines.push("");
	}

	return lines.join("\n");
}
