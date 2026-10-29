import { Redis } from "ioredis";

async function cleanRedisCache() {
	const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
	console.log(`🔌 Connecting to Redis at ${redisUrl}...`);
	const redis = new Redis(redisUrl, { lazyConnect: true });

	try {
		await redis.connect();
		console.log("✅ Connected to Redis successfully.");

		// 1. Scan and delete all legacy nsmcp:* keys
		let legacyDeleted = 0;
		let cursor = "0";
		do {
			const reply = await redis.scan(cursor, "MATCH", "nsmcp:*", "COUNT", 100);
			cursor = reply[0];
			const keys = reply[1];
			if (keys && keys.length > 0) {
				await redis.unlink(...keys);
				legacyDeleted += keys.length;
			}
		} while (cursor !== "0");
		console.log(`🗑️ Deleted ${legacyDeleted} legacy 'nsmcp:*' keys.`);

		// 2. Scan and delete all cached metadata in ns:* namespace (ns:*:ns_getsuiteqlmetadata_*, ns:*:ns_getrecordtypemetadata_*)
		let metadataDeleted = 0;
		cursor = "0";
		do {
			const reply = await redis.scan(
				cursor,
				"MATCH",
				"ns:*metadata*",
				"COUNT",
				100,
			);
			cursor = reply[0];
			const keys = reply[1];
			if (keys && keys.length > 0) {
				await redis.unlink(...keys);
				metadataDeleted += keys.length;
			}
		} while (cursor !== "0");
		console.log(`🗑️ Deleted ${metadataDeleted} cached 'ns:*metadata*' keys.`);

		// 3. Scan and delete any column probe cache keys
		let colprobeDeleted = 0;
		cursor = "0";
		do {
			const reply = await redis.scan(
				cursor,
				"MATCH",
				"ns:*colprobe*",
				"COUNT",
				100,
			);
			cursor = reply[0];
			const keys = reply[1];
			if (keys && keys.length > 0) {
				await redis.unlink(...keys);
				colprobeDeleted += keys.length;
			}
		} while (cursor !== "0");
		console.log(`🗑️ Deleted ${colprobeDeleted} cached 'ns:*colprobe*' keys.`);

		// Summary stats
		const remainingNsKeys = await redis.keys("ns:*");
		const remainingLegacyKeys = await redis.keys("nsmcp:*");
		console.log("\n📊 Redis Clean Slate Summary:");
		console.log(`   - Total legacy 'nsmcp:*' keys remaining: ${remainingLegacyKeys.length}`);
		console.log(`   - Total valid 'ns:*' keys remaining: ${remainingNsKeys.length}`);
		console.log("✨ Redis cache successfully reset to a clean baseline!");
	} catch (err) {
		console.error("❌ Failed to clean Redis cache:", err);
		process.exit(1);
	} finally {
		await redis.quit();
	}
}

cleanRedisCache();
