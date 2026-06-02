---
name: netsuite-record-expert
description: Specialized in creating, querying, and updating NetSuite Records. Triggers automatically when a user requests to fetch sales orders, create customers, update invoices, or manage any NetSuite entity records. This skill is designed to prevent field typos and type errors by fetching schema metadata first and standardizing sublist handling, ensuring high accuracy and zero errors.
disable-model-invocation: false
allowed-tools: [ns_getRecord, ns_createRecord, ns_updateRecord, ns_getRecordTypeMetadata, netsuite_get_record_link]
---

# NetSuite Record Management Expert Skill

The sole core objective of this skill is: **To create, retrieve, update, and delete NetSuite records with high accuracy and zero errors, and provide clear user feedback!**

When performing any Record operations (Get, Create, Update), the AI assistant **must unconditionally execute the following "Self-Healing" Standard Operating Procedures (SOP)**. It is absolutely forbidden to guess fields or directly send unvalidated data structures to NetSuite!

## 🛡️ NetSuite Record Operation SOP (Strict Execution)

### Step 1: Metadata First - Do Not Guess Fields or Sublist Structures
- Before executing a **Create (`ns_createRecord`)** or **Update (`ns_updateRecord`)** operation, you **must** first call `ns_getRecordTypeMetadata` to retrieve the metadata definition of that record type.
- Verify target field names (Field ID), data types (e.g., `select`, `text`, `checkbox`, `integer`), and whether fields are read-only.
- If the operation involves a sublist (e.g., the `item` sublist on a sales order), you must verify the sublist's internal field names and insertion format. If a field is not defined in the metadata, it is strictly forbidden to include it in the request body!

### Step 2: Precise Handling of Sublists and Related Fields
When drafting create or update data structures, you must adhere to the following hard rules:
1. **Multi-line Sublist Handling**:
   - For records containing sublists (such as the `item` sublist on a `salesorder` or `invoice`), they must be passed as an array, and each line's data must strictly match the sublist fields (e.g., `item`, `quantity`, `amount`, `rate`).
   - Related fields like Item ID (`item`) and Customer ID (`entity`) are typically internal numeric IDs (Internal ID), not text names. If the user only provides a name, you must first retrieve the corresponding Internal ID using SuiteQL or other query tools.
2. **Boolean Values**:
   - Checkbox fields in NetSuite typically require strict boolean types (`true`/`false`) or `'T'`/`'F'` (as specified by the data type returned by `ns_getRecordTypeMetadata`).
3. **Filter Read-Only Fields**:
   - Never pass system read-only fields (e.g., `createddate`, `total`, `status`) to create or update requests.

### Step 3: Error Catching & Auto-Retry (Closed-Loop Troubleshooting)
- **If successful**: Skip to Step 4.
- **If failed**:
  1. Carefully read the specific error message returned by NetSuite (e.g., `INVALID_KEY_OR_REF` if a related record is not found, or if a field value does not meet validation criteria).
  2. Call `ns_getRecordTypeMetadata` to re-examine the problematic field names, checking for casing issues, missing underscores, etc.
  3. If there is a reference error (e.g., customer does not exist), point out the missing prerequisite to the user, or try using SuiteQL to retrieve the correct internal ID via a fuzzy search.
  4. Modify the data structure and retry the operation. The retry limit is 2 times.

### Step 4: UI Link Generation & Elegant Presentation
- Upon successful execution, you **must** call the `netsuite_get_record_link` tool to obtain the direct browser hyperlink for the record in the NetSuite UI.
- **Elegant Reporting**:
  1. Briefly and clearly summarize the operation result (e.g., "Successfully created Sales Order with a total of $12,500.00").
  2. Use a beautiful Markdown table or tree structure to display the created/updated key fields, making details clear at a glance.
  3. **Prominently display** the generated NetSuite record link:
     > 🔗 **[View this record in NetSuite](LINK_URL)**
