import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const AGENT_LABEL = 'com.suiteinsider.netsuite-mcp-keepalive';
const PLIST_NAME = `${AGENT_LABEL}.plist`;

function getPaths() {
  const homedir = os.homedir();
  const plistPath = path.join(homedir, 'Library', 'LaunchAgents', PLIST_NAME);
  const logPath = path.join(homedir, 'Library', 'Logs', 'netsuite-mcp-daemon.log');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // The file is built to dist/daemon/installer.js, so project root is 2 directories up
  const projectRoot = path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(projectRoot, 'dist', 'daemon', 'keepalive.js');

  return {
    plistPath,
    logPath,
    scriptPath,
    nodePath: process.execPath,
  };
}

function generatePlist(nodePath: string, scriptPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * Install and load macOS LaunchAgent
 */
export async function install(): Promise<void> {
  const paths = getPaths();
  console.error(`⚙️  Installing macOS LaunchAgent daemon...`);
  console.error(`   Node path: ${paths.nodePath}`);
  console.error(`   Script path: ${paths.scriptPath}`);
  console.error(`   Log path: ${paths.logPath}`);
  console.error(`   Plist path: ${paths.plistPath}`);

  try {
    // 1. Ensure scripts are built
    try {
      await fs.access(paths.scriptPath);
    } catch {
      throw new Error(`keepalive.js not found at ${paths.scriptPath}. Please run 'npm run build' first.`);
    }

    // 2. Ensure Library/LaunchAgents directory exists
    const launchAgentsDir = path.dirname(paths.plistPath);
    await fs.mkdir(launchAgentsDir, { recursive: true });

    // 3. Generate and write Plist
    const plistContent = generatePlist(paths.nodePath, paths.scriptPath, paths.logPath);
    await fs.writeFile(paths.plistPath, plistContent, 'utf-8');
    await fs.chmod(paths.plistPath, 0o644);

    // 4. Load launch agent
    try {
      execSync(`launchctl unload "${paths.plistPath}" 2>/dev/null`);
    } catch {
      // Ignored
    }
    execSync(`launchctl load -w "${paths.plistPath}"`);
    
    console.error(`\n✅ LaunchAgent daemon installed and loaded successfully!`);
    console.error(`   The daemon will run every 10 minutes.`);
    console.error(`   You can view logs at: tail -f "${paths.logPath}"`);
  } catch (err: any) {
    console.error(`❌ Failed to install LaunchAgent: ${err.message}`);
    throw err;
  }
}

/**
 * Unload and uninstall macOS LaunchAgent
 */
export async function uninstall(): Promise<void> {
  const paths = getPaths();
  console.error(`⚙️  Uninstalling macOS LaunchAgent daemon...`);

  try {
    try {
      execSync(`launchctl unload "${paths.plistPath}" 2>/dev/null`);
      console.error(`   Unloaded LaunchAgent.`);
    } catch {
      // Ignored
    }

    try {
      await fs.unlink(paths.plistPath);
      console.error(`   Removed Plist file.`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }

    console.error(`✅ LaunchAgent daemon uninstalled successfully!`);
  } catch (err: any) {
    console.error(`❌ Failed to uninstall LaunchAgent: ${err.message}`);
    throw err;
  }
}

/**
 * Get status of macOS LaunchAgent
 */
export async function status(): Promise<void> {
  const paths = getPaths();
  console.error(`📋 LaunchAgent Daemon Status:`);
  console.error(`   Plist path: ${paths.plistPath}`);
  console.error(`   Log path: ${paths.logPath}`);

  let isFileInstalled = false;
  try {
    await fs.access(paths.plistPath);
    isFileInstalled = true;
  } catch {
    // Doesn't exist
  }

  console.error(`   File Installed: ${isFileInstalled ? '✅ Yes' : '❌ No'}`);

  let isLoaded = false;
  if (isFileInstalled) {
    try {
      const listOutput = execSync(`launchctl list | grep ${AGENT_LABEL}`, { encoding: 'utf-8' });
      console.error(`   Launchctl status: ✅ Loaded`);
      console.error(`   Launchctl list detail:\n${listOutput.trim().replace(/^/gm, '     ')}`);
      isLoaded = true;
    } catch {
      console.error(`   Launchctl status: ❌ Not loaded (or idle/stopped)`);
    }
  }

  try {
    const stats = await fs.stat(paths.logPath);
    console.error(`   Last log execution time: ${stats.mtime.toISOString()}`);
    console.error(`   Last 5 log lines:`);
    try {
      const logs = execSync(`tail -n 5 "${paths.logPath}"`, { encoding: 'utf-8' });
      console.error(logs.trim().replace(/^/gm, '     '));
    } catch {
      console.error(`     (Could not read logs)`);
    }
  } catch {
    console.error(`   Last log execution time: ❌ No log file found yet.`);
  }
}
