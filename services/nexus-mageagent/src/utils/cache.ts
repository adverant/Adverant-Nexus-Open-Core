import { logger } from './logger';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private defaultTTL: number = 300000) { // 5 minutes default
    this.startCleanupTimer();
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Clean up expired entries every minute
  }

  set<T>(key: string, value: T, ttl?: number): void {
    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    });
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cache cleanup: removed ${cleaned} expired entries`);
    }
  }

  getMetrics(): {
    size: number;
    memoryUsage: number;
  } {
    let memoryUsage = 0;

    // Estimate memory usage
    for (const [key, entry] of this.cache.entries()) {
      memoryUsage += key.length * 2; // Unicode characters
      memoryUsage += JSON.stringify(entry.data).length * 2;
      memoryUsage += 16; // Overhead for timestamp and ttl
    }

    return {
      size: this.cache.size,
      memoryUsage
    };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }
}

// Redis-backed cache for distributed caching
export class RedisCache {
  constructor(private redisClient: any, private defaultTTL: number = 300) {} // 5 minutes default

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.redisClient.setex(
        `cache:${key}`,
        ttl || this.defaultTTL,
        serialized
      );
    } catch (error) {
      logger.error('Redis cache set error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.redisClient.get(`cache:${key}`);
      if (!data) return null;

      return JSON.parse(data) as T;
    } catch (error) {
      logger.error('Redis cache get error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const exists = await this.redisClient.exists(`cache:${key}`);
      return exists === 1;
    } catch (error) {
      logger.error('Redis cache exists error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redisClient.del(`cache:${key}`);
    } catch (error) {
      logger.error('Redis cache delete error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async clear(pattern: string = '*'): Promise<void> {
    try {
      const keys = await this.redisClient.keys(`cache:${pattern}`);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    } catch (error) {
      logger.error('Redis cache clear error', {
        pattern,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

// Cache key generators
export const cacheKeys = {
  model: (modelId: string) => `model:${modelId}`,
  agentResult: (agentId: string, taskId: string) => `agent:${agentId}:task:${taskId}`,
  competitionResult: (competitionId: string) => `competition:${competitionId}`,
  pattern: (context: string) => `pattern:${context}`,
  memory: (queryHash: string) => `memory:${queryHash}`,
  modelList: () => 'models:list'
};