/**
 * NetSuite error response detail structure
 */
interface NetSuiteErrorDetail {
	detail?: string;
	message?: string;
	"o:errorCode"?: string;
	o_errorCode?: string;
}

/**
 * Returns actionable advice for common NetSuite errors to assist the AI agent.
 */
function getActionableAdvice(code: string, message: string): string {
	const normalizedCode = code.toUpperCase();
	const normalizedMessage = message.toLowerCase();

	// SuiteQL / SQL / Field name errors
	if (
		normalizedCode.includes("INVALID_SEARCH_SELECT_FIELD") ||
		normalizedCode.includes("INVALID_SQL") ||
		normalizedMessage.includes("sql") ||
		normalizedMessage.includes("select") ||
		normalizedMessage.includes("query") ||
		normalizedMessage.includes("column")
	) {
		let advice = "\n💡 [Troubleshooting Advice - SuiteQL/SQL]:";
		advice +=
			'\n  - Explicit Columns: Avoid "SELECT *". Specify explicit column names.';
		advice +=
			"\n  - Case-Sensitivity: NetSuite table and field names are case-sensitive. Verify exact names using `ns_getSuiteQLMetadata`.";
		advice += '\n  - Primary Key: Primary key is "id" (not "internalid").';
		advice +=
			"\n  - Dates: Format date parameters with TO_DATE('<value>', '<format>'), e.g. TO_DATE('2025-01-15', 'YYYY-MM-DD').";
		advice +=
			'\n  - Pagination: "LIMIT" and "OFFSET" are NOT supported. Use "FETCH FIRST N ROWS ONLY" or "WHERE ROWNUM <= N".';
		advice +=
			"\n  - Display Names: Use BUILTIN.DF(<field>) to extract foreign key text labels (e.g. BUILTIN.DF(entity), BUILTIN.DF(status)).";
		advice +=
			"\n  - Transaction Types: SalesOrd, CustInvc, PurchOrd, VendBill, Journal, CustCred, ItemRcpt, ItemShip, CashSale, CustPymt, VendPymt.";
		advice +=
			"\n  - Self-Healing Action: Call `ns_getSuiteQLMetadata` for the target table to verify actual field names, fix the query, and RETRY automatically.";
		return advice;
	}

	// Record Not Found / Invalid Record Type
	if (
		normalizedCode.includes("RECORD_NOT_FOUND") ||
		normalizedCode.includes("INVALID_RECORD_TYPE") ||
		normalizedMessage.includes("record type") ||
		normalizedMessage.includes("does not exist")
	) {
		let advice = "\n💡 [Troubleshooting Advice - Record Type / ID]:";
		advice +=
			"\n  - Verify the record type is lowercase and valid (e.g., 'salesorder', 'customer', 'customrecord_xxx').";
		advice +=
			"\n  - Call `ns_getRecordTypeMetadata` to verify the record schema and existing field IDs.";
		return advice;
	}

	// Missing Required Argument
	if (
		normalizedCode.includes("SSS_MISSING_REQD_ARGUMENT") ||
		normalizedCode.includes("MISSING_REQD_ARGUMENT") ||
		normalizedMessage.includes("missing required")
	) {
		let advice = "\n💡 [Troubleshooting Advice - Missing Required Argument]:";
		advice +=
			"\n  - Inspect the record metadata using `ns_getRecordTypeMetadata` or `ns_getSuiteQLMetadata`.";
		advice +=
			"\n  - Ensure all non-nullable / mandatory fields are provided in the payload.";
		return advice;
	}

	// Invalid Field Value
	if (
		normalizedCode.includes("INVALID_FLD_VALUE") ||
		normalizedMessage.includes("invalid field value")
	) {
		let advice = "\n💡 [Troubleshooting Advice - Invalid Field Value]:";
		advice +=
			"\n  - Check data types: ensure numeric IDs are integers/strings as expected and booleans are passed correctly.";
		advice +=
			"\n  - For list/select fields, use internal IDs rather than display text labels.";
		return advice;
	}

	// Permissions / Access errors
	if (
		normalizedCode.includes("INSUFFICIENT_PERMISSION") ||
		normalizedCode.includes("PERMISSION") ||
		normalizedMessage.includes("permission") ||
		normalizedMessage.includes("privilege") ||
		normalizedMessage.includes("access denied")
	) {
		let advice = "\n💡 [Troubleshooting Advice - Permissions]:";
		advice +=
			'\n  - Check that the active integration role has "Web Services" and "REST Web Services" permissions enabled.';
		advice +=
			"\n  - Verify that the active role has permissions to view/modify the target record type.";
		return advice;
	}

	// Concurrency / Rate limit errors
	if (
		normalizedCode.includes("LIMIT_EXCEEDED") ||
		normalizedCode.includes("CONCURRENT") ||
		normalizedMessage.includes("concurrent") ||
		normalizedMessage.includes("too many requests")
	) {
		let advice = "\n💡 [Troubleshooting Advice - Concurrency]:";
		advice += "\n  - You have exceeded NetSuite's concurrent request limit.";
		advice +=
			"\n  - Recommended: For multiple independent SuiteQL queries, use `netsuite_run_parallel_queries` to run them concurrently (up to 5).";
		advice +=
			"\n  - Otherwise, reduce the frequency of your requests or add retries.";
		return advice;
	}

	return "";
}

/**
 * Parses axios or generic error into a readable NetSuite-specific error message.
 */
export function parseNetSuiteError(error: unknown): Error {
	if (!error) {
		return new Error("Unknown error");
	}

	const err = error as {
		message?: string;
		response?: {
			status?: number;
			statusText?: string;
			data?: unknown;
		};
	};

	// Check if error has response data (AxiosError structure)
	if (err.response?.data) {
		const data = err.response.data;

		// Detect HTML response and truncate to avoid raw HTML dump in context window
		if (
			typeof data === "string" &&
			(data.includes("<!DOCTYPE html>") ||
				data.includes("<html") ||
				data.includes("<HTML"))
		) {
			const status = err.response.status || "Unknown";
			const statusText = err.response.statusText || "";
			const titleMatch = data.match(/<title>([\s\S]*?)<\/title>/i);
			const title = titleMatch?.[1]?.trim() ?? "";
			return new Error(
				`HTTP ${status} (${statusText || "Error"}): Server returned HTML response instead of JSON. ${
					title ? `Title: "${title}"` : ""
				} (Truncated raw HTML)`,
			);
		}

		// 1. Check for NetSuite o:errorDetails structure
		if (data && typeof data === "object") {
			const dataObj = data as Record<string, unknown>;
			const errorDetails = dataObj["o:errorDetails"] || dataObj.o_errorDetails;
			if (Array.isArray(errorDetails)) {
				let advice = "";
				const details = errorDetails
					.map((d: NetSuiteErrorDetail) => {
						const code = d["o:errorCode"] || d.o_errorCode || "ERROR";
						const msg = d.detail || d.message || "";
						const itemAdvice = getActionableAdvice(code, msg);
						if (itemAdvice && !advice.includes(itemAdvice)) {
							advice += itemAdvice;
						}
						return `[${code}] ${msg}`;
					})
					.filter(Boolean)
					.join("; ");

				if (details) {
					return new Error(`NetSuite API Error: ${details}${advice}`);
				}
			}

			// 2. Check for OAuth error structure (standard OAuth 2.0 error body)
			if (dataObj.error) {
				const errCode = String(dataObj.error);
				const errDesc = String(
					dataObj.error_description || dataObj.errorDescription || "",
				);
				const advice = getActionableAdvice(errCode, errDesc);
				return new Error(
					`OAuth Error [${errCode}]: ${errDesc || "No details provided"}${advice}`,
				);
			}

			// 3. Check if it's general JSON but doesn't match above, serialize it
			try {
				const advice = getActionableAdvice(
					String(dataObj.code || ""),
					String(dataObj.message || ""),
				);
				return new Error(
					`NetSuite Error Response: ${JSON.stringify(data)}${advice}`,
				);
			} catch {
				// Ignore serialization failure
			}
		}
	}

	// 4. Fallback if it is an Axios error with status but no response body details
	if (err.response?.status) {
		const status = err.response.status;
		let advice = "";
		if (status === 429) {
			advice =
				"\n💡 [Troubleshooting Advice - Concurrency]:\n  - You have exceeded NetSuite's concurrent request limit.\n  - Recommended: Use `netsuite_run_parallel_queries` or reduce request frequency.";
		} else if (status === 403) {
			advice =
				"\n💡 [Troubleshooting Advice - Permissions]:\n  - Access denied. Verify authentication status and permissions.";
		}
		return new Error(
			`HTTP ${status}: ${err.message || "Request failed"}${advice}`,
		);
	}

	// 5. Fallback to standard error or String representation
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

export function sanitizeMessage(message: string): string {
	if (!message) return message;
	let sanitized = message;

	// 正则过滤各种凭证敏感串
	sanitized = sanitized.replace(
		/Bearer\s+[a-zA-Z0-9_\-.]+/gi,
		"Bearer [REDACTED]",
	);
	sanitized = sanitized.replace(
		/refresh_token=[a-zA-Z0-9_\-.]+/gi,
		"refresh_token=[REDACTED]",
	);
	sanitized = sanitized.replace(
		/client_id=[a-zA-Z0-9_\-.]+/gi,
		"client_id=[REDACTED]",
	);
	sanitized = sanitized.replace(
		/code_verifier=[a-zA-Z0-9_\-.]+/gi,
		"code_verifier=[REDACTED]",
	);
	sanitized = sanitized.replace(
		/"access_token"\s*:\s*"[^"]+"/gi,
		'"access_token":"[REDACTED]"',
	);
	sanitized = sanitized.replace(
		/"refresh_token"\s*:\s*"[^"]+"/gi,
		'"refresh_token":"[REDACTED]"',
	);

	// 正则过滤操作系统的绝对工作目录与用户物理路径
	const cwd = process.cwd();
	if (cwd) {
		const registrySafe = cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		sanitized = sanitized.replace(
			new RegExp(registrySafe, "g"),
			"<PROJECT_ROOT>",
		);
	}
	sanitized = sanitized.replace(/\/Users\/[a-zA-Z0-9_\-.]+/gi, "/Users/<USER>");
	sanitized = sanitized.replace(/\/home\/[a-zA-Z0-9_\-.]+/gi, "/home/<USER>");

	return sanitized;
}

/**
 * 脱敏错误信息：优先提取 NetSuite 具体的 API 返回体（如 INVALID_SQL 详情），
 * 然后对其做脱敏，同时避免 Axios 大对象泄露敏感 config 凭证。
 */
export function sanitizeError(error: unknown): Error {
	if (!error) return new Error("Unknown error");

	// 1. 提取 NetSuite 精确内部报错详情以防止 INVALID_SQL 等信息流失
	const parsedError = parseNetSuiteError(error);

	// 2. 对返回的报错 message 进行敏感路径与 credential 脱敏
	const cleanMsg = sanitizeMessage(parsedError.message);
	const cleanErr = new Error(cleanMsg);

	if (parsedError.stack) {
		cleanErr.stack = sanitizeMessage(parsedError.stack);
	}

	return cleanErr;
}
