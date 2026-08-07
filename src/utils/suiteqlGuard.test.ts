import {
	assertValidSuiteQL,
	SuiteQLValidationError,
	validateSuiteQL,
} from "./suiteqlGuard.js";

describe("suiteqlGuard", () => {
	describe("validateSuiteQL", () => {
		it("should validate a simple valid SELECT query", () => {
			const res = validateSuiteQL(
				"SELECT id, name FROM customer WHERE isinactive = 'F'",
			);
			expect(res.valid).toBe(true);
			expect(res.reason).toBeUndefined();
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
