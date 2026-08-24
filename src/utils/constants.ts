import "./envLoader.js";

/**
 * Centralized Application Constants & Default Configuration
 */

export const SERVER_NAME = "netsuite-mcp";

/**
 * Dynamic lookup for configured Client IDs for given NetSuite account environments.
 * Checks account-specific environment variables (e.g. NETSUITE_CLIENT_ID_5848789 or NETSUITE_CLIENT_ID_9260916_SB1)
 * and falls back to NETSUITE_CLIENT_ID.
 */
export function getKnownClientId(accountId?: string): string | undefined {
	if (!accountId) return undefined;
	const normAccount = accountId.toUpperCase().replace(/-/g, "_");
	const specificKey = `NETSUITE_CLIENT_ID_${normAccount}`;
	return (
		process.env[specificKey] || process.env.NETSUITE_CLIENT_ID || undefined
	);
}
