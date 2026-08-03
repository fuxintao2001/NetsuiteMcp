/**
 * Metadata & SuiteQL Field Mapping Utilities
 */

export interface JsonSchemaProperty {
	title?: string;
	type: string;
	format?: string;
	description?: string;
	nullable?: boolean;
	properties?: Record<string, JsonSchemaProperty>;
}

/**
 * Maps a NetSuite field type string (e.g., 'CHECKBOX', 'CURRENCY', 'SELECT')
 * to standard JSON Schema property definitions.
 */
export function mapFieldType(
	fieldType: string | undefined,
): JsonSchemaProperty {
	const type = (fieldType || "TEXT").toUpperCase().trim();

	if (type === "CHECKBOX" || type === "BOOLEAN") {
		return { type: "boolean" };
	}
	if (type === "INTEGER") {
		return { type: "integer" };
	}
	if (
		type === "FLOAT" ||
		type === "DOUBLE" ||
		type === "CURRENCY" ||
		type === "PERCENT"
	) {
		return { type: "number", format: "double" };
	}
	if (type === "DATE") {
		return { type: "string", format: "date" };
	}
	if (type === "DATETIME" || type === "DATE-TIME") {
		return { type: "string", format: "date-time" };
	}
	if (type === "SELECT" || type === "MULTISELECT" || type === "RECORD") {
		return {
			type: "object",
			properties: {
				id: { title: "Internal identifier", type: "string" },
				refName: { title: "Reference Name", type: "string" },
			},
		};
	}
	return { type: "string" };
}

/**
 * Sanitizes a script ID for use in SuiteQL queries to prevent SQL injection.
 * Enforces that scriptId contains only alphanumeric characters and underscores.
 */
export function sanitizeScriptId(scriptId: string): string {
	const sanitized = scriptId.trim().toUpperCase();
	if (!/^[A-Z0-9_]+$/.test(sanitized)) {
		throw new Error(`Invalid script ID format: "${scriptId}"`);
	}
	return sanitized;
}

/**
 * Sanitizes an integer ID (e.g. rectype or internalId) for use in SuiteQL queries.
 */
export function sanitizeIntegerId(id: unknown): number {
	const parsed = typeof id === "number" ? id : Number.parseInt(String(id), 10);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid numeric ID format: "${String(id)}"`);
	}
	return parsed;
}

/**
 * Unwraps data from an MCP content wrapper response or stringified JSON payload.
 */
export function unwrapMcpContent(result: unknown): unknown {
	if (result === null || result === undefined) return result;

	let data: unknown = result;

	// Handle MCP wrapper shape: { content: [{ text: '...' }] }
	if (
		typeof data === "object" &&
		data !== null &&
		"content" in data &&
		Array.isArray((data as { content: unknown[] }).content)
	) {
		const contentList = (data as { content: Array<{ text?: string }> }).content;
		const first = contentList[0];
		if (first?.text && typeof first.text === "string") {
			try {
				data = JSON.parse(first.text);
			} catch {
				return first.text;
			}
		}
	}

	// Handle stringified JSON
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch {
			return data;
		}
	}

	return data;
}

/**
 * Shared dynamic resolution for custom record numeric IDs (rectype).
 * Checks memory cache first, then queries SuiteQL with SQL injection protection,
 * and updates persistent cache.
 */
export async function resolveCustomRecordRectype(
	mcpTools: {
		customRecordMappings: Map<string, number>;
		executeTool: (
			name: string,
			params: Record<string, unknown>,
		) => Promise<unknown>;
		extractDataArray: (result: unknown) => Array<Record<string, unknown>>;
	},
	oauthManager: { getAccountId: () => Promise<string | null | undefined> },
	cacheServiceInstance: {
		get: <T>(accountId: string, key: string) => Promise<T | null | undefined>;
		set: <T>(accountId: string, key: string, val: T) => Promise<void>;
	},
	recordType: string,
): Promise<number | null> {
	if (!recordType) return null;
	const upperType = recordType.toUpperCase().trim();
	const cached = mcpTools.customRecordMappings.get(upperType);
	if (cached !== undefined) return cached;

	try {
		const safeType = sanitizeScriptId(upperType);
		console.error(
			`🔍 Resolving custom record type mapping dynamically for ${safeType}...`,
		);
		const result = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: `SELECT internalId FROM customrecordtype WHERE UPPER(scriptId) = '${safeType}'`,
		});
		const records = mcpTools.extractDataArray(result);
		const firstRecord = records[0];
		if (firstRecord) {
			const internalId = Number.parseInt(
				String(firstRecord.internalid || firstRecord.internalId),
				10,
			);
			if (!Number.isNaN(internalId)) {
				mcpTools.customRecordMappings.set(upperType, internalId);
				const accountId = await oauthManager.getAccountId();
				if (accountId) {
					const mappingsObj =
						(await cacheServiceInstance.get<Record<string, number>>(
							accountId,
							"customrecord_mappings",
						)) || {};
					mappingsObj[upperType] = internalId;
					await cacheServiceInstance.set(
						accountId,
						"customrecord_mappings",
						mappingsObj,
					);
				}
				return internalId;
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(
			`⚠️ Failed to dynamically resolve custom record rectype for ${upperType}: ${msg}`,
		);
	}

	return null;
}
