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
			mockRedisInstance.scan.mockResolvedValueOnce(["0", ["ns:acc1:key1"]]);
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
				"ns:acc1:mykey",
				JSON.stringify({ foo: "bar" }),
				"EX",
				60,
			);

			const result = await cache.get<any>("acc1", "myKey");
			expect(mockRedisInstance.get).toHaveBeenCalledWith("ns:acc1:mykey");
			expect(result).toEqual({ foo: "bar" });
		});

		it("should set without EX if ttl is 0", async () => {
			await cache.set("acc1", "myKey", "val", 0);
			expect(mockRedisInstance.set).toHaveBeenCalledWith(
				"ns:acc1:mykey",
				JSON.stringify("val"),
			);
		});

		it("should delete keys from Redis", async () => {
			await cache.delete("acc1", "deleteKey");
			expect(mockRedisInstance.del).toHaveBeenCalledWith("ns:acc1:deletekey");
		});

		it("should scan and clear all cache for a specific account", async () => {
			mockRedisInstance.scan.mockResolvedValueOnce([
				"0",
				["ns:acc1:key1", "ns:acc1:key2"],
			]);

			await cache.clearAccountCache("acc1");

			expect(mockRedisInstance.scan).toHaveBeenCalledWith(
				"0",
				"MATCH",
				"ns:acc1:*",
				"COUNT",
				100,
			);
			expect(mockRedisInstance.del).toHaveBeenCalledWith(
				"ns:acc1:key1",
				"ns:acc1:key2",
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
			expect(acquireSpy).toHaveBeenCalledWith(["ns:lock:my-resource"], 1000);
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

			const result = await lockProvider.release(mockLock as any);

			expect(result).toBe(true);
			expect(mockLock.release).toHaveBeenCalled();
		});

		it("should return false on release failure", async () => {
			const mockLock = {
				release: vi.fn().mockRejectedValue(new Error("Release failed")),
			};

			const result = await lockProvider.release(mockLock as any);

			expect(result).toBe(false);
		});
	});

	describe("TieredCacheProvider (L1 LRU + L2 Redis)", () => {
		let mockL2: any;
		let tiered: any;

		beforeEach(async () => {
			const { TieredCacheProvider } = await import("./tieredCacheProvider.js");
			mockL2 = {
				connect: vi.fn().mockResolvedValue(undefined),
				disconnect: vi.fn().mockResolvedValue(undefined),
				get: vi.fn(),
				set: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
				clearAccountCache: vi.fn().mockResolvedValue(undefined),
				getStats: vi.fn().mockResolvedValue({
					provider: "redis",
					connected: true,
					keyCount: 5,
				}),
			};
			tiered = new TieredCacheProvider(mockL2, {
				l1MaxItems: 10,
				l1TtlMs: 60000,
			});
		});

		it("should set into both L1 and L2 and hit L1 on subsequent get without touching L2", async () => {
			await tiered.set("acc1", "user", { name: "Alice" }, 300);
			expect(mockL2.set).toHaveBeenCalledWith(
				"acc1",
				"user",
				{ name: "Alice" },
				300,
			);

			// Subsequent get should hit L1 without calling L2.get
			const val = await tiered.get("acc1", "user");
			expect(val).toEqual({ name: "Alice" });
			expect(mockL2.get).not.toHaveBeenCalled();
		});

		it("should populate L1 on L2 hit when L1 misses", async () => {
			mockL2.get.mockResolvedValueOnce({ name: "Bob" });

			const val1 = await tiered.get("acc1", "bobKey");
			expect(val1).toEqual({ name: "Bob" });
			expect(mockL2.get).toHaveBeenCalledTimes(1);

			// Second get should be served from L1
			const val2 = await tiered.get("acc1", "bobKey");
			expect(val2).toEqual({ name: "Bob" });
			expect(mockL2.get).toHaveBeenCalledTimes(1);
		});

		it("should delete key from both L1 and L2", async () => {
			await tiered.set("acc1", "delKey", "value");
			await tiered.delete("acc1", "delKey");

			expect(mockL2.delete).toHaveBeenCalledWith("acc1", "delKey");

			// L1 should no longer have the key; next get queries L2
			mockL2.get.mockResolvedValueOnce(null);
			const val = await tiered.get("acc1", "delKey");
			expect(val).toBeNull();
			expect(mockL2.get).toHaveBeenCalledWith("acc1", "delKey");
		});

		it("should clear account cache from L1 and L2", async () => {
			await tiered.set("acc1", "k1", "v1");
			await tiered.set("acc1", "k2", "v2");
			await tiered.set("acc2", "k3", "v3");

			await tiered.clearAccountCache("acc1");
			expect(mockL2.clearAccountCache).toHaveBeenCalledWith("acc1");

			// acc1 keys evicted from L1; next get queries L2
			mockL2.get.mockResolvedValueOnce(null);
			const val = await tiered.get("acc1", "k1");
			expect(val).toBeNull();
			expect(mockL2.get).toHaveBeenCalledWith("acc1", "k1");

			// acc2 key still in L1 (hits L1 without calling L2)
			const valAcc2 = await tiered.get("acc2", "k3");
			expect(valAcc2).toBe("v3");
		});

		it("should aggregate stats correctly from L1 and L2", async () => {
			await tiered.set("acc1", "k1", "v1");
			const stats = await tiered.getStats();
			expect(stats.provider).toBe("tiered(l1:lru,l2:redis)");
			expect(stats.connected).toBe(true);
			expect(stats.keyCount).toBe(6); // 1 in L1 + 5 in L2
		});
	});
});
