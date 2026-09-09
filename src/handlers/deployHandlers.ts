import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { OAuthManager } from "../oauth/manager.js";
import { isSandboxAccount } from "../utils/environment.js";
import { suitecloudRunnerService } from "../utils/suitecloudRunner.js";
import { SuitecloudUploadArgsSchema } from "./toolSchemas.js";

type ToolResponse = CallToolResult;

function textResult(text: string, isError?: boolean): CallToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError } : {}),
	};
}

export async function handleSuitecloudUpload(
	args: Record<string, unknown>,
	oauthManager: OAuthManager,
	defaultProjectRoot: string,
): Promise<ToolResponse> {
	const parsed = SuitecloudUploadArgsSchema.safeParse(args);
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

	let candidateStartDir = customProjectPath;
	if (
		!candidateStartDir &&
		firstPathCandidate &&
		path.isAbsolute(firstPathCandidate)
	) {
		candidateStartDir = path.dirname(firstPathCandidate);
	}
	if (!candidateStartDir) {
		candidateStartDir = defaultProjectRoot;
	}

	const resolvedProjectRoot =
		suitecloudRunnerService.findSdfProjectRoot(
			candidateStartDir,
			currentAccountId,
		) || candidateStartDir;

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
	if (isProd && !allowProduction) {
		let prodMd = `🚨 **生产环境安全拦截 (Production Safety Block)**\n\n`;
		prodMd += `当前目标 NetSuite 账号为**生产环境** (\`${currentAccountId.toUpperCase()}\`)。\n`;
		prodMd += `为防止误操作覆盖生产代码，需获得用户明确授权。\n\n`;
		prodMd += `### 待上传文件清单（共 ${resolution.files.length} 个文件，${(resolution.totalBytes / 1024).toFixed(2)} KB）：\n`;
		for (const f of resolution.files) {
			prodMd += `- \`${f.fileCabinetPath}\` (${f.sizeBytes !== undefined ? (f.sizeBytes / 1024).toFixed(2) : 0} KB)\n`;
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

	// 8. Execute the upload via SuiteCloud CLI
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
		successMd += `- \`${f.fileCabinetPath}\` (${sizeKb} KB) ➔ \`${f.localFullPath}\`\n`;
	}

	if (execResult.stdout.trim().length > 0) {
		successMd += `\n### CLI 输出：\n\`\`\`\n${execResult.stdout.trim()}\n\`\`\`\n`;
	}

	return textResult(successMd);
}
