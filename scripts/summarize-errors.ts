#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { getDefaultLogsDir } from "../src/utils/environment.js";
import type { ToolErrorCategory } from "../src/utils/toolErrorLogger.js";
import {
	formatSummaryToMarkdown,
	summarizeToolErrors,
} from "../src/utils/toolErrorSummarizer.js";

// Parse CLI arguments
function parseArgs() {
	const args = process.argv.slice(2);
	const options: {
		days?: number;
		tool?: string;
		category?: ToolErrorCategory;
		output?: string;
		logsDir?: string;
		json?: boolean;
		help?: boolean;
	} = {};

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg.startsWith("--days=")) {
			options.days = Number.parseInt(arg.split("=")[1], 10);
		} else if (arg.startsWith("--tool=")) {
			options.tool = arg.split("=")[1];
		} else if (arg.startsWith("--category=")) {
			options.category = arg.split("=")[1] as ToolErrorCategory;
		} else if (arg.startsWith("--output=")) {
			options.output = arg.split("=")[1];
		} else if (arg.startsWith("--logs-dir=")) {
			options.logsDir = arg.split("=")[1];
		} else if (arg === "--json") {
			options.json = true;
		}
	}

	return options;
}

function printUsage() {
	console.log(`
📊 NetSuite MCP Tool Error Summarizer CLI

Usage:
  npm run logs:summary [options]
  tsx scripts/summarize-errors.ts [options]

Options:
  --days=<n>         Number of days to analyze (default: 7)
  --tool=<name>      Filter errors for a specific tool (e.g. --tool=ns_runCustomSuiteQL)
  --category=<cat>   Filter by error category (ARGUMENT_VALIDATION, SUITEQL_SYNTAX, etc.)
  --output=<path>    Write markdown report to specified file path
  --logs-dir=<path>  Custom directory containing log files
  --json             Output raw JSON summary data instead of Markdown
  --help, -h         Show this help message

Examples:
  npm run logs:summary
  npm run logs:summary -- --days=30
  npm run logs:summary -- --tool=ns_runCustomSuiteQL --output=suiteql-report.md
`);
}

async function main() {
	const options = parseArgs();

	if (options.help) {
		printUsage();
		process.exit(0);
	}

	const days = options.days || 7;
	const logsDir = options.logsDir || getDefaultLogsDir();

	console.log("🔍 [1/3] Scanning NetSuite MCP error logs...");
	console.log(`📁 Log directory: ${logsDir}`);
	console.log(
		`⏱️  Time window: Past ${days} days${options.tool ? ` | Tool: ${options.tool}` : ""}${options.category ? ` | Category: ${options.category}` : ""}\n`,
	);

	try {
		const summary = await summarizeToolErrors({
			logsDir,
			days,
			tool: options.tool,
			category: options.category,
		});

		console.log("📈 [2/3] Computing analytics & optimization guidance...");
		console.log(`   - Total errors captured: ${summary.totalErrors}`);
		console.log(
			`   - Affected tools: ${Object.keys(summary.byTool).length} tool(s)`,
		);
		console.log(
			`   - Generated recommendations: ${summary.recommendations.length} action item(s)\n`,
		);

		if (options.json) {
			console.log(JSON.stringify(summary, null, 2));
			return;
		}

		const markdownReport = formatSummaryToMarkdown(summary);

		if (options.output) {
			const outputPath = path.resolve(options.output);
			fs.writeFileSync(outputPath, markdownReport, "utf-8");
			console.log(
				`✅ [3/3] Analysis report successfully generated and saved to:`,
			);
			console.log(`   📄 ${outputPath}\n`);
		} else {
			console.log("📝 [3/3] Generated Report Preview:\n");
			console.log(markdownReport);
			console.log(
				"\n💡 Tip: Add '--output=report.md' to save this report to a Markdown file.",
			);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`❌ Error generating summary: ${msg}`);
		process.exit(1);
	}
}

main();
