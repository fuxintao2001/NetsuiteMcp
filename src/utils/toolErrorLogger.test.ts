import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyError,
	createToolErrorLogger,
	maskSensitiveData,
	recordToolError,
	setToolErrorLogger,
} from "./toolErrorLogger.js";

describe("toolErrorLogger", () => {
	describe("maskSensitiveData", () => {
		it("should mask sensitive keys at top level and nested objects", () => {
			const input = {
				accountId: "5848789_SB1",
				clientId: "client_12345",
				clientSecret: "super_secret_key",
				refreshToken: "refresh_token_xyz",
				password: "my_password",
				nested: {
					authHeader: "Bearer 123",
					normalField: "keep-me",
				},
				arr: [{ token: "abc" }, { normal: 42 }],
			};

			const masked = maskSensitiveData(input) as Record<string, unknown>;
			expect(masked.accountId).toBe("5848789_SB1");
			expect(masked.clientId).toBe("client_12345");
			expect(masked.clientSecret).toBe("[REDACTED]");
			expect(masked.refreshToken).toBe("[REDACTED]");
			expect(masked.password).toBe("[REDACTED]");

			const nested = masked.nested as Record<string, unknown>;
			expect(nested.authHeader).toBe("[REDACTED]");
			expect(nested.normalField).toBe("keep-me");

			const arr = masked.arr as Array<Record<string, unknown>>;
			expect(arr[0].token).toBe("[REDACTED]");
			expect(arr[1].normal).toBe(42);
		});

		it("should truncate overly long strings to prevent log explosion", () => {
			const hugeStr = "A".repeat(60_000);
			const masked = maskSensitiveData({ payload: hugeStr }) as {
				payload: string;
			};
			expect(masked.payload.length).toBeLessThan(50_000);
			expect(masked.payload).toContain("[TRUNCATED 59000 CHARS]");
		});

		it("should gracefully handle primitives, null, and undefined", () => {
			expect(maskSensitiveData(null)).toBeNull();
			expect(maskSensitiveData(undefined)).toBeUndefined();
			expect(maskSensitiveData(123)).toBe(123);
			expect(maskSensitiveData("plain text")).toBe("plain text");
		});
	});

	describe("classifyError", () => {
		it("should classify validation errors", () => {
			expect(
				classifyError("ns_getRecord", "Invalid arguments: missing id"),
			).toBe("ARGUMENT_VALIDATION");
			expect(classifyError("ns_getRecord", "Something failed", true)).toBe(
				"ARGUMENT_VALIDATION",
			);
			expect(
				classifyError(
					"netsuite_authenticate",
					"Required field clientId is missing",
				),
			).toBe("ARGUMENT_VALIDATION");
		});

		it("should classify production write blocks", () => {
			expect(
				classifyError(
					"ns_createRecord",
					"⛔ [Production Safety Violation] Operation strictly blocked in Production",
				),
			).toBe("PRODUCTION_WRITE_BLOCKED");
		});

		it("should classify permission errors", () => {
			expect(
				classifyError(
					"ns_runCustomSuiteQL",
					"INSUFFICIENT_PERMISSION: You do not have permission to view transaction",
				),
			).toBe("PERMISSION_DENIED");
			expect(
				classifyError(
					"ns_getRecord",
					"403 Forbidden NetSuite Permission Error",
				),
			).toBe("PERMISSION_DENIED");
		});

		it("should classify SuiteQL syntax errors", () => {
			expect(
				classifyError(
					"ns_runCustomSuiteQL",
					"Table or view does not exist: CUSTOM_TBL",
				),
			).toBe("SUITEQL_SYNTAX");
			expect(
				classifyError(
					"ns_getSuiteQLMetadata",
					"Invalid search criteria in SuiteQL",
				),
			).toBe("SUITEQL_SYNTAX");
		});

		it("should classify record not found errors", () => {
			expect(
				classifyError(
					"ns_getRecord",
					"RECORD_NOT_FOUND: Record with id 999999 does not exist",
				),
			).toBe("RECORD_NOT_FOUND");
		});

		it("should classify network & timeout errors", () => {
			expect(
				classifyError("ns_runReport", "connect ETIMEDOUT 192.168.1.1:443"),
			).toBe("NETWORK_OR_TIMEOUT");
			expect(
				classifyError("ns_runReport", "socket hang up - request timeout"),
			).toBe("NETWORK_OR_TIMEOUT");
		});

		it("should classify NetSuite general API errors", () => {
			expect(
				classifyError("ns_getRecord", "NetSuite Error: Unknown server status"),
			).toBe("NETSUITE_API_ERROR");
		});

		it("should fallback to SYSTEM_EXCEPTION for uncaught errors", () => {
			expect(
				classifyError(
					"unknown_tool",
					"TypeError: Cannot read properties of null",
				),
			).toBe("SYSTEM_EXCEPTION");
		});
	});

	describe("recordToolError with file logging", () => {
		const testDir = path.resolve("./tmp-test-logger");
		const testLogFile = path.join(testDir, "sync-errors.jsonl");

		beforeEach(() => {
			if (fs.existsSync(testDir)) {
				fs.rmSync(testDir, { recursive: true, force: true });
			}
			fs.mkdirSync(testDir, { recursive: true });
			const testLogger = createToolErrorLogger(testDir, {
				syncFile: testLogFile,
			});
			setToolErrorLogger(testLogger);
		});

		afterEach(() => {
			setToolErrorLogger(null);
			if (fs.existsSync(testDir)) {
				fs.rmSync(testDir, { recursive: true, force: true });
			}
		});

		it("should record structured error to file with masked parameters", () => {
			const entry = recordToolError({
				tool: "ns_runCustomSuiteQL",
				accountId: "9260916_SB1",
				environment: "Sandbox",
				durationMs: 45,
				category: "SUITEQL_SYNTAX",
				errorMessage: "Table not found: customrecord_nonexistent",
				parameters: {
					sqlQuery: "SELECT * FROM customrecord_nonexistent",
					accessToken: "secret_token_123",
				},
			});

			expect(entry.id).toBeDefined();
			expect(entry.timestamp).toBeDefined();
			expect(entry.parameters.sqlQuery).toBe(
				"SELECT * FROM customrecord_nonexistent",
			);
			expect(entry.parameters.accessToken).toBe("[REDACTED]");

			// Check file content
			expect(fs.existsSync(testLogFile)).toBe(true);
			const content = fs.readFileSync(testLogFile, "utf-8").trim();
			expect(content.length).toBeGreaterThan(0);
			const logged = JSON.parse(content);
			expect(logged.tool).toBe("ns_runCustomSuiteQL");
			expect(logged.category).toBe("SUITEQL_SYNTAX");
			expect(logged.parameters.accessToken).toBe("[REDACTED]");
		});
	});
});
