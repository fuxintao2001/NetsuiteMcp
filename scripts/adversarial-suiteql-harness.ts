/**
 * Adversarial Empirical Stress Test Harness for SuiteQL AST & Security Guardrails
 * 
 * Challenges `src/utils/suiteqlGuard.ts` across 5 adversarial dimensions:
 * 1. Parameterized & non-standard LIMIT pagination dialects
 * 2. Mainline filter literal spoofing, unquoted identifier bypasses, and scope flaws
 * 3. Comment disguise attempts, comment interleaving, and comment leakage false positives
 * 4. SAFE Pitfall 11 SystemNote join variations, quoted table bypasses, and unindexed scans
 * 5. Wildcard projection evasions vs. legitimate arithmetic/aggregate expressions
 */

import { validateSuiteQL, SuiteQLValidationResult } from "../src/utils/suiteqlGuard.js";

interface TestCase {
	id: string;
	category: string;
	description: string;
	sql: string;
	expectedValid: boolean;
	vulnerabilityTag?: string;
}

const testCases: TestCase[] = [
	// =========================================================================
	// Category 1: Parameterized & Non-Standard LIMIT Variations
	// =========================================================================
	{
		id: "LIMIT-01",
		category: "LIMIT Dialect",
		description: "Standard bare LIMIT with numeric count",
		sql: "SELECT id, companyname FROM customer LIMIT 10",
		expectedValid: false,
	},
	{
		id: "LIMIT-02",
		category: "LIMIT Dialect",
		description: "Parameterized LIMIT with positional question mark (LIMIT ?)",
		sql: "SELECT id, companyname FROM customer LIMIT ?",
		expectedValid: false,
	},
	{
		id: "LIMIT-03",
		category: "LIMIT Dialect",
		description: "Parameterized LIMIT with named bind variable (LIMIT :param)",
		sql: "SELECT id, companyname FROM customer LIMIT :param",
		expectedValid: false,
	},
	{
		id: "LIMIT-04",
		category: "LIMIT Dialect",
		description: "Parameterized LIMIT with short bind variable (LIMIT :p)",
		sql: "SELECT id, companyname FROM customer LIMIT :p",
		expectedValid: false,
	},
	{
		id: "LIMIT-05",
		category: "LIMIT Dialect",
		description: "Parameterized LIMIT with Postgres bind variable (LIMIT $1)",
		sql: "SELECT id, companyname FROM customer LIMIT $1",
		expectedValid: false,
	},
	{
		id: "LIMIT-06",
		category: "LIMIT Dialect",
		description: "Parameterized LIMIT and OFFSET (LIMIT ? OFFSET ?)",
		sql: "SELECT id, companyname FROM customer LIMIT ? OFFSET ?",
		expectedValid: false,
	},
	{
		id: "LIMIT-07",
		category: "LIMIT Dialect",
		description: "MySQL comma-style LIMIT (LIMIT 20, 10)",
		sql: "SELECT id, companyname FROM customer LIMIT 20, 10",
		expectedValid: false,
	},
	{
		id: "LIMIT-08",
		category: "LIMIT Dialect",
		description: "Parenthesized numeric LIMIT: LIMIT (10)",
		sql: "SELECT id, companyname FROM customer LIMIT (10)",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-PAREN",
	},
	{
		id: "LIMIT-09",
		category: "LIMIT Dialect",
		description: "Parenthesized parameterized LIMIT: LIMIT (?)",
		sql: "SELECT id, companyname FROM customer LIMIT (?)",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-PAREN-PARAM",
	},
	{
		id: "LIMIT-10",
		category: "LIMIT Dialect",
		description: "Parenthesized named variable: LIMIT (:p)",
		sql: "SELECT id, companyname FROM customer LIMIT (:p)",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-PAREN-NAMED",
	},
	{
		id: "LIMIT-11",
		category: "LIMIT Dialect",
		description: "Parenthesized positional variable: LIMIT ($1)",
		sql: "SELECT id, companyname FROM customer LIMIT ($1)",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-PAREN-POS",
	},
	{
		id: "LIMIT-12",
		category: "LIMIT Dialect",
		description: "User session variable: LIMIT @param",
		sql: "SELECT id, companyname FROM customer LIMIT @param",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-USER-VAR",
	},
	{
		id: "LIMIT-13",
		category: "LIMIT Dialect",
		description: "Postgres LIMIT ALL syntax",
		sql: "SELECT id, companyname FROM customer LIMIT ALL",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-ALL",
	},
	{
		id: "LIMIT-14",
		category: "LIMIT Dialect",
		description: "Postgres LIMIT NULL syntax",
		sql: "SELECT id, companyname FROM customer LIMIT NULL",
		expectedValid: false,
		vulnerabilityTag: "VULN-LIMIT-NULL",
	},
	{
		id: "LIMIT-15",
		category: "LIMIT Dialect",
		description: "Negative Control: Legitimate column alias named limit (creditlimit AS limit)",
		sql: "SELECT id, creditlimit AS limit FROM customer FETCH FIRST 10 ROWS ONLY",
		expectedValid: true,
	},
	{
		id: "LIMIT-16",
		category: "LIMIT Dialect",
		description: "Negative Control: Oracle FETCH FIRST ? ROWS ONLY",
		sql: "SELECT id, companyname FROM customer FETCH FIRST ? ROWS ONLY",
		expectedValid: true,
	},
	{
		id: "LIMIT-17",
		category: "LIMIT Dialect",
		description: "Negative Control: Oracle FETCH FIRST :param ROWS ONLY",
		sql: "SELECT id, companyname FROM customer FETCH FIRST :param ROWS ONLY",
		expectedValid: true,
	},

	// =========================================================================
	// Category 2: Mainline Literal Spoofing & Scope Flaws
	// =========================================================================
	{
		id: "MAINLINE-01",
		category: "Mainline Guard",
		description: "Single quote memo literal: memo = 'mainline = T'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'mainline = T'",
		expectedValid: false,
	},
	{
		id: "MAINLINE-02",
		category: "Mainline Guard",
		description: "Double quote memo literal spoofing: memo = \"mainline = T\"",
		sql: 'SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = "mainline = T"',
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-DOUBLE-QUOTE-SPOOF",
	},
	{
		id: "MAINLINE-03",
		category: "Mainline Guard",
		description: "Escaped quote memo literal: memo = 'tl.mainline = ''T'''",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'tl.mainline = ''T'''",
		expectedValid: false,
	},
	{
		id: "MAINLINE-04",
		category: "Mainline Guard",
		description: "Multiple fake literals: memo1 = 'mainline = T' AND memo2 = 'mainline = F'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'mainline = T' AND tl.memo2 = 'mainline = F'",
		expectedValid: false,
	},
	{
		id: "MAINLINE-05",
		category: "Mainline Guard",
		description: "Multiline memo literal: memo = 'line1\\nmainline = T\\nline2'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'line1\nmainline = T\nline2'",
		expectedValid: false,
	},
	{
		id: "MAINLINE-06",
		category: "Mainline Guard",
		description: "Mainline compared to column starting with t: tl.mainline = t.id",
		sql: "SELECT tl.id FROM transactionline tl WHERE tl.mainline = t.id",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-IDENTIFIER-T-ID",
	},
	{
		id: "MAINLINE-07",
		category: "Mainline Guard",
		description: "Mainline compared to unquoted boolean: tl.mainline = false",
		sql: "SELECT tl.id FROM transactionline tl WHERE tl.mainline = false",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-UNQUOTED-BOOLEAN",
	},
	{
		id: "MAINLINE-08",
		category: "Mainline Guard",
		description: "Mainline compared to identifier starting with T: tl.mainline = TOTAL",
		sql: "SELECT tl.id FROM transactionline tl WHERE tl.mainline = TOTAL",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-IDENTIFIER-TOTAL",
	},
	{
		id: "MAINLINE-09",
		category: "Mainline Guard",
		description: "Mainline compared to identifier starting with T: tl.mainline = TARGET",
		sql: "SELECT tl.id FROM transactionline tl WHERE tl.mainline = TARGET",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-IDENTIFIER-TARGET",
	},
	{
		id: "MAINLINE-10",
		category: "Mainline Guard",
		description: "Mainline compared to self transaction column: tl.mainline = tl.transaction",
		sql: "SELECT tl.id FROM transactionline tl WHERE tl.mainline = tl.transaction",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-IDENTIFIER-TL-TRAN",
	},
	{
		id: "MAINLINE-11",
		category: "Mainline Guard",
		description: "Mainline in SELECT projection without WHERE filter: SELECT tl.id, CASE WHEN tl.mainline = 'T' THEN 1 END FROM transactionline tl",
		sql: "SELECT tl.id, CASE WHEN tl.mainline = 'T' THEN 1 ELSE 0 END AS flag FROM transactionline tl",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-SELECT-PROJECTION-SCOPE",
	},
	{
		id: "MAINLINE-12",
		category: "Mainline Guard",
		description: "Mainline in ORDER BY clause without WHERE filter: ORDER BY (CASE WHEN tl.mainline = 'T' THEN 1 END)",
		sql: "SELECT tl.id FROM transactionline tl ORDER BY (CASE WHEN tl.mainline = 'T' THEN 1 ELSE 0 END)",
		expectedValid: false,
		vulnerabilityTag: "VULN-MAINLINE-ORDER-BY-SCOPE",
	},
	{
		id: "MAINLINE-13",
		category: "Mainline Guard",
		description: "Negative Control: Legitimate header summary filter tl.mainline = 'T'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.mainline = 'T'",
		expectedValid: true,
	},
	{
		id: "MAINLINE-14",
		category: "Mainline Guard",
		description: "Negative Control: Legitimate line items filter tl.mainline = 'F'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.mainline = 'F'",
		expectedValid: true,
	},
	{
		id: "MAINLINE-15",
		category: "Mainline Guard",
		description: "Negative Control: Memo literal present alongside genuine tl.mainline = 'F'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.memo = 'mainline = T' AND tl.mainline = 'F'",
		expectedValid: true,
	},
	{
		id: "MAINLINE-16",
		category: "Mainline Guard",
		description: "Negative Control: Parenthesized genuine filter (tl.mainline = 'T')",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE (tl.mainline = 'T')",
		expectedValid: true,
	},

	// =========================================================================
	// Category 3: Comment Disguise & Interleaving Attempts
	// =========================================================================
	{
		id: "COMMENT-01",
		category: "Comment Disguise",
		description: "Disguised mainline in block comment: /* tl.mainline = 'T' */",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.id = 100 /* tl.mainline = 'T' */",
		expectedValid: false,
	},
	{
		id: "COMMENT-02",
		category: "Comment Disguise",
		description: "Disguised mainline in single line comment: -- tl.mainline = 'T'",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.id = 100 -- tl.mainline = 'T'",
		expectedValid: false,
	},
	{
		id: "COMMENT-03",
		category: "Comment Disguise",
		description: "Disguised mainline in Oracle optimizer hint comment: /*+ INDEX(tl) tl.mainline = 'T' */",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.id = 100 /*+ INDEX(tl) tl.mainline = 'T' */",
		expectedValid: false,
	},
	{
		id: "COMMENT-04",
		category: "Comment Disguise",
		description: "Disguised driving filter in AP6 comment: /* type = 'SalesOrd' */ bypassing unindexed join check",
		sql: "SELECT t.id, tl.amount FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE tl.mainline = 'F' /* type = 'SalesOrd' */",
		expectedValid: false,
		vulnerabilityTag: "VULN-COMMENT-AP6-UNINDEXED-BYPASS",
	},
	{
		id: "COMMENT-05",
		category: "Comment Disguise",
		description: "Disguised driving filter in AP7 comment: /* trandate >= '2025-01-01' */ bypassing HAVING check",
		sql: "SELECT entity, SUM(foreigntotal) AS total FROM transaction /* trandate >= TO_DATE('2025-01-01') */ GROUP BY entity HAVING SUM(foreigntotal) > 5000",
		expectedValid: false,
		vulnerabilityTag: "VULN-COMMENT-AP7-HAVING-BYPASS",
	},
	{
		id: "COMMENT-06",
		category: "Comment Disguise",
		description: "False Positive Check: Benign comment mentioning TO_CHAR(x) in JOIN clause (AP8)",
		sql: "SELECT t.id FROM transaction t JOIN transactionline tl ON tl.transaction = t.id /* TO_CHAR(x) removed */ WHERE t.type = 'SalesOrd' AND tl.mainline = 'F'",
		expectedValid: true,
		vulnerabilityTag: "FP-COMMENT-AP8-FUNCTION-CONVERSION",
	},
	{
		id: "COMMENT-07",
		category: "Comment Disguise",
		description: "False Positive Check: Benign comment mentioning createdfrom in transaction query (AP2)",
		sql: "SELECT t.id FROM transaction t JOIN transactionline tl ON t.id = tl.transaction WHERE tl.createdfrom = 123 AND tl.mainline = 'T' /* t.createdfrom does not exist */",
		expectedValid: true,
		vulnerabilityTag: "FP-COMMENT-AP2-CREATEDFROM",
	},
	{
		id: "COMMENT-08",
		category: "Comment Disguise",
		description: "False Positive Check: Benign comment mentioning recordtype in item query (AP5)",
		sql: "SELECT i.id, i.itemid FROM item i /* do not use recordtype */ WHERE i.itemtype = 'InvtPart'",
		expectedValid: true,
		vulnerabilityTag: "FP-COMMENT-AP5-RECORDTYPE",
	},
	{
		id: "COMMENT-09",
		category: "Comment Disguise",
		description: "Negative Control: Legitimate comments interleaved inside genuine mainline clause",
		sql: "SELECT tl.id, tl.item FROM transactionline tl WHERE tl.mainline /* safe */ = /* verified */ 'T'",
		expectedValid: true,
	},

	// =========================================================================
	// Category 4: SAFE Pitfall 11 SystemNote Joins & Scans
	// =========================================================================
	{
		id: "SYSNOTE-01",
		category: "Pitfall 11 SystemNote",
		description: "Standard ANSI INNER JOIN on SystemNote",
		sql: "SELECT t.id, sn.date FROM transaction t INNER JOIN systemnote sn ON t.id = sn.recordid",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-02",
		category: "Pitfall 11 SystemNote",
		description: "ANSI LEFT JOIN on SystemNote",
		sql: "SELECT t.id, sn.date FROM transaction t LEFT JOIN systemnote sn ON t.id = sn.recordid",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-03",
		category: "Pitfall 11 SystemNote",
		description: "ANSI RIGHT JOIN on SystemNote",
		sql: "SELECT t.id, sn.date FROM transaction t RIGHT JOIN systemnote sn ON t.id = sn.recordid",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-04",
		category: "Pitfall 11 SystemNote",
		description: "ANSI FULL OUTER JOIN on SystemNote",
		sql: "SELECT t.id, sn.date FROM transaction t FULL OUTER JOIN systemnote sn ON t.id = sn.recordid",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-05",
		category: "Pitfall 11 SystemNote",
		description: "ANSI CROSS JOIN on SystemNote",
		sql: "SELECT t.id, sn.date FROM transaction t CROSS JOIN systemnote sn",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-06",
		category: "Pitfall 11 SystemNote",
		description: "ANSI NATURAL JOIN on SystemNote",
		sql: "SELECT t.id, sn.date FROM transaction t NATURAL JOIN systemnote sn",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-07",
		category: "Pitfall 11 SystemNote",
		description: "Implicit 2-table comma join: FROM systemnote sn, transaction t",
		sql: "SELECT t.id, sn.date FROM systemnote sn, transaction t WHERE sn.recordid = t.id",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-08",
		category: "Pitfall 11 SystemNote",
		description: "Implicit 3-table comma join: FROM transaction t, transactionline tl, systemnote sn",
		sql: "SELECT sn.id FROM transaction t, transactionline tl, systemnote sn WHERE t.id = tl.transaction AND sn.recordid = t.id",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-09",
		category: "Pitfall 11 SystemNote",
		description: "Quoted identifier join: JOIN \"systemnote\" sn",
		sql: 'SELECT t.id, sn.date FROM transaction t JOIN "systemnote" sn ON t.id = sn.recordid',
		expectedValid: false,
		vulnerabilityTag: "VULN-SYSNOTE-QUOTED-JOIN",
	},
	{
		id: "SYSNOTE-10",
		category: "Pitfall 11 SystemNote",
		description: "Parenthesized table join: JOIN (systemnote sn)",
		sql: "SELECT t.id, sn.date FROM transaction t JOIN (systemnote sn) ON t.id = sn.recordid",
		expectedValid: false,
		vulnerabilityTag: "VULN-SYSNOTE-PAREN-JOIN",
	},
	{
		id: "SYSNOTE-11",
		category: "Pitfall 11 SystemNote",
		description: "Parenthesized standalone SystemNote scan without recordid: FROM (systemnote sn)",
		sql: "SELECT sn.id, sn.field FROM (systemnote sn)",
		expectedValid: false,
		vulnerabilityTag: "VULN-SYSNOTE-PAREN-STANDALONE-SCAN",
	},
	{
		id: "SYSNOTE-12",
		category: "Pitfall 11 SystemNote",
		description: "Standalone SystemNote unindexed scan (missing recordid filter)",
		sql: "SELECT recordid, field, date FROM systemnote WHERE date >= TO_DATE('2026-01-01', 'YYYY-MM-DD')",
		expectedValid: false,
	},
	{
		id: "SYSNOTE-13",
		category: "Pitfall 11 SystemNote",
		description: "Negative Control: Legitimate standalone SystemNote query with indexed recordid filter",
		sql: "SELECT recordid, field, oldvalue, newvalue FROM systemnote WHERE recordid = 12345 AND date >= TO_DATE('2026-01-01', 'YYYY-MM-DD')",
		expectedValid: true,
	},

	// =========================================================================
	// Category 5: Wildcard Projections vs. Legitimate Expressions
	// =========================================================================
	{
		id: "WILDCARD-01",
		category: "Wildcard Projection",
		description: "Bare wildcard: SELECT * FROM customer",
		sql: "SELECT * FROM customer",
		expectedValid: false,
	},
	{
		id: "WILDCARD-02",
		category: "Wildcard Projection",
		description: "Aliased table wildcard: SELECT c.* FROM customer c",
		sql: "SELECT c.* FROM customer c",
		expectedValid: false,
	},
	{
		id: "WILDCARD-03",
		category: "Wildcard Projection",
		description: "Mixed column and aliased wildcard: SELECT id, c.* FROM customer c",
		sql: "SELECT id, c.* FROM customer c",
		expectedValid: false,
	},
	{
		id: "WILDCARD-04",
		category: "Wildcard Projection",
		description: "Quoted table alias wildcard: SELECT \"item\".* FROM item",
		sql: 'SELECT "item".* FROM item',
		expectedValid: false,
		vulnerabilityTag: "VULN-WILDCARD-QUOTED-ALIAS",
	},
	{
		id: "WILDCARD-05",
		category: "Wildcard Projection",
		description: "Parenthesized bare wildcard: SELECT (*) FROM item",
		sql: "SELECT (*) FROM item",
		expectedValid: false,
		vulnerabilityTag: "VULN-WILDCARD-PAREN-BARE",
	},
	{
		id: "WILDCARD-06",
		category: "Wildcard Projection",
		description: "Parenthesized aliased wildcard: SELECT (item.*) FROM item",
		sql: "SELECT (item.*) FROM item",
		expectedValid: false,
		vulnerabilityTag: "VULN-WILDCARD-PAREN-ALIAS",
	},
	{
		id: "WILDCARD-07",
		category: "Wildcard Projection",
		description: "Negative Control: Aggregate COUNT(*) expression",
		sql: "SELECT COUNT(*) AS total FROM customer",
		expectedValid: true,
	},
	{
		id: "WILDCARD-08",
		category: "Wildcard Projection",
		description: "Negative Control: Arithmetic multiplication without wildcard",
		sql: "SELECT a.rate * a.quantity AS total FROM transactionline a WHERE a.mainline = 'F'",
		expectedValid: true,
	},
	{
		id: "WILDCARD-09",
		category: "Wildcard Projection",
		description: "Negative Control: Aggregate SUM with multiplication",
		sql: "SELECT SUM(a * b) AS grand_total FROM item",
		expectedValid: true,
	},
	{
		id: "WILDCARD-10",
		category: "Wildcard Projection",
		description: "Negative Control: EXTRACT(YEAR FROM date) function with valid columns",
		sql: "SELECT EXTRACT(YEAR FROM trandate) AS yr, id FROM transaction WHERE type = 'SalesOrd'",
		expectedValid: true,
	},
];

export interface HarnessExecutionResult {
	totalTests: number;
	totalPassed: number;
	totalFailed: number;
	vulnerabilitiesFound: number;
	falsePositivesFound: number;
	categoryStats: Record<string, { total: number; passed: number; failed: number }>;
	findings: Array<{
		id: string;
		category: string;
		description: string;
		expected: "BLOCK" | "ALLOW";
		actual: "BLOCK" | "ALLOW";
		vulnerabilityTag?: string;
		sql: string;
		reason?: string;
	}>;
}

export function runAdversarialHarness(): HarnessExecutionResult {
	const categoryStats: Record<string, { total: number; passed: number; failed: number }> = {};
	const findings: HarnessExecutionResult["findings"] = [];
	let totalPassed = 0;
	let totalFailed = 0;
	let vulnerabilitiesFound = 0;
	let falsePositivesFound = 0;

	for (const tc of testCases) {
		if (!categoryStats[tc.category]) {
			categoryStats[tc.category] = { total: 0, passed: 0, failed: 0 };
		}
		categoryStats[tc.category].total++;

		const res: SuiteQLValidationResult = validateSuiteQL(tc.sql);
		const testPassed = res.valid === tc.expectedValid;

		if (testPassed) {
			totalPassed++;
			categoryStats[tc.category].passed++;
		} else {
			totalFailed++;
			categoryStats[tc.category].failed++;

			const isBypass = tc.expectedValid === false && res.valid === true;
			const isFalsePositive = tc.expectedValid === true && res.valid === false;

			if (isBypass) vulnerabilitiesFound++;
			if (isFalsePositive) falsePositivesFound++;

			findings.push({
				id: tc.id,
				category: tc.category,
				description: tc.description,
				expected: tc.expectedValid ? "ALLOW" : "BLOCK",
				actual: res.valid ? "ALLOW" : "BLOCK",
				vulnerabilityTag: tc.vulnerabilityTag,
				sql: tc.sql,
				reason: res.reason,
			});
		}
	}

	return {
		totalTests: testCases.length,
		totalPassed,
		totalFailed,
		vulnerabilitiesFound,
		falsePositivesFound,
		categoryStats,
		findings,
	};
}

if (process.argv[1]?.endsWith("adversarial-suiteql-harness.ts")) {
	console.log("============================================================================================");
	console.log("🛡️  SuiteQL AST & Security Guardrails Adversarial Stress Test Harness");
	console.log("📖 Evaluating src/utils/suiteqlGuard.ts across 5 adversarial dimensions");
	console.log("============================================================================================\n");

	const report = runAdversarialHarness();

	console.log("--------------------------------------------------------------------------------------------");
	console.log("📊 Category Breakdown");
	console.log("--------------------------------------------------------------------------------------------");
	for (const [cat, stats] of Object.entries(report.categoryStats)) {
		const passRate = ((stats.passed / stats.total) * 100).toFixed(1);
		const statusIcon = stats.failed === 0 ? "🟢" : "🔴";
		console.log(`${statusIcon} ${cat.padEnd(25)}: ${stats.passed}/${stats.total} passed (${passRate}%) [${stats.failed} failed]`);
	}

	console.log("\n--------------------------------------------------------------------------------------------");
	console.log(`🚨 Empirical Findings (${report.totalFailed} Total: ${report.vulnerabilitiesFound} Vulnerabilities/Bypasses, ${report.falsePositivesFound} False Positives)`);
	console.log("--------------------------------------------------------------------------------------------");

	for (const f of report.findings) {
		const tag = f.vulnerabilityTag ? `[${f.vulnerabilityTag}] ` : "";
		const kind = f.expected === "BLOCK" ? "❌ SECURITY BYPASS" : "⚠️ FALSE POSITIVE BLOCK";
		console.log(`\n• ${kind}: ${f.id} - ${tag}${f.description}`);
		console.log(`  SQL:      ${f.sql.replace(/\n/g, "\\n")}`);
		console.log(`  Expected: ${f.expected}`);
		console.log(`  Actual:   ${f.actual}${f.reason ? " (Reason: " + f.reason.slice(0, 80) + "...)" : ""}`);
	}

	console.log("\n============================================================================================");
	console.log(`🏁 Harness Result: ${report.totalPassed}/${report.totalTests} Passed (${((report.totalPassed / report.totalTests) * 100).toFixed(1)}%)`);
	console.log(`⚠️ Verdict: ${report.totalFailed > 0 ? "REQUEST_CHANGES (Defects Reproduced Empirically)" : "APPROVE"}`);
	console.log("============================================================================================\n");
}
