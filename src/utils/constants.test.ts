import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKnownClientId, SERVER_NAME } from "./constants.js";

describe("constants module", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	it("should export correct SERVER_NAME", () => {
		expect(SERVER_NAME).toBe("netsuite-mcp");
	});

	it("should lookup account-specific client IDs correctly from env", () => {
		process.env.NETSUITE_CLIENT_ID_5848789 = "client_5848789";
		process.env.NETSUITE_CLIENT_ID_5848789_SB1 = "client_5848789_sb1";
		process.env.NETSUITE_CLIENT_ID_9260916_SB1 = "client_9260916_sb1";

		expect(getKnownClientId("5848789")).toBe("client_5848789");
		expect(getKnownClientId("5848789-sb1")).toBe("client_5848789_sb1");
		expect(getKnownClientId("9260916-SB1")).toBe("client_9260916_sb1");
	});

	it("should fallback to NETSUITE_CLIENT_ID if specific account ID is not set", () => {
		delete process.env.NETSUITE_CLIENT_ID_UNKNOWN_ACC;
		process.env.NETSUITE_CLIENT_ID = "generic_client_id";

		expect(getKnownClientId("unknown_acc")).toBe("generic_client_id");
	});

	it("should return undefined if neither specific nor generic client ID is set", () => {
		delete process.env.NETSUITE_CLIENT_ID_UNKNOWN_ACC;
		delete process.env.NETSUITE_CLIENT_ID;

		expect(getKnownClientId("unknown_acc")).toBeUndefined();
		expect(getKnownClientId(undefined)).toBeUndefined();
	});
});
