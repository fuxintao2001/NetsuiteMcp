import { describe, expect, it } from "vitest";
import { NetSuiteHTTPServer } from "./server.js";

describe("NetSuiteHTTPServer (Hono)", () => {
	it("should respond with ok on /health route", async () => {
		const server = new NetSuiteHTTPServer();
		const res = await server.app.request("/health");
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.status).toBe("ok");
		expect(Array.isArray(data.accounts)).toBe(true);
		expect(data.accounts).toContain("9260916_sb1");
	});

	it("should handle /mcp/:accountId with valid JSON-RPC request", async () => {
		const server = new NetSuiteHTTPServer();
		// Test ping / initialize request via standard HTTP POST
		const reqBody = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "test-client", version: "1.0.0" },
			},
		};

		const res = await server.app.request("/mcp/9260916_sb1", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(reqBody),
		});

		expect(res.status).toBe(200);
	});
});
