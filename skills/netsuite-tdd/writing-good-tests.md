# Writing Honest Tests for NetSuite & MCP

## Overview

A test that passes when your production code is broken is worse than no test at all — it gives false confidence. In NetSuite and MCP development, dishonest tests usually fall into two traps: **Mocking Fabricated Schemas** and **Testing Mock Calls Instead of Behavior**.

---

## Rule 1: Never Use Unverified Schemas in Test Fixtures

The #1 cause of SuiteScript tests passing locally and crashing immediately in NetSuite Sandbox/Production is **hallucinated field IDs in test fixtures**.

### ❌ BAD: Mocking a Hallucinated Field
```typescript
// BAD: The developer guessed that Item records have a 'recordtype' field
// and Transaction headers have a 'createdfrom' field.
// The unit test passes 100% locally, but fails immediately in NetSuite!
const mockItemRow = {
	id: 405,
	itemid: "SKU-001",
	recordtype: "inventoryitem", // DOES NOT EXIST on 'item' table!
};
```

### ✅ GOOD: Grounding Fixtures in Authoritative NetSuite Schema (Tier 1/2)
Before creating test fixtures for NetSuite records or SuiteQL rows, verify the exact column names against `netsuite-suitescript-records-reference` or `netsuite_get_metadata`:
- `item` table uses `itemtype` (`'InvtPart'`, `'Assembly'`, `'Service'`) and `subtype` (`'Sale'`, `'Purchase'`, `'Resale'`).
- `transactionline` (never `transaction`) holds `createdfrom`, and boolean flags in SuiteQL rows are `'T'` or `'F'` (never `true`/`false` or `1`/`0`).

```typescript
const verifiedItemRow = {
	id: 405,
	itemid: "SKU-001",
	itemtype: "InvtPart",
	subtype: "Sale",
	isinactive: "F",
};
```

---

## Rule 2: Assert on Real Behavior & Output, Never on Mock Call Counts

When testing SuiteScript or MCP handlers, do not write tests that merely verify a mock function was called.

### ❌ BAD: Testing Mock Mechanics
```typescript
// Proves nothing about whether the SQL is valid or the calculation is right
it("calls runSuiteQL", async () => {
	const mockRun = mock.fn(() => Promise.resolve([]));
	await fetchCustomerBalances(mockRun);
	assert.strictEqual(mockRun.mock.callCount(), 1);
});
```

### ✅ GOOD: Testing Actual Transformation, Validation, and Edge Cases
1. **Validate the generated SuiteQL with `validateSuiteQL` from `suiteqlGuard.ts`!**
   If your function constructs a SuiteQL query dynamically, pass that generated SQL string directly into `validateSuiteQL(sql)` inside your test to prove it obeys all Oracle NetSuite guardrails (explicit columns, `mainline` filter, `FETCH FIRST N ROWS ONLY`, no `SELECT *`).
2. **Test the pure data transformation with realistic edge cases**:
   - Empty result sets (`[]`)
   - Multi-currency transactions (`foreigntotal` vs. base `amount`)
   - Negative credit memo amounts
   - Penny rounding remainders on prorated lines

---

## Rule 3: Test Both Positive (Golden) and Negative (Blocked) Boundaries

When adding a guardrail rule to `src/utils/suiteqlGuard.ts`:
1. **Negative Test (Must Block)**: Prove that the invalid query is caught (`res.valid === false`) and returns the exact self-healing diagnostic message.
2. **Positive Test (Zero False Positives)**: Prove that a legitimate query containing similar keywords (e.g., a column alias named `limit_amount`, a CTE named `systemnote_summary`, or `createdfrom` on `transactionline tl`) is **NOT** falsely blocked (`res.valid === true`).

---

## Rule 4: Zero Test-Only Pollution in Production Code

Never add flags like `if (process.env.NODE_ENV === 'test')` or test-only methods into `src/` or SuiteScript files. If a module is hard to test without polluting production code, its interface is too tightly coupled — extract the pure logic into a standalone function or pass dependencies explicitly.
