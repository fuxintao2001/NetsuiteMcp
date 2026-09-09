import type { NetSuiteMCPTools } from "../mcp/tools.js";
import {
	type JsonSchemaProperty,
	mapFieldType,
	sanitizeIntegerId,
	unwrapMcpContent,
} from "../utils/metadata.js";

/** Hydrates NetSuite custom record metadata with custom fields from SuiteQL if needed. */
export async function hydrateMetadataIfNeeded(
	_toolName: string,
	recordTypeRaw: unknown,
	originalResult: unknown,
	mcpTools: NetSuiteMCPTools,
	resolveRectype: (type: string) => number | null | Promise<number | null>,
): Promise<unknown> {
	const recordType =
		typeof recordTypeRaw === "string" ? recordTypeRaw.trim() : "";
	if (!recordType?.toLowerCase().startsWith("customrecord")) {
		return originalResult;
	}

	// If originalResult already contains valid property definitions, return directly
	const parsedOriginal = unwrapMcpContent(originalResult) as Record<
		string,
		unknown
	> | null;
	if (parsedOriginal && typeof parsedOriginal === "object") {
		const meta = (parsedOriginal.metadata || parsedOriginal) as Record<
			string,
			unknown
		>;
		if (
			meta &&
			typeof meta.properties === "object" &&
			meta.properties !== null &&
			Object.keys(meta.properties).length > 0
		) {
			return originalResult;
		}
	}

	try {
		const rawRectype = await resolveRectype(recordType);
		if (!rawRectype) {
			return originalResult;
		}

		const rectype = sanitizeIntegerId(rawRectype);

		const qFields = await mcpTools.executeTool("ns_runCustomSuiteQL", {
			sqlQuery: `SELECT Name, ScriptID, FieldType, IsMandatory FROM CustomField WHERE RecordType = ${rectype}`,
		});
		const fields = mcpTools.extractDataArray(qFields);

		if (!fields || fields.length === 0) {
			return originalResult;
		}

		const properties: Record<string, JsonSchemaProperty> = {
			id: { title: "Internal ID", type: "string", nullable: true },
			name: { title: "Name", type: "string", nullable: true },
			externalId: { title: "External ID", type: "string", nullable: true },
			isinactive: { title: "Is Inactive", type: "boolean", nullable: true },
			owner: {
				title: "Owner",
				type: "object",
				properties: {
					id: { title: "Internal identifier", type: "string" },
					refName: { title: "Reference Name", type: "string" },
				},
				nullable: true,
			},
		};

		for (const field of fields) {
			const scriptId = String(field.scriptid || field.scriptId || "")
				.toLowerCase()
				.trim();
			if (scriptId) {
				properties[scriptId] = {
					title: String(field.name || field.label || scriptId),
					nullable: field.ismandatory !== "T",
					...mapFieldType(field.fieldtype as string | undefined),
				};
			}
		}

		let originalProperties: Record<string, JsonSchemaProperty> = {};
		if (parsedOriginal && typeof parsedOriginal === "object") {
			const meta = (parsedOriginal.metadata || parsedOriginal) as Record<
				string,
				unknown
			>;
			if (
				meta &&
				typeof meta.properties === "object" &&
				meta.properties !== null
			) {
				originalProperties = meta.properties as Record<
					string,
					JsonSchemaProperty
				>;
			}
		}

		const finalProperties = { ...properties, ...originalProperties };

		const hydratedResponse = {
			success: true,
			metadata: {
				type: "object",
				properties: finalProperties,
			},
		};

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(hydratedResponse),
				},
			],
		};
	} catch {
		// Custom field hydration is a best-effort enhancement — fall back gracefully to original metadata
		return originalResult;
	}
}
