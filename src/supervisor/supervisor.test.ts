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
});
