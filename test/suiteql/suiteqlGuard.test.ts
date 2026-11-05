import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertValidSuiteQL,
	splitSuiteQLStatements,
	validateSuiteQL,
} from "../../src/utils/suiteqlGuard.js";

describe("SuiteQL Guardrail & Rule Engine", () => {
	describe("1. Valid SuiteQL Golden Queries", () => {
		it("allows standard single table query with Oracle pagination", () => {
			const sql =
				"SELECT id, entityid, companyname, email FROM customer WHERE isinactive = 'F' FETCH FIRST 10 ROWS ONLY";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
			assert.strictEqual(res.errors.length, 0);
			assert.deepStrictEqual(res.tables, ["customer"]);
			assert.strictEqual(res.hasPagination, true);
		});

		it("allows joined transaction and transactionline with mainline = 'F'", () => {
			const sql = `
				SELECT t.id, t.tranid, tl.linesequencenumber, tl.item, tl.amount
				FROM transaction t
				JOIN transactionline tl ON t.id = tl.transaction
				WHERE t.type = 'SalesOrd' AND tl.mainline = 'F'
				FETCH FIRST 25 ROWS ONLY
			`;
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
			assert.strictEqual(res.errors.length, 0);
			assert.ok(res.tables.includes("transaction"));
			assert.ok(res.tables.includes("transactionline"));
		});

		it("allows CTE (Common Table Expression) with aggregation and BUILTIN.DF", () => {
			const sql = `
				WITH monthly_sales AS (
					SELECT tl.item, SUM(tl.amount) AS total_amt
					FROM transaction t
					JOIN transactionline tl ON t.id = tl.transaction
					WHERE t.type = 'SalesOrd' AND tl.mainline = 'F'
					GROUP BY tl.item
				)
				SELECT ms.item, ms.total_amt, BUILTIN.DF(ms.item) AS item_name
				FROM monthly_sales ms
				FETCH FIRST 20 ROWS ONLY
			`;
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
			assert.strictEqual(res.errors.length, 0);
		});

		it("allows scalar subqueries in SELECT projection without premature truncation", () => {
			const sql = `
				SELECT t.id, t.tranid,
					(SELECT COUNT(*) FROM transactionline tl WHERE tl.transaction = t.id AND tl.mainline = 'F') AS line_count
				FROM transaction t
				WHERE t.type = 'CustInvc'
				FETCH FIRST 10 ROWS ONLY
			`;
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
			assert.strictEqual(res.errors.length, 0);
		});

		it("allows standalone systemnote query by recordid", () => {
			const sql =
				"SELECT id, recordid, field, date, direction FROM systemnote WHERE recordid = 12345 ORDER BY date DESC FETCH FIRST 50 ROWS ONLY";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
		});
	});

	describe("2. Security & Anti-Injection Guardrails", () => {
		it("blocks queries not starting with SELECT or WITH", () => {
			const sql = "UPDATE customer SET isinactive = 'T' WHERE id = 1";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "sec-start-with-select-or-with"),
			);
		});

		it("blocks DDL / mutation statements", () => {
			const sql = "DROP TABLE customer";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(res.errors.some((e) => e.ruleId === "sec-read-only-only"));
		});

		it("blocks multi-statement injection separated by semicolons", () => {
			const sql = "SELECT id FROM customer; SELECT id, tranid FROM transaction";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(res.errors.some((e) => e.ruleId === "sec-no-multi-statements"));
		});
	});

	describe("3. SAFE Guide Compliance Guardrails", () => {
		it("blocks SELECT * wildcard projection", () => {
			const sql = "SELECT * FROM transaction FETCH FIRST 10 ROWS ONLY";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(res.errors.some((e) => e.ruleId === "safe-no-wildcards"));
		});

		it("blocks table alias wildcard projection (t.*)", () => {
			const sql =
				"SELECT t.*, tl.id FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE tl.mainline = 'F'";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(res.errors.some((e) => e.ruleId === "safe-no-wildcards"));
		});

		it("blocks transactionline queries missing mainline filter", () => {
			const sql =
				"SELECT id, item, quantity FROM transactionline FETCH FIRST 10 ROWS ONLY";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "safe-transactionline-mainline"),
			);
		});

		it("blocks multi-table JOIN involving systemnote (SAFE Pitfall 11)", () => {
			const sql =
				"SELECT s.id, t.tranid FROM systemnote s JOIN transaction t ON s.recordid = t.id";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "safe-prohibit-systemnote-join"),
			);
		});

		it("blocks derived tables in FROM / JOIN, guiding to CTE", () => {
			const sql =
				"SELECT sub.id FROM (SELECT id FROM transaction WHERE type = 'SalesOrd') sub";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "safe-no-derived-tables-in-from"),
			);
		});

		it("blocks BUILTIN.DF in GROUP BY query without CTE", () => {
			const sql =
				"SELECT entity, BUILTIN.DF(entity) AS customer_name, COUNT(*) FROM transaction GROUP BY entity";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "safe-group-by-builtin-df"),
			);
		});
	});

	describe("4. Schema Invariant Guardrails", () => {
		it("blocks item.recordtype hallucination", () => {
			const sql =
				"SELECT id, itemid, recordtype FROM item WHERE isinactive = 'F'";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "schema-item-no-recordtype"),
			);
		});

		it("blocks transaction.createdfrom hallucination", () => {
			const sql =
				"SELECT t.id, t.tranid, t.createdfrom FROM transaction t WHERE t.type = 'CustInvc'";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some(
					(e) => e.ruleId === "schema-transaction-no-createdfrom",
				),
			);
		});

		it("blocks duplicate column alias in SELECT projection", () => {
			const sql =
				"SELECT t.id AS record_id, tl.id AS record_id FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE tl.mainline = 'F'";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "schema-unique-projection-aliases"),
			);
		});
	});

	describe("5. Oracle Dialect Guardrails", () => {
		it("blocks MySQL LIMIT keyword, guiding to FETCH FIRST", () => {
			const sql = "SELECT id, tranid FROM transaction LIMIT 10";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "dialect-oracle-pagination"),
			);
		});

		it("blocks non-Oracle date functions (NOW())", () => {
			const sql = "SELECT id FROM transaction WHERE trandate >= NOW() - 30";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "dialect-oracle-date-functions"),
			);
		});

		it("blocks non-Oracle NULL functions (IFNULL())", () => {
			const sql = "SELECT id, IFNULL(memo, 'No memo') FROM transaction";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "dialect-oracle-null-functions"),
			);
		});

		it("blocks bare boolean literals (true/false) on ERP columns", () => {
			const sql = "SELECT id FROM customer WHERE isinactive = false";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "dialect-oracle-boolean-literals"),
			);
		});

		it("blocks string concatenation with + operator", () => {
			const sql =
				"SELECT id, 'Invoice #' + tranid AS full_title FROM transaction";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.ok(
				res.errors.some((e) => e.ruleId === "dialect-oracle-string-concat"),
			);
		});
	});

	describe("6. Multi-Diagnostic Reporting (Single-Turn Recovery)", () => {
		it("collects all errors simultaneously when a query has multiple violations", () => {
			// Contains BOTH SELECT * AND missing mainline on transactionline
			const sql = "SELECT * FROM transactionline";
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, false);
			assert.strictEqual(res.errors.length >= 2, true);

			const ruleIds = res.errors.map((e) => e.ruleId);
			assert.ok(ruleIds.includes("safe-no-wildcards"));
			assert.ok(ruleIds.includes("safe-transactionline-mainline"));
			assert.ok(res.reason?.includes("Multiple SuiteQL Guardrail Violations"));
		});
	});

	describe("7. Lexer & Comment/Literal Robustness", () => {
		it("handles apostrophes inside line comments without corrupting parsing", () => {
			const sql = `
				SELECT id, tranid -- customer's order lookup
				FROM transaction
				FETCH FIRST 5 ROWS ONLY
			`;
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
		});

		it("handles double-dash inside string literals without treating it as a comment", () => {
			const sql = `
				SELECT id, tranid, 'item -- line note' AS note
				FROM transaction
				FETCH FIRST 5 ROWS ONLY
			`;
			const res = validateSuiteQL(sql);
			assert.strictEqual(res.valid, true);
		});

		it("correctly splits multiple statements using splitSuiteQLStatements", () => {
			const multi = `
				SELECT id FROM customer FETCH FIRST 5 ROWS ONLY;
				SELECT id, tranid FROM transaction WHERE memo = 'a;b;c' FETCH FIRST 5 ROWS ONLY
			`;
			const stmts = splitSuiteQLStatements(multi);
			assert.strictEqual(stmts.length, 2);
			assert.ok(stmts[0]?.includes("customer"));
			assert.ok(stmts[1]?.includes("transaction"));
			assert.ok(stmts[1]?.includes("a;b;c"));
		});
	});

	describe("8. assertValidSuiteQL Exception Throwing", () => {
		it("throws SuiteQLValidationError on invalid query", () => {
			assert.throws(
				() => {
					assertValidSuiteQL("SELECT * FROM customer");
				},
				{
					name: "SuiteQLValidationError",
					message: /SuiteQL Security Guardrail Violation/,
				},
			);
		});

		it("does not throw on valid query", () => {
			assert.doesNotThrow(() => {
				assertValidSuiteQL("SELECT id FROM customer FETCH FIRST 1 ROWS ONLY");
			});
		});
	});
});
