import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import { isPermissionError } from "../utils/errors.js";
import { unwrapMcpContent } from "../utils/metadata.js";
import { GetScriptLogsArgsSchema } from "./toolSchemas.js";
import { textResult } from "./types.js";

type ToolResponse = CallToolResult;

/**
 * netsuite_get_script_logs
 * Query NetSuite SuiteScript execution logs (ScriptNote) with index optimization.
 */
export async function handleGetScriptLogs(
	args: Record<string, unknown>,
	mcpTools: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = GetScriptLogsArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(`❌ ${parsed.error.issues[0]?.message}`, true);
	}
	const {
		recordType,
		scriptId,
		scriptIds,
		type: logType,
		dateFrom,
		dateTo,
		title,
		detail,
		keyword,
		deploymentId,
		limit: rawLimit,
		format,
	} = parsed.data;

	const limit = Math.min(Math.max(rawLimit ?? 50, 1), 200);

	// Build SELECT with Script info joined for complete visibility
	let sql = `SELECT TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date, sn.type, sn.title, sn.detail, s.scriptid AS scriptScriptId, s.name AS scriptName FROM ScriptNote AS sn LEFT JOIN Script AS s ON sn.scripttype = s.id`;

	// Build WHERE clauses with OWASP input validation & sanitization
	const conditions: string[] = [];

	if (recordType) {
		const cleanRecordType = recordType.trim().toUpperCase();
		if (!/^[A-Z0-9_\-.]+$/.test(cleanRecordType)) {
			return textResult(
				"❌ Invalid recordType format. Only alphanumeric characters, dashes, and underscores are permitted.",
				true,
			);
		}
		const escapedRecordType = cleanRecordType.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype IN (SELECT sd_sub.script FROM ScriptDeployment sd_sub WHERE UPPER(sd_sub.recordtype) = '${escapedRecordType}')`,
		);
	}

	const targetScriptIds = [
		...(scriptId ? [scriptId.trim()] : []),
		...(scriptIds || []).map((s) => s.trim()),
	];
	if (targetScriptIds.length > 0) {
		for (const id of targetScriptIds) {
			if (!/^[a-zA-Z0-9_\-.]+$/.test(id)) {
				return textResult(
					"❌ Invalid scriptId format. Only alphanumeric characters, dashes, and underscores are permitted.",
					true,
				);
			}
		}
		const escapedIds = targetScriptIds.map(
			(id) => `'${id.toUpperCase().replace(/'/g, "''")}'`,
		);
		if (escapedIds.length === 1) {
			conditions.push(
				`sn.scripttype = (SELECT s_sub.id FROM Script s_sub WHERE UPPER(s_sub.scriptid) = ${escapedIds[0]} FETCH FIRST 1 ROWS ONLY)`,
			);
		} else {
			conditions.push(
				`sn.scripttype IN (SELECT s_sub.id FROM Script s_sub WHERE UPPER(s_sub.scriptid) IN (${escapedIds.join(", ")}))`,
			);
		}
	}
	if (deploymentId) {
		const cleanDeploymentId = deploymentId.trim();
		if (!/^[a-zA-Z0-9_\-.]+$/.test(cleanDeploymentId)) {
			return textResult(
				"❌ Invalid deploymentId format. Only alphanumeric characters, dashes, and underscores are permitted.",
				true,
			);
		}
		const escapedDeploymentId = cleanDeploymentId
			.toUpperCase()
			.replace(/'/g, "''");
		conditions.push(
			`sn.scripttype IN (SELECT sd.script FROM ScriptDeployment sd WHERE UPPER(sd.scriptid) = '${escapedDeploymentId}')`,
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
		conditions.push(`sn.date < TO_DATE('${dateTo}', 'YYYY-MM-DD') + 1`);
	}
	if (title) {
		const escapedTitle = title.slice(0, 100).replace(/'/g, "''");
		conditions.push(`UPPER(sn.title) LIKE UPPER('%${escapedTitle}%')`);
	}
	if (detail) {
		const escapedDetail = detail.slice(0, 100).replace(/'/g, "''");
		conditions.push(`UPPER(sn.detail) LIKE UPPER('%${escapedDetail}%')`);
	}
	if (keyword) {
		const escapedKeyword = keyword.slice(0, 100).replace(/'/g, "''");
		conditions.push(
			`(UPPER(sn.title) LIKE UPPER('%${escapedKeyword}%') OR UPPER(sn.detail) LIKE UPPER('%${escapedKeyword}%'))`,
		);
	}

	if (conditions.length > 0) {
		sql += ` WHERE ${conditions.join(" AND ")}`;
	}

	sql += ` ORDER BY sn.date DESC FETCH FIRST ${limit} ROWS ONLY`;

	try {
		const result = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: sql,
		});

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
						`❌ NetSuite Error: ${errorMsg}\n\n💡 Tip: Accessing script execution logs requires the role to have 'SuiteScript' (ADMI_CUSTOMSCRIPT) permission.`,
						true,
					);
				}
				return textResult(`❌ Failed to query script logs: ${errorMsg}`, true);
			}
		}

		const data = mcpTools.extractDataArray(result);
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

		if (format === "compact_json") {
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
		}

		if (data.length === 0) {
			return textResult(
				"No script logs found matching the specified criteria.",
			);
		}

		let md = `## 📜 SuiteScript Execution Logs (${data.length} entries)\n\n`;

		if (diagnosticSummary) {
			md += `> [!WARNING] **Diagnostic Alert**: ${diagnosticSummary.errorCount} error/emergency log(s) found.\n`;
			md += `> - Latest Script: \`${diagnosticSummary.latestScript}\`\n`;
			md += `> - Latest Time: \`${diagnosticSummary.latestTimestamp}\`\n`;
			md += `> - Title: ${diagnosticSummary.latestTitle}\n`;
			if (diagnosticSummary.latestDetailSnippet) {
				md += `> - Detail: ${diagnosticSummary.latestDetailSnippet}\n`;
			}
			md += "\n";
		}

		md += "| Date | Type | Script | Title | Detail |\n";
		md += "| :--- | :--- | :--- | :--- | :--- |\n";

		for (const row of data) {
			const date = String(row.date || "").trim();
			const type = String(row.type || "").trim();
			const script = String(row.scriptScriptId || row.scriptName || "-").trim();
			const title = String(row.title || "-")
				.replace(/\|/g, "\\|")
				.replace(/[\r\n]+/g, " ")
				.trim();
			let detail = String(row.detail || "-")
				.replace(/\|/g, "\\|")
				.replace(/[\r\n]+/g, " ")
				.trim();
			if (detail.length > 200) {
				detail = `${detail.slice(0, 197)}...`;
			}
			md += `| ${date} | ${type} | ${script} | ${title} | ${detail} |\n`;
		}

		return textResult(md.trim());
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (isPermissionError(msg)) throw err;
		return textResult(`❌ Failed to query script logs: ${msg}`, true);
	}
}
