import { describe, expect, it } from "@jest/globals";
import {
	getKnownClientId,
	KNOWN_CLIENT_IDS,
	SERVER_NAME,
} from "./constants.js";

describe("constants module", () => {
	it("should export correct SERVER_NAME", () => {
		expect(SERVER_NAME).toBe("netsuite-mcp");
	});

	it("should lookup known client IDs correctly", () => {
		expect(getKnownClientId("5848789")).toBe(KNOWN_CLIENT_IDS["5848789"]);
		expect(getKnownClientId("5848789-sb1")).toBe(
			KNOWN_CLIENT_IDS["5848789_sb1"],
		);
		expect(getKnownClientId("9260916-SB1")).toBe(
			KNOWN_CLIENT_IDS["9260916_sb1"],
		);
		expect(getKnownClientId("unknown_acc")).toBeUndefined();
		expect(getKnownClientId(undefined)).toBeUndefined();
	});
});
