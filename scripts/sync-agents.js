/**
 * sync-agents.js — Synchronize AGENTS.md and Antigravity .agents/ structure to all NetSuite workspace projects.
 *
 * Usage:
 *   npm run sync-agents              # Execute sync to all workspaces
 *   npm run sync-agents -- --dry-run # Preview changes without writing
 *
 * Reads workspace-agents/ templates and workspace-agents/workspaces.json,
 * substitutes environment-specific variables, and provisions:
 * 1. Project-level AGENTS.md (core charter & SOP)
 * 2. .agents/hooks.json (lifecycle safety gates)
 * 3. .agents/rules/*.md (modular directives: Fast-Path, SuiteQL, SAFE, Generative UI, Environment Locks)
 * 4. scripts/ (pre-upload-check.js & suitescript-safe-check.js)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const dryRun = process.argv.includes("--dry-run");

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
| \`ns_createRecord\` | Create a new record (**Sandbox only**) |
| \`ns_updateRecord\` | Update an existing record (**Sandbox only**) |
| \`netsuite_suitecloud_upload\` | Deploy code via SuiteCloud CLI (simplified card confirmation) |`;

const WRITE_TOOLS_TABLE_PRODUCTION = `> 🔒 **Production Safety Guard**: Mutation tools (\`ns_createRecord\`, \`ns_updateRecord\`) are strictly blocked in Production. Code deployment requires interactive card confirmation.`;

const WRITE_OPS_SECTION_SANDBOX = `### Simplified File Upload & Code Deployment (✅ Sandbox Enabled)
1. **Record Mutations**: Inspect schema via \`ns_getRecordTypeMetadata\` ➔ Build valid JSON ➔ Execute \`ns_createRecord\` or \`ns_updateRecord\`.
2. **File Upload Card Protocol**: When deploying code, display an interactive confirmation card (\`ask_question\`) showing only the file's absolute path, with choices "接受" and "拒绝". Call \`netsuite_suitecloud_upload\` directly upon acceptance.`;

const WRITE_OPS_SECTION_PRODUCTION = `### Simplified File Upload & Code Deployment (🔒 Production Read-Only)
> [!WARNING]
> Record mutations are strictly prohibited in Production.
- **File Upload Card Protocol**: When uploading code to Production, display an interactive confirmation card (\`ask_question\`) showing only the file's absolute path, with choices "接受" and "拒绝". Call \`netsuite_suitecloud_upload\` with \`allowProduction: true\` directly upon acceptance.`;

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
// Main
// ---------------------------------------------------------------------------

try {
	if (!fs.existsSync(templatePath)) {
		throw new Error(`Template not found: ${templatePath}`);
	}
	if (!fs.existsSync(configPath)) {
		throw new Error(`Config not found: ${configPath}`);
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
			if (!fs.existsSync(projectPath)) {
				console.warn(`⚠️  Skipped (directory not found): ${projectPath}`);
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

	if (errorCount > 0) {
		process.exit(1);
	}
} catch (error) {
	console.error(`\n❌ Fatal error: ${error.message}`);
	process.exit(1);
}
