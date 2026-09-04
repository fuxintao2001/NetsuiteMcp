import type { Server } from "@modelcontextprotocol/server";

export interface PromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface PromptDefinition {
	name: string;
	description?: string;
	arguments?: PromptArgument[];
}

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
	{
		name: "review_suitescript",
		description:
			"Review SuiteScript 2.1 code against Oracle SAFE Guide 2025.2 and OWASP standards. Evaluates Governance Units, loops, queries, and security.",
		arguments: [
			{
				name: "code",
				description: "The SuiteScript 2.1 source code to review.",
				required: true,
			},
			{
				name: "scriptType",
				description:
					"Type of script (e.g. UserEvent, MapReduce, ClientScript, Suitelet, RESTlet, Scheduled).",
				required: false,
			},
		],
	},
	{
		name: "debug_script_error",
		description:
			"Analyze a NetSuite script execution error stack trace. Pinpoints root cause (e.g. null pointer, governance, record locks) and offers a patch.",
		arguments: [
			{
				name: "errorLog",
				description:
					"The NetSuite error message, stack trace, or ScriptNote detail.",
				required: true,
			},
			{
				name: "scriptCode",
				description:
					"Optional: Relevant SuiteScript code snippet around the failing line.",
				required: false,
			},
		],
	},
	{
		name: "generate_suiteql",
		description:
			"Generate standard, high-performance Oracle NetSuite SuiteQL adhering strictly to SAFE Guide syntax rules and avoiding common pitfalls.",
		arguments: [
			{
				name: "requirement",
				description:
					"Natural language description of what NetSuite data you want to retrieve.",
				required: true,
			},
			{
				name: "recordType",
				description:
					"Target record type or domain (e.g. transaction, inventory, customer, customrecord_xxx).",
				required: false,
			},
		],
	},
];

export function registerPromptHandlers(server: Server): void {
	// --- List Prompts ---
	// Suppressed by default to prevent polluting IDE/client slash command menus with
	// duplicate mcp:<server>:<prompt> entries across multiple active account instances.
	// Can be explicitly enabled via ENABLE_MCP_PROMPTS=true.
	server.setRequestHandler("prompts/list", async () => {
		const isEnabled = process.env.ENABLE_MCP_PROMPTS === "true";
		return {
			prompts: isEnabled ? PROMPT_DEFINITIONS : [],
		};
	});

	// --- Get Prompt ---
	server.setRequestHandler("prompts/get", async (request) => {
		const { name, arguments: args } = request.params;

		switch (name) {
			case "review_suitescript": {
				const code = (args?.code as string) || "";
				const scriptType = (args?.scriptType as string) || "SuiteScript 2.1";

				const promptText = `You are an expert NetSuite Technical Architect and Senior SuiteScript Developer.
Please perform a rigorous code review of the following ${scriptType} code against Oracle NetSuite SAFE Guide (2025.2) standards:

\`\`\`javascript
${code}
\`\`\`

## Mandatory Review Checklist:
1. **Governance Usage & Budget**:
   - Are there any \`record.load()\` or search executions inside \`for\` / \`forEach\` loops?
   - Is Governance limit at risk for large datasets? What is the estimated Governance consumption per record/execution?
2. **Performance & Query Optimization**:
   - Are searches/SuiteQL queries bounded with proper mainline filters, indexed conditions, and pagination?
   - Is \`N/search\` or \`N/query\` used with proper columns instead of loading whole records where possible?
3. **Defensive Coding & Exception Handling**:
   - Are try/catch blocks used properly without silently swallowing critical errors?
   - Are null/undefined checks present before accessing record field values?
4. **Security & OWASP**:
   - Is output encoded? Are user inputs sanitized to prevent SOQL/SuiteQL or script injection?
5. **Concrete Refactoring Patch**:
   - Provide the complete, production-ready refactored code fixing all identified pitfalls.`;

				return {
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: promptText,
							},
						},
					],
				};
			}

			case "debug_script_error": {
				const errorLog = (args?.errorLog as string) || "";
				const scriptCode = (args?.scriptCode as string) || "";

				let promptText = `You are a NetSuite Technical Support Specialist and SuiteScript Debugger.
Analyze the following NetSuite runtime error log and pinpoint the exact root cause:

## Error Log / Stack Trace:
\`\`\`
${errorLog}
\`\`\``;

				if (scriptCode) {
					promptText += `\n\n## Script Code Context:\n\`\`\`javascript\n${scriptCode}\n\`\`\``;
				}

				promptText += `\n\nPlease identify:
1. **Root Cause**: Explain clearly in Simplified Chinese what failed (e.g. record lock, missing field, null pointer, invalid record type, governance exhaustion).
2. **NetSuite Specific Context**: Explain any underlying NetSuite platform quirks related to this error.
3. **Actionable Fix**: Provide the exact code fix or configuration change (permissions, role, record type) required to resolve it.`;

				return {
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: promptText,
							},
						},
					],
				};
			}

			case "generate_suiteql": {
				const req = (args?.requirement as string) || "";
				const recType = (args?.recordType as string) || "transaction";

				const promptText = `You are a SuiteQL specialist following Oracle SAFE Guide (2025.2) and NetSuite2.com standards.
Generate a valid, high-performance SuiteQL query for the following requirement:

- **Requirement**: ${req}
- **Target Domain / Record**: ${recType}

## Mandatory SuiteQL Guardrails:
1. NO \`SELECT *\` — specify explicit column names.
2. If querying \`transaction\` + \`transactionline\`, ALWAYS include \`tl.mainline = 'F'\` and \`tl.taxline = 'F'\`.
3. If checking downstream linked transactions, join on \`transactionline.createdfrom\` (NOT transaction.createdfrom).
4. If querying cross-item location stock, use \`aggregateitemlocation\` (NOT \`inventoryitemlocations\`).
5. Use \`BUILTIN.DF(fieldName)\` to display friendly names without unnecessary JOINs.
6. End with \`FETCH FIRST 100 ROWS ONLY\`.
7. Output the query with parameter placeholders and explain each column choice.`;

				return {
					messages: [
						{
							role: "user",
							content: {
								type: "text",
								text: promptText,
							},
						},
					],
				};
			}

			default:
				throw new Error(`Unknown prompt: ${name}`);
		}
	});
}
