import { describe, expect, it } from "vitest";
import { parseEnv } from "./envLoader.js";

describe("envLoader module", () => {
	it("should correctly parse key-value pairs from .env string", () => {
		const sampleEnv = `
# Comment line
FOO=bar
BAZ="quoted value"
SINGLE='single quoted'
EMPTY=
SPACED = trimmed 
`;
		const parsed = parseEnv(sampleEnv);
		expect(parsed.FOO).toBe("bar");
		expect(parsed.BAZ).toBe("quoted value");
		expect(parsed.SINGLE).toBe("single quoted");
		expect(parsed.EMPTY).toBe("");
		expect(parsed.SPACED).toBe("trimmed");
	});

	it("should ignore comments and empty lines", () => {
		const sample = `# A comment
# Another comment
`;
		const parsed = parseEnv(sample);
		expect(Object.keys(parsed).length).toBe(0);
	});
});
