import fs from "node:fs/promises";
import { basename, join } from "node:path";
import type { Server } from "@modelcontextprotocol/server";
import { getSkillsDir } from "../utils/environment.js";
import { recordsReferenceService } from "../utils/recordsReference.js";
import { SUITEQL_TEMPLATES } from "../utils/suiteqlTemplates.js";

// ---------------------------------------------------------------------------
// Helper: Parse YAML frontmatter simply
// ---------------------------------------------------------------------------
function parseFrontmatter(content: string): {
	name?: string;
	description?: string;
} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) return {};
	const frontmatterText = match[1];
	const lines = frontmatterText.split("\n");
	const result: { name?: string; description?: string } = {};

	let currentKey: "name" | "description" | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const nameMatch = line.match(/^name:\s*(.*)/);
		const descMatch = line.match(/^description:\s*(.*)/);

		if (nameMatch) {
			const val = nameMatch[1];
			if (val !== undefined) {
				result.name = val.trim();
				currentKey = "name";
			}
		} else if (descMatch) {
			const val = descMatch[1];
			if (val !== undefined) {
				result.description = val.trim();
				currentKey = "description";
			}
		} else if (line.match(/^[a-zA-Z0-9_-]+:/)) {
			currentKey = null;
		} else if (currentKey && line.startsWith(" ")) {
			if (currentKey === "description" && result.description) {
				result.description += ` ${trimmed}`;
			}
		}
	}

	if (result.name) result.name = result.name.replace(/^['"]|['"]$/g, "");
	if (result.description)
		result.description = result.description.replace(/^['"]|['"]$/g, "");

	return result;
}

// ---------------------------------------------------------------------------
// MCP Resource Handlers
// ---------------------------------------------------------------------------

/**
 * Register MCP Resource handlers on the server.
 *
 * Exposes reference documents and downloaded SuiteCloud Agent Skills as MCP
 * Resources so that AI agents can discover and read them via the standard MCP protocol.
 */
export function registerResourceHandlers(
	server: Server,
	projectRoot: string,
): void {
	// --- List Resources ---
	server.setRequestHandler("resources/list", async () => {
		const resources = [
			{
				uri: "netsuite://guides/suiteql",
				name: "SuiteQL Query & Syntax Reference Guide",
				description:
					"Complete SuiteQL syntax reference including Oracle SQL subset rules, " +
					"BUILTIN functions, date handling, common pitfalls, and NetSuite-specific " +
					"query patterns like ScriptNote log queries.",
				mimeType: "text/markdown",
			},
			{
				uri: "netsuite://queries/golden-templates",
				name: "Curated SuiteQL Query Template Library",
				description:
					"Production-ready SuiteQL templates from Oracle SAFE Guide and Tim Dietrich. " +
					"Includes transaction lines, lineage, multi-location stock, script error logs, and system notes.",
				mimeType: "text/markdown",
			},
			{
				uri: "netsuite://records/reference",
				name: "Oracle NetSuite Official 272 Records Definition Index",
				description:
					"Index of all 272 standard NetSuite record types available in SuiteScript records reference.",
				mimeType: "text/markdown",
			},
		];

		const skillsDir = getSkillsDir(projectRoot);
		try {
			const entries = await fs.readdir(skillsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
					try {
						const content = await fs.readFile(skillMdPath, "utf-8");
						const meta = parseFrontmatter(content);
						resources.push({
							uri: `netsuite://skills/${entry.name}`,
							name: meta.name || entry.name,
							description:
								meta.description || `SuiteCloud Agent Skill: ${entry.name}`,
							mimeType: "text/markdown",
						});
					} catch {
						// SKILL.md doesn't exist or is not readable - skip
					}
				}
			}
		} catch {
			// skills/ directory might not exist yet - ignore
		}

		return { resources };
	});

	// --- Read Resource ---
	server.setRequestHandler("resources/read", async (request) => {
		const { uri } = request.params;

		if (uri === "netsuite://guides/suiteql") {
			const skillsDir = getSkillsDir(projectRoot);
			const filePath = join(
				skillsDir,
				"netsuite-ai-connector-instructions",
				"SKILL.md",
			);
			try {
				const content = await fs.readFile(filePath, "utf-8");
				return {
					contents: [
						{
							uri,
							mimeType: "text/markdown",
							text: content,
						},
					],
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					contents: [
						{
							uri,
							mimeType: "text/plain",
							text: `⚠️ Guide file not found: ${msg}`,
						},
					],
				};
			}
		}

		if (uri === "netsuite://queries/golden-templates") {
			let md = `# Curated SuiteQL Query Template Library\n\n`;
			md += `Sourced from Oracle SAFE Guide (2025.2) and Tim Dietrich SuiteQL Library.\n\n`;
			for (const t of SUITEQL_TEMPLATES) {
				md += `## ${t.name} (\`${t.id}\`)\n`;
				md += `**Category**: \`${t.category}\` | **Source**: ${t.officialSource}\n\n`;
				md += `> ${t.description}\n\n`;
				md += `\`\`\`sql\n${t.sqlTemplate}\n\`\`\`\n\n`;
				md += `### Best Practices:\n`;
				for (const bp of t.bestPractices) {
					md += `- ${bp}\n`;
				}
				md += `\n---\n\n`;
			}

			return {
				contents: [
					{
						uri,
						mimeType: "text/markdown",
						text: md,
					},
				],
			};
		}

		if (uri === "netsuite://records/reference") {
			const types = recordsReferenceService.listRecordTypes();
			let md = `# Oracle NetSuite Official 272 Records Definition Index\n\n`;
			md += `Total records available: **${types.length}**\n\n`;
			md += `Use the tool \`netsuite_get_record_definition\` with \`{ recordType: '...' }\` to view complete field metadata for any type below.\n\n`;
			md += `### Supported Record Types:\n`;
			md += types.map((t) => `- \`${t}\``).join("\n");

			return {
				contents: [
					{
						uri,
						mimeType: "text/markdown",
						text: md,
					},
				],
			};
		}

		if (uri.startsWith("netsuite://skills/")) {
			const skillName = uri.substring("netsuite://skills/".length);
			// Sanitize the directory name to prevent path traversal
			const sanitizedName = basename(skillName);

			const skillsDir = getSkillsDir(projectRoot);
			const filePath = join(skillsDir, sanitizedName, "SKILL.md");
			try {
				const content = await fs.readFile(filePath, "utf-8");
				return {
					contents: [
						{
							uri,
							mimeType: "text/markdown",
							text: content,
						},
					],
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Skill resource not found or unreadable: ${uri} (${msg})`,
				);
			}
		}

		throw new Error(`Resource not found: ${uri}`);
	});
}
