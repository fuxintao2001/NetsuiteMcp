# NetSuite MCP Server & Skills Toolkit Development Guide

This guide provides commands and guidelines for development in this codebase. Antigravity and other AI coding assistants read this file to guide their behaviors.

## Command Reference

### Development & Service
- **Run development server (inspected)**: `npm run dev`
- **Start MCP server**: `npm run start`

### Skills Installation
- **Install skills to global Claude configuration (`~/.claude/skills/`)**: `npm run install-skills`
- **Install skills to local workspace directory (`./.claude/skills/`)**: `npm run install-skills -- --local`

---

## Codebase Guidelines & SOPs

### 1. NetSuite SuiteQL Operations
- **SOP**: Always read the local memory file `.gemini_sql_memory.md` before drafting any query.
- **Rule**: Never guess column names. Call `ns_getSuiteQLMetadata` first.
- **Rule**: Apply `ROWNUM <= 1000` to prevent query timeout.
- **Rule**: Use `BUILTIN.DF(field_name)` to get display names instead of unnecessary joins.

### 2. NetSuite Record Operations (CRUD)
- **SOP**: Prioritize calling `ns_getRecordTypeMetadata` before writing a record to NetSuite to verify the schema.
- **Rule**: Format sublist arrays (like `item` line list on transactions) strictly according to the metadata definitions.
- **Rule**: Always call `netsuite_get_record_link` upon successful creation or modification of a record to provide the user with a clickable UI browser link.
- **Rule**: Keep all values aligned with NetSuite internal type mappings (IDs must be integers, checkboxes must match boolean fields).
