import { exec, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";

const execAsync = promisify(exec);

export interface FileInspectionResult {
	exists: boolean;
	localFullPath?: string | undefined;
	fileCabinetPath?: string | undefined;
	sizeBytes?: number | undefined;
	mtime?: Date | undefined;
	error?: string | undefined;
	syntaxValid?: boolean | undefined;
	syntaxError?: string | undefined;
	scriptType?: string | undefined;
	apiVersion?: string | undefined;
	warnings?: string[] | undefined;
}

export interface MultiFileResolutionResult {
	projectRoot: string;
	files: FileInspectionResult[];
	totalBytes: number;
	invalidCount: number;
	missingCount: number;
	warnings: string[];
}

export interface AuthInfo {
	authId: string;
	account: string;
	role: string;
	domain?: string | undefined;
}

export interface AuthSyncResult {
	configuredAuthId?: string | undefined;
	matchedAuthId?: string | undefined;
	autoUpdated: boolean;
	availableAuthIds: string[];
	warning?: string | undefined;
}

export interface UploadExecutionResult {
	success: boolean;
	stdout: string;
	stderr: string;
	executionTimeMs: number;
	diagnostics?: string[] | undefined;
}

/**
 * SuiteCloud CLI execution, SDF file resolution, preflight validation, and auth management.
 */
export class SuiteCloudRunnerService {
	/**
	 * Search for SDF project root using multi-tier strategy:
	 * 1. Explicit start directory and upward recursion
	 * 2. Environment variables NETSUITE_SDF_PROJECT_PATH / NETSUITE_PROJECT_PATH
	 * 3. workspace-agents/workspaces.json account ID matching
	 * 4. Sibling/parent directories named after account ID
	 * 5. process.cwd() inspection
	 */
	findSdfProjectRoot(startDir?: string, accountId?: string): string | null {
		// 1. If startDir is specified and not the MCP server's own root, search upwards
		if (startDir) {
			const candidate = this.searchUpwards(startDir);
			if (candidate) return candidate;
		}

		// 2. Check environment variables
		const envPath =
			process.env.NETSUITE_SDF_PROJECT_PATH ||
			process.env.NETSUITE_PROJECT_PATH;
		if (envPath && fs.existsSync(envPath)) {
			const candidate = this.searchUpwards(envPath);
			if (candidate) return candidate;
		}

		// 3. Search in workspaces.json if accountId is provided
		if (accountId) {
			const wsProject = this.findProjectFromWorkspacesConfig(accountId);
			if (wsProject && fs.existsSync(wsProject)) {
				return wsProject;
			}

			// 4. Search sibling / parent directories matching accountId
			const siblingMatch = this.findProjectFromSiblingDirectories(accountId);
			if (siblingMatch) return siblingMatch;
		}

		// 5. Check process.cwd()
		const cwdCandidate = this.searchUpwards(process.cwd());
		if (cwdCandidate) return cwdCandidate;

		return null;
	}

	/**
	 * Search upwards from a directory for SDF project markers
	 */
	searchUpwards(startDir: string): string | null {
		let curr = path.resolve(startDir);
		let candidateRoot: string | null = null;

		while (true) {
			// Higher priority: root containing suitecloud.config.js or project.json
			if (
				fs.existsSync(path.join(curr, "suitecloud.config.js")) ||
				fs.existsSync(path.join(curr, "project.json"))
			) {
				return curr;
			}
			// Secondary fallback: directory containing manifest.xml or src/manifest.xml
			if (
				!candidateRoot &&
				(fs.existsSync(path.join(curr, "manifest.xml")) ||
					fs.existsSync(path.join(curr, "src", "manifest.xml")))
			) {
				candidateRoot = curr;
			}

			const parent = path.dirname(curr);
			if (parent === curr) break;
			curr = parent;
		}

		return candidateRoot;
	}

	/**
	 * Search workspaces.json for project matching the account ID
	 */
	private findProjectFromWorkspacesConfig(accountId: string): string | null {
		const normTarget = accountId.toLowerCase().replace(/[-_]/g, "");
		const searchDirs = [
			process.cwd(),
			path.resolve(__dirname, "..", ".."),
			path.resolve(__dirname, "..", "..", ".."),
		];

		for (const baseDir of searchDirs) {
			const configPath = path.join(
				baseDir,
				"workspace-agents",
				"workspaces.json",
			);
			if (fs.existsSync(configPath)) {
				try {
					const data = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
						workspaces?: Array<{ accountId: string; projectPath: string }>;
					};
					if (Array.isArray(data.workspaces)) {
						// 1. Exact match first (prevents Sandbox sb1 matching Prod)
						for (const ws of data.workspaces) {
							const normWs = ws.accountId.toLowerCase().replace(/[-_]/g, "");
							if (normWs === normTarget && fs.existsSync(ws.projectPath)) {
								return ws.projectPath;
							}
						}
						// 2. Prefix match fallback (only if ws starts with full target)
						for (const ws of data.workspaces) {
							const normWs = ws.accountId.toLowerCase().replace(/[-_]/g, "");
							if (
								normWs.startsWith(normTarget) &&
								fs.existsSync(ws.projectPath)
							) {
								return ws.projectPath;
							}
						}
					}
				} catch {}
			}
		}
		return null;
	}

	/**
	 * Search sibling directories matching accountId
	 */
	private findProjectFromSiblingDirectories(accountId: string): string | null {
		const normTarget = accountId.toLowerCase().replace(/[-_]/g, "");
		const parentDirs = [
			path.dirname(process.cwd()),
			path.resolve(__dirname, "..", "..", ".."),
		];

		for (const parentDir of parentDirs) {
			if (!fs.existsSync(parentDir)) continue;
			try {
				const entries = fs.readdirSync(parentDir, { withFileTypes: true });
				// 1. Exact match first
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const normEntry = entry.name.toLowerCase().replace(/[-_]/g, "");
					if (normEntry === normTarget) {
						const dirPath = path.join(parentDir, entry.name);
						const found = this.searchUpwards(dirPath);
						if (found) return found;
					}
				}
				// 2. Prefix match fallback (e.g. 9260916-sb1 matching 9260916_sb1)
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const normEntry = entry.name.toLowerCase().replace(/[-_]/g, "");
					if (normEntry.startsWith(normTarget)) {
						const dirPath = path.join(parentDir, entry.name);
						const found = this.searchUpwards(dirPath);
						if (found) return found;
					}
				}
			} catch {}
		}
		return null;
	}

	/**
	 * Normalize path to NetSuite FileCabinet format (e.g. '/SuiteScripts/foo.js').
	 * Handles absolute local paths, paths containing 'FileCabinet/', SuiteApps, or relative paths.
	 */
	normalizeFileCabinetPath(inputPath: string, projectRoot?: string): string {
		let normalized = inputPath.replace(/\\/g, "/").trim();

		// Strip projectRoot if absolute
		if (projectRoot && path.isAbsolute(inputPath)) {
			const normProjectRoot = projectRoot.replace(/\\/g, "/");
			if (normalized.startsWith(normProjectRoot)) {
				normalized = normalized.substring(normProjectRoot.length);
				if (normalized.startsWith("/")) normalized = normalized.substring(1);
			}
		}

		const fcIndex = normalized.indexOf("FileCabinet/");
		if (fcIndex !== -1) {
			const sub = normalized.substring(fcIndex + "FileCabinet/".length);
			return sub.startsWith("/") ? sub : `/${sub}`;
		}

		if (
			normalized.startsWith("/SuiteScripts") ||
			normalized.startsWith("/SuiteApps") ||
			normalized.startsWith("/Templates") ||
			normalized.startsWith("/Web Site Hosting Files")
		) {
			return normalized;
		}

		if (
			normalized.startsWith("SuiteScripts/") ||
			normalized.startsWith("SuiteApps/") ||
			normalized.startsWith("Templates/") ||
			normalized.startsWith("Web Site Hosting Files/")
		) {
			return `/${normalized}`;
		}

		return normalized.startsWith("/") ? normalized : `/${normalized}`;
	}

	/**
	 * Validate SuiteScript file content (syntax, annotations, size)
	 */
	validateSuiteScriptContent(
		filePath: string,
		content: string,
	): {
		syntaxValid: boolean;
		syntaxError?: string | undefined;
		scriptType?: string | undefined;
		apiVersion?: string | undefined;
		warnings: string[];
	} {
		const warnings: string[] = [];
		let syntaxValid = true;
		let syntaxError: string | undefined;
		let scriptType: string | undefined;
		let apiVersion: string | undefined;

		// 1. Annotation discovery
		const apiVersionMatch = content.match(/@NApiVersion\s+([\d.x]+)/i);
		if (apiVersionMatch) {
			apiVersion = apiVersionMatch[1];
		}

		const scriptTypeMatch = content.match(/@NScriptType\s+([\w]+)/i);
		if (scriptTypeMatch) {
			scriptType = scriptTypeMatch[1];
		}

		// 2. SuiteScript 1.0 or missing version warnings
		if (
			content.includes("nlapiGet") ||
			content.includes("nlapiSet") ||
			content.includes("nlapiCreate") ||
			content.includes("nlapiSearch")
		) {
			warnings.push(
				"⚠️ 检测到 SuiteScript 1.0 遗留 API (nlapi*)。NetSuite 官方强烈建议升级至 SuiteScript 2.1。",
			);
		} else if (!apiVersion) {
			warnings.push(
				"💡 提示：文件未声明 '@NApiVersion' 注解，NetSuite 脚本推荐声明 '@NApiVersion 2.1'。",
			);
		}

		// 3. Syntax validation for JS files
		if (filePath.endsWith(".js") || filePath.endsWith(".cjs")) {
			try {
				new vm.Script(content, { filename: filePath });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				// Allow ES module export/import syntax without marking as syntax failure
				if (
					msg.includes("Cannot use import statement") ||
					msg.includes("Unexpected token 'export'")
				) {
					syntaxValid = true;
				} else {
					syntaxValid = false;
					syntaxError = msg;
					warnings.push(`❌ JavaScript 语法错误: ${msg}`);
				}
			}
		}

		return {
			syntaxValid,
			syntaxError,
			scriptType,
			apiVersion,
			warnings,
		};
	}

	/**
	 * Inspect single local file mapped to FileCabinet
	 */
	inspectLocalFile(
		projectRoot: string,
		fileCabinetPath: string,
		options?: { skipValidation?: boolean },
	): FileInspectionResult {
		const normFcPath = this.normalizeFileCabinetPath(
			fileCabinetPath,
			projectRoot,
		);
		const cleanPath = normFcPath.startsWith("/")
			? normFcPath.slice(1)
			: normFcPath;

		const candidates = [
			path.isAbsolute(fileCabinetPath) ? fileCabinetPath : null,
			path.join(projectRoot, "src", "FileCabinet", cleanPath),
			path.join(projectRoot, "FileCabinet", cleanPath),
			path.join(projectRoot, cleanPath),
			path.resolve(projectRoot, fileCabinetPath),
		].filter(Boolean) as string[];

		let foundPath: string | null = null;
		for (const candidate of candidates) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				foundPath = candidate;
				break;
			}
		}

		// If still not found and fileCabinetPath is a simple filename, search FileCabinet recursively
		if (
			!foundPath &&
			!fileCabinetPath.includes("/") &&
			!fileCabinetPath.includes("\\")
		) {
			const fcRoots = [
				path.join(projectRoot, "src", "FileCabinet"),
				path.join(projectRoot, "FileCabinet"),
			];
			for (const fcRoot of fcRoots) {
				if (fs.existsSync(fcRoot)) {
					const matched = this.findFileRecursively(fcRoot, fileCabinetPath);
					if (matched) {
						foundPath = matched;
						break;
					}
				}
			}
		}

		if (!foundPath) {
			return {
				exists: false,
				fileCabinetPath: normFcPath,
				error: `Local file corresponding to '${fileCabinetPath}' was not found in project '${projectRoot}'.`,
			};
		}

		const stat = fs.statSync(foundPath);
		const warnings: string[] = [];

		if (stat.size === 0) {
			warnings.push("⚠️ 文件内容为空 (0 字节)");
		} else if (stat.size > 10 * 1024 * 1024) {
			warnings.push("⚠️ 文件大小超过 10MB，上传 NetSuite 可能会超时或受限");
		}

		let syntaxValid = true;
		let syntaxError: string | undefined;
		let scriptType: string | undefined;
		let apiVersion: string | undefined;

		if (
			!options?.skipValidation &&
			stat.size > 0 &&
			stat.size < 10 * 1024 * 1024
		) {
			try {
				const content = fs.readFileSync(foundPath, "utf-8");
				const validation = this.validateSuiteScriptContent(foundPath, content);
				syntaxValid = validation.syntaxValid;
				syntaxError = validation.syntaxError;
				scriptType = validation.scriptType;
				apiVersion = validation.apiVersion;
				warnings.push(...validation.warnings);
			} catch {}
		}

		const actualFcPath = this.normalizeFileCabinetPath(foundPath, projectRoot);

		return {
			exists: true,
			localFullPath: foundPath,
			fileCabinetPath: actualFcPath,
			sizeBytes: stat.size,
			mtime: stat.mtime,
			syntaxValid,
			syntaxError,
			scriptType,
			apiVersion,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	/**
	 * Find file recursively by basename inside a directory
	 */
	private findFileRecursively(dir: string, targetName: string): string | null {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isFile() && entry.name === targetName) {
					return full;
				}
				if (
					entry.isDirectory() &&
					entry.name !== ".git" &&
					entry.name !== "node_modules"
				) {
					const res = this.findFileRecursively(full, targetName);
					if (res) return res;
				}
			}
		} catch {}
		return null;
	}

	/**
	 * Collect all files in a directory recursively
	 */
	collectFilesInDirectory(dir: string): string[] {
		const results: string[] = [];
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (
					entry.name === ".DS_Store" ||
					entry.name === ".git" ||
					entry.name === "node_modules"
				) {
					continue;
				}
				if (entry.isFile()) {
					results.push(full);
				} else if (entry.isDirectory()) {
					results.push(...this.collectFilesInDirectory(full));
				}
			}
		} catch {}
		return results;
	}

	/**
	 * Resolve input paths (single string, array, directory, comma-separated) into inspected file list
	 */
	resolveUploadFiles(
		projectRoot: string,
		pathsInput: string | string[],
		options?: { skipValidation?: boolean },
	): MultiFileResolutionResult {
		const rawList: string[] = [];

		if (Array.isArray(pathsInput)) {
			rawList.push(...pathsInput.map((p) => String(p).trim()).filter(Boolean));
		} else if (typeof pathsInput === "string") {
			const trimmed = pathsInput.trim();
			// Check if trimmed path directly points to an existing file or directory
			const directCheck = path.isAbsolute(trimmed)
				? trimmed
				: path.join(projectRoot, trimmed);
			const directFcCheck = path.join(
				projectRoot,
				"src",
				"FileCabinet",
				trimmed.replace(/^\/+/, ""),
			);

			if (fs.existsSync(directCheck) || fs.existsSync(directFcCheck)) {
				rawList.push(trimmed);
			} else if (trimmed.includes("\n")) {
				rawList.push(
					...trimmed
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean),
				);
			} else if (trimmed.includes(",")) {
				rawList.push(
					...trimmed
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				);
			} else if (trimmed.includes(" ")) {
				// Parse space-separated files
				const parts = trimmed.match(/"[^"]+"|'[^']+'|\S+/g) || [];
				rawList.push(
					...parts
						.map((p) => p.replace(/^['"]|['"]$/g, "").trim())
						.filter(Boolean),
				);
			} else {
				rawList.push(trimmed);
			}
		}

		const files: FileInspectionResult[] = [];
		const globalWarnings: string[] = [];
		let totalBytes = 0;
		let invalidCount = 0;
		let missingCount = 0;

		for (const item of rawList) {
			// Check if item points to a directory
			const dirCandidates = [
				path.isAbsolute(item) ? item : null,
				path.join(projectRoot, "src", "FileCabinet", item.replace(/^\/+/, "")),
				path.join(projectRoot, "FileCabinet", item.replace(/^\/+/, "")),
				path.join(projectRoot, item),
			].filter(Boolean) as string[];

			let foundDir: string | null = null;
			for (const c of dirCandidates) {
				if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
					foundDir = c;
					break;
				}
			}

			if (foundDir) {
				const dirFiles = this.collectFilesInDirectory(foundDir);
				if (dirFiles.length === 0) {
					globalWarnings.push(`📁 目录 '${item}' 为空，未找到可上传的文件`);
					continue;
				}
				for (const f of dirFiles) {
					const inspected = this.inspectLocalFile(projectRoot, f, options);
					files.push(inspected);
					if (inspected.exists && inspected.sizeBytes) {
						totalBytes += inspected.sizeBytes;
					}
					if (inspected.syntaxValid === false) invalidCount++;
					if (!inspected.exists) missingCount++;
				}
			} else {
				const inspected = this.inspectLocalFile(projectRoot, item, options);
				files.push(inspected);
				if (inspected.exists && inspected.sizeBytes) {
					totalBytes += inspected.sizeBytes;
				}
				if (inspected.syntaxValid === false) invalidCount++;
				if (!inspected.exists) missingCount++;
			}
		}

		return {
			projectRoot,
			files,
			totalBytes,
			invalidCount,
			missingCount,
			warnings: globalWarnings,
		};
	}

	/**
	 * Retrieve all configured SuiteCloud authentication IDs using 'suitecloud account:manageauth --list'
	 */
	async getAvailableAuthIds(): Promise<AuthInfo[]> {
		let cliBin = "suitecloud";
		if (fs.existsSync("/opt/homebrew/bin/suitecloud")) {
			cliBin = "/opt/homebrew/bin/suitecloud";
		} else if (fs.existsSync("/usr/local/bin/suitecloud")) {
			cliBin = "/usr/local/bin/suitecloud";
		} else {
			cliBin = "npx suitecloud";
		}

		const env = this.resolveEnvironment();
		try {
			const { stdout } = await execAsync(
				`${cliBin} account:manageauth --list`,
				{
					timeout: 10000,
					env,
				},
			);

			const results: AuthInfo[] = [];
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI escape sequences from CLI output
			const cleanStdout = (stdout || "").replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
			const lines = cleanStdout.split("\n");
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed?.includes("|")) continue;
				const parts = trimmed.split("|").map((p) => p.trim());
				const authId = parts[0] || "";
				const rolePart = parts[1] || "";
				const domainPart = parts[2];
				const accountMatch = authId.match(
					/^([a-zA-Z0-9_-]+?)(?:-[a-zA-Z0-9]+)?$/,
				);
				const account = accountMatch?.[1] ? accountMatch[1] : authId;

				results.push({
					authId,
					account,
					role: rolePart,
					domain: domainPart,
				});
			}
			return results;
		} catch {
			return [];
		}
	}

	/**
	 * Verify and align project.json defaultAuthId with active target account ID
	 */
	async syncProjectAuthId(
		projectRoot: string,
		targetAccountId: string,
		preferredAuthId?: string,
	): Promise<AuthSyncResult> {
		const projectJsonPath = path.join(projectRoot, "project.json");
		let currentConfiguredAuthId: string | undefined;
		let projectJson: Record<string, unknown> = {};

		if (fs.existsSync(projectJsonPath)) {
			try {
				projectJson = JSON.parse(fs.readFileSync(projectJsonPath, "utf-8"));
				currentConfiguredAuthId = projectJson.defaultAuthId as string;
			} catch {}
		}

		const available = await this.getAvailableAuthIds();
		const availableIds = available.map((a) => a.authId);

		// If user explicitly provided preferredAuthId
		if (preferredAuthId) {
			projectJson.defaultAuthId = preferredAuthId;
			try {
				fs.writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2));
			} catch {}
			return {
				configuredAuthId: preferredAuthId,
				matchedAuthId: preferredAuthId,
				autoUpdated: true,
				availableAuthIds: availableIds,
			};
		}

		const normTarget = targetAccountId.toLowerCase().replace(/[-_]/g, "");

		// Check if current defaultAuthId already matches target account ID
		if (currentConfiguredAuthId) {
			const normCurrent = currentConfiguredAuthId
				.toLowerCase()
				.replace(/[-_]/g, "");
			if (
				normCurrent === normTarget ||
				normCurrent.startsWith(normTarget) ||
				normTarget.startsWith(normCurrent)
			) {
				return {
					configuredAuthId: currentConfiguredAuthId,
					matchedAuthId: currentConfiguredAuthId,
					autoUpdated: false,
					availableAuthIds: availableIds,
				};
			}
		}

		// Find best match among available auth IDs
		const matched = available.find((a) => {
			const normAuth = a.authId.toLowerCase().replace(/[-_]/g, "");
			return (
				normAuth === normTarget ||
				normAuth.startsWith(normTarget) ||
				normTarget.startsWith(normAuth)
			);
		});

		if (matched) {
			projectJson.defaultAuthId = matched.authId;
			try {
				fs.writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2));
			} catch {}
			return {
				configuredAuthId: matched.authId,
				matchedAuthId: matched.authId,
				autoUpdated: true,
				availableAuthIds: availableIds,
			};
		}

		return {
			configuredAuthId: currentConfiguredAuthId,
			autoUpdated: false,
			availableAuthIds: availableIds,
			warning:
				`⚠️ 未找到匹配账号 '${targetAccountId}' 的 SuiteCloud Auth ID。` +
				`当前 project.json 配置: '${currentConfiguredAuthId || "未设置"}'。` +
				`已配置的 Auth IDs: ${availableIds.length > 0 ? availableIds.join(", ") : "无"}。` +
				`若上传失败，请在终端执行 'npx suitecloud account:setup' 授权此账号。`,
		};
	}

	/**
	 * Build complete environment with dynamic JAVA_HOME and standard CLI paths
	 */
	resolveEnvironment(): NodeJS.ProcessEnv {
		const env = { ...process.env };
		let resolvedJavaHome = "";

		if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
			resolvedJavaHome = process.env.JAVA_HOME;
		} else if (process.platform === "darwin") {
			try {
				const jh = execSync("/usr/libexec/java_home", {
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "ignore"],
				}).trim();
				if (jh && fs.existsSync(jh)) {
					resolvedJavaHome = jh;
				}
			} catch {}
		}

		if (!resolvedJavaHome) {
			const knownJavaHomes = [
				"/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home",
				"/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home",
				"/opt/homebrew/opt/openjdk@17",
				"/usr/lib/jvm/java-17-openjdk",
			];
			for (const jh of knownJavaHomes) {
				if (fs.existsSync(jh)) {
					resolvedJavaHome = jh;
					break;
				}
			}
		}

		const extraPaths = [
			resolvedJavaHome ? path.join(resolvedJavaHome, "bin") : "",
			"/opt/homebrew/bin",
			"/opt/homebrew/sbin",
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		].filter(Boolean);

		const currentPath = env.PATH || "";
		const pathParts = currentPath.split(":");
		for (const p of extraPaths) {
			if (!pathParts.includes(p)) {
				pathParts.unshift(p);
			}
		}

		env.PATH = pathParts.join(":");
		if (resolvedJavaHome) {
			env.JAVA_HOME = resolvedJavaHome;
		}
		return env;
	}

	/**
	 * Intelligent diagnostic error pattern recognition
	 */
	diagnoseUploadError(
		stderr: string,
		stdout: string,
		context: {
			targetAccountId: string;
			authId?: string | undefined;
			paths: string[];
		},
	): string[] {
		const combined = `${stderr}\n${stdout}`.toLowerCase();
		const tips: string[] = [];

		if (
			combined.includes("missing_default_auth_id") ||
			combined.includes("not set up an account") ||
			combined.includes('run "account:setup"') ||
			combined.includes("no default authentication id")
		) {
			tips.push(
				"🔑 **SuiteCloud 认证缺失**: 项目尚未关联 NetSuite 认证别名。请在终端执行 `npx suitecloud account:setup` 进行网页授权，或执行 `npx suitecloud account:manageauth --list` 查看已有凭据。",
			);
		}

		if (
			combined.includes("does not exist in the file cabinet") ||
			combined.includes("folder does not exist")
		) {
			tips.push(
				"📁 **File Cabinet 目标目录不存在**: NetSuite 要求目标父级文件夹在系统中已存在。请在 NetSuite 界面（Customization > File Cabinet）预先创建对应文件夹，或确保本地目录结构已包含该目录。",
			);
		}

		if (
			combined.includes("java") ||
			combined.includes("unsupportedclassversionerror") ||
			combined.includes("java_home")
		) {
			tips.push(
				"☕ **Java 环境异常**: SuiteCloud CLI 要求 Java 17+。macOS 可通过 `brew install openjdk@17` 安装，并确保 `JAVA_HOME` 正确设置。",
			);
		}

		if (
			combined.includes("system contention") ||
			combined.includes("concurrency") ||
			combined.includes("operation on other objects")
		) {
			tips.push(
				"⏳ **系统临时资源争用 (System Contention)**: NetSuite 后台正在执行其他部署操作或元数据锁。此问题为瞬态并发冲突，建议稍候 1-2 分钟后重试。",
			);
		}

		if (
			combined.includes("token expired") ||
			combined.includes("invalid_grant") ||
			combined.includes("unauthorized")
		) {
			tips.push(
				`🔄 **认证凭据已过期**: 账号 \`${context.targetAccountId}\` 的 SuiteCloud 凭据已失效。请运行 \`npx suitecloud account:setup\` 重新登录授权。`,
			);
		}

		if (tips.length === 0) {
			tips.push(
				`1. 确认已在终端执行 \`npx suitecloud account:setup\` 为账号 \`${context.targetAccountId}\` 完成授权。`,
				`2. 确认当前生效的 Auth ID 对应目标账号 \`${context.targetAccountId}\`。`,
				`3. 确认待上传路径在项目内存在，且目标父目录在 NetSuite File Cabinet 中已建好。`,
			);
		}

		return tips;
	}

	/**
	 * Execute suitecloud file:upload in the project directory
	 */
	async executeUpload(
		projectRoot: string,
		fileCabinetPaths: string | string[],
		options?: {
			targetAccountId?: string | undefined;
			authId?: string | undefined;
		},
	): Promise<UploadExecutionResult> {
		const startTime = Date.now();
		let cliBin = "suitecloud";
		if (fs.existsSync("/opt/homebrew/bin/suitecloud")) {
			cliBin = "/opt/homebrew/bin/suitecloud";
		} else if (fs.existsSync("/usr/local/bin/suitecloud")) {
			cliBin = "/usr/local/bin/suitecloud";
		} else if (fs.existsSync("/opt/homebrew/bin/npx")) {
			cliBin = "/opt/homebrew/bin/npx suitecloud";
		} else {
			cliBin = "npx suitecloud";
		}

		const pathsArray = Array.isArray(fileCabinetPaths)
			? fileCabinetPaths
			: [fileCabinetPaths];
		const joinedPaths = pathsArray.join(" ");
		const command = `${cliBin} file:upload --paths "${joinedPaths}"`;

		try {
			const env = this.resolveEnvironment();
			console.error(
				`[SuiteCloudRunner] Executing: ${command} in ${projectRoot}`,
			);
			const { stdout, stderr } = await execAsync(command, {
				cwd: projectRoot,
				timeout: 120000, // 120 seconds
				env,
			});

			return {
				success: true,
				stdout: stdout || "",
				stderr: stderr || "",
				executionTimeMs: Date.now() - startTime,
			};
		} catch (err: unknown) {
			const execErr = err as {
				stdout?: string;
				stderr?: string;
				message?: string;
			};
			const outputText = [execErr.stderr, execErr.stdout, execErr.message]
				.filter(Boolean)
				.map((s) => String(s).trim())
				.filter(Boolean)
				.join("\n");
			console.error("[SuiteCloudRunner Error]:", outputText);

			const diagnostics = this.diagnoseUploadError(
				execErr.stderr || "",
				execErr.stdout || execErr.message || "",
				{
					targetAccountId: options?.targetAccountId || "UNKNOWN",
					authId: options?.authId,
					paths: pathsArray,
				},
			);

			return {
				success: false,
				stdout: execErr.stdout || "",
				stderr: outputText,
				executionTimeMs: Date.now() - startTime,
				diagnostics,
			};
		}
	}
}

export const suitecloudRunnerService = new SuiteCloudRunnerService();
