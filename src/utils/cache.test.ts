import type { Redis } from "ioredis";
import Redlock from "redlock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheService } from "./cache.js";
import { RedisCacheProvider } from "./redisCacheProvider.js";
import { RedisLockProvider } from "./redisLock.js";

describe("Cache & Locking", () => {
	describe("CacheService with RedisCacheProvider (DI Mock)", () => {
		let mockRedisInstance: any;
		let provider: RedisCacheProvider;
		let cache: CacheService;

		beforeEach(() => {
			vi.clearAllMocks();

			mockRedisInstance = {
				connect: vi.fn().mockResolvedValue(undefined),
				quit: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(),
				set: vi.fn(),
				del: vi.fn(),
				scan: vi.fn(),
			};

			provider = new RedisCacheProvider(
				"redis://localhost:6379",
				mockRedisInstance,
			);
			cache = new CacheService();
			cache.configure(provider);
		});

		it("should get stats based on mock instance connection status", async () => {
			mockRedisInstance.scan.mockResolvedValueOnce(["0", ["nsmcp:acc1:key1"]]);
			const stats = await cache.getStats();
			expect(stats).toEqual({
				provider: "redis",
				connected: true,
				keyCount: 1,
			});
		});

		it("should set and get values in Redis", async () => {
			mockRedisInstance.get.mockResolvedValue(JSON.stringify({ foo: "bar" }));

			await cache.set("acc1", "myKey", { foo: "bar" }, 60);
			expect(mockRedisInstance.set).toHaveBeenCalledWith(
				"nsmcp:acc1:mykey",
				JSON.stringify({ foo: "bar" }),
				"EX",
				60,
			);

			const result = await cache.get<any>("acc1", "myKey");
			expect(mockRedisInstance.get).toHaveBeenCalledWith("nsmcp:acc1:mykey");
			expect(result).toEqual({ foo: "bar" });
		});

		it("should set without EX if ttl is 0", async () => {
			await cache.set("acc1", "myKey", "val", 0);
			expect(mockRedisInstance.set).toHaveBeenCalledWith(
				"nsmcp:acc1:mykey",
				JSON.stringify("val"),
			);
		});

		it("should delete keys from Redis", async () => {
			await cache.delete("acc1", "deleteKey");
			expect(mockRedisInstance.del).toHaveBeenCalledWith(
				"nsmcp:acc1:deletekey",
			);
		});

		it("should scan and clear all cache for a specific account", async () => {
			mockRedisInstance.scan.mockResolvedValueOnce([
				"0",
				["nsmcp:acc1:key1", "nsmcp:acc1:key2"],
			]);

			await cache.clearAccountCache("acc1");

			expect(mockRedisInstance.scan).toHaveBeenCalledWith(
				"0",
				"MATCH",
				"nsmcp:acc1:*",
				"COUNT",
				100,
			);
			expect(mockRedisInstance.del).toHaveBeenCalledWith(
				"nsmcp:acc1:key1",
				"nsmcp:acc1:key2",
			);
		});
	});

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
});
