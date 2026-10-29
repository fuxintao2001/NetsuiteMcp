import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suitecloudRunnerService } from "../utils/suitecloudRunner.js";
import { registerResourceHandlers } from "./resources.js";
import { registerToolHandlers } from "./tools.js";
import { formatTargetFileDisplay } from "./uploadHandlers.js";

describe("MCP Handler Wires", () => {
	let mockServer: any;
	let mockOAuthManager: any;
	let mockMCPTools: any;
	let registeredHandlers: Map<string, (...args: any[]) => any>;

	const testRoot = path.join(process.cwd(), ".test-handlers-root");

	beforeEach(async () => {
		vi.clearAllMocks();
		await fs.rm(testRoot, { recursive: true, force: true });
		await fs.mkdir(
			path.join(testRoot, "skills/netsuite-ai-connector-instructions"),
			{ recursive: true },
		);
		await fs.writeFile(
			path.join(testRoot, "skills/netsuite-ai-connector-instructions/SKILL.md"),
			"# SuiteQL Guidelines",
		);

		registeredHandlers = new Map();
		mockServer = {
			setRequestHandler: vi.fn(
				(method: string, handler: (...args: any[]) => any) => {
					registeredHandlers.set(method, handler);
				},
			),
		};

		mockOAuthManager = {
			getAccountId: (vi.fn() as any).mockResolvedValue("9260916-sb1"),
			hasValidSession: (vi.fn() as any).mockResolvedValue(true),
			getSessionInfo: (vi.fn() as any).mockResolvedValue({
				authenticated: true,
				accountId: "9260916-sb1",
			}),
		};

		mockMCPTools = {
			fetchTools: (vi.fn() as any).mockResolvedValue([
				{ name: "ns_getRecord", description: "Fetch NetSuite records" },
				{ name: "ns_createRecord", description: "Create NetSuite records" },
				{ name: "ns_updateRecord", description: "Update NetSuite records" },
				{ name: "ns_runCustomSuiteQL", description: "Run SuiteQL queries" },
			]),
			executeTool: (vi.fn() as any).mockImplementation(
				(name: string, args: any) => {
					if (name === "ns_runCustomSuiteQL" && args.customRecordMappings) {
						if (
							args.customRecordMappings.some(
								(m: any) =>
									typeof m.rectype === "string" &&
									m.rectype.includes("unknown"),
							)
						) {
							throw new Error("Could not resolve rectype ID");
						}
					}
					return Promise.resolve({
						id: "166",
						entityid: "IC00000009",
						type: "customer",
						name: "100101-NVC Lighting Japan株式会社",
					});
				},
			),
			customRecordMappings: new Map(),
			extractDataArray: (result: any) => {
				if (result && Array.isArray(result.data)) return result.data;
				return [];
			},
		};
	});

	afterEach(async () => {
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	describe("Tools Handler Wiring", () => {
		let authCb: any;
		let logoutCb: any;
		let refreshCb: any;

		beforeEach(() => {
			authCb = (vi.fn() as any).mockResolvedValue({
				content: [{ type: "text", text: "Authentication process initiated" }],
			});
			logoutCb = (vi.fn() as any).mockResolvedValue({
				content: [{ type: "text", text: "Logged out successfully" }],
			});
			refreshCb = vi.fn();

			registerToolHandlers({
				server: mockServer,
				oauthManager: mockOAuthManager,
				mcpTools: mockMCPTools,
				projectRoot: testRoot,
				handleAuthentication: authCb,
				handleLogout: logoutCb,
				handleCacheRefresh: refreshCb,
				resolveCustomRecordRectype: async (type: string) => {
					if (type.toLowerCase() === "customrecord_etissl_carrier") return 54;
					return null;
				},
			});
		});

		it("should register tool list and call schemas", () => {
			expect(registeredHandlers.has("tools/list")).toBe(true);
			expect(registeredHandlers.has("tools/call")).toBe(true);
		});

		it("should list 8 authoritative tools in Production environment", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916"); // Production
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const names = result.tools.map((t: any) => t.name);

			expect(names).toContain("netsuite_run_suiteql");
			expect(names).toContain("netsuite_get_metadata");
			expect(names).toContain("netsuite_get_record");
			expect(names).toContain("netsuite_get_script_logs");
			expect(names).toContain("netsuite_get_system_notes");
			expect(names).toContain("netsuite_upload_file");
			expect(names).toContain("netsuite_status");
			expect(names).toContain("netsuite_auth");
			expect(names).toContain("netsuite_call_official");
			expect(names).not.toContain("netsuite_create_record");
			expect(names).not.toContain("netsuite_update_record");
			expect(names.length).toBe(9);
		});

		it("should list 11 authoritative tools in Sandbox environment", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1"); // Sandbox
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const names = result.tools.map((t: any) => t.name);

			expect(names).toContain("netsuite_run_suiteql");
			expect(names).toContain("netsuite_get_metadata");
			expect(names).toContain("netsuite_get_record");
			expect(names).toContain("netsuite_get_script_logs");
			expect(names).toContain("netsuite_get_system_notes");
			expect(names).toContain("netsuite_upload_file");
			expect(names).toContain("netsuite_status");
			expect(names).toContain("netsuite_auth");
			expect(names).toContain("netsuite_call_official");
			expect(names).toContain("netsuite_create_record");
			expect(names).toContain("netsuite_update_record");
			expect(names.length).toBe(11);
		});

		it("should attach standard MCP annotations to tools", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const getRecordTool = result.tools.find(
				(t: any) => t.name === "netsuite_get_record",
			);
			const uploadTool = result.tools.find(
				(t: any) => t.name === "netsuite_upload_file",
			);
			const createRecordTool = result.tools.find(
				(t: any) => t.name === "netsuite_create_record",
			);
			const updateRecordTool = result.tools.find(
				(t: any) => t.name === "netsuite_update_record",
			);

			expect(getRecordTool?.annotations).toEqual({
				readOnlyHint: true,
				idempotentHint: true,
			});
			expect(uploadTool?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
			});
			expect(createRecordTool?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
			});
			expect(updateRecordTool?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
			});
		});

		it("should block netsuite_create_record and netsuite_update_record in Production", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916"); // Production
			const callFn = registeredHandlers.get("tools/call");

			const createRes = await callFn?.({
				params: {
					name: "netsuite_create_record",
					arguments: {
						recordType: "customer",
						record: { companyName: "100101-NVC Lighting Japan株式会社" },
					},
				},
			});
			expect(createRes.isError).toBe(true);
			expect(createRes.content[0].text).toContain(
				"⛔ [Production Safety Violation]",
			);

			const updateRes = await callFn?.({
				params: {
					name: "netsuite_update_record",
					arguments: {
						recordType: "customer",
						id: "166",
						record: { companyName: "100101-NVC Lighting Japan株式会社" },
					},
				},
			});
			expect(updateRes.isError).toBe(true);
			expect(updateRes.content[0].text).toContain(
				"⛔ [Production Safety Violation]",
			);
		});

		it("should allow netsuite_create_record in Sandbox environment and append UI link", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1"); // Sandbox
			mockMCPTools.executeTool.mockResolvedValueOnce({
				id: 501,
				entityid: "CUST501",
			});
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_create_record",
					arguments: {
						recordType: "customer",
						record: { companyname: "New Corp" },
					},
				},
			});

			expect(res.isError).toBeFalsy();
			expect(res.content[0].text).toContain(
				"✅ NetSuite Record Created: `customer` (ID: `501`)",
			);
			expect(res.content[0].text).toContain("app.netsuite.com");
		});

		it("should handle netsuite_create_record when id is a string", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1"); // Sandbox
			mockMCPTools.executeTool.mockResolvedValueOnce({
				id: "502",
				entityid: "CUST502",
			});
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_create_record",
					arguments: {
						recordType: "customer",
						record: { companyname: "Another Corp" },
					},
				},
			});

			expect(res.isError).toBeFalsy();
			expect(res.content[0].text).toContain(
				"✅ NetSuite Record Created: `customer` (ID: `502`)",
			);
			expect(res.content[0].text).toContain("app.netsuite.com");
		});

		it("should allow netsuite_update_record in Sandbox environment and resolve natural keys", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1"); // Sandbox
			mockMCPTools.executeTool.mockImplementation(
				async (toolName: string, args: any) => {
					if (toolName === "ns_runCustomSuiteQL") {
						return {
							data: [{ id: "777", type: "salesorder", tranid: "SO10099" }],
						};
					}
					if (toolName === "ns_updateRecord") {
						return { id: args.recordId, tranid: "SO10099", memo: "Updated" };
					}
					return {};
				},
			);
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_update_record",
					arguments: {
						recordType: "salesorder",
						id: "SO10099",
						memo: "Updated",
					},
				},
			});

			expect(res.isError).toBeFalsy();
			expect(res.content[0].text).toContain(
				"✅ NetSuite Record Updated: `salesorder` (ID: `777`)",
			);
			expect(res.content[0].text).toContain("app.netsuite.com");
		});

		it("should allow mutation tools via netsuite_call_official in Sandbox environment", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1"); // Sandbox
			mockMCPTools.executeTool.mockResolvedValueOnce({
				id: "999",
				entityid: "CUST999",
			});
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_call_official",
					arguments: {
						action: "call",
						toolName: "ns_createRecord",
						parameters: {
							recordType: "customer",
							record: { companyname: "Sandbox Official Corp" },
						},
					},
				},
			});

			expect(res.isError).toBeFalsy();
			expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_createRecord", {
				recordType: "customer",
				record: { companyname: "Sandbox Official Corp" },
			});
		});

		it("should block mutation tools via netsuite_call_official in Production environment", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("5848789"); // Production
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_call_official",
					arguments: {
						action: "call",
						toolName: "ns_createRecord",
						parameters: {
							recordType: "customer",
							record: { companyname: "Prod Official Corp" },
						},
					},
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("[Production Safety Violation]");
			expect(res.content[0].text).toContain("5848789");
		});

		it("should include environment suffix in tool descriptions", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const runSqlTool = result.tools.find(
				(t: any) => t.name === "netsuite_run_suiteql",
			);
			expect(runSqlTool?.description).toContain("9260916");
		});

		it("should reject unknown tools on tools/call", async () => {
			const callFn = registeredHandlers.get("tools/call");
			const res = await callFn?.({
				params: {
					name: "ns_unknown_tool",
					arguments: { recordType: "customer" },
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("Unknown tool: 'ns_unknown_tool'");
		});

		it("should require allowProduction for file upload in Production", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916"); // Production
			const callFn = registeredHandlers.get("tools/call");

			const dummy = path.join(testRoot, "dummy.js");
			await fs.writeFile(dummy, "console.log(1);");

			const res = await callFn?.({
				params: {
					name: "netsuite_upload_file",
					arguments: { paths: dummy, projectPath: testRoot },
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("生产环境安全拦截");
		});

		it("should require authentication for protected tools when session is invalid", async () => {
			mockOAuthManager.hasValidSession.mockResolvedValue(false);
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_get_record",
					arguments: { recordType: "customer", id: "166" },
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("Not authenticated");
		});

		it("should delegate tool execution to mcpTools.executeTool", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_get_record",
					arguments: { recordType: "customer", id: "166" },
				},
			});

			expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
				recordType: "customer",
				recordId: "166",
			});
			expect(res.content[0].text).toContain(
				"100101-NVC Lighting Japan株式会社",
			);
		});

		it("should query table metadata for customrecord in netsuite_get_metadata", async () => {
			const callFn = registeredHandlers.get("tools/call");

			await callFn?.({
				params: {
					name: "netsuite_get_metadata",
					arguments: { table: "customrecord_special" },
				},
			});

			expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
				"ns_getSuiteQLMetadata",
				expect.objectContaining({
					recordType: "customrecord_special",
				}),
			);
		});

		it("should resolve custom record string rectype in netsuite_run_suiteql", async () => {
			const callFn = registeredHandlers.get("tools/call");

			await callFn?.({
				params: {
					name: "netsuite_run_suiteql",
					arguments: {
						sqlQuery: "SELECT id FROM customrecord_etissl_carrier",
						customRecordMappings: [
							{
								rectype: "customrecord_etissl_carrier",
								scriptId: "customrecord_etissl_carrier",
							},
						],
					},
				},
			});

			expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
				"ns_runCustomSuiteQL",
				{
					sqlQuery: "SELECT id FROM customrecord_etissl_carrier",
					customRecordMappings: [
						{
							rectype: 54,
							scriptId: "customrecord_etissl_carrier",
						},
					],
				},
			);
		});

		it("should return hard stop error without self-healing advice on record permission failure payload", async () => {
			const callFn = registeredHandlers.get("tools/call");

			mockMCPTools.executeTool.mockResolvedValueOnce({
				success: false,
				error:
					"INSUFFICIENT_PERMISSION: You do not have permission to view this record",
			});

			const res = await callFn?.({
				params: {
					name: "netsuite_get_record",
					arguments: { recordType: "customer", id: "101" },
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("NetSuite Permission Error");
			expect(res.content[0].text).toContain(
				"PERMISSION DENIED — HARD STOP REQUIRED",
			);
			expect(res.content[0].text).toContain("STOP ALL TASKS IMMEDIATELY");
			expect(res.content[0].text).not.toContain("Self-Healing Action");
		});

		it("should return hard stop error without self-healing advice when SuiteQL throws permission error", async () => {
			const callFn = registeredHandlers.get("tools/call");

			mockMCPTools.executeTool.mockRejectedValueOnce(
				new Error(
					"NetSuite API Error: [USER_ERROR] Permission Violation: You need the 'Lists -> Customers' permission",
				),
			);

			const res = await callFn?.({
				params: {
					name: "netsuite_run_suiteql",
					arguments: { sqlQuery: "SELECT id FROM customer" },
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain(
				"PERMISSION DENIED — HARD STOP REQUIRED",
			);
			expect(res.content[0].text).toContain("STOP ALL TASKS IMMEDIATELY");
			expect(res.content[0].text).not.toContain("Self-Healing Action");
		});

		it("should throw error when custom record rectype cannot be resolved", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_run_suiteql",
					arguments: {
						sqlQuery: "SELECT id FROM customrecord_unknown",
						customRecordMappings: [
							{
								rectype: "customrecord_unknown",
								scriptId: "customrecord_unknown",
							},
						],
					},
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("Could not resolve rectype ID");
		});

		it("should provide rich tool descriptions and input schemas for netsuite_run_suiteql and netsuite_get_metadata", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1");
			const listFn = registeredHandlers.get("tools/list");
			const result = await listFn?.();
			const suiteqlTool = result.tools.find(
				(t: any) => t.name === "netsuite_run_suiteql",
			);
			const metaTool = result.tools.find(
				(t: any) => t.name === "netsuite_get_metadata",
			);

			expect(suiteqlTool.description).toContain("SuiteQL queries");
			expect(suiteqlTool.inputSchema.properties.sqlQuery.description).toContain(
				"The SuiteQL query string to execute",
			);

			expect(metaTool.description).toContain(
				"Inspect NetSuite database table schema",
			);
			expect(metaTool.inputSchema.properties.keyword).toBeDefined();
		});

		it("should return fast table catalog discovery when netsuite_get_metadata has no table", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_get_metadata",
					arguments: {},
				},
			});

			expect(mockMCPTools.executeTool).not.toHaveBeenCalledWith(
				"ns_getSuiteQLMetadata",
				expect.anything(),
			);
			expect(res.content[0].text).toContain(
				"### 📚 NetSuite SuiteQL Universal Table Catalog",
			);
			expect(res.content[0].text).toContain("`aggregateitemlocation`");
			expect(res.content[0].text).toContain("`transaction`");
		});

		it("should return filtered table catalog when netsuite_get_metadata is called with keyword", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_get_metadata",
					arguments: { keyword: "inventory" },
				},
			});

			expect(mockMCPTools.executeTool).not.toHaveBeenCalledWith(
				"ns_getSuiteQLMetadata",
				expect.anything(),
			);
			expect(res.content[0].text).toContain(
				'### 🔍 NetSuite SuiteQL Table Catalog (Matches for "inventory"',
			);
			expect(res.content[0].text).toContain("`aggregateitemlocation`");
		});

		it("should return rich diagnostic error on SuiteQL schema failure", async () => {
			const callFn = registeredHandlers.get("tools/call");

			mockMCPTools.executeTool.mockRejectedValueOnce(
				new Error(
					"SuiteQL query execution failed: Unknown identifier 'createdfrom'",
				),
			);

			const res = await callFn?.({
				params: {
					name: "netsuite_run_suiteql",
					arguments: {
						sqlQuery:
							"SELECT id, createdfrom FROM transactionline WHERE id = 1 AND mainline = 'F'",
					},
				},
			});

			expect(res.isError).toBe(true);
			expect(res.content[0].text).toContain("❌ **SuiteQL Error:**");
			expect(res.content[0].text).toContain("🔍 **Diagnostic:**");
			expect(res.content[0].text).toContain("Invalid Field Location");
			expect(res.content[0].text).toContain("💡 **Suggested Pattern:**");
			expect(res.content[0].text).toContain("transactionline");
		});

		it("should handle local authentication tool call via netsuite_auth", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_auth",
					arguments: { action: "login" },
				},
			});

			expect(authCb).toHaveBeenCalled();
			expect(res.content[0].text).toContain("Authentication process initiated");
		});

		it("should handle local logout tool call via netsuite_auth", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_auth",
					arguments: { action: "logout" },
				},
			});

			expect(logoutCb).toHaveBeenCalled();
			expect(res.content[0].text).toContain("Logged out successfully");
		});

		it("should handle local status tool call", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_status",
					arguments: {},
				},
			});

			expect(res.content[0].text).toContain("netsuite-mcp");
		});

		describe("netsuite_get_script_logs tool", () => {
			it("should generate default query with no filters", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [
						{
							date: "2026-08-01",
							type: "ERROR",
							title: "Test Error",
							detail: "Something failed",
							scriptScriptId: "customscript_test",
							scriptName: "Test Script",
						},
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: { format: "compact_json" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining(
							"FROM ScriptNote AS sn LEFT JOIN Script AS s ON sn.scripttype = s.id",
						),
					}),
				);

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.totalResults).toBe(1);
				expect(parsed.data[0].type).toBe("ERROR");
				// Default limit should be 50
				expect(parsed.query).toContain("FETCH FIRST 50 ROWS ONLY");
				// SAFE Guide performance optimization: partition pruning defaults to last 7 days
				expect(parsed.query).toContain("sn.date >= SYSDATE - 7");
			});

			it("should format script logs as compact markdown table by default", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [
						{
							date: "2026-08-01 12:00:00",
							type: "ERROR",
							title: "Test Error",
							detail: "Something failed",
							scriptScriptId: "customscript_test",
							scriptName: "Test Script",
						},
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: {},
					},
				});

				expect(res.content[0].text).toContain(
					"## 📜 SuiteScript Execution Logs (1 entries)",
				);
				expect(res.content[0].text).toContain(
					"| Date | Type | Script | Title | Detail |",
				);
				expect(res.content[0].text).toContain("Test Error");
			});

			it("should generate query with all filters applied", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({ data: [] });

				await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: {
							scriptId: "customscript_my_ue",
							type: "ERROR",
							dateFrom: "2026-07-01",
							dateTo: "2026-07-31",
							title: "timeout",
							detail: "exceeded",
							deploymentId: "customdeploy_my_ue",
							limit: 100,
						},
					},
				});

				const sqlArg = mockMCPTools.executeTool.mock.calls[0][1]
					.sqlQuery as string;
				expect(sqlArg).toContain(
					"SELECT TO_CHAR(sn.date, 'YYYY-MM-DD HH24:MI:SS') AS date",
				);
				expect(sqlArg).toContain(
					"LEFT JOIN Script AS s ON sn.scripttype = s.id",
				);
				expect(sqlArg).toContain(
					"sn.scripttype = (SELECT s_sub.id FROM Script s_sub WHERE UPPER(s_sub.scriptid) = 'CUSTOMSCRIPT_MY_UE' FETCH FIRST 1 ROWS ONLY)",
				);
				expect(sqlArg).toContain(
					"sn.scripttype IN (SELECT sd.script FROM ScriptDeployment sd WHERE UPPER(sd.scriptid) = 'CUSTOMDEPLOY_MY_UE')",
				);
				expect(sqlArg).toContain("sn.type = 'ERROR'");
				expect(sqlArg).toContain("TO_DATE('2026-07-01', 'YYYY-MM-DD')");
				expect(sqlArg).toContain("TO_DATE('2026-07-31', 'YYYY-MM-DD') + 1");
				expect(sqlArg).toContain("UPPER(sn.title) LIKE UPPER('%timeout%')");
				expect(sqlArg).toContain("UPPER(sn.detail) LIKE UPPER('%exceeded%')");
				expect(sqlArg).toContain("FETCH FIRST 100 ROWS ONLY");
			});

			it("should filter logs by recordType via ScriptDeployment", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({ data: [] });

				await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: {
							recordType: "salesorder",
						},
					},
				});

				const sqlArg = mockMCPTools.executeTool.mock.calls[0][1]
					.sqlQuery as string;
				expect(sqlArg).toContain(
					"sn.scripttype IN (SELECT sd_sub.script FROM ScriptDeployment sd_sub WHERE UPPER(sd_sub.recordtype) = 'SALESORDER')",
				);
			});

			it("should reject invalid date format", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: { dateFrom: "01-07-2026" },
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Invalid dateFrom format");
			});

			it("should reject invalid log type", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: { type: "WARN" },
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Invalid option");
			});

			it("should cap limit at 200", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({ data: [] });

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: { limit: 500, format: "compact_json" },
					},
				});

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.query).toContain("FETCH FIRST 200 ROWS ONLY");
			});

			it("should return error with permission tip when ScriptNote table is not found", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({
					content: [
						{
							type: "text",
							text: '{"error":"Error executing SuiteQL query: Search error occurred: Record \'ScriptNote\' was not found."}',
						},
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: {},
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("ADMI_CUSTOMSCRIPT");
				expect(res.content[0].text).toContain("SuiteScript");
			});

			it("should return error when SuiteQL execution fails", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockRejectedValueOnce(
					new Error("SuiteQL query failed: invalid table"),
				);

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: {},
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Failed to query script logs");
			});
		});

		describe("Developer Tools Wiring", () => {
			it("should handle netsuite_get_metadata with source: 'offline' for standard record definitions", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const res = await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: { table: "salesorder", source: "offline" },
					},
				});

				expect(res.content[0].text).toContain("Official Records Definition");
			});

			it("should handle netsuite_get_metadata tool with standard table in auto mode", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const res = await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: { table: "salesorder" },
					},
				});

				expect(res.content[0].text).toContain("Official Records Definition");
				expect(res.content[0].text).toContain("salesorder");
			});

			it("should handle netsuite_get_metadata table catalog discovery when table is omitted", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const res = await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: { keyword: "transaction" },
					},
				});

				expect(res.content[0].text).toContain("NetSuite SuiteQL Table Catalog");
				expect(res.content[0].text).toContain("transaction");
			});

			it("should handle netsuite_get_metadata with explicit offline source", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const res = await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: { table: "customer", source: "offline" },
					},
				});

				expect(res.content[0].text).toContain("Official Records Definition");
				expect(res.content[0].text).toContain("customer");
			});

			it("should handle miss-driven metadata inspection for unknown keyword on standard table", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					metadata: {
						type: "object",
						properties: {
							id: { type: "integer", title: "Internal ID" },
							item: { type: "integer", title: "Item" },
						},
					},
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: { table: "transactionline", keyword: "accrual" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_getSuiteQLMetadata",
					{
						recordType: "transactionline",
					},
				);
				expect(res.content[0].text).toContain("Real-Time Synchronized");
				expect(res.content[0].text).toContain("accrual");
			});

			it("should reject grouped query with BUILTIN.DF via pre-flight AST validation without network call", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockClear();

				const res = await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQuery:
								"SELECT ir.id, BUILTIN.DF(ir.entity) as vendor, COUNT(ir.id) as cnt FROM transaction ir WHERE ir.id = 123 GROUP BY ir.id, ir.entity",
						},
					},
				});

				expect(mockMCPTools.executeTool).not.toHaveBeenCalled();
				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain(
					"Unsupported 'BUILTIN.DF()' in Grouped Query",
				);
				expect(res.content[0].text).toContain("Common Table Expression (CTE)");
			});

			it("should diagnose error properly when sqlQueries array is used in netsuite_run_suiteql", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockRejectedValueOnce(
					new Error(
						"Search error occurred: Unknown identifier 'islotnumbered'",
					),
				);

				const res = await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: ["SELECT id, islotnumbered FROM item WHERE id = 100"],
						},
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain(
					"Unknown Field/Column: 'islotnumbered'",
				);
				expect(res.content[0].text).toContain(
					"Complete Official Data Structure for table 'item'",
				);
			});

			it("should handle netsuite_get_record successfully with full line details by default", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "12345",
					tranid: "SO1002",
					trandate: "2026-03-01",
					custbody_test_flag: "T",
					item: [{ item: "100", quantity: 2, custcol_test_col: "abc" }],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: { recordType: "salesorder", id: "12345" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
					recordType: "salesorder",
					recordId: "12345",
				});
				expect(res.content[0].text).toContain("NetSuite Record Inspection");
				expect(res.content[0].text).toContain("custbody_test_flag");
				expect(res.content[0].text).toContain("Sublists & Line Details");
				expect(res.content[0].text).toContain("custcol_test_col");
			});

			it("should compact unchecked false flags into compact inline lists", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "12345",
					tranid: "SO1002",
					isInactive: false,
					shipComplete: "F",
					custbody_active_flag: true,
					custbody_unchecked_1: false,
					custbody_unchecked_2: "F",
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: { recordType: "salesorder", id: "12345" },
					},
				});

				const text = res.content[0].text;
				// Active fields remain in table
				expect(text).toContain("| `custbody_active_flag` | true |");
				expect(text).toContain("| `tranid` | SO1002 |");
				// False flags are compacted into inline summaries
				expect(text).toContain("Unchecked / False Flags");
				expect(text).toContain("`isInactive`, `shipComplete`");
				expect(text).toContain(
					"`custbody_unchecked_1`, `custbody_unchecked_2`",
				);
			});

			it("should normalize id to recordId for netsuite_get_record", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "99887",
					tranid: "SO1003",
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: { recordType: "salesorder", id: "99887" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
					recordType: "salesorder",
					recordId: "99887",
				});
				expect(res.content[0].text).toContain("NetSuite Record Inspection");
			});

			it("should unwrap nested Arguments and resolve tranid for netsuite_get_record", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [{ id: "9028600", type: "itemreceipt" }],
				});
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "9028600",
					tranid: "IR-ZH-202609-000001",
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							Arguments: {
								recordType: "itemreceipt",
								id: "IR-ZH-202609-000001",
							},
						},
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
					recordType: "itemreceipt",
					recordId: "9028600",
				});
				expect(res.content[0].text).toContain("NetSuite Record Inspection");
			});

			it("should support format: compact_json and return full line items without omission by default", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "12345",
					tranid: "SO1002",
					emptyField: null,
					emptyString: "",
					custbody_order_type: "online",
					item: [
						{ item: "100", quantity: 2, custcol_test_col: "abc" },
						{ item: "101", quantity: 1, custcol_test_col: "def" },
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "12345",
							format: "compact_json",
						},
					},
				});

				expect(res.isError).toBeUndefined();
				const parsed = JSON.parse(res.content[0].text.split("\n\n---\n")[0]);
				expect(parsed.recordType).toBe("salesorder");
				expect(parsed.recordId).toBe("12345");
				expect(parsed.systemFields.tranid).toBe("SO1002");
				expect(parsed.systemFields.emptyField).toBeUndefined();
				expect(parsed.customFields.custbody_order_type).toBe("online");
				expect(parsed.sublists.item).toHaveLength(2);
				expect(parsed.sublists.item[0].item).toBe("100");
				expect(parsed.sublists.item[1].item).toBe("101");
			});

			it("should preserve false and 'F' boolean flags in compact_json mode", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "999",
					isinactive: false,
					isclosed: "F",
					custbody_approved: false,
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "999",
							format: "compact_json",
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text.split("\n\n---\n")[0]);
				expect(parsed.systemFields.isinactive).toBe(false);
				expect(parsed.systemFields.isclosed).toBe("F");
				expect(parsed.customFields.custbody_approved).toBe(false);
				expect(parsed.uncheckedFlags.system).toContain("isinactive");
				expect(parsed.uncheckedFlags.system).toContain("isclosed");
				expect(parsed.uncheckedFlags.custom).toContain("custbody_approved");
			});

			it("should indicate total lines and truncation status in markdown sublists", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "123",
					item: [
						{ item: "1", quantity: 10 },
						{ item: "2", quantity: 20 },
						{ item: "3", quantity: 30 },
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "123",
							maxLines: 1,
						},
					},
				});

				expect(res.content[0].text).toContain(
					"Showing 1 of 3 lines — TRUNCATED",
				);
			});

			it("should support linesMode: summary when explicitly requested", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "12345",
					tranid: "SO1002",
					item: [
						{ item: "100", quantity: 2 },
						{ item: "101", quantity: 1 },
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "12345",
							format: "compact_json",
							linesMode: "summary",
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text.split("\n\n---\n")[0]);
				expect(parsed.sublists).toBeUndefined();
				expect(parsed.sublistsSummary.item.count).toBe(2);
			});

			it("should support maxLines and lineFields when specified", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "12345",
					tranid: "SO1002",
					item: [
						{ item: "100", quantity: 2, rate: 50, amount: 100 },
						{ item: "101", quantity: 1, rate: 30, amount: 30 },
						{ item: "102", quantity: 5, rate: 10, amount: 50 },
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "12345",
							format: "compact_json",
							maxLines: 2,
							lineFields: ["item", "quantity", "amount"],
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text.split("\n\n---\n")[0]);
				expect(parsed.sublists.item).toHaveLength(2);
				expect(parsed.sublists.item[0]).toEqual({
					item: "100",
					quantity: 2,
					amount: 100,
				});
				expect(parsed.sublists.item[0].rate).toBeUndefined(); // filtered by lineFields
			});

			it("should auto-resolve non-numeric document number tranid for netsuite_get_record", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [{ id: "55555", type: "salesorder" }],
				});

				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "55555",
					tranid: "SO9876",
					total: 100,
				});

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "SO9876",
						},
					},
				})) as any;

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining("UPPER(tranid) = 'SO9876'"),
					}),
				);
				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_getRecord",
					expect.objectContaining({
						recordId: "55555",
					}),
				);
				expect(res.isError).toBeFalsy();
			});

			it("should return not found error when tranid resolution yields no records", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({ data: [] });

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "NON_EXISTENT_DOC",
						},
					},
				})) as any;

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Record Not Found");
				expect(res.content[0].text).toContain("NON_EXISTENT_DOC");
			});

			it("should auto-resolve scriptdeployment natural key customdeploy_xxx and append scriptdeployment.nl UI link", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916-sb1");

				// 1. Natural key lookup via SuiteQL
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [{ id: "4", scriptid: "customdeploy_my_ue" }],
				});

				// 2. Record get
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "4",
					scriptid: "customdeploy_my_ue",
					status: "RELEASED",
				});

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "scriptdeployment",
							id: "customdeploy_my_ue",
						},
					},
				})) as any;

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining("FROM ScriptDeployment"),
					}),
				);
				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain(
					"https://9260916-sb1.app.netsuite.com/app/common/scripting/scriptdeployment.nl?id=4",
				);
			});

			it("should auto-resolve script natural key customscript_xxx and append script.nl UI link", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916-sb1");

				// 1. Natural key lookup via SuiteQL
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [{ id: "5", scriptid: "customscript_my_ue" }],
				});

				// 2. Record get
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "5",
					scriptid: "customscript_my_ue",
					name: "My UE Script",
				});

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "script",
							id: "customscript_my_ue",
						},
					},
				})) as any;

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining("FROM Script"),
					}),
				);
				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain(
					"https://9260916-sb1.app.netsuite.com/app/common/scripting/script.nl?id=5",
				);
			});

			it("should transparently fall back to offline catalog when remote metadata fails", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockRejectedValueOnce(
					new Error(
						"NetSuite API error: Record type 'salesorder' not supported in REST",
					),
				);

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: { table: "salesorder" },
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain("Offline Catalog");
				expect(res.content[0].text).toContain("salesorder");
			});

			it("should inspect offline metadata for core view transactionaccountingline and billingrevenueevent", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const resTal = (await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: {
							table: "transactionaccountingline",
							source: "offline",
						},
					},
				})) as any;

				expect(resTal.isError).toBeFalsy();
				expect(resTal.content[0].text).toContain("transactionaccountingline");
				expect(resTal.content[0].text).toContain("account");
				expect(resTal.content[0].text).toContain("Key Relationships");

				const resBre = (await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: {
							table: "billingrevenueevent",
							source: "offline",
						},
					},
				})) as any;

				expect(resBre.isError).toBeFalsy();
				expect(resBre.content[0].text).toContain("billingrevenueevent");
				expect(resBre.content[0].text).toContain("revenueelement");
			});

			it("should execute SuiteQL query as-is without auto-rewriting", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [{ id: "1" }],
				});

				await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQuery: "SELECT id FROM customer FETCH FIRST 10 ROWS ONLY",
						},
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: "SELECT id FROM customer FETCH FIRST 10 ROWS ONLY",
					}),
				);
			});

			it("should execute multiple semicolon-separated queries in parallel in netsuite_run_suiteql", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockImplementation(
					async (_name: string, args: any) => {
						if (args.sqlQuery.includes("transaction")) {
							return { data: [{ id: "101", tranid: "SO1001" }] };
						}
						if (args.sqlQuery.includes("customer")) {
							return { data: [{ id: "201", entityid: "CUST2001" }] };
						}
						return { data: [] };
					},
				);

				const res = (await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQuery:
								"SELECT id, tranid FROM transaction; SELECT id, entityid FROM customer;",
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain(
					"Parallel SuiteQL Batch Execution",
				);
				expect(res.content[0].text).toContain("SO1001");
				expect(res.content[0].text).toContain("CUST2001");
				expect(mockMCPTools.executeTool).toHaveBeenCalledTimes(2);
			});

			it("should execute sqlQueries array in parallel in netsuite_run_suiteql", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockImplementation(
					async (_name: string, args: any) => {
						if (args.sqlQuery.includes("item")) {
							return { data: [{ id: "301", itemid: "ITEM_A" }] };
						}
						if (args.sqlQuery.includes("vendor")) {
							return { data: [{ id: "401", entityid: "VEND_B" }] };
						}
						return { data: [] };
					},
				);

				const res = (await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: [
								"SELECT id, itemid FROM item",
								"SELECT id, entityid FROM vendor",
							],
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain(
					"Parallel SuiteQL Batch Execution",
				);
				expect(res.content[0].text).toContain("ITEM_A");
				expect(res.content[0].text).toContain("VEND_B");
				expect(mockMCPTools.executeTool).toHaveBeenCalledTimes(2);
			});

			it("should reject more than 10 queries in netsuite_run_suiteql", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const queries = Array.from(
					{ length: 11 },
					(_, i) => `SELECT ${i} FROM customer`,
				);

				const res = (await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: queries,
						},
					},
				})) as any;

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Batch Limit Exceeded");
			});

			it("should execute golden template via templateId and bind templateParams", async () => {
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [{ tran_id: "6257", item_id: "101", quantity: 5 }],
				});
				const callFn = registeredHandlers.get("tools/call");

				const res = (await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							templateId: "transaction_lines",
							templateParams: {
								":tranType": "'SalesOrd'",
								":tranId": "6257",
								":docNumber": "''",
							},
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining("t.type = 'SalesOrd'"),
					}),
				);
			});

			it("should reject unknown templateId with list of available templates", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const res = (await callFn?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							templateId: "non_existent_template",
						},
					},
				})) as any;

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Invalid Template ID");
				expect(res.content[0].text).toContain("transaction_lines");
			});

			it("should reject empty or missing id for netsuite_get_record without network call", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "customer",
							id: "",
						},
					},
				})) as any;

				expect(mockMCPTools.executeTool).not.toHaveBeenCalled();
				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("Invalid arguments");
			});

			it("should execute batch tables array in parallel in netsuite_get_metadata", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_metadata",
						arguments: {
							tables: ["salesorder", "customer"],
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain(
					"Parallel Metadata Batch Inspection (2 Tables)",
				);
				expect(res.content[0].text).toContain("Table #1: `salesorder`");
				expect(res.content[0].text).toContain("Table #2: `customer`");
			});

			it("should execute batch ids array in parallel in netsuite_get_record", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockImplementation(
					async (toolName: string, args: any) => {
						if (toolName === "ns_getRecord") {
							return {
								id: args.recordId,
								tranid: `SO-${args.recordId}`,
							};
						}
						return {};
					},
				);

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							ids: ["101", "102"],
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain(
					"Parallel NetSuite Record Batch Inspection: `salesorder` (2 Records)",
				);
				expect(res.content[0].text).toContain("SO-101");
				expect(res.content[0].text).toContain("SO-102");
				expect(mockMCPTools.executeTool).toHaveBeenCalledTimes(2);
			});

			it("should resolve batch natural keys using a single IN query and extract sublist header union", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockImplementation(
					async (toolName: string, args: any) => {
						if (toolName === "ns_runCustomSuiteQL") {
							return {
								data: [
									{ id: "201", type: "salesorder", tranid: "SO10023" },
									{ id: "202", type: "salesorder", tranid: "SO10024" },
								],
							};
						}
						if (toolName === "ns_getRecord") {
							return {
								id: args.recordId,
								item: [
									{ item: "ItemA", quantity: 2 },
									{ item: "ItemB", quantity: 5, discount: "10%", rate: 100 },
								],
							};
						}
						return {};
					},
				);

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							ids: ["SO10023", "SO10024"],
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				// Assert that batch resolution query was called with IN clause
				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining(
							"UPPER(tranid) IN ('SO10023', 'SO10024')",
						),
					}),
				);
				// Assert sublist header union includes discount and rate even though row 0 lacked them
				expect(res.content[0].text).toContain("discount");
				expect(res.content[0].text).toContain("rate");
			});

			it("should allow negative numeric internal IDs for netsuite_get_record", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					id: "-30",
					recordType: "transaction",
				});

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "transaction",
							id: "-30",
						},
					},
				})) as any;

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
					recordType: "transaction",
					recordId: "-30",
				});
				expect(res.isError).toBeFalsy();
				expect(res.content[0].text).toContain("-30");
			});

			it("should return compact JSON format when requested for netsuite_get_record", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const rawPayload = {
					id: "12345",
					memo: "Important order",
					emptyField: "",
					links: [{ rel: "self", href: "https://example.com" }],
				};
				mockMCPTools.executeTool.mockResolvedValueOnce(rawPayload);

				const res = (await callFn?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							id: "12345",
							format: "compact_json",
						},
					},
				})) as any;

				expect(res.isError).toBeFalsy();
				const parsed = JSON.parse(res.content[0].text.split("\n\n")[0]);
				expect(parsed.systemFields.memo).toBe("Important order");
				expect(parsed.systemFields.emptyField).toBeUndefined();
			});

			it("should handle netsuite_get_system_notes successfully", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [
						{
							date: "2026-03-01 10:00:00",
							field: "status",
							oldvalue: "Pending Approval",
							newvalue: "Pending Fulfillment",
							author_name: "Admin User",
							role_name: "Administrator",
						},
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "12345" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining("ORDER BY sn.id DESC"),
					}),
				);
				expect(res.content[0].text).toContain("System Notes Audit Trail");
				expect(res.content[0].text).toContain("Admin User");
				expect(res.content[0].text).toContain("Pending Fulfillment");
			});

			it("should inject recordtypeid = -30 when recordType is a transaction type", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [],
				});

				await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "12345", recordType: "salesorder" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining(
							"sn.recordtypeid = -30 AND sn.recordid = 12345",
						),
					}),
				);
			});

			it("should inject recordtypeid = -9 when recordType is entity and -10 when item", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool
					.mockResolvedValueOnce({ data: [] })
					.mockResolvedValueOnce({ data: [] });

				await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "100", recordType: "customer" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining(
							"sn.recordtypeid = -9 AND sn.recordid = 100",
						),
					}),
				);

				await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "200", recordType: "inventoryitem" },
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining(
							"sn.recordtypeid = -10 AND sn.recordid = 200",
						),
					}),
				);
			});

			it("should dynamically resolve custom record type ID and inject into systemnote query", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [],
				});

				await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: {
							recordId: "74043",
							recordType: "customrecord_etissl_carrier",
						},
					},
				});

				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining(
							"sn.recordtypeid = 54 AND sn.recordid = 74043",
						),
					}),
				);
			});

			it("should return error when non-numeric recordId cannot be resolved", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "SO-NONEXISTENT" },
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain(
					"could not be resolved to a numeric internal ID",
				);
			});

			it("should trigger permission hard stop when netsuite_get_system_notes encounters permission error", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool.mockResolvedValueOnce({
					isError: true,
					error: "INSUFFICIENT_PERMISSION: Permission Violation for SystemNote",
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "12345" },
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain(
					"PERMISSION DENIED — HARD STOP REQUIRED",
				);
			});

			it("should truncate long audit values to 60 characters with ellipsis", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const longValue = "A".repeat(80);
				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [
						{
							date: "2026-03-01 10:00:00",
							field: "memo",
							oldvalue: "Short",
							newvalue: longValue,
							author_name: "Admin",
							role_name: "Admin",
						},
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_get_system_notes",
						arguments: { recordId: "12345" },
					},
				});

				expect(res.content[0].text).toContain(`${"A".repeat(57)}...`);
			});

			it("should handle error summary diagnostics via netsuite_status successfully", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const res = await callFn?.({
					params: {
						name: "netsuite_status",
						arguments: { includeErrors: true },
					},
				});

				expect(res.content[0].text).toContain("NetSuite MCP");
			});

			it("should execute upload directly in sandbox without confirmation tokens", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				// Create dummy file in testRoot
				const dummyScript = path.join(testRoot, "dummy.js");
				await fs.writeFile(dummyScript, "console.log('hello');");

				const execSpy = vi
					.spyOn(suitecloudRunnerService, "executeUpload")
					.mockResolvedValueOnce({
						success: true,
						stdout: "Upload complete.",
						stderr: "",
						executionTimeMs: 120,
					});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: dummyScript,
							projectPath: testRoot,
						},
					},
				});

				expect(execSpy).toHaveBeenCalled();
				expect(res.content[0].text).toContain(
					"SuiteCloud File Upload Succeeded",
				);
				expect(res.content[0].text).toContain("9260916_SB1");
				execSpy.mockRestore();
			});

			it("should enrich successful upload with active NetSuite Web UI links for file editor, script record, deployment, and suitelet launch", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916-sb1");

				const dummyScript = path.join(testRoot, "my_suitelet.js");
				await fs.writeFile(dummyScript, "/** @NApiVersion 2.1 */");

				const execSpy = vi
					.spyOn(suitecloudRunnerService, "executeUpload")
					.mockResolvedValueOnce({
						success: true,
						stdout: "Upload complete.",
						stderr: "",
						executionTimeMs: 150,
					});

				mockMCPTools.executeTool.mockResolvedValueOnce({
					data: [
						{
							file_id: "1001",
							file_name: "my_suitelet.js",
							script_id: "2001",
							script_text_id: "customscript_my_suitelet",
							script_name: "My Suitelet Script",
							script_type: "SUITELET",
							deploy_id: "3001",
							deploy_text_id: "customdeploy_my_suitelet_dep",
							deploy_title: "My Suitelet Deployment",
						},
					],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: dummyScript,
							projectPath: testRoot,
						},
					},
				});

				expect(execSpy).toHaveBeenCalled();
				expect(res.content[0].text).toContain("快捷访问与部署链接");
				expect(res.content[0].text).toContain("edittextmediaitem.nl?id=1001");
				expect(res.content[0].text).toContain("mediaitem.nl?id=1001");
				expect(res.content[0].text).toContain("script.nl?id=2001");
				expect(res.content[0].text).toContain("scriptdeployment.nl?id=3001");
				expect(res.content[0].text).toContain(
					"scriptlet.nl?script=customscript_my_suitelet&deploy=customdeploy_my_suitelet_dep",
				);
				execSpy.mockRestore();
			});

			it("should return dry-run preview in sandbox when dryRun is true", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const dummyScript = path.join(testRoot, "dummy_dry.js");
				await fs.writeFile(dummyScript, "console.log('dry');");

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: dummyScript,
							projectPath: testRoot,
							dryRun: true,
						},
					},
				});

				expect(res.content[0].text).toContain(
					"SuiteCloud File Upload Preview (Dry Run)",
				);
				expect(res.content[0].text).toContain("SANDBOX");
			});

			it("should block upload to production without allowProduction", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916");

				const dummyScript = path.join(testRoot, "prod.js");
				await fs.writeFile(dummyScript, "console.log('prod');");

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: dummyScript,
							projectPath: testRoot,
						},
					},
				});

				expect(res.content[0].text).toContain("生产环境安全拦截");
			});

			it("should execute upload directly in production when allowProduction is true", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916");

				const dummyScript = path.join(testRoot, "prod_allow.js");
				await fs.writeFile(dummyScript, "console.log('prod');");

				const execSpy = vi
					.spyOn(suitecloudRunnerService, "executeUpload")
					.mockResolvedValueOnce({
						success: true,
						stdout: "Prod upload complete.",
						stderr: "",
						executionTimeMs: 200,
					});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: dummyScript,
							projectPath: testRoot,
							allowProduction: true,
						},
					},
				});

				expect(execSpy).toHaveBeenCalled();
				expect(res.content[0].text).toContain(
					"SuiteCloud File Upload Succeeded",
				);
				expect(res.content[0].text).toContain("9260916");
				execSpy.mockRestore();
			});

			it("should support uploading an array of paths in sandbox", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const s1 = path.join(testRoot, "s1.js");
				const s2 = path.join(testRoot, "s2.js");
				await fs.writeFile(s1, "console.log(1);");
				await fs.writeFile(s2, "console.log(2);");

				const execSpy = vi
					.spyOn(suitecloudRunnerService, "executeUpload")
					.mockResolvedValueOnce({
						success: true,
						stdout: "Batch upload complete.",
						stderr: "",
						executionTimeMs: 150,
					});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: [s1, s2],
							projectPath: testRoot,
						},
					},
				});

				expect(execSpy).toHaveBeenCalled();
				expect(res.content[0].text).toContain(
					"SuiteCloud File Upload Succeeded",
				);
				expect(res.content[0].text).toContain("成功上传文件数");
				expect(res.content[0].text).toContain("2 个文件");
				execSpy.mockRestore();
			});

			it("should block upload with pre-flight syntax error when script is malformed", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const brokenScript = path.join(testRoot, "broken.js");
				await fs.writeFile(brokenScript, "function malformed( { return;");

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: brokenScript,
							projectPath: testRoot,
						},
					},
				});

				expect(res.content[0].text).toContain("代码预检失败");
				expect(res.content[0].text).toContain("JavaScript 语法错误");
			});

			it("should bypass pre-flight syntax check when skipValidation is true", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const brokenScript = path.join(testRoot, "broken_skip.js");
				await fs.writeFile(brokenScript, "function malformed( { return;");

				const execSpy = vi
					.spyOn(suitecloudRunnerService, "executeUpload")
					.mockResolvedValueOnce({
						success: true,
						stdout: "Uploaded despite syntax.",
						stderr: "",
						executionTimeMs: 110,
					});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: brokenScript,
							projectPath: testRoot,
							skipValidation: true,
						},
					},
				});

				expect(execSpy).toHaveBeenCalled();
				expect(res.content[0].text).toContain(
					"SuiteCloud File Upload Succeeded",
				);
				execSpy.mockRestore();
			});

			it("should extract project folder and filename correctly via formatTargetFileDisplay", () => {
				const fullPath1 =
					"/Users/fuxintao/WebstormProjects/9260916/src/FileCabinet/SuiteScripts/test.js";
				expect(formatTargetFileDisplay(fullPath1)).toBe("9260916/test.js");

				const fullPath2 =
					"/Users/fuxintao/WebstormProjects/5848789_SB1/src/FileCabinet/SuiteScripts/custom/service.js";
				expect(formatTargetFileDisplay(fullPath2)).toBe(
					"5848789_SB1/service.js",
				);

				const fullPath3 = "/some/path/my_script.js";
				const projectRoot = "/Users/fuxintao/WebstormProjects/9260916";
				expect(formatTargetFileDisplay(fullPath3, projectRoot)).toBe(
					"9260916/my_script.js",
				);
			});

			it("should switch execution directory when projectPath is explicitly specified and sync external file", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const sourceProject = path.join(testRoot, "source_proj");
				const targetProject = path.join(testRoot, "target_proj");
				const sourceFile = path.join(
					sourceProject,
					"src/FileCabinet/SuiteScripts/test.js",
				);
				await fs.mkdir(path.dirname(sourceFile), { recursive: true });
				await fs.mkdir(path.join(targetProject, "src/FileCabinet"), {
					recursive: true,
				});
				await fs.writeFile(sourceFile, "console.log('external');");
				await fs.writeFile(
					path.join(targetProject, "project.json"),
					JSON.stringify({ defaultAuthId: "target-auth-sb1" }),
				);
				await fs.writeFile(
					path.join(targetProject, "manifest.xml"),
					"<manifest/>",
				);

				let executedCwd = "";
				const execSpy = vi
					.spyOn(suitecloudRunnerService, "executeUpload")
					.mockImplementation(async (projectRoot, _uploadFcPaths) => {
						executedCwd = projectRoot;
						return {
							success: true,
							stdout: "Switched upload complete.",
							stderr: "",
							executionTimeMs: 100,
						};
					});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: sourceFile,
							projectPath: targetProject,
						},
					},
				});

				expect(execSpy).toHaveBeenCalled();
				expect(executedCwd).toBe(targetProject);

				// Verify the file was synchronized to targetProject/src/FileCabinet/SuiteScripts/test.js
				const syncedTargetFile = path.join(
					targetProject,
					"src/FileCabinet/SuiteScripts/test.js",
				);
				const content = await fs.readFile(syncedTargetFile, "utf-8");
				expect(content).toBe("console.log('external');");

				expect(res.content[0].text).toContain(
					"SuiteCloud File Upload Succeeded",
				);
				execSpy.mockRestore();
			});

			it("should block upload if project defaultAuthId points to production even when session is sandbox", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const prodProject = path.join(testRoot, "prod_auth_proj");
				const prodFile = path.join(
					prodProject,
					"src/FileCabinet/SuiteScripts/test.js",
				);
				await fs.mkdir(path.dirname(prodFile), { recursive: true });
				await fs.writeFile(prodFile, "console.log('test');");
				await fs.writeFile(
					path.join(prodProject, "project.json"),
					JSON.stringify({ defaultAuthId: "9260916" }),
				);

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: prodFile,
							projectPath: prodProject,
						},
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("生产环境安全拦截");
				expect(res.content[0].text).toContain("指向**生产环境**");
			});

			it("should block directory traversal attempt in upload file cabinet path", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const traversalProject = path.join(testRoot, "traversal_proj");
				const testFile = path.join(testRoot, "secret.js");
				await fs.mkdir(path.join(traversalProject, "src/FileCabinet"), {
					recursive: true,
				});
				await fs.writeFile(testFile, "console.log('secret');");

				vi.spyOn(
					suitecloudRunnerService,
					"resolveUploadFiles",
				).mockReturnValueOnce({
					projectRoot: traversalProject,
					files: [
						{
							exists: true,
							localFullPath: testFile,
							fileCabinetPath: "/../../../etc/passwd",
							sizeBytes: 100,
							syntaxValid: true,
						},
					],
					totalBytes: 100,
					invalidCount: 0,
					missingCount: 0,
					warnings: [],
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_upload_file",
						arguments: {
							paths: testFile,
							projectPath: traversalProject,
						},
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("路径安全拦截");
			});
		});
	});

	describe("Resources Handler Wiring", () => {
		beforeEach(() => {
			registerResourceHandlers(mockServer, testRoot);
		});

		it("should register resources list and read schemas", () => {
			expect(registeredHandlers.has("resources/list")).toBe(true);
			expect(registeredHandlers.has("resources/read")).toBe(true);
		});

		it("should read the suiteql guide file content successfully", async () => {
			const readFn = registeredHandlers.get("resources/read");
			const res = await readFn?.({
				params: { uri: "netsuite://guides/suiteql" },
			});

			expect(res.contents[0].uri).toBe("netsuite://guides/suiteql");
			expect(res.contents[0].text).toContain("SuiteQL Guidelines");
		});

		it("should read golden-templates resource successfully", async () => {
			const readFn = registeredHandlers.get("resources/read");
			const res = await readFn?.({
				params: { uri: "netsuite://queries/golden-templates" },
			});

			expect(res.contents[0].uri).toBe("netsuite://queries/golden-templates");
			expect(res.contents[0].text).toContain(
				"Curated SuiteQL Query Template Library",
			);
		});

		it("should read records/reference resource successfully", async () => {
			const readFn = registeredHandlers.get("resources/read");
			const res = await readFn?.({
				params: { uri: "netsuite://records/reference" },
			});

			expect(res.contents[0].uri).toBe("netsuite://records/reference");
			expect(res.contents[0].text).toContain(
				"Official 272 Records Definition Index",
			);
		});

		it("should list standard reference resources including permissions, builtins, and governance-units", async () => {
			const listFn = registeredHandlers.get("resources/list");
			const res = await listFn?.();
			const uris = res.resources.map((r: any) => r.uri);
			expect(uris).toContain("netsuite://reference/permissions");
			expect(uris).toContain("netsuite://reference/suiteql-builtins");
			expect(uris).toContain("netsuite://safe/governance-units");
		});

		it("should read permissions reference resource successfully", async () => {
			const readFn = registeredHandlers.get("resources/read");
			const res = await readFn?.({
				params: { uri: "netsuite://reference/permissions" },
			});

			expect(res.contents[0].uri).toBe("netsuite://reference/permissions");
			expect(res.contents[0].text).toContain(
				"Official Standard Permissions Matrix",
			);
			expect(res.contents[0].text).toContain("TRAN_SALESORD");
			expect(res.contents[0].text).toContain(
				"403 Permission Denied Self-Healing Diagnostic",
			);
		});

		it("should read suiteql-builtins resource successfully", async () => {
			const readFn = registeredHandlers.get("resources/read");
			const res = await readFn?.({
				params: { uri: "netsuite://reference/suiteql-builtins" },
			});

			expect(res.contents[0].uri).toBe("netsuite://reference/suiteql-builtins");
			expect(res.contents[0].text).toContain("BUILTIN.DF");
			expect(res.contents[0].text).toContain("BUILTIN.CONSOLIDATE");
			expect(res.contents[0].text).toContain("SAFE Pitfalls");
		});

		it("should read governance-units resource successfully", async () => {
			const readFn = registeredHandlers.get("resources/read");
			const res = await readFn?.({
				params: { uri: "netsuite://safe/governance-units" },
			});

			expect(res.contents[0].uri).toBe("netsuite://safe/governance-units");
			expect(res.contents[0].text).toContain("Script Type Governance Limits");
			expect(res.contents[0].text).toContain("SAFE-GOV-001");
		});
	});
});
