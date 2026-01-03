/**
 * @adverant/cache
 * Redis-backed distributed caching for Nexus stack services
 */

export {
  QueryCache,
  Cacheable,
  InvalidateCache,
  type CacheConfig,
  type CacheStats,
} from './query-cache';

export { MemoryCache } from './memory-cache';

export { cacheKeys, invalidationPatterns } from './cache-keys';

/**
 * Re-export Redis type for convenience
 */
export type { Redis } from 'ioredis';
