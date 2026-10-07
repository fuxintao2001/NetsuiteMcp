import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { suitecloudRunnerService } from "../utils/suitecloudRunner.js";
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

		it("should list the 8 authoritative tools", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const names = result.tools.map((t: any) => t.name);

			expect(names).toContain("netsuite_run_suiteql");
			expect(names).toContain("netsuite_get_metadata");
			expect(names).toContain("netsuite_get_record");
			expect(names).toContain("netsuite_get_script_logs");
			expect(names).toContain("netsuite_get_system_notes");
			expect(names).toContain("netsuite_deploy_script");
			expect(names).toContain("netsuite_status");
			expect(names).toContain("netsuite_auth");
			expect(names.length).toBe(8);
		});

		it("should attach standard MCP annotations to tools", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const getRecordTool = result.tools.find(
				(t: any) => t.name === "netsuite_get_record",
			);
			const deployTool = result.tools.find(
				(t: any) => t.name === "netsuite_deploy_script",
			);

			expect(getRecordTool?.annotations).toEqual({
				readOnlyHint: true,
				idempotentHint: true,
			});
			expect(deployTool?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
			});
		});

		it("should include environment suffix in tool descriptions", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("123456");
			const listFn = registeredHandlers.get("tools/list");

			const result = await listFn?.();
			const runSqlTool = result.tools.find(
				(t: any) => t.name === "netsuite_run_suiteql",
			);
			expect(runSqlTool?.description).toContain("123456");
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

		it("should require allowProduction for code deploy in Production", async () => {
			mockOAuthManager.getAccountId.mockResolvedValue("123456"); // Production
			const callFn = registeredHandlers.get("tools/call");

			const dummy = path.join(testRoot, "dummy.js");
			await fs.writeFile(dummy, "console.log(1);");

			const res = await callFn?.({
				params: {
					name: "netsuite_deploy_script",
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
					arguments: { recordType: "customer", id: "101" },
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
					arguments: { recordType: "customer", id: "101" },
				},
			});

			expect(mockMCPTools.executeTool).toHaveBeenCalledWith("ns_getRecord", {
				recordType: "customer",
				recordId: "101",
			});
			expect(res.content[0].text).toContain("Acme Corp");
		});

		it("should normalize table_name / tableName to recordType in netsuite_get_metadata", async () => {
			const callFn = registeredHandlers.get("tools/call");

			await callFn?.({
				params: {
					name: "netsuite_get_metadata",
					arguments: { table_name: "customrecord_special" },
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
				// SAFE Guide performance optimization: partition pruning defaults to last 7 days
				expect(parsed.query).toContain("sn.date >= SYSDATE - 7");
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
					"sn.scripttype = (SELECT s_sub.id FROM Script s_sub WHERE s_sub.scriptid = 'customscript_my_ue' FETCH FIRST 1 ROWS ONLY)",
				);
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
				expect(res.content[0].text).toContain("Invalid option");
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

			it("should normalize type, tranid, and nested Arguments for netsuite_get_record", async () => {
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
								type: "itemreceipt",
								tranid: "IR-ZH-202609-000001",
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
						sqlQuery: expect.stringContaining("WHERE tranid = 'SO9876'"),
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

			it("should handle error summary diagnostics via netsuite_status successfully", async () => {
				const callFn = registeredHandlers.get("tools/call");
				const res = await callFn?.({
					params: {
						name: "netsuite_status",
						arguments: { includeDiagnostics: true },
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
						name: "netsuite_suitecloud_upload",
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

			it("should return dry-run preview in sandbox when dryRun is true", async () => {
				const callFn = registeredHandlers.get("tools/call");
				mockOAuthManager.getAccountId.mockResolvedValueOnce("9260916_sb1");

				const dummyScript = path.join(testRoot, "dummy_dry.js");
				await fs.writeFile(dummyScript, "console.log('dry');");

				const res = await callFn?.({
					params: {
						name: "netsuite_suitecloud_upload",
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
						name: "netsuite_suitecloud_upload",
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
						name: "netsuite_suitecloud_upload",
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
						name: "netsuite_suitecloud_upload",
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
						name: "netsuite_suitecloud_upload",
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
						name: "netsuite_suitecloud_upload",
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
	});
});
