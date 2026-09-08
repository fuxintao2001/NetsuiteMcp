import type { Server } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { PROMPT_DEFINITIONS, registerPromptHandlers } from "./prompts.js";

describe("MCP Prompt Handlers", () => {
	it("should return prompt definitions by default", async () => {
		let listHandler: any;
		const fakeServer = {
			setRequestHandler: vi.fn((method, handler) => {
				if (method === "prompts/list") listHandler = handler;
			}),
		} as unknown as Server;

		registerPromptHandlers(fakeServer);

		expect(listHandler).toBeDefined();
		const res = await listHandler();
		expect(res.prompts).toEqual(PROMPT_DEFINITIONS);
		expect(res.prompts.some((p: any) => p.name === "review_suitescript")).toBe(
			true,
		);
		expect(res.prompts.some((p: any) => p.name === "debug_script_error")).toBe(
			true,
		);
		expect(res.prompts.some((p: any) => p.name === "generate_suiteql")).toBe(
			true,
		);
		expect(
			res.prompts.some((p: any) => p.name === "visualize_netsuite_data"),
		).toBe(true);
		expect(res.prompts.some((p: any) => p.name === "upgrade_suitescript")).toBe(
			true,
		);
	});

	it("should render review_suitescript prompt message", async () => {
		let getHandler: any;
		const fakeServer = {
			setRequestHandler: vi.fn((method, handler) => {
				if (method === "prompts/get") getHandler = handler;
			}),
		} as unknown as Server;

		registerPromptHandlers(fakeServer);

		const res = await getHandler({
			params: {
				name: "review_suitescript",
				arguments: {
					code: "function beforeSubmit() { record.load(...) }",
					scriptType: "UserEvent",
				},
			},
		});

		expect(res.messages).toHaveLength(1);
		expect(res.messages[0].content.text).toContain(
			"Oracle NetSuite SAFE Guide",
		);
		expect(res.messages[0].content.text).toContain("record.load(...)");
		expect(res.messages[0].content.text).toContain("Governance Usage & Budget");
	});

	it("should render debug_script_error prompt message", async () => {
		let getHandler: any;
		const fakeServer = {
			setRequestHandler: vi.fn((method, handler) => {
				if (method === "prompts/get") getHandler = handler;
			}),
		} as unknown as Server;

		registerPromptHandlers(fakeServer);

		const res = await getHandler({
			params: {
				name: "debug_script_error",
				arguments: {
					errorLog:
						"TypeError: Cannot read property \x27value\x27 of undefined at line 45",
				},
			},
		});

		expect(res.messages).toHaveLength(1);
		expect(res.messages[0].content.text).toContain(
			"TypeError: Cannot read property",
		);
		expect(res.messages[0].content.text).toContain("Root Cause");
	});

	it("should render visualize_netsuite_data prompt message adhering to Generative UI standards", async () => {
		let getHandler: any;
		const fakeServer = {
			setRequestHandler: vi.fn((method, handler) => {
				if (method === "prompts/get") getHandler = handler;
			}),
		} as unknown as Server;

		registerPromptHandlers(fakeServer);

		const res = await getHandler({
			params: {
				name: "visualize_netsuite_data",
				arguments: {
					dataType: "financial_variance",
					dataJson: JSON.stringify({ revenue: 1000000, cogs: 600000 }),
					layout: "inline",
				},
			},
		});

		expect(res.messages).toHaveLength(1);
		const text = res.messages[0].content.text;
		expect(text).toContain("generative_ui");
		expect(text).toContain(
			"https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js",
		);
		expect(text).toContain("var(--card)");
		expect(text).toContain("<agent-embed");
	});

	it("should render upgrade_suitescript prompt message", async () => {
		let getHandler: any;
		const fakeServer = {
			setRequestHandler: vi.fn((method, handler) => {
				if (method === "prompts/get") getHandler = handler;
			}),
		} as unknown as Server;

		registerPromptHandlers(fakeServer);

		const res = await getHandler({
			params: {
				name: "upgrade_suitescript",
				arguments: {
					code: "var rec = nlapiLoadRecord('customer', 123);",
					targetVersion: "2.1",
				},
			},
		});

		expect(res.messages).toHaveLength(1);
		const text = res.messages[0].content.text;
		expect(text).toContain("SuiteScript Modernization Specialist");
		expect(text).toContain("API Conversion (1.0 -> 2.1)");
		expect(text).toContain("ES6+ Modernization");
		expect(text).toContain("nlapiLoadRecord('customer', 123)");
	});

	it("should throw for unknown prompt", async () => {
		let getHandler: any;
		const fakeServer = {
			setRequestHandler: vi.fn((method, handler) => {
				if (method === "prompts/get") getHandler = handler;
			}),
		} as unknown as Server;

		registerPromptHandlers(fakeServer);

		await expect(
			getHandler({
				params: { name: "unknown_test_prompt" },
			}),
		).rejects.toThrow("Unknown prompt");
	});
});
