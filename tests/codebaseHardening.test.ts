import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GetMetadataArgsSchema,
	GetRecordArgsSchema,
	GetScriptLogsArgsSchema,
	GetSystemNotesArgsSchema,
	UploadFileArgsSchema,
} from "../src/handlers/toolSchemas.js";
import { registerToolHandlers } from "../src/handlers/tools.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "../src/utils/contextSlimmer.js";
import {
	buildEnvSuffix,
	formatNetSuiteAccountHost,
	isSandboxAccount,
} from "../src/utils/environment.js";
import { ConcurrencyLimiter } from "../src/utils/resilience.js";
import { validateSuiteQL } from "../src/utils/suiteqlGuard.js";

interface ToolRepresentation {
	name: string;
	description?: string;
	annotations?: Record<string, boolean>;
}

describe("Codebase Hardening Exhaustive E2E Suite", () => {
	// =========================================================================
	// Shared Test Harness Setup
	// =========================================================================
	let mockServer: {
		setRequestHandler: ReturnType<typeof vi.fn>;
		notification: ReturnType<typeof vi.fn>;
	};
	let mockOAuthManager: {
		getAccountId: ReturnType<typeof vi.fn>;
		hasValidSession: ReturnType<typeof vi.fn>;
		getSessionInfo: ReturnType<typeof vi.fn>;
	};
	let mockMCPTools: {
		fetchTools: ReturnType<typeof vi.fn>;
		executeTool: ReturnType<typeof vi.fn>;
		customRecordMappings: Map<string, number>;
		extractDataArray: (result: unknown) => unknown[];
	};
	let registeredHandlers: Map<
		string,
		(
			request?: Record<string, unknown>,
		) => Promise<CallToolResult | { tools: ToolRepresentation[] }>
	>;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = new Map();

		mockServer = {
			setRequestHandler: vi.fn(
				(
					method: string,
					handler: (
						request?: Record<string, unknown>,
					) => Promise<CallToolResult | { tools: ToolRepresentation[] }>,
				) => {
					registeredHandlers.set(method, handler);
				},
			),
			notification: vi.fn().mockResolvedValue(undefined),
		};

		mockOAuthManager = {
			getAccountId: vi.fn().mockResolvedValue("9260916-sb1"),
			hasValidSession: vi.fn().mockResolvedValue(true),
			getSessionInfo: vi.fn().mockResolvedValue({
				authenticated: true,
				accountId: "9260916-sb1",
			}),
		};

		mockMCPTools = {
			fetchTools: vi.fn().mockResolvedValue([
				{ name: "ns_getRecord", description: "Fetch NetSuite records" },
				{ name: "ns_createRecord", description: "Create NetSuite records" },
				{ name: "ns_updateRecord", description: "Update NetSuite records" },
				{ name: "ns_runCustomSuiteQL", description: "Run SuiteQL queries" },
			]),
			executeTool: vi.fn().mockImplementation((name: string, args: unknown) => {
				const params = (args || {}) as Record<string, unknown>;

				if (name === "ns_runCustomSuiteQL") {
					const sql = String(params.sqlQuery || "");
					if (sql.includes("non_existent_table_xyz")) {
						throw new Error(
							"Table 'non_existent_table_xyz' was not found in schema",
						);
					}
					if (sql.includes("INSUFFICIENT_PERMISSION")) {
						throw new Error(
							"PERMISSION_DENIED: INSUFFICIENT_PERMISSION to access record",
						);
					}
					// Natural key resolution lookup for Sales Orders
					if (
						sql.includes("FROM transaction WHERE UPPER(tranid)") ||
						sql.includes("FROM transaction")
					) {
						if (sql.includes("SO10023")) {
							return Promise.resolve({
								data: [{ id: "98765", type: "salesorder", tranid: "SO10023" }],
							});
						}
						if (sql.includes("SO10024")) {
							return Promise.resolve({
								data: [{ id: "98766", type: "salesorder", tranid: "SO10024" }],
							});
						}
						return Promise.resolve({
							data: [{ id: "10023", type: "salesorder", tranid: "10023" }],
						});
					}
					// System note queries
					if (sql.includes("systemnote") || sql.includes("SystemNote")) {
						return Promise.resolve({
							data: [
								{
									id: "1001",
									recordid: "98765",
									field: "status",
									oldvalue: "Pending Approval",
									newvalue: "Pending Fulfillment",
									date: "2026-10-21 04:00:00",
								},
							],
						});
					}
					// Script note queries
					if (sql.includes("ScriptNote") || sql.includes("scriptnote")) {
						return Promise.resolve({
							data: [
								{
									date: "2026-10-21 04:05:00",
									type: "AUDIT",
									title: "Order Processed",
									detail: "Processed order SO10023 successfully",
									scriptScriptId: "customscript_order_sync",
									scriptName: "Order Sync Service",
								},
							],
						});
					}
					// Standard SuiteQL table rows
					return Promise.resolve({
						data: [
							{
								id: "101",
								entityid: "CUST101",
								companyname: "Acme International",
								balance: "15000.00",
							},
							{
								id: "102",
								entityid: "CUST102",
								companyname: "Beta Corp",
								balance: "0.00",
							},
						],
					});
				}

				if (name === "ns_getRecord") {
					const recId = String(params.recordId || params.id || "98765");
					const tranid =
						recId === "98765" || recId === "SO10023" ? "SO10023" : `SO${recId}`;
					return Promise.resolve({
						id: recId === "SO10023" ? "98765" : recId,
						recordType: String(params.recordType || "salesorder"),
						tranid,
						entity: { id: "101", refName: "Acme International" },
						total: 1250.5,
						memo: "Urgent shipment",
						links: [{ rel: "self", href: "https://example.netsuite.com" }],
					});
				}

				return Promise.resolve({ success: true, id: "501" });
			}),
			customRecordMappings: new Map<string, number>(),
			extractDataArray: (result: unknown): unknown[] => {
				if (!result || typeof result !== "object") return [];
				const obj = result as Record<string, unknown>;
				if (Array.isArray(obj.data)) return obj.data;
				if (Array.isArray(obj.records)) return obj.records;
				if (Array.isArray(obj.items)) return obj.items;
				return [];
			},
		};

		registerToolHandlers({
			server: mockServer as unknown as Parameters<
				typeof registerToolHandlers
			>[0]["server"],
			oauthManager: mockOAuthManager as unknown as Parameters<
				typeof registerToolHandlers
			>[0]["oauthManager"],
			mcpTools: mockMCPTools as unknown as Parameters<
				typeof registerToolHandlers
			>[0]["mcpTools"],
			projectRoot: process.cwd(),
			handleAuthentication: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Authenticated" }],
			}),
			handleLogout: vi.fn().mockResolvedValue({
				content: [{ type: "text", text: "Logged out" }],
			}),
			handleCacheRefresh: vi.fn().mockResolvedValue(undefined),
			resolveCustomRecordRectype: vi.fn().mockResolvedValue(null),
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// =========================================================================
	// Tier 1: Feature Coverage
	// =========================================================================
	describe("Tier 1: Feature Coverage", () => {
		describe("1.1 SuiteQL Dialect Guard (LIMIT / OFFSET Rejection)", () => {
			it("should reject bare MySQL/Postgres LIMIT with Oracle FETCH FIRST guidance", () => {
				const res = validateSuiteQL(
					"SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' LIMIT 10",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT/OFFSET");
				expect(res.reason).toContain("FETCH FIRST");
			});

			it("should reject comma-separated LIMIT (MySQL offset, count syntax)", () => {
				const res = validateSuiteQL(
					"SELECT id, entityid FROM customer LIMIT 20, 10;",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject LIMIT count OFFSET offset syntax", () => {
				const res = validateSuiteQL("SELECT id FROM item LIMIT 50 OFFSET 100");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject invalid standalone OFFSET lacking Oracle FETCH syntax", () => {
				const res = validateSuiteQL("SELECT id FROM customer OFFSET 10");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Invalid OFFSET syntax");
				expect(res.reason).toContain("OFFSET M ROWS FETCH NEXT N ROWS ONLY");
			});

			it("should accept compliant Oracle pagination (FETCH FIRST, ROWNUM, and OFFSET ROWS FETCH NEXT)", () => {
				const resFetch = validateSuiteQL(
					"SELECT id, companyname FROM customer FETCH FIRST 10 ROWS ONLY",
				);
				expect(resFetch.valid).toBe(true);

				const resRownum = validateSuiteQL(
					"SELECT id, tranid FROM transaction WHERE ROWNUM <= 50",
				);
				expect(resRownum.valid).toBe(true);

				const resOffset = validateSuiteQL(
					"SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY",
				);
				expect(resOffset.valid).toBe(true);
			});

			it("should not reject column aliases or identifiers named limit", () => {
				const res = validateSuiteQL(
					"SELECT id, creditlimit AS limit FROM customer FETCH FIRST 10 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});
		});

		describe("1.2 Mainline Filter Enforcement on transactionline", () => {
			it("should reject transactionline queries missing mainline filter", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.transaction = 100",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should reject joined transaction and transactionline queries missing mainline filter", () => {
				const res = validateSuiteQL(
					"SELECT t.id, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should accept transactionline queries with explicit mainline = 'T'", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.transaction = 100 AND tl.mainline = 'T'",
				);
				expect(res.valid).toBe(true);
			});

			it("should accept transactionline queries with explicit mainline = 'F'", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.transaction = 100 AND tl.mainline = 'F'",
				);
				expect(res.valid).toBe(true);
			});

			it("should accept table-aliased mainline predicate (line.mainline = 'F')", () => {
				const res = validateSuiteQL(
					"SELECT line.id, line.item FROM transactionline line WHERE line.transaction = 100 AND line.mainline = 'F'",
				);
				expect(res.valid).toBe(true);
			});
		});

		describe("1.3 SAFE Pitfall 11 SystemNote Hard Block", () => {
			it("should reject multi-table joins involving systemnote (explicit JOIN)", () => {
				const res = validateSuiteQL(
					"SELECT t.id, sn.detail FROM transaction t JOIN systemnote sn ON sn.recordid = t.id WHERE t.id = 100",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Prohibited 'JOIN SystemNote'");
			});

			it("should reject implicit comma joins involving systemnote", () => {
				const res = validateSuiteQL(
					"SELECT t.id, sn.detail FROM transaction t, systemnote sn WHERE sn.recordid = t.id AND t.id = 100",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Prohibited 'JOIN SystemNote'");
			});

			it("should reject unindexed standalone systemnote queries lacking recordid filter", () => {
				const res = validateSuiteQL(
					"SELECT id, field, oldvalue, newvalue FROM systemnote WHERE date >= SYSDATE - 1",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Unindexed 'systemnote' scan");
				expect(res.reason).toContain("netsuite_get_system_notes");
			});

			it("should accept indexed standalone systemnote queries filtered by recordid", () => {
				const res = validateSuiteQL(
					"SELECT sn.id, sn.field, sn.oldvalue, sn.newvalue FROM systemnote sn WHERE sn.recordid = 12345",
				);
				expect(res.valid).toBe(true);
			});
		});

		describe("1.4 Dual-Gate Physical Production Write Barrier", () => {
			it("Gate 1: should filter out mutation tools during tool discovery in Production", async () => {
				mockOAuthManager.getAccountId.mockResolvedValue("9260916"); // Production
				const listHandler = registeredHandlers.get("tools/list");
				expect(listHandler).toBeDefined();

				const result = (await listHandler?.()) as {
					tools: ToolRepresentation[];
				};
				const toolNames = result.tools.map((t) => t.name);

				expect(toolNames).toContain("netsuite_run_suiteql");
				expect(toolNames).toContain("netsuite_get_metadata");
				expect(toolNames).toContain("netsuite_get_record");
				expect(toolNames).toContain("netsuite_get_script_logs");
				expect(toolNames).toContain("netsuite_get_system_notes");
				expect(toolNames).toContain("netsuite_upload_file");
				expect(toolNames).toContain("netsuite_status");
				expect(toolNames).toContain("netsuite_auth");
				expect(toolNames).toContain("netsuite_call_official");

				// Mutation tools must be strictly filtered out
				expect(toolNames).not.toContain("netsuite_create_record");
				expect(toolNames).not.toContain("netsuite_update_record");
				expect(toolNames.length).toBe(9);

				// Description must include Production environment badge
				const statusTool = result.tools.find(
					(t) => t.name === "netsuite_status",
				);
				expect(statusTool?.description).toContain("Env: Production");
			});

			it("Gate 1: should expose all 11 tools during tool discovery in Sandbox", async () => {
				mockOAuthManager.getAccountId.mockResolvedValue("9260916-sb1"); // Sandbox
				const listHandler = registeredHandlers.get("tools/list");
				expect(listHandler).toBeDefined();

				const result = (await listHandler?.()) as {
					tools: ToolRepresentation[];
				};
				const toolNames = result.tools.map((t) => t.name);

				expect(toolNames).toContain("netsuite_create_record");
				expect(toolNames).toContain("netsuite_update_record");
				expect(toolNames).toContain("netsuite_call_official");
				expect(toolNames.length).toBe(11);

				const statusTool = result.tools.find(
					(t) => t.name === "netsuite_status",
				);
				expect(statusTool?.description).toContain("Env: Sandbox");
			});

			it("Gate 2: should block netsuite_create_record at runtime in Production with safety violation error", async () => {
				mockOAuthManager.getAccountId.mockResolvedValue("9260916"); // Production
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				const res = (await callHandler?.({
					params: {
						name: "netsuite_create_record",
						arguments: {
							recordType: "customer",
							record: { companyname: "Disallowed Production Customer" },
						},
					},
				})) as CallToolResult;

				expect(res.isError).toBe(true);
				const errorText =
					res.content?.find((c) => c.type === "text")?.text || "";
				expect(errorText).toContain("⛔ [Production Safety Violation]");
				expect(errorText).toContain(
					"restricted strictly to Sandbox environments",
				);
			});

			it("Gate 2: should block netsuite_update_record at runtime in Production with safety violation error", async () => {
				mockOAuthManager.getAccountId.mockResolvedValue("9260916"); // Production
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				const res = (await callHandler?.({
					params: {
						name: "netsuite_update_record",
						arguments: {
							recordType: "customer",
							id: "101",
							record: { memo: "Attempted Production Edit" },
						},
					},
				})) as CallToolResult;

				expect(res.isError).toBe(true);
				const errorText =
					res.content?.find((c) => c.type === "text")?.text || "";
				expect(errorText).toContain("⛔ [Production Safety Violation]");
			});
		});

		describe("1.5 Context Economy & High-Density Formatting (contextSlimmer)", () => {
			it("cleanRecordPayload: should recursively strip null, undefined, empty strings, and links", () => {
				const dirtyPayload = {
					id: "10023",
					tranid: "SO10023",
					memo: null,
					otherrefnum: "",
					notes: undefined,
					links: [{ rel: "self", href: "https://example.com" }],
					customer: {
						id: "101",
						companyname: "Acme Corp",
						parent: null,
						secondaryEmail: "",
					},
					lines: [
						{
							item: "Widget A",
							rate: "10.00",
							taxCode: null,
							memo: "",
						},
						{
							taxCode: null,
							memo: "",
						},
					],
				};

				const cleaned = cleanRecordPayload(dirtyPayload) as Record<
					string,
					unknown
				>;

				expect(cleaned.id).toBe("10023");
				expect(cleaned.tranid).toBe("SO10023");
				expect(cleaned).not.toHaveProperty("memo");
				expect(cleaned).not.toHaveProperty("otherrefnum");
				expect(cleaned).not.toHaveProperty("notes");
				expect(cleaned).not.toHaveProperty("links");

				const customer = cleaned.customer as Record<string, unknown>;
				expect(customer.companyname).toBe("Acme Corp");
				expect(customer).not.toHaveProperty("parent");
				expect(customer).not.toHaveProperty("secondaryEmail");

				const lines = cleaned.lines as Array<Record<string, unknown>>;
				expect(lines.length).toBe(1);
				expect(lines[0]?.item).toBe("Widget A");
				expect(lines[0]).not.toHaveProperty("taxCode");
			});

			it("cleanRecordPayload: should fall back to empty object/array when everything is stripped", () => {
				expect(cleanRecordPayload({ a: null, b: "", c: undefined })).toEqual(
					{},
				);
				expect(cleanRecordPayload([{ a: null }, { b: "" }])).toEqual([]);
				expect(cleanRecordPayload(["", null, undefined])).toEqual([]);
				expect(cleanRecordPayload({ a: { b: "" }, c: ["", "val"] })).toEqual({
					c: ["val"],
				});
			});

			it("formatSuiteQLToCompactMarkdown: should convert row arrays into high-density Markdown tables with >= 50% byte reduction", () => {
				// Typical ERP multi-column response with nulls, links, and repeated keys
				const rawRows = Array.from({ length: 15 }, (_, i) => ({
					id: String(1000 + i),
					tranid: `SO${1000 + i}`,
					entity: `Customer ${i}`,
					trandate: "2026-10-21",
					amount: "1500.00",
					memo: null,
					status: "Pending Approval",
					department: null,
					class: null,
					location: "Main Warehouse",
					createdby: "System",
					links: [{ rel: "self", href: `https://example.com/record/${i}` }],
				}));

				const rawJson = JSON.stringify(
					{ data: rawRows, success: true },
					null,
					2,
				);
				const markdownTable = formatSuiteQLToCompactMarkdown(rawRows);

				expect(markdownTable).toContain("| id | tranid | entity | trandate |");
				expect(markdownTable).toContain("| 1000 | SO1000 | Customer 0 |");

				const rawBytes = Buffer.byteLength(rawJson, "utf8");
				const mdBytes = Buffer.byteLength(markdownTable, "utf8");
				const reduction = (rawBytes - mdBytes) / rawBytes;

				// Verify context economy satisfies requirement (>= 50% byte/token reduction)
				expect(reduction).toBeGreaterThanOrEqual(0.5);
			});

			it("formatSuiteQLToCompactMarkdown: should properly escape pipe characters and newlines in cell content", () => {
				const rows = [
					{
						id: "1",
						description: "Line 1 with | pipe character\nand second line",
					},
				];
				const md = formatSuiteQLToCompactMarkdown(rows);
				expect(md).toContain("Line 1 with \\| pipe character and second line");
				expect(md).not.toContain("Line 1 with | pipe");

				const longRows = [
					{
						id: "1",
						longText: "A".repeat(400),
					},
				];
				const longMd = formatSuiteQLToCompactMarkdown(longRows);
				expect(longMd).toContain("...");
				expect(longMd).not.toContain("A".repeat(400));
			});

			it("formatMetadataToCompactMarkdown: should convert schema properties into a structured markdown table with optional keyword filtering", () => {
				const schema = {
					properties: {
						id: { type: "integer", description: "Internal ID" },
						tranid: {
							type: "string",
							description: "Transaction Document Number",
						},
						memo: { type: "string", description: "Memo / Notes" },
					},
				};

				const fullMd = formatMetadataToCompactMarkdown(schema);
				expect(fullMd).toContain("| Field | Type | Description | Nullable |");
				expect(fullMd).toContain("| id | integer | Internal ID |");
				expect(fullMd).toContain(
					"| tranid | string | Transaction Document Number |",
				);
				expect(fullMd).toContain("| memo | string | Memo / Notes |");

				const filteredMd = formatMetadataToCompactMarkdown(schema, "tranid");
				expect(filteredMd).toContain("| tranid |");
				expect(filteredMd).not.toContain("| memo |");
			});
		});

		describe("1.6 Single-Turn Fan-Out Batch Array Schemas", () => {
			it("should validate batch array parameters and enforce max 10 ceiling across tools", async () => {
				// RunSuiteQL runtime batch limit check
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();
				const runRes = (await callHandler?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: Array.from(
								{ length: 11 },
								(_, i) => `SELECT ${i} FROM customer`,
							),
						},
					},
				})) as CallToolResult;
				expect(runRes.isError).toBe(true);
				const runErrorText =
					runRes.content?.find((c) => c.type === "text")?.text || "";
				expect(runErrorText).toContain("[Batch Limit Exceeded]");
				expect(runErrorText).toContain("maximum of 10 queries");

				// GetMetadataArgsSchema
				expect(
					GetMetadataArgsSchema.safeParse({
						tables: ["customer", "transaction", "item"],
					}).success,
				).toBe(true);
				expect(
					GetMetadataArgsSchema.safeParse({
						tables: Array.from({ length: 11 }, (_, i) => `table_${i}`),
					}).success,
				).toBe(false);

				// GetRecordArgsSchema
				expect(
					GetRecordArgsSchema.safeParse({
						recordType: "salesorder",
						ids: ["SO10023", "SO10024"],
					}).success,
				).toBe(true);
				expect(
					GetRecordArgsSchema.safeParse({
						recordType: "salesorder",
						ids: Array.from({ length: 11 }, (_, i) => String(i)),
					}).success,
				).toBe(false);

				// GetScriptLogsArgsSchema
				expect(
					GetScriptLogsArgsSchema.safeParse({
						scriptIds: ["customscript_a", "customscript_b"],
					}).success,
				).toBe(true);
				expect(
					GetScriptLogsArgsSchema.safeParse({
						scriptIds: Array.from({ length: 11 }, (_, i) => `script_${i}`),
					}).success,
				).toBe(false);

				// GetSystemNotesArgsSchema
				expect(
					GetSystemNotesArgsSchema.safeParse({
						recordIds: ["1001", "1002"],
					}).success,
				).toBe(true);
				expect(
					GetSystemNotesArgsSchema.safeParse({
						recordIds: Array.from({ length: 11 }, (_, i) => String(i)),
					}).success,
				).toBe(false);

				// UploadFileArgsSchema
				expect(
					UploadFileArgsSchema.safeParse({
						paths: ["/src/test1.js", "/src/test2.js"],
					}).success,
				).toBe(true);
				expect(
					UploadFileArgsSchema.safeParse({
						paths: Array.from({ length: 11 }, (_, i) => `/src/test_${i}.js`),
					}).success,
				).toBe(false);
			});
		});
	});

	// =========================================================================
	// Tier 2: Boundary & Corner Cases
	// =========================================================================
	describe("Tier 2: Boundary & Corner Cases", () => {
		describe("2.1 Parameterized LIMIT (? and :param)", () => {
			it("should reject parameterized LIMIT with question mark (LIMIT ?)", () => {
				const res = validateSuiteQL("SELECT id, name FROM customer LIMIT ?");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject parameterized LIMIT with named bind variable (LIMIT :pageSize)", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer LIMIT :pageSize",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject parameterized LIMIT count and OFFSET (LIMIT ? OFFSET ?)", () => {
				const res = validateSuiteQL("SELECT id FROM item LIMIT ? OFFSET ?");
				expect(res.valid).toBe(false);
				expect(res.reason).toMatch(/LIMIT|OFFSET/i);
			});

			it("should permit Oracle-compliant parameterized FETCH FIRST ? ROWS ONLY", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer FETCH FIRST ? ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should permit Oracle-compliant parameterized FETCH FIRST :limit ROWS ONLY", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer FETCH FIRST :limit ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});
		});

		describe("2.2 Memo Literal Masking with 'mainline = T'", () => {
			it("should reject transactionline queries where 'mainline = T' exists only inside a string literal", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'mainline = T'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should reject transactionline queries where 'tl.mainline = ''F''' is masked inside a string literal", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'tl.mainline = ''F'''",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should accept transactionline queries containing memo literal AND genuine mainline filter", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'mainline = T' AND tl.mainline = 'F'",
				);
				expect(res.valid).toBe(true);
			});
		});

		describe("2.3 Comment Disguise", () => {
			it("should reject transactionline queries where mainline filter is hidden inside block comments", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.transaction = 100 /* tl.mainline = 'F' */",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should reject transactionline queries where mainline filter is hidden inside line comments", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.transaction = 100 -- tl.mainline = 'F'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should reject queries where LIMIT is disguised behind block comments", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer /* comment */ LIMIT 10",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject queries where LIMIT is disguised after newline in line comment", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer -- pagination\nLIMIT 10",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should allow queries with benign comments that do not contain disguised violations", () => {
				const res = validateSuiteQL(
					"SELECT id, companyname FROM customer -- get active customers\nFETCH FIRST 10 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});
		});

		describe("2.4 Non-Sandbox Account Regex Boundaries", () => {
			it("should accurately classify standard and edge-case account IDs via isSandboxAccount", () => {
				// True Sandbox
				expect(isSandboxAccount("5848789_SB1")).toBe(true);
				expect(isSandboxAccount("9260916-sb1")).toBe(true);
				expect(isSandboxAccount("123456_sb")).toBe(true);
				expect(isSandboxAccount("123456-sb")).toBe(true);
				expect(isSandboxAccount("TSTDRV12345")).toBe(true);
				expect(isSandboxAccount("tstdrv_suite")).toBe(true);
				expect(isSandboxAccount("ACME-SB2")).toBe(true);
				expect(isSandboxAccount("ACME_SB99")).toBe(true);

				// False (Production / Non-Sandbox)
				expect(isSandboxAccount("5848789")).toBe(false);
				expect(isSandboxAccount("9260916")).toBe(false);
				expect(isSandboxAccount("123456")).toBe(false);
				expect(isSandboxAccount("123456_PROD")).toBe(false);
				expect(isSandboxAccount("123456-production")).toBe(false);
				expect(isSandboxAccount("SB_123456")).toBe(false);
				expect(isSandboxAccount("TSTDRIVE")).toBe(false);
				expect(isSandboxAccount("")).toBe(false);
			});

			it("should format host subdomain accurately across underscores and uppercase", () => {
				expect(formatNetSuiteAccountHost("5848789_SB1")).toBe("5848789-sb1");
				expect(formatNetSuiteAccountHost(" 9260916-SB2 ")).toBe("9260916-sb2");
				expect(formatNetSuiteAccountHost("123456")).toBe("123456");
			});

			it("should build proper environment suffix for tool description enhancement", () => {
				expect(buildEnvSuffix("9260916-sb1")).toBe(
					" [Account: 9260916-sb1, Env: Sandbox]",
				);
				expect(buildEnvSuffix("9260916")).toBe(
					" [Account: 9260916, Env: Production]",
				);
				expect(buildEnvSuffix(null)).toBe("");
			});
		});
	});

	// =========================================================================
	// Tier 3: Cross-Feature Interactions
	// =========================================================================
	describe("Tier 3: Cross-Feature Interactions", () => {
		describe("3.1 Batch SuiteQL Queries with Mixed Valid / Invalid Statements", () => {
			it("should execute multi-query batch concurrently and gracefully report mixed success and error results", async () => {
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				const batchResult = (await callHandler?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: [
								"SELECT id, entityid FROM customer FETCH FIRST 2 ROWS ONLY",
								"SELECT id FROM non_existent_table_xyz FETCH FIRST 2 ROWS ONLY",
								"SELECT id, tranid FROM transaction FETCH FIRST 2 ROWS ONLY",
							],
						},
					},
				})) as CallToolResult;

				// Partial failure: at least one succeeded, so top-level isError is false or omitted
				expect(batchResult.isError).toBeFalsy();
				const text =
					batchResult.content?.find((c) => c.type === "text")?.text || "";

				expect(text).toContain(
					"## 📊 Parallel SuiteQL Batch Execution (3 Queries)",
				);
				expect(text).toContain("### 🔹 Query #1");
				expect(text).toContain("| id | entityid | companyname | balance |");
				expect(text).toContain("### 🔹 Query #2");
				expect(text).toContain("non_existent_table_xyz");
				expect(text).toContain("### 🔹 Query #3");
				expect(text).toContain("| id | entityid | companyname | balance |");
			});

			it("should return isError: true when ALL queries in a batch fail", async () => {
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				const batchResult = (await callHandler?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: [
								"SELECT id FROM non_existent_table_xyz FETCH FIRST 2 ROWS ONLY",
								"SELECT name FROM non_existent_table_xyz FETCH FIRST 2 ROWS ONLY",
							],
						},
					},
				})) as CallToolResult;

				expect(batchResult.isError).toBe(true);
			});

			it("should halt immediately and propagate 403 permission errors during batch execution", async () => {
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				const res = (await callHandler?.({
					params: {
						name: "netsuite_run_suiteql",
						arguments: {
							sqlQueries: [
								"SELECT id FROM customer FETCH FIRST 2 ROWS ONLY",
								"SELECT id FROM customer WHERE INSUFFICIENT_PERMISSION",
							],
						},
					},
				})) as CallToolResult;

				expect(res.isError).toBe(true);
				const text = res.content?.find((c) => c.type === "text")?.text || "";
				expect(text).toContain("PERMISSION DENIED — HARD STOP");
			});
		});

		describe("3.2 Multi-Record Inspection with Natural Key Resolution", () => {
			it("should inspect multiple records in parallel, resolving natural keys (tranid) to internal IDs via SuiteQL", async () => {
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				const inspectResult = (await callHandler?.({
					params: {
						name: "netsuite_get_record",
						arguments: {
							recordType: "salesorder",
							ids: ["10023", "SO10023", "SO10024"],
						},
					},
				})) as CallToolResult;

				expect(inspectResult.isError).toBeFalsy();
				const text =
					inspectResult.content?.find((c) => c.type === "text")?.text || "";

				// Verify SuiteQL natural key resolution was triggered
				expect(mockMCPTools.executeTool).toHaveBeenCalledWith(
					"ns_runCustomSuiteQL",
					expect.objectContaining({
						sqlQuery: expect.stringContaining("UPPER(tranid)"),
					}),
				);

				// Verify record fetches occurred and results were formatted
				expect(text).toContain("NetSuite Record Inspection");
				expect(text).toContain("Acme International");
			});
		});
	});

	// =========================================================================
	// Tier 4: Real-World Workflows (Single-Turn Multi-Tool Troubleshooting)
	// =========================================================================
	describe("Tier 4: Real-World Workflows", () => {
		describe("4.1 Single-Turn Multi-Tool Troubleshooting Simulation", () => {
			it("should simulate a single-turn multi-tool diagnostic workflow executing concurrently under ConcurrencyLimiter(5)", async () => {
				const callHandler = registeredHandlers.get("tools/call");
				expect(callHandler).toBeDefined();

				let maxActiveConcurrent = 0;
				let currentActive = 0;
				const limiter = new ConcurrencyLimiter(5);

				// Wrap executeTool to track real concurrency depth
				const originalExecute = mockMCPTools.executeTool;
				mockMCPTools.executeTool = vi
					.fn()
					.mockImplementation(async (name: string, args: unknown) => {
						return limiter.run(async () => {
							currentActive++;
							if (currentActive > maxActiveConcurrent) {
								maxActiveConcurrent = currentActive;
							}
							// Add minor realistic latency to allow concurrency overlap
							await new Promise((r) => setTimeout(r, 10));
							try {
								return await originalExecute(name, args);
							} finally {
								currentActive--;
							}
						});
					});

				// Turn 1: AI Agent emits 3 independent troubleshooting tool calls concurrently in 1 turn
				const [recordRes, logsRes, notesRes] = await Promise.all([
					callHandler?.({
						params: {
							name: "netsuite_get_record",
							arguments: {
								recordType: "salesorder",
								id: "SO10023",
							},
						},
					}) as Promise<CallToolResult>,
					callHandler?.({
						params: {
							name: "netsuite_get_script_logs",
							arguments: {
								scriptId: "customscript_order_sync",
								limit: 5,
							},
						},
					}) as Promise<CallToolResult>,
					callHandler?.({
						params: {
							name: "netsuite_get_system_notes",
							arguments: {
								recordType: "salesorder",
								recordId: "98765",
								limit: 5,
							},
						},
					}) as Promise<CallToolResult>,
				]);

				// All 3 tool calls must succeed
				expect(recordRes.isError).toBeFalsy();
				expect(logsRes.isError).toBeFalsy();
				expect(notesRes.isError).toBeFalsy();

				const recordText =
					recordRes.content?.find((c) => c.type === "text")?.text || "";
				const logsText =
					logsRes.content?.find((c) => c.type === "text")?.text || "";
				const notesText =
					notesRes.content?.find((c) => c.type === "text")?.text || "";

				// Verify payload content and context economy formatting
				expect(recordText).toContain("NetSuite Record Inspection");
				expect(recordText).toContain("SO10023");

				expect(logsText).toContain("SuiteScript Execution Logs");
				expect(logsText).toContain("customscript_order_sync");
				expect(logsText).toContain("Order Processed");

				expect(notesText).toContain("System Notes Audit Trail");
				expect(notesText).toContain("Pending Fulfillment");

				// Concurrency must never exceed NetSuite governance ceiling of 5
				expect(maxActiveConcurrent).toBeGreaterThan(0);
				expect(maxActiveConcurrent).toBeLessThanOrEqual(5);
			});
		});
	});
});
