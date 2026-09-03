import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ConfirmationPayload {
	paths: string;
	accountId: string;
	projectPath: string;
	createdAt: number;
}

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
 * SuiteCloud CLI execution and confirmation security service.
 */
export class SuiteCloudRunnerService {
	private pendingTokens: Map<string, ConfirmationPayload> = new Map();
	private readonly TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

	/**
	 * Generate a 5-minute single-use confirmation token tied to paths and account.
	 */
	generateToken(payload: {
		paths: string;
		accountId: string;
		projectPath: string;
	}): string {
		this.cleanupExpiredTokens();
		const token = randomUUID();
		this.pendingTokens.set(token, {
			...payload,
			createdAt: Date.now(),
		});
		return token;
	}

	/**
	 * Validate and consume a confirmation token. Single use only.
	 */
	consumeToken(
		token: string,
		current: { paths: string; accountId: string },
	): { valid: boolean; reason?: string } {
		this.cleanupExpiredTokens();
		const record = this.pendingTokens.get(token);
		if (!record) {
			return {
				valid: false,
				reason: "Confirmation token is invalid or has expired.",
			};
		}

		// Consume immediately (single-use)
		this.pendingTokens.delete(token);

		if (record.paths !== current.paths) {
			return {
				valid: false,
				reason: "Upload paths do not match the previewed confirmation token.",
			};
		}

		if (record.accountId.toLowerCase() !== current.accountId.toLowerCase()) {
			return {
				valid: false,
				reason:
					"Target account ID does not match the previewed confirmation token.",
			};
		}

		return { valid: true };
	}

	/**
	 * Direct execution by confirmation token (e.g. from one-click browser link).
	 */
	async executeByToken(token: string): Promise<{
		success: boolean;
		message: string;
		details?: UploadExecutionResult;
		payload?: ConfirmationPayload;
	}> {
		this.cleanupExpiredTokens();
		const record = this.pendingTokens.get(token);
		if (!record) {
			return {
				success: false,
				message:
					"Confirmation token is invalid or has expired (valid for 5 minutes).",
			};
		}

		// Consume immediately (single-use)
		this.pendingTokens.delete(token);

		const result = await this.executeUpload(record.projectPath, record.paths);
		return {
			success: result.success,
			message: result.success
				? "File uploaded successfully"
				: "Upload command failed",
			details: result,
			payload: record,
		};
	}

	/**
	 * Search upwards for SDF project root containing manifest.xml or suitecloud.config.js
	 */
	findSdfProjectRoot(startDir: string): string | null {
		let curr = path.resolve(startDir);
		while (true) {
			if (
				fs.existsSync(path.join(curr, "manifest.xml")) ||
				fs.existsSync(path.join(curr, "suitecloud.config.js")) ||
				fs.existsSync(path.join(curr, "src", "manifest.xml"))
			) {
				return curr;
			}
			const parent = path.dirname(curr);
			if (parent === curr) break;
			curr = parent;
		}
		return null;
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
	 * Execute npx suitecloud file:upload --paths "<paths>" in the project directory
	 */
	async executeUpload(
		projectRoot: string,
		fileCabinetPaths: string,
	): Promise<UploadExecutionResult> {
		const startTime = Date.now();
		const command = `npx suitecloud file:upload --paths "${fileCabinetPaths}"`;

		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: projectRoot,
				timeout: 60000, // 60 seconds
				env: { ...process.env },
			});

			return {
				success: true,
				stdout: stdout || "",
				stderr: stderr || "",
				executionTimeMs: Date.now() - startTime,
			};
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			const execErr = err as { stdout?: string; stderr?: string };
			return {
				success: false,
				stdout: execErr.stdout || "",
				stderr: execErr.stderr || msg,
				executionTimeMs: Date.now() - startTime,
			};
		}
	}

	private cleanupExpiredTokens(): void {
		const now = Date.now();
		for (const [token, record] of this.pendingTokens.entries()) {
			if (now - record.createdAt > this.TOKEN_TTL_MS) {
				this.pendingTokens.delete(token);
			}
		}
	}
}

export const suitecloudRunnerService = new SuiteCloudRunnerService();
