import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runKeepAlive } from "./keepalive.js";

describe("Token Keepalive Daemon", () => {
	const testSessionRoot = path.join(
		os.tmpdir(),
		`netsuite-mcp-test-sessions-${Date.now()}`,
	);

	beforeEach(async () => {
		await fs.mkdir(testSessionRoot, { recursive: true });
		process.env.DAEMON_SESSION_ROOTS = testSessionRoot;
	});

	afterEach(async () => {
		delete process.env.DAEMON_SESSION_ROOTS;
		try {
			await fs.rm(testSessionRoot, { recursive: true, force: true });
		} catch {
			// Ignored
		}
	});

	it("should skip a session if token is fresh", async () => {
		const accountDir = path.join(testSessionRoot, "111111");
		await fs.mkdir(accountDir, { recursive: true });

		const freshExpiry = Date.now() + 3000 * 1000; // 50 mins left
		const sessionData = {
			config: {
				accountId: "111111",
				clientId: "client_111",
				redirectUri: "http://localhost:8080/callback",
			},
			tokens: {
				access_token: "acc_111",
				refresh_token: "ref_111",
				expires_in: 3600,
				expires_at: freshExpiry,
				accountId: "111111",
				clientId: "client_111",
			},
			authenticated: true,
		};

		const sessionFile = path.join(accountDir, "session.json");
		await fs.writeFile(sessionFile, JSON.stringify(sessionData));

		// Run keepalive (should skip)
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await runKeepAlive();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipped (token is still fresh"),
		);

		// File contents should be untouched
		const content = await fs.readFile(sessionFile, "utf-8");
		const parsed = JSON.parse(content);
		expect(parsed.tokens.access_token).toBe("acc_111");

		consoleErrorSpy.mockRestore();
	});

	it("should skip session if no configuration is present", async () => {
		const accountDir = path.join(testSessionRoot, "222222");
		await fs.mkdir(accountDir, { recursive: true });

		const sessionData = {
			authenticated: true,
		};

		const sessionFile = path.join(accountDir, "session.json");
		await fs.writeFile(sessionFile, JSON.stringify(sessionData));

		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await runKeepAlive();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipped (no tokens or credentials"),
		);

		consoleErrorSpy.mockRestore();
	});

	it("should skip session if marked unrecoverable", async () => {
		const accountDir = path.join(testSessionRoot, "333333");
		await fs.mkdir(accountDir, { recursive: true });

		const sessionData = {
			config: {
				accountId: "333333",
				clientId: "client_333",
				redirectUri: "http://localhost:8080/callback",
			},
			tokens: {
				access_token: "acc_333",
				refresh_token: "ref_333",
				expires_in: 3600,
				expires_at: Date.now() - 10000,
				accountId: "333333",
				clientId: "client_333",
			},
			authenticated: false,
			unrecoverable: true,
		};

		const sessionFile = path.join(accountDir, "session.json");
		await fs.writeFile(sessionFile, JSON.stringify(sessionData));

		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		await runKeepAlive();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Skipped (session is unrecoverable"),
		);

		consoleErrorSpy.mockRestore();
	});

	it("should skip entire keepalive scan if macOS is asleep / UserIsActive is 0", async () => {
		const resilience = await import("../utils/resilience.js");
		const spy = vi
			.spyOn(resilience, "isUserActiveOnMacOS")
			.mockResolvedValue(false);

		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await runKeepAlive();

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"macOS is in sleep / DarkWake mode (UserIsActive = 0)",
			),
		);

		consoleErrorSpy.mockRestore();
		spy.mockRestore();
	});
});
