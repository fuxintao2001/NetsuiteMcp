import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pino, { type Logger } from "pino";
import { getDefaultLogsDir } from "./environment.js";
import { isPermissionError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolErrorCategory =
	| "ARGUMENT_VALIDATION"
	| "SUITEQL_SYNTAX"
	| "PERMISSION_DENIED"
	| "RECORD_NOT_FOUND"
	| "PRODUCTION_WRITE_BLOCKED"
	| "NETWORK_OR_TIMEOUT"
	| "NETSUITE_API_ERROR"
	| "SYSTEM_EXCEPTION";

export interface ToolErrorEntry {
	id: string;
	timestamp: string;
	tool: string;
	accountId?: string | undefined;
	environment?: "Sandbox" | "Production" | "Unknown" | undefined;
	durationMs: number;
	category: ToolErrorCategory;
	errorMessage: string;
	errorStack?: string | undefined;
	errorCode?: string | number | undefined;
	parameters: Record<string, unknown>;
	guidanceAttached?: string | undefined;
}

export type NewToolErrorInput = Omit<ToolErrorEntry, "id" | "timestamp">;

// ---------------------------------------------------------------------------
// Sensitive data masking
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN =
	/token|secret|password|auth|key|credential|bearer|session/i;
const MAX_STRING_LENGTH = 50_000;

/**
 * Recursively masks sensitive fields and prevents payload explosion from huge base64 strings.
 */
export function maskSensitiveData(data: unknown, depth = 0): unknown {
	if (depth > 8 || data === null || data === undefined) {
		return data;
	}

	if (typeof data === "string") {
		if (data.length > MAX_STRING_LENGTH) {
			return `${data.slice(0, 1000)}... [TRUNCATED ${data.length - 1000} CHARS]`;
		}
		return data;
	}

	if (typeof data !== "object") {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map((item) => maskSensitiveData(item, depth + 1));
	}

	const masked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (SENSITIVE_KEY_PATTERN.test(key)) {
			masked[key] = "[REDACTED]";
		} else {
			masked[key] = maskSensitiveData(value, depth + 1);
		}
	}
	return masked;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classifies an error into structured categories based on tool, message, and origin.
 */
export function classifyError(
	toolName: string,
	errorMessage: string,
	isValidation = false,
): ToolErrorCategory {
	const lower = (errorMessage || "").toLowerCase();

	if (
		isValidation ||
		lower.includes("invalid arguments") ||
		lower.includes("validation error") ||
		lower.includes("invalid input") ||
		lower.includes("schema error") ||
		lower.includes("expected string") ||
		lower.includes("expected number") ||
		lower.includes("required") ||
		lower.includes("missing required")
	) {
		return "ARGUMENT_VALIDATION";
	}

	if (
		lower.includes("production safety violation") ||
		lower.includes("strictly blocked in production")
	) {
		return "PRODUCTION_WRITE_BLOCKED";
	}

	if (
		isPermissionError(errorMessage) ||
		lower.includes("insufficient_permission") ||
		lower.includes("permission error") ||
		lower.includes("permission denied") ||
		lower.includes("403 forbidden") ||
		lower.includes("permission violation")
	) {
		return "PERMISSION_DENIED";
	}

	if (
		toolName === "ns_runCustomSuiteQL" ||
		lower.includes("suiteql") ||
		lower.includes("invalid_search") ||
		lower.includes("syntax error") ||
		lower.includes("table or view does not exist") ||
		lower.includes("unknown identifier") ||
		lower.includes("invalid column") ||
		lower.includes("ambiguous column")
	) {
		return "SUITEQL_SYNTAX";
	}

	if (
		lower.includes("record_not_found") ||
		lower.includes("not found") ||
		lower.includes("does not exist") ||
		lower.includes("invalid record id") ||
		lower.includes("404 not found")
	) {
		return "RECORD_NOT_FOUND";
	}

	if (
		lower.includes("etimedout") ||
		lower.includes("econnreset") ||
		lower.includes("econnrefused") ||
		lower.includes("timeout") ||
		lower.includes("network error") ||
		lower.includes("socket hang up")
	) {
		return "NETWORK_OR_TIMEOUT";
	}

	if (lower.includes("netsuite error") || lower.includes("api error")) {
		return "NETSUITE_API_ERROR";
	}

	return "SYSTEM_EXCEPTION";
}

// ---------------------------------------------------------------------------
// Logger instance & initialization
// ---------------------------------------------------------------------------

let defaultLogger: Logger | null = null;
let activeTransport: {
	flush?: (cb?: () => void) => void;
	flushSync?: () => void;
} | null = null;

/**
 * Creates a configured Pino logger instance writing to rotating JSON Lines files.
 */
export function createToolErrorLogger(
	customLogsDir?: string,
	options: { syncFile?: string } = {},
): Logger {
	const logsDir = customLogsDir || getDefaultLogsDir();
	if (!fs.existsSync(logsDir)) {
		try {
			fs.mkdirSync(logsDir, { recursive: true });
		} catch {
			// Handled by transport or file system
		}
	}

	if (options.syncFile) {
		// Synchronous direct file destination for tests
		const dest = pino.destination({
			dest: options.syncFile,
			sync: true,
			mkdir: true,
		});
		return pino(
			{
				level: "error",
				timestamp: pino.stdTimeFunctions.isoTime,
			},
			dest,
		);
	}

	const transport = pino.transport({
		target: "pino-roll",
		options: {
			file: path.join(logsDir, "tool-errors.jsonl"),
			frequency: "daily",
			dateFormat: "yyyy-MM-dd",
			mkdir: true,
			extension: ".jsonl",
			limit: { count: 30, removeOtherLogFiles: true },
		},
	});

	activeTransport = transport as unknown as typeof activeTransport;

	return pino(
		{
			level: "error",
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		transport,
	);
}

/**
 * Returns the active default logger, initializing it on demand if necessary.
 */
export function getToolErrorLogger(): Logger {
	if (!defaultLogger) {
		defaultLogger = createToolErrorLogger();
	}
	return defaultLogger;
}

/**
 * Allows setting a custom logger (primarily for testing and dependency injection).
 */
export function setToolErrorLogger(logger: Logger | null): void {
	defaultLogger = logger;
}

/**
 * Records a structured tool execution error into the rolling JSONL log file.
 */
export function recordToolError(input: NewToolErrorInput): ToolErrorEntry {
	const entry: ToolErrorEntry = {
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		...input,
		parameters: (maskSensitiveData(input.parameters) || {}) as Record<
			string,
			unknown
		>,
	};

	try {
		const logger = getToolErrorLogger();
		logger.error(entry, `Tool ${entry.tool} failed [${entry.category}]`);
	} catch (err) {
		// Tool error logging MUST NEVER throw or crash the main server
		console.error("⚠️ Failed to write tool error log:", err);
	}

	return entry;
}

/**
 * Flushes pending asynchronous logs to disk. Useful during server shutdown.
 */
export async function flushToolErrorLogger(): Promise<void> {
	if (activeTransport) {
		try {
			if (typeof activeTransport.flushSync === "function") {
				activeTransport.flushSync();
			} else if (typeof activeTransport.flush === "function") {
				await new Promise<void>((resolve) => {
					activeTransport?.flush?.(() => resolve());
					setTimeout(resolve, 500); // 500ms timeout guard
				});
			}
		} catch {
			// Non-fatal
		}
	}
}
