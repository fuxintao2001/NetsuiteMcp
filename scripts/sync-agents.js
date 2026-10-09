/**
 * sync-agents.js — Synchronize AGENTS.md and Antigravity .agents/ structure to all NetSuite workspace projects.
 *
 * Usage:
 *   npm run sync-agents              # Execute sync to all workspaces
 *   npm run sync-agents -- --dry-run # Preview changes without writing
 *   npm run sync-agents -- --push    # Execute sync and git push to remote branches
 *   npm run sync-agents -- --watch   # Watch workspace-agents/ and auto-sync on change (debounced 2s)
 *
 * Reads workspace-agents/ templates and workspace-agents/workspaces.json,
 * substitutes environment-specific variables, and provisions:
 * 1. Project-level AGENTS.md (core charter & SOP)
 * 2. .agents/hooks.json (lifecycle safety gates)
 * 3. .agents/rules/*.md (modular directives: Fast-Path, SuiteQL, SAFE, Generative UI, Environment Locks)
 * 4. scripts/ (pre-upload-check.js & suitescript-safe-check.js)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const templatePath = path.join(
	projectRoot,
	"workspace-agents",
	"AGENTS.template.md",
);
const hooksTemplatePath = path.join(
	projectRoot,
	"workspace-agents",
	"hooks.template.json",
);
const rulesSourceDir = path.join(projectRoot, "workspace-agents", "rules");
const configPath = path.join(
	projectRoot,
	"workspace-agents",
	"workspaces.json",
);

// ---------------------------------------------------------------------------
// Conditional Content Blocks
// ---------------------------------------------------------------------------

const WRITE_TOOLS_TABLE_SANDBOX = `| Tool | Permissions & Behavior |
|:---|:---|
| \`netsuite_create_record\` | Create a new record in Sandbox (cleans noise, generates Web UI link) |
| \`netsuite_update_record\` | Update an existing record in Sandbox (resolves natural keys, generates Web UI link) |
| \`netsuite_deploy_script\` | Deploy SuiteScript code via SuiteCloud CLI (simplified card confirmation) |`;

const WRITE_TOOLS_TABLE_PRODUCTION = `> 🔒 **Production Safety Guard**: Mutation tools (\`netsuite_create_record\`, \`netsuite_update_record\`) are strictly blocked and filtered out in Production. Code deployment to Production requires explicit confirmation.`;

const WRITE_OPS_SECTION_SANDBOX = `### Record Mutations & Code Deployment (✅ Sandbox Enabled)
- **Record Mutations**: Inspect schema via \`netsuite_get_metadata\` ➔ Build valid JSON ➔ Execute \`netsuite_create_record\` or \`netsuite_update_record\`.
- **File Upload Card Protocol**: When deploying code, display an interactive confirmation card (\`ask_question\`) showing only the file's absolute path, with choices "接受" and "拒绝". Call \`netsuite_deploy_script\` directly upon acceptance.`;

const WRITE_OPS_SECTION_PRODUCTION = `### Simplified File Upload & Code Deployment (🔒 Production Read-Only)
- **Record Mutations**: Strictly blocked. Never attempt record creation or updates in Production.
- **File Upload Card Protocol**: When uploading code to Production, display an interactive confirmation card (\`ask_question\`) showing only the file's absolute path, with choices "接受" and "拒绝". Call \`netsuite_deploy_script\` with \`allowProduction: true\` directly upon acceptance.`;

// ---------------------------------------------------------------------------
// Helper: Variable Interpolator
// ---------------------------------------------------------------------------
function interpolateTemplate(rawTemplate, vars) {
	let output = rawTemplate;
	for (const [key, value] of Object.entries(vars)) {
		output = output.replaceAll(`{{${key}}}`, value);
	}
	return output;
}

// ---------------------------------------------------------------------------
// Main Sync Runner
// ---------------------------------------------------------------------------

export function runSync({ dryRun = false, shouldPush = false } = {}) {
	if (!fs.existsSync(templatePath)) {
		throw new Error(`Template not found: ${templatePath}`);
	}
	if (!fs.existsSync(configPath)) {
		console.log("ℹ️  workspaces.json not found, skipping sync (run 'cp workspace-agents/workspaces.example.json workspace-agents/workspaces.json' to configure).");
		process.exit(0);
	}
	const template = fs.readFileSync(templatePath, "utf-8");
	const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

	if (!config.workspaces || !Array.isArray(config.workspaces)) {
		throw new Error('Invalid config: "workspaces" array is required');
	}

	console.log(`📋 Template: ${templatePath}`);
	console.log(`📋 Config: ${config.workspaces.length} workspaces`);
	console.log(`📋 Mode: ${dryRun ? "🔍 DRY RUN" : "✏️  WRITE"}\n`);

	let successCount = 0;
	let errorCount = 0;

	for (const workspace of config.workspaces) {
		const { projectPath, accountId, envType, mcpServerName, writeOpsEnabled } =
			workspace;

		try {
			if (!path.isAbsolute(projectPath) || !fs.existsSync(projectPath)) {
				console.warn(`⚠️  Skipped (invalid or missing directory): ${projectPath}`);
				errorCount++;
				continue;
			}

			const vars = {
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

			const renderedAgents = interpolateTemplate(template, vars);

			// Check for remaining unreplaced placeholders
			const unreplaced = renderedAgents.match(/\{\{[A-Z_]+\}\}/g);
			if (unreplaced) {
				console.warn(
					`⚠️  Warning: Unreplaced placeholders in ${accountId}: ${unreplaced.join(", ")}`,
				);
			}

			const targetAgentsPath = path.join(projectPath, "AGENTS.md");
			const targetAgentsDir = path.join(projectPath, ".agents");
			const targetRulesDir = path.join(targetAgentsDir, "rules");
			const targetHooksPath = path.join(targetAgentsDir, "hooks.json");
			const targetScriptsDir = path.join(projectPath, "scripts");

			// Cleanup obsolete legacy items
			const obsoleteSkillsJson = path.join(targetAgentsDir, "skills.json");
			const obsoleteSkillsDir = path.join(targetAgentsDir, "skills");

			if (dryRun) {
				console.log(`🔍 [DRY RUN] ${path.basename(projectPath)}:`);
				console.log(
					`   - AGENTS.md (${Buffer.byteLength(renderedAgents, "utf-8")} bytes)`,
				);
				console.log(`   - .agents/hooks.json`);
				console.log(`   - .agents/rules/*.md (5 modular rules)`);
				console.log(
					`   - scripts/ (pre-upload-check.js, suitescript-safe-check.js)`,
				);
			} else {
				// 1. Write AGENTS.md
				fs.writeFileSync(targetAgentsPath, renderedAgents, "utf-8");

				// 2. Clean obsolete legacy items if present
				if (fs.existsSync(obsoleteSkillsJson)) {
					fs.rmSync(obsoleteSkillsJson, { force: true });
				}
				if (fs.existsSync(obsoleteSkillsDir)) {
					fs.rmSync(obsoleteSkillsDir, { recursive: true, force: true });
				}

				// 3. Ensure .agents and .agents/rules directories exist
				fs.mkdirSync(targetRulesDir, { recursive: true });

				// 4. Write hooks.json
				if (fs.existsSync(hooksTemplatePath)) {
					const hooksContent = fs.readFileSync(hooksTemplatePath, "utf-8");
					fs.writeFileSync(targetHooksPath, hooksContent, "utf-8");
				}

				// 5. Sync modular rules
				if (fs.existsSync(rulesSourceDir)) {
					const ruleFiles = fs.readdirSync(rulesSourceDir);
					for (const rf of ruleFiles) {
						const srcRulePath = path.join(rulesSourceDir, rf);
						if (!fs.statSync(srcRulePath).isFile()) continue;

						let targetRuleName = rf;
						if (rf === "environment-locks.template.md") {
							targetRuleName = "environment-locks.md";
						}
						const destRulePath = path.join(targetRulesDir, targetRuleName);
						const rawRuleContent = fs.readFileSync(srcRulePath, "utf-8");
						const renderedRule = interpolateTemplate(rawRuleContent, vars);
						fs.writeFileSync(destRulePath, renderedRule, "utf-8");
					}
				}

				// 6. Ensure target scripts directory has the safety checkers
				fs.mkdirSync(targetScriptsDir, { recursive: true });
				const scriptSourceDir = path.join(projectRoot, "scripts");
				for (const scriptFile of [
					"pre-upload-check.js",
					"suitescript-safe-check.js",
				]) {
					const srcScript = path.join(scriptSourceDir, scriptFile);
					const destScript = path.join(targetScriptsDir, scriptFile);
					if (fs.existsSync(srcScript)) {
						fs.copyFileSync(srcScript, destScript);
					}
				}

				console.log(
					`✅ Synced: ${path.basename(projectPath)} — ${accountId} [${envType}] (.agents + rules + hooks + scripts)`,
				);

				// 7. Git commit and push if requested
				if (shouldPush) {
					try {
						execSync(
							"git add AGENTS.md .agents/ scripts/pre-upload-check.js scripts/suitescript-safe-check.js",
							{ cwd: projectPath, stdio: "pipe" },
						);

						let hasChanges = false;
						try {
							execSync("git diff --cached --quiet", {
								cwd: projectPath,
								stdio: "pipe",
							});
						} catch {
							hasChanges = true;
						}

						if (hasChanges) {
							execSync(
								'git commit -m "docs(agents): 同步8大权威工具、严格SuiteQL标准与自然键自愈规约"',
								{ cwd: projectPath, stdio: "pipe" },
							);
							const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
								cwd: projectPath,
								encoding: "utf-8",
							}).trim();
							if (!/^[a-zA-Z0-9_\-./]+$/.test(currentBranch)) {
								throw new Error(`Invalid git branch name: ${currentBranch}`);
							}
							execSync(`git push origin ${currentBranch}`, {
								cwd: projectPath,
								stdio: "pipe",
							});
							console.log(
								`   🚀 Pushed to remote: ${path.basename(projectPath)} [branch: ${currentBranch}]`,
							);
						} else {
							console.log(
								`   ℹ️  Remote up to date: ${path.basename(projectPath)} (no changes)`,
							);
						}
					} catch (pushErr) {
						console.error(
							`   ⚠️  Git push warning for ${path.basename(projectPath)}: ${pushErr.message}`,
						);
					}
				}
			}

			successCount++;
		} catch (err) {
			console.error(`❌ Error processing ${projectPath}: ${err.message}`);
			errorCount++;
		}
	}

	console.log(`\n${"-".repeat(60)}`);
	console.log(
		`${dryRun ? "🔍 Dry run" : "✨ Sync"} complete: ${successCount} succeeded, ${errorCount} failed`,
	);

	if (
		errorCount > 0 &&
		!process.argv.includes("--watch") &&
		!process.argv.includes("-w")
	) {
		process.exit(1);
	}

	return { successCount, errorCount };
}

// ---------------------------------------------------------------------------
// Watch Mode
// ---------------------------------------------------------------------------

function startWatchMode() {
	const watchDir = path.join(projectRoot, "workspace-agents");
	console.log(`👀 [Watch Agents] 正在监听目录: ${watchDir}`);
	console.log(
		"💡 每次保存文件后，将自动执行同步并推送到各环境远程仓库 (防抖 2 秒)...\n",
	);

	let timeoutId = null;
	let isSyncing = false;

	function triggerSync(filename) {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => {
			if (isSyncing) return;
			isSyncing = true;
			console.log(`\n🔔 检测到变更 [${filename}]，开始执行自动同步与推送...`);
			try {
				runSync({ dryRun: false, shouldPush: true });
				console.log("✅ 自动同步与推送完成！\n");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`❌ 同步失败: ${message}\n`);
			} finally {
				isSyncing = false;
			}
		}, 2000);
	}

	try {
		fs.watch(watchDir, { recursive: true }, (_eventType, filename) => {
			if (!filename) return;
			// Ignore temporary swap files or hidden files
			if (
				filename.startsWith(".") ||
				filename.endsWith("~") ||
				filename.includes(".tmp")
			) {
				return;
			}
			triggerSync(filename);
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`❌ 无法监听目录 ${watchDir}: ${message}`);
		process.exit(1);
	}
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

const isWatch = process.argv.includes("--watch") || process.argv.includes("-w");
const dryRun = process.argv.includes("--dry-run");
const shouldPush = process.argv.includes("--push");

if (isWatch) {
	startWatchMode();
} else {
	try {
		runSync({ dryRun, shouldPush });
	} catch (error) {
		console.error(`\n❌ Fatal error: ${error.message}`);
		process.exit(1);
	}
}
