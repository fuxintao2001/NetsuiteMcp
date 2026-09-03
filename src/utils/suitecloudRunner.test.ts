import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { suitecloudRunnerService } from "./suitecloudRunner.js";

describe("SuiteCloudRunnerService", () => {
	it("should find SDF project root correctly with priority for suitecloud.config.js", () => {
		const tmpDir = path.join(process.cwd(), "temp-test-root-sdf");
		fs.mkdirSync(path.join(tmpDir, "src", "FileCabinet", "SuiteScripts"), {
			recursive: true,
		});
		fs.writeFileSync(path.join(tmpDir, "suitecloud.config.js"), "module.exports={};");
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

	it("should normalize file cabinet paths correctly", () => {
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
			suitecloudRunnerService.normalizeFileCabinetPath(
				"SuiteScripts/test.js",
			),
		).toBe("/SuiteScripts/test.js");
		expect(
			suitecloudRunnerService.normalizeFileCabinetPath(
				"/SuiteScripts/test.js",
			),
		).toBe("/SuiteScripts/test.js");
	});
});
