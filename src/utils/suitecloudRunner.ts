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
	 * Inspect local file mapped to the File Cabinet path
	 */
	inspectLocalFile(
		projectRoot: string,
		fileCabinetPath: string,
	): FileInspectionResult {
		const cleanPath = fileCabinetPath.startsWith("/")
			? fileCabinetPath.slice(1)
			: fileCabinetPath;

		const candidates = [
			path.join(projectRoot, "src", "FileCabinet", cleanPath),
			path.join(projectRoot, "FileCabinet", cleanPath),
			path.join(projectRoot, cleanPath),
			path.resolve(fileCabinetPath),
		];

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
