/**
 * Common parameter resolution and normalization utilities.
 */

/**
 * Resolves a recordType or tableName parameter from various common aliases.
 */
export function resolveRecordTypeParam(
	args: Record<string, unknown>,
): string | undefined {
	const raw =
		args.recordType ??
		args.record_type ??
		args.tableName ??
		args.table_name ??
		args.table ??
		args.type;
	if (typeof raw === "string" && raw.trim().length > 0) {
		return raw.toLowerCase().trim();
	}
	return undefined;
}

/**
 * Resolves an ID parameter (recordId, id, internalId, etc.) from various common aliases.
 */
export function resolveRecordIdParam(
	args: Record<string, unknown>,
): string | undefined {
	const raw =
		args.recordId ??
		args.id ??
		args.record_id ??
		args.internalId ??
		args.internal_id ??
		args.tranid ??
		args.tranId ??
		args.documentNumber;
	if (raw !== undefined && raw !== null) {
		const strId = String(raw).trim();
		if (strId.length > 0) {
			return strId;
		}
	}
	return undefined;
}

/**
 * Normalizes standard arguments in-place and returns the object.
 */
export function normalizeStandardArgs(
	args: Record<string, unknown>,
): Record<string, unknown> {
	// Unwrap nested Arguments/arguments object if present (e.g. from lazy MCP callers)
	const nestedArgs = args.Arguments ?? args.arguments;
	if (
		nestedArgs &&
		typeof nestedArgs === "object" &&
		!Array.isArray(nestedArgs)
	) {
		const innerArgs = nestedArgs as Record<string, unknown>;
		for (const [k, v] of Object.entries(innerArgs)) {
			if (!(k in args)) {
				args[k] = v;
			}
		}
	}

	const recType = resolveRecordTypeParam(args);
	if (recType) {
		args.recordType = recType;
		if (typeof args.tableName === "string") {
			args.tableName = recType;
		}
	}
	const recId = resolveRecordIdParam(args);
	if (recId) {
		args.recordId = recId;
		args.id = recId;
	}
	return args;
}
