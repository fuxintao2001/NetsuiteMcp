import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerResourceHandlers } from "./resources.js";
import { registerToolHandlers } from "./tools.js";

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
			getAccountId: (vi.fn() as any).mockResolvedValue("123456_SB1"),
			hasValidSession: (vi.fn() as any).mockResolvedValue(true),
			getSessionInfo: (vi.fn() as any).mockResolvedValue({
				authenticated: true,
				accountId: "123456_SB1",
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
						id: "101",
						type: "customer",
						name: "Acme Corp",
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

		it("should list all tools when in Sandbox environment", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const names = result.tools.map((t: any) => t.name);

			expect(names).toContain("ns_createRecord");
			expect(names).toContain("ns_updateRecord");
			expect(names).toContain("ns_getRecord");
			expect(names).toContain("netsuite_get_record_link");
		});

		it("should filter out write tools when in Production environment", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("123456");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const names = result.tools.map((t: any) => t.name);

			expect(names).not.toContain("ns_createRecord");
			expect(names).not.toContain("ns_updateRecord");
			expect(names).toContain("ns_getRecord");
		});

		it("should return unauthenticated toolset when session is invalid", async () => {
			mockOAuthManager.hasValidSession.mockResolvedValue(false);
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const names = result.tools.map((t: any) => t.name);

			expect(names).toEqual([
				"netsuite_authenticate",
				"netsuite_logout",
				"netsuite_status",
			]);
		});

		it("should delegate tool execution to mcpTools.executeTool", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "ns_getRecord",
					arguments: { recordType: "customer", id: "101" },
				},
			});

			expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
				recordType: "customer",
				id: "101",
			});
			expect(res.content[0].text).toContain("Acme Corp");
		});

		it("should normalize table_name / tableName to recordType in ns_getSuiteQLMetadata", async () => {
			const callFn = registeredHandlers.get("tools/call");

			await callFn?.({
				params: {
					name: "ns_getSuiteQLMetadata",
					arguments: { table_name: "item" },
				},
			});

			expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
				"ns_getSuiteQLMetadata",
				expect.objectContaining({
					recordType: "item",
				}),
			);
		});

		it("should resolve custom record string rectype in ns_runCustomSuiteQL", async () => {
			const callFn = registeredHandlers.get("tools/call");

			await callFn?.({
				params: {
					name: "ns_runCustomSuiteQL",
					arguments: {
						sql: "SELECT * FROM customrecord_etissl_carrier",
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
					sql: "SELECT * FROM customrecord_etissl_carrier",
					customRecordMappings: [
						{
							rectype: "customrecord_etissl_carrier",
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
					name: "ns_getRecord",
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
					name: "ns_runCustomSuiteQL",
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
					name: "ns_runCustomSuiteQL",
					arguments: {
						sql: "SELECT * FROM customrecord_unknown",
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

		it("should enhance tool descriptions and input schemas for ns_runCustomSuiteQL and ns_getSuiteQLMetadata", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1");
			mockMCPTools.fetchTools.mockResolvedValueOnce([
				{
					name: "ns_runCustomSuiteQL",
					description: "Run SuiteQL queries",
					inputSchema: {
						type: "object",
						properties: {
							sqlQuery: { type: "string" },
						},
					},
				},
				{
					name: "ns_getSuiteQLMetadata",
					description: "Get metadata",
					inputSchema: {
						type: "object",
						properties: {
							recordType: { type: "string" },
						},
					},
				},
			]);

			const listFn = registeredHandlers.get("tools/list");
			const result = await listFn?.();
			const suiteqlTool = result.tools.find(
				(t: any) => t.name === "ns_runCustomSuiteQL",
			);
			const metaTool = result.tools.find(
				(t: any) => t.name === "ns_getSuiteQLMetadata",
			);

			expect(suiteqlTool.description).toContain("MANDATORY SUITEQL PROTOCOL");
			expect(suiteqlTool.inputSchema.properties.sqlQuery.description).toContain(
				"UNIVERSAL RULES",
			);

			expect(metaTool.description).toContain("Fast Table Discovery");
			expect(metaTool.inputSchema.properties.keyword).toBeDefined();
			expect(metaTool.inputSchema.properties.keyword.description).toContain(
				"search keyword",
			);
		});

		it("should return fast table catalog discovery when ns_getSuiteQLMetadata has no recordType", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "ns_getSuiteQLMetadata",
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

		it("should return filtered table catalog when ns_getSuiteQLMetadata is called with keyword", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "ns_getSuiteQLMetadata",
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
					name: "ns_runCustomSuiteQL",
					arguments: {
						sqlQuery: "SELECT id, createdfrom FROM transaction WHERE id = 1",
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

		it("should handle local authentication tool call", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_authenticate",
					arguments: {},
				},
			});

			expect(authCb).toHaveBeenCalled();
			expect(res.content[0].text).toContain("Authentication process initiated");
		});

		it("should handle local logout tool call", async () => {
			const callFn = registeredHandlers.get("tools/call");

			const res = await callFn?.({
				params: {
					name: "netsuite_logout",
					arguments: {},
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

		describe("netsuite_batch_execute tool", () => {
			it("should execute multiple tools in parallel and return partial results", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool
					.mockResolvedValueOnce({ id: "1", name: "Cust 1" })
					.mockRejectedValueOnce(new Error("Record not found"));

				const res = await callFn?.({
					params: {
						name: "netsuite_batch_execute",
						arguments: {
							tasks: [
								{
									toolName: "ns_getRecord",
									arguments: { recordType: "customer", id: "1" },
								},
								{
									toolName: "ns_getRecord",
									arguments: { recordType: "customer", id: "99" },
								},
							],
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.totalTasks).toBe(2);
				expect(parsed.successfulTasks).toBe(1);
				expect(parsed.failedTasks).toBe(1);
				expect(parsed.individualResults[0].success).toBe(true);
				expect(parsed.individualResults[1].success).toBe(false);
			});

			it("should capture permission errors in batch tasks and format with hard-stop banner", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({
					success: false,
					error: "INSUFFICIENT_PERMISSION: Permission Violation: Access Denied",
				});

				const res = await callFn?.({
					params: {
						name: "netsuite_batch_execute",
						arguments: {
							tasks: [
								{
									toolName: "ns_getRecord",
									arguments: { recordType: "invoice", id: "555" },
								},
							],
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.totalTasks).toBe(1);
				expect(parsed.successfulTasks).toBe(0);
				expect(parsed.failedTasks).toBe(1);
				expect(parsed.individualResults[0].success).toBe(false);
				expect(parsed.individualResults[0].error).toContain(
					"NetSuite Permission Error",
				);
				expect(parsed.individualResults[0].error).toContain(
					"PERMISSION DENIED — HARD STOP REQUIRED",
				);
			});

			it("should execute parallel SuiteQL queries via batch", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockMCPTools.executeTool
					.mockResolvedValueOnce({ data: [{ id: 1 }] })
					.mockResolvedValueOnce({ data: [{ id: 2 }] });

				const res = await callFn?.({
					params: {
						name: "netsuite_batch_execute",
						arguments: {
							tasks: [
								{
									toolName: "ns_runCustomSuiteQL",
									arguments: { sqlQuery: "SELECT id FROM customer" },
								},
								{
									toolName: "ns_runCustomSuiteQL",
									arguments: { sqlQuery: "SELECT id FROM transaction" },
								},
							],
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.totalTasks).toBe(2);
				expect(parsed.successfulTasks).toBe(2);
			});

			it("should execute local tools like netsuite_get_record_link within batch", async () => {
				const callFn = registeredHandlers.get("tools/call");

				const res = await callFn?.({
					params: {
						name: "netsuite_batch_execute",
						arguments: {
							tasks: [
								{
									toolName: "netsuite_get_record_link",
									arguments: { recordType: "customer", recordId: "101" },
								},
							],
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.totalTasks).toBe(1);
				expect(parsed.successfulTasks).toBe(1);
				expect(parsed.individualResults[0].result).toContain("123456_SB1");
			});

			it("should fail only write tasks in production", async () => {
				mockOAuthManager.getAccountId.mockResolvedValue("123456");
				const callFn = registeredHandlers.get("tools/call");

				const res = await callFn?.({
					params: {
						name: "netsuite_batch_execute",
						arguments: {
							tasks: [
								{
									toolName: "ns_createRecord",
									arguments: { recordType: "customer" },
								},
							],
						},
					},
				});

				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.individualResults[0].success).toBe(false);
				expect(parsed.individualResults[0].error).toContain(
					"disabled in production",
				);
			});

			it("should reject if tasks exceeds 10", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const tasks = Array.from({ length: 11 }, () => ({
					toolName: "ns_getRecord",
					arguments: {},
				}));

				const res = await callFn?.({
					params: {
						name: "netsuite_batch_execute",
						arguments: { tasks },
					},
				});

				expect(res.isError).toBe(true);
				expect(res.content[0].text).toContain("maximum limit of 10");
			});
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
						arguments: {},
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
				// No WHERE clause when no filters
				expect(parsed.query).not.toContain("WHERE");
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
					"LEFT JOIN Script AS s ON sn.scripttype = s.id",
				);
				expect(sqlArg).toContain("s.scriptid = 'customscript_my_ue'");
				expect(sqlArg).toContain(
					"sn.scripttype IN (SELECT sd.script FROM ScriptDeployment sd WHERE sd.scriptid = 'customdeploy_my_ue')",
				);
				expect(sqlArg).toContain("sn.type = 'ERROR'");
				expect(sqlArg).toContain("TO_DATE('2026-07-01', 'YYYY-MM-DD')");
				expect(sqlArg).toContain("TO_DATE('2026-07-31', 'YYYY-MM-DD') + 1");
				expect(sqlArg).toContain("UPPER(sn.title) LIKE UPPER('%timeout%')");
				expect(sqlArg).toContain("UPPER(sn.detail) LIKE UPPER('%exceeded%')");
				expect(sqlArg).toContain("FETCH FIRST 100 ROWS ONLY");
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
				expect(res.content[0].text).toContain("Invalid log type");
			});

			it("should cap limit at 200", async () => {
				const callFn = registeredHandlers.get("tools/call");

				mockMCPTools.executeTool.mockResolvedValueOnce({ data: [] });

				const res = await callFn?.({
					params: {
						name: "netsuite_get_script_logs",
						arguments: { limit: 500 },
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
	});
});
