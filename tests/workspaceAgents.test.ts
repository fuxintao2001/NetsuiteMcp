import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const workspaceAgentsDir = path.join(projectRoot, "workspace-agents");
const agentsTemplatePath = path.join(workspaceAgentsDir, "AGENTS.template.md");
const hooksTemplatePath = path.join(workspaceAgentsDir, "hooks.template.json");
const rulesDir = path.join(workspaceAgentsDir, "rules");
const workspacesJsonPath = path.join(workspaceAgentsDir, "workspaces.json");

/**
 * Recursively retrieves all files within a directory.
 */
function getAllFiles(dirPath: string): string[] {
	if (!fs.existsSync(dirPath)) return [];
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...getAllFiles(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

describe("Workspace Agents E2E Acceptance Suite", () => {
	// =========================================================================
	// 1. Technical & Tool Precision
	// =========================================================================
	describe("1. Technical & Tool Precision", () => {
		it("AC-1.1: Zero instances of 'view_file' exist across workspace-agents/ and references native 'read_file'", () => {
			const allFiles = getAllFiles(workspaceAgentsDir);
			expect(allFiles.length).toBeGreaterThan(0);

			const violations: { file: string; line: number; content: string }[] = [];

			for (const file of allFiles) {
				// Only inspect text files (markdown, json)
				if (!file.endsWith(".md") && !file.endsWith(".json")) continue;

				const content = fs.readFileSync(file, "utf-8");
				const lines = content.split("\n");
				lines.forEach((lineText, idx) => {
					if (lineText.includes("view_file")) {
						violations.push({
							file: path.relative(projectRoot, file),
							line: idx + 1,
							content: lineText.trim(),
						});
					}
				});
			}

			expect(
				violations,
				`Found forbidden foreign tool 'view_file' in workspace-agents files: ${JSON.stringify(violations, null, 2)}`,
			).toEqual([]);

			// Verify AGENTS.template.md explicitly references Antigravity native read_file
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");
			expect(agentsContent).toMatch(/read_file/);
		});

		it("AC-1.2: All 11 NetSuite MCP tools (8 core + 2 sandbox mutation + 1 official gateway) are documented in AGENTS.template.md", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			const coreTools = [
				"netsuite_run_suiteql",
				"netsuite_get_metadata",
				"netsuite_get_record",
				"netsuite_get_script_logs",
				"netsuite_get_system_notes",
				"netsuite_upload_file",
				"netsuite_status",
				"netsuite_auth",
				"netsuite_call_official",
			];

			const sandboxMutationTools = [
				"netsuite_create_record",
				"netsuite_update_record",
			];

			const allTools = [...coreTools, ...sandboxMutationTools];
			expect(allTools).toHaveLength(11);

			for (const tool of allTools) {
				expect(
					agentsContent,
					`AGENTS.template.md must document tool: ${tool}`,
				).toContain(tool);
			}

			// Verify sandbox tools are explicitly marked as Sandbox-only / blocked in Production
			expect(agentsContent).toMatch(
				/netsuite_create_record[\s\S]*?(Sandbox|blocked in Production)/i,
			);
			expect(agentsContent).toMatch(
				/netsuite_update_record[\s\S]*?(Sandbox|blocked in Production)/i,
			);
		});

		it("AC-1.3: All 6 parallel batch parameters are documented in AGENTS.template.md and rules", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			const batchParams = [
				"sqlQueries",
				"tables",
				"ids",
				"scriptIds",
				"recordIds",
				"paths",
			];

			for (const param of batchParams) {
				expect(
					agentsContent,
					`AGENTS.template.md must document batch parameter: ${param}`,
				).toContain(param);
			}

			// Verify fast-path routing rule documents batch parameters
			const fastPathRulePath = path.join(rulesDir, "fast-path-routing.md");
			const fastPathContent = fs.readFileSync(fastPathRulePath, "utf-8");
			expect(fastPathContent).toContain("sqlQueries");
			expect(fastPathContent).toContain("tables");
			expect(fastPathContent).toContain("ids");
		});

		it("AC-1.4: Fast-Path whitelist contains all 15 standard core tables", () => {
			const expected15Tables = [
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
			expect(expected15Tables).toHaveLength(15);

			// 1. Check AGENTS.template.md Section 4.1 Fast-Path routing
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");
			for (const table of expected15Tables) {
				expect(
					agentsContent,
					`AGENTS.template.md Fast-Path whitelist must include table: ${table}`,
				).toContain(table);
			}

			// 2. Check workspace-agents/rules/fast-path-routing.md
			const fastPathRulePath = path.join(rulesDir, "fast-path-routing.md");
			const fastPathContent = fs.readFileSync(fastPathRulePath, "utf-8");
			for (const table of expected15Tables) {
				expect(
					fastPathContent,
					`fast-path-routing.md must include table: ${table}`,
				).toContain(table);
			}
		});

		it("AC-1.5: All 7 MCP resource URIs are documented with explicit trigger conditions in AGENTS.template.md", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			const expectedResources = [
				{
					uri: "netsuite://guides/suiteql",
					triggerPattern: /suiteql/i,
				},
				{
					uri: "netsuite://queries/golden-templates",
					triggerPattern: /golden|template/i,
				},
				{
					uri: "netsuite://records/reference",
					triggerPattern: /272|record/i,
				},
				{
					uri: "netsuite://templates/generative-ui",
					triggerPattern: /generative\s*ui|visual|component/i,
				},
				{
					uri: "netsuite://reference/permissions",
					triggerPattern: /permission|403|role/i,
				},
				{
					uri: "netsuite://reference/suiteql-builtins",
					triggerPattern: /builtin|function/i,
				},
				{
					uri: "netsuite://safe/governance-units",
					triggerPattern: /governance|unit|limit/i,
				},
			];

			expect(expectedResources).toHaveLength(7);

			for (const { uri, triggerPattern } of expectedResources) {
				expect(
					agentsContent,
					`AGENTS.template.md must contain resource URI: ${uri}`,
				).toContain(uri);

				// Verify presence of trigger condition or directive associated with the resource
				const uriIndex = agentsContent.indexOf(uri);
				const contextSnippet = agentsContent.substring(
					Math.max(0, uriIndex - 300),
					Math.min(agentsContent.length, uriIndex + 500),
				);
				expect(
					triggerPattern.test(contextSnippet),
					`Resource ${uri} must have associated trigger/directive context`,
				).toBe(true);
			}
		});

		it("AC-1.6: Self-Healing SOP covers at least 12 distinct NetSuite error diagnostic categories matching suiteqlGuard.ts", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			// Locate Section 6 (Self-Healing SOP)
			const selfHealingSectionMatch = agentsContent.match(
				/##\s*🔄\s*6\.\s*Self-Healing Error Recovery SOP[\s\S]*?(?:\n---\n|\n##\s|$)/,
			);
			expect(
				selfHealingSectionMatch,
				"AGENTS.template.md must have Section 6 Self-Healing Error Recovery SOP",
			).toBeTruthy();

			const section6Content = selfHealingSectionMatch![0];

			// Diagnostic categories required to match suiteqlGuard.ts
			const diagnosticCategories = [
				{
					id: "METADATA_DISCOVERY",
					pattern: /Call netsuite_get_metadata|unverified column|invalid table/i,
				},
				{
					id: "MAINLINE_FILTER",
					pattern: /mainline.*filter/i,
				},
				{
					id: "INVENTORY_ITEM_LOCATIONS",
					pattern: /inventoryitemlocations/i,
				},
				{
					id: "PROHIBITED_JOIN_SYSTEMNOTE",
					pattern: /JOIN SystemNote/i,
				},
				{
					id: "PERMISSION_DENIED_HARD_STOP",
					pattern: /PERMISSION DENIED/i,
				},
				{
					id: "PRODUCTION_SAFETY_VIOLATION",
					pattern: /Production Safety Violation/i,
				},
				{
					id: "PAGINATION_LIMIT_DIALECT",
					pattern: /FETCH FIRST|LIMIT/i,
				},
				{
					id: "NETWORK_OR_TIMEOUT",
					pattern: /NETWORK_OR_TIMEOUT|Gateway Timeout/i,
				},
				{
					id: "DERIVED_TABLE_SUBQUERY",
					pattern: /derived table|subquer(y|ies) in FROM|CTE/i,
				},
				{
					id: "BUILTIN_DF_GROUP_BY",
					pattern: /BUILTIN\.DF.*(GROUP BY|Grouped)/i,
				},
				{
					id: "DUPLICATE_COLUMN_ALIAS",
					pattern: /duplicate.*alias/i,
				},
				{
					id: "AMBIGUOUS_COLUMN",
					pattern: /ambiguous.*column/i,
				},
				{
					id: "FALSE_NEAR_FETCH_TRAP",
					pattern: /near:\s*FETCH/i,
				},
				{
					id: "GROUP_BY_NON_AGGREGATED",
					pattern: /GROUP BY expression|non-aggregated/i,
				},
				{
					id: "INVALID_FIELD_LOCATION",
					pattern: /createdfrom|recordtype/i,
				},
				{
					id: "TABLE_NOT_ACCESSIBLE_BIN",
					pattern: /table not directly accessible|bin.*inventorybalance/i,
				},
				{
					id: "FUNCTION_IN_JOIN_ON",
					pattern: /function.*JOIN ON|performance hazard/i,
				},
				{
					id: "UNINDEXED_SYSTEMNOTE_SCAN",
					pattern: /unindexed.*systemnote/i,
				},
				{
					id: "UNINDEXED_TRANSACTION_QUERY",
					pattern: /unindexed.*transaction/i,
				},
				{
					id: "NON_ORACLE_DIALECT_FUNCTIONS",
					pattern: /non-oracle|SYSDATE|NVL|LISTAGG/i,
				},
			];

			let matchedCount = 0;
			const missingCategories: string[] = [];

			for (const cat of diagnosticCategories) {
				if (cat.pattern.test(section6Content)) {
					matchedCount++;
				} else {
					missingCategories.push(cat.id);
				}
			}

			expect(
				matchedCount,
				`Self-Healing SOP must cover at least 12 distinct diagnostic categories matching suiteqlGuard.ts. Matched: ${matchedCount}. Missing: ${missingCategories.join(", ")}`,
			).toBeGreaterThanOrEqual(12);
		});
	});

	// =========================================================================
	// 2. Hook & Rule Synchronization
	// =========================================================================
	describe("2. Hook & Rule Synchronization", () => {
		it("AC-2.1: workspace-agents/hooks.template.json contains write_file and edit_file in code-quality-gate.PostToolUse", () => {
			expect(fs.existsSync(hooksTemplatePath)).toBe(true);
			const rawHooks = fs.readFileSync(hooksTemplatePath, "utf-8");
			const hooks = JSON.parse(rawHooks);

			expect(hooks).toHaveProperty("code-quality-gate");
			expect(hooks["code-quality-gate"]).toHaveProperty("enabled", true);
			expect(hooks["code-quality-gate"]).toHaveProperty("PostToolUse");

			const postToolUseEntries = hooks["code-quality-gate"].PostToolUse;
			expect(Array.isArray(postToolUseEntries)).toBe(true);

			const matchers = postToolUseEntries.map(
				(entry: { matcher: string }) => entry.matcher,
			);

			// Required matchers: write_to_file, replace_file_content, write_file, edit_file
			expect(matchers).toContain("write_to_file");
			expect(matchers).toContain("replace_file_content");
			expect(
				matchers,
				"hooks.template.json must include Antigravity native 'write_file' matcher",
			).toContain("write_file");
			expect(
				matchers,
				"hooks.template.json must include Antigravity native 'edit_file' matcher",
			).toContain("edit_file");

			// Verify each hook command runs suitescript-safe-check.js
			for (const entry of postToolUseEntries) {
				expect(entry.hooks).toBeDefined();
				expect(entry.hooks.length).toBeGreaterThan(0);
				const cmd = entry.hooks[0].command;
				expect(cmd).toContain("suitescript-safe-check.js");
			}

			// Verify upload safety gate
			expect(hooks).toHaveProperty("upload-safety-gate");
			expect(hooks["upload-safety-gate"].PreToolUse[0].matcher).toBe(
				"netsuite_upload_file",
			);
			expect(
				hooks["upload-safety-gate"].PreToolUse[0].hooks[0].command,
			).toContain("pre-upload-check.js");
		});

		it("AC-2.2: Rule files in workspace-agents/rules/ have clean syntax, zero broken references, zero historical version narratives", () => {
			expect(fs.existsSync(rulesDir)).toBe(true);
			const ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
			expect(ruleFiles.length).toBeGreaterThanOrEqual(5);

			const expectedRuleFiles = [
				"fast-path-routing.md",
				"suiteql-guardrails.md",
				"safe-guide-standards.md",
				"environment-locks.template.md",
				"generative-ui.md",
			];

			for (const expectedFile of expectedRuleFiles) {
				expect(
					ruleFiles,
					`workspace-agents/rules/ must contain ${expectedFile}`,
				).toContain(expectedFile);
			}

			const antiVersionNarrativePatterns = [
				/in (the )?previous version/i,
				/previously we (used|had|implemented|relied)/i,
				/now (we )?refactored to/i,
				/compared to earlier versions/i,
				/upgraded from (v\d|\d\.\d)/i,
				/in older versions/i,
				/deprecated implementation was/i,
			];

			for (const file of ruleFiles) {
				const fullPath = path.join(rulesDir, file);
				const content = fs.readFileSync(fullPath, "utf-8");

				// 1. Anti-version narrative check
				for (const pattern of antiVersionNarrativePatterns) {
					const match = content.match(pattern);
					expect(
						match,
						`Forbidden version iteration narrative found in ${file}: "${match?.[0]}"`,
					).toBeNull();
				}

				// 2. Link integrity check: check file:// links
				const fileLinkMatches = content.matchAll(
					/\[([^\]]+)\]\((file:\/\/\{\{PROJECT_PATH\}\}[^\)]+)\)/g,
				);
				for (const linkMatch of fileLinkMatches) {
					const rawUrl = linkMatch[2];
					// Strip file://{{PROJECT_PATH}}/
					const relativeTarget = rawUrl.replace(
						"file://{{PROJECT_PATH}}/",
						"",
					);

					if (relativeTarget === "AGENTS.md") {
						// Expected root target
						expect(true).toBe(true);
					} else if (relativeTarget.startsWith(".agents/rules/")) {
						const ruleTargetName = relativeTarget.replace(
							".agents/rules/",
							"",
						);
						// If pointing to environment-locks.md, it maps to environment-locks.template.md
						const sourceName =
							ruleTargetName === "environment-locks.md"
								? "environment-locks.template.md"
								: ruleTargetName;
						const sourcePath = path.join(rulesDir, sourceName);
						expect(
							fs.existsSync(sourcePath),
							`Link target '${rawUrl}' in ${file} resolves to non-existent rule '${sourceName}'`,
						).toBe(true);
					}
				}
			}
		});

		it("AC-2.3: Template interpolation placeholders in AGENTS.template.md and rules are intact", () => {
			const agentsContent = fs.readFileSync(agentsTemplatePath, "utf-8");

			const requiredPlaceholders = [
				"{{ACCOUNT_ID}}",
				"{{ENV_TYPE}}",
				"{{WRITE_OPS_BADGE}}",
				"{{MCP_SERVER_NAME}}",
				"{{PROJECT_PATH}}",
				"{{WRITE_TOOLS_TABLE}}",
				"{{WRITE_OPS_SECTION}}",
			];

			for (const placeholder of requiredPlaceholders) {
				expect(
					agentsContent,
					`AGENTS.template.md must retain placeholder: ${placeholder}`,
				).toContain(placeholder);
			}

			// Verify environment-locks.template.md placeholders
			const envLocksPath = path.join(rulesDir, "environment-locks.template.md");
			const envLocksContent = fs.readFileSync(envLocksPath, "utf-8");
			expect(envLocksContent).toContain("{{ACCOUNT_ID}}");
			expect(envLocksContent).toContain("{{ENV_TYPE}}");
			expect(envLocksContent).toContain("{{WRITE_OPS_BADGE}}");
			expect(envLocksContent).toContain("{{WRITE_TOOLS_TABLE}}");
			expect(envLocksContent).toContain("{{WRITE_OPS_SECTION}}");
		});
	});

	// =========================================================================
	// 3. Programmatic Build & Verification Gate
	// =========================================================================
	describe("3. Programmatic Build & Verification Gate", () => {
		it("AC-3.1: Executes 'node scripts/sync-agents.js --dry-run' with exit code 0 and 0 unreplaced placeholders", () => {
			expect(fs.existsSync(workspacesJsonPath)).toBe(true);

			const result = execSync("node scripts/sync-agents.js --dry-run", {
				cwd: projectRoot,
				encoding: "utf-8",
				stdio: "pipe",
			});

			// Verify dry run output structure
			expect(result).toContain("DRY RUN");
			expect(result).toMatch(/succeeded.*0 failed/i);

			// Assert no unreplaced placeholder warnings in stdout
			expect(result).not.toContain("Unreplaced placeholders");
			expect(result).not.toMatch(/⚠️\s*Warning: Unreplaced placeholders in/);
		});

		it("AC-3.2: Programmatically verifies template rendering for every configured workspace", () => {
			const rawWorkspaces = fs.readFileSync(workspacesJsonPath, "utf-8");
			const config = JSON.parse(rawWorkspaces);
			expect(Array.isArray(config.workspaces)).toBe(true);
			expect(config.workspaces.length).toBeGreaterThan(0);

			const template = fs.readFileSync(agentsTemplatePath, "utf-8");

			const WRITE_TOOLS_TABLE_SANDBOX = `| Tool | Permissions & Behavior |
|:---|:---|
| \`netsuite_create_record\` | Create a new record in Sandbox (cleans noise, generates Web UI link) |
| \`netsuite_update_record\` | Update an existing record in Sandbox (resolves natural keys, generates Web UI link) |
| \`netsuite_upload_file\` | Upload SuiteScript files via SuiteCloud CLI (simplified card confirmation) |`;

			const WRITE_TOOLS_TABLE_PRODUCTION = `> 🔒 **Production Safety Guard**: Mutation tools (\`netsuite_create_record\`, \`netsuite_update_record\`) are strictly blocked and filtered out in Production. File upload to Production requires explicit confirmation.`;

			const WRITE_OPS_SECTION_SANDBOX = `### Record Mutations & File Upload (✅ Sandbox Enabled)
- **Record Mutations**: Inspect schema via \`netsuite_get_metadata\` ➔ Build valid JSON ➔ Execute \`netsuite_create_record\` or \`netsuite_update_record\`.
- **File Upload Card Protocol**: When uploading code, display an interactive confirmation card (\`ask_question\`) extracting the workspace folder name and filename from the absolute path (e.g. from \`/Users/fuxintao/WebstormProjects/9260916/...\` extract \`9260916\` and combine with the filename: \`9260916/test.js\`), with choices "(Recommended) Accept" and "Reject". Call \`netsuite_upload_file\` directly upon acceptance.`;

			const WRITE_OPS_SECTION_PRODUCTION = `### Simplified File Upload (🔒 Production Read-Only)
- **Record Mutations**: Strictly blocked. Never attempt record creation or updates in Production.
- **File Upload Card Protocol**: When uploading code to Production, display an interactive confirmation card (\`ask_question\`) extracting the workspace folder name and filename from the absolute path (e.g. \`9260916/test.js\`), with choices "(Recommended) Accept" and "Reject". Call \`netsuite_upload_file\` with \`allowProduction: true\` directly upon acceptance.`;

			for (const ws of config.workspaces) {
				const { projectPath, accountId, envType, mcpServerName, writeOpsEnabled } =
					ws;

				const vars: Record<string, string> = {
					ACCOUNT_ID: accountId,
					ENV_TYPE: envType,
					MCP_SERVER_NAME: mcpServerName,
					WRITE_OPS_BADGE: writeOpsEnabled ? "✅ Enabled" : "❌ Disabled",
					PROJECT_PATH: projectPath,
					WRITE_TOOLS_TABLE: writeOpsEnabled
						? WRITE_TOOLS_TABLE_SANDBOX
						: WRITE_TOOLS_TABLE_PRODUCTION,
					WRITE_OPS_SECTION: writeOpsEnabled
						? WRITE_OPS_SECTION_SANDBOX
						: WRITE_OPS_SECTION_PRODUCTION,
				};

				let rendered = template;
				for (const [key, value] of Object.entries(vars)) {
					rendered = rendered.replaceAll(`{{${key}}}`, value);
				}

				// Check for any remaining {{VARIABLE}}
				const unreplaced = rendered.match(/\{\{[A-Z_]+\}\}/g);
				expect(
					unreplaced,
					`Workspace ${accountId} rendered with unreplaced placeholders: ${unreplaced?.join(", ")}`,
				).toBeNull();

				// Check environment badge
				if (writeOpsEnabled) {
					expect(rendered).toContain("✅ Enabled");
					expect(rendered).toContain("netsuite_create_record");
				} else {
					expect(rendered).toContain("❌ Disabled");
					expect(rendered).toContain("Production Safety Guard");
				}
			}
		});
	});
});
