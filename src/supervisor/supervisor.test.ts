import { describe, expect, it } from "vitest";
import { McpSupervisor } from "./supervisor.js";

describe("McpSupervisor", () => {
	it("should instantiate with valid configuration", () => {
		const supervisor = new McpSupervisor({
			scriptPath: "/path/to/dist/index.js",
			distDir: "/path/to/dist",
			pollIntervalMs: 500,
		});

		expect(supervisor).toBeDefined();
		expect(typeof supervisor.start).toBe("function");
	});

	it("should prune stale in-flight requests exceeding 65s TTL", () => {
		const supervisor = new McpSupervisor({
			scriptPath: "/path/to/dist/index.js",
			distDir: "/path/to/dist",
		});

		const reqMap = (
			supervisor as unknown as {
				activeRequestIds: Map<string | number, number>;
			}
		).activeRequestIds;
		const now = Date.now();
		// Stale request: 70 seconds old
		reqMap.set("stale_req_1", now - 70_000);
		// Fresh request: 10 seconds old
		reqMap.set("fresh_req_2", now - 10_000);

		(
			supervisor as unknown as { pruneStaleRequests: () => void }
		).pruneStaleRequests();

		expect(reqMap.has("stale_req_1")).toBe(false);
		expect(reqMap.has("fresh_req_2")).toBe(true);
	});
});
