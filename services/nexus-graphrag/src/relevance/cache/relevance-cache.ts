/**
 * Relevance Cache for Nexus Memory Lens
 *
 * Redis-based caching layer for relevance scores with:
 * - 5-minute TTL for score freshness
 * - Pattern-based invalidation on access events
 * - Tenant-aware key generation
 */

import Redis from 'ioredis';
import { createHash } from 'crypto';
import winston from 'winston';
import { EnhancedTenantContext } from '../../middleware/tenant-context';
import { FusedScoreResult } from '../scoring/score-calculator';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'relevance-cache' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Cache configuration
 */
export interface RelevanceCacheConfig {
  /** Redis client */
  redis: Redis;
  /** Default TTL in seconds (default: 300 = 5 minutes) */
  defaultTTL?: number;
  /** Key prefix for namespacing */
  keyPrefix?: string;
  /** Enable cache statistics */
  enableStats?: boolean;
}

/**
 * Cached relevance result
 */
export interface CachedRelevanceResult {
  /** Query that was cached */
  query: string;
  /** Cached scores */
  scores: Map<string, FusedScoreResult>;
  /** When this was cached */
  cachedAt: Date;
  /** TTL in seconds */
  ttl: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  hitRate: number;
}

/**
 * Relevance Cache
 */
export class RelevanceCache {
  private redis: Redis;
  private defaultTTL: number;
  private keyPrefix: string;
  private enableStats: boolean;

  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    hitRate: 0
  };

  constructor(config: RelevanceCacheConfig) {
    this.redis = config.redis;
    this.defaultTTL = config.defaultTTL || 300; // 5 minutes
    this.keyPrefix = config.keyPrefix || 'relevance';
    this.enableStats = config.enableStats !== false;

    logger.info('RelevanceCache initialized', {
      defaultTTL: this.defaultTTL,
      keyPrefix: this.keyPrefix,
      enableStats: this.enableStats
    });
  }

  /**
   * Get cached relevance scores for a query
   *
   * @param query - Query text
   * @param tenantContext - Tenant context
   * @returns Cached result or null if not found/expired
   */
  async get(
    query: string,
    tenantContext: EnhancedTenantContext
  ): Promise<CachedRelevanceResult | null> {
    try {
      const key = this.generateKey(query, tenantContext);
      const cached = await this.redis.get(key);

      if (!cached) {
        this.incrementMiss();
        return null;
      }

      const parsed = JSON.parse(cached);

      // Reconstruct Map from plain object
      const scores = new Map<string, FusedScoreResult>(
        Object.entries(parsed.scores)
      );

      this.incrementHit();

      logger.debug('Cache hit', {
        query: query.substring(0, 50),
        tenantId: tenantContext.tenantId,
        scoreCount: scores.size
      });

      return {
        query: parsed.query,
        scores,
        cachedAt: new Date(parsed.cachedAt),
        ttl: parsed.ttl
      };
    } catch (error) {
      logger.error('Cache get error', {
        error: (error as Error).message,
        query: query.substring(0, 50)
      });
      this.incrementMiss();
      return null;
    }
  }

  /**
   * Set relevance scores in cache
   *
   * @param query - Query text
   * @param scores - Map of node IDs to scores
   * @param tenantContext - Tenant context
   * @param ttl - Custom TTL (optional)
   */
  async set(
    query: string,
    scores: Map<string, FusedScoreResult>,
    tenantContext: EnhancedTenantContext,
    ttl?: number
  ): Promise<void> {
    try {
      const key = this.generateKey(query, tenantContext);
      const effectiveTTL = ttl ?? this.defaultTTL;

      const cacheEntry = {
        query,
        scores: Object.fromEntries(scores),
        cachedAt: new Date().toISOString(),
        ttl: effectiveTTL
      };

      await this.redis.setex(key, effectiveTTL, JSON.stringify(cacheEntry));

      logger.debug('Cache set', {
        query: query.substring(0, 50),
        tenantId: tenantContext.tenantId,
        scoreCount: scores.size,
        ttl: effectiveTTL
      });
    } catch (error) {
      logger.error('Cache set error', {
        error: (error as Error).message,
        query: query.substring(0, 50)
      });
      throw error;
    }
  }

  /**
   * Invalidate cache entries for a specific node
   *
   * When a node is accessed, invalidate all queries that might include it.
   *
   * @param nodeId - Node that was accessed
   * @param tenantContext - Tenant context
   * @returns Number of keys invalidated
   */
  async invalidateNode(
    nodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<number> {
    try {
      // Pattern: relevance:query:*:{tenantId}
      const pattern = this.buildKey(`query:*:${tenantContext.tenantId}`);
      const keys = await this.redis.keys(pattern);

      if (keys.length === 0) {
        return 0;
      }

      // Filter keys that might contain this node
      // In production, you'd store node IDs in the cache entry
      await this.redis.del(...keys);

      this.stats.invalidations += keys.length;

      logger.info('Node cache invalidated', {
        nodeId,
        tenantId: tenantContext.tenantId,
        invalidatedKeys: keys.length
      });

      return keys.length;
    } catch (error) {
      logger.error('Cache invalidation error', {
        error: (error as Error).message,
        nodeId
      });
      return 0;
    }
  }

  /**
   * Invalidate all cache entries for a tenant
   *
   * @param tenantContext - Tenant context
   * @returns Number of keys invalidated
   */
  async invalidateTenant(tenantContext: EnhancedTenantContext): Promise<number> {
    try {
      const pattern = this.buildKey(`query:*:${tenantContext.tenantId}`);
      const keys = await this.redis.keys(pattern);

      if (keys.length === 0) {
        return 0;
      }

      await this.redis.del(...keys);
      this.stats.invalidations += keys.length;

      logger.info('Tenant cache invalidated', {
        tenantId: tenantContext.tenantId,
        invalidatedKeys: keys.length
      });

      return keys.length;
    } catch (error) {
      logger.error('Tenant cache invalidation error', {
        error: (error as Error).message,
        tenantId: tenantContext.tenantId
      });
      return 0;
    }
  }

  /**
   * Clear all cache entries
   *
   * Use with caution!
   */
  async clear(): Promise<void> {
    try {
      const pattern = this.buildKey('*');
      const keys = await this.redis.keys(pattern);

      if (keys.length > 0) {
        await this.redis.del(...keys);
        this.stats.invalidations += keys.length;
      }

      this.resetStats();

      logger.info('Cache cleared', { clearedKeys: keys.length });
    } catch (error) {
      logger.error('Cache clear error', {
        error: (error as Error).message
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
        invalidations: 0,
        hitRate: 0
      };
    }

    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? this.stats.hits / total : 0;

    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 10000) / 100
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      invalidations: 0,
      hitRate: 0
    };
  }

  /**
   * Generate cache key for query
   *
   * Format: relevance:query:{hash}:{tenantId}
   *
   * @private
   */
  private generateKey(query: string, tenantContext: EnhancedTenantContext): string {
    // Hash query to keep keys manageable
    const hash = createHash('sha256')
      .update(query)
      .digest('hex')
      .substring(0, 16);

    return this.buildKey(`query:${hash}:${tenantContext.tenantId}`);
  }

  /**
   * Build full cache key with prefix
   *
   * @private
   */
  private buildKey(suffix: string): string {
    return `${this.keyPrefix}:${suffix}`;
  }

  /**
   * Increment hit counter
   *
   * @private
   */
  private incrementHit(): void {
    if (this.enableStats) {
      this.stats.hits++;
    }
  }

  /**
   * Increment miss counter
   *
   * @private
   */
  private incrementMiss(): void {
    if (this.enableStats) {
      this.stats.misses++;
    }
  }
}

/**
 * Create relevance cache instance
 *
 * @param redis - Redis client
 * @param config - Optional configuration
 * @returns RelevanceCache instance
 */
export function createRelevanceCache(
  redis: Redis,
  config?: Partial<RelevanceCacheConfig>
): RelevanceCache {
  return new RelevanceCache({
    redis,
    ...config
  });
}
