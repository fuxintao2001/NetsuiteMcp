import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEEPALIVE_LABEL = "com.suiteinsider.netsuite-mcp-keepalive";
const LEGACY_SERVER_LABEL = "com.suiteinsider.netsuite-mcp-server";

function getPaths() {
	const homedir = os.homedir();
	const keepalivePlistPath = path.join(
		homedir,
		"Library",
		"LaunchAgents",
		`${KEEPALIVE_LABEL}.plist`,
	);
	const legacyServerPlistPath = path.join(
		homedir,
		"Library",
		"LaunchAgents",
		`${LEGACY_SERVER_LABEL}.plist`,
	);
	const keepaliveLogPath = path.join(
		homedir,
		"Library",
		"Logs",
		"netsuite-mcp-daemon.log",
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

	return {
		keepalivePlistPath,
		legacyServerPlistPath,
		keepaliveLogPath,
		keepaliveScriptPath,
		nodePath: process.execPath,
		projectRoot,
	};
}

function buildEnvironmentVariablesXml(
	extraVars: Record<string, string> = {},
): string {
	const systemPaths = [
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	];
	const currentPaths = process.env.PATH ? process.env.PATH.split(":") : [];
	const mergedPathSet = new Set<string>();

	for (const p of [...currentPaths, ...systemPaths]) {
		if (p && p.trim().length > 0) {
			mergedPathSet.add(p.trim());
		}
	}
	const finalPath = Array.from(mergedPathSet).join(":");

	let xml = "    <key>PATH</key>\n";
	xml += `    <string>${finalPath}</string>\n`;

	if (process.env.JAVA_HOME) {
		xml += "    <key>JAVA_HOME</key>\n";
		xml += `    <string>${process.env.JAVA_HOME}</string>\n`;
	}

	for (const [k, v] of Object.entries(extraVars)) {
		xml += `    <key>${k}</key>\n`;
		xml += `    <string>${v}</string>\n`;
	}

	return xml;
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
${buildEnvironmentVariablesXml()}  </dict>
</dict>
</plist>
`;
}

/**
 * Install and load macOS LaunchAgent daemon for token keepalive
 */
export async function install(): Promise<void> {
	const paths = getPaths();
	console.error(`⚙️  Installing macOS LaunchAgent keepalive daemon...`);

	try {
		// 1. Ensure keepalive script is built
		try {
			await fs.access(paths.keepaliveScriptPath);
		} catch {
			throw new Error(
				`Built script not found (${paths.keepaliveScriptPath}). Please run 'npm run build' first.`,
			);
		}

		// 2. Ensure Library/LaunchAgents directory exists
		const launchAgentsDir = path.dirname(paths.keepalivePlistPath);
		await fs.mkdir(launchAgentsDir, { recursive: true });

		// 3. Clean up any legacy HTTP server daemon if it was installed
		try {
			execSync(`launchctl unload "${paths.legacyServerPlistPath}" 2>/dev/null`);
			await fs.unlink(paths.legacyServerPlistPath);
		} catch {
			// Ignored
		}

		// 4. Generate and write Keepalive Plist
		const keepalivePlist = generateKeepalivePlist(
			paths.nodePath,
			paths.keepaliveScriptPath,
			paths.keepaliveLogPath,
		);
		await fs.writeFile(paths.keepalivePlistPath, keepalivePlist, "utf-8");
		await fs.chmod(paths.keepalivePlistPath, 0o644);

		// 5. Load keepalive launch agent
		try {
			execSync(`launchctl unload "${paths.keepalivePlistPath}" 2>/dev/null`);
		} catch {
			// Ignored
		}
		execSync(`launchctl load -w "${paths.keepalivePlistPath}"`);

		console.error(
			`\n✅ macOS LaunchAgent token keepalive daemon installed and loaded successfully!`,
		);
		console.error(
			`   Token Refresh Daemon: ${KEEPALIVE_LABEL} (Runs every 10 mins)`,
		);
		console.error(`   Daemon logs: tail -f "${paths.keepaliveLogPath}"`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`❌ Failed to install LaunchAgent: ${message}`);
		throw err;
	}
}

/**
 * Unload and uninstall macOS LaunchAgent daemon
 */
export async function uninstall(): Promise<void> {
	const paths = getPaths();
	console.error(`⚙️  Uninstalling macOS LaunchAgent keepalive daemon...`);

	for (const p of [paths.keepalivePlistPath, paths.legacyServerPlistPath]) {
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

	console.error(`✅ LaunchAgent daemon uninstalled successfully!`);
}

/**
 * Get status of macOS LaunchAgent daemon
 */
export async function status(): Promise<void> {
	const paths = getPaths();
	console.error(`📋 LaunchAgent Daemon Status:`);

	const daemon = {
		label: KEEPALIVE_LABEL,
		plist: paths.keepalivePlistPath,
		log: paths.keepaliveLogPath,
		name: "Token Refresh Keepalive Daemon",
	};

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
			console.error(
				`   Last 3 log lines:\n${logs.trim().replace(/^/gm, "     ")}`,
			);
		} catch {
			// Ignored
		}
	} catch {
		console.error(`   Log file: ❌ No log file found yet.`);
	}
}
