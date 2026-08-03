import crypto from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import { base64URLEncode, generatePKCE } from "./pkce.js";

describe("PKCE Utilities", () => {
	describe("base64URLEncode", () => {
		it("should generate url safe base64 without padding", () => {
			const buf = Buffer.from("hello+world/foo=bar");
			const encoded = base64URLEncode(buf);
			expect(encoded).not.toContain("+");
			expect(encoded).not.toContain("/");
			expect(encoded).not.toContain("=");
		});
	});

	describe("generatePKCE", () => {
		it("should return a valid S256 code challenge structure", () => {
			const challengeObj = generatePKCE();
			expect(challengeObj.code_challenge_method).toBe("S256");
			expect(challengeObj.code_verifier.length).toBeGreaterThan(0);
			expect(challengeObj.code_challenge.length).toBeGreaterThan(0);

			// Verify the SHA-256 math
			const expectedChallenge = base64URLEncode(
				crypto.createHash("sha256").update(challengeObj.code_verifier).digest(),
			);
			expect(challengeObj.code_challenge).toBe(expectedChallenge);
		});
	});
});
