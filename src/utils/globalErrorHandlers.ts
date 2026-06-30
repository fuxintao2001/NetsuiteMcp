import { sanitizeError, sanitizeMessage } from './errors.js';

interface ProcessLike {
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  on(event: 'SIGTERM', listener: () => void): unknown;
  stdin: {
    on(event: 'close' | 'end', listener: () => void): unknown;
  };
  exit(code?: number): never;
  exitCode: number | string | null | undefined;
}

interface LoggerLike {
  error(...args: unknown[]): void;
}

function isBrokenStdioError(error: unknown): boolean {
  const err = error as { code?: unknown; config?: unknown; request?: unknown } | null;
  return (
    !!err &&
    (err.code === 'EPIPE' || err.code === 'ECONNRESET') &&
    !err.config &&
    !err.request
  );
}

function logSanitizedError(prefix: string, error: unknown, logger: LoggerLike): void {
  const sanitized = sanitizeError(error);
  logger.error(prefix, sanitized.message);

  if (error instanceof Error && error.stack) {
    logger.error(sanitizeMessage(error.stack));
  }
}

/**
 * Install process-level handlers without terminating on transient async errors.
 *
 * MCP servers are long-lived stdio processes. Network, OAuth, and background
 * prefetch failures must be surfaced in logs, not promoted into process exits.
 */
export function installGlobalErrorHandlers(
  proc: ProcessLike = process,
  logger: LoggerLike = console
): void {
  proc.on('uncaughtException', (error: unknown) => {
    if (isBrokenStdioError(error)) {
      proc.exitCode = 0;
      return;
    }

    logSanitizedError('[MCP] Uncaught Exception:', error, logger);
  });

  proc.on('unhandledRejection', (reason: unknown) => {
    if (isBrokenStdioError(reason)) {
      proc.exitCode = 0;
      return;
    }

    logSanitizedError('[MCP] Unhandled Promise Rejection:', reason, logger);
  });

  proc.stdin.on('close', () => {
    proc.exit(0);
  });
  proc.stdin.on('end', () => {
    proc.exit(0);
  });

  proc.on('SIGTERM', () => {
    proc.exit(0);
  });
}
