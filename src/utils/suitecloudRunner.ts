import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface FileInspectionResult {
	exists: boolean;
	localFullPath?: string;
	sizeBytes?: number;
	mtime?: Date;
	error?: string;
}

export interface UploadExecutionResult {
	success: boolean;
	stdout: string;
	stderr: string;
	executionTimeMs: number;
}

/**
 * SuiteCloud CLI execution and SDF file resolution service.
 */
export class SuiteCloudRunnerService {

	/**
	 * Search upwards for SDF project root containing suitecloud.config.js, project.json, or manifest.xml
	 */
	findSdfProjectRoot(startDir: string): string | null {
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
	 * Normalize path to NetSuite FileCabinet format (e.g. '/SuiteScripts/foo.js').
	 * Handles absolute local paths, paths containing 'FileCabinet/', or relative paths.
	 */
	normalizeFileCabinetPath(inputPath: string): string {
		const normalized = inputPath.replace(/\\/g, "/").trim();
		const fcIndex = normalized.indexOf("FileCabinet/");
		if (fcIndex !== -1) {
			const sub = normalized.substring(fcIndex + "FileCabinet/".length);
			return sub.startsWith("/") ? sub : `/${sub}`;
		}
		if (
			normalized.startsWith("/SuiteScripts") ||
			normalized.startsWith("/Templates") ||
			normalized.startsWith("/Web Site Hosting Files")
		) {
			return normalized;
		}
		if (
			normalized.startsWith("SuiteScripts/") ||
			normalized.startsWith("Templates/") ||
			normalized.startsWith("Web Site Hosting Files/")
		) {
			return `/${normalized}`;
		}
		return normalized.startsWith("/") ? normalized : `/${normalized}`;
	}

	/**
	 * Inspect local file mapped to the File Cabinet path
	 */
	inspectLocalFile(
		projectRoot: string,
		fileCabinetPath: string,
	): FileInspectionResult {
		const normFcPath = this.normalizeFileCabinetPath(fileCabinetPath);
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

		for (const candidate of candidates) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				const stat = fs.statSync(candidate);
				return {
					exists: true,
					localFullPath: candidate,
					sizeBytes: stat.size,
					mtime: stat.mtime,
				};
			}
		}

		return {
			exists: false,
			error: `Local file corresponding to '${fileCabinetPath}' was not found in project '${projectRoot}'.`,
		};
	}

	/**
	 * Build complete environment with JAVA_HOME and standard CLI paths for child processes
	 */
	private resolveEnvironment(): NodeJS.ProcessEnv {
		const env = { ...process.env };
		const knownJavaHomes = [
			process.env.JAVA_HOME,
			"/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home",
			"/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home",
		].filter(Boolean) as string[];

		let resolvedJavaHome = "";
		for (const jh of knownJavaHomes) {
			if (fs.existsSync(jh)) {
				resolvedJavaHome = jh;
				break;
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
	 * Execute suitecloud file:upload --paths "<paths>" in the project directory
	 */
	async executeUpload(
		projectRoot: string,
		fileCabinetPaths: string,
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

		const command = `${cliBin} file:upload --paths "${fileCabinetPaths}"`;

		try {
			const env = this.resolveEnvironment();
			console.log(`[SuiteCloudRunner] Executing: ${command} in ${projectRoot}`);
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
			const execErr = err as { stdout?: string; stderr?: string; message?: string };
			const outputText = [execErr.stderr, execErr.stdout, execErr.message]
				.filter(Boolean)
				.map((s) => String(s).trim())
				.filter(Boolean)
				.join("\n");
			console.error(`[SuiteCloudRunner Error]:`, outputText);
			return {
				success: false,
				stdout: execErr.stdout || "",
				stderr: outputText,
				executionTimeMs: Date.now() - startTime,
			};
		}
	}
}

export const suitecloudRunnerService = new SuiteCloudRunnerService();
