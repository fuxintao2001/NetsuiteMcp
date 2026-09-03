import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppConfig, resolveSessionPath } from "./config.js";

describe("Configuration & Environment Decoupling (Phase 1)", () => {
	const tempDir = path.join(os.tmpdir(), `netsuite-config-test-${Date.now()}`);

	beforeEach(async () => {
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignored
		}
	});

	describe("resolveSessionPath", () => {
		it("should use customPath if provided directly", () => {
			const resolved = resolveSessionPath("my_acc", "/custom/path");
			expect(resolved).toBe(path.resolve("/custom/path"));
		});

		it("should resolve standard path with accountId subdirectory", () => {
			const resolved = resolveSessionPath(
				"123456_SB1",
				undefined,
				"/base/sessions",
			);
			expect(resolved).toBe(path.join("/base/sessions", "123456_sb1"));
		});
	});

	describe("loadAppConfig", () => {
		it("should load configuration from a valid netsuite.config.json file", async () => {
			const configFilePath = path.join(tempDir, "netsuite.config.json");
			const sampleConfig = {
				defaultCallbackPort: 9090,
				sessionsDir: path.join(tempDir, "sessions"),
				accounts: {
					sb_primary: {
						accountId: "5848789-sb1",
						clientId: "client_abc_123",
						callbackPort: 9091,
					},
				},
			};

			await fs.writeFile(configFilePath, JSON.stringify(sampleConfig, null, 2));

			const loaded = loadAppConfig(configFilePath, tempDir);
			expect(loaded.defaultCallbackPort).toBe(9090);
			expect(loaded.accounts.sb_primary).toBeDefined();
			expect(loaded.accounts.sb_primary.accountId).toBe("5848789-sb1");
			expect(loaded.accounts.sb_primary.clientId).toBe("client_abc_123");
			expect(loaded.accounts.sb_primary.callbackPort).toBe(9091);
			expect(loaded.accounts.sb_primary.sessionPath).toBe(
				path.join(tempDir, "sessions", "sb_primary"),
			);
		});

		it("should discover accounts from environment variables when no file exists", () => {
			const oldEnv = { ...process.env };
			try {
				process.env.NETSUITE_ACCOUNTS = "test_acct_1,test_acct_2";
				process.env.NETSUITE_CLIENT_ID_TEST_ACCT_1 = "client_1";
				process.env.NETSUITE_CLIENT_ID_TEST_ACCT_2 = "client_2";

				const loaded = loadAppConfig(undefined, tempDir);
				expect(loaded.accounts.test_acct_1).toBeDefined();
				expect(loaded.accounts.test_acct_1.clientId).toBe("client_1");
				expect(loaded.accounts.test_acct_2).toBeDefined();
				expect(loaded.accounts.test_acct_2.clientId).toBe("client_2");
			} finally {
				process.env = oldEnv;
			}
		});
	});
});
