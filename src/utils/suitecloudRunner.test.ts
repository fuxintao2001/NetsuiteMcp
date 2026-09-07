import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { suitecloudRunnerService } from "./suitecloudRunner.js";

describe("SuiteCloudRunnerService", () => {
	it("should find SDF project root correctly with priority for suitecloud.config.js", () => {
		const tmpDir = path.join(process.cwd(), "temp-test-root-sdf");
		fs.mkdirSync(path.join(tmpDir, "src", "FileCabinet", "SuiteScripts"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(tmpDir, "suitecloud.config.js"),
			"module.exports={};",
		);
		fs.writeFileSync(path.join(tmpDir, "project.json"), "{}");
		fs.writeFileSync(path.join(tmpDir, "src", "manifest.xml"), "<manifest/>");

		const rootFromNested = suitecloudRunnerService.findSdfProjectRoot(
			path.join(tmpDir, "src", "FileCabinet", "SuiteScripts"),
		);
		expect(rootFromNested).toBe(tmpDir);

		// Clean up
		fs.rmSync(tmpDir, { recursive: true, force: true });
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

	it("should normalize file cabinet paths correctly including SuiteApps", () => {
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath(
				"/Users/foo/project/src/FileCabinet/SuiteScripts/test.js",
			),
		).toBe("/SuiteScripts/test.js");
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath(
				"src/FileCabinet/SuiteScripts/sub/test.js",
			),
		).toBe("/SuiteScripts/sub/test.js");
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath("SuiteScripts/test.js"),
		).toBe("/SuiteScripts/test.js");
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath("/SuiteScripts/test.js"),
		).toBe("/SuiteScripts/test.js");
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath(
				"/SuiteApps/com.sample.app/main.js",
			),
		).toBe("/SuiteApps/com.sample.app/main.js");
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath(
				"src/FileCabinet/SuiteApps/com.sample.app/main.js",
			),
		).toBe("/SuiteApps/com.sample.app/main.js");
	});

	it("should perform fuzzy search for bare filenames in FileCabinet", () => {
		const tmpDir = path.join(process.cwd(), "temp-test-fuzzy");
		fs.mkdirSync(
			path.join(tmpDir, "src", "FileCabinet", "SuiteScripts", "sub"),
			{
				recursive: true,
			},
		);
		fs.writeFileSync(
			path.join(
				tmpDir,
				"src",
				"FileCabinet",
				"SuiteScripts",
				"sub",
				"fuzzy_script.js",
			),
			"/**\n * @NApiVersion 2.1\n * @NScriptType Suitelet\n */\ndefine([], () => ({ onRequest: () => {} }));",
		);

		const result = suitecloudRunnerService.inspectLocalFile(
			tmpDir,
			"fuzzy_script.js",
		);
		expect(result.exists).toBe(true);
		expect(result.fileCabinetPath).toBe("/SuiteScripts/sub/fuzzy_script.js");
		expect(result.scriptType).toBe("Suitelet");
		expect(result.apiVersion).toBe("2.1");
		expect(result.syntaxValid).toBe(true);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should validate SuiteScript syntax and detect errors", () => {
		const validJs =
			"/** @NApiVersion 2.1\n * @NScriptType UserEventScript */\ndefine(['N/record'], (record) => { return { beforeLoad: () => {} }; });";
		const validRes = suitecloudRunnerService.validateSuiteScriptContent(
			"test.js",
			validJs,
		);
		expect(validRes.syntaxValid).toBe(true);
		expect(validRes.apiVersion).toBe("2.1");
		expect(validRes.scriptType).toBe("UserEventScript");

		const brokenJs = "function broken( { return 123; }";
		const brokenRes = suitecloudRunnerService.validateSuiteScriptContent(
			"broken.js",
			brokenJs,
		);
		expect(brokenRes.syntaxValid).toBe(false);
		expect(brokenRes.syntaxError).toBeDefined();
		expect(brokenRes.warnings.length).toBeGreaterThan(0);
	});

	it("should resolve multi-file arrays, comma lists, and directory expansions", () => {
		const tmpDir = path.join(process.cwd(), "temp-test-multi");
		const dirPath = path.join(
			tmpDir,
			"src",
			"FileCabinet",
			"SuiteScripts",
			"batch",
		);
		fs.mkdirSync(dirPath, { recursive: true });
		fs.writeFileSync(path.join(dirPath, "f1.js"), "console.log(1);");
		fs.writeFileSync(path.join(dirPath, "f2.js"), "console.log(2);");

		// Test array resolution
		const arrayRes = suitecloudRunnerService.resolveUploadFiles(tmpDir, [
			"/SuiteScripts/batch/f1.js",
			"/SuiteScripts/batch/f2.js",
		]);
		expect(arrayRes.files.length).toBe(2);
		expect(arrayRes.missingCount).toBe(0);

		// Test directory expansion
		const dirRes = suitecloudRunnerService.resolveUploadFiles(
			tmpDir,
			"/SuiteScripts/batch",
		);
		expect(dirRes.files.length).toBe(2);
		expect(dirRes.files.map((f) => f.fileCabinetPath)).toContain(
			"/SuiteScripts/batch/f1.js",
		);
		expect(dirRes.files.map((f) => f.fileCabinetPath)).toContain(
			"/SuiteScripts/batch/f2.js",
		);

		// Test comma-separated resolution
		const commaRes = suitecloudRunnerService.resolveUploadFiles(
			tmpDir,
			"/SuiteScripts/batch/f1.js, /SuiteScripts/batch/f2.js",
		);
		expect(commaRes.files.length).toBe(2);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should synchronize project.json Auth ID properly", async () => {
		const tmpDir = path.join(process.cwd(), "temp-test-auth");
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, "project.json"),
			JSON.stringify({ defaultAuthId: "old-auth" }),
		);

		vi.spyOn(
			suitecloudRunnerService,
			"getAvailableAuthIds",
		).mockResolvedValueOnce([
			{ authId: "9260916_SB1-Adm-Sand", account: "9260916_SB1", role: "Admin" },
			{ authId: "5848789-Adm-Prod", account: "5848789", role: "Admin" },
		]);

		const res = await suitecloudRunnerService.syncProjectAuthId(
			tmpDir,
			"9260916_SB1",
		);
		expect(res.matchedAuthId).toBe("9260916_SB1-Adm-Sand");
		expect(res.autoUpdated).toBe(true);

		const updatedProjectJson = JSON.parse(
			fs.readFileSync(path.join(tmpDir, "project.json"), "utf-8"),
		);
		expect(updatedProjectJson.defaultAuthId).toBe("9260916_SB1-Adm-Sand");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should generate diagnostic recommendations on error", () => {
		const tipsAuth = suitecloudRunnerService.diagnoseUploadError(
			"MISSING_DEFAULT_AUTH_ID: No default auth id set",
			"",
			{ targetAccountId: "9260916_SB1", paths: ["/SuiteScripts/test.js"] },
		);
		expect(tipsAuth[0]).toContain("SuiteCloud 认证缺失");

		const tipsFolder = suitecloudRunnerService.diagnoseUploadError(
			"The folder /SuiteScripts/unknown does not exist in the File Cabinet",
			"",
			{
				targetAccountId: "9260916_SB1",
				paths: ["/SuiteScripts/unknown/test.js"],
			},
		);
		expect(tipsFolder[0]).toContain("File Cabinet 目标目录不存在");

		const tipsContention = suitecloudRunnerService.diagnoseUploadError(
			"System contention caused by operation on other objects",
			"",
			{ targetAccountId: "9260916_SB1", paths: ["/SuiteScripts/test.js"] },
		);
		expect(tipsContention[0]).toContain("系统临时资源争用");
	});
});
