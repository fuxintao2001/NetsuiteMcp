import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { getSkillsDir } from "../utils/environment.js";
import { textResult } from "./types.js";

/** Simple parser for YAML frontmatter in SKILL.md files. */
function parseFrontmatter(content: string): {
	name?: string;
	description?: string;
} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) return {};
	const lines = match[1].split("\n");
	const result: { name?: string; description?: string } = {};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const nameMatch = trimmed.match(/^name:\s*['"]?(.*?)['"]?$/);
		const descMatch = trimmed.match(/^description:\s*['"]?(.*?)['"]?$/);
		if (nameMatch?.[1]) result.name = nameMatch[1];
		if (descMatch?.[1]) result.description = descMatch[1];
	}

	return result;
}

/** Extracts a specific Markdown section by heading keyword. */
function extractSection(
	markdown: string,
	sectionHeading: string,
): string | null {
	const headingLower = sectionHeading.toLowerCase().trim();
	const lines = markdown.split("\n");
	let capturing = false;
	let captureLevel = 0;
	const capturedLines: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			const level = headingMatch[1]?.length ?? 1;
			const title = (headingMatch[2] || "").toLowerCase().trim();

			if (capturing) {
				// Stop capturing when encountering a heading of the same or higher level
				if (level <= captureLevel) {
					break;
				}
			} else if (title.includes(headingLower)) {
				capturing = true;
				captureLevel = level;
				capturedLines.push(line);
				continue;
			}
		}

		if (capturing) {
			capturedLines.push(line);
		}
	}

	return capturing ? capturedLines.join("\n").trim() : null;
}

/**
 * Handler for netsuite_get_skill — on-demand discovery and retrieval of
 * Oracle SuiteCloud Agent Skills and engineering reference standards.
 */
export async function handleGetSkill(
	args: Record<string, unknown>,
	projectRoot?: string,
): Promise<CallToolResult> {
	const skillsDir = getSkillsDir(projectRoot);
	const rawSkillName =
		typeof args.skillName === "string" ? args.skillName.trim() : "";
	const section = typeof args.section === "string" ? args.section.trim() : "";

	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await fs.readdir(skillsDir, { withFileTypes: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(
			`⚠️ Failed to access skills directory at '${skillsDir}': ${msg}`,
			true,
		);
	}

	const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

	// Case 1: List all available skills when skillName is omitted
	if (!rawSkillName) {
		let listMd = `# 📚 Oracle NetSuite Available Agent Skills Library\n\n`;
		listMd += `The following official SuiteCloud Agent Skills are available for on-demand lookup:\n\n`;
		listMd += `| Skill Name | Description |\n|---|---|\n`;

		for (const dirName of skillDirs) {
			const skillMdPath = path.join(skillsDir, dirName, "SKILL.md");
			try {
				const content = await fs.readFile(skillMdPath, "utf-8");
				const meta = parseFrontmatter(content);
				const name = meta.name || dirName;
				const desc = (meta.description || "-")
					.replace(/\|/g, "\\|")
					.slice(0, 120);
				listMd += `| \`${name}\` | ${desc} |\n`;
			} catch {
				listMd += `| \`${dirName}\` | NetSuite SuiteCloud Skill |\n`;
			}
		}

		listMd += `\n💡 Call \`netsuite_get_skill({ skillName: '<name>' })\` to read full specifications, or specify \`section\` for targeted guidance.`;
		return textResult(listMd);
	}

	// Case 2: Retrieve specific skill
	const sanitizedName = path.basename(rawSkillName);
	// Match exact or fuzzy folder name
	const targetDir =
		skillDirs.find((d) => d.toLowerCase() === sanitizedName.toLowerCase()) ||
		skillDirs.find((d) =>
			d.toLowerCase().includes(sanitizedName.toLowerCase()),
		);

	if (!targetDir) {
		return textResult(
			`❌ Skill '${rawSkillName}' not found.\nAvailable skills: ${skillDirs.map((s) => `\`${s}\``).join(", ")}`,
			true,
		);
	}

	const skillMdPath = path.join(skillsDir, targetDir, "SKILL.md");
	let content: string;
	try {
		content = await fs.readFile(skillMdPath, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return textResult(`❌ Failed to read skill '${targetDir}': ${msg}`, true);
	}

	// Filter section if requested
	if (section) {
		const sectionContent = extractSection(content, section);
		if (sectionContent) {
			return textResult(
				`# 📖 Skill: \`${targetDir}\` — Section: "${section}"\n\n${sectionContent}`,
			);
		}
		// If specific section not found, inform and return full content
		return textResult(
			`⚠️ Section matching "${section}" not found in skill \`${targetDir}\`.\nReturning complete skill documentation below:\n\n${content}`,
		);
	}

	return textResult(content);
}
