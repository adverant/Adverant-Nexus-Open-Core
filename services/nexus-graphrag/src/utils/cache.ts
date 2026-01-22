/**
 * Redis Query Cache Layer for GraphRAG
 *
 * Root Cause Fixed: QueryCache stub code (null as any) caused runtime crashes.
 *
 * Solution: Complete QueryCache implementation copied from proven videoagent service,
 * providing Redis-backed caching with TTL, pattern invalidation, and type-safe operations.
 */

import Redis from 'ioredis';
import { createHash } from 'crypto';

/**
 * Cache configuration
 */
export interface CacheConfig {
  redis: Redis;
  defaultTTL?: number; // Default TTL in seconds
  keyPrefix?: string; // Key prefix for namespacing
  enableCompression?: boolean; // Compress large values
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
  private readonly _enableCompression: boolean; // Compression feature flag - reserved for future use
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
    this.defaultTTL = config.defaultTTL || 60;
    this.keyPrefix = config.keyPrefix || 'cache';
    // Compression feature flag - reserved for future use
    this._enableCompression = config.enableCompression || false;
    this.enableStats = config.enableStats !== false;
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
        return null;
      }

      // Parse cached entry
      const entry = this.deserialize<CacheEntry<T>>(cached);

      if (!entry) {
        this.incrementMiss();
        return null;
      }

      // Check if expired (defensive check)
      const now = Date.now();
      if (entry.ttl > 0 && now - entry.timestamp > entry.ttl * 1000) {
        await this.delete(key);
        this.incrementMiss();
        return null;
      }

      this.incrementHit();
      return entry.value;
    } catch (error) {
      console.error('Cache get error:', error);
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
    } catch (error) {
      console.error('Cache set error:', error);
      throw error;
    }
  }

  /**
   * Get or set pattern: Try cache first, compute and cache if miss
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
    } catch (error) {
      console.error('Cache delete error:', error);
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
      console.error('Cache exists error:', error);
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
   */
  async invalidatePattern(pattern: string): Promise<number> {
    try {
      const fullPattern = this.buildKey(pattern);
      const keys = await this.redis.keys(fullPattern);

      if (keys.length === 0) {
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
      return deleted;
    } catch (error) {
      console.error('Cache invalidate pattern error:', error);
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
      }

      this.resetStats();
    } catch (error) {
      console.error('Cache clear error:', error);
      throw error;
    }
  }

  /**
   * Get time to live for a key
   */
  async ttl(key: string): Promise<number> {
    try {
      const fullKey = this.buildKey(key);
      return await this.redis.ttl(fullKey);
    } catch (error) {
      console.error('Cache ttl error:', error);
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
      }
    } catch (error) {
      console.error('Cache touch error:', error);
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
  }

  /**
   * Get cache configuration
   */
  getConfig(): { keyPrefix: string; defaultTTL: number; enableCompression: boolean } {
    return {
      keyPrefix: this.keyPrefix,
      defaultTTL: this.defaultTTL,
      enableCompression: this._enableCompression
    };
  }

  /**
   * Generate cache key from complex parameters
   *
   * Useful for caching query results based on multiple parameters.
   */
  static generateKey(prefix: string, params: Record<string, any>): string {
    // Sort keys for consistent hashing
    const sortedKeys = Object.keys(params).sort();
    const paramsString = sortedKeys
      .map(key => `${key}=${JSON.stringify(params[key])}`)
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
      console.error('Serialization error:', error);
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
      console.error('Deserialization error:', error);
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
 * Embedding cache entry structure
 * Stores the full embedding vector along with metadata
 */
export interface EmbeddingCacheEntry {
  embedding: number[];
  model: string;
  timestamp: string;
  contentLength: number;
}

/**
 * Dedicated Embedding Cache Service
 *
 * Provides content-hash based caching for embeddings with:
 * - SHA256 content hashing for deduplication
 * - 24-hour TTL for fresh embeddings
 * - Full 1024-dimensional vector storage
 * - Cache hit/miss tracking for metrics
 */
export class EmbeddingCache {
  private readonly redis: Redis;
  private readonly ttl: number;
  private hits: number = 0;
  private misses: number = 0;

  constructor(redis: Redis, ttlSeconds: number = 86400) {
    this.redis = redis;
    this.ttl = ttlSeconds; // Default: 24 hours
  }

  /**
   * Generate content hash for cache key
   */
  private generateContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get cached embedding for content
   *
   * @returns Embedding entry if cached, null otherwise
   */
  async getEmbedding(content: string): Promise<EmbeddingCacheEntry | null> {
    try {
      const hash = this.generateContentHash(content);
      const key = `embedding:${hash}`;
      const cached = await this.redis.get(key);

      if (!cached) {
        this.misses++;
        return null;
      }

      this.hits++;
      return JSON.parse(cached) as EmbeddingCacheEntry;
    } catch (error) {
      console.error('[EmbeddingCache] Get error:', error);
      this.misses++;
      return null;
    }
  }

  /**
   * Cache embedding for content
   *
   * @param content - The original content that was embedded
   * @param embedding - The embedding vector (1024 dimensions for Voyage-3)
   * @param model - The model used to generate the embedding
   */
  async setEmbedding(
    content: string,
    embedding: number[],
    model: string
  ): Promise<void> {
    try {
      const hash = this.generateContentHash(content);
      const key = `embedding:${hash}`;

      const entry: EmbeddingCacheEntry = {
        embedding,
        model,
        timestamp: new Date().toISOString(),
        contentLength: content.length,
      };

      await this.redis.setex(key, this.ttl, JSON.stringify(entry));
    } catch (error) {
      console.error('[EmbeddingCache] Set error:', error);
      // Don't throw - caching failures shouldn't block the main flow
    }
  }

  /**
   * Get or generate embedding with cache
   *
   * @param content - Content to embed
   * @param generateFn - Function to generate embedding if not cached
   * @returns Embedding vector and model
   */
  async getOrGenerate(
    content: string,
    generateFn: () => Promise<{ embedding: number[]; model: string }>
  ): Promise<{ embedding: number[]; model: string; cached: boolean }> {
    // Check cache first
    const cached = await this.getEmbedding(content);
    if (cached) {
      return {
        embedding: cached.embedding,
        model: cached.model,
        cached: true,
      };
    }

    // Generate new embedding
    const result = await generateFn();

    // Cache for future use (non-blocking)
    this.setEmbedding(content, result.embedding, result.model).catch(() => {
      // Ignore cache write failures
    });

    return {
      ...result,
      cached: false,
    };
  }

  /**
   * Get cache statistics
   */
  getStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 10000) / 100 : 0,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Clear all embedding cache entries
   */
  async clearAll(): Promise<number> {
    try {
      const keys = await this.redis.keys('embedding:*');
      if (keys.length === 0) return 0;

      const batchSize = 100;
      let deleted = 0;

      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await this.redis.del(...batch);
        deleted += batch.length;
      }

      return deleted;
    } catch (error) {
      console.error('[EmbeddingCache] Clear error:', error);
      return 0;
    }
  }
}

/**
 * Cache key generators for GraphRAG queries
 */
export const cacheKeys = {
  /**
   * Generate cache key for GraphRAG retrieval queries
   */
  graphragQuery: (query: string, options: Record<string, any> = {}): string => {
    return QueryCache.generateKey('graphrag:query', {
      query,
      ...options,
    });
  },

  /**
   * Generate cache key for embeddings (legacy - use EmbeddingCache instead)
   * @deprecated Use EmbeddingCache.getEmbedding() instead for full embedding caching
   */
  embedding: (text: string, model: string = 'voyage-3'): string => {
    return QueryCache.generateKey('graphrag:embedding', { text, model });
  },

  /**
   * Generate cache key for Neo4j graph queries
   */
  graphQuery: (cypherQuery: string, params: Record<string, any> = {}): string => {
    return QueryCache.generateKey('graphrag:graph', {
      query: cypherQuery,
      params,
    });
  },

  /**
   * Generate cache key for Qdrant vector searches
   */
  vectorSearch: (collectionName: string, vector: number[], limit: number): string => {
    // Hash the vector for reasonable key length
    const vectorHash = createHash('sha256')
      .update(JSON.stringify(vector))
      .digest('hex')
      .substring(0, 16);

    return QueryCache.generateKey('graphrag:vector', {
      collection: collectionName,
      vectorHash,
      limit,
    });
  },
};
