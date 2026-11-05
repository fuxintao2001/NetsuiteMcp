import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("session");

export interface SessionData {
	pkce?: string | null;
	state?: string;
	config?: {
		accountId: string;
		clientId: string;
		redirectUri: string;
	};
	tokens?: TokenData;
	previous_tokens?: TokenData | undefined;
	timestamp?: number;
	authenticated?: boolean;
	unrecoverable?: boolean;
}

export interface TokenData {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	expires_at: number;
	accountId: string;
	clientId: string;
}

/**
 * Session storage for OAuth tokens
 * Handles reading and writing session data to disk with mtime-based in-memory caching
 * and cross-process file-locking barriers.
 */
export class SessionStorage {
	private storagePath: string;
	private sessionFile: string;
	private lockFile: string;
	private cachedData: SessionData | null = null;
	private cachedMtimeMs = 0;

	constructor(storagePath: string) {
		this.storagePath = storagePath;
		this.sessionFile = path.join(storagePath, "session.json");
		this.lockFile = path.join(storagePath, "session.lock");
	}

	/**
	 * Get storage path
	 */
	getStoragePath(): string {
		return this.storagePath;
	}

	/**
	 * Acquire cross-process lockfile on session storage directory.
	 * Retries for up to timeoutMs (default 20s).
	 */
	async acquireLock(timeoutMs = 20000): Promise<() => Promise<void>> {
		await fs.mkdir(this.storagePath, { recursive: true });
		try {
			await fs.writeFile(this.lockFile, "", { flag: "a", mode: 0o600 });
		} catch {
			// File may already exist
		}
		const retries = Math.max(1, Math.floor(timeoutMs / 250));
		return await lockfile.lock(this.lockFile, {
			retries: {
				retries,
				minTimeout: 150,
				maxTimeout: 350,
			},
			stale: Math.max(25000, timeoutMs + 5000),
		});
	}

	/**
	 * Clear session file and invalidate in-memory cache
	 */
	async clear(): Promise<void> {
		this.cachedData = null;
		this.cachedMtimeMs = 0;
		try {
			await fs.unlink(this.sessionFile);
		} catch {
			// Ignored
		}
	}

	/**
	 * Save session data to file atomically and update memory cache
	 */
	async save(data: SessionData): Promise<void> {
		try {
			await fs.mkdir(this.storagePath, { recursive: true });
			// Restrict directory permission to 0o700 (owner read, write, execute only)
			await fs.chmod(this.storagePath, 0o700).catch(() => {});

			// Write atomically using write-file-atomic with fsync and 0o600 permissions
			await writeFileAtomic(this.sessionFile, JSON.stringify(data, null, 2), {
				mode: 0o600,
			});

			const stat = await fs.stat(this.sessionFile);
			this.cachedData = data;
			this.cachedMtimeMs = stat.mtimeMs;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to save session: ${message}`);
			throw error;
		}
	}

	/**
	 * Load session data from file with lightweight mtime check
	 */
	async load(forceRefresh = false): Promise<SessionData | null> {
		try {
			const stat = await fs.stat(this.sessionFile);
			if (
				!forceRefresh &&
				this.cachedData &&
				stat.mtimeMs === this.cachedMtimeMs
			) {
				return this.cachedData;
			}

			const fileContent = await fs.readFile(this.sessionFile, "utf-8");
			const trimmed = fileContent.trim();
			if (!trimmed) {
				this.cachedData = null;
				this.cachedMtimeMs = stat.mtimeMs;
				return null;
			}

			try {
				const parsed = JSON.parse(fileContent) as SessionData;
				this.cachedData = parsed;
				this.cachedMtimeMs = stat.mtimeMs;
				return parsed;
			} catch (parseError: unknown) {
				const message =
					parseError instanceof Error ? parseError.message : String(parseError);
				const corruptedBackup = path.join(
					this.storagePath,
					`session.corrupted.${Date.now()}.json`,
				);
				logger.warn(
					`Session file is corrupted, renaming to ${path.basename(corruptedBackup)}: ${message}`,
				);
				try {
					await fs.rename(this.sessionFile, corruptedBackup);
				} catch (renameError) {
					logger.error(
						`Failed to rename corrupted session file: ${renameError instanceof Error ? renameError.message : String(renameError)}`,
					);
					await this.clear(); // fallback to delete if rename fails
				}
				this.cachedData = null;
				this.cachedMtimeMs = 0;
				return null;
			}
		} catch (error: unknown) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				this.cachedData = null;
				this.cachedMtimeMs = 0;
				return null; // Session file doesn't exist
			}
			throw error;
		}
	}

	/**
	 * Check if session exists and is authenticated
	 */
	async isAuthenticated(): Promise<boolean> {
		try {
			const session = await this.load();
			return !!(session?.authenticated && session.tokens);
		} catch {
			return false;
		}
	}

	/**
	 * Touch heartbeat file to signal that an active MCP server instance is actively maintaining this session.
	 */
	async touchHeartbeat(): Promise<void> {
		try {
			await fs.mkdir(this.storagePath, { recursive: true });
			const heartbeatFile = path.join(this.storagePath, "session.heartbeat");
			await fs.writeFile(heartbeatFile, String(Date.now()), { mode: 0o600 });
		} catch {
			// Ignored
		}
	}
}
