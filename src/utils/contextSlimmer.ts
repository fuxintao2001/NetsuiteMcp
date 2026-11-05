/**
 * Utility functions for slimming down response payloads to reduce MCP context token usage.
 */

/**
 * Clean helper function to recursively remove nulls, undefineds, and 'links' keys.
 */
function cleanRecordPayloadHelper(
	val: unknown,
	depth = 0,
	seen = new WeakSet<object>(),
): unknown {
	if (val === null || val === undefined || val === "" || depth > 20) {
		return undefined;
	}
	if (typeof val === "object" && val !== null) {
		if (seen.has(val)) return undefined;
		seen.add(val);
	}
	if (Array.isArray(val)) {
		const cleanedArr = val
			.map((item) => cleanRecordPayloadHelper(item, depth + 1, seen))
			.filter((item) => item !== undefined && item !== null && item !== "");
		return cleanedArr.length > 0 ? cleanedArr : undefined;
	}
	if (typeof val === "object" && val !== null) {
		const cleaned: Record<string, unknown> = {};
		let hasKeys = false;
		const objVal = val as Record<string, unknown>;
		for (const key of Object.keys(objVal)) {
			if (key === "links") continue;
			const cleanedVal = cleanRecordPayloadHelper(objVal[key], depth + 1, seen);
			if (
				cleanedVal !== undefined &&
				cleanedVal !== null &&
				cleanedVal !== ""
			) {
				cleaned[key] = cleanedVal;
				hasKeys = true;
			}
		}
		return hasKeys ? cleaned : undefined;
	}
	return val;
}

/**
 * Recursively removes redundant fields (like 'links') and null/undefined values from record objects.
 * Always returns a fallback empty object/array if the root is completely stripped.
 */
export function cleanRecordPayload(val: unknown): unknown {
	const result = cleanRecordPayloadHelper(val);
	if (result === undefined) {
		return Array.isArray(val) ? [] : {};
	}
	return result;
}

/**
 * Formats JSON schema (from NetSuite record metadata) into a compact Markdown table.
 */
export function formatMetadataToCompactMarkdown(
	schema: unknown,
	keyword?: string,
): string {
	if (!schema || typeof schema !== "object") {
		return String(schema);
	}

	const schemaObj = schema as Record<string, unknown>;

	// Handle various formats of JSON Schema / responses
	let properties = schemaObj.properties as Record<string, unknown> | undefined;
	if (schemaObj.metadata && typeof schemaObj.metadata === "object") {
		properties = (schemaObj.metadata as Record<string, unknown>).properties as
			| Record<string, unknown>
			| undefined;
	}

	// Unwrap array/content wrapper if it's from local converted record format or MCP response format
	if (Array.isArray(schemaObj.content)) {
		const first = schemaObj.content[0] as { text?: string } | undefined;
		if (first?.text && typeof first.text === "string") {
			try {
				const parsed = JSON.parse(first.text);
				return formatMetadataToCompactMarkdown(parsed, keyword);
			} catch {
				// Not JSON text, return content as string
				return first.text;
			}
		}
	}

	if (!properties || typeof properties !== "object") {
		// If it's standard JSON but has a success status
		if (schemaObj.success === true && schemaObj.metadata) {
			return formatMetadataToCompactMarkdown(schemaObj.metadata, keyword);
		}
		return typeof schema === "string"
			? schema
			: JSON.stringify(schema, null, 2);
	}

	let output = "| Field | Type | Description | Nullable |\n|---|---|---|---|\n";
	const kwLower = keyword ? keyword.toLowerCase().trim() : "";
	for (const [key, value] of Object.entries(properties)) {
		if (!value || typeof value !== "object") continue;
		const valObj = value as Record<string, unknown>;
		const desc = String(valObj.description || valObj.title || "")
			.trim()
			.replace(/\|/g, "\\|")
			.replace(/\n/g, " ");

		if (kwLower.length > 0) {
			const keyMatch = key.toLowerCase().includes(kwLower);
			const descMatch = desc.toLowerCase().includes(kwLower);
			if (!keyMatch && !descMatch) {
				continue;
			}
		}

		const innerProps = valObj.properties as Record<string, unknown> | undefined;
		const typeStr =
			valObj.type === "object" && innerProps
				? `object (${Object.keys(innerProps).join(", ")})`
				: String(valObj.type || "string");
		const nullable = valObj.nullable !== false ? "Yes" : "No";
		const safeKey = key.replace(/\|/g, "\\|");
		const safeType = typeStr.replace(/\|/g, "\\|");
		output += `| ${safeKey} | ${safeType} | ${desc} | ${nullable} |\n`;
	}
	return output;
}

/**
 * Formats SuiteQL query result rows into a compact Markdown table to drastically reduce token usage.
 */
export function formatSuiteQLToCompactMarkdown(result: unknown): string {
	if (!result) return "No results returned.";

	let dataRows: Array<Record<string, unknown>> = [];
	let totalResults: number | undefined;
	let hasMore: boolean | undefined;

	// Direct array
	if (Array.isArray(result)) {
		dataRows = result as Array<Record<string, unknown>>;
	} else if (typeof result === "object" && result !== null) {
		const resObj = result as Record<string, unknown>;

		// Check if it's already an error payload
		if (resObj.error || resObj.success === false) {
			return typeof result === "string"
				? result
				: JSON.stringify(result, null, 2);
		}

		if (typeof resObj.hasMore === "boolean") {
			hasMore = resObj.hasMore;
		}

		if (Array.isArray(resObj.data)) {
			dataRows = resObj.data as Array<Record<string, unknown>>;
			totalResults =
				typeof resObj.totalResults === "number"
					? resObj.totalResults
					: undefined;
		} else if (Array.isArray(resObj.records)) {
			dataRows = resObj.records as Array<Record<string, unknown>>;
		} else if (Array.isArray(resObj.items)) {
			dataRows = resObj.items as Array<Record<string, unknown>>;
		} else if (Array.isArray(resObj.content)) {
			// Handle MCP content wrapper
			const first = resObj.content[0] as { text?: string } | undefined;
			if (first?.text && typeof first.text === "string") {
				try {
					const parsed = JSON.parse(first.text);
					return formatSuiteQLToCompactMarkdown(parsed);
				} catch {
					return first.text;
				}
			}
		} else {
			// Single object record row
			const keys = Object.keys(resObj).filter(
				(k) =>
					k !== "links" &&
					k !== "method" &&
					k !== "totalResults" &&
					k !== "numberOfPages" &&
					k !== "hasMore",
			);
			if (keys.length > 0) {
				dataRows = [resObj];
			}
		}
	} else if (typeof result === "string") {
		try {
			const parsed = JSON.parse(result);
			return formatSuiteQLToCompactMarkdown(parsed);
		} catch {
			return result;
		}
	}

	if (!dataRows || dataRows.length === 0) {
		return "No rows returned.";
	}

	// Extract unique headers while preserving order
	const headers: string[] = [];
	const headerSet = new Set<string>();
	for (const row of dataRows) {
		if (typeof row === "object" && row !== null) {
			for (const key of Object.keys(row)) {
				if (key === "links") continue;
				if (!headerSet.has(key)) {
					headerSet.add(key);
					headers.push(key);
				}
			}
		}
	}

	if (headers.length === 0) {
		return "No rows returned.";
	}

	// Safety truncation cap to prevent context explosion on massive queries
	const MAX_DISPLAY_ROWS = 100;
	const totalInputRows = dataRows.length;
	let wasTruncated = false;
	if (dataRows.length > MAX_DISPLAY_ROWS) {
		dataRows = dataRows.slice(0, MAX_DISPLAY_ROWS);
		wasTruncated = true;
	}

	let output = "";
	if (wasTruncated) {
		output += `> ⚠️ **Notice**: Result truncated to top ${MAX_DISPLAY_ROWS} of ${totalInputRows} rows. Use WHERE, ROWNUM, or aggregation in SuiteQL for complete totals.\n\n`;
	} else if (
		hasMore === true ||
		(dataRows.length === 100 && totalResults === undefined)
	) {
		output += `> ℹ️ **Notice**: Query returned ${dataRows.length} rows (safe ceiling applied; additional rows may exist). Use \`COUNT(*)\` aggregate for exact total or specify \`OFFSET / ROWNUM\` for remaining pages.\n\n`;
	}
	if (totalResults !== undefined && totalResults !== dataRows.length) {
		output += `*Total Results: ${totalResults} (Showing ${dataRows.length} rows)*\n\n`;
	}

	const escapedHeaders = headers.map((h) => h.replace(/\|/g, "\\|"));
	output += `| ${escapedHeaders.join(" | ")} |\n`;
	output += `| ${escapedHeaders.map(() => "---").join(" | ")} |\n`;

	for (const row of dataRows) {
		const rowValues = headers.map((header) => {
			const val = row[header];
			if (val === null || val === undefined || val === "") {
				return "-";
			}
			let formatted =
				typeof val === "object"
					? JSON.stringify(val)
							.replace(/\|/g, "\\|")
							.replace(/[\r\n]+/g, " ")
					: String(val)
							.replace(/\|/g, "\\|")
							.replace(/[\r\n]+/g, " ");
			if (formatted.length > 300) {
				formatted = `${formatted.slice(0, 297)}...`;
			}
			return formatted;
		});
		output += `| ${rowValues.join(" | ")} |\n`;
	}

	return output.trim();
}
