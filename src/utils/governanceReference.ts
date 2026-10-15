/**
 * Oracle NetSuite SAFE Guide Official Governance Units & Execution Limits Matrix
 * Sourced from Oracle NetSuite SAFE Guide 2025.2 (Principle 2: Manage SuiteScript Usage Unit Consumption).
 */

export interface ScriptGovernanceLimit {
	scriptType: string;
	limitUnits: number | "N/A";
	scope: string;
	notes: string;
}

export interface ApiOperationGovernance {
	module: string;
	operation: string;
	units: number;
	costLevel: "Low" | "Medium" | "High";
	description: string;
	safeOptimization: string;
}

export interface SafeGovernanceRule {
	ruleId: string;
	title: string;
	safeGuideSection: string;
	description: string;
	bestPractice: string;
}

export const SCRIPT_GOVERNANCE_LIMITS: ScriptGovernanceLimit[] = [
	{
		scriptType: "Client Script",
		limitUnits: "N/A",
		scope: "Browser execution context",
		notes: "Runs client-side in browser; no server governance limits apply.",
	},
	{
		scriptType: "User Event Script",
		limitUnits: 1000,
		scope: "Per event (beforeLoad, beforeSubmit, afterSubmit)",
		notes:
			"Exceeding 1,000 units triggers SSS_USAGE_LIMIT_EXCEEDED. Minimize operations in beforeLoad to preserve UI responsiveness.",
	},
	{
		scriptType: "Suitelet",
		limitUnits: 1000,
		scope: "Per HTTP request invocation",
		notes: "Use for on-demand UI pages or custom lightweight endpoints.",
	},
	{
		scriptType: "RESTlet",
		limitUnits: 5000,
		scope: "Per REST HTTP request",
		notes:
			"High-throughput API integration endpoint. Yields 5x higher budget than Suitelet.",
	},
	{
		scriptType: "Scheduled Script",
		limitUnits: 10000,
		scope: "Per execution run",
		notes:
			"Can yield execution state and reschedule via script.yield() when remaining units < 500.",
	},
	{
		scriptType: "Map/Reduce Script",
		limitUnits: 10000,
		scope: "Per stage (getInputData, map, reduce, summarize)",
		notes:
			"Governance resets to 10,000 units per stage and per invocation slice across SuiteCloud parallel queues.",
	},
	{
		scriptType: "Workflow Action Script",
		limitUnits: 1000,
		scope: "Per action trigger",
		notes: "Custom logic invoked from NetSuite SuiteFlow workflows.",
	},
	{
		scriptType: "Mass Update Script",
		limitUnits: 1000,
		scope: "Per updated record",
		notes: "Executed for each selected record in mass update job.",
	},
	{
		scriptType: "Portlet Script",
		limitUnits: 1000,
		scope: "Per dashboard portlet render",
		notes: "Dashboard visual widgets; keep queries lightweight.",
	},
	{
		scriptType: "Bundle Installation Script",
		limitUnits: 10000,
		scope: "Per bundle install or update phase",
		notes: "Runs during SuiteApp installation/upgrade.",
	},
	{
		scriptType: "Custom GL Lines Plugin",
		limitUnits: 1000,
		scope: "Per transaction GL posting execution",
		notes: "Real-time custom GL lines generation plug-in.",
	},
];

export const API_OPERATION_GOVERNANCE: ApiOperationGovernance[] = [
	{
		module: "N/search",
		operation: "search.lookupFields()",
		units: 1,
		costLevel: "Low",
		description: "Retrieves specific scalar field values from a record.",
		safeOptimization:
			"SAFE Principle 2 Mandate: Always prefer search.lookupFields() (1 unit) over record.load() (5-10 units) for read-only access.",
	},
	{
		module: "N/crypto",
		operation: "crypto.checkMac()",
		units: 1,
		costLevel: "Low",
		description: "Validates HMAC digital signature.",
		safeOptimization: "Standard cryptographic verification.",
	},
	{
		module: "N/record",
		operation: "record.submitFields()",
		units: 2,
		costLevel: "Low",
		description:
			"Directly updates field values on an existing record without loading it into memory.",
		safeOptimization:
			"SAFE Principle 2 Mandate: Use submitFields() (2-4 units) instead of load() + save() (30 units) when updating scalar fields without sublists.",
	},
	{
		module: "N/record",
		operation: "record.load()",
		units: 5,
		costLevel: "Medium",
		description:
			"Loads an entire NetSuite record and all sublists into memory (5-10 units depending on record type).",
		safeOptimization:
			"SAFE-GOV-001 Mandate: NEVER call record.load() inside a loop. Hoist queries outside loops or use submitFields().",
	},
	{
		module: "N/record",
		operation: "record.create()",
		units: 10,
		costLevel: "Medium",
		description: "Instantiates a new record in memory.",
		safeOptimization:
			"Batch create records in Map/Reduce for high-volume transactions.",
	},
	{
		module: "N/search",
		operation: "search.create().run()",
		units: 10,
		costLevel: "Medium",
		description: "Executes a saved search or ad-hoc query.",
		safeOptimization:
			"SAFE-GOV-002 Mandate: NEVER call search.create() inside a loop. Hoist query definitions outside loops.",
	},
	{
		module: "N/query",
		operation: "query.runSuiteQL()",
		units: 10,
		costLevel: "Medium",
		description: "Executes a SuiteQL query via N/query module.",
		safeOptimization:
			"Enforce FETCH FIRST N ROWS ONLY, explicit projection, and mainline filters.",
	},
	{
		module: "N/email",
		operation: "email.send()",
		units: 10,
		costLevel: "Medium",
		description: "Dispatches an email notification.",
		safeOptimization: "Aggregate notification emails where appropriate.",
	},
	{
		module: "N/https",
		operation: "https.request()",
		units: 10,
		costLevel: "Medium",
		description: "Makes an outbound HTTP/HTTPS web service call.",
		safeOptimization:
			"Cache external API responses using N/cache to avoid duplicate network roundtrips.",
	},
	{
		module: "N/file",
		operation: "file.load()",
		units: 10,
		costLevel: "Medium",
		description: "Reads a file from the NetSuite File Cabinet.",
		safeOptimization: "Cache static templates and configurations.",
	},
	{
		module: "N/render",
		operation: "render.xmlToPdf()",
		units: 10,
		costLevel: "Medium",
		description: "Generates a PDF document from Advanced PDF/HTML template.",
		safeOptimization: "Offload batch PDF rendering to Map/Reduce.",
	},
	{
		module: "N/record",
		operation: "record.save()",
		units: 20,
		costLevel: "High",
		description: "Commits record modifications and writes to database.",
		safeOptimization:
			"High-cost write (20 units). Avoid in loops. For mass updates, use Map/Reduce script.",
	},
	{
		module: "N/record",
		operation: "record.delete()",
		units: 20,
		costLevel: "High",
		description: "Permanently deletes a record from the database.",
		safeOptimization:
			"Validate existence before deletion to avoid wasteful error handling.",
	},
	{
		module: "N/file",
		operation: "file.save()",
		units: 20,
		costLevel: "High",
		description: "Persists a file to the NetSuite File Cabinet.",
		safeOptimization: "Batch file uploads and avoid redundant file writes.",
	},
	{
		module: "N/task",
		operation: "task.create().submit()",
		units: 20,
		costLevel: "High",
		description: "Schedules a task (Map/Reduce, Scheduled Script, CSV Import).",
		safeOptimization: "Ensure queue availability before submitting tasks.",
	},
];

export const SAFE_GOVERNANCE_RULES: SafeGovernanceRule[] = [
	{
		ruleId: "SAFE-GOV-001",
		title: "Prohibit Record Load in Loops (Loop-Record-Load)",
		safeGuideSection: "SAFE Guide 2025.2 Section 2.2 & Pitfall 1",
		description:
			"Calling record.load() (5-10 units) inside a loop quickly exhausts the 1,000 unit budget (e.g. 100 iterations = 1,000 units exhausted).",
		bestPractice:
			"Use search.lookupFields() (1 unit) for reads or record.submitFields() (2-4 units) for field updates.",
	},
	{
		ruleId: "SAFE-GOV-002",
		title: "Query Hoisting Mandate (Loop-Search-Create)",
		safeGuideSection: "SAFE Guide 2025.2 Section 2.2 & Pitfall 2",
		description:
			"Calling search.create() or query.runSuiteQL() (10 units) inside a loop causes rapid governance exhaustion.",
		bestPractice:
			"Hoist the search or SuiteQL query outside the loop and iterate through the pre-fetched result set.",
	},
	{
		ruleId: "SAFE-GOV-003",
		title: "Scheduled vs Map/Reduce Scaling Mandate",
		safeGuideSection: "SAFE Guide 2025.2 Section 2.4",
		description:
			"Scheduled Scripts have a single-threaded 10,000 unit limit and cannot process very large datasets concurrently.",
		bestPractice:
			"For processing >1,000 records, always adopt Map/Reduce scripts with multi-threaded parallel queue execution.",
	},
	{
		ruleId: "SAFE-GOV-004",
		title: "Active Governance Monitoring & Yielding",
		safeGuideSection: "SAFE Guide 2025.2 Section 2.5",
		description:
			"Failing to check remaining governance units causes sudden script termination without recovery.",
		bestPractice:
			"Regularly check runtime.getCurrentScript().getRemainingUsage() and yield when remaining units < 500.",
	},
];

export function getAllScriptLimits(): ScriptGovernanceLimit[] {
	return [...SCRIPT_GOVERNANCE_LIMITS];
}

export function getAllOperationCosts(): ApiOperationGovernance[] {
	return [...API_OPERATION_GOVERNANCE];
}

export function formatGovernanceUnitsMarkdown(): string {
	let md = `# Oracle NetSuite SAFE Guide Official Governance Units & Limits Reference\n\n`;
	md += `> **Authority**: Oracle NetSuite SAFE Guide 2025.2 (Principle 2: Manage SuiteScript Usage Unit Consumption)\n`;
	md += `> **Standard**: SuiteCloud Platform Runtime Governance Budgeting & Optimization\n\n`;

	// Section 1: Script Limits
	md += `## ⏱️ 1. Script Type Governance Limits\n\n`;
	md += `| Script Type | Usage Unit Limit | Execution Scope | Lifecycle Notes |\n|:---|:---:|:---|:---|\n`;
	for (const s of SCRIPT_GOVERNANCE_LIMITS) {
		const limitStr =
			typeof s.limitUnits === "number"
				? `**${s.limitUnits.toLocaleString()}** units`
				: `\`${s.limitUnits}\``;
		md += `| **${s.scriptType}** | ${limitStr} | ${s.scope} | ${s.notes} |\n`;
	}
	md += `\n---\n\n`;

	// Section 2: API Operation Costs
	md += `## 💰 2. API Operation Usage Unit Costs\n\n`;
	md += `| Module & Operation | Usage Units | Cost Level | SAFE Optimization & Best Practice |\n|:---|:---:|:---:|:---|\n`;
	for (const op of API_OPERATION_GOVERNANCE) {
		const badge =
			op.costLevel === "Low"
				? "🟢 Low"
				: op.costLevel === "Medium"
					? "🟡 Medium"
					: "🔴 High";
		md += `| \`${op.operation}\` | **${op.units}** | ${badge} | ${op.safeOptimization} |\n`;
	}
	md += `\n---\n\n`;

	// Section 3: SAFE Optimization Rules
	md += `## 🛡️ 3. Oracle SAFE Guide Core Optimization Patterns\n\n`;
	for (const rule of SAFE_GOVERNANCE_RULES) {
		md += `### ${rule.ruleId}: ${rule.title}\n`;
		md += `*Source: ${rule.safeGuideSection}*\n\n`;
		md += `> **Constraint**: ${rule.description}\n\n`;
		md += `✅ **Remediation & Best Practice**:\n${rule.bestPractice}\n\n`;
	}

	return md;
}
