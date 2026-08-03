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
	if (val === null || val === undefined || depth > 20) {
		return undefined;
	}
	if (typeof val === "object" && val !== null) {
		if (seen.has(val)) return undefined;
		seen.add(val);
	}
	if (Array.isArray(val)) {
		const cleanedArr = val
			.map((item) => cleanRecordPayloadHelper(item, depth + 1, seen))
			.filter((item) => item !== undefined);
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
export function formatMetadataToCompactMarkdown(schema: unknown): string {
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
				return formatMetadataToCompactMarkdown(parsed);
			} catch {
				// Not JSON text, return content as string
				return first.text;
			}
		}
	}

	if (!properties || typeof properties !== "object") {
		// If it's standard JSON but has a success status
		if (schemaObj.success === true && schemaObj.metadata) {
			return formatMetadataToCompactMarkdown(schemaObj.metadata);
		}
		return typeof schema === "string"
			? schema
			: JSON.stringify(schema, null, 2);
	}

	let output = "| Field | Type | Description | Nullable |\n|---|---|---|---|\n";
	for (const [key, value] of Object.entries(properties)) {
		if (!value || typeof value !== "object") continue;
		const valObj = value as Record<string, unknown>;
		const innerProps = valObj.properties as Record<string, unknown> | undefined;
		const typeStr =
			valObj.type === "object" && innerProps
				? `object (${Object.keys(innerProps).join(", ")})`
				: String(valObj.type || "string");
		const desc = String(valObj.description || valObj.title || "")
			.trim()
			.replace(/\|/g, "\\|")
			.replace(/\n/g, " ");
		const nullable = valObj.nullable !== false ? "Yes" : "No";
		output += `| ${key} | ${typeStr} | ${desc} | ${nullable} |\n`;
	}
	return output;
}
