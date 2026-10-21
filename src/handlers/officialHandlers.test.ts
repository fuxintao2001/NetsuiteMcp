import { describe, expect, it, vi } from "vitest";
import type { NetSuiteMCPTools } from "../mcp/tools.js";
import { handleCallOfficial } from "./officialHandlers.js";

describe("officialHandlers - handleCallOfficial", () => {
	const mockOfficialTools = [
		{
			name: "ns_runSavedSearch",
			title: "Run Saved Search",
			description: "Runs a saved search from your NetSuite account",
			inputSchema: {
				type: "object",
				properties: {
					searchId: {
						type: "string",
						description: "Internal ID of saved search",
					},
					range_start: { type: "number", description: "Start row index" },
					range_end: { type: "number", description: "End row index" },
				},
				required: ["searchId"],
			},
			annotations: {
				title: "Run Saved Search",
				readOnlyHint: true,
				destructiveHint: false,
			},
		},
		{
			name: "ns_runReport",
			title: "Run Report",
			description: "Run a report in your NetSuite Account",
			inputSchema: {
				type: "object",
				properties: {
					reportId: { type: "string", description: "Report internal ID" },
					dateTo: { type: "string", description: "Cutoff date" },
				},
				required: ["reportId", "dateTo"],
			},
			annotations: {
				title: "Run Report",
				readOnlyHint: true,
				destructiveHint: false,
			},
		},
		{
			name: "ns_createRecord",
			title: "Create Record",
			description: "Create a new record in NetSuite",
			inputSchema: {
				type: "object",
				properties: {
					recordType: { type: "string", description: "Record type" },
					data: { type: "string", description: "JSON stringified data" },
				},
				required: ["recordType", "data"],
			},
			annotations: {
				title: "Create Record",
				readOnlyHint: false,
				destructiveHint: false,
			},
		},
		{
			name: "ns_prompt_library_app",
			title: "Prompt Library App",
			description: "Interactive MCP App for browsing prompts",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
			_meta: { ui: { resourceUri: "ui://..." } },
		},
	];

	function createMockMcpTools(
		overrides: Partial<NetSuiteMCPTools> = {},
	): NetSuiteMCPTools {
		return {
			fetchTools: vi.fn().mockResolvedValue(mockOfficialTools),
			executeTool: vi
				.fn()
				.mockResolvedValue({ content: [{ type: "text", text: "[]" }] }),
			...overrides,
		} as unknown as NetSuiteMCPTools;
	}

	it("action: 'list' returns structured markdown table of official tools", async () => {
		const mcpTools = createMockMcpTools();
		const res = await handleCallOfficial(
			{ action: "list" },
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBeFalsy();
		const text = res.content[0].text;
		expect(text).toContain("Oracle NetSuite Official Native Tools");
		expect(text).toContain("ns_runSavedSearch");
		expect(text).toContain("ns_runReport");
		expect(text).toContain("Interactive MCP Apps");
		expect(text).toContain("ns_prompt_library_app");
	});

	it("action: 'schema' returns parameter details for specified tool", async () => {
		const mcpTools = createMockMcpTools();
		const res = await handleCallOfficial(
			{ action: "schema", toolName: "ns_runSavedSearch" },
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBeFalsy();
		const text = res.content[0].text;
		expect(text).toContain("Official Tool Schema: `ns_runSavedSearch`");
		expect(text).toContain("searchId");
		expect(text).toContain("range_start");
		expect(text).toContain("range_end");
	});

	it("action: 'schema' fails if toolName is missing", async () => {
		const mcpTools = createMockMcpTools();
		const res = await handleCallOfficial(
			{ action: "schema" },
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("'toolName' parameter is required");
	});

	it("action: 'schema' fails if toolName is unknown", async () => {
		const mcpTools = createMockMcpTools();
		const res = await handleCallOfficial(
			{ action: "schema", toolName: "ns_nonExistent" },
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain(
			"Official tool 'ns_nonExistent' not found",
		);
	});

	it("action: 'call' executes tool and returns markdown table for array results", async () => {
		const searchResults = [
			{ id: "101", tranid: "SO10023", amount: "500.00" },
			{ id: "102", tranid: "SO10024", amount: "750.00" },
		];
		const mcpTools = createMockMcpTools({
			executeTool: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: JSON.stringify(searchResults) }],
			}),
		});

		const res = await handleCallOfficial(
			{
				action: "call",
				toolName: "ns_runSavedSearch",
				parameters: { searchId: "customsearch_orders" },
			},
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBeFalsy();
		const text = res.content[0].text;
		expect(text).toContain("## 🏛️ Official Tool: `ns_runSavedSearch`");
		expect(text).toContain("| id | tranid | amount |");
		expect(text).toContain("SO10023");
		expect(text).toContain("500.00");
	});

	it("action: 'call' returns compact_json format when requested", async () => {
		const searchResults = [{ id: "101", tranid: "SO10023" }];
		const mcpTools = createMockMcpTools({
			executeTool: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: JSON.stringify(searchResults) }],
			}),
		});

		const res = await handleCallOfficial(
			{
				action: "call",
				toolName: "ns_runSavedSearch",
				parameters: { searchId: "customsearch_orders" },
				format: "compact_json",
			},
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toBe(JSON.stringify(searchResults));
	});

	it("action: 'call' blocks mutation tool in Production environment", async () => {
		const mcpTools = createMockMcpTools();
		const res = await handleCallOfficial(
			{
				action: "call",
				toolName: "ns_createRecord",
				parameters: { recordType: "customer", data: "{}" },
			},
			mcpTools,
			"9260916", // Production account
			false, // isSandbox = false
		);

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("[Production Safety Violation]");
		expect(mcpTools.executeTool).not.toHaveBeenCalled();
	});

	it("action: 'call' allows mutation tool in Sandbox environment", async () => {
		const mcpTools = createMockMcpTools({
			executeTool: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: JSON.stringify({ id: "999" }) }],
			}),
		});

		const res = await handleCallOfficial(
			{
				action: "call",
				toolName: "ns_createRecord",
				parameters: { recordType: "customer", data: "{}" },
			},
			mcpTools,
			"9260916_SB1",
			true, // isSandbox = true
		);

		expect(res.isError).toBeFalsy();
		expect(mcpTools.executeTool).toHaveBeenCalledWith("ns_createRecord", {
			recordType: "customer",
			data: "{}",
		});
	});

	it("action: 'call' appends permission advice when permission is denied", async () => {
		const mcpTools = createMockMcpTools({
			executeTool: vi
				.fn()
				.mockRejectedValue(
					new Error("INSUFFICIENT_PERMISSION: permission violation"),
				),
		});

		const res = await handleCallOfficial(
			{
				action: "call",
				toolName: "ns_runReport",
				parameters: { reportId: "152" },
			},
			mcpTools,
			"9260916_SB1",
			true,
		);

		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain(
			"PERMISSION DENIED — HARD STOP REQUIRED",
		);
	});
});
