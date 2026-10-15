import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { registerToolHandlers } from "../src/handlers/tools.js";
import { NetSuiteMCPTools } from "../src/mcp/tools.js";
import { OAuthManager } from "../src/oauth/manager.js";

/**
 * Live End-to-End Test Suite against real NetSuite Sandbox (9260916-sb1).
 *
 * Validates actual MCP tool operations against genuine NetSuite ERP data:
 * - Sales Order: SO-ZH-202112-000003 (ID: 6257)
 * - Customer: IC00000009 (ID: 166, 100101-NVC Lighting Japan株式会社)
 */
describe("NetSuite Live Sandbox E2E Suite (9260916-sb1)", () => {
	const sessionPath =
		process.env.NETSUITE_SESSION_PATH ||
		"/Users/fuxintao/.gemini/antigravity/sessions/9260916_sb1";
	const sessionFile = path.join(sessionPath, "session.json");
	const hasSession = fs.existsSync(sessionFile);

	let callTool: (
		name: string,
		args?: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;

	beforeAll(async () => {
		if (!hasSession) {
			console.warn(
				`⚠️ Skipping live E2E tests: session file not found at ${sessionFile}`,
			);
			return;
		}

		const oauthManager = new OAuthManager({ storagePath: sessionPath });
		const mcpTools = new NetSuiteMCPTools(oauthManager);
		const registeredHandlers = new Map<
			string,
			(...args: unknown[]) => unknown
		>();

		const mockServer = {
			setRequestHandler: (
				method: string,
				handler: (...args: unknown[]) => unknown,
			) => {
				registeredHandlers.set(method, handler);
			},
		};

		registerToolHandlers({
			server: mockServer as any,
			oauthManager,
			mcpTools,
			resolveCustomRecordRectype: async () => null,
			customRecordMap: new Map(),
		});

		const handler = registeredHandlers.get("tools/call") as (req: {
			params: { name: string; arguments?: Record<string, unknown> };
		}) => Promise<any>;

		callTool = async (name: string, args: Record<string, unknown> = {}) => {
			return await handler({ params: { name, arguments: args } });
		};
	});

	it("1. netsuite_status: should connect to 9260916-sb1 and return active Sandbox status", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_status", { includeErrors: true });
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("9260916-sb1");
		expect(text).toContain("Sandbox");
		expect(text).toContain("Authenticated");
	});

	it("2. netsuite_run_suiteql: should query real customer entities with clean Markdown formatting", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_run_suiteql", {
			sqlQuery:
				"SELECT id, entityid, companyname, email FROM customer WHERE ROWNUM <= 3",
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("| id | entityid | companyname |");
		expect(text).toContain("IC000000");
	});

	it("3. netsuite_run_suiteql: should query real sales orders with indexed driving filters", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_run_suiteql", {
			sqlQuery:
				"SELECT id, tranid, type, trandate FROM transaction WHERE type = 'SalesOrd' AND ROWNUM <= 3",
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("SalesOrd");
		expect(text).toContain("SO-ZH-");
	});

	it("4. netsuite_run_suiteql: should execute parallel batch queries via ConcurrencyLimiter pool", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_run_suiteql", {
			sqlQueries: [
				"SELECT id, entityid FROM customer WHERE ROWNUM <= 2",
				"SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' AND ROWNUM <= 2",
			],
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("Parallel SuiteQL Batch Execution (2 Queries)");
		expect(text).toContain("Query #1");
		expect(text).toContain("Query #2");
	});

	it("5. netsuite_get_metadata: should inspect real table schemas for customer and salesorder", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_metadata", {
			tables: ["customer", "salesorder"],
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("customer");
		expect(text).toContain("salesorder");
		expect(text).toContain("entityid");
	});

	it("6. netsuite_get_record: should inspect real sales order by numeric internal ID (6257)", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_record", {
			recordType: "salesorder",
			id: "6257",
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("salesorder");
		expect(text).toContain("6257");
		expect(text).toContain("SO-ZH-202112-000003");
		expect(text).toContain("NVCI_MFG_销售订单");
	});

	it("7. netsuite_get_record: should automatically resolve document natural key (SO-ZH-202112-000003) to internal ID", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_record", {
			recordType: "salesorder",
			id: "SO-ZH-202112-000003",
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("salesorder");
		expect(text).toContain("6257");
		expect(text).toContain("SO-ZH-202112-000003");
	});

	it("8. netsuite_get_record: should inspect real customer by entity ID (IC00000009)", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_record", {
			recordType: "customer",
			id: "IC00000009",
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toContain("customer");
		expect(text).toContain("166");
		expect(text).toContain("100101-NVC Lighting Japan株式会社");
	});

	it("9. netsuite_get_record: should return structured RECORD_NOT_FOUND for non-existent document numbers", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_record", {
			recordType: "salesorder",
			id: "NON_EXISTENT_DOC_999999",
		});
		expect(res.isError).toBe(true);

		const text = res.content[0]?.text || "";
		expect(text).toContain("Record Not Found");
		expect(text).toContain("NON_EXISTENT_DOC_999999");
	});

	it("10. netsuite_get_script_logs: should retrieve recent execution logs from real ScriptNote table", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_script_logs", {
			limit: 5,
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toBeDefined();
	});

	it("11. netsuite_get_system_notes: should retrieve audit logs for real transaction (6257)", async () => {
		if (!hasSession) return;
		const res = await callTool("netsuite_get_system_notes", {
			recordType: "salesorder",
			recordId: "6257",
		});
		expect(res.isError).toBeFalsy();

		const text = res.content[0]?.text || "";
		expect(text).toBeDefined();
	});

	it("12. Sandbox write boundary: netsuite_create_record & netsuite_update_record should reject missing parameters", async () => {
		if (!hasSession) return;
		const createRes = await callTool("netsuite_create_record", {});
		expect(createRes.isError).toBe(true);
		expect(createRes.content[0]?.text).toContain("Invalid arguments");

		const updateRes = await callTool("netsuite_update_record", {
			recordType: "customer",
		});
		expect(updateRes.isError).toBe(true);
		expect(updateRes.content[0]?.text).toContain("Invalid arguments");
	});
});
