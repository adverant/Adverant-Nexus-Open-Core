/**
 * In-Memory Cache Implementation
 *
 * Provides a fallback caching solution when Redis is unavailable.
 * Useful for development, testing, and single-instance deployments.
 *
 * Warning: Not suitable for distributed systems - each instance
 * maintains its own cache.
 */

import { createLogger } from '@adverant/logger';

const logger = createLogger({ service: 'adverant-cache' });

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * Memory Cache
 *
 * In-memory cache with TTL support and automatic cleanup.
 */
export class MemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private defaultTTL: number = 300000) {
    // 5 minutes default (in milliseconds)
    this.startCleanupTimer();

    logger.debug('MemoryCache initialized', { defaultTTL });
  }

  /**
   * Start cleanup timer to remove expired entries
   */
  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Clean up expired entries every minute
  }

  /**
   * Set value in cache with optional TTL
   */
  set<T>(key: string, value: T, ttl?: number): void {
    this.cache.set(key, {
      data: value,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    });

    logger.debug('MemoryCache set', { key, ttl: ttl || this.defaultTTL });
  }

  /**
   * Get value from cache
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      logger.debug('MemoryCache miss', { key });
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      logger.debug('MemoryCache expired', { key });
      return null;
    }

    logger.debug('MemoryCache hit', { key });
    return entry.data as T;
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * Delete key from cache
   */
  delete(key: string): void {
    this.cache.delete(key);
    logger.debug('MemoryCache delete', { key });
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    logger.info('MemoryCache cleared');
  }

  /**
   * Cleanup expired entries
   */
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
      logger.debug('MemoryCache cleanup', { entriesRemoved: cleaned });
    }
  }

  /**
   * Get cache metrics
   */
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
      memoryUsage,
    };
  }

  /**
   * Cleanup and stop timer
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
    logger.debug('MemoryCache destroyed');
  }
}
