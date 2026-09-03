import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { suitecloudRunnerService } from "./suitecloudRunner.js";

describe("SuiteCloudRunnerService", () => {
	it("should generate a valid confirmation token and consume it successfully", () => {
		const payload = {
			paths: "/SuiteScripts/my_script.js",
			accountId: "9260916_sb1",
			projectPath: "/some/project",
		};

		const token = suitecloudRunnerService.generateToken(payload);
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(10);

		// Consume the token successfully
		const res = suitecloudRunnerService.consumeToken(token, {
			paths: "/SuiteScripts/my_script.js",
			accountId: "9260916_sb1",
		});

		expect(res.valid).toBe(true);

		// Second consumption should fail (single-use anti-replay)
		const secondTry = suitecloudRunnerService.consumeToken(token, {
			paths: "/SuiteScripts/my_script.js",
			accountId: "9260916_sb1",
		});
		expect(secondTry.valid).toBe(false);
		expect(secondTry.reason).toContain("invalid or has expired");
	});

	it("should reject token if paths or account do not match", () => {
		const token = suitecloudRunnerService.generateToken({
			paths: "/SuiteScripts/script_a.js",
			accountId: "9260916_sb1",
			projectPath: "/some/project",
		});

		// Mismatched path
		const pathMismatch = suitecloudRunnerService.consumeToken(token, {
			paths: "/SuiteScripts/script_b.js",
			accountId: "9260916_sb1",
		});
		expect(pathMismatch.valid).toBe(false);
		expect(pathMismatch.reason).toContain("Upload paths do not match");

		// New token for account mismatch test
		const token2 = suitecloudRunnerService.generateToken({
			paths: "/SuiteScripts/script_a.js",
			accountId: "9260916_sb1",
			projectPath: "/some/project",
		});

		const accMismatch = suitecloudRunnerService.consumeToken(token2, {
			paths: "/SuiteScripts/script_a.js",
			accountId: "1234567_sb1",
		});
		expect(accMismatch.valid).toBe(false);
		expect(accMismatch.reason).toContain("Target account ID does not match");
	});

	it("should inspect local files correctly", () => {
		const tmpDir = path.join(process.cwd(), "temp-test-sdf");
		fs.mkdirSync(path.join(tmpDir, "src", "FileCabinet", "SuiteScripts"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(tmpDir, "src", "FileCabinet", "SuiteScripts", "test.js"),
			"console.log(1);",
		);

		const result = suitecloudRunnerService.inspectLocalFile(
			tmpDir,
			"/SuiteScripts/test.js",
		);
		expect(result.exists).toBe(true);
		expect(result.sizeBytes).toBeGreaterThan(0);

		const missing = suitecloudRunnerService.inspectLocalFile(
			tmpDir,
			"/SuiteScripts/missing.js",
		);
		expect(missing.exists).toBe(false);

		// Clean up
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
