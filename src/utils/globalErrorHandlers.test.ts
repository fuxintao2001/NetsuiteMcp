import { describe, expect, it, jest } from '@jest/globals';
import { installGlobalErrorHandlers } from './globalErrorHandlers.js';

type Handler = (arg?: unknown) => void;

function createMockProcess() {
  const processHandlers = new Map<string, Handler>();
  const stdinHandlers = new Map<string, Handler>();
  const proc = {
    exitCode: undefined as number | string | null | undefined,
    on: jest.fn((event: string, listener: Handler) => {
      processHandlers.set(event, listener);
      return proc;
    }),
    stdin: {
      on: jest.fn((event: string, listener: Handler) => {
        stdinHandlers.set(event, listener);
        return proc.stdin;
      })
    },
    exit: jest.fn((() => {
      throw new Error('exit called');
    }) as (code?: number) => never)
  };

  return { proc, processHandlers, stdinHandlers };
}

describe('installGlobalErrorHandlers', () => {
  it('logs uncaught exceptions without exiting the process', () => {
    const { proc, processHandlers } = createMockProcess();
    const logger = { error: jest.fn() };

    installGlobalErrorHandlers(proc, logger);

    processHandlers.get('uncaughtException')?.(new Error('network wake failure'));

    expect(proc.exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[MCP] Uncaught Exception:', 'network wake failure');
  });

  it('logs unhandled rejections without exiting the process', () => {
    const { proc, processHandlers } = createMockProcess();
    const logger = { error: jest.fn() };

    installGlobalErrorHandlers(proc, logger);

    processHandlers.get('unhandledRejection')?.(new Error('refresh failed'));

    expect(proc.exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('[MCP] Unhandled Promise Rejection:', 'refresh failed');
  });

  it('marks broken stdio errors as clean without forcing exit from global handlers', () => {
    const { proc, processHandlers } = createMockProcess();
    const logger = { error: jest.fn() };

    installGlobalErrorHandlers(proc, logger);

    processHandlers.get('uncaughtException')?.({ code: 'EPIPE' });

    expect(proc.exit).not.toHaveBeenCalled();
    expect(proc.exitCode).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('exits cleanly when stdin closes', () => {
    const { proc, stdinHandlers } = createMockProcess();
    const logger = { error: jest.fn() };

    installGlobalErrorHandlers(proc, logger);

    expect(() => stdinHandlers.get('close')?.()).toThrow('exit called');
    expect(proc.exit).toHaveBeenCalledWith(0);
  });
});
