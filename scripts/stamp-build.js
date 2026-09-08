#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "..", "dist");
const stampFile = path.join(distDir, ".build_stamp");

try {
	if (fs.existsSync(distDir)) {
		fs.writeFileSync(
			stampFile,
			JSON.stringify({
				timestamp: Date.now(),
				buildTime: new Date().toISOString(),
			}),
			"utf-8",
		);
		console.log("⚡ [Build] Generated .build_stamp for MCP hot reload");
	}
} catch (err) {
	// Non-fatal
}
