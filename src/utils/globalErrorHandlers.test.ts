import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { installGlobalErrorHandlers } from './globalErrorHandlers.js';

describe('Global Error Handlers', () => {
  let mockProcess: any;
  let mockLogger: any;
  let eventListeners: Record<string, Function>;
  let stdinListeners: Record<string, Function>;

  beforeEach(() => {
    eventListeners = {};
    stdinListeners = {};
    mockProcess = {
      on: jest.fn((event: string, listener: Function) => {
        eventListeners[event] = listener;
      }),
      stdin: {
        on: jest.fn((event: string, listener: Function) => {
          stdinListeners[event] = listener;
        })
      },
      exit: jest.fn(),
      exitCode: undefined
    };
    mockLogger = {
      error: jest.fn()
    };
  });

  it('should register listeners on startup', () => {
    installGlobalErrorHandlers(mockProcess, mockLogger);
    expect(mockProcess.on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(mockProcess.on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    expect(mockProcess.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(mockProcess.stdin.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(mockProcess.stdin.on).toHaveBeenCalledWith('end', expect.any(Function));
  });

  it('should swallow and log uncaught exceptions without exiting', () => {
    installGlobalErrorHandlers(mockProcess, mockLogger);
    
    const error = new Error('Test Exception');
    eventListeners['uncaughtException'](error);

    expect(mockLogger.error).toHaveBeenCalledWith('[MCP] Uncaught Exception:', expect.stringContaining('Test Exception'));
    expect(mockProcess.exit).not.toHaveBeenCalled();
  });

  it('should set exitCode to 0 and swallow on broken stdio error (EPIPE/ECONNRESET)', () => {
    installGlobalErrorHandlers(mockProcess, mockLogger);
    
    const brokenStdioError = { code: 'EPIPE' };
    eventListeners['uncaughtException'](brokenStdioError);

    expect(mockProcess.exitCode).toBe(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockProcess.exit).not.toHaveBeenCalled();
  });

  it('should exit with 0 on SIGTERM or stdin close', () => {
    installGlobalErrorHandlers(mockProcess, mockLogger);
    
    eventListeners['SIGTERM']();
    expect(mockProcess.exit).toHaveBeenCalledWith(0);

    stdinListeners['close']();
    expect(mockProcess.exit).toHaveBeenCalledWith(0);
  });
});
