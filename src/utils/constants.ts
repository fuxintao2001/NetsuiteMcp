/**
 * Centralized Application Constants & Default Configuration
 */

export const SERVER_NAME = "netsuite-mcp";

/**
 * Pre-configured default Client IDs for known NetSuite account environments.
 * These fallbacks allow seamless zero-config developer onboarding.
 */
export const KNOWN_CLIENT_IDS: Record<string, string> = {
	"5848789": "a1b2d7195f6788a9c751d8107c5b79d9c8f9ac07eccf3ad910b744002597001e",
	"5848789_sb1":
		"0236ead47a3111e43ef133494c12b55c7a83b4f0ad72cc7c2cb2787af636768a",
	"9260916": "a464dbc30452bd27cde365f221ebe2b28e5fe2edb5d00880aef4f276dcbe6383",
	"9260916_sb1":
		"23b3717bc449aa331fc9867222b86f5f8324713abd56076d74f62450de6cf310",
	"9260916_sb3":
		"3a651cfac0d8de2d1c93c0a7c53b38e6627a6e55a1ad602bc759f64c95a2d425",
};

/**
 * Lookup default client ID for a given NetSuite account ID.
 */
export function getKnownClientId(accountId?: string): string | undefined {
	if (!accountId) return undefined;
	const normAccount = accountId.toLowerCase().replace(/-/g, "_");
	return KNOWN_CLIENT_IDS[normAccount];
}
