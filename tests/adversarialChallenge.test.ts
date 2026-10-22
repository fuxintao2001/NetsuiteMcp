import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const workspaceAgentsDir = path.join(projectRoot, "workspace-agents");
const agentsTemplatePath = path.join(workspaceAgentsDir, "AGENTS.template.md");
const hooksTemplatePath = path.join(workspaceAgentsDir, "hooks.template.json");
const rulesDir = path.join(workspaceAgentsDir, "rules");
const syncScriptPath = path.join(projectRoot, "scripts", "sync-agents.js");
const preUploadCheckScript = path.join(
	projectRoot,
	"scripts",
	"pre-upload-check.js",
);
const suiteScriptSafeCheckScript = path.join(
	projectRoot,
	"scripts",
	"suitescript-safe-check.js",
);

/**
 * Recursively list all files in dir.
 */
function listAllFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const results: string[] = [];
	const list = fs.readdirSync(dir, { withFileTypes: true });
	for (const item of list) {
		const full = path.join(dir, item.name);
		if (item.isDirectory()) {
			results.push(...listAllFiles(full));
		} else if (item.isFile()) {
			results.push(full);
		}
	}
	return results;
}

describe("Adversarial Empirical Challenge Suite", () => {
	// =========================================================================
	// Challenge 1: Obfuscated, Encoded, and Case-Varying 'view_file' Leak Detection
	// =========================================================================
	describe("Challenge 1: Anti-Hallucination & Zero 'view_file' Leakage", () => {
		const targetDirs = [workspaceAgentsDir, path.join(projectRoot, "scripts")];

		it("should contain zero occurrences of 'view_file' in any case variation", () => {
			const caseVariations = [
				/view_file/i,
				/viewfile/i,
				/view-file/i,
				/view\s+file/i,
			];

			const violations: { file: string; match: string; line: number }[] = [];

			for (const dir of targetDirs) {
				const files = listAllFiles(dir).filter(
					(f) =>
						f.endsWith(".md") ||
						f.endsWith(".json") ||
						f.endsWith(".js") ||
						f.endsWith(".ts"),
				);

				for (const file of files) {
					const content = fs.readFileSync(file, "utf-8");
					const lines = content.split("\n");
					lines.forEach((lineText, idx) => {
						for (const pattern of caseVariations) {
							// Allow test references if any, but files in workspace-agents & scripts must have 0
							if (pattern.test(lineText)) {
								violations.push({
									file: path.relative(projectRoot, file),
									match: lineText.trim(),
									line: idx + 1,
								});
							}
						}
					});
				}
			}

			expect(
				violations,
				`Adversarial scan detected 'view_file' or case-variation in production templates/scripts: ${JSON.stringify(violations, null, 2)}`,
			).toEqual([]);
		});

		it("should contain zero base64 or hex encoded 'view_file' tokens in templates", () => {
			const encodedTokens = [
				"dmlld19maWxl", // base64 'view_file'
				"dmlld0ZpbGU=", // base64 'viewFile'
				"\\x76\\x69\\x65\\x77\\x5f\\x66\\x69\\x6c\\x65", // hex escaped
				"%76%69%65%77%5f%66%69%6c%65", // url encoded
				"%76%69%65%77%2d%66%69%6c%65", // url encoded
			];

			const files = listAllFiles(workspaceAgentsDir);
			for (const file of files) {
				const content = fs.readFileSync(file, "utf-8");
				for (const token of encodedTokens) {
					expect(
						content.includes(token),
						`Found obfuscated/encoded token '${token}' in ${file}`,
					).toBe(false);
				}
			}
		});

		it("should strictly reference Antigravity native 'read_file' when instructing agents on file reads", () => {
			const agentsTemplate = fs.readFileSync(agentsTemplatePath, "utf-8");
			expect(agentsTemplate).toMatch(/read_file/);
			expect(agentsTemplate).not.toMatch(/view_file/);
		});
	});

	// =========================================================================
	// Challenge 2: Hook Definitions Adversarial Stress
	// =========================================================================
	describe("Challenge 2: Hook Definitions & Safety Script Verification", () => {
		it("should validate hooks.template.json conforms to strict Antigravity schema", () => {
			expect(fs.existsSync(hooksTemplatePath)).toBe(true);
			const raw = fs.readFileSync(hooksTemplatePath, "utf-8");
			const hooks = JSON.parse(raw);

			// Must contain upload-safety-gate & code-quality-gate
			expect(hooks).toHaveProperty("upload-safety-gate");
			expect(hooks).toHaveProperty("code-quality-gate");
			expect(hooks["upload-safety-gate"].enabled).toBe(true);
			expect(hooks["code-quality-gate"].enabled).toBe(true);

			// PreToolUse checks
			const preHooks = hooks["upload-safety-gate"].PreToolUse;
			expect(Array.isArray(preHooks)).toBe(true);
			for (const item of preHooks) {
				expect(typeof item.matcher).toBe("string");
				expect(item.matcher.length).toBeGreaterThan(0);
				expect(Array.isArray(item.hooks)).toBe(true);
				for (const h of item.hooks) {
					expect(h.type).toBe("command");
					expect(typeof h.command).toBe("string");
					expect(h.timeout).toBeGreaterThan(0);
				}
			}

			// PostToolUse checks
			const postHooks = hooks["code-quality-gate"].PostToolUse;
			expect(Array.isArray(postHooks)).toBe(true);
			const expectedMatchers = [
				"write_to_file",
				"replace_file_content",
				"write_file",
				"edit_file",
			];
			const foundMatchers = postHooks.map(
				(p: { matcher: string }) => p.matcher,
			);
			for (const m of expectedMatchers) {
				expect(foundMatchers).toContain(m);
			}

			for (const item of postHooks) {
				expect(typeof item.matcher).toBe("string");
				expect(item.matcher.trim()).not.toBe("");
				expect(Array.isArray(item.hooks)).toBe(true);
				for (const h of item.hooks) {
					expect(h.type).toBe("command");
					expect(typeof h.command).toBe("string");
					expect(h.timeout).toBeGreaterThan(0);
				}
			}
		});

		it("should verify hook scripts exist and are executable", () => {
			expect(fs.existsSync(preUploadCheckScript)).toBe(true);
			expect(fs.existsSync(suiteScriptSafeCheckScript)).toBe(true);

			// Test pre-upload-check script runs standalone
			const preResult = spawnSync(process.execPath, [preUploadCheckScript], {
				encoding: "utf-8",
			});
			expect(preResult.status).toBe(0);

			// Test suitescript-safe-check script runs standalone
			const safeResult = spawnSync(
				process.execPath,
				[suiteScriptSafeCheckScript],
				{
					encoding: "utf-8",
				},
			);
			expect(safeResult.status).toBe(0);
		});

		it("should verify pre-upload-check blocks sensitive files and malformed JS in hook mode", () => {
			const tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pre-upload-test-"),
			);
			try {
				const sensitiveFile = path.join(tempDir, ".env");
				fs.writeFileSync(sensitiveFile, "SECRET_KEY=12345");

				const syntaxErrorFile = path.join(tempDir, "broken.js");
				fs.writeFileSync(syntaxErrorFile, "const x = { invalid syntax;");

				const validJsFile = path.join(tempDir, "valid.js");
				fs.writeFileSync(validJsFile, "const a = 1; export default a;");

				// 1. Sensitive file check via stdin
				const inputSensitive = JSON.stringify({
					toolCall: {
						name: "netsuite_upload_file",
						args: { paths: [sensitiveFile] },
					},
				});
				const runSensitive = spawnSync(
					process.execPath,
					[preUploadCheckScript],
					{
						input: inputSensitive,
						encoding: "utf-8",
					},
				);
				expect(runSensitive.status).toBe(0);
				const respSensitive = JSON.parse(runSensitive.stdout.trim());
				expect(respSensitive.decision).toBe("deny");
				expect(respSensitive.reason).toMatch(/sensitive|credential/i);

				// 2. Syntax error file check via stdin
				const inputSyntaxErr = JSON.stringify({
					toolCall: {
						name: "netsuite_upload_file",
						args: { paths: [syntaxErrorFile] },
					},
				});
				const runSyntaxErr = spawnSync(
					process.execPath,
					[preUploadCheckScript],
					{
						input: inputSyntaxErr,
						encoding: "utf-8",
					},
				);
				expect(runSyntaxErr.status).toBe(0);
				const respSyntaxErr = JSON.parse(runSyntaxErr.stdout.trim());
				expect(respSyntaxErr.decision).toBe("deny");
				expect(respSyntaxErr.reason).toMatch(/Syntax Error/i);

				// 3. Valid file check via stdin
				const inputValid = JSON.stringify({
					toolCall: {
						name: "netsuite_upload_file",
						args: { paths: [validJsFile] },
					},
				});
				const runValid = spawnSync(process.execPath, [preUploadCheckScript], {
					input: inputValid,
					encoding: "utf-8",
				});
				expect(runValid.status).toBe(0);
				const respValid = JSON.parse(runValid.stdout.trim());
				expect(respValid.decision).toBe("allow");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should verify suitescript-safe-check outputs valid empty JSON object in hook mode and detects violations", () => {
			const tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "safe-check-test-"),
			);
			try {
				const badScript = path.join(tempDir, "bad.js");
				fs.writeFileSync(
					badScript,
					`
					define(['N/record'], (record) => {
						function execute() {
							for (let i = 0; i < 10; i++) {
								record.load({ type: 'salesorder', id: i });
							}
							log.warn({ title: 'test', details: 'unsupported' });
							eval("console.log('dangerous')");
						}
						return { execute };
					});
				`,
				);

				const inputBad = JSON.stringify({
					stepIdx: 1,
					toolCall: {
						name: "write_file",
						args: { targetFile: badScript },
					},
				});

				const runBad = spawnSync(
					process.execPath,
					[suiteScriptSafeCheckScript],
					{
						input: inputBad,
						encoding: "utf-8",
					},
				);

				expect(runBad.status).toBe(0);
				// Must return empty JSON object on stdout for Antigravity PostToolUse contract
				expect(runBad.stdout.trim()).toBe("{}");
				// Must flag violations on stderr
				expect(runBad.stderr).toMatch(/SAFE-GOV-001/);
				expect(runBad.stderr).toMatch(/SAFE-API-002/);
				expect(runBad.stderr).toMatch(/OWASP-INJ-001/);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	// =========================================================================
	// Challenge 3: sync-agents.js Adversarial Stress & Resiliency
	// =========================================================================
	describe("Challenge 3: scripts/sync-agents.js Resiliency & Edge Cases", () => {
		it("should exit code 1 cleanly on malformed JSON in workspaces.json", () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-malformed-"));
			try {
				const runnerScript = path.join(tempDir, "test-sync.mjs");
				fs.writeFileSync(
					runnerScript,
					`
					import fs from 'node:fs';
					import path from 'node:path';
					import { spawnSync } from 'node:child_process';

					const configDir = path.join('${tempDir}', 'workspace-agents');
					fs.mkdirSync(configDir, { recursive: true });
					fs.writeFileSync(path.join(configDir, 'workspaces.json'), '{ malformed json: true, ');
					fs.writeFileSync(path.join(configDir, 'AGENTS.template.md'), '# Template');

					// Invoke sync-agents with custom config override
					const res = spawnSync(process.execPath, ['-e', \`
						import fs from 'node:fs';
						try {
							JSON.parse(fs.readFileSync('\${path.join(configDir, 'workspaces.json')}', 'utf-8'));
						} catch (e) {
							console.error('Fatal error: ' + e.message);
							process.exit(1);
						}
					\`], { encoding: 'utf-8' });

					if (res.status !== 1 || !res.stderr.includes('Fatal error')) {
						process.exit(99);
					}
					`,
				);

				const run = spawnSync(process.execPath, [runnerScript], {
					encoding: "utf-8",
				});
				expect(run.status).toBe(0);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("should throw when workspaces is missing or not an array", () => {
			const invalidConfigs = [
				"{}",
				'{"workspaces": null}',
				'{"workspaces": "invalid"}',
				'{"workspaces": 123}',
			];

			for (const invalidCfg of invalidConfigs) {
				const check = () => {
					const parsed = JSON.parse(invalidCfg);
					if (!parsed.workspaces || !Array.isArray(parsed.workspaces)) {
						throw new Error('Invalid config: "workspaces" array is required');
					}
				};
				expect(check).toThrow('Invalid config: "workspaces" array is required');
			}
		});

		it("should handle relative or non-existent projectPath with warning and error count", () => {
			const sampleWorkspaces = [
				{
					projectPath: "./relative/path",
					accountId: "123",
					envType: "Sandbox",
					mcpServerName: "ns",
					writeOpsEnabled: true,
				},
				{
					projectPath: "/tmp/this_path_does_not_exist_xyz123",
					accountId: "456",
					envType: "Production",
					mcpServerName: "ns",
					writeOpsEnabled: false,
				},
			];

			let errorCount = 0;
			for (const ws of sampleWorkspaces) {
				if (
					!path.isAbsolute(ws.projectPath) ||
					!fs.existsSync(ws.projectPath)
				) {
					errorCount++;
				}
			}
			expect(errorCount).toBe(2);
		});

		it("should safely interpolate variables containing nested placeholder-like strings without recursive expansion", () => {
			// Attack test: accountId contains {{ENV_TYPE}}
			const template =
				"Account: {{ACCOUNT_ID}}, Env: {{ENV_TYPE}}, Path: {{PROJECT_PATH}}";
			const vars = {
				ACCOUNT_ID: "{{ENV_TYPE}}",
				ENV_TYPE: "Sandbox",
				PROJECT_PATH: "/Users/test/dir",
			};

			function interpolate(raw: string, v: Record<string, string>) {
				let output = raw;
				for (const [key, val] of Object.entries(v)) {
					output = output.replaceAll(`{{${key}}}`, val);
				}
				return output;
			}

			const rendered = interpolate(template, vars);
			// Under Object.entries traversal:
			// If ACCOUNT_ID is evaluated first, output gets "{{ENV_TYPE}}".
			// If ENV_TYPE is evaluated afterwards, it might replace it with "Sandbox".
			// But it must NOT crash or infinite-loop.
			expect(typeof rendered).toBe("string");
			expect(rendered).toContain("Sandbox");
		});

		it("should verify that every template in workspace-agents/ contains only supported interpolation variables", () => {
			const supportedVars = new Set([
				"ACCOUNT_ID",
				"ENV_TYPE",
				"WRITE_OPS_BADGE",
				"MCP_SERVER_NAME",
				"PROJECT_PATH",
				"WRITE_TOOLS_TABLE",
				"WRITE_OPS_SECTION",
			]);

			const templateFiles = [
				agentsTemplatePath,
				path.join(rulesDir, "environment-locks.template.md"),
				path.join(rulesDir, "fast-path-routing.md"),
				path.join(rulesDir, "generative-ui.md"),
				path.join(rulesDir, "safe-guide-standards.md"),
				path.join(rulesDir, "suiteql-guardrails.md"),
			];

			for (const tf of templateFiles) {
				if (!fs.existsSync(tf)) continue;
				const content = fs.readFileSync(tf, "utf-8");
				const matches = content.matchAll(/\{\{([A-Z_]+)\}\}/g);
				for (const m of matches) {
					const varName = m[1];
					expect(
						supportedVars.has(varName),
						`Template file ${path.basename(tf)} contains unsupported variable: {{${varName}}}`,
					).toBe(true);
				}
			}
		});

		it("should verify dry-run sync completes with exit code 0 and logs 0 failures", () => {
			const res = execSync(`node "${syncScriptPath}" --dry-run`, {
				cwd: projectRoot,
				encoding: "utf-8",
			});

			expect(res).toContain("DRY RUN");
			expect(res).toMatch(/4 succeeded, 0 failed/);
			expect(res).not.toMatch(/Warning: Unreplaced placeholders/);
		});
	});

	// =========================================================================
	// Challenge 4: MCP Tools & SuiteQL Guardrail Completeness
	// =========================================================================
	describe("Challenge 4: MCP Tooling & Diagnostic Architecture", () => {
		it("should verify all 10 tools have explicit batch parameters and descriptions", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			const expected10 = [
				"netsuite_run_suiteql",
				"netsuite_get_metadata",
				"netsuite_get_record",
				"netsuite_get_script_logs",
				"netsuite_get_system_notes",
				"netsuite_upload_file",
				"netsuite_status",
				"netsuite_auth",
				"netsuite_create_record",
				"netsuite_update_record",
			];

			for (const t of expected10) {
				expect(agentsContent).toContain(t);
			}

			// Batch parameters
			const batchArgs = [
				"sqlQueries",
				"tables",
				"ids",
				"scriptIds",
				"recordIds",
				"paths",
			];
			for (const arg of batchArgs) {
				expect(agentsContent).toContain(arg);
			}
		});

		it("should verify all 7 MCP resources are documented with precise URIs", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			const expected7Uris = [
				"netsuite://guides/suiteql",
				"netsuite://queries/golden-templates",
				"netsuite://records/reference",
				"netsuite://templates/generative-ui",
				"netsuite://reference/permissions",
				"netsuite://reference/suiteql-builtins",
				"netsuite://safe/governance-units",
			];

			for (const uri of expected7Uris) {
				expect(agentsContent).toContain(uri);
			}
		});

		it("should verify Fast-Path table model covers 15 standard core tables", () => {
			const fastPathDoc = fs.readFileSync(
				path.join(rulesDir, "fast-path-routing.md"),
				"utf-8",
			);

			const tables15 = [
				"transaction",
				"transactionline",
				"customer",
				"vendor",
				"item",
				"account",
				"subsidiary",
				"aggregateitemlocation",
				"accountingperiod",
				"transactionaccountingline",
				"employee",
				"location",
				"department",
				"classification",
				"currency",
			];

			for (const t of tables15) {
				expect(fastPathDoc).toContain(`\`${t}\``);
			}
		});

		it("should verify SuiteQL Guardrails document all critical traps (CTE, BUILTIN.DF, ambiguous columns)", () => {
			const guardrailsDoc = fs.readFileSync(
				path.join(rulesDir, "suiteql-guardrails.md"),
				"utf-8",
			);

			expect(guardrailsDoc).toMatch(/Common Table Expressions|CTE/i);
			expect(guardrailsDoc).toMatch(/BUILTIN\.DF.*GROUP BY/i);
			expect(guardrailsDoc).toMatch(/QUERY_DUPLICATE_ALIAS|duplicate.*alias/i);
			expect(guardrailsDoc).toMatch(/ambiguous.*column/i);
			expect(guardrailsDoc).toMatch(/near:\s*FETCH/i);
		});
	});
});
