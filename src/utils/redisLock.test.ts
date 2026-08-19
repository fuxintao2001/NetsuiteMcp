import type { Redis } from "ioredis";
import Redlock from "redlock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisLockProvider } from "./redisLock.js";

describe("RedisLockProvider", () => {
	let mockRedis: any;
	let lockProvider: RedisLockProvider;

	beforeEach(() => {
		mockRedis = {};
		lockProvider = new RedisLockProvider(mockRedis as unknown as Redis);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it("should acquire a lock and return a non-null lock object", async () => {
		const mockLock = { release: vi.fn() };
		const acquireSpy = vi
			.spyOn(Redlock.prototype, "acquire")
			.mockResolvedValue(mockLock as any);

		const lock = await lockProvider.acquire("my-resource", 1000);

		expect(lock).toBe(mockLock);
		expect(acquireSpy).toHaveBeenCalledWith(["nsmcp:lock:my-resource"], 1000);
	});

	it("should return null when acquire fails", async () => {
		vi.spyOn(Redlock.prototype, "acquire").mockRejectedValue(
			new Error("Lock failed"),
		);

		const lock = await lockProvider.acquire("my-resource", 1000);

		expect(lock).toBeNull();
	});

	it("should return true on release success", async () => {
		const mockLock = { release: vi.fn().mockResolvedValue(undefined) };

		const result = await lockProvider.release("my-resource", mockLock as any);

		expect(result).toBe(true);
		expect(mockLock.release).toHaveBeenCalled();
	});

	it("should return false on release failure", async () => {
		const mockLock = {
			release: vi.fn().mockRejectedValue(new Error("Release failed")),
		};

		const result = await lockProvider.release("my-resource", mockLock as any);

		expect(result).toBe(false);
	});
});
