import { describe, expect, it } from "vitest";
import {
	assertValidSuiteQL,
	ensureSuiteQLPagination,
	extractReferencedTables,
	hasPaginationClause,
	maskStringLiterals,
	SuiteQLValidationError,
	validateSuiteQL,
} from "./suiteqlGuard.js";

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
			const sql = "SELECT id FROM Customer WHERE memo = 'JOIN Transaction NOW'";
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
				hasPaginationClause("SELECT id FROM customer FETCH FIRST 50 ROWS ONLY"),
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
			const res = validateSuiteQL("SELECT * FROM transaction;");
			expect(res.valid).toBe(true);
		});

		it("should validate a valid CTE (WITH statement) query", () => {
			const res = validateSuiteQL(
				"WITH c AS (SELECT id FROM customer) SELECT * FROM c",
			);
			expect(res.valid).toBe(true);
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
	});
});
