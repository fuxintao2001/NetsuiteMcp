import { describe, expect, it } from "vitest";
import {
	cleanRecordPayload,
	formatMetadataToCompactMarkdown,
	formatSuiteQLToCompactMarkdown,
} from "./contextSlimmer.js";
import {
	formatTableCatalogMarkdown,
	searchSuiteQLCatalog,
} from "./metadata.js";
import { generateNetSuiteUrl } from "./netsuiteUrls.js";
import { SuiteScriptSearchValidator } from "./searchValidator.js";
import {
	assertValidSuiteQL,
	diagnoseSuiteQLError,
	ensureSuiteQLPagination,
	extractReferencedTables,
	formatSuiteQLErrorResponse,
	hasPaginationClause,
	maskStringLiterals,
	SuiteQLValidationError,
	validateSuiteQL,
} from "./suiteqlGuard.js";

describe("SuiteQL, Search & Query Utilities", () => {
	describe("suiteqlGuard", () => {
		describe("maskStringLiterals", () => {
			it("should mask single quote strings and preserve escaped quotes", () => {
				const sql =
					"SELECT * FROM customer WHERE memo = 'DROP SHIPPING ''LLC''' AND name = 'O''Reilly'";
				const { maskedSql, literals } = maskStringLiterals(sql);
				expect(maskedSql).toContain("__STR_LITERAL_0__");
				expect(maskedSql).toContain("__STR_LITERAL_1__");
				expect(literals[0]).toBe("'DROP SHIPPING ''LLC'''");
				expect(literals[1]).toBe("'O''Reilly'");
			});
		});

		describe("extractReferencedTables", () => {
			it("should extract table names from FROM and JOIN clauses", () => {
				const sql = `
				SELECT t.id, c.companyname, tl.amount 
				FROM Transaction t 
				LEFT JOIN Customer c ON t.entity = c.id 
				JOIN TransactionLine tl ON tl.transaction = t.id
			`;
				const tables = extractReferencedTables(sql);
				expect(tables).toContain("transaction");
				expect(tables).toContain("customer");
				expect(tables).toContain("transactionline");
			});

			it("should not extract table names from inside string literals", () => {
				const sql =
					"SELECT id FROM Customer WHERE memo = 'JOIN Transaction NOW'";
				const tables = extractReferencedTables(sql);
				expect(tables).toEqual(["customer"]);
			});
		});

		describe("pagination helpers", () => {
			it("should detect ROWNUM and FETCH FIRST clauses", () => {
				expect(
					hasPaginationClause("SELECT id FROM customer WHERE ROWNUM <= 100"),
				).toBe(true);
				expect(
					hasPaginationClause(
						"SELECT id FROM customer FETCH FIRST 50 ROWS ONLY",
					),
				).toBe(true);
				expect(hasPaginationClause("SELECT id FROM customer")).toBe(false);
			});

			it("should ensure pagination by appending FETCH FIRST when missing", () => {
				const query = "SELECT id FROM customer WHERE isinactive = 'F'";
				const withPagination = ensureSuiteQLPagination(query, 50);
				expect(withPagination).toBe(
					"SELECT id FROM customer WHERE isinactive = 'F' FETCH FIRST 50 ROWS ONLY",
				);

				const alreadyHas = "SELECT id FROM customer WHERE ROWNUM <= 10";
				expect(ensureSuiteQLPagination(alreadyHas, 50)).toBe(alreadyHas);
			});
		});

		describe("validateSuiteQL", () => {
			it("should validate a simple valid SELECT query", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer WHERE isinactive = 'F'",
				);
				expect(res.valid).toBe(true);
				expect(res.reason).toBeUndefined();
				expect(res.tables).toContain("customer");
			});

			it("should allow DDL/DML keywords inside string literals without false positives", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer WHERE memo = 'DROP SHIPPING LLC' AND notes = 'please update account'",
				);
				expect(res.valid).toBe(true);
			});

			it("should allow comment symbols inside string literals without false positives", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer WHERE memo = 'Issue #123 -- urgent /* check */'",
				);
				expect(res.valid).toBe(true);
			});

			it("should validate a query ending with a single semicolon", () => {
				const res = validateSuiteQL("SELECT id FROM transaction;");
				expect(res.valid).toBe(true);
			});

			it("should validate a valid CTE (WITH statement) query", () => {
				const res = validateSuiteQL(
					"WITH c AS (SELECT id FROM customer) SELECT id FROM c",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject queries with SELECT * (Gate 2 Syntax Mandate)", () => {
				const res = validateSuiteQL("SELECT * FROM transaction");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("contains 'SELECT *'");
			});

			it("should reject alias wildcards in any position (SELECT c.*, t.* or SELECT id, t.*)", () => {
				const res1 = validateSuiteQL(
					"SELECT c.*, t.* FROM customer c JOIN transaction t ON c.id = t.entity",
				);
				expect(res1.valid).toBe(false);
				expect(res1.reason).toContain("wildcard projection");

				const res2 = validateSuiteQL("SELECT id, t.* FROM transaction t");
				expect(res2.valid).toBe(false);
				expect(res2.reason).toContain("wildcard projection");
			});

			it("should allow valid COUNT(*) aggregate and arithmetic multiplication without false positives", () => {
				const countRes = validateSuiteQL(
					"SELECT COUNT(*) AS total FROM customer",
				);
				expect(countRes.valid).toBe(true);

				const multiCountRes = validateSuiteQL(
					"SELECT id, COUNT(*) FROM customer GROUP BY id",
				);
				expect(multiCountRes.valid).toBe(true);

				const arithRes = validateSuiteQL(
					"SELECT a.id, a.quantity * a.rate AS total FROM transactionline a WHERE a.mainline = 'F'",
				);
				expect(arithRes.valid).toBe(true);
			});

			it("should reject queries with MySQL/Postgres LIMIT (Gate 2 Syntax Mandate)", () => {
				const res = validateSuiteQL("SELECT id FROM customer LIMIT 10");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("does not support 'LIMIT/OFFSET'");
			});

			it("should reject an empty query", () => {
				const res = validateSuiteQL("  ");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("cannot be empty");
			});

			it("should reject non-SELECT / non-WITH query statements", () => {
				const res = validateSuiteQL("SHOW TABLES");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"must begin with a SELECT or WITH statement",
				);
			});

			it("should reject DDL/DML mutation keywords like DELETE", () => {
				const res = validateSuiteQL("DELETE FROM customer WHERE id = 1");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"must begin with a SELECT or WITH statement",
				);
			});

			it("should reject DROP queries", () => {
				const res = validateSuiteQL("DROP TABLE customer");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"must begin with a SELECT or WITH statement",
				);
			});

			it("should reject UPDATE queries embedded after SELECT", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer WHERE id = 1 UPDATE customer SET name = 'bad'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"disallowed mutation or DDL keyword: 'UPDATE'",
				);
			});

			it("should reject queries with comments (--)", () => {
				const res = validateSuiteQL("SELECT * FROM customer -- comment");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("prohibited SQL comments");
			});

			it("should reject queries with block comments (/* */)", () => {
				const res = validateSuiteQL("SELECT /* secret */ id FROM customer");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("prohibited SQL comments");
			});

			it("should reject multi-statement injection with semicolons", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer; SELECT id FROM item;",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"multiple statements separated by semicolons",
				);
			});

			it("should reject prohibited SystemNote JOIN queries", () => {
				const res = validateSuiteQL(
					"SELECT t.id, sn.detail FROM transaction t JOIN SystemNote sn ON sn.recordid = t.id WHERE t.id = 1",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Prohibited 'JOIN SystemNote'");
			});

			it("should reject createdfrom on transaction header table", () => {
				const res1 = validateSuiteQL(
					"SELECT t.id FROM transaction t WHERE t.createdfrom = 100",
				);
				expect(res1.valid).toBe(false);
				expect(res1.reason).toContain("Invalid field location 'createdfrom'");

				const res2 = validateSuiteQL(
					"SELECT id FROM transaction WHERE createdfrom = 100",
				);
				expect(res2.valid).toBe(false);
				expect(res2.reason).toContain("Invalid field location 'createdfrom'");
			});

			it("should reject inventoryitemlocations without itemtype filter and guide to aggregateitemlocation", () => {
				const res = validateSuiteQL(
					"SELECT a.item, a.location, a.quantityOnHand FROM inventoryitemlocations a WHERE a.location = 1",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Suboptimal table 'inventoryitemlocations'",
				);
				expect(res.reason).toContain("aggregateitemlocation");
			});

			it("should allow inventoryitemlocations when explicitly filtered by itemtype", () => {
				const res = validateSuiteQL(
					"SELECT a.item, a.location, a.quantityOnHand FROM inventoryitemlocations a WHERE a.itemtype = 'InvtPart' AND a.location = 1",
				);
				expect(res.valid).toBe(true);
			});

			it("should validate aggregateitemlocation queries successfully", () => {
				const res = validateSuiteQL(
					"SELECT a.item, a.location, a.quantityOnHand, a.quantityAvailable, a.quantityOnOrder FROM aggregateitemlocation a WHERE a.location = 23",
				);
				expect(res.valid).toBe(true);
				expect(res.tables).toContain("aggregateitemlocation");
			});

			it("should reject transactionline queries missing mainline filter", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item, tl.quantity FROM transactionline tl WHERE tl.transaction = 100",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

			it("should reject unindexed transaction + transactionline joins", () => {
				const res = validateSuiteQL(
					"SELECT t.id, tl.amount FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE tl.mainline = 'F'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Unindexed query against 'transaction' + 'transactionline'",
				);
			});

			it("should allow indexed transaction + transactionline queries with mainline filter", () => {
				const res = validateSuiteQL(
					"SELECT t.id, t.tranid, tl.item, tl.amount FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd' AND t.trandate >= TO_DATE('2025-01-01', 'YYYY-MM-DD') AND tl.mainline = 'F'",
				);
				expect(res.valid).toBe(true);
				expect(res.tables).toContain("transaction");
				expect(res.tables).toContain("transactionline");
			});

			it("should reject queries using invalid column 'recordtype' on item table", () => {
				const res1 = validateSuiteQL(
					"SELECT id, itemid, recordtype FROM item WHERE isinactive = 'F'",
				);
				expect(res1.valid).toBe(false);
				expect(res1.reason).toContain("does not exist on the 'item' table");
				expect(res1.reason).toContain("itemtype");

				const res2 = validateSuiteQL(
					"SELECT asm.recordtype, com.itemtype FROM BomRevisionComponent brc JOIN bomRevision bomr ON bomr.id = brc.bomrevision JOIN item asm ON asm.id = bomr.assembly JOIN item com ON com.id = brc.item",
				);
				expect(res2.valid).toBe(false);
				expect(res2.reason).toContain(
					"Invalid column 'asm.recordtype' on 'item'",
				);
				expect(res2.reason).toContain("asm.itemtype");
			});

			it("should allow valid itemtype and subtype on item table", () => {
				const res = validateSuiteQL(
					"SELECT id, itemid, itemtype, subtype FROM item WHERE itemtype = 'Assembly'",
				);
				expect(res.valid).toBe(true);
				expect(res.tables).toContain("item");
			});
		});

		describe("assertValidSuiteQL", () => {
			it("should not throw on valid query", () => {
				expect(() =>
					assertValidSuiteQL("SELECT entityid, email FROM customer"),
				).not.toThrow();
			});

			it("should throw SuiteQLValidationError on invalid query", () => {
				expect(() => assertValidSuiteQL("DROP TABLE item")).toThrow(
					SuiteQLValidationError,
				);
			});

			it("should throw SuiteQLValidationError with helpful suggestion on missing mainline", () => {
				expect(() =>
					assertValidSuiteQL(
						"SELECT id, item FROM transactionline WHERE transaction = 1",
					),
				).toThrowError(/Missing 'mainline' filter/);
			});
		});

		describe("diagnoseSuiteQLError & formatSuiteQLErrorResponse", () => {
			it("should diagnose unknown identifier 'createdfrom' on transaction", () => {
				const diag = diagnoseSuiteQLError(
					"Unknown identifier 'createdfrom'",
					"SELECT id, createdfrom FROM transaction WHERE id = 1",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Invalid Field Location");
				expect(diag.rootCause).toContain("transactionline");
				expect(diag.suggestedFix).toContain("transactionline");
				expect(diag.selfHealingAction).toContain("tl.mainline = 'T'");

				const formatted = formatSuiteQLErrorResponse(
					"Unknown identifier 'createdfrom'",
					"SELECT id, createdfrom FROM transaction WHERE id = 1",
				);
				expect(formatted).toContain("❌ **SuiteQL Error:**");
				expect(formatted).toContain("🔍 **Diagnostic:**");
				expect(formatted).toContain("💡 **Suggested Pattern:**");
			});

			it("should diagnose unknown identifier 'recordtype' on item table", () => {
				const diag = diagnoseSuiteQLError(
					"Unknown identifier 'recordtype'",
					"SELECT id, recordtype FROM item WHERE id = 100",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Invalid Column on 'item' Table");
				expect(diag.rootCause).toContain("itemtype");
				expect(diag.suggestedFix).toContain("itemtype");
				expect(diag.selfHealingAction).toContain(
					"Replace all occurrences of 'recordtype'",
				);
			});

			it("should diagnose 'Record bin was not found' and guide to inventorybalance", () => {
				const diag = diagnoseSuiteQLError(
					"Record 'bin' was not found in schema",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Table Not Directly Accessible");
				expect(diag.officialGuidance).toContain("inventorybalance");
				expect(diag.suggestedFix).toContain("inventorybalance");
			});

			it("should diagnose non-existent table and suggest ns_getSuiteQLMetadata", () => {
				const diag = diagnoseSuiteQLError(
					"Record 'nonexistent_tbl' was not found",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Non-Existent or Disabled Table");
				expect(diag.selfHealingAction).toContain(
					"ns_getSuiteQLMetadata({ keyword: 'nonexistent_tbl' })",
				);
			});

			it("should diagnose LIMIT/OFFSET dialect errors", () => {
				const diag = diagnoseSuiteQLError(
					"Syntax error near LIMIT",
					"SELECT id FROM customer LIMIT 10",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Unsupported Dialect Keyword");
				expect(diag.suggestedFix).toContain("FETCH FIRST");
			});

			it("should diagnose Prohibited SystemNote multi-table joins", () => {
				const diag = diagnoseSuiteQLError(
					"Prohibited 'JOIN SystemNote'",
					"SELECT s.field FROM systemnote s JOIN transaction t ON s.recordid = t.id",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain(
					"Prohibited Multi-Table JOIN with SystemNote",
				);
				expect(diag.suggestedFix).toContain("WHERE recordtypeid = -30");
			});

			it("should handle unknown generic errors gracefully", () => {
				const diag = diagnoseSuiteQLError("Some bizarre internal error");
				expect(diag.isDiagnosed).toBe(false);
				expect(diag.selfHealingAction).toContain("ns_getSuiteQLMetadata");
			});
		});

		describe("searchSuiteQLCatalog & formatTableCatalogMarkdown", () => {
			it("should return full catalog when keyword is omitted or empty", () => {
				const all = searchSuiteQLCatalog();
				expect(all.length).toBeGreaterThan(15);
				expect(all.some((t) => t.tableName === "aggregateitemlocation")).toBe(
					true,
				);
				expect(all.some((t) => t.tableName === "transaction")).toBe(true);
			});

			it("should filter catalog by keyword accurately across domains and fields", () => {
				const invMatches = searchSuiteQLCatalog("inventory");
				expect(invMatches.length).toBeGreaterThan(0);
				expect(
					invMatches.some((t) => t.tableName === "aggregateitemlocation"),
				).toBe(true);

				const mfgMatches = searchSuiteQLCatalog("bom");
				expect(mfgMatches.some((t) => t.tableName === "bom")).toBe(true);
				expect(mfgMatches.some((t) => t.tableName === "bomcomponent")).toBe(
					true,
				);

				const emptyMatches = searchSuiteQLCatalog("nonexistent_keyword_xyz");
				expect(emptyMatches.length).toBe(0);
			});

			it("should format catalog results into Markdown table", () => {
				const matches = searchSuiteQLCatalog("inventory");
				const md = formatTableCatalogMarkdown(matches, "inventory");
				expect(md).toContain("### 🔍 NetSuite SuiteQL Table Catalog");
				expect(md).toContain("| `aggregateitemlocation` |");
				expect(md).toContain("GOLDEN TABLE");

				const emptyMd = formatTableCatalogMarkdown([], "xyz");
				expect(emptyMd).toContain(
					"⚠️ No matching NetSuite SuiteQL tables found",
				);
			});
		});
	});

	describe("SuiteScriptSearchValidator", () => {
		it("should detect hallucinated customer search fields", () => {
			const res1 = SuiteScriptSearchValidator.validateField(
				"customer",
				"customerId",
			);
			expect(res1.valid).toBe(false);
			expect(res1.suggestion).toContain("entityid");

			const res2 = SuiteScriptSearchValidator.validateField(
				"customer",
				"customerName",
			);
			expect(res2.valid).toBe(false);
			expect(res2.suggestion).toContain("companyname");
		});

		it("should validate standard customer search fields", () => {
			expect(
				SuiteScriptSearchValidator.validateField("customer", "entityid").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateField("customer", "email").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateField("customer", "balance").valid,
			).toBe(true);
		});

		it("should allow custom fields on any record", () => {
			expect(
				SuiteScriptSearchValidator.validateField(
					"salesorder",
					"custbody_my_field",
				).valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateField(
					"customer",
					"custentity_tax_id",
				).valid,
			).toBe(true);
		});

		it("should reject UI transaction names and recommend shortcodes", () => {
			const res =
				SuiteScriptSearchValidator.validateTransactionType("Sales Order");
			expect(res.valid).toBe(false);
			expect(res.suggestion).toContain("SalesOrd");
		});

		it("should accept valid transaction shortcodes", () => {
			expect(
				SuiteScriptSearchValidator.validateTransactionType("SalesOrd").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateTransactionType("CustInvc").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateTransactionType("PurchOrd").valid,
			).toBe(true);
		});

		it("should detect 1.0 API mixing in 2.1 code", () => {
			const badCode =
				"search.create({ filters: [new nlobjSearchFilter('email', null, 'is', 'a@b.com')] })";
			const res = SuiteScriptSearchValidator.checkLegacyApiMixing(badCode);
			expect(res.valid).toBe(false);
			expect(res.error).toContain("nlobjSearchFilter");
		});

		it("should validate and reject invalid search summary aggregation types", () => {
			expect(SuiteScriptSearchValidator.validateSummaryType("SUM").valid).toBe(
				true,
			);
			expect(
				SuiteScriptSearchValidator.validateSummaryType("COUNT").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateSummaryType("GROUP").valid,
			).toBe(true);

			const invalid = SuiteScriptSearchValidator.validateSummaryType("TOTAL");
			expect(invalid.valid).toBe(false);
			expect(invalid.suggestion).toContain("SUM");
		});

		it("should validate and reject invalid formula column names", () => {
			expect(
				SuiteScriptSearchValidator.validateFormulaField("formulatext").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateFormulaField("formulanumeric").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateFormulaField("formulacurrency")
					.valid,
			).toBe(true);

			const invalid =
				SuiteScriptSearchValidator.validateFormulaField("formula_currency");
			expect(invalid.valid).toBe(false);
			expect(invalid.suggestion).toContain("formulacurrency");
		});

		it("should reject camelCase or PascalCase record type strings", () => {
			expect(
				SuiteScriptSearchValidator.validateRecordTypeString("salesorder").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateRecordTypeString("customerpayment")
					.valid,
			).toBe(true);

			const camel =
				SuiteScriptSearchValidator.validateRecordTypeString("salesOrder");
			expect(camel.valid).toBe(false);
			expect(camel.suggestion).toContain("salesorder");

			const pascal =
				SuiteScriptSearchValidator.validateRecordTypeString("PurchaseOrder");
			expect(pascal.valid).toBe(false);
			expect(pascal.suggestion).toContain("purchaseorder");
		});

		it("should validate and reject invalid sublist field IDs", () => {
			expect(
				SuiteScriptSearchValidator.validateSublistField(
					"salesorder",
					"item",
					"quantity",
				).valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateSublistField(
					"salesorder",
					"item",
					"rate",
				).valid,
			).toBe(true);

			const invalidQty = SuiteScriptSearchValidator.validateSublistField(
				"salesorder",
				"item",
				"qty",
			);
			expect(invalidQty.valid).toBe(false);
			expect(invalidQty.suggestion).toContain("quantity");

			const invalidRate = SuiteScriptSearchValidator.validateSublistField(
				"salesorder",
				"item",
				"unitprice",
			);
			expect(invalidRate.valid).toBe(false);
			expect(invalidRate.suggestion).toContain("rate");
		});

		it("should validate and reject invalid filter connectors", () => {
			expect(
				SuiteScriptSearchValidator.validateFilterConnector("AND").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateFilterConnector("OR").valid,
			).toBe(true);
			expect(
				SuiteScriptSearchValidator.validateFilterConnector("NOT").valid,
			).toBe(true);

			const invalidAnd =
				SuiteScriptSearchValidator.validateFilterConnector("and");
			expect(invalidAnd.valid).toBe(false);

			const invalidSymbol =
				SuiteScriptSearchValidator.validateFilterConnector("&&");
			expect(invalidSymbol.valid).toBe(false);
		});
	});

	describe("Context Slimmer", () => {
		describe("cleanRecordPayload", () => {
			it("should recursively remove null, undefined, empty strings, and links key", () => {
				const payload = {
					id: "123",
					name: "John Doe",
					email: "",
					parent: null,
					links: [{ rel: "self", href: "/url" }],
					nested: {
						active: true,
						value: undefined,
						links: { href: "/another-url" },
					},
					items: [{ sku: "A", discount: null, links: [] }],
				};

				const result = cleanRecordPayload(payload);
				expect(result).toEqual({
					id: "123",
					name: "John Doe",
					nested: {
						active: true,
					},
					items: [{ sku: "A" }],
				});
			});

			it("should fall back to empty object/array when everything is cleaned", () => {
				expect(cleanRecordPayload({ links: [], temp: null })).toEqual({});
				expect(cleanRecordPayload([null, undefined])).toEqual([]);
			});
		});

		describe("formatMetadataToCompactMarkdown", () => {
			it("should convert standard JSON Schema properties into a Markdown table", () => {
				const schema = {
					properties: {
						id: { title: "Internal ID", type: "string", nullable: false },
						name: {
							title: "Name",
							type: "string",
							description: "Customer name",
						},
						company: {
							title: "Company Reference",
							type: "object",
							properties: {
								id: { type: "string" },
								refName: { type: "string" },
							},
						},
					},
				};

				const markdown = formatMetadataToCompactMarkdown(schema);
				expect(markdown).toContain("| Field | Type | Description | Nullable |");
				expect(markdown).toContain("| id | string | Internal ID | No |");
				expect(markdown).toContain("| name | string | Customer name | Yes |");
				expect(markdown).toContain(
					"| company | object (id, refName) | Company Reference | Yes |",
				);
			});

			it("should unwrap schema when nested in success/metadata or content formats", () => {
				const mcpFormat = {
					content: [
						{
							text: JSON.stringify({
								success: true,
								metadata: {
									properties: {
										sku: { title: "SKU", type: "string" },
									},
								},
							}),
						},
					],
				};

				const markdown = formatMetadataToCompactMarkdown(mcpFormat);
				expect(markdown).toContain("| sku | string | SKU | Yes |");
			});

			it("should return stringified fallback on non-object inputs", () => {
				expect(formatMetadataToCompactMarkdown("plain string")).toBe(
					"plain string",
				);
				expect(formatMetadataToCompactMarkdown(null)).toBe("null");
			});
		});

		describe("formatSuiteQLToCompactMarkdown", () => {
			it("should format a standard SuiteQL result array into a Markdown table", () => {
				const suiteqlResult = {
					totalResults: 2,
					numberOfPages: 1,
					data: [
						{
							id: "101",
							tranid: "SO1001",
							trandate: "2025-01-01",
							amount: 5000,
						},
						{
							id: "102",
							tranid: "SO1002",
							trandate: "2025-01-02",
							amount: 3200,
						},
					],
				};

				const markdown = formatSuiteQLToCompactMarkdown(suiteqlResult);
				expect(markdown).toContain("| id | tranid | trandate | amount |");
				expect(markdown).toContain("| 101 | SO1001 | 2025-01-01 | 5000 |");
				expect(markdown).toContain("| 102 | SO1002 | 2025-01-02 | 3200 |");
			});

			it("should escape pipe characters and newlines in column values", () => {
				const data = [
					{
						id: "1",
						memo: "Contract | Phase 1\nNotes here",
						status: null,
					},
				];

				const markdown = formatSuiteQLToCompactMarkdown(data);
				expect(markdown).toContain("| id | memo | status |");
				expect(markdown).toContain("Contract \\| Phase 1 Notes here");
				expect(markdown).toContain(" - |");
			});

			it("should handle empty results gracefully", () => {
				expect(formatSuiteQLToCompactMarkdown([])).toBe("No rows returned.");
				expect(formatSuiteQLToCompactMarkdown({ data: [] })).toBe(
					"No rows returned.",
				);
				expect(formatSuiteQLToCompactMarkdown(null)).toBe(
					"No results returned.",
				);
			});

			it("should display total results notice when paginated", () => {
				const paginatedResult = {
					totalResults: 150,
					data: [
						{ id: "1", name: "Row 1" },
						{ id: "2", name: "Row 2" },
					],
				};

				const markdown = formatSuiteQLToCompactMarkdown(paginatedResult);
				expect(markdown).toContain("*Total Results: 150 (Showing 2 rows)*");
				expect(markdown).toContain("| 1 | Row 1 |");
			});
		});
	});

	describe("NetSuite UI URL Generation", () => {
		it("should return null if accountId or recordId is missing", () => {
			expect(generateNetSuiteUrl(undefined, "customer", "123")).toBeNull();
			expect(generateNetSuiteUrl("123456", "customer", undefined)).toBeNull();
			expect(generateNetSuiteUrl("123456", "customer", "")).toBeNull();
			expect(generateNetSuiteUrl("123456", "customer", "   ")).toBeNull();
		});

		it("should format host subdomain accurately", () => {
			const url = generateNetSuiteUrl("9260916-sb1", "customer", "789");
			expect(url).toContain("https://9260916-sb1.app.netsuite.com");
		});

		it("should resolve standard mapped record types", () => {
			const custUrl = generateNetSuiteUrl("123456", "customer", "100");
			expect(custUrl).toBe(
				"https://123456.app.netsuite.com/app/common/entity/custjob.nl?id=100",
			);

			const invUrl = generateNetSuiteUrl("123456", "invoice", "200");
			expect(invUrl).toBe(
				"https://123456.app.netsuite.com/app/accounting/transactions/custinvc.nl?id=200",
			);

			const periodUrl = generateNetSuiteUrl(
				"123456",
				"accountingperiod",
				"350",
			);
			expect(periodUrl).toBe(
				"https://123456.app.netsuite.com/app/accounting/other/period.nl?id=350",
			);

			const currencyUrl = generateNetSuiteUrl("123456", "currency", "1");
			expect(currencyUrl).toBe(
				"https://123456.app.netsuite.com/app/common/other/currency.nl?id=1",
			);

			const scriptUrl = generateNetSuiteUrl("123456", "script", "99");
			expect(scriptUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/script.nl?id=99",
			);
		});

		it("should handle custom records requiring numeric rectype parameter", () => {
			// Custom records without numeric rectype return null to prevent broken NetSuite UI URLs
			const customWithoutRectype = generateNetSuiteUrl(
				"123456",
				"customrecord_my_script",
				"500",
			);
			expect(customWithoutRectype).toBeNull();

			// Custom records with numeric rectype (number or numeric string) succeed
			const customNumericUrl = generateNetSuiteUrl(
				"123456",
				"customrecord_type",
				"500",
				105,
			);
			expect(customNumericUrl).toBe(
				"https://123456.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=105&id=500",
			);

			const customStringNumericUrl = generateNetSuiteUrl(
				"123456",
				"customrecord_type",
				"500",
				"105",
			);
			expect(customStringNumericUrl).toBe(
				"https://123456.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=105&id=500",
			);
		});

		it("should fall back to standard transaction page if record type is unmapped", () => {
			const fallbackUrl = generateNetSuiteUrl("123456", "unknown_type", "888");
			expect(fallbackUrl).toBe(
				"https://123456.app.netsuite.com/app/accounting/transactions/transaction.nl?id=888",
			);
		});
	});
});
