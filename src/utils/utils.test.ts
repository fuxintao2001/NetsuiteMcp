import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKnownClientId, SERVER_NAME } from "./constants.js";
import {
	buildEnvSuffix,
	formatNetSuiteAccountHost,
	isSandboxAccount,
} from "./environment.js";
import { parseEnv } from "./envLoader.js";
import { validateEnv } from "./envValidator.js";
import {
	isPermissionError,
	PERMISSION_HARD_STOP_ADVICE,
	parseNetSuiteError,
	sanitizeError,
	sanitizeMessage,
} from "./errors.js";
import { installGlobalErrorHandlers } from "./globalErrorHandlers.js";
import {
	ConcurrencyLimiter,
	checkNetworkReadiness,
	getRetryAfterMs,
	retryWithBackoff,
	TokenRefreshScheduler,
} from "./resilience.js";

describe("Core & Environment Utilities", () => {
	describe("envLoader", () => {
		it("should correctly parse key-value pairs from .env string", () => {
			const sampleEnv = `
# Comment line
FOO=bar
BAZ="quoted value"
SINGLE='single quoted'
EMPTY=
SPACED = trimmed 
`;
			const parsed = parseEnv(sampleEnv);
			expect(parsed.FOO).toBe("bar");
			expect(parsed.BAZ).toBe("quoted value");
			expect(parsed.SINGLE).toBe("single quoted");
			expect(parsed.EMPTY).toBe("");
			expect(parsed.SPACED).toBe("trimmed");
		});

		it("should ignore comments and empty lines", () => {
			const sample = `# A comment
# Another comment
`;
			const parsed = parseEnv(sample);
			expect(Object.keys(parsed).length).toBe(0);
		});
	});

	describe("Environment Validator", () => {
		it("should pass with empty or minimum environment variables", () => {
			const config = validateEnv({});
			expect(config.OAUTH_CALLBACK_PORT).toBe(8080);
			expect(config.PORT).toBeUndefined();
		});

		it("should validate and parse correct ports", () => {
			const config = validateEnv({
				PORT: "3000",
				OAUTH_CALLBACK_PORT: "9000",
				NETSUITE_ACCOUNT_ID: "123456_SB1",
			});
			expect(config.PORT).toBe(3000);
			expect(config.OAUTH_CALLBACK_PORT).toBe(9000);
			expect(config.NETSUITE_ACCOUNT_ID).toBe("123456_SB1");
		});

		it("should throw validation error on invalid ports", () => {
			expect(() => validateEnv({ PORT: "invalid" })).toThrow(
				"Environment validation failed",
			);
			expect(() => validateEnv({ PORT: "99999" })).toThrow(
				"Environment validation failed",
			);
			expect(() => validateEnv({ OAUTH_CALLBACK_PORT: "-5" })).toThrow(
				"Environment validation failed",
			);
		});
	});

	describe("Environment Classification & Suffixes", () => {
		describe("isSandboxAccount", () => {
			it("should correctly classify sandbox accounts containing _SB", () => {
				expect(isSandboxAccount("123456_SB1")).toBe(true);
				expect(isSandboxAccount("5848789_sb2")).toBe(true);
			});

			it("should correctly classify sandbox accounts containing -SB", () => {
				expect(isSandboxAccount("9260916-sb1")).toBe(true);
				expect(isSandboxAccount("9260916_SB1")).toBe(true);
				expect(isSandboxAccount("9260916-SB3")).toBe(true);
			});

			it("should correctly classify test drive accounts starting with TSTDRV", () => {
				expect(isSandboxAccount("TSTDRV123456")).toBe(true);
				expect(isSandboxAccount("tstdrv_789")).toBe(true);
			});

			it("should correctly classify production accounts", () => {
				expect(isSandboxAccount("123456")).toBe(false);
				expect(isSandboxAccount("COMPANY_PROD")).toBe(false);
			});
		});

		describe("formatNetSuiteAccountHost", () => {
			it("should format account IDs to lowercase and replace underscores with hyphens", () => {
				expect(formatNetSuiteAccountHost("123456_SB1")).toBe("123456-sb1");
				expect(formatNetSuiteAccountHost(" 9260916_sb3 ")).toBe("9260916-sb3");
				expect(formatNetSuiteAccountHost("COMPANY_PROD")).toBe("company-prod");
			});
		});

		describe("buildEnvSuffix", () => {
			it("should return empty string if accountId is null", () => {
				expect(buildEnvSuffix(null)).toBe("");
			});

			it("should append suffix with Sandbox env if sandbox account ID", () => {
				expect(buildEnvSuffix("123456_SB1")).toBe(
					" [Account: 123456_SB1, Env: Sandbox]",
				);
			});

			it("should append suffix with Production env if production account ID", () => {
				expect(buildEnvSuffix("123456")).toBe(
					" [Account: 123456, Env: Production]",
				);
			});
		});
	});

	describe("Constants", () => {
		const originalEnv = { ...process.env };

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = { ...originalEnv };
		});

		it("should export correct SERVER_NAME", () => {
			expect(SERVER_NAME).toBe("netsuite-mcp");
		});

		it("should lookup account-specific client IDs correctly from env", () => {
			process.env.NETSUITE_CLIENT_ID_5848789 = "client_5848789";
			process.env.NETSUITE_CLIENT_ID_5848789_SB1 = "client_5848789_sb1";
			process.env.NETSUITE_CLIENT_ID_9260916_SB1 = "client_9260916_sb1";

			expect(getKnownClientId("5848789")).toBe("client_5848789");
			expect(getKnownClientId("5848789-sb1")).toBe("client_5848789_sb1");
			expect(getKnownClientId("9260916-SB1")).toBe("client_9260916_sb1");
		});

		it("should fallback to NETSUITE_CLIENT_ID if specific account ID is not set", () => {
			delete process.env.NETSUITE_CLIENT_ID_UNKNOWN_ACC;
			process.env.NETSUITE_CLIENT_ID = "generic_client_id";

			expect(getKnownClientId("unknown_acc")).toBe("generic_client_id");
		});

		it("should return undefined if neither specific nor generic client ID is set", () => {
			delete process.env.NETSUITE_CLIENT_ID_UNKNOWN_ACC;
			delete process.env.NETSUITE_CLIENT_ID;

			expect(getKnownClientId("unknown_acc")).toBeUndefined();
			expect(getKnownClientId(undefined)).toBeUndefined();
		});
	});

	describe("Errors & Sanitization", () => {
		describe("isPermissionError", () => {
			it("should identify permission errors by HTTP 403 status", () => {
				expect(isPermissionError("error", 403)).toBe(true);
				expect(isPermissionError(undefined, 403)).toBe(true);
			});

			it("should identify permission error codes and keywords", () => {
				expect(isPermissionError("INSUFFICIENT_PERMISSION")).toBe(true);
				expect(isPermissionError("ROLE_PERMISSION_ERROR")).toBe(true);
				expect(isPermissionError("PERMISSION_VIOLATION")).toBe(true);
				expect(
					isPermissionError(
						"Permission Violation: You need the 'Lists -> Customers' permission",
					),
				).toBe(true);
				expect(
					isPermissionError(
						"USER_ERROR: You do not have permission to view this record",
					),
				).toBe(true);
				expect(isPermissionError("Access denied")).toBe(true);
				expect(isPermissionError("Forbidden")).toBe(true);
			});

			it("should return false for non-permission errors", () => {
				expect(isPermissionError("INVALID_SQL")).toBe(false);
				expect(isPermissionError("RECORD_NOT_FOUND")).toBe(false);
				expect(isPermissionError("INVALID_FLD_VALUE")).toBe(false);
				expect(isPermissionError(undefined, 400)).toBe(false);
			});
		});

		describe("PERMISSION_HARD_STOP_ADVICE", () => {
			it("should include critical stop and zero hallucination instructions", () => {
				expect(PERMISSION_HARD_STOP_ADVICE).toContain(
					"PERMISSION DENIED — HARD STOP REQUIRED",
				);
				expect(PERMISSION_HARD_STOP_ADVICE).toContain(
					"STOP ALL TASKS IMMEDIATELY",
				);
				expect(PERMISSION_HARD_STOP_ADVICE).toContain(
					"STRICTLY ZERO HALLUCINATION",
				);
			});
		});

		describe("sanitizeMessage", () => {
			it("should redact sensitive OAuth parameters and tokens", () => {
				const original =
					"Failed: Bearer target_token_xyz&refresh_token=refresh_123&client_id=client_987&code_verifier=verifier_abc";
				const expected =
					"Failed: Bearer [REDACTED]&refresh_token=[REDACTED]&client_id=[REDACTED]&code_verifier=[REDACTED]";
				expect(sanitizeMessage(original)).toBe(expected);
			});

			it("should redact tokens from json strings", () => {
				const original =
					'{"access_token" : "some_secret_token", "refresh_token":"another_secret"}';
				const expected =
					'{"access_token":"[REDACTED]", "refresh_token":"[REDACTED]"}';
				expect(sanitizeMessage(original)).toBe(expected);
			});

			it("should redact local home and users paths", () => {
				const original =
					"Error occurred at /Users/fuxintao/WebstormProjects/NetsuiteMcp/src/index.ts";
				expect(sanitizeMessage(original)).toContain(
					"<PROJECT_ROOT>/src/index.ts",
				);
			});
		});

		describe("parseNetSuiteError", () => {
			it("should handle standard NetSuite o:errorDetails array", () => {
				const mockError = {
					response: {
						status: 400,
						data: {
							"o:errorDetails": [
								{
									"o:errorCode": "INVALID_SQL",
									detail: "Syntax error in SuiteQL query.",
								},
							],
						},
					},
				};

				const result = parseNetSuiteError(mockError);
				expect(result.message).toContain(
					"NetSuite API Error: [INVALID_SQL] Syntax error in SuiteQL query.",
				);
				expect(result.message).toContain(
					"Troubleshooting Advice - SuiteQL/SQL",
				);
			});

			it("should append hard-stop permission advice on INSUFFICIENT_PERMISSION", () => {
				const mockError = {
					response: {
						status: 403,
						data: {
							"o:errorDetails": [
								{
									"o:errorCode": "INSUFFICIENT_PERMISSION",
									detail:
										"You do not have permission to view customer records.",
								},
							],
						},
					},
				};

				const result = parseNetSuiteError(mockError);
				expect(result.message).toContain("INSUFFICIENT_PERMISSION");
				expect(result.message).toContain(
					"PERMISSION DENIED — HARD STOP REQUIRED",
				);
				expect(result.message).toContain("STOP ALL TASKS IMMEDIATELY");
				expect(result.message).toContain("STRICTLY ZERO HALLUCINATION");
			});

			it("should parse OAuth error responses", () => {
				const mockError = {
					response: {
						status: 400,
						data: {
							error: "invalid_grant",
							error_description: "Refresh token has expired.",
						},
					},
				};

				const result = parseNetSuiteError(mockError);
				expect(result.message).toContain(
					"OAuth Error [invalid_grant]: Refresh token has expired.",
				);
			});

			it("should truncate HTML error pages", () => {
				const html =
					"<!DOCTYPE html><html><head><title>504 Gateway Timeout</title></head><body>Timeout</body></html>";
				const mockError = {
					response: {
						status: 504,
						statusText: "Gateway Timeout",
						data: html,
					},
				};

				const result = parseNetSuiteError(mockError);
				expect(result.message).toContain("HTTP 504 (Gateway Timeout)");
				expect(result.message).toContain('Title: "504 Gateway Timeout"');
				expect(result.message).not.toContain("<body>Timeout</body>");
			});

			it("should fall back to standard response status message with permission hard stop on 403", () => {
				const mockError = {
					response: {
						status: 403,
						statusText: "Forbidden",
					},
					message: "Request failed with 403",
				};

				const result = parseNetSuiteError(mockError);
				expect(result.message).toContain("HTTP 403: Request failed with 403");
				expect(result.message).toContain("PERMISSION DENIED");
			});
		});

		describe("sanitizeError", () => {
			it("should extract NetSuite error details and redact stack traces", () => {
				const innerErr = new Error("Auth error with Bearer token_xyz");
				innerErr.stack = "at Object.test (/Users/fuxintao/test.ts:1:1)";

				const result = sanitizeError(innerErr);
				expect(result.message).toBe("Auth error with Bearer [REDACTED]");
				expect(result.stack).toContain("/Users/<USER>/test.ts");
			});
		});
	});

	describe("Global Error Handlers", () => {
		let mockProcess: any;
		let mockLogger: any;
		let eventListeners: Record<string, (...args: unknown[]) => void>;
		let stdinListeners: Record<string, (...args: unknown[]) => void>;

		beforeEach(() => {
			eventListeners = {};
			stdinListeners = {};
			mockProcess = {
				on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
					eventListeners[event] = listener;
				}),
				stdin: {
					on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
						stdinListeners[event] = listener;
					}),
				},
				exit: vi.fn(),
				exitCode: undefined,
			};
			mockLogger = {
				error: vi.fn(),
			};
		});

		it("should register listeners on startup", () => {
			installGlobalErrorHandlers(mockProcess, mockLogger);
			expect(mockProcess.on).toHaveBeenCalledWith(
				"uncaughtException",
				expect.any(Function),
			);
			expect(mockProcess.on).toHaveBeenCalledWith(
				"unhandledRejection",
				expect.any(Function),
			);
			expect(mockProcess.on).toHaveBeenCalledWith(
				"SIGTERM",
				expect.any(Function),
			);
			expect(mockProcess.stdin.on).toHaveBeenCalledWith(
				"close",
				expect.any(Function),
			);
			expect(mockProcess.stdin.on).toHaveBeenCalledWith(
				"end",
				expect.any(Function),
			);
		});

		it("should swallow and log uncaught exceptions without exiting", () => {
			installGlobalErrorHandlers(mockProcess, mockLogger);

			const error = new Error("Test Exception");
			eventListeners.uncaughtException(error);

			expect(mockLogger.error).toHaveBeenCalledWith(
				"[MCP] Uncaught Exception:",
				expect.stringContaining("Test Exception"),
			);
			expect(mockProcess.exit).not.toHaveBeenCalled();
		});

		it("should set exitCode to 0 and swallow on broken stdio error (EPIPE/ECONNRESET)", () => {
			installGlobalErrorHandlers(mockProcess, mockLogger);

			const brokenStdioError = { code: "EPIPE" };
			eventListeners.uncaughtException(brokenStdioError);

			expect(mockProcess.exitCode).toBe(0);
			expect(mockLogger.error).not.toHaveBeenCalled();
			expect(mockProcess.exit).not.toHaveBeenCalled();
		});

		it("should exit with 0 on SIGTERM or stdin close", () => {
			installGlobalErrorHandlers(mockProcess, mockLogger);

			eventListeners.SIGTERM();
			expect(mockProcess.exit).toHaveBeenCalledWith(0);

			stdinListeners.close();
			expect(mockProcess.exit).toHaveBeenCalledWith(0);
		});
	});

	describe("Resilience & Scheduling", () => {
		describe("checkNetworkReadiness", () => {
			it("should return true in test environment", async () => {
				const ready = await checkNetworkReadiness();
				expect(ready).toBe(true);
			});
		});

		describe("retryWithBackoff", () => {
			it("should resolve immediately if function succeeds first time", async () => {
				const fn = vi.fn<() => Promise<string>>().mockResolvedValue("success");
				const result = await retryWithBackoff(fn, () => true, { retries: 3 });
				expect(result).toBe("success");
				expect(fn).toHaveBeenCalledTimes(1);
			});

			it("should retry up to limit and throw on final failure", async () => {
				const fn = vi
					.fn<() => Promise<string>>()
					.mockRejectedValue(new Error("failure"));
				const isRetryable = vi
					.fn<(error: unknown) => boolean>()
					.mockReturnValue(true);

				await expect(
					retryWithBackoff(fn, isRetryable, {
						retries: 2,
						minTimeoutMs: 1,
						maxTimeoutMs: 5,
						jitter: false,
					}),
				).rejects.toThrow("failure");

				expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
			});

			it("should respect Retry-After header if present", () => {
				const error = {
					response: {
						headers: {
							"retry-after": "3",
						},
					},
				};
				expect(getRetryAfterMs(error)).toBe(3000);

				const errorMixedCase = {
					response: {
						headers: {
							"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT",
						},
					},
				};
				vi.useFakeTimers();
				vi.setSystemTime(new Date("Wed, 21 Oct 2026 07:27:50 GMT"));
				expect(getRetryAfterMs(errorMixedCase)).toBe(10000);
				vi.useRealTimers();
			});
		});

		describe("ConcurrencyLimiter", () => {
			it("should limit active concurrent operations and execute in order", async () => {
				const limiter = new ConcurrencyLimiter(2);
				const activeJobs: number[] = [];
				const order: number[] = [];
				const resolves: Array<() => void> = [];

				const job = async (id: number) => {
					await limiter.run(async () => {
						activeJobs.push(id);
						expect(activeJobs.length).toBeLessThanOrEqual(2);
						await new Promise<void>((resolve) => {
							resolves.push(resolve);
						});
						activeJobs.splice(activeJobs.indexOf(id), 1);
						order.push(id);
					});
				};

				const promise = Promise.all([job(1), job(2), job(3)]);

				// Wait a tiny bit to let all run() calls reach their limit/queues
				await new Promise((resolve) => setTimeout(resolve, 5));

				// Resolve job 2 first (resolves[1])
				if (resolves[1]) resolves[1]();
				await new Promise((resolve) => setTimeout(resolve, 5));

				// Resolve job 3 (resolves[2]) which was queued and starts after job 2 finished
				if (resolves[2]) resolves[2]();
				await new Promise((resolve) => setTimeout(resolve, 5));

				// Resolve job 1 (resolves[0])
				if (resolves[0]) resolves[0]();

				await promise;
				expect(order).toEqual([2, 3, 1]);
			});
		});

		describe("TokenRefreshScheduler", () => {
			let mockTarget: {
				hasValidSession: vi.Mock<() => Promise<boolean>>;
				ensureValidToken: vi.Mock<() => Promise<string>>;
				forceRefreshToken: vi.Mock<() => Promise<string>>;
				tryAutoRecover: vi.Mock<() => Promise<void>>;
				touchHeartbeat: vi.Mock<() => Promise<void>>;
			};
			let scheduler: TokenRefreshScheduler;

			beforeEach(() => {
				mockTarget = {
					hasValidSession: vi
						.fn<() => Promise<boolean>>()
						.mockResolvedValue(true),
					ensureValidToken: vi
						.fn<() => Promise<string>>()
						.mockResolvedValue("token"),
					forceRefreshToken: vi
						.fn<() => Promise<string>>()
						.mockResolvedValue("new-token"),
					tryAutoRecover: vi
						.fn<() => Promise<void>>()
						.mockResolvedValue(undefined),
					touchHeartbeat: vi
						.fn<() => Promise<void>>()
						.mockResolvedValue(undefined),
				};
				scheduler = new TokenRefreshScheduler(mockTarget, 100);
			});

			afterEach(() => {
				scheduler.stop();
			});

			it("should run tick immediately on start and check validity", async () => {
				scheduler.start();
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(mockTarget.hasValidSession).toHaveBeenCalled();
				expect(mockTarget.ensureValidToken).toHaveBeenCalled();
			});

			it("should invoke tryAutoRecover if session is lost", async () => {
				mockTarget.hasValidSession.mockResolvedValue(false);
				scheduler.start();
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect(mockTarget.tryAutoRecover).toHaveBeenCalledWith(1);
			});
		});
	});
});
