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
import {
	generateNetSuiteScriptDeploymentUrl,
	generateNetSuiteScriptFileUrl,
	generateNetSuiteScriptUrl,
	generateNetSuiteSuiteletUrl,
	generateNetSuiteUrl,
} from "./netsuiteUrls.js";
import {
	assertValidSuiteQL,
	diagnoseSuiteQLError,
	extractReferencedTables,
	formatSuiteQLErrorResponse,
	hasMainlineFilter,
	hasPaginationClause,
	maskStringLiterals,
	SuiteQLValidationError,
	splitSuiteQLStatements,
	unmaskStringLiterals,
	validateSuiteQL,
} from "./suiteqlGuard.js";

describe("SuiteQL, Search & Query Utilities", () => {
	describe("suiteqlGuard", () => {
		describe("maskStringLiterals & unmaskStringLiterals", () => {
			it("should mask single quote strings and preserve escaped quotes", () => {
				const sql =
					"SELECT * FROM customer WHERE memo = 'DROP SHIPPING ''LLC''' AND name = 'O''Reilly'";
				const { maskedSql, literals } = maskStringLiterals(sql);
				expect(maskedSql).toContain("__STR_LITERAL_0__");
				expect(maskedSql).toContain("__STR_LITERAL_1__");
				expect(literals[0]).toBe("'DROP SHIPPING ''LLC'''");
				expect(literals[1]).toBe("'O''Reilly'");
			});

			it("should restore string literals accurately with unmaskStringLiterals", () => {
				const sql = "SELECT * FROM customer WHERE memo = 'special $100 price'";
				const { maskedSql, literals } = maskStringLiterals(sql);
				const restored = unmaskStringLiterals(maskedSql, literals);
				expect(restored).toBe(sql);
			});

			it("should mask double quote strings/identifiers and preserve escaped double quotes", () => {
				const sql =
					'SELECT id FROM customer WHERE memo = "DROP SHIPPING ""LLC""" AND "status" = "ACTIVE"';
				const { maskedSql, literals } = maskStringLiterals(sql);
				expect(maskedSql).toContain("__STR_LITERAL_0__");
				expect(maskedSql).toContain("__STR_LITERAL_1__");
				expect(maskedSql).toContain("__STR_LITERAL_2__");
				expect(literals[0]).toBe('"DROP SHIPPING ""LLC"""');
				expect(literals[1]).toBe('"status"');
				expect(literals[2]).toBe('"ACTIVE"');
				const restored = unmaskStringLiterals(maskedSql, literals);
				expect(restored).toBe(sql);
			});
		});

		describe("splitSuiteQLStatements", () => {
			it("should split multiple statements separated by semicolons", () => {
				const sql =
					"SELECT id, tranid FROM transaction; SELECT id, entityid FROM customer;";
				const statements = splitSuiteQLStatements(sql);
				expect(statements).toEqual([
					"SELECT id, tranid FROM transaction",
					"SELECT id, entityid FROM customer",
				]);
			});

			it("should safely ignore semicolons inside single-quoted string literals", () => {
				const sql =
					"SELECT id FROM transaction WHERE memo = 'step 1; step 2'; SELECT id FROM customer WHERE companyname = 'ABC; LLC'";
				const statements = splitSuiteQLStatements(sql);
				expect(statements).toHaveLength(2);
				expect(statements[0]).toBe(
					"SELECT id FROM transaction WHERE memo = 'step 1; step 2'",
				);
				expect(statements[1]).toBe(
					"SELECT id FROM customer WHERE companyname = 'ABC; LLC'",
				);
			});

			it("should return single statement for query without semicolon or with only trailing semicolon", () => {
				expect(splitSuiteQLStatements("SELECT id FROM customer")).toEqual([
					"SELECT id FROM customer",
				]);
				expect(splitSuiteQLStatements("SELECT id FROM customer;")).toEqual([
					"SELECT id FROM customer",
				]);
				expect(splitSuiteQLStatements("SELECT id FROM customer;;;")).toEqual([
					"SELECT id FROM customer",
				]);
			});

			it("should handle empty or whitespace input gracefully", () => {
				expect(splitSuiteQLStatements("")).toEqual([]);
				expect(splitSuiteQLStatements("   ;   ;;   ")).toEqual([]);
			});
		});

		describe("strict dialect guard (zero implicit transpilation)", () => {
			it("should reject standalone LIMIT with FETCH FIRST guidance", () => {
				const res = validateSuiteQL(
					"SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' LIMIT 10",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT/OFFSET");
				expect(res.reason).toContain("FETCH FIRST");
			});

			it("should reject LIMIT offset, count (MySQL format)", () => {
				const res = validateSuiteQL("SELECT id FROM customer LIMIT 20, 10;");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject LIMIT count OFFSET offset", () => {
				const res = validateSuiteQL("SELECT id FROM item LIMIT 50 OFFSET 100");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT");
			});

			it("should reject parameterized LIMIT with question mark (LIMIT ?)", () => {
				const res = validateSuiteQL("SELECT id, name FROM customer LIMIT ?");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT/OFFSET");
			});

			it("should reject parameterized LIMIT with named bind variable (LIMIT :pageSize)", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer LIMIT :pageSize",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT/OFFSET");
			});

			it("should reject parameterized LIMIT with positional bind variable (LIMIT $1)", () => {
				const res = validateSuiteQL("SELECT id, name FROM customer LIMIT $1");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT/OFFSET");
			});

			it("should reject parameterized LIMIT count and OFFSET (LIMIT ? OFFSET ?)", () => {
				const res = validateSuiteQL("SELECT id FROM item LIMIT ? OFFSET ?");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LIMIT/OFFSET");
			});

			it("should ignore LIMIT inside string literals and allow query", () => {
				const res = validateSuiteQL(
					"SELECT id, memo FROM customer WHERE memo = 'credit LIMIT 50' FETCH FIRST 5 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should accept valid Oracle SuiteQL FETCH FIRST ROWS ONLY syntax", () => {
				const res = validateSuiteQL(
					"SELECT id, companyname FROM customer FETCH FIRST 10 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should accept Oracle-compliant parameterized FETCH FIRST ? ROWS ONLY", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer FETCH FIRST ? ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should accept Oracle-compliant parameterized FETCH FIRST :limit ROWS ONLY", () => {
				const res = validateSuiteQL(
					"SELECT id, name FROM customer FETCH FIRST :limit ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject parenthesized, parameter bind, and keyword LIMIT variations", () => {
				expect(
					validateSuiteQL("SELECT id FROM customer LIMIT (10)").valid,
				).toBe(false);
				expect(validateSuiteQL("SELECT id FROM customer LIMIT (?)").valid).toBe(
					false,
				);
				expect(
					validateSuiteQL("SELECT id FROM customer LIMIT (:p)").valid,
				).toBe(false);
				expect(
					validateSuiteQL("SELECT id FROM customer LIMIT ($1)").valid,
				).toBe(false);
				expect(
					validateSuiteQL("SELECT id FROM customer LIMIT @param").valid,
				).toBe(false);
				expect(validateSuiteQL("SELECT id FROM customer LIMIT ALL").valid).toBe(
					false,
				);
				expect(
					validateSuiteQL("SELECT id FROM customer LIMIT NULL").valid,
				).toBe(false);
			});

			it("should permit legitimate column alias AS limit without false positive", () => {
				const res = validateSuiteQL(
					"SELECT id, creditlimit AS limit FROM customer FETCH FIRST 10 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject non-Oracle date functions NOW() and CURDATE() with SYSDATE guidance", () => {
				const res1 = validateSuiteQL(
					"SELECT id FROM transaction WHERE trandate >= NOW()",
				);
				expect(res1.valid).toBe(false);
				expect(res1.reason).toContain("SYSDATE");

				const res2 = validateSuiteQL(
					"SELECT id FROM transaction WHERE trandate >= CURDATE()",
				);
				expect(res2.valid).toBe(false);
				expect(res2.reason).toContain("CURRENT_DATE");
			});

			it("should reject non-Oracle null functions IFNULL() and ISNULL() with NVL guidance", () => {
				const res1 = validateSuiteQL(
					"SELECT id, IFNULL(memo, 'N/A') FROM customer",
				);
				expect(res1.valid).toBe(false);
				expect(res1.reason).toContain("NVL");

				const res2 = validateSuiteQL(
					"SELECT id, ISNULL(memo, 'N/A') FROM customer",
				);
				expect(res2.valid).toBe(false);
				expect(res2.reason).toContain("COALESCE");
			});

			it("should reject non-Oracle GROUP_CONCAT() with LISTAGG guidance", () => {
				const res = validateSuiteQL(
					"SELECT entity, GROUP_CONCAT(tranid) FROM transaction GROUP BY entity",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("LISTAGG");
			});

			it("should allow derived table subqueries in FROM clause", () => {
				const res = validateSuiteQL(
					"SELECT line_count, COUNT(*) FROM (SELECT item, COUNT(*) AS line_count FROM transactionline WHERE mainline = 'F' GROUP BY item) t GROUP BY line_count",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject duplicate column aliases in SELECT projection without unique AS alias", () => {
				const res = validateSuiteQL(
					"SELECT t.id, tl.id, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.id = 123 AND tl.mainline = 'F'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Duplicate column alias 'id'");

				const resValid = validateSuiteQL(
					"SELECT t.id AS tran_id, tl.id AS line_id, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.id = 123 AND tl.mainline = 'F'",
				);
				expect(resValid.valid).toBe(true);
			});

			it("should permit transactionline query without mainline filter when filtering by unique line key", () => {
				const res = validateSuiteQL(
					"SELECT tl.custcol_order_status, tl.quantity FROM transactionline tl WHERE tl.transaction = 6981429 AND tl.uniquekey = 46322085",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject non-existent previousline on transactionline", () => {
				const res = validateSuiteQL(
					"SELECT id, previousline FROM transactionline WHERE mainline = 'F'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("previousline");
				expect(res.reason).toContain("createdfrom");
			});

			it("should serve identical queries from in-memory LRU cache", () => {
				const query =
					"SELECT id, entityid FROM customer WHERE isinactive = 'F' ORDER BY id ASC FETCH FIRST 10 ROWS ONLY";
				const res1 = validateSuiteQL(query);
				const res2 = validateSuiteQL(query);
				expect(res1.valid).toBe(true);
				expect(res2).toBe(res1); // exact same cached object reference
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

			it("should exclude CTE virtual table names from physical referenced tables", () => {
				const sql = `
					WITH sales_summary AS (
						SELECT transaction, SUM(amount) AS total FROM transactionline WHERE mainline = 'F' GROUP BY transaction
					)
					SELECT t.id, ss.total
					FROM transaction t
					JOIN sales_summary ss ON t.id = ss.transaction
				`;
				const tables = extractReferencedTables(sql);
				expect(tables).toContain("transaction");
				expect(tables).toContain("transactionline");
				expect(tables).not.toContain("sales_summary");
			});

			it("should extract quoted identifiers and parenthesized tables", () => {
				const sql1 =
					'SELECT t.id, sn.date FROM transaction t JOIN "systemnote" sn ON t.id = sn.recordid';
				expect(extractReferencedTables(sql1)).toContain("systemnote");

				const sql2 =
					"SELECT t.id, sn.date FROM transaction t JOIN (systemnote sn) ON t.id = sn.recordid";
				expect(extractReferencedTables(sql2)).toContain("systemnote");

				const sql3 = "SELECT sn.id, sn.field FROM (systemnote sn)";
				expect(extractReferencedTables(sql3)).toContain("systemnote");
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
				expect(
					hasPaginationClause(
						"SELECT id FROM customer OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY",
					),
				).toBe(true);
				expect(
					hasPaginationClause(
						"SELECT id FROM customer FETCH FIRST ? ROWS ONLY",
					),
				).toBe(true);
				expect(
					hasPaginationClause(
						"SELECT id FROM customer FETCH FIRST :limit ROWS ONLY",
					),
				).toBe(true);
			});

			it("should allow unpaginated queries without error and preserve them without mutation", () => {
				const query =
					"SELECT id, companyname FROM customer WHERE isinactive = 'F'";
				const result = validateSuiteQL(query);
				expect(result.valid).toBe(true);
				expect(result.hasPagination).toBe(false);

				const paginatedQuery =
					"SELECT id, companyname FROM customer FETCH FIRST 50 ROWS ONLY";
				const paginatedResult = validateSuiteQL(paginatedQuery);
				expect(paginatedResult.valid).toBe(true);
				expect(paginatedResult.hasPagination).toBe(true);
			});
		});

		describe("hasMainlineFilter", () => {
			it("should return true when mainline filter is genuinely present in masked SQL", () => {
				const { maskedSql, literals } = maskStringLiterals(
					"SELECT id FROM transactionline WHERE mainline = 'T'",
				);
				expect(hasMainlineFilter(maskedSql, literals)).toBe(true);
			});

			it("should return false when mainline = T is spoofed inside a string literal", () => {
				const { maskedSql, literals } = maskStringLiterals(
					"SELECT id FROM transactionline WHERE memo = 'mainline = T'",
				);
				expect(hasMainlineFilter(maskedSql, literals)).toBe(false);
			});

			it("should return true when both memo literal and genuine mainline filter are present", () => {
				const { maskedSql, literals } = maskStringLiterals(
					"SELECT id FROM transactionline WHERE memo = 'mainline = T' AND tl.mainline = 'F'",
				);
				expect(hasMainlineFilter(maskedSql, literals)).toBe(true);
			});

			it("should reject unquoted identifiers, booleans, and double-quoted memo spoofing", () => {
				const { maskedSql: m1, literals: l1 } = maskStringLiterals(
					'SELECT tl.id FROM transactionline tl WHERE tl.memo = "mainline = T"',
				);
				expect(hasMainlineFilter(m1, l1)).toBe(false);

				const { maskedSql: m2, literals: l2 } = maskStringLiterals(
					"SELECT tl.id FROM transactionline tl WHERE tl.mainline = TOTAL",
				);
				expect(hasMainlineFilter(m2, l2)).toBe(false);

				const { maskedSql: m3, literals: l3 } = maskStringLiterals(
					"SELECT tl.id FROM transactionline tl WHERE tl.mainline = false",
				);
				expect(hasMainlineFilter(m3, l3)).toBe(false);

				const { maskedSql: m4, literals: l4 } = maskStringLiterals(
					"SELECT tl.id FROM transactionline tl WHERE tl.mainline = t.id",
				);
				expect(hasMainlineFilter(m4, l4)).toBe(false);
			});

			it("should accept Yoda syntax and reject mainline expressions outside WHERE/ON clauses", () => {
				const { maskedSql: m1, literals: l1 } = maskStringLiterals(
					"SELECT tl.id FROM transactionline tl WHERE 'T' = tl.mainline",
				);
				expect(hasMainlineFilter(m1, l1)).toBe(true);

				const { maskedSql: m2, literals: l2 } = maskStringLiterals(
					"SELECT tl.id, CASE WHEN tl.mainline = 'T' THEN 1 ELSE 0 END AS flag FROM transactionline tl",
				);
				expect(hasMainlineFilter(m2, l2)).toBe(false);

				const { maskedSql: m3, literals: l3 } = maskStringLiterals(
					"SELECT tl.id FROM transactionline tl ORDER BY (CASE WHEN tl.mainline = 'T' THEN 1 ELSE 0 END)",
				);
				expect(hasMainlineFilter(m3, l3)).toBe(false);
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

			it("should correctly handle FROM inside functions like EXTRACT(YEAR FROM trandate) and reject wildcard", () => {
				const res = validateSuiteQL(
					"SELECT EXTRACT(YEAR FROM trandate), * FROM transaction",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("wildcard projection");

				const resValid = validateSuiteQL(
					"SELECT EXTRACT(YEAR FROM trandate) AS yr, id FROM transaction",
				);
				expect(resValid.valid).toBe(true);
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

				const sumArithRes = validateSuiteQL(
					"SELECT SUM(a * b) AS grand_total FROM item",
				);
				expect(sumArithRes.valid).toBe(true);
			});

			it("should reject quoted alias and parenthesized wildcards", () => {
				expect(validateSuiteQL('SELECT "item".* FROM item').valid).toBe(false);
				expect(validateSuiteQL("SELECT (*) FROM item").valid).toBe(false);
				expect(validateSuiteQL("SELECT (item.*) FROM item").valid).toBe(false);
			});

			it("should reject queries with MySQL/Postgres LIMIT (Gate 2 Syntax Mandate)", () => {
				const res = validateSuiteQL("SELECT id FROM customer LIMIT 10");
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("does not support 'LIMIT/OFFSET'");
			});

			it("should allow Oracle-standard OFFSET pagination", () => {
				const res = validateSuiteQL(
					"SELECT id, tranid FROM transaction WHERE type = 'SalesOrd' OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should not reject column alias named limit (creditlimit AS limit)", () => {
				const res = validateSuiteQL(
					"SELECT id, creditlimit AS limit FROM customer FETCH FIRST 10 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should recognize driving index filters inside JOIN ON clauses", () => {
				const res = validateSuiteQL(
					"SELECT t.id, tl.item FROM transaction t JOIN transactionline tl ON t.id = tl.transaction AND t.type = 'SalesOrd' WHERE tl.mainline = 'F' FETCH FIRST 10 ROWS ONLY",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject createdfrom on transaction header with arbitrary alias like tr", () => {
				const res = validateSuiteQL(
					"SELECT tr.id, tr.createdfrom FROM transaction tr JOIN transactionline tl ON tr.id = tl.transaction WHERE tl.mainline = 'F'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Invalid field location 'createdfrom'");
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

			it("should safely allow queries with line comments (--)", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer -- helpful business note",
				);
				expect(res.valid).toBe(true);
			});

			it("should safely allow queries with block comments (/* */)", () => {
				const res = validateSuiteQL(
					"SELECT /* query index hint */ id FROM customer",
				);
				expect(res.valid).toBe(true);
			});

			it("should not trigger DDL keyword violation from comments mentioning keywords", () => {
				const res = validateSuiteQL(
					"SELECT id FROM customer -- note: do not UPDATE this record",
				);
				expect(res.valid).toBe(true);
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

			it("should reject prohibited SystemNote implicit comma joins", () => {
				const res = validateSuiteQL(
					"SELECT t.id, sn.detail FROM systemnote sn, transaction t WHERE sn.recordid = t.id AND t.id = 1",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Prohibited 'JOIN SystemNote'");
			});

			it("should reject unindexed standalone SystemNote queries without recordid filter", () => {
				const res = validateSuiteQL(
					"SELECT recordid, recordtypeid, field, date FROM systemnote WHERE date >= TO_DATE('2026-09-26', 'YYYY-MM-DD')",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Unindexed 'systemnote' scan");
				expect(res.reason).toContain("netsuite_get_system_notes");
			});

			it("should allow standalone SystemNote queries with recordid filter", () => {
				const res = validateSuiteQL(
					"SELECT sn.id, sn.field, sn.oldvalue, sn.newvalue FROM systemnote sn WHERE sn.recordid = 12345 AND sn.date >= TO_DATE('2026-01-01', 'YYYY-MM-DD')",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject function conversions like TO_NUMBER in JOIN ON clause against transactionline", () => {
				const res = validateSuiteQL(
					"SELECT wo.id FROM transaction wo JOIN transactionline tl_wo ON tl_wo.transaction = wo.id LEFT JOIN transactionline tl_ship ON tl_ship.createdfrom = TO_NUMBER(tl_wo.custcol_link) WHERE wo.type = 'WorkOrd' AND tl_wo.mainline = 'F'",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Performance hazard: Function conversion");
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

			it("should reject transactionline queries where mainline filter is disguised in comments", () => {
				const res = validateSuiteQL(
					"SELECT tl.id, tl.item FROM transactionline tl WHERE tl.transaction = 100 /* tl.mainline = 'F' */",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain(
					"Missing 'mainline' filter on 'transactionline'",
				);
			});

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

			it("should allow transactionline + transaction joins driven by tl.transaction filter", () => {
				const res1 = validateSuiteQL(
					"SELECT tl.transaction, tl.id, tl.item, tl.quantity, t.custbody_vendor_deliv FROM transactionline tl JOIN transaction t ON t.id = tl.transaction WHERE tl.transaction IN (9024545, 9025081) AND tl.mainline = 'F' AND tl.quantity > 0",
				);
				expect(res1.valid).toBe(true);

				const res2 = validateSuiteQL(
					"SELECT tl.createdfrom, t.tranid FROM transactionline tl JOIN transaction t ON t.id = tl.transaction WHERE tl.transaction = 9024545 AND tl.mainline = 'T'",
				);
				expect(res2.valid).toBe(true);
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

			it("should accept inventoryitemlocations when qualified with table alias like i.itemtype = 'InvtPart'", () => {
				const res = validateSuiteQL(
					"SELECT loc.item, loc.quantityonhand FROM inventoryitemlocations loc JOIN item i ON loc.item = i.id WHERE i.itemtype = 'InvtPart'",
				);
				expect(res.valid).toBe(true);
			});

			it("should accept transactionline with aliased mainline filter", () => {
				const res = validateSuiteQL(
					"SELECT tl.item, tl.amount FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE t.type = 'SalesOrd' AND tl.mainline = 'F' AND t.id = 123",
				);
				expect(res.valid).toBe(true);
			});

			it("should reject unindexed aggregation query using HAVING without driving indexed filter in WHERE", () => {
				const res = validateSuiteQL(
					"SELECT entity, SUM(foreigntotal) AS total FROM transaction GROUP BY entity HAVING SUM(foreigntotal) > 5000",
				);
				expect(res.valid).toBe(false);
				expect(res.reason).toContain("Unindexed aggregation query with HAVING");
			});

			it("should allow aggregation query with HAVING when indexed driving filter is present in WHERE", () => {
				const res = validateSuiteQL(
					"SELECT entity, SUM(foreigntotal) AS total FROM transaction WHERE type = 'SalesOrd' AND trandate >= TO_DATE('2025-01-01', 'YYYY-MM-DD') GROUP BY entity HAVING SUM(foreigntotal) > 5000",
				);
				expect(res.valid).toBe(true);
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

			it("should diagnose non-existent table and suggest netsuite_get_metadata", () => {
				const diag = diagnoseSuiteQLError(
					"Record 'nonexistent_tbl' was not found",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Non-Existent or Disabled Table");
				expect(diag.selfHealingAction).toContain(
					"netsuite_get_metadata({ keyword: 'nonexistent_tbl' })",
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

			it("should diagnose unindexed SystemNote scans", () => {
				const diag = diagnoseSuiteQLError(
					"Unindexed 'systemnote' scan: NetSuite 'systemnote' contains tens of millions of audit log records",
					"SELECT date FROM systemnote WHERE date >= SYSDATE - 1",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain(
					"Unindexed Full-Table Scan on SystemNote",
				);
				expect(diag.selfHealingAction).toContain("netsuite_get_system_notes");
			});

			it("should diagnose function conversions in JOIN ON clause", () => {
				const diag = diagnoseSuiteQLError(
					"Function conversion (e.g. TO_NUMBER/TO_CHAR) detected in JOIN ON clause",
					"SELECT wo.id FROM transaction wo LEFT JOIN transactionline tl_ship ON tl_ship.createdfrom = TO_NUMBER(tl_wo.custcol_link)",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Function Conversion in JOIN ON Clause");
			});

			it("should diagnose statement execution timeouts and socket hang ups", () => {
				const diag = diagnoseSuiteQLError(
					"timeout of 60000ms exceeded",
					"SELECT t.id FROM transaction t JOIN transactionline tl ON t.id = tl.transaction",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Statement Execution Timeout");
				expect(diag.officialGuidance).toContain(
					"Add selective indexed filters",
				);
			});

			it("should diagnose the false 'near: FETCH' trap and prevent invalid LIMIT conversion", () => {
				const diag = diagnoseSuiteQLError(
					"Failed to parse sql near: FETCH",
					"SELECT id, bad_column FROM transaction FETCH FIRST 10 ROWS ONLY",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("False 'near: FETCH' Trap");
				expect(diag.officialGuidance).toContain("DO NOT remove 'FETCH FIRST'");
				expect(diag.selfHealingAction).toContain(
					"Keep Oracle-standard pagination",
				);
			});

			it("should diagnose duplicate alias errors", () => {
				const diag = diagnoseSuiteQLError("duplicate alias 'amount'");
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Duplicate Column Alias");
				expect(diag.suggestedFix).toContain("AS tran_id");
			});

			it("should diagnose ambiguous column references in joined tables", () => {
				const diag = diagnoseSuiteQLError("column 'id' is ambiguous column");
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Ambiguous Column Reference");
				expect(diag.selfHealingAction).toContain("Prefix ambiguous column(s)");
			});

			it("should diagnose GROUP BY non-aggregated expression errors", () => {
				const diag = diagnoseSuiteQLError("not a GROUP BY expression");
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Invalid GROUP BY Expression");
				expect(diag.officialGuidance).toContain(
					"Add all non-aggregated SELECT columns",
				);
			});

			it("should diagnose invalid table JOIN relationships", () => {
				const diag = diagnoseSuiteQLError(
					"QUERY_INVALID_JOIN: invalid join between transaction and item",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Invalid Table JOIN");
				expect(diag.selfHealingAction).toContain("netsuite_get_metadata");
			});

			it("should diagnose invalid or unsupported search errors for FROM subqueries and BUILTIN.DF GROUP BY", () => {
				const diag1 = diagnoseSuiteQLError(
					"Search error occurred: Invalid or unsupported search",
					"SELECT line_count, COUNT(*) FROM (SELECT item, COUNT(*) as line_count FROM customrecord_xxx GROUP BY item) t GROUP BY line_count",
				);
				expect(diag1.isDiagnosed).toBe(true);
				expect(diag1.summary).toContain(
					"Unsupported Subquery in FROM/JOIN Clause",
				);
				expect(diag1.suggestedFix).toContain("WITH");

				const diag2 = diagnoseSuiteQLError(
					"Search error occurred: Invalid or unsupported search",
					"SELECT BUILTIN.DF(status) AS lbl, status, COUNT(*) FROM customrecord_xxx GROUP BY status",
				);
				expect(diag2.isDiagnosed).toBe(true);
				expect(diag2.summary).toContain("BUILTIN.DF()");
				expect(diag2.suggestedFix).toContain("GROUP BY");

				const diag3 = diagnoseSuiteQLError(
					"Search error occurred: Invalid or unsupported search",
					"SELECT id FROM customrecord_xxx",
				);
				expect(diag3.isDiagnosed).toBe(true);
				expect(diag3.summary).toContain(
					"Invalid or Unsupported Search Specification",
				);
			});

			it("should diagnose NOT_EXPOSED field errors and provide column hint", () => {
				const diag = diagnoseSuiteQLError(
					"Search error occurred: Field 'lineuniquekey' for record 'transactionLine' was not found. Reason: NOT_EXPOSED - Not available for channel SEARCH",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Field Not Exposed to SuiteQL");
				expect(diag.suggestedFix).toContain("transactionline.uniquekey");
			});

			it("should diagnose permission denied for standard tables reported as 'not found'", () => {
				const diag = diagnoseSuiteQLError(
					"Search error occurred: Record 'subsidiary' was not found.",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain(
					"Permission Denied for Standard Table 'subsidiary'",
				);
				expect(diag.selfHealingAction).toContain("HALT");
			});

			it("should diagnose pseudo metadata tables and guide to netsuite_get_metadata", () => {
				const diag = diagnoseSuiteQLError(
					"Search error occurred: Record 'customfield' was not found.",
				);
				expect(diag.isDiagnosed).toBe(true);
				expect(diag.summary).toContain("Metadata Table 'customfield'");
				expect(diag.selfHealingAction).toContain("netsuite_get_metadata");
			});

			it("should handle unknown generic errors gracefully", () => {
				const diag = diagnoseSuiteQLError("Some bizarre internal error");
				expect(diag.isDiagnosed).toBe(false);
				expect(diag.selfHealingAction).toContain("netsuite_get_metadata");
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

			it("should contain savedsearch, customrecordtype without recordname, and no customfield", () => {
				const searches = searchSuiteQLCatalog("savedsearch");
				expect(searches.some((s) => s.tableName === "savedsearch")).toBe(true);
				const savedsearch = searches.find((s) => s.tableName === "savedsearch");
				expect(savedsearch?.keyFields).toContain("scriptid");
				expect(savedsearch?.keyFields).toContain("name");
				expect(savedsearch?.keyFields).not.toContain("title");

				const customrecord = searchSuiteQLCatalog("customrecordtype").find(
					(c) => c.tableName === "customrecordtype",
				);
				expect(customrecord?.keyFields).toContain("name");
				expect(customrecord?.keyFields).not.toContain("recordname");

				const scriptnote = searchSuiteQLCatalog("scriptnote").find(
					(s) => s.tableName === "scriptnote",
				);
				expect(scriptnote?.keyFields).toContain("internalId");
				expect(scriptnote?.keyFields).not.toContain("id");

				const customfieldMatches = searchSuiteQLCatalog("customfield");
				expect(
					customfieldMatches.some((c) => c.tableName === "customfield"),
				).toBe(false);
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

			it("should display hasMore notice when hasMore is true or at 100 limit", () => {
				const hasMoreResult = {
					hasMore: true,
					data: [{ id: "1", name: "Row 1" }],
				};
				const markdown = formatSuiteQLToCompactMarkdown(hasMoreResult);
				expect(markdown).toContain(
					"safe ceiling applied; additional rows may exist",
				);

				const atLimitResult = {
					data: Array.from({ length: 100 }, (_, i) => ({ id: String(i) })),
				};
				const atLimitMarkdown = formatSuiteQLToCompactMarkdown(atLimitResult);
				expect(atLimitMarkdown).toContain("Query returned 100 rows");
			});

			it("should place truncation notice at the very top when rows exceed 100", () => {
				const largeResult = {
					data: Array.from({ length: 105 }, (_, i) => ({
						id: String(i + 1),
						name: `Item ${i + 1}`,
					})),
				};

				const markdown = formatSuiteQLToCompactMarkdown(largeResult);
				expect(
					markdown.startsWith(
						"> ⚠️ **Notice**: Result truncated to top 100 of 105 rows.",
					),
				).toBe(true);
				expect(markdown).toContain("| id | name |");
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

			const deploymentUrl = generateNetSuiteUrl(
				"123456",
				"scriptdeployment",
				"10",
			);
			expect(deploymentUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/scriptdeployment.nl?id=10",
			);

			const deployAliasUrl = generateNetSuiteUrl("123456", "deployment", "10");
			expect(deployAliasUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/scriptdeployment.nl?id=10",
			);

			const ueUrl = generateNetSuiteUrl("123456", "usereventscript", "55");
			expect(ueUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/script.nl?id=55",
			);

			const suiteletRecordUrl = generateNetSuiteUrl("123456", "suitelet", "77");
			expect(suiteletRecordUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/script.nl?id=77",
			);

			const classUrl = generateNetSuiteUrl("123456", "classification", "3");
			expect(classUrl).toBe(
				"https://123456.app.netsuite.com/app/common/other/classification.nl?id=3",
			);

			const classShortUrl = generateNetSuiteUrl("123456", "class", "3");
			expect(classShortUrl).toBe(
				"https://123456.app.netsuite.com/app/common/other/classification.nl?id=3",
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

		it("should return null deterministically if record type is unmapped", () => {
			const fallbackUrl = generateNetSuiteUrl("123456", "unknown_type", "888");
			expect(fallbackUrl).toBeNull();
		});

		it("should resolve file cabinet, customization, and workflow URLs accurately", () => {
			const folderUrl = generateNetSuiteUrl("123456", "folder", "42");
			expect(folderUrl).toBe(
				"https://123456.app.netsuite.com/app/common/media/mediaitemfolders.nl?folder=42",
			);

			const fileUrl = generateNetSuiteUrl("123456", "file", "108");
			expect(fileUrl).toBe(
				"https://123456.app.netsuite.com/app/common/media/mediaitem.nl?id=108",
			);

			const customRecordTypeUrl = generateNetSuiteUrl(
				"123456",
				"customrecordtype",
				"999",
			);
			expect(customRecordTypeUrl).toBe(
				"https://123456.app.netsuite.com/app/common/custom/custrecord.nl?id=999",
			);

			const workflowUrl = generateNetSuiteUrl("123456", "workflow", "15");
			expect(workflowUrl).toBe(
				"https://123456.app.netsuite.com/app/common/workflow/setup/nextgen/workflowdesktop.nl?id=15",
			);
		});

		it("should generate NetSuite script file editor direct link", () => {
			expect(generateNetSuiteScriptFileUrl(undefined, "123")).toBeNull();
			expect(generateNetSuiteScriptFileUrl("123456", undefined)).toBeNull();
			expect(generateNetSuiteScriptFileUrl("123456", "")).toBeNull();

			const scriptFileUrl = generateNetSuiteScriptFileUrl("123456_SB1", "2048");
			expect(scriptFileUrl).toBe(
				"https://123456-sb1.app.netsuite.com/app/common/record/edittextmediaitem.nl?id=2048&e=T&l=T&target=filesize&syntaxHighlighting=T",
			);
		});

		it("should generate NetSuite Suitelet execution and script helper URLs", () => {
			expect(generateNetSuiteSuiteletUrl(undefined, "s1", "d1")).toBeNull();
			expect(generateNetSuiteSuiteletUrl("123456", undefined, "d1")).toBeNull();
			expect(generateNetSuiteSuiteletUrl("123456", "s1", undefined)).toBeNull();
			expect(generateNetSuiteSuiteletUrl("123456", "", "d1")).toBeNull();

			const suiteletUrl = generateNetSuiteSuiteletUrl(
				"9260916-SB1",
				"customscript_my_sl",
				"customdeploy_my_sl",
			);
			expect(suiteletUrl).toBe(
				"https://9260916-sb1.app.netsuite.com/app/site/hosting/scriptlet.nl?script=customscript_my_sl&deploy=customdeploy_my_sl",
			);

			const deployHelperUrl = generateNetSuiteScriptDeploymentUrl(
				"123456",
				"42",
			);
			expect(deployHelperUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/scriptdeployment.nl?id=42",
			);

			const scriptHelperUrl = generateNetSuiteScriptUrl("123456", "88");
			expect(scriptHelperUrl).toBe(
				"https://123456.app.netsuite.com/app/common/scripting/script.nl?id=88",
			);
		});
	});
});
