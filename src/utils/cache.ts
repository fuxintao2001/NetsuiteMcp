import NodeCache from 'node-cache';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { asyncJsonParse } from './json.js';

interface CacheEnvelope<T> {
  expiration: number;   // UTC 毫秒时间戳
  ttlSeconds: number;   // 原始 TTL
  data: T;
}

export class CacheService {
  private memoryCache: NodeCache;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.memoryCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
    this.projectRoot = projectRoot ?? process.cwd();
  }

  configure(projectRoot: string): void {
    this.projectRoot = projectRoot;
  }

  /**
   * 生成确定性、防冲突且完全小写的文件路径，防止在区分大小写的文件系统上漏删
   */
  private getFileSystemCachePath(accountId: string, key: string): string {
    const normalizedKey = key.toLowerCase();
    const hash = createHash('sha256').update(normalizedKey).digest('hex');
    const safePrefix = normalizedKey.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safePrefix}_${hash.slice(0, 16)}.json`;
    return path.join(this.projectRoot, '.cache', accountId.toLowerCase().replace(/_/g, '-'), filename);
  }

  async get<T>(accountId: string, key: string): Promise<T | null> {
    // 将内存缓存键归一化为小写，确保 L1/L2 大小写处理的一致性
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    
    // L1 内存缓存检查
    const memResult = this.memoryCache.get<T>(memKey);
    if (memResult !== undefined) {
      console.error(`⚡ [Cache Hit L1] Memory cache hit for ${key}`);
      return memResult;
    }

    // L2 文件系统缓存检查
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      const stats = await fs.stat(fsPath);
      const fileData = await fs.readFile(fsPath, 'utf-8');
      const envelope = await asyncJsonParse<any>(fileData);
      
      if (envelope && typeof envelope === 'object' && 'expiration' in envelope && 'data' in envelope) {
        const now = Date.now();
        if (now < envelope.expiration) {
          const remainingTtl = Math.max(1, Math.round((envelope.expiration - now) / 1000));
          // 使用剩余 of the TTL 晋升回 L1 内存缓存
          this.memoryCache.set(memKey, envelope.data, remainingTtl);
          console.error(`⚡ [Cache Hit L2] File cache hit for ${key}. Promoted to L1 (remaining TTL: ${remainingTtl}s).`);
          return envelope.data;
        } else {
          // 已过期，异步删除 L2 缓存文件
          fs.unlink(fsPath).catch(() => {});
        }
      } else {
        // 对旧版缓存格式的向前兼容回退处理
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < 3600 * 1000) {
          this.memoryCache.set(memKey, envelope);
          console.error(`⚡ [Cache Hit L2 Legacy] File cache hit for legacy key ${key}. Promoted to L1.`);
          return envelope as T;
        } else {
          fs.unlink(fsPath).catch(() => {});
        }
      }
    } catch {
      // 忽略读取错误
    }
    return null;
  }

  async set<T>(accountId: string, key: string, data: T, ttlSeconds: number = 3600): Promise<void> {
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    this.memoryCache.set(memKey, data, ttlSeconds);

    const fsPath = this.getFileSystemCachePath(accountId, key);
    const envelope: CacheEnvelope<T> = {
      expiration: Date.now() + (ttlSeconds * 1000),
      ttlSeconds,
      data
    };

    try {
      await fs.mkdir(path.dirname(fsPath), { recursive: true });
      // 压缩 JSON（无多余空格缩进）以优化性能并减少磁盘占用
      await fs.writeFile(fsPath, JSON.stringify(envelope), 'utf-8');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to write L2 cache for ${key}: ${message}`);
    }
  }

  async delete(accountId: string, key: string): Promise<void> {
    const memKey = `${accountId.toLowerCase()}::${key.toLowerCase()}`;
    this.memoryCache.del(memKey);
    const fsPath = this.getFileSystemCachePath(accountId, key);
    try {
      await fs.unlink(fsPath);
    } catch {}
  }

  /**
   * 清除指定账户的所有 L1 与 L2 缓存
   */
  async clearAccountCache(accountId: string): Promise<void> {
    // 清理 L1 内存
    const keys = this.memoryCache.keys();
    const accountKeys = keys.filter(k => k.toLowerCase().startsWith(`${accountId.toLowerCase()}::`));
    this.memoryCache.del(accountKeys);

    // 清理 L2 磁盘缓存
    const fsPath = this.getFileSystemCachePath(accountId, 'dummy');
    const fsDir = path.dirname(fsPath);
    try {
      await fs.rm(fsDir, { recursive: true, force: true });
      console.error(`🗑️ L1 and L2 Cache cleared for account ${accountId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠️ Failed to clear L2 cache for ${accountId}: ${message}`);
    }
  }

  /**
   * 一次性清理指定账户下的旧格式（未带哈希）缓存文件
   */
  async migrateFromLegacyFormat(accountId: string): Promise<void> {
    const dummyPath = this.getFileSystemCachePath(accountId, 'dummy');
    const cacheDir = path.dirname(dummyPath);
    try {
      const files = await fs.readdir(cacheDir);
      let cleaned = 0;
      for (const file of files) {
        // 旧格式文件特征：文件名以 .json 结尾，且不带 _[a-f0-9]{16}.json 模式
        if (file.endsWith('.json') && !/_[a-f0-9]{16}\.json$/.test(file)) {
          await fs.unlink(path.join(cacheDir, file)).catch(() => {});
          cleaned++;
        }
      }
      if (cleaned > 0) {
        console.error(`🧹 Cleaned ${cleaned} legacy cache files for ${accountId}`);
      }
    } catch {
      // 目录不存在则忽略
    }
  }

  /**
   * 获取缓存诊断状态指标
   */
  getStats(): { l1KeyCount: number; l2CacheDir: string } {
    return {
      l1KeyCount: this.memoryCache.keys().length,
      l2CacheDir: path.join(this.projectRoot, '.cache')
    };
  }
}

// 导出 CacheService 的单例实例，供全局引用
export const cacheService = new CacheService();
