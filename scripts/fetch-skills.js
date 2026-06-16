import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.dirname(__dirname);

const tempDir = path.join(projectRoot, 'temp-sdk');
const targetDir = path.join(projectRoot, 'skills');

try {
  console.log('🧹 Cleaning up old skills and temp directories...');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  console.log('📥 Cloning oracle/netsuite-suitecloud-sdk (depth 1)...');
  execSync(
    'git clone --depth 1 https://github.com/oracle/netsuite-suitecloud-sdk.git temp-sdk',
    { cwd: projectRoot, stdio: 'inherit' }
  );

  const sourceSkillsDir = path.join(tempDir, 'packages', 'agent-skills');
  if (!fs.existsSync(sourceSkillsDir)) {
    throw new Error(`Could not find agent-skills directory at: ${sourceSkillsDir}`);
  }

  console.log('🚚 Copying skills to target directory...');
  fs.mkdirSync(targetDir, { recursive: true });

  // Read all contents in sourceSkillsDir and copy
  const items = fs.readdirSync(sourceSkillsDir);
  for (const item of items) {
    // Skip hidden files if any
    if (item.startsWith('.')) continue;
    const srcPath = path.join(sourceSkillsDir, item);
    const destPath = path.join(targetDir, item);
    fs.cpSync(srcPath, destPath, { recursive: true });
  }

  console.log('🧹 Cleaning up temporary clone directory...');
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log('✨ NetSuite Agent Skills fetched and installed successfully in /skills!');
} catch (error) {
  console.error('❌ Error fetching skills:', error);
  // Cleanup temp on failure
  if (fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
  process.exit(1);
}
