import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEEPALIVE_LABEL = "com.suiteinsider.netsuite-mcp-keepalive";
const SERVER_LABEL = "com.suiteinsider.netsuite-mcp-server";

function getPaths() {
	const homedir = os.homedir();
	const keepalivePlistPath = path.join(
		homedir,
		"Library",
		"LaunchAgents",
		`${KEEPALIVE_LABEL}.plist`,
	);
	const serverPlistPath = path.join(
		homedir,
		"Library",
		"LaunchAgents",
		`${SERVER_LABEL}.plist`,
	);
	const keepaliveLogPath = path.join(
		homedir,
		"Library",
		"Logs",
		"netsuite-mcp-daemon.log",
	);
	const serverLogPath = path.join(
		homedir,
		"Library",
		"Logs",
		"netsuite-mcp-server.log",
	);

	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);
	const projectRoot = path.resolve(__dirname, "..", "..");
	const keepaliveScriptPath = path.join(
		projectRoot,
		"dist",
		"daemon",
		"keepalive.js",
	);
	const serverScriptPath = path.join(projectRoot, "dist", "server.js");

	return {
		keepalivePlistPath,
		serverPlistPath,
		keepaliveLogPath,
		serverLogPath,
		keepaliveScriptPath,
		serverScriptPath,
		nodePath: process.execPath,
		projectRoot,
	};
}

function generateKeepalivePlist(
	nodePath: string,
	scriptPath: string,
	logPath: string,
): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${KEEPALIVE_LABEL}</string>
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
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
`;
}

function generateServerPlist(
	nodePath: string,
	scriptPath: string,
	logPath: string,
	projectRoot: string,
): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * Install and load macOS LaunchAgent daemons
 */
export async function install(): Promise<void> {
	const paths = getPaths();
	console.error(`⚙️  Installing macOS LaunchAgent daemons...`);

	try {
		// 1. Ensure scripts are built
		try {
			await fs.access(paths.keepaliveScriptPath);
			await fs.access(paths.serverScriptPath);
		} catch {
			throw new Error(
				`Built scripts not found. Please run 'npm run build' first.`,
			);
		}

		// 2. Ensure Library/LaunchAgents directory exists
		const launchAgentsDir = path.dirname(paths.keepalivePlistPath);
		await fs.mkdir(launchAgentsDir, { recursive: true });

		// 3. Generate and write Keepalive Plist
		const keepalivePlist = generateKeepalivePlist(
			paths.nodePath,
			paths.keepaliveScriptPath,
			paths.keepaliveLogPath,
		);
		await fs.writeFile(paths.keepalivePlistPath, keepalivePlist, "utf-8");
		await fs.chmod(paths.keepalivePlistPath, 0o644);

		// 4. Generate and write HTTP Server Plist
		const serverPlist = generateServerPlist(
			paths.nodePath,
			paths.serverScriptPath,
			paths.serverLogPath,
			paths.projectRoot,
		);
		await fs.writeFile(paths.serverPlistPath, serverPlist, "utf-8");
		await fs.chmod(paths.serverPlistPath, 0o644);

		// 5. Load keepalive launch agent
		try {
			execSync(`launchctl unload "${paths.keepalivePlistPath}" 2>/dev/null`);
		} catch {
			// Ignored
		}
		execSync(`launchctl load -w "${paths.keepalivePlistPath}"`);

		// 6. Load HTTP server launch agent
		try {
			execSync(`launchctl unload "${paths.serverPlistPath}" 2>/dev/null`);
		} catch {
			// Ignored
		}
		execSync(`launchctl load -w "${paths.serverPlistPath}"`);

		console.error(
			`\n✅ macOS LaunchAgent daemons installed and loaded successfully!`,
		);
		console.error(`   1. HTTP Server Daemon: ${SERVER_LABEL} (Port 3000, KeepAlive)`);
		console.error(`   2. Token Refresh Daemon: ${KEEPALIVE_LABEL} (Every 10 mins)`);
		console.error(`   Server logs: tail -f "${paths.serverLogPath}"`);
		console.error(`   Daemon logs: tail -f "${paths.keepaliveLogPath}"`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`❌ Failed to install LaunchAgents: ${message}`);
		throw err;
	}
}

/**
 * Unload and uninstall macOS LaunchAgent daemons
 */
export async function uninstall(): Promise<void> {
	const paths = getPaths();
	console.error(`⚙️  Uninstalling macOS LaunchAgent daemons...`);

	for (const p of [paths.keepalivePlistPath, paths.serverPlistPath]) {
		try {
			execSync(`launchctl unload "${p}" 2>/dev/null`);
		} catch {
			// Ignored
		}

		try {
			await fs.unlink(p);
		} catch (err: unknown) {
			const nodeErr = err as { code?: string };
			if (nodeErr.code !== "ENOENT") {
				throw err;
			}
		}
	}

	console.error(`✅ LaunchAgent daemons uninstalled successfully!`);
}

/**
 * Get status of macOS LaunchAgent daemons
 */
export async function status(): Promise<void> {
	const paths = getPaths();
	console.error(`📋 LaunchAgent Daemons Status:`);

	for (const daemon of [
		{ label: SERVER_LABEL, plist: paths.serverPlistPath, log: paths.serverLogPath, name: "HTTP Server Daemon (Port 3000)" },
		{ label: KEEPALIVE_LABEL, plist: paths.keepalivePlistPath, log: paths.keepaliveLogPath, name: "Token Refresh Keepalive Daemon" },
	]) {
		console.error(`\n🔹 ${daemon.name}:`);
		console.error(`   Plist path: ${daemon.plist}`);
		console.error(`   Log path: ${daemon.log}`);

		let isFileInstalled = false;
		try {
			await fs.access(daemon.plist);
			isFileInstalled = true;
		} catch {
			// Doesn't exist
		}

		console.error(`   File Installed: ${isFileInstalled ? "✅ Yes" : "❌ No"}`);

		if (isFileInstalled) {
			try {
				const listOutput = execSync(`launchctl list | grep ${daemon.label}`, {
					encoding: "utf-8",
				});
				console.error(`   Launchctl status: ✅ Loaded`);
				console.error(
					`   Launchctl list detail:\n${listOutput.trim().replace(/^/gm, "     ")}`,
				);
			} catch {
				console.error(`   Launchctl status: ❌ Not loaded`);
			}
		}

		try {
			const stats = await fs.stat(daemon.log);
			console.error(`   Last log update: ${stats.mtime.toISOString()}`);
			try {
				const logs = execSync(`tail -n 3 "${daemon.log}"`, {
					encoding: "utf-8",
				});
				console.error(`   Last 3 log lines:\n${logs.trim().replace(/^/gm, "     ")}`);
			} catch {
				// Ignored
			}
		} catch {
			console.error(`   Log file: ❌ No log file found yet.`);
		}
	}
}
