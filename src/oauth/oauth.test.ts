import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpClient } from "../utils/httpClient.js";
import { CallbackServer } from "./callbackServer.js";
import { OAuthManager } from "./manager.js";
import { base64URLEncode, generatePKCE } from "./pkce.js";
import { type SessionData, SessionStorage } from "./sessionStorage.js";
import {
	exchangeCodeForTokens,
	refreshAccessToken,
	shouldRefreshToken,
	TokenRefreshError,
} from "./tokenExchange.js";

describe("OAuth Module", () => {
	describe("PKCE Utilities", () => {
		describe("base64URLEncode", () => {
			it("should generate url safe base64 without padding", () => {
				const buf = Buffer.from("hello+world/foo=bar");
				const encoded = base64URLEncode(buf);
				expect(encoded).not.toContain("+");
				expect(encoded).not.toContain("/");
				expect(encoded).not.toContain("=");
			});
		});

		describe("generatePKCE", () => {
			it("should return a valid S256 code challenge structure", () => {
				const challengeObj = generatePKCE();
				expect(challengeObj.code_challenge_method).toBe("S256");
				expect(challengeObj.code_verifier.length).toBeGreaterThan(0);
				expect(challengeObj.code_challenge.length).toBeGreaterThan(0);

				// Verify the SHA-256 math
				const expectedChallenge = base64URLEncode(
					crypto
						.createHash("sha256")
						.update(challengeObj.code_verifier)
						.digest(),
				);
				expect(challengeObj.code_challenge).toBe(expectedChallenge);
			});
		});
	});

	describe("SessionStorage", () => {
		const tempDir = path.join(process.cwd(), ".test-session-storage");
		let storage: SessionStorage;

		beforeEach(async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
			await fs.mkdir(tempDir, { recursive: true });
			storage = new SessionStorage(tempDir);
		});

		afterEach(async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		});

		it("should return null if session file does not exist", async () => {
			const data = await storage.load();
			expect(data).toBeNull();
		});

		it("should save and load session data correctly", async () => {
			const session: SessionData = {
				authenticated: true,
				state: "state-123",
				tokens: {
					access_token: "access-tok",
					refresh_token: "refresh-tok",
					expires_in: 3600,
					expires_at: Date.now() + 3600000,
					accountId: "123456",
					clientId: "client-123",
				},
			};

			await storage.save(session);
			const loaded = await storage.load();
			expect(loaded).toEqual(session);
			expect(await storage.isAuthenticated()).toBe(true);
		});

		it("should clear the session file", async () => {
			const session: SessionData = { authenticated: true };
			await storage.save(session);
			expect(await storage.load()).toEqual(session);

			await storage.clear();
			expect(await storage.load()).toBeNull();
			expect(await storage.isAuthenticated()).toBe(false);
		});

		it("should back up and return null if the session file is corrupted JSON", async () => {
			await fs.mkdir(tempDir, { recursive: true });
			const sessionFile = path.join(tempDir, "session.json");
			await fs.writeFile(sessionFile, "{ corrupted json : ", "utf-8");

			const loaded = await storage.load();
			expect(loaded).toBeNull();

			// Check that a corrupted backup file was created
			const files = await fs.readdir(tempDir);
			const backupFile = files.find((f) => f.startsWith("session.corrupted."));
			expect(backupFile).toBeDefined();
		});
	});

	describe("TokenExchange", () => {
		let postSpy: any;

		beforeEach(() => {
			postSpy = vi.spyOn(httpClient, "post");
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		describe("shouldRefreshToken", () => {
			it("should return true if token expires in less than 75% of lifetime (e.g. 40 mins remaining on 60m token)", () => {
				const tokens = {
					access_token: "acc",
					refresh_token: "ref",
					expires_in: 3600,
					expires_at: Date.now() + 40 * 60 * 1000, // 40 mins remaining (< 45 mins)
					accountId: "123",
					clientId: "456",
				};
				expect(shouldRefreshToken(tokens)).toBe(true);
			});

			it("should return false if token expires in more than 75% of lifetime (e.g. 50 mins remaining on 60m token)", () => {
				const tokens = {
					access_token: "acc",
					refresh_token: "ref",
					expires_in: 3600,
					expires_at: Date.now() + 50 * 60 * 1000, // 50 mins remaining (> 45 mins)
					accountId: "123",
					clientId: "456",
				};
				expect(shouldRefreshToken(tokens)).toBe(false);
			});
		});

		describe("exchangeCodeForTokens", () => {
			it("should successfully exchange authorization code for tokens", async () => {
				postSpy.mockResolvedValueOnce({
					data: {
						access_token: "access_123",
						refresh_token: "refresh_123",
						expires_in: 3600,
					},
				});

				const config = {
					accountId: "123456_SB1",
					clientId: "client_id",
					redirectUri: "http://localhost",
				};
				const tokens = await exchangeCodeForTokens(
					"code_123",
					config,
					"verifier_123",
				);

				expect(tokens.access_token).toBe("access_123");
				expect(tokens.refresh_token).toBe("refresh_123");
				expect(tokens.expires_in).toBe(3600);
				expect(tokens.expires_at).toBeGreaterThan(Date.now());
				expect(postSpy).toHaveBeenCalled();
			});

			it("should throw on API exchange failure", async () => {
				const mockErr = new Error("Exchange failed");
				Object.assign(mockErr, {
					response: { status: 400, data: { error: "invalid_grant" } },
				});
				postSpy.mockRejectedValueOnce(mockErr);

				const config = {
					accountId: "123456_SB1",
					clientId: "client_id",
					redirectUri: "http://localhost",
				};
				await expect(
					exchangeCodeForTokens("code_123", config, "verifier_123"),
				).rejects.toThrow("Failed to exchange authorization code");
			});
		});

		describe("refreshAccessToken", () => {
			it("should refresh token successfully", async () => {
				postSpy.mockResolvedValueOnce({
					data: {
						access_token: "new_access",
						refresh_token: "new_refresh",
						expires_in: 3600,
					},
				});

				const oldTokens = {
					access_token: "old_access",
					refresh_token: "old_refresh",
					expires_in: 3600,
					expires_at: Date.now(),
					accountId: "123456_SB1",
					clientId: "client_id",
				};

				const result = await refreshAccessToken(oldTokens);
				expect(result.access_token).toBe("new_access");
				expect(result.refresh_token).toBe("new_refresh");
			});

			it("should classify 400/401 token refresh failure as unrecoverable", async () => {
				const mockErr = new Error("Invalid refresh token");
				Object.assign(mockErr, {
					response: { status: 400, data: { error: "invalid_grant" } },
				});
				postSpy.mockRejectedValueOnce(mockErr);

				const oldTokens = {
					access_token: "old_access",
					refresh_token: "old_refresh",
					expires_in: 3600,
					expires_at: Date.now(),
					accountId: "123456_SB1",
					clientId: "client_id",
				};

				try {
					await refreshAccessToken(oldTokens);
					expect(true).toBe(false); // Should have thrown an error
				} catch (err: any) {
					expect(err).toBeInstanceOf(TokenRefreshError);
					expect(err.recoverable).toBe(false);
				}
			});

			it("should classify 503 token refresh failure as recoverable", async () => {
				const mockErr = new Error("Service Unavailable");
				Object.assign(mockErr, { response: { status: 503 } });
				// Reject then resolve on retry
				postSpy.mockRejectedValueOnce(mockErr).mockResolvedValueOnce({
					data: {
						access_token: "new_access",
						expires_in: 3600,
					},
				});

				const oldTokens = {
					access_token: "old_access",
					refresh_token: "old_refresh",
					expires_in: 3600,
					expires_at: Date.now(),
					accountId: "123456_SB1",
					clientId: "client_id",
				};

				const result = await refreshAccessToken(oldTokens);
				expect(result.access_token).toBe("new_access");
				expect(postSpy).toHaveBeenCalledTimes(2); // Initial reject + retry success
			});
		});
	});

	describe("OAuthManager Integration tests", () => {
		const testStoragePath = path.join(
			process.cwd(),
			".test-manager-storage-rewritten",
		);
		let manager: OAuthManager;
		let startSpy: any;
		let httpPostSpy: any;

		beforeEach(async () => {
			vi.clearAllMocks();
			await fs.rm(testStoragePath, { recursive: true, force: true });

			manager = new OAuthManager({ storagePath: testStoragePath });

			// Mock CallbackServer.prototype.start
			startSpy = vi.spyOn(CallbackServer.prototype, "start");

			// Mock httpClient.post
			httpPostSpy = vi.spyOn(httpClient, "post");
		});

		afterEach(async () => {
			manager.stopProactiveRefresh();
			await fs.rm(testStoragePath, { recursive: true, force: true });
			vi.restoreAllMocks();
		});

		describe("startAuthFlow", () => {
			it("should orchestrate start, launch browser, and wait for callback", async () => {
				startSpy.mockImplementation(
					async (_state: string, callback: (code: string) => Promise<void>) => {
						// Execute callback
						await callback("new-auth-code");
					},
				);

				httpPostSpy.mockResolvedValue({
					data: {
						access_token: "new-access-token",
						refresh_token: "new-refresh-token",
						expires_in: 3600,
					},
				} as any);

				await manager.startAuthFlow({
					accountId: "9260916-sb1",
					clientId: "my-client-id",
				});

				expect(startSpy).toHaveBeenCalled();
				expect(httpPostSpy).toHaveBeenCalled();

				const finalSession = JSON.parse(
					await fs.readFile(
						path.join(testStoragePath, "session.json"),
						"utf-8",
					),
				);
				expect(finalSession.tokens.access_token).toBe("new-access-token");
				expect(finalSession.authenticated).toBe(true);
			});
		});

		describe("ensureValidToken", () => {
			it("should return current token without refresh if valid", async () => {
				const mockSession = {
					authenticated: true,
					tokens: {
						access_token: "valid-access-token",
						refresh_token: "my-refresh-token",
						expires_in: 3600,
						expires_at: Date.now() + 3000 * 1000, // valid
						accountId: "123456",
						clientId: "my-client-id",
					},
				};

				await fs.mkdir(testStoragePath, { recursive: true });
				await fs.writeFile(
					path.join(testStoragePath, "session.json"),
					JSON.stringify(mockSession),
					"utf-8",
				);

				const token = await manager.ensureValidToken();
				expect(token).toBe("valid-access-token");
				expect(httpPostSpy).not.toHaveBeenCalled();
			});

			it("should refresh token if expired or proactively renew", async () => {
				const mockSession = {
					authenticated: true,
					tokens: {
						access_token: "expired-access-token",
						refresh_token: "my-refresh-token",
						expires_in: 3600,
						expires_at: Date.now() - 100, // expired
						accountId: "123456",
						clientId: "my-client-id",
					},
				};

				await fs.mkdir(testStoragePath, { recursive: true });
				await fs.writeFile(
					path.join(testStoragePath, "session.json"),
					JSON.stringify(mockSession),
					"utf-8",
				);

				httpPostSpy.mockResolvedValue({
					data: {
						access_token: "refreshed-access-token",
						refresh_token: "my-refresh-token",
						expires_in: 3600,
					},
				} as any);

				const token = await manager.ensureValidToken();
				expect(token).toBe("refreshed-access-token");
				expect(httpPostSpy).toHaveBeenCalled();
			});
		});

		describe("tryAutoRecover", () => {
			it("should attempt recovery via refresh token if session is not authenticated but refresh token exists", async () => {
				const mockSession = {
					authenticated: false,
					tokens: {
						access_token: "expired-access-token",
						refresh_token: "my-refresh-token",
						expires_in: 3600,
						expires_at: Date.now() - 100,
						accountId: "123456",
						clientId: "my-client-id",
					},
				};

				await fs.mkdir(testStoragePath, { recursive: true });
				await fs.writeFile(
					path.join(testStoragePath, "session.json"),
					JSON.stringify(mockSession),
					"utf-8",
				);

				httpPostSpy.mockResolvedValue({
					data: {
						access_token: "recovered-access-token",
						refresh_token: "my-refresh-token",
						expires_in: 3600,
					},
				} as any);

				await manager.tryAutoRecover(1);
				expect(httpPostSpy).toHaveBeenCalled();

				const finalSession = JSON.parse(
					await fs.readFile(
						path.join(testStoragePath, "session.json"),
						"utf-8",
					),
				);
				expect(finalSession.authenticated).toBe(true);
				expect(finalSession.tokens.access_token).toBe("recovered-access-token");
			});
		});
	});
});
