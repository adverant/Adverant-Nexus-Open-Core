/**
 * Distributed Lock Manager - Redis-Based Mutual Exclusion
 *
 * Implements distributed locking pattern using Redis SET NX with TTL.
 * Prevents race conditions in distributed systems by ensuring only
 * one process can hold a lock at a time.
 *
 * Features:
 * - Automatic lock expiration (TTL) to prevent deadlocks
 * - Unique lock tokens to prevent accidental unlock
 * - Retry with exponential backoff
 * - Lock extension for long-running operations
 *
 * @pattern Distributed Lock Pattern
 * @pattern Circuit Breaker Pattern (for Redis failures)
 */

import type { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DistributedLock');

/**
 * Lock acquisition result
 */
export interface LockResult {
  acquired: boolean;
  token?: string; // Unique token to release lock
  expiresAt?: Date;
}

/**
 * Lock configuration
 */
export interface LockConfig {
  ttlMs?: number; // Lock TTL in milliseconds (default: 5000ms)
  retryCount?: number; // Max retry attempts (default: 0 = no retries)
  retryDelayMs?: number; // Initial retry delay (default: 100ms)
  retryBackoffMultiplier?: number; // Backoff multiplier (default: 2)
}

/**
 * Distributed Lock Manager
 *
 * Manages distributed locks using Redis SET NX (Set if Not eXists)
 * with automatic expiration to prevent deadlocks.
 */
export class DistributedLockManager {
  private readonly redis: Redis;
  private readonly keyPrefix: string;

  constructor(redis: Redis, keyPrefix: string = 'nexus:locks') {
    if (!redis) {
      throw new Error('Redis client is required for DistributedLockManager');
    }

    this.redis = redis;
    this.keyPrefix = keyPrefix;

    logger.info('DistributedLockManager initialized', { keyPrefix });
  }

  /**
   * Acquire a distributed lock
   *
   * Algorithm:
   * 1. Generate unique lock token
   * 2. Attempt to SET NX with TTL
   * 3. If failed and retries configured, retry with exponential backoff
   * 4. Return lock result with token for release
   *
   * @param lockKey - Unique key for the lock
   * @param config - Lock configuration
   * @returns Lock result with acquisition status and token
   */
  async acquire(lockKey: string, config: LockConfig = {}): Promise<LockResult> {
    const {
      ttlMs = 5000,
      retryCount = 0,
      retryDelayMs = 100,
      retryBackoffMultiplier = 2
    } = config;

    const fullKey = this.getLockKey(lockKey);
    const token = uuidv4(); // Unique token to prevent accidental unlock
    let attempt = 0;

    while (attempt <= retryCount) {
      attempt++;

      try {
        // SET NX PX (Set if Not eXists with expiration in milliseconds)
        const result = await this.redis.set(fullKey, token, 'PX', ttlMs, 'NX');

        if (result === 'OK') {
          const expiresAt = new Date(Date.now() + ttlMs);

          logger.debug('Lock acquired successfully', {
            lockKey,
            token,
            attempt,
            expiresAt,
            ttlMs
          });

          return {
            acquired: true,
            token,
            expiresAt
          };
        }

        // Lock not acquired - retry if configured
        if (attempt <= retryCount) {
          const delay = retryDelayMs * Math.pow(retryBackoffMultiplier, attempt - 1);
          logger.debug('Lock acquisition failed, retrying', {
            lockKey,
            attempt,
            maxRetries: retryCount,
            delayMs: delay
          });

          await this.sleep(delay);
        }
      } catch (error: any) {
        logger.error('Error acquiring lock', {
          lockKey,
          attempt,
          error: error.message,
          stack: error.stack
        });

        // Don't retry on Redis errors
        return { acquired: false };
      }
    }

    logger.warn('Lock acquisition failed after all retries', {
      lockKey,
      attempts: attempt,
      maxRetries: retryCount
    });

    return { acquired: false };
  }

  /**
   * Release a distributed lock
   *
   * Uses Lua script to atomically check token and delete lock.
   * Prevents accidental unlock of someone else's lock.
   *
   * @param lockKey - Lock key to release
   * @param token - Token from acquire() to verify ownership
   * @returns true if lock was released, false otherwise
   */
  async release(lockKey: string, token: string): Promise<boolean> {
    const fullKey = this.getLockKey(lockKey);

    try {
      // Lua script for atomic check-and-delete
      // ARGV[1] = token to check
      // Returns 1 if deleted, 0 if not found or token mismatch
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;

      const result = await this.redis.eval(luaScript, 1, fullKey, token);

      if (result === 1) {
        logger.debug('Lock released successfully', { lockKey, token });
        return true;
      } else {
        logger.warn('Lock release failed - token mismatch or lock expired', {
          lockKey,
          token
        });
        return false;
      }
    } catch (error: any) {
      logger.error('Error releasing lock', {
        lockKey,
        token,
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  }

  /**
   * Extend lock expiration (for long-running operations)
   *
   * Uses Lua script to atomically check token and extend TTL.
   *
   * @param lockKey - Lock key to extend
   * @param token - Token from acquire() to verify ownership
   * @param ttlMs - Additional TTL in milliseconds
   * @returns true if extended, false otherwise
   */
  async extend(lockKey: string, token: string, ttlMs: number): Promise<boolean> {
    const fullKey = this.getLockKey(lockKey);

    try {
      // Lua script for atomic check-and-extend
      const luaScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("pexpire", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;

      const result = await this.redis.eval(luaScript, 1, fullKey, token, ttlMs);

      if (result === 1) {
        logger.debug('Lock extended successfully', { lockKey, token, ttlMs });
        return true;
      } else {
        logger.warn('Lock extension failed - token mismatch or lock expired', {
          lockKey,
          token
        });
        return false;
      }
    } catch (error: any) {
      logger.error('Error extending lock', {
        lockKey,
        token,
        ttlMs,
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  }

  /**
   * Check if lock is currently held
   *
   * @param lockKey - Lock key to check
   * @returns true if lock exists, false otherwise
   */
  async isLocked(lockKey: string): Promise<boolean> {
    const fullKey = this.getLockKey(lockKey);

    try {
      const exists = await this.redis.exists(fullKey);
      return exists === 1;
    } catch (error: any) {
      logger.error('Error checking lock status', {
        lockKey,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get remaining TTL for a lock
   *
   * @param lockKey - Lock key to check
   * @returns Remaining TTL in milliseconds, -1 if no TTL, -2 if not exists
   */
  async getTTL(lockKey: string): Promise<number> {
    const fullKey = this.getLockKey(lockKey);

    try {
      const ttl = await this.redis.pttl(fullKey); // PTTL returns milliseconds
      return ttl;
    } catch (error: any) {
      logger.error('Error getting lock TTL', {
        lockKey,
        error: error.message
      });
      return -2; // Not exists
    }
  }

  /**
   * Execute function with lock protection
   *
   * Automatically acquires lock, executes function, and releases lock.
   * Ensures lock is always released even if function throws.
   *
   * @param lockKey - Lock key
   * @param fn - Function to execute with lock held
   * @param config - Lock configuration
   * @returns Function result
   * @throws Error if lock cannot be acquired
   */
  async withLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    config: LockConfig = {}
  ): Promise<T> {
    const lockResult = await this.acquire(lockKey, config);

    if (!lockResult.acquired) {
      throw new Error(`Failed to acquire lock: ${lockKey}`);
    }

    try {
      logger.debug('Executing function with lock protection', {
        lockKey,
        token: lockResult.token
      });

      return await fn();
    } finally {
      // Always release lock, even if function throws
      if (lockResult.token) {
        await this.release(lockKey, lockResult.token);
      }
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private getLockKey(lockKey: string): string {
    return `${this.keyPrefix}:${lockKey}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
