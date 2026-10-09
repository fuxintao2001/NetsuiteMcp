/**
 * Common parameter resolution and normalization utilities.
 */

/**
 * Normalizes standard arguments in-place: unwraps nested Arguments if present from lazy MCP callers.
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
	return args;
}
