/**
 * sync-agents.js — Synchronize AGENTS.md template to all NetSuite workspace projects.
 *
 * Usage:
 *   npm run sync-agents              # Execute sync to all workspaces
 *   npm run sync-agents -- --dry-run # Preview changes without writing
 *
 * Reads workspace-agents/AGENTS.template.md and workspace-agents/workspaces.json,
 * substitutes environment-specific variables, and writes to each project's AGENTS.md.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const dryRun = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const templatePath = path.join(projectRoot, 'workspace-agents', 'AGENTS.template.md');
const configPath = path.join(projectRoot, 'workspace-agents', 'workspaces.json');

// ---------------------------------------------------------------------------
// Conditional Content Blocks
// ---------------------------------------------------------------------------

const WRITE_TOOLS_TABLE_SANDBOX = `| Tool | Permissions & Behavior |
|:---|:---|
| \`ns_createRecord\` | Create a new record (**Sandbox only**) |
| \`ns_updateRecord\` | Update an existing record (**Sandbox only**) |
| \`netsuite_suitecloud_upload\` | Deploy code via SuiteCloud CLI (one-step direct upload) |`;

const WRITE_TOOLS_TABLE_PRODUCTION = `> 🔒 **Production Safety Guard**: Mutation tools (\`ns_createRecord\`, \`ns_updateRecord\`) are strictly blocked by code-level runtime guards. Code upload (\`netsuite_suitecloud_upload\`) requires explicit user authorization with \`allowProduction: true\`.`;

const WRITE_OPS_SECTION_SANDBOX = `### Write Operations & Code Deployment (✅ Sandbox Enabled)
1. **Record Mutations**: Inspect schema via \`ns_getRecordTypeMetadata\` ➔ Build valid JSON ➔ Execute \`ns_createRecord\` or \`ns_updateRecord\`.
2. **File Uploads**: In Sandbox, call \`netsuite_suitecloud_upload\` directly with absolute or FileCabinet path. Deploys without extra confirmation steps.`;

const WRITE_OPS_SECTION_PRODUCTION = `### Write Operations & Code Deployment (🔒 Production Read-Only)
> [!WARNING]
> Record mutations are strictly prohibited in Production. Code deployment requires explicit user authorization and \`allowProduction: true\`.`;


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
  // Read template
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templatePath}`);
  }
  const template = fs.readFileSync(templatePath, 'utf-8');

  // Read workspace config
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  if (!config.workspaces || !Array.isArray(config.workspaces)) {
    throw new Error('Invalid config: "workspaces" array is required');
  }

  console.log(`📋 Template: ${templatePath}`);
  console.log(`📋 Config: ${config.workspaces.length} workspaces`);
  console.log(`📋 Mode: ${dryRun ? '🔍 DRY RUN' : '✏️  WRITE'}\n`);

  let successCount = 0;
  let errorCount = 0;

  for (const workspace of config.workspaces) {
    const { projectPath, accountId, envType, mcpServerName, writeOpsEnabled } = workspace;

    try {
      // Validate project path exists
      if (!fs.existsSync(projectPath)) {
        console.warn(`⚠️  Skipped (directory not found): ${projectPath}`);
        errorCount++;
        continue;
      }

      let output = template;

      // Replace simple variables
      output = output.replaceAll('{{ACCOUNT_ID}}', accountId);
      output = output.replaceAll('{{ENV_TYPE}}', envType);
      output = output.replaceAll('{{MCP_SERVER_NAME}}', mcpServerName);
      output = output.replaceAll('{{WRITE_OPS_BADGE}}', writeOpsEnabled ? '✅ Enabled' : '❌ Disabled');

      // Replace conditional blocks
      if (writeOpsEnabled) {
        output = output.replaceAll('{{WRITE_TOOLS_TABLE}}', WRITE_TOOLS_TABLE_SANDBOX);
        output = output.replaceAll('{{WRITE_OPS_SECTION}}', WRITE_OPS_SECTION_SANDBOX);
      } else {
        output = output.replaceAll('{{WRITE_TOOLS_TABLE}}', WRITE_TOOLS_TABLE_PRODUCTION);
        output = output.replaceAll('{{WRITE_OPS_SECTION}}', WRITE_OPS_SECTION_PRODUCTION);
      }

      // Verify no unreplaced placeholders remain
      const unreplaced = output.match(/\{\{[A-Z_]+\}\}/g);
      if (unreplaced) {
        console.warn(`⚠️  Warning: Unreplaced placeholders in ${accountId}: ${unreplaced.join(', ')}`);
      }

      const targetPath = path.join(projectPath, 'AGENTS.md');
      const sizeBytes = Buffer.byteLength(output, 'utf-8');

      const agentsDir = path.join(projectPath, '.agents');
      const skillsDir = path.join(agentsDir, 'skills');
      const skillsJsonPath = path.join(agentsDir, 'skills.json');
      const hasObsoleteSkillsJson = fs.existsSync(skillsJsonPath);
      const hasObsoleteSkillsDir = fs.existsSync(skillsDir);

      if (dryRun) {
        console.log(`🔍 [DRY RUN] ${path.basename(projectPath)}/AGENTS.md`);
        console.log(`   Account: ${accountId} | Env: ${envType} | Write: ${writeOpsEnabled ? '✅' : '❌'} | Size: ${sizeBytes} bytes`);
        if (hasObsoleteSkillsJson || hasObsoleteSkillsDir) {
          console.log(`   🔍 [DRY RUN] Will remove obsolete .agents folder contents`);
        }
      } else {
        fs.writeFileSync(targetPath, output, 'utf-8');
        if (hasObsoleteSkillsJson) {
          fs.rmSync(skillsJsonPath, { force: true });
          console.log(`🧹 Cleaned: Removed obsolete ${path.basename(projectPath)}/.agents/skills.json`);
        }
        if (hasObsoleteSkillsDir) {
          fs.rmSync(skillsDir, { recursive: true, force: true });
          console.log(`🧹 Cleaned: Removed obsolete ${path.basename(projectPath)}/.agents/skills/`);
        }
        if (fs.existsSync(agentsDir)) {
          const files = fs.readdirSync(agentsDir);
          if (files.length === 0) {
            fs.rmdirSync(agentsDir);
            console.log(`🧹 Cleaned: Removed empty ${path.basename(projectPath)}/.agents/ directory`);
          }
        }
        console.log(`✅ Synced: ${path.basename(projectPath)}/AGENTS.md — ${accountId} [${envType}]`);
      }

      successCount++;
    } catch (err) {
      console.error(`❌ Error processing ${projectPath}: ${err.message}`);
      errorCount++;
    }
  }

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${dryRun ? '🔍 Dry run' : '✨ Sync'} complete: ${successCount} succeeded, ${errorCount} failed`);

  if (errorCount > 0) {
    process.exit(1);
  }
} catch (error) {
  console.error(`\n❌ Fatal error: ${error.message}`);
  process.exit(1);
}
