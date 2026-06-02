---
name: netsuite-suiteql-expert
description: Specialized in writing, executing, and debugging NetSuite SuiteQL queries. Triggers automatically when a user wants to query NetSuite data, generate reports, or encounters SQL errors. Committed to achieving a 100% success rate and zero errors through robust metadata validation and closed-loop automatic error correction.
disable-model-invocation: false
allowed-tools: [ns_runCustomSuiteQL, ns_getSuiteQLMetadata, netsuite_get_sql_memory, netsuite_save_sql_error]
---

# NetSuite SuiteQL High-Speed Zero-Error Expert Skill

The sole core objective of this skill is: **To eliminate all SuiteQL query errors and ensure that any SQL presented to the user has run successfully with 100% certainty!**

Each time this skill is executed, the AI assistant **must unconditionally execute the following "Self-Healing" 5-Step SOP**. It is absolutely forbidden to output untested SQL directly to the user!

## 🛡️ "Self-Healing" 5-Step SOP (Strict Execution)

### Step 1: Read the Local Error Memory
- At startup, you must first call `netsuite_get_sql_memory` to read the local `.gemini_sql_memory.md` file, retrieving the system's recorded historical rules and general requirements.

### Step 2: Schema First - Do Not Guess Tables and Fields
- Identify the target tables (e.g., `transaction`, `customer`, `item`).
- You **must** call `ns_getSuiteQLMetadata` to retrieve the **actual field list** of these tables in the current NetSuite environment.
- Confirm column names, data types, and joinable permissions. If a field is not present in the metadata, it is strictly forbidden to write it into the SQL!

### Step 3: Draft SQL Complying with Strict Oracle/NetSuite Specifications
When drafting SQL, the following hard error-prevention rules must be adhered to:
1. **Alias Reserved Words**: If a field name is a reserved word (e.g., `status`, `type`, `date`, `role`), you must prefix it with a table alias (e.g., `t.status`, `t.type`).
2. **Hard Limit on Row Count**: You must add `ROWNUM <= 1000` (or configure metadata pagination) in the outermost layer or the `WHERE` clause to prevent timeouts or crashes caused by large datasets.
3. **Mainline Filtering**: When querying the `transaction` table for totals or headers, you must add `t.mainline = 'T'`. When querying line items, you must add `t.mainline = 'F'`.
4. **Date Formatting**: Date filters must be wrapped using `TO_DATE('YYYY-MM-DD', 'YYYY-MM-DD')`.
5. **Prioritize BUILTIN**: To retrieve display text for related fields (e.g., sales representative names, customer names), always use `BUILTIN.DF(field_name)` and avoid complex table joins.

### Step 4: Silent Background Run (Key to Closed-Loop Error Resolution)
- Before presenting any query results to the user, you must first call `ns_runCustomSuiteQL` to **silently run the drafted SQL in the background**.
- **If successful**: Skip to Step 5.
- **If failed**:
  1. Carefully read the error stack returned by NetSuite (e.g., `Search query is invalid` indicating which field is missing).
  2. Call `ns_getSuiteQLMetadata` to perform a deep search on the failing table, comparing field spellings (check capitalization, underscores, etc.).
  3. Correct the SQL syntax and call `ns_runCustomSuiteQL` again for a second test.
  4. The retry limit is 3 times. If it still fails after 3 attempts, report the final error message and your troubleshooting steps to the user.
  5. **Once successfully corrected and verified**, you must automatically call the `netsuite_save_sql_error` tool to append the error description, incorrect SQL, correct SQL, and correction rule to the `.gemini_sql_memory.md` memory file!

### Step 5: Elegant Presentation of Results
- Present the successfully retrieved data in a highly readable Markdown table.
- Include the 100% verified, correct SQL code.
- Provide a corresponding SuiteScript 2.x `N/query` code snippet for easy development integration.
