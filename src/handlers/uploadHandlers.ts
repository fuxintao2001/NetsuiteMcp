import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import type { OAuthManager } from "../oauth/manager.js";
import { isSandboxAccount } from "../utils/environment.js";
import {
	generateNetSuiteScriptFileUrl,
	generateNetSuiteSuiteletUrl,
	generateNetSuiteUrl,
} from "../utils/netsuiteUrls.js";
import { suitecloudRunnerService } from "../utils/suitecloudRunner.js";
import { UploadFileArgsSchema } from "./toolSchemas.js";
import { textResult } from "./types.js";

type ToolResponse = CallToolResult;

/**
 * Format target file for confirmation card and summary presentation:
 * Extracts the workspace / account folder name (e.g. 9260916) and filename (e.g. test.js).
 * Example: /Users/fuxintao/WebstormProjects/9260916/src/FileCabinet/SuiteScripts/test.js ➔ 9260916/test.js
 */
export function formatTargetFileDisplay(
	localFullPath: string,
	projectRoot?: string,
): string {
	const fileName = path.basename(localFullPath);

	if (projectRoot?.trim()) {
		const folderName = path.basename(path.resolve(projectRoot));
		if (folderName && folderName !== "." && folderName !== "/") {
			return `${folderName}/${fileName}`;
		}
	}

	const normalized = path.resolve(localFullPath).replace(/\\/g, "/");

	// Check if path contains src/FileCabinet
	const fcIdx = normalized.indexOf("/src/FileCabinet");
	if (fcIdx !== -1) {
		const sub = normalized.substring(0, fcIdx);
		const folderName = path.basename(sub);
		if (folderName) {
			return `${folderName}/${fileName}`;
		}
	}

	// Check for /WebstormProjects/<folder>/ or /projects/<folder>/ or workspace folder
	const wsMatch = normalized.match(
		/(?:WebstormProjects|projects|workspace|workspaces)\/([^/]+)/i,
	);
	if (wsMatch?.[1]) {
		return `${wsMatch[1]}/${fileName}`;
	}

	const parentDir = path.basename(path.dirname(normalized));
	if (parentDir && parentDir !== "." && parentDir !== "/") {
		return `${parentDir}/${fileName}`;
	}

	return fileName;
}

export async function handleUploadFile(
	args: Record<string, unknown>,
	oauthManager: OAuthManager,
	defaultProjectRoot: string,
	mcpTools?: NetSuiteMCPTools,
): Promise<ToolResponse> {
	const parsed = UploadFileArgsSchema.safeParse(args);
	if (!parsed.success) {
		return textResult(
			`❌ Invalid arguments: ${parsed.error.issues[0]?.message}`,
			true,
		);
	}
	const {
		paths,
		projectPath: customProjectPath,
		authId: customAuthId,
		dryRun,
		skipValidation,
		allowProduction,
	} = parsed.data;

	const currentAccountId = (await oauthManager.getAccountId()) || "UNKNOWN";
	const isProd = !isSandboxAccount(currentAccountId);

	// 1. Resolve Project Root
	let firstPathCandidate = Array.isArray(paths) ? paths[0] : paths;
	if (firstPathCandidate && typeof firstPathCandidate === "string") {
		firstPathCandidate = firstPathCandidate.split(/[\s,]+/)[0];
	}

	let resolvedProjectRoot: string;
	if (customProjectPath) {
		resolvedProjectRoot =
			suitecloudRunnerService.searchUpwards(customProjectPath) ||
			path.resolve(customProjectPath);
	} else {
		let candidateStartDir: string | undefined;
		if (firstPathCandidate && path.isAbsolute(firstPathCandidate)) {
			candidateStartDir = path.dirname(firstPathCandidate);
		}
		if (!candidateStartDir) {
			candidateStartDir = defaultProjectRoot;
		}

		resolvedProjectRoot =
			suitecloudRunnerService.findSdfProjectRoot(
				candidateStartDir,
				currentAccountId,
			) || candidateStartDir;
	}

	// 2. Resolve and inspect target files
	const resolution = suitecloudRunnerService.resolveUploadFiles(
		resolvedProjectRoot,
		paths,
		{ skipValidation },
	);

	if (resolution.files.length === 0) {
		return textResult(
			`❌ 未找到待上传的文件。\n` +
				`输入路径: ${JSON.stringify(paths)}\n` +
				`解析工程根目录: \`${resolvedProjectRoot}\`\n` +
				`提示: 请确认文件存在于项目的 FileCabinet 结构下，或直接传入文件的绝对路径。`,
			true,
		);
	}

	// 3. Check for missing files
	const missingFiles = resolution.files.filter((f) => !f.exists);
	if (missingFiles.length > 0) {
		let missingMd = `❌ **部分或全部本地文件未找到 (404 Not Found)**\n\n`;
		missingMd += `SDF 项目根目录: \`${resolvedProjectRoot}\`\n\n`;
		missingMd += `| 请求路径 | 状态 | 详情 |\n|---|---|---|\n`;
		for (const mf of missingFiles) {
			missingMd += `| \`${mf.fileCabinetPath || "未知"}\` | ❌ 不存在 | ${mf.error || "未在项目内定位到对应文件"} |\n`;
		}
		missingMd += `\n💡 **排查建议**：\n`;
		missingMd += `1. 检查文件是否位于 \`${resolvedProjectRoot}/src/FileCabinet/\` 下。\n`;
		missingMd += `2. 可显式指定 \`projectPath\` 参数，例如 \`projectPath: "/path/to/sdf_project"\`。\n`;
		missingMd += `3. 也可以直接传入本地文件的绝对路径。`;
		return textResult(missingMd, true);
	}

	// 4. Pre-flight Syntax & Validation Check (unless skipValidation)
	const invalidFiles = resolution.files.filter((f) => f.syntaxValid === false);
	if (invalidFiles.length > 0 && !skipValidation) {
		let syntaxMd = `🚨 **SuiteScript 代码预检失败 (Pre-flight Syntax Error)**\n\n`;
		syntaxMd += `在尝试上传前，检测到待上传的脚本存在明显的 JavaScript 语法错误，上传到 NetSuite 会导致脚本编译或运行时异常：\n\n`;
		for (const inv of invalidFiles) {
			syntaxMd += `### 📄 \`${inv.fileCabinetPath}\`\n`;
			syntaxMd += `- **本地路径**: \`${inv.localFullPath}\`\n`;
			syntaxMd += `- **语法错误**: \`${inv.syntaxError}\`\n\n`;
		}
		syntaxMd += `💡 **处理方式**：请先修正上述语法错误。若确定无需预检，可指定 \`skipValidation: true\` 强制跳过。`;
		return textResult(syntaxMd, true);
	}

	// 5. SuiteCloud Auth ID Verification and Auto-Synchronization
	const authSync = await suitecloudRunnerService.syncProjectAuthId(
		resolvedProjectRoot,
		currentAccountId,
		customAuthId,
	);

	const effectiveAuthId =
		authSync.matchedAuthId || authSync.configuredAuthId || "UNKNOWN";

	// 6. Production Safety Check (Rule 3)
	const effectiveAuthIsProd =
		effectiveAuthId !== "UNKNOWN" && !isSandboxAccount(effectiveAuthId);
	const targetIsProd = isProd || effectiveAuthIsProd;

	if (targetIsProd && !allowProduction) {
		let prodMd = `🚨 **生产环境安全拦截 (Production Safety Block)**\n\n`;
		if (effectiveAuthIsProd && !isProd) {
			prodMd += `⚠️ 严重警告：当前目标 NetSuite 会话为沙箱环境 (\`${currentAccountId.toUpperCase()}\`)，但项目配置的 Auth ID (\`${effectiveAuthId}\`) 指向**生产环境**！\n`;
			prodMd += `为防止沙箱代码误传生产环境，已被硬拦截。\n\n`;
		} else {
			prodMd += `当前目标 NetSuite 账号为**生产环境** (\`${currentAccountId.toUpperCase()}\`)。\n`;
			prodMd += `为防止误操作覆盖生产代码，需获得用户明确授权。\n\n`;
		}
		prodMd += `### 待上传文件清单（共 ${resolution.files.length} 个文件，${(resolution.totalBytes / 1024).toFixed(2)} KB）：\n`;
		for (const f of resolution.files) {
			const targetDisplay = formatTargetFileDisplay(
				f.localFullPath || f.fileCabinetPath || "",
				resolvedProjectRoot,
			);
			prodMd += `- \`${targetDisplay}\` (${f.fileCabinetPath}, ${f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : 0} KB)\n`;
		}
		prodMd += `\n若用户已明确指示上传到生产环境，请设置 \`allowProduction: true\` 重新调用此工具，即可直接一步执行上传。`;
		return textResult(prodMd, true);
	}

	// Array of normalized FileCabinet paths
	const uploadFcPaths = resolution.files.map((f) => f.fileCabinetPath || "");

	// 7. Dry Run Preview
	if (dryRun) {
		let previewMd = `## 🔍 SuiteCloud File Upload Preview (Dry Run)\n\n`;
		previewMd += `| 配置项 | 详情 |\n|---|---|\n`;
		previewMd += `| **目标账号** | \`${currentAccountId.toUpperCase()}\` (${isProd ? "🚨 PRODUCTION" : "🛡️ SANDBOX"}) |\n`;
		previewMd += `| **SDF 项目目录** | \`${resolvedProjectRoot}\` |\n`;
		previewMd += `| **SuiteCloud Auth ID** | \`${effectiveAuthId}\` ${authSync.autoUpdated ? "(已自动对齐)" : ""} |\n`;
		previewMd += `| **文件总数 / 总大小** | ${resolution.files.length} 个文件 / ${(resolution.totalBytes / 1024).toFixed(2)} KB |\n`;
		previewMd += `| **执行命令预览** | \`suitecloud file:upload --paths "${uploadFcPaths.join(" ")}"\` |\n\n`;

		previewMd += `### 📋 文件详情清单\n\n`;
		previewMd += `| # | File Cabinet 目标路径 | 本地文件位置 | 大小 | 脚本类型 / API 版本 | 预检状态 |\n|---|---|---|---|---|---|\n`;
		resolution.files.forEach((f, idx) => {
			const sizeKb =
				f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : "0";
			const scriptInfo =
				[f.scriptType, f.apiVersion ? `v${f.apiVersion}` : ""]
					.filter(Boolean)
					.join(" / ") || "-";
			const status = f.syntaxValid === false ? "❌ 语法错误" : "✅ 正常";
			previewMd += `| ${idx + 1} | \`${f.fileCabinetPath}\` | \`${f.localFullPath}\` | ${sizeKb} KB | ${scriptInfo} | ${status} |\n`;
		});

		if (authSync.warning) {
			previewMd += `\n> [!WARNING]\n> ${authSync.warning}\n`;
		}
		if (resolution.warnings.length > 0) {
			previewMd += `\n> [!NOTE]\n> ${resolution.warnings.join("\n> ")}\n`;
		}

		return textResult(previewMd);
	}

	// 8. Synchronize external source files into resolvedProjectRoot if execution directory was switched
	const fileCabinetRoot = path.join(resolvedProjectRoot, "src", "FileCabinet");
	const syncedFiles: string[] = [];
	for (const f of resolution.files) {
		if (f.exists && f.localFullPath && f.fileCabinetPath) {
			const cleanFcPath = f.fileCabinetPath.replace(/^\/+/, "");
			const expectedInRoot = path.resolve(fileCabinetRoot, cleanFcPath);
			const rel = path.relative(fileCabinetRoot, expectedInRoot);
			if (rel.startsWith("..") || path.isAbsolute(rel)) {
				return textResult(
					`🚨 **路径安全拦截**: 检测到非法路径穿越 '${f.fileCabinetPath}'，禁止写入 FileCabinet 目录之外。`,
					true,
				);
			}
			if (path.resolve(f.localFullPath) !== expectedInRoot) {
				const targetDir = path.dirname(expectedInRoot);
				if (!fs.existsSync(targetDir)) {
					fs.mkdirSync(targetDir, { recursive: true });
				}
				fs.copyFileSync(f.localFullPath, expectedInRoot);
				syncedFiles.push(f.fileCabinetPath);
			}
		}
	}

	// 9. Execute the upload via SuiteCloud CLI
	const execResult = await suitecloudRunnerService.executeUpload(
		resolvedProjectRoot,
		uploadFcPaths,
		{
			targetAccountId: currentAccountId,
			authId: effectiveAuthId,
		},
	);

	if (!execResult.success) {
		let errorMd = `❌ **SuiteCloud Upload 失败 (耗时: ${execResult.executionTimeMs}ms)**\n\n`;
		errorMd += `- **目标账号**: \`${currentAccountId.toUpperCase()}\`\n`;
		errorMd += `- **使用的 Auth ID**: \`${effectiveAuthId}\`\n`;
		errorMd += `- **SDF 项目根目录**: \`${resolvedProjectRoot}\`\n\n`;
		errorMd += `### CLI 原始错误输出：\n\`\`\`\n${execResult.stderr || execResult.stdout}\n\`\`\`\n\n`;

		if (execResult.diagnostics && execResult.diagnostics.length > 0) {
			errorMd += `💡 **智能自愈与排查指南：**\n`;
			execResult.diagnostics.forEach((diag) => {
				errorMd += `${diag}\n\n`;
			});
		}

		return textResult(errorMd, true);
	}

	// 9. Success response formatting
	let successMd = `✅ **SuiteCloud File Upload Succeeded / 上传成功 (Time: ${execResult.executionTimeMs}ms)**\n\n`;
	successMd += `| 属性 | 信息 |\n|---|---|\n`;
	successMd += `| **目标账号** | \`${currentAccountId.toUpperCase()}\` (${isProd ? "🚨 PRODUCTION" : "🛡️ SANDBOX"}) |\n`;
	successMd += `| **使用的 Auth ID** | \`${effectiveAuthId}\` |\n`;
	successMd += `| **成功上传文件数** | ${resolution.files.length} 个文件 (${(resolution.totalBytes / 1024).toFixed(2)} KB) |\n`;
	successMd += `| **SDF 项目目录** | \`${resolvedProjectRoot}\` |\n\n`;

	successMd += `### 📄 已上传文件列表\n`;
	for (const f of resolution.files) {
		const sizeKb =
			f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : "0";
		const targetDisplay = formatTargetFileDisplay(
			f.localFullPath || f.fileCabinetPath || "",
			resolvedProjectRoot,
		);
		successMd += `- \`${targetDisplay}\` (${sizeKb} KB) ➔ \`${f.fileCabinetPath}\`\n`;
	}

	if (syncedFiles.length > 0) {
		successMd += `\n> ℹ️ **Notice**: ${syncedFiles.length} file(s) synchronized from external path into project FileCabinet: \`${syncedFiles.join("`, `")}\`\n`;
	}

	// 10. Enrich uploaded files with active NetSuite Web UI links (Editor, File Cabinet, Script & Deployments)
	const fileNames = resolution.files
		.map((f) =>
			path.basename(f.fileCabinetPath || f.localFullPath || "").trim(),
		)
		.filter((n) => n.length > 0);

	if (mcpTools && fileNames.length > 0) {
		try {
			const inList = fileNames
				.map((n) => `'${n.replace(/'/g, "''")}'`)
				.join(", ");
			const sql = `SELECT f.id AS file_id, f.name AS file_name, s.id AS script_id, s.scriptid AS script_text_id, s.name AS script_name, s.scripttype AS script_type, sd.primarykey AS deploy_id, sd.scriptid AS deploy_text_id, sd.title AS deploy_title FROM file f LEFT JOIN Script s ON s.scriptfile = f.id LEFT JOIN ScriptDeployment sd ON sd.script = s.id WHERE f.name IN (${inList}) ORDER BY f.name, s.name`;
			const res = await mcpTools.executeTool("ns_runCustomSuiteQL", {
				sqlQuery: sql,
			});
			const rows = mcpTools.extractDataArray(res);
			if (rows.length > 0) {
				successMd += `\n### 🔗 快捷访问与部署链接 (Quick Access Links)\n\n`;
				const fileMap = new Map<string, typeof rows>();
				for (const row of rows) {
					const name = String(row.file_name || "unknown");
					let list = fileMap.get(name);
					if (!list) {
						list = [];
						fileMap.set(name, list);
					}
					list.push(row);
				}

				for (const [name, rowList] of fileMap.entries()) {
					const first = rowList[0];
					const fileId =
						first?.file_id !== undefined && first?.file_id !== null
							? String(first.file_id)
							: undefined;
					const editUrl = generateNetSuiteScriptFileUrl(
						currentAccountId,
						fileId,
					);
					const fileCabinetUrl = generateNetSuiteUrl(
						currentAccountId,
						"file",
						fileId,
					);

					successMd += `#### 📄 文件: \`${name}\`\n`;
					if (editUrl) {
						successMd += `- 📝 **在线代码编辑 (Code Editor)**: [打开编辑页面](${editUrl})\n`;
					}
					if (fileCabinetUrl) {
						successMd += `- 📁 **文件柜媒体详情 (File Cabinet)**: [查看文件属性](${fileCabinetUrl})\n`;
					}

					const seenScripts = new Set<string>();
					const seenDeploys = new Set<string>();

					for (const row of rowList) {
						const scriptId =
							row.script_id !== undefined && row.script_id !== null
								? String(row.script_id)
								: undefined;
						const scriptTextId =
							row.script_text_id !== undefined && row.script_text_id !== null
								? String(row.script_text_id)
								: undefined;
						const scriptName =
							row.script_name !== undefined && row.script_name !== null
								? String(row.script_name)
								: undefined;

						if (scriptId && !seenScripts.has(scriptId)) {
							seenScripts.add(scriptId);
							const scriptUrl = generateNetSuiteUrl(
								currentAccountId,
								"script",
								scriptId,
							);
							const scriptLabel = scriptTextId
								? `${scriptTextId} (${scriptName || "Script"})`
								: String(scriptName || scriptId);
							if (scriptUrl) {
								successMd += `- 📜 **脚本定义记录 (Script)**: [${scriptLabel}](${scriptUrl})\n`;
							}
						}

						const deployId =
							row.deploy_id !== undefined && row.deploy_id !== null
								? String(row.deploy_id)
								: undefined;
						const deployTextId =
							row.deploy_text_id !== undefined && row.deploy_text_id !== null
								? String(row.deploy_text_id)
								: undefined;
						const deployTitle =
							row.deploy_title !== undefined && row.deploy_title !== null
								? String(row.deploy_title)
								: undefined;

						if (deployId && !seenDeploys.has(deployId)) {
							seenDeploys.add(deployId);
							const deployUrl = generateNetSuiteUrl(
								currentAccountId,
								"scriptdeployment",
								deployId,
							);
							const deployLabel = deployTextId
								? `${deployTextId} (${deployTitle || "Deployment"})`
								: String(deployTitle || deployId);
							if (deployUrl) {
								successMd += `- 🚀 **脚本部署记录 (Deployment)**: [${deployLabel}](${deployUrl})\n`;
							}

							if (
								String(row.script_type || "").toUpperCase() === "SUITELET" &&
								scriptTextId &&
								deployTextId
							) {
								const suiteletUrl = generateNetSuiteSuiteletUrl(
									currentAccountId,
									scriptTextId,
									deployTextId,
								);
								if (suiteletUrl) {
									successMd += `- 🌐 **Suitelet 直接运行链接 (Launch)**: [点击访问 Suitelet](${suiteletUrl})\n`;
								}
							}
						}
					}
					successMd += "\n";
				}
			}
		} catch {
			/* Non-fatal: upload succeeded */
		}
	}

	if (execResult.stdout.trim().length > 0) {
		successMd += `\n### CLI 输出：\n\`\`\`\n${execResult.stdout.trim()}\n\`\`\`\n`;
	}

	return textResult(successMd);
}
