import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import { unwrapMcpContent } from "../utils/metadata.js";
import { suiteqlTemplateService } from "../utils/suiteqlTemplates.js";
import {
	GetQueryTemplateArgsSchema,
	GetScriptLogsArgsSchema,
} from "./toolSchemas.js";

type ToolResponse = CallToolResult;

function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

export async function handleGetScriptLogs(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = GetScriptLogsArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(`❌ ${parsed.error.issues[0]?.message}`, true);
	}
	const {
		scriptId,
		type: logType,
		dateFrom,
		dateTo,
		title,
		detail,
		deploymentId,
		limit,
	} = parsed.data;

	// Build SELECT with Script info joined for complete visibility (explicit second-level timestamp formatting)
	let sql = `SELECT TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date, sn.type, sn.title, sn.detail, s.scriptid AS scriptScriptId, s.name AS scriptName FROM ScriptNote AS sn LEFT JOIN Script AS s ON sn.scripttype = s.id`;

	// Build WHERE clauses with OWASP input validation & sanitization
	const conditions: string[] = [];

	if (scriptId) {
		const cleanScriptId = scriptId.trim();
		if (!/^[a-zA-Z0-9_\-.]+$/.test(cleanScriptId)) {
			return textResult(
				"❌ Invalid scriptId format. Only alphanumeric characters, dashes, and underscores are permitted.",
				true,
			);
		}
		const escapedScriptId = cleanScriptId.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype = (SELECT s_sub.id FROM Script s_sub WHERE s_sub.scriptid = '${escapedScriptId}' FETCH FIRST 1 ROWS ONLY)`,
		);
	}
	if (deploymentId) {
		const cleanDeploymentId = deploymentId.trim();
		if (!/^[a-zA-Z0-9_\-.]+$/.test(cleanDeploymentId)) {
			return textResult(
				"❌ Invalid deploymentId format. Only alphanumeric characters, dashes, and underscores are permitted.",
				true,
			);
		}
		const escapedDeploymentId = cleanDeploymentId.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype IN (SELECT sd.script FROM ScriptDeployment sd WHERE sd.scriptid = '${escapedDeploymentId}')`,
		);
	}
	if (logType) {
		const cleanLogType = logType.trim().toUpperCase();
		if (!/^[A-Z_]+$/.test(cleanLogType)) {
			return textResult("❌ Invalid log type format.", true);
		}
		conditions.push(`sn.type = '${cleanLogType}'`);
	}
	if (dateFrom) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
			return textResult(
				"❌ Invalid dateFrom format. Expected YYYY-MM-DD.",
				true,
			);
		}
		conditions.push(`sn.date >= TO_DATE('${dateFrom}', 'YYYY-MM-DD')`);
	} else if (!dateTo) {
		// SAFE Guide performance optimization: partition pruning defaults to last 7 days
		conditions.push("sn.date >= SYSDATE - 7");
	}
	if (dateTo) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
			return textResult("❌ Invalid dateTo format. Expected YYYY-MM-DD.", true);
		}
		// Include the full day of dateTo (up to 23:59:59) by checking < dateTo + 1
		conditions.push(`sn.date < TO_DATE('${dateTo}', 'YYYY-MM-DD') + 1`);
	}
	if (title) {
		const escapedTitle = title.slice(0, 100).replace(/'/g, "''");
		conditions.push(`UPPER(sn.title) LIKE UPPER('%${escapedTitle}%')`);
	}
	if (detail) {
		const escapedDetail = detail.slice(0, 200).replace(/'/g, "''");
		conditions.push(`UPPER(sn.detail) LIKE UPPER('%${escapedDetail}%')`);
	}

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	sql += ` ORDER BY sn.date DESC FETCH FIRST ${limit} ROWS ONLY`;

	try {
		const result = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: sql,
		});

		// Check if SuiteQL returned a NetSuite-level error JSON payload
		const parsedResult = unwrapMcpContent(result) as Record<
			string,
			unknown
		> | null;

		if (parsedResult && typeof parsedResult === "object") {
			if (parsedResult.error || parsedResult.success === false) {
				const errorMsg = String(
					parsedResult.error ||
						parsedResult.message ||
						JSON.stringify(parsedResult),
				);
				if (
					errorMsg.includes("Record 'ScriptNote' was not found") ||
					errorMsg.includes("Record 'Script' was not found")
				) {
					return textResult(
						`❌ NetSuite Error: ${errorMsg}\n\n💡 Tip: Accessing script execution logs (ScriptNote table) requires the current NetSuite role to have the 'SuiteScript' (ADMI_CUSTOMSCRIPT) permission with at least 'View' level under Permissions > Setup.`,
						true,
					);
				}
				return textResult(`❌ Failed to query script logs: ${errorMsg}`, true);
			}
		}

		const data = mcpTools.extractDataArray(result);

		// If errors exist, add structured diagnostic summary inside JSON payload
		const errors = data.filter(
			(d) =>
				typeof d === "object" &&
				d !== null &&
				(d.type === "ERROR" || d.type === "EMERGENCY"),
		);
		let diagnosticSummary: Record<string, unknown> | undefined;
		const latest = errors[0] as Record<string, unknown> | undefined;
		if (latest) {
			diagnosticSummary = {
				errorCount: errors.length,
				latestScript: latest.scriptScriptId || latest.scriptName || "Unknown",
				latestTimestamp: latest.date,
				latestTitle: latest.title,
				latestDetailSnippet: String(latest.detail || "").slice(0, 200),
			};
		}

		return textResult(
			JSON.stringify(
				{
					totalResults: data.length,
					...(diagnosticSummary ? { diagnosticSummary } : {}),
					query: sql,
					data,
				},
				null,
				2,
			),
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ Failed to query script logs: ${msg}`, true);
	}
}

export async function handleGetQueryTemplate(
	args: Record<string, unknown>,
): Promise<ToolResponse> {
	const parsed = GetQueryTemplateArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const { templateId, category, search } = parsed.data;

	if (templateId) {
		const tmpl = suiteqlTemplateService.getTemplate(templateId);
		if (!tmpl) {
			return textResult(`❌ Template '${templateId}' not found.`, true);
		}

		let md = `## 💎 SuiteQL Template: ${tmpl.name} (\`${tmpl.id}\`)\n\n`;
		md += `**Category**: \`${tmpl.category}\`  \n`;
		md += `**Source**: ${tmpl.officialSource}  \n\n`;
		md += `> ${tmpl.description}\n\n`;
		md += `### 📝 SQL Template\n\`\`\`sql\n${tmpl.sqlTemplate}\n\`\`\`\n\n`;
		md += `### ⚙️ Parameters\n| Parameter | Description |\n|---|---|\n`;
		for (const [param, desc] of Object.entries(tmpl.params)) {
			md += `| \`${param}\` | ${desc} |\n`;
		}
		md += `\n### 🛡️ SAFE Best Practices\n`;
		for (const bp of tmpl.bestPractices) {
			md += `- ${bp}\n`;
		}
		return textResult(md);
	}

	let templates = suiteqlTemplateService.listTemplates(category);
	if (search) {
		templates = suiteqlTemplateService.searchTemplates(search);
	}

	let md = `## 📚 Curated SuiteQL Templates (${templates.length} available)\n\n`;
	md += `| ID | Name | Category | Description |\n|---|---|---|---|\n`;
	for (const t of templates) {
		md += `| \`${t.id}\` | ${t.name} | \`${t.category}\` | ${t.description.slice(0, 70)}... |\n`;
	}
	md += `\n💡 Call with \`{ templateId: '...' }\` to retrieve full SQL and parameter guidance.`;
	return textResult(md);
}
