import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv as nodeParseEnv } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

/**
 * Parse .env file contents into key-value pairs using Node.js native util.parseEnv.
 */
export function parseEnv(content: string): Record<string, string> {
	const parsed = nodeParseEnv(content);
	const result: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed)) {
		if (v !== undefined) {
			result[k] = v;
		}
	}
	return result;
}

/**
 * Load environment variables from .env and .env.local files into process.env.
 * Existing process.env variables take precedence and will not be overwritten.
 */
function loadEnv(customDir?: string): void {
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
