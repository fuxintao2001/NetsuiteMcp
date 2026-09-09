import pino from "pino";
import { sanitizeMessage } from "./errors.js";

const defaultLevel =
	process.env.LOG_LEVEL ||
	(process.env.NODE_ENV === "test" ? "silent" : "info");

/**
 * Custom hooks/formatters to ensure all logged strings and objects
 * have sensitive tokens and absolute paths sanitized.
 */
export const rootLogger = pino(
	{
		level: defaultLevel,
		formatters: {
			log(object) {
				const sanitized: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(object)) {
					if (typeof v === "string") {
						sanitized[k] = sanitizeMessage(v);
					} else if (v instanceof Error) {
						sanitized[k] = {
							message: sanitizeMessage(v.message),
							stack: v.stack ? sanitizeMessage(v.stack) : undefined,
							name: v.name,
						};
					} else {
						sanitized[k] = v;
					}
				}
				return sanitized;
			},
		},
		hooks: {
			logMethod(inputArgs, method) {
				const sanitizedArgs = inputArgs.map((arg) => {
					if (typeof arg === "string") {
						return sanitizeMessage(arg);
					}
					if (arg instanceof Error) {
						arg.message = sanitizeMessage(arg.message);
						if (arg.stack) {
							arg.stack = sanitizeMessage(arg.stack);
						}
					}
					return arg;
				});
				Reflect.apply(method, this, sanitizedArgs);
			},
		},
	},
	pino.destination({ dest: 2, sync: true }),
); // 2 = process.stderr (critical for MCP stdio)

/**
 * Creates a scoped child logger for a specific module or component.
 */
export function createLogger(moduleName: string) {
	return rootLogger.child({ module: moduleName });
}

export const logger = rootLogger;
