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

const WRITE_TOOLS_TABLE_SANDBOX = `| \`ns_createRecord\` | Create a new record (**Sandbox only**) | \`recordType\`, \`data\` (stringified JSON) |
| \`ns_updateRecord\` | Update an existing record (**Sandbox only**) | \`recordType\`, \`recordId\`, \`data\` (stringified JSON) |`;

const WRITE_TOOLS_TABLE_PRODUCTION = `\n> *Write tools (\`ns_createRecord\`, \`ns_updateRecord\`) are disabled in Production.*\n`;

const WRITE_OPS_SECTION_SANDBOX = `### Write Operations (✅ Enabled)

Write operations (\`ns_createRecord\` / \`ns_updateRecord\`) are fully enabled in this Sandbox environment.

**Write Workflow:**
1. \`ns_getRecordTypeMetadata\` → verify record schema and field constraints
2. For reference fields → use \`ns_selector_app\` or SuiteQL to look up valid IDs
3. Build \`data\` as **stringified JSON** matching the schema exactly
4. Call \`ns_createRecord\` or \`ns_updateRecord\`
5. Verify result → \`netsuite_get_record_link\` for UI confirmation`;

const WRITE_OPS_SECTION_PRODUCTION = `### Write Operations (❌ Disabled)

> [!CAUTION]
> \`ns_createRecord\` and \`ns_updateRecord\` are **disabled** in this Production environment to protect data integrity. Use \`ns_getRecord\` for read-only access. To perform write operations, switch to a Sandbox workspace.`;

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

      // Prepare .agents/skills.json payload linking to master project skills
      const skillsJsonContent = JSON.stringify({
        entries: [
          { path: path.join(projectRoot, 'skills') },
          { path: path.join(projectRoot, '.agents', 'skills') }
        ]
      }, null, 2) + '\n';
      const agentsDir = path.join(projectPath, '.agents');
      const skillsJsonPath = path.join(agentsDir, 'skills.json');

      if (dryRun) {
        console.log(`🔍 [DRY RUN] ${path.basename(projectPath)}/AGENTS.md`);
        console.log(`   Account: ${accountId} | Env: ${envType} | Write: ${writeOpsEnabled ? '✅' : '❌'} | Size: ${sizeBytes} bytes`);
        console.log(`🔍 [DRY RUN] ${path.basename(projectPath)}/.agents/skills.json`);
      } else {
        fs.writeFileSync(targetPath, output, 'utf-8');
        if (!fs.existsSync(agentsDir)) {
          fs.mkdirSync(agentsDir, { recursive: true });
        }
        fs.writeFileSync(skillsJsonPath, skillsJsonContent, 'utf-8');
        console.log(`✅ Synced: ${path.basename(projectPath)}/AGENTS.md & .agents/skills.json — ${accountId} [${envType}]`);
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
