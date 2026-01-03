/**
 * Redis Query Cache Layer
 *
 * Distributed caching with TTL management, pattern invalidation,
 * and comprehensive statistics tracking.
 *
 * Features:
 * - Type-safe Redis caching with automatic serialization
 * - TTL (Time To Live) management
 * - Pattern-based invalidation (e.g., "user:*")
 * - Cache statistics (hit rate, miss rate)
 * - Batch operations for performance
 * - Decorators for method-level caching
 */

import type Redis from 'ioredis';
import { createHash } from 'crypto';
import { createLogger } from '@adverant/logger';

const logger = createLogger({ service: 'adverant-cache' });

/**
 * Cache configuration
 */
export interface CacheConfig {
  redis: Redis;
  defaultTTL?: number; // Default TTL in seconds
  keyPrefix?: string; // Key prefix for namespacing
  enableCompression?: boolean; // Compress large values (future enhancement)
  enableStats?: boolean; // Track cache statistics
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  invalidations: number;
  hitRate: number;
}

/**
 * Cache entry metadata
 */
interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl: number;
}

/**
 * Query Cache Implementation
 *
 * Provides type-safe Redis caching with automatic serialization,
 * TTL management, and pattern-based invalidation.
 */
export class QueryCache {
  private readonly redis: Redis;
  private readonly defaultTTL: number;
  private readonly keyPrefix: string;
  private readonly enableCompression: boolean;
  private readonly enableStats: boolean;

  // Statistics
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    invalidations: 0,
    hitRate: 0,
  };

  constructor(config: CacheConfig) {
    this.redis = config.redis;
    this.defaultTTL = config.defaultTTL || 300; // 5 minutes default
    this.keyPrefix = config.keyPrefix || 'cache';
    this.enableCompression = config.enableCompression || false;
    this.enableStats = config.enableStats !== false;

    logger.debug('QueryCache initialized', {
      keyPrefix: this.keyPrefix,
      defaultTTL: this.defaultTTL,
      enableStats: this.enableStats,
    });
  }

  /**
   * Get value from cache
   *
   * Returns null if key doesn't exist or has expired.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const fullKey = this.buildKey(key);
      const cached = await this.redis.get(fullKey);

      if (!cached) {
        this.incrementMiss();
        logger.debug('Cache miss', { key });
        return null;
      }

      // Parse cached entry
      const entry = this.deserialize<CacheEntry<T>>(cached);

      if (!entry) {
        this.incrementMiss();
        logger.warn('Cache deserialization failed', { key });
        return null;
      }

      // Check if expired (defensive check - Redis should handle TTL)
      const now = Date.now();
      if (entry.ttl > 0 && now - entry.timestamp > entry.ttl * 1000) {
        await this.delete(key);
        this.incrementMiss();
        logger.debug('Cache expired', { key });
        return null;
      }

      this.incrementHit();
      logger.debug('Cache hit', { key });
      return entry.value;
    } catch (error) {
      logger.error('Cache get error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.incrementMiss();
      return null;
    }
  }

  /**
   * Set value in cache with optional TTL
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const fullKey = this.buildKey(key);
      const effectiveTTL = ttl !== undefined ? ttl : this.defaultTTL;

      // Create cache entry with metadata
      const entry: CacheEntry<T> = {
        value,
        timestamp: Date.now(),
        ttl: effectiveTTL,
      };

      const serialized = this.serialize(entry);

      if (effectiveTTL > 0) {
        await this.redis.setex(fullKey, effectiveTTL, serialized);
      } else {
        // TTL of 0 means no expiration
        await this.redis.set(fullKey, serialized);
      }

      this.incrementSet();
      logger.debug('Cache set', { key, ttl: effectiveTTL });
    } catch (error) {
      logger.error('Cache set error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Get or set pattern: Try cache first, compute and cache if miss
   *
   * This implements the cache-aside pattern for optimal performance.
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    // Try cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Cache miss - compute value
    logger.debug('Cache miss - computing value', { key });
    const value = await factory();

    // Cache the computed value
    await this.set(key, value, ttl);

    return value;
  }

  /**
   * Delete key from cache
   */
  async delete(key: string): Promise<void> {
    try {
      const fullKey = this.buildKey(key);
      await this.redis.del(fullKey);
      this.incrementDelete();
      logger.debug('Cache delete', { key });
    } catch (error) {
      logger.error('Cache delete error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Check if key exists in cache
   */
  async exists(key: string): Promise<boolean> {
    try {
      const fullKey = this.buildKey(key);
      const exists = await this.redis.exists(fullKey);
      return exists === 1;
    } catch (error) {
      logger.error('Cache exists error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Invalidate all keys matching a pattern
   *
   * Pattern examples:
   * - "user:*" - All user-related keys
   * - "job:123:*" - All keys for job 123
   * - "*:status" - All status keys
   *
   * Returns the number of keys deleted.
   */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const fullPattern = this.buildKey(pattern);
      const keys = await this.redis.keys(fullPattern);

      if (keys.length === 0) {
        logger.debug('No keys matched pattern', { pattern });
        return 0;
      }

      // Delete in batches to avoid blocking Redis
      const batchSize = 100;
      let deleted = 0;

      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await this.redis.del(...batch);
        deleted += batch.length;
      }

      this.stats.invalidations += deleted;
      logger.info('Cache pattern invalidated', { pattern, deleted });
      return deleted;
    } catch (error) {
      logger.error('Cache invalidate pattern error', {
        pattern,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Clear all cache entries (use with caution!)
   */
  async clear(): Promise<void> {
    try {
      const pattern = this.buildKey('*');
      const keys = await this.redis.keys(pattern);

      if (keys.length > 0) {
        await this.redis.del(...keys);
        logger.info('Cache cleared', { keysDeleted: keys.length });
      }

      this.resetStats();
    } catch (error) {
      logger.error('Cache clear error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Get time to live for a key
   *
   * Returns:
   * - TTL in seconds if key exists and has TTL
   * - -1 if key exists but has no expiration
   * - -2 if key doesn't exist
   */
  async ttl(key: string): Promise<number> {
    try {
      const fullKey = this.buildKey(key);
      return await this.redis.ttl(fullKey);
    } catch (error) {
      logger.error('Cache ttl error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return -2; // Key doesn't exist
    }
  }

  /**
   * Refresh TTL for a key without changing the value
   */
  async touch(key: string, ttl?: number): Promise<void> {
    try {
      const fullKey = this.buildKey(key);
      const effectiveTTL = ttl !== undefined ? ttl : this.defaultTTL;

      if (effectiveTTL > 0) {
        await this.redis.expire(fullKey, effectiveTTL);
        logger.debug('Cache key touched', { key, ttl: effectiveTTL });
      }
    } catch (error) {
      logger.error('Cache touch error', {
        key,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    if (!this.enableStats) {
      return {
        hits: 0,
        misses: 0,
        sets: 0,
        deletes: 0,
        invalidations: 0,
        hitRate: 0,
      };
    }

    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 10000) / 100, // Percentage with 2 decimals
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      invalidations: 0,
      hitRate: 0,
    };
    logger.debug('Cache stats reset');
  }

  /**
   * Generate cache key from complex parameters
   *
   * Useful for caching query results based on multiple parameters.
   * Creates a deterministic hash for consistent cache keys.
   */
  static generateKey(prefix: string, params: Record<string, any>): string {
    // Sort keys for consistent hashing
    const sortedKeys = Object.keys(params).sort();
    const paramsString = sortedKeys
      .map((key) => `${key}=${JSON.stringify(params[key])}`)
      .join('&');

    // Hash to keep keys manageable
    const hash = createHash('sha256')
      .update(paramsString)
      .digest('hex')
      .substring(0, 16);

    return `${prefix}:${hash}`;
  }

  /**
   * Build full cache key with prefix
   */
  private buildKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  /**
   * Serialize value for storage
   */
  private serialize<T>(value: T): string {
    try {
      return JSON.stringify(value);
    } catch (error) {
      logger.error('Serialization error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error('Failed to serialize cache value');
    }
  }

  /**
   * Deserialize value from storage
   */
  private deserialize<T>(value: string): T | null {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error('Deserialization error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Update statistics
   */
  private incrementHit(): void {
    if (this.enableStats) {
      this.stats.hits++;
    }
  }

  private incrementMiss(): void {
    if (this.enableStats) {
      this.stats.misses++;
    }
  }

  private incrementSet(): void {
    if (this.enableStats) {
      this.stats.sets++;
    }
  }

  private incrementDelete(): void {
    if (this.enableStats) {
      this.stats.deletes++;
    }
  }
}

/**
 * Cache decorator for class methods
 *
 * Automatically caches method results based on arguments.
 *
 * Usage:
 * ```typescript
 * class UserService {
 *   cache = new QueryCache(config);
 *
 *   @Cacheable('user', 60)
 *   async getUser(userId: string): Promise<User> {
 *     return await database.getUser(userId);
 *   }
 * }
 * ```
 */
export function Cacheable(keyPrefix: string, ttl?: number) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const cache: QueryCache = (this as any).cache;

      if (!cache) {
        // No cache available, call original method
        logger.debug('No cache available - calling original method', {
          method: propertyKey,
        });
        return originalMethod.apply(this, args);
      }

      // Generate cache key from arguments
      const cacheKey = QueryCache.generateKey(keyPrefix, { args });

      // Try cache first
      return cache.getOrSet(
        cacheKey,
        () => originalMethod.apply(this, args),
        ttl
      );
    };

    return descriptor;
  };
}

/**
 * Cache invalidation decorator
 *
 * Automatically invalidates cache entries after method execution.
 *
 * Usage:
 * ```typescript
 * class UserService {
 *   cache = new QueryCache(config);
 *
 *   @InvalidateCache('user:*')
 *   async updateUser(userId: string, data: UserData): Promise<void> {
 *     await database.updateUser(userId, data);
 *   }
 * }
 * ```
 */
export function InvalidateCache(pattern: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const result = await originalMethod.apply(this, args);

      const cache: QueryCache = (this as any).cache;
      if (cache) {
        await cache.invalidatePattern(pattern);
        logger.debug('Cache invalidated after method execution', {
          method: propertyKey,
          pattern,
        });
      }

      return result;
    };

    return descriptor;
  };
}
