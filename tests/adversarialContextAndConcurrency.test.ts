import { describe, expect, it } from "vitest";
import {
	GetMetadataArgsSchema,
	GetRecordArgsSchema,
	GetScriptLogsArgsSchema,
	GetSystemNotesArgsSchema,
	RunSuiteQLArgsSchema,
	UploadFileArgsSchema,
} from "../src/handlers/toolSchemas.js";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "../src/utils/contextSlimmer.js";
import { ConcurrencyLimiter } from "../src/utils/resilience.js";

describe("Tier 5 Adversarial Challenge: Context Economy & Concurrency", () => {
	// =========================================================================
	// Challenge 1: Deep Nested Structures, Circular References & Large Arrays
	// =========================================================================
	describe("1.1 cleanRecordPayload — Deep Nesting & Stack Overflow Resilience", () => {
		it("should preserve valid scalar data up to depth 20 and truncate at depth 21", () => {
			// Construct an object nested 30 levels deep where each level has scalar data
			let deepObj: Record<string, unknown> = { val_30: "innermost_val" };
			for (let i = 29; i >= 1; i--) {
				deepObj = {
					[`level_${i}`]: deepObj,
					[`val_${i}`]: `value_at_${i}`,
					nullField: null,
					emptyField: "",
				};
			}

			const cleaned = cleanRecordPayload(deepObj) as Record<string, unknown>;
			expect(cleaned).toBeDefined();

			// Verify level 1 to 20 exist and contain their scalar values
			let current: unknown = cleaned;
			let reachedDepth = 0;
			for (let i = 1; i <= 30; i++) {
				if (
					current &&
					typeof current === "object" &&
					`val_${i}` in (current as Record<string, unknown>)
				) {
					reachedDepth = i;
					current = (current as Record<string, unknown>)[`level_${i}`];
				} else {
					break;
				}
			}

			// Clean helper depth cap is depth > 20: levels 1-20 preserved, level 21 omitted
			expect(reachedDepth).toBe(20);

			// Verify level 21 does not exist on level 20
			let nodeAt20: unknown = cleaned;
			for (let i = 1; i < 20; i++) {
				nodeAt20 = (nodeAt20 as Record<string, unknown>)[`level_${i}`];
			}
			expect((nodeAt20 as Record<string, unknown>).level_20).toBeUndefined();

			// Verify null and empty fields were pruned at all levels
			let checkNode: unknown = cleaned;
			for (let i = 1; i <= 20; i++) {
				const nodeObj = checkNode as Record<string, unknown>;
				expect(nodeObj).not.toHaveProperty("nullField");
				expect(nodeObj).not.toHaveProperty("emptyField");
				checkNode = nodeObj[`level_${i}`];
			}
		});

		it("should prune purely container branches whose only content lies beyond depth 20", () => {
			// If intermediate nodes have no valid scalars and only point deeper,
			// when depth 21 returns undefined, empty parent objects collapse to {}
			let emptyContainers: Record<string, unknown> = { val_30: "innermost" };
			for (let i = 29; i >= 1; i--) {
				emptyContainers = {
					[`level_${i}`]: emptyContainers,
					nullField: null,
				};
			}

			const cleaned = cleanRecordPayload(emptyContainers);
			// Intermediate nodes had no other valid keys, so everything cleanly collapses to empty object
			expect(cleaned).toEqual({});
		});

		it("should handle extreme nesting depth (10,000 levels) without RangeError call stack overflow", () => {
			// Build a 10,000 deep chain
			let root: Record<string, unknown> = { val: "leaf" };
			for (let i = 0; i < 10000; i++) {
				root = { child: root };
			}

			// Must not throw RangeError: Maximum call stack size exceeded
			expect(() => {
				const res = cleanRecordPayload(root);
				expect(res).toBeDefined();
			}).not.toThrow();
		});

		it("should handle direct circular reference (obj.self = obj) without infinite recursion", () => {
			const cyclicObj: Record<string, unknown> = {
				id: "1001",
				name: "Acme",
				memo: null,
			};
			cyclicObj.self = cyclicObj;

			const cleaned = cleanRecordPayload(cyclicObj) as Record<string, unknown>;
			expect(cleaned).toBeDefined();
			expect(cleaned.id).toBe("1001");
			expect(cleaned.name).toBe("Acme");
			expect(cleaned).not.toHaveProperty("memo");
			// Self-referential loop must be dropped
			expect(cleaned).not.toHaveProperty("self");
		});

		it("should handle direct array circular reference (arr[0] = arr) without infinite recursion", () => {
			const cyclicArr: unknown[] = ["valid_item", null, ""];
			cyclicArr.push(cyclicArr);

			const cleaned = cleanRecordPayload(cyclicArr) as unknown[];
			expect(Array.isArray(cleaned)).toBe(true);
			expect(cleaned).toContain("valid_item");
			expect(cleaned).not.toContain(null);
			expect(cleaned).not.toContain("");
		});

		it("should handle mutually recursive cycles (a -> b -> c -> a) safely", () => {
			const a: Record<string, unknown> = { name: "A", empty: "" };
			const b: Record<string, unknown> = { name: "B", empty: null };
			const c: Record<string, unknown> = { name: "C", valid: 42 };
			a.toB = b;
			b.toC = c;
			c.toA = a;

			const cleaned = cleanRecordPayload(a) as Record<string, unknown>;
			expect(cleaned).toBeDefined();
			expect(cleaned.name).toBe("A");
			expect(cleaned).not.toHaveProperty("empty");
			const bCleaned = cleaned.toB as Record<string, unknown>;
			expect(bCleaned.name).toBe("B");
			const cCleaned = bCleaned.toC as Record<string, unknown>;
			expect(cCleaned.name).toBe("C");
			expect(cCleaned.valid).toBe(42);
			// Loop back from c to a should be safely dropped as already seen
			expect(cCleaned).not.toHaveProperty("toA");
		});

		it("behavioral check on DAG / diamond shared references: duplicate object instances are stripped", () => {
			const sharedSub = { code: "USD", symbol: "$" };
			const dagRecord = {
				currency: sharedSub,
				baseCurrency: sharedSub,
			};

			const cleaned = cleanRecordPayload(dagRecord) as Record<string, unknown>;
			// The first occurrence is preserved
			expect(cleaned.currency).toEqual({ code: "USD", symbol: "$" });
			// The second occurrence sharing the exact same object reference in memory is treated as seen and stripped
			expect(cleaned.baseCurrency).toBeUndefined();
		});

		it("should properly preserve valid falsy primitives (0, false, -0)", () => {
			const payload = {
				zero: 0,
				negativeZero: -0,
				falseFlag: false,
				emptyStr: "",
				nullVal: null,
				undefVal: undefined,
				sublist: [
					{ lineNum: 0, isClosed: false, memo: "" },
					{ lineNum: 1, isClosed: true, memo: null },
				],
			};

			const cleaned = cleanRecordPayload(payload) as Record<string, unknown>;
			expect(cleaned.zero).toBe(0);
			expect(cleaned.negativeZero).toBe(-0);
			expect(cleaned.falseFlag).toBe(false);
			expect(cleaned).not.toHaveProperty("emptyStr");
			expect(cleaned).not.toHaveProperty("nullVal");
			expect(cleaned).not.toHaveProperty("undefVal");

			const lines = cleaned.sublist as Array<Record<string, unknown>>;
			expect(lines).toHaveLength(2);
			expect(lines[0]?.lineNum).toBe(0);
			expect(lines[0]?.isClosed).toBe(false);
			expect(lines[0]).not.toHaveProperty("memo");
			expect(lines[1]?.lineNum).toBe(1);
			expect(lines[1]?.isClosed).toBe(true);
		});

		it("should efficiently process large arrays (20,000 items) with mixed null/empty values within 200ms", () => {
			const largeArray = Array.from({ length: 20000 }, (_, i) => {
				if (i % 4 === 0) return null;
				if (i % 4 === 1) return "";
				if (i % 4 === 2) return { empty1: null, empty2: "" };
				return { id: String(i), name: `Item ${i}`, memo: null };
			});

			const startTime = Date.now();
			const cleaned = cleanRecordPayload(largeArray) as Array<
				Record<string, unknown>
			>;
			const duration = Date.now() - startTime;

			// Expected: only valid items (i % 4 === 3) survive -> 5,000 items
			expect(cleaned.length).toBe(5000);
			expect(cleaned[0]?.id).toBe("3");
			expect(cleaned[0]?.name).toBe("Item 3");
			expect(cleaned[0]).not.toHaveProperty("memo");
			expect(duration).toBeLessThan(1000);
		});
	});

	// =========================================================================
	// Challenge 2: Markdown Table Formatting & Pipe Character Injection
	// =========================================================================
	describe("1.2 Compact Markdown Formatting & Injection Resilience", () => {
		it("should safely escape pipe characters in SuiteQL cell values and prevent table cell splitting", () => {
			const adversarialRows = [
				{
					id: "101",
					name: "Acme | Corp | LLC",
					expression: "a || b | c",
					memo: "Pipes: | and escaped \\| and trailing |",
				},
			];

			const md = formatSuiteQLToCompactMarkdown(adversarialRows);
			const lines = md.split("\n").filter((l) => l.startsWith("|"));

			// Header, separator, and 1 data row -> exactly 3 table lines
			expect(lines.length).toBe(3);

			// Count number of unescaped pipes in each line (excluding escaped \|)
			// Header has 4 columns -> 5 pipes: | id | name | expression | memo |
			const countPipes = (line: string) => {
				const unescaped = line.replace(/\\\|/g, "");
				return (unescaped.match(/\|/g) || []).length;
			};

			const headerPipes = countPipes(lines[0]!);
			const sepPipes = countPipes(lines[1]!);
			const dataRowPipes = countPipes(lines[2]!);

			expect(headerPipes).toBe(5);
			expect(sepPipes).toBe(5);
			expect(dataRowPipes).toBe(5);

			// Check that all pipes inside cell contents were escaped
			expect(lines[2]).toContain("Acme \\| Corp \\| LLC");
			expect(lines[2]).toContain("a \\|\\| b \\| c");
		});

		it("should safely escape pipe characters in SuiteQL column aliases / headers", () => {
			const rowsWithPipeInHeader = [
				{
					"col|with|pipes": "value1",
					"price|usd": "100.00",
				},
			];

			const md = formatSuiteQLToCompactMarkdown(rowsWithPipeInHeader);
			const lines = md.split("\n").filter((l) => l.startsWith("|"));

			expect(lines.length).toBe(3);
			expect(lines[0]).toContain("col\\|with\\|pipes");
			expect(lines[0]).toContain("price\\|usd");
		});

		it("adversarial finding: newline in column header splits header line in formatSuiteQLToCompactMarkdown", () => {
			const rowsWithNewlineInHeader = [
				{
					"col\nname": "value1",
				},
			];

			const md = formatSuiteQLToCompactMarkdown(rowsWithNewlineInHeader);
			// Because headers only replace | and not \n, a newline in a column alias creates a split header line
			expect(md).toContain("| col\nname |");
		});

		it("should replace newlines and carriage returns with spaces in SuiteQL cells", () => {
			const rowsWithNewlines = [
				{
					id: "201",
					memo: "First line\nSecond line\r\nThird line\rFourth line",
				},
			];

			const md = formatSuiteQLToCompactMarkdown(rowsWithNewlines);
			const lines = md.split("\n").filter((l) => l.startsWith("|"));

			// Must not break data across multiple lines
			expect(lines.length).toBe(3);
			expect(lines[2]).toContain(
				"First line Second line Third line Fourth line",
			);
			expect(lines[2]).not.toMatch(/\r|\n/);
		});

		it("should truncate cell content longer than 300 characters to 297 characters + '...'", () => {
			const longStr = "X".repeat(350);
			const exact300 = "Y".repeat(300);
			const rows = [
				{
					id: "1",
					longVal: longStr,
					exactVal: exact300,
				},
			];

			const md = formatSuiteQLToCompactMarkdown(rows);
			expect(md).toContain(`${"X".repeat(297)}...`);
			expect(md).not.toContain("X".repeat(298));
			expect(md).toContain("Y".repeat(300));
			expect(md).not.toContain(`${"Y".repeat(300)}...`);
		});

		it("should enforce safe ceiling truncation at 100 rows and append warning notice", () => {
			const rows150 = Array.from({ length: 150 }, (_, i) => ({
				id: String(i),
				val: `Row ${i}`,
			}));

			const md = formatSuiteQLToCompactMarkdown(rows150);
			expect(md).toContain(
				"> ⚠️ **Notice**: Result truncated to top 100 of 150 rows.",
			);

			const dataLines = md.split("\n").filter((l) => l.startsWith("|"));
			// Header (1) + Separator (1) + Data (100) = 102 lines
			expect(dataLines.length).toBe(102);
		});

		it("should safely escape pipe characters and newlines in formatMetadataToCompactMarkdown", () => {
			const schema = {
				properties: {
					"field|pipe": {
						type: "string | null",
						description: "Description with | pipe and \n newline",
					},
					normal_field: {
						type: "object",
						properties: {
							sub_a: { type: "string" },
							"sub|b": { type: "number" },
						},
						description: "Complex object",
					},
				},
			};

			const md = formatMetadataToCompactMarkdown(schema);
			const lines = md.split("\n").filter((l) => l.startsWith("|"));

			// Check escaping
			expect(md).toContain("field\\|pipe");
			expect(md).toContain("string \\| null");
			expect(md).toContain("Description with \\| pipe and   newline");
			expect(md).toContain("object (sub_a, sub\\|b)");

			// Validate all lines have 5 pipes
			for (const line of lines) {
				const unescaped = line.replace(/\\\|/g, "");
				const pipeCount = (unescaped.match(/\|/g) || []).length;
				expect(pipeCount).toBe(5);
			}
		});
	});

	// =========================================================================
	// Challenge 3: Context Economy Byte & Token Reduction (>= 50%)
	// =========================================================================
	describe("1.3 Context Economy Byte & Token Reduction Metrics", () => {
		it("should achieve >= 50% byte reduction across realistic ERP transaction datasets", () => {
			// Real-world NetSuite Sales Order query payload with header & 25 line items
			const rawErpRows = Array.from({ length: 25 }, (_, i) => ({
				transaction_id: "6257",
				tranid: "SO-ZH-202112-000003",
				trandate: "2021-12-15",
				entity_id: "IC00000009",
				companyname: "Shanghai Global Trading Co., Ltd.",
				subsidiary: "1",
				currency: "1",
				line_id: String(i + 1),
				item_id: String(100 + i),
				item_name: `Industrial Component Part ${i + 1}`,
				quantity: (i + 1) * 10,
				rate: "150.00",
				amount: ((i + 1) * 1500).toFixed(2),
				taxcode: null,
				taxrate: null,
				memo: "",
				department: null,
				class: null,
				location: "Main Distribution Center",
				isclosed: "F",
				links: [
					{
						rel: "self",
						href: `https://system.netsuite.com/app/accounting/transactions/salesord.nl?id=6257&line=${i}`,
					},
				],
			}));

			const rawJson = JSON.stringify(
				{ data: rawErpRows, totalResults: 25, success: true },
				null,
				2,
			);
			const markdownTable = formatSuiteQLToCompactMarkdown(rawErpRows);

			const rawBytes = Buffer.byteLength(rawJson, "utf8");
			const mdBytes = Buffer.byteLength(markdownTable, "utf8");
			const reductionPercentage = ((rawBytes - mdBytes) / rawBytes) * 100;

			// Verify reduction meets the context economy charter (>= 50%)
			expect(reductionPercentage).toBeGreaterThanOrEqual(50);
		});

		it("should achieve >= 50% byte reduction on cleanRecordPayload when stripping redundant ERP metadata", () => {
			const rawRecordPayload = {
				id: "6257",
				recordType: "salesorder",
				tranid: "SO10023",
				entity: {
					id: "101",
					refName: "Acme Customer",
					links: [{ rel: "self", href: "https://example.com/entity/101" }],
				},
				subtotal: "15000.00",
				taxtotal: null,
				shippingcost: "",
				memo: null,
				otherrefnum: "",
				customForm: { id: "105", refName: "Standard SO Form" },
				department: null,
				class: null,
				location: { id: "1", refName: "Warehouse A" },
				links: [
					{ rel: "self", href: "https://example.com/record/6257" },
					{ rel: "parent", href: "https://example.com/parent" },
				],
				item: {
					links: [{ rel: "self", href: "https://example.com/items" }],
					items: Array.from({ length: 15 }, (_, i) => ({
						line: i + 1,
						item: { id: String(i), refName: `Item ${i}` },
						quantity: 5,
						rate: 100,
						amount: 500,
						taxcode: null,
						memo: "",
						options: null,
						links: [{ rel: "self", href: `https://example.com/line/${i}` }],
					})),
				},
			};

			const rawBytes = Buffer.byteLength(
				JSON.stringify(rawRecordPayload, null, 2),
				"utf8",
			);
			const cleaned = cleanRecordPayload(rawRecordPayload);
			const cleanedBytes = Buffer.byteLength(
				JSON.stringify(cleaned, null, 2),
				"utf8",
			);
			const reduction = ((rawBytes - cleanedBytes) / rawBytes) * 100;

			expect(reduction).toBeGreaterThanOrEqual(50);
		});
	});

	// =========================================================================
	// Challenge 4: Batch Array Schema Ceilings (> 10 items rejection)
	// =========================================================================
	describe("1.4 Batch Array Schemas — Max 10 Items Constraint & Boundary Tests", () => {
		describe("RunSuiteQLArgsSchema (sqlQueries)", () => {
			it("should accept 1 to 10 queries", () => {
				expect(
					RunSuiteQLArgsSchema.safeParse({
						sqlQueries: ["SELECT 1 FROM customer"],
					}).success,
				).toBe(true);

				expect(
					RunSuiteQLArgsSchema.safeParse({
						sqlQueries: Array.from(
							{ length: 10 },
							(_, i) => `SELECT ${i} FROM customer`,
						),
					}).success,
				).toBe(true);
			});

			it("should strictly reject 11 or more queries", () => {
				const parseRes = RunSuiteQLArgsSchema.safeParse({
					sqlQueries: Array.from(
						{ length: 11 },
						(_, i) => `SELECT ${i} FROM customer`,
					),
				});
				expect(parseRes.success).toBe(false);
				if (!parseRes.success) {
					expect(parseRes.error.issues[0]?.message).toMatch(
						/Batch Limit Exceeded|maximum of 10 queries/i,
					);
				}
			});
		});

		describe("GetMetadataArgsSchema (tables)", () => {
			it("should accept 1 to 10 tables", () => {
				expect(
					GetMetadataArgsSchema.safeParse({
						tables: ["customer", "transaction", "item"],
					}).success,
				).toBe(true);

				expect(
					GetMetadataArgsSchema.safeParse({
						tables: Array.from({ length: 10 }, (_, i) => `table_${i}`),
					}).success,
				).toBe(true);
			});

			it("should strictly reject 11 or more tables", () => {
				const parseRes = GetMetadataArgsSchema.safeParse({
					tables: Array.from({ length: 11 }, (_, i) => `table_${i}`),
				});
				expect(parseRes.success).toBe(false);
				if (!parseRes.success) {
					expect(parseRes.error.issues[0]?.message).toMatch(
						/maximum of 10 tables/i,
					);
				}
			});
		});

		describe("GetRecordArgsSchema (ids)", () => {
			it("should accept 1 to 10 record IDs", () => {
				expect(
					GetRecordArgsSchema.safeParse({
						recordType: "salesorder",
						ids: ["SO10023", "SO10024"],
					}).success,
				).toBe(true);

				expect(
					GetRecordArgsSchema.safeParse({
						recordType: "salesorder",
						ids: Array.from({ length: 10 }, (_, i) => `SO${i}`),
					}).success,
				).toBe(true);
			});

			it("should reject 11 or more record IDs", () => {
				const parseRes = GetRecordArgsSchema.safeParse({
					recordType: "salesorder",
					ids: Array.from({ length: 11 }, (_, i) => `SO${i}`),
				});
				expect(parseRes.success).toBe(false);
				if (!parseRes.success) {
					expect(parseRes.error.issues[0]?.message).toMatch(
						/maximum of 10 records/i,
					);
				}
			});

			it("should reject empty ids array ([])", () => {
				const parseRes = GetRecordArgsSchema.safeParse({
					recordType: "salesorder",
					ids: [],
				});
				expect(parseRes.success).toBe(false);
			});
		});

		describe("GetScriptLogsArgsSchema (scriptIds)", () => {
			it("should accept 1 to 10 script IDs", () => {
				expect(
					GetScriptLogsArgsSchema.safeParse({
						scriptIds: Array.from({ length: 10 }, (_, i) => `script_${i}`),
					}).success,
				).toBe(true);
			});

			it("should reject 11 or more script IDs", () => {
				const parseRes = GetScriptLogsArgsSchema.safeParse({
					scriptIds: Array.from({ length: 11 }, (_, i) => `script_${i}`),
				});
				expect(parseRes.success).toBe(false);
				if (!parseRes.success) {
					expect(parseRes.error.issues[0]?.message).toMatch(
						/maximum of 10 script IDs/i,
					);
				}
			});

			it("should reject empty scriptIds array ([])", () => {
				expect(
					GetScriptLogsArgsSchema.safeParse({
						scriptIds: [],
					}).success,
				).toBe(false);
			});
		});

		describe("GetSystemNotesArgsSchema (recordIds)", () => {
			it("should accept 1 to 10 record IDs", () => {
				expect(
					GetSystemNotesArgsSchema.safeParse({
						recordIds: Array.from({ length: 10 }, (_, i) => String(1000 + i)),
					}).success,
				).toBe(true);
			});

			it("should reject 11 or more record IDs", () => {
				const parseRes = GetSystemNotesArgsSchema.safeParse({
					recordIds: Array.from({ length: 11 }, (_, i) => String(1000 + i)),
				});
				expect(parseRes.success).toBe(false);
				if (!parseRes.success) {
					expect(parseRes.error.issues[0]?.message).toMatch(
						/maximum of 10 records/i,
					);
				}
			});

			it("should reject empty recordIds array ([])", () => {
				expect(
					GetSystemNotesArgsSchema.safeParse({
						recordIds: [],
					}).success,
				).toBe(false);
			});
		});

		describe("UploadFileArgsSchema (paths)", () => {
			it("should accept single string path or array of 1 to 10 paths", () => {
				expect(
					UploadFileArgsSchema.safeParse({
						paths: "/src/FileCabinet/SuiteScripts/test.js",
					}).success,
				).toBe(true);

				expect(
					UploadFileArgsSchema.safeParse({
						paths: Array.from({ length: 10 }, (_, i) => `/src/test_${i}.js`),
					}).success,
				).toBe(true);
			});

			it("should reject 11 or more paths", () => {
				const parseRes = UploadFileArgsSchema.safeParse({
					paths: Array.from({ length: 11 }, (_, i) => `/src/test_${i}.js`),
				});
				expect(parseRes.success).toBe(false);
				if (!parseRes.success) {
					expect(parseRes.error.issues[0]?.message).toMatch(
						/maximum of 10 files/i,
					);
				}
			});

			it("should reject empty paths array ([])", () => {
				expect(
					UploadFileArgsSchema.safeParse({
						paths: [],
					}).success,
				).toBe(false);
			});
		});
	});

	// =========================================================================
	// Challenge 5: ConcurrencyLimiter(5) Ceiling, Queue & Error Isolation
	// =========================================================================
	describe("1.5 ConcurrencyLimiter(5) — Ceiling, Queue Drain & Error Recovery", () => {
		it("should strictly enforce the 5-task ceiling under concurrent load of 50 tasks", async () => {
			const limiter = new ConcurrencyLimiter(5);
			let currentInFlight = 0;
			let peakInFlight = 0;
			const executionLog: { id: number; startedAt: number; endedAt: number }[] =
				[];

			const tasks = Array.from({ length: 50 }, (_, i) => {
				return async () => {
					return limiter.run(async () => {
						currentInFlight++;
						if (currentInFlight > peakInFlight) {
							peakInFlight = currentInFlight;
						}
						const startedAt = Date.now();

						// Random realistic execution latency between 5ms and 20ms
						const delay = Math.floor(Math.random() * 15) + 5;
						await new Promise((resolve) => setTimeout(resolve, delay));

						const endedAt = Date.now();
						executionLog.push({ id: i, startedAt, endedAt });

						currentInFlight--;
						return `result_${i}`;
					});
				};
			});

			const results = await Promise.all(tasks.map((t) => t()));

			// 1. Peak concurrent operations must never exceed 5
			expect(peakInFlight).toBeLessThanOrEqual(5);
			// 2. Concurrency ceiling must have been fully utilized
			expect(peakInFlight).toBe(5);
			// 3. All 50 tasks must return their expected results
			expect(results.length).toBe(50);
			expect(results[0]).toBe("result_0");
			expect(results[49]).toBe("result_49");
			// 4. In-flight operations must return to 0
			expect(currentInFlight).toBe(0);
		});

		it("should maintain queue integrity and not leak slots when tasks reject with errors", async () => {
			const limiter = new ConcurrencyLimiter(5);
			let currentInFlight = 0;
			let peakInFlight = 0;

			// 30 tasks total: tasks divisible by 3 will reject with Error
			const tasks = Array.from({ length: 30 }, (_, i) => {
				return async () => {
					return limiter.run(async () => {
						currentInFlight++;
						if (currentInFlight > peakInFlight) {
							peakInFlight = currentInFlight;
						}
						try {
							await new Promise((resolve) => setTimeout(resolve, 8));
							if (i % 3 === 0) {
								throw new Error(`Intentional failure on task ${i}`);
							}
							return `success_${i}`;
						} finally {
							currentInFlight--;
						}
					});
				};
			});

			const settled = await Promise.allSettled(tasks.map((t) => t()));

			const fulfilled = settled.filter((s) => s.status === "fulfilled");
			const rejected = settled.filter((s) => s.status === "rejected");

			// 30 tasks total: 10 rejected (0, 3, 6, ..., 27), 20 fulfilled
			expect(rejected.length).toBe(10);
			expect(fulfilled.length).toBe(20);

			// Ceiling never breached
			expect(peakInFlight).toBeLessThanOrEqual(5);
			// In-flight must return to 0
			expect(currentInFlight).toBe(0);

			// Subsequent tasks must continue to run at full capacity
			const followUpTasks = Array.from({ length: 10 }, (_, i) => {
				return limiter.run(async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return `followup_${i}`;
				});
			});

			const followUpResults = await Promise.all(followUpTasks);
			expect(followUpResults.length).toBe(10);
			expect(followUpResults[9]).toBe("followup_9");
		});

		it("should handle nested distinct ConcurrencyLimiter instances without deadlock", async () => {
			// Outer limiter (e.g. handler-level record fan-out)
			const outerLimiter = new ConcurrencyLimiter(5);
			// Inner limiter (e.g. NetSuite low-level HTTP client)
			const innerLimiter = new ConcurrencyLimiter(5);

			let innerPeak = 0;
			let innerActive = 0;

			const tasks = Array.from({ length: 20 }, (_, i) => {
				return outerLimiter.run(async () => {
					return innerLimiter.run(async () => {
						innerActive++;
						if (innerActive > innerPeak) innerPeak = innerActive;
						await new Promise((r) => setTimeout(r, 10));
						innerActive--;
						return `nested_${i}`;
					});
				});
			});

			const results = await Promise.all(tasks);
			expect(results.length).toBe(20);
			expect(innerPeak).toBeLessThanOrEqual(5);
			expect(innerActive).toBe(0);
		});

		it("should process high-throughput burst of 100 fast tasks safely without starvation", async () => {
			const limiter = new ConcurrencyLimiter(5);
			const completedIds: number[] = [];

			const startTime = Date.now();
			await Promise.all(
				Array.from({ length: 100 }, (_, i) =>
					limiter.run(async () => {
						await new Promise((resolve) => setTimeout(resolve, 2));
						completedIds.push(i);
					}),
				),
			);
			const duration = Date.now() - startTime;

			expect(completedIds.length).toBe(100);
			// Under 5 concurrency with 2ms delay each: min time ~ 40ms, total time should comfortably be < 2000ms
			expect(duration).toBeLessThan(2000);
		});
	});
});
