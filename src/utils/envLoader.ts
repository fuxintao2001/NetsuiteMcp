import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

/**
 * Parse .env file contents into key-value pairs.
 */
export function parseEnv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = content.split(/\r?\n/);

	for (const rawLine of lines) {
		const line = rawLine.trim();
		// Skip empty lines and comments
		if (!line || line.startsWith("#")) continue;

		const equalIndex = line.indexOf("=");
		if (equalIndex === -1) continue;

		const key = line.substring(0, equalIndex).trim();
		let val = line.substring(equalIndex + 1).trim();

		// Handle surrounding quotes
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.substring(1, val.length - 1);
		}

		if (key) {
			result[key] = val;
		}
	}

	return result;
}

/**
 * Load environment variables from .env and .env.local files into process.env.
 * Existing process.env variables take precedence and will not be overwritten.
 */
export function loadEnv(customDir?: string): void {
	const searchDirs = [customDir, process.cwd(), projectRoot].filter(
		Boolean,
	) as string[];

	const envFiles = [".env.local", ".env"];

	const loadedFiles = new Set<string>();

	for (const dir of searchDirs) {
		for (const filename of envFiles) {
			const fullPath = path.resolve(dir, filename);
			if (loadedFiles.has(fullPath)) continue;

			try {
				if (fs.existsSync(fullPath)) {
					const content = fs.readFileSync(fullPath, "utf-8");
					const parsed = parseEnv(content);
					for (const [key, value] of Object.entries(parsed)) {
						if (process.env[key] === undefined) {
							process.env[key] = value;
						}
					}
					loadedFiles.add(fullPath);
				}
			} catch {
				// Ignore unreadable files
			}
		}
	}
}

// Auto-load on module evaluation
loadEnv();
