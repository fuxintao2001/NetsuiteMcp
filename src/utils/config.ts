import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getKnownClientId } from "./constants.js";
import { getDefaultConfigDir, getDefaultSessionsDir } from "./environment.js";

// ---------------------------------------------------------------------------
// Zod Schemas & TypeScript Types
// ---------------------------------------------------------------------------

export const AppAccountConfigSchema = z.object({
	accountId: z.string().trim().min(1, "accountId cannot be empty"),
	clientId: z.string().trim().min(1, "clientId cannot be empty"),
	sessionPath: z.string().trim().optional(),
	callbackPort: z.number().int().min(1024).max(65535).optional(),
});
export type AppAccountConfig = z.infer<typeof AppAccountConfigSchema>;

export const AppConfigSchema = z.object({
	defaultCallbackPort: z.number().int().min(1024).max(65535).default(8080),
	sessionsDir: z.string().trim().optional(),
	redisUrl: z.string().trim().optional(),
	accounts: z.record(z.string(), AppAccountConfigSchema).default({}),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve session path for a specific account or the default directory.
 * Priority:
 * 1. customPath (explicitly configured for the account)
 * 2. NETSUITE_SESSION_PATH env var
 * 3. configured sessionsDir + accountId
 * 4. Default standard directory: ~/.config/netsuite-mcp/sessions/<account_id>
 */
export function resolveSessionPath(
	accountId?: string,
	customPath?: string,
	baseSessionsDir?: string,
): string {
	if (customPath && customPath.trim().length > 0) {
		return path.resolve(customPath);
	}

	if (process.env.NETSUITE_SESSION_PATH) {
		return path.resolve(process.env.NETSUITE_SESSION_PATH);
	}

	const baseDir =
		baseSessionsDir ||
		process.env.NETSUITE_SESSIONS_DIR ||
		getDefaultSessionsDir();

	if (accountId) {
		const safeAccountKey = accountId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
		return path.join(baseDir, safeAccountKey);
	}

	return baseDir;
}

/**
 * Search upwards for netsuite.config.json starting from startDir
 */
function findConfigFile(startDir: string): string | null {
	let curr = path.resolve(startDir);
	while (true) {
		const candidate = path.join(curr, "netsuite.config.json");
		if (fs.existsSync(candidate)) {
			return candidate;
		}
		const parent = path.dirname(curr);
		if (parent === curr) break;
		curr = parent;
	}
	return null;
}

/**
 * Detect accounts defined through environment variables:
 * - NETSUITE_ACCOUNTS (comma-separated list of account keys)
 * - NETSUITE_CLIENT_ID_<ACCOUNT>
 * - Single account via NETSUITE_ACCOUNT_ID and NETSUITE_CLIENT_ID
 */
function detectAccountsFromEnv(
	defaultCallbackPort = 8080,
	baseSessionsDir?: string,
): Record<string, AppAccountConfig> {
	const discovered: Record<string, AppAccountConfig> = {};

	// 1. Explicit list from NETSUITE_ACCOUNTS
	if (process.env.NETSUITE_ACCOUNTS) {
		const accounts = process.env.NETSUITE_ACCOUNTS.split(",")
			.map((a) => a.trim())
			.filter(Boolean);

		for (const key of accounts) {
			const normKey = key.toUpperCase().replace(/-/g, "_");
			const envAccountId =
				process.env[`NETSUITE_ACCOUNT_ID_${normKey}`] || key.replace(/_/g, "-");
			const envClientId =
				process.env[`NETSUITE_CLIENT_ID_${normKey}`] ||
				getKnownClientId(key) ||
				process.env.NETSUITE_CLIENT_ID ||
				"";
			const envSession = process.env[`NETSUITE_SESSION_PATH_${normKey}`];
			const portStr = process.env[`NETSUITE_CALLBACK_PORT_${normKey}`];

			if (envAccountId && envClientId) {
				discovered[key] = {
					accountId: envAccountId,
					clientId: envClientId,
					sessionPath: resolveSessionPath(key, envSession, baseSessionsDir),
					callbackPort: portStr ? parseInt(portStr, 10) : defaultCallbackPort,
				};
			}
		}
	}

	// 2. Discover from NETSUITE_CLIENT_ID_<KEY>
	for (const [envKey, envVal] of Object.entries(process.env)) {
		if (
			envKey.startsWith("NETSUITE_CLIENT_ID_") &&
			envVal &&
			envVal.trim().length > 0
		) {
			const key = envKey.replace("NETSUITE_CLIENT_ID_", "").toLowerCase();
			if (!discovered[key]) {
				const accountId = key.replace(/_/g, "-");
				const envSession =
					process.env[`NETSUITE_SESSION_PATH_${key.toUpperCase()}`];
				discovered[key] = {
					accountId,
					clientId: envVal.trim(),
					sessionPath: resolveSessionPath(key, envSession, baseSessionsDir),
					callbackPort: defaultCallbackPort,
				};
			}
		}
	}

	// 3. Single-account fallback from standard NETSUITE_ACCOUNT_ID
	if (
		Object.keys(discovered).length === 0 &&
		process.env.NETSUITE_ACCOUNT_ID &&
		process.env.NETSUITE_CLIENT_ID
	) {
		const key = process.env.NETSUITE_ACCOUNT_ID.toLowerCase().replace(
			/-/g,
			"_",
		);
		discovered[key] = {
			accountId: process.env.NETSUITE_ACCOUNT_ID.trim(),
			clientId: process.env.NETSUITE_CLIENT_ID.trim(),
			sessionPath: resolveSessionPath(
				key,
				process.env.NETSUITE_SESSION_PATH,
				baseSessionsDir,
			),
			callbackPort: process.env.OAUTH_CALLBACK_PORT
				? parseInt(process.env.OAUTH_CALLBACK_PORT, 10)
				: defaultCallbackPort,
		};
	}

	return discovered;
}

// ---------------------------------------------------------------------------
// Main Loader
// ---------------------------------------------------------------------------

/**
 * Load unified application configuration.
 *
 * Search order for configuration file:
 * 1. explicitFilePath argument (if provided)
 * 2. Process cwd and ancestor directories for `netsuite.config.json`
 * 3. Global config file at `~/.config/netsuite-mcp/config.json`
 *
 * Accounts declared in config file are merged with environment-discovered accounts.
 */
export function loadAppConfig(
	explicitFilePath?: string,
	startDir = process.cwd(),
): AppConfig {
	let rawConfig: Record<string, unknown> = {};

	// 1. Locate configuration file
	let configPath: string | null = null;
	if (explicitFilePath && fs.existsSync(explicitFilePath)) {
		configPath = explicitFilePath;
	} else {
		configPath = findConfigFile(startDir);
		if (!configPath) {
			const globalConfig = path.join(getDefaultConfigDir(), "config.json");
			if (fs.existsSync(globalConfig)) {
				configPath = globalConfig;
			}
		}
	}

	// 2. Read and parse configuration file if found
	if (configPath) {
		try {
			const content = fs.readFileSync(configPath, "utf-8");
			rawConfig = JSON.parse(content) as Record<string, unknown>;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`⚠️ Failed to parse config file at ${configPath}: ${msg}`);
		}
	}

	const parsed = AppConfigSchema.parse(rawConfig);

	// 3. Merge with environment variables
	const envAccounts = detectAccountsFromEnv(
		parsed.defaultCallbackPort,
		parsed.sessionsDir,
	);

	const mergedAccounts: Record<string, AppAccountConfig> = {
		...envAccounts,
		...parsed.accounts,
	};

	// Ensure each account has a resolved sessionPath and callbackPort
	for (const [key, account] of Object.entries(mergedAccounts)) {
		if (!account.sessionPath) {
			account.sessionPath = resolveSessionPath(
				key,
				undefined,
				parsed.sessionsDir,
			);
		}
		if (!account.callbackPort) {
			account.callbackPort = parsed.defaultCallbackPort;
		}
	}

	return {
		defaultCallbackPort: parsed.defaultCallbackPort,
		sessionsDir: parsed.sessionsDir,
		redisUrl: parsed.redisUrl || process.env.REDIS_URL,
		accounts: mergedAccounts,
	};
}
