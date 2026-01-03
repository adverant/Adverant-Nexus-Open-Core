/**
 * Redis Manager
 * Handles Redis connection, pub/sub, and operations
 */

import Redis, { RedisOptions } from 'ioredis';
import { createLogger } from '@adverant/logger';
import { createRetry } from '@adverant/resilience';
import type { RedisConfig, HealthCheckResult } from '../types';

const logger = createLogger({ service: 'adverant-database' });

export class RedisManager {
  private client: Redis | null = null;
  private config: RedisConfig;
  private retry = createRetry({
    maxRetries: 3,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
  });

  constructor(config: RedisConfig) {
    this.config = config;
  }

  /**
   * Initialize Redis connection
   */
  async initialize(): Promise<void> {
    try {
      const options: RedisOptions = {
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        db: this.config.db || 0,
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 1000, 5000);
          logger.debug('Redis retry attempt', { attempt: times, delay });
          return delay;
        },
        maxRetriesPerRequest: this.config.maxRetriesPerRequest || 3,
        enableReadyCheck: true,
        lazyConnect: false,
      };

      if (this.config.tls) {
        options.tls = this.config.tls === true ? {} : this.config.tls;
      }

      if (this.config.keyPrefix) {
        options.keyPrefix = this.config.keyPrefix;
      }

      this.client = new Redis(options);

      // Set up event listeners
      this.client.on('error', (err) => {
        logger.error('Redis error', { error: err.message });
      });

      this.client.on('connect', () => {
        logger.debug('Redis connecting');
      });

      this.client.on('ready', () => {
        logger.info('Redis connected successfully', {
          host: this.config.host,
          port: this.config.port,
          db: this.config.db || 0,
        });
      });

      this.client.on('close', () => {
        logger.debug('Redis connection closed');
      });

      this.client.on('reconnecting', () => {
        logger.debug('Redis reconnecting');
      });

      // Test connection
      await this.retry.execute(async () => {
        if (!this.client) throw new Error('Redis client not initialized');
        await this.client.ping();
      });
    } catch (error) {
      logger.error('Redis initialization failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        host: this.config.host,
      });
      throw error;
    }
  }

  /**
   * Get the Redis client instance
   */
  getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client;
  }

  /**
   * Execute a Redis command
   */
  async execute<T = any>(command: string, ...args: any[]): Promise<T> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    try {
      const result = await this.client.call(command, ...args);
      return result as T;
    } catch (error) {
      logger.error('Redis command error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        command,
      });
      throw error;
    }
  }

  /**
   * Get a value from Redis
   */
  async get(key: string): Promise<string | null> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client.get(key);
  }

  /**
   * Set a value in Redis
   */
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * Delete a key from Redis
   */
  async delete(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client.del(key);
  }

  /**
   * Delete keys matching a pattern
   */
  async deletePattern(pattern: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    let cursor = '0';
    let deletedCount = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );

      cursor = nextCursor;

      if (keys.length > 0) {
        const deleted = await this.client.del(...keys);
        deletedCount += deleted;
      }
    } while (cursor !== '0');

    return deletedCount;
  }

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    const result = await this.client.exists(key);
    return result === 1;
  }

  /**
   * Get TTL for a key
   */
  async ttl(key: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client.ttl(key);
  }

  /**
   * Publish a message to a channel
   */
  async publish(channel: string, message: string): Promise<number> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client.publish(channel, message);
  }

  /**
   * Subscribe to a channel
   */
  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    // Create a separate subscriber client
    const subscriber = this.client.duplicate();

    subscriber.on('message', (chan, message) => {
      if (chan === channel) {
        callback(message);
      }
    });

    await subscriber.subscribe(channel);
    logger.debug('Subscribed to Redis channel', { channel });
  }

  /**
   * Increment a value
   */
  async increment(key: string, amount: number = 1): Promise<number> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return amount === 1 ? this.client.incr(key) : this.client.incrby(key, amount);
  }

  /**
   * Decrement a value
   */
  async decrement(key: string, amount: number = 1): Promise<number> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return amount === 1 ? this.client.decr(key) : this.client.decrby(key, amount);
  }

  /**
   * Get multiple keys
   */
  async mget(keys: string[]): Promise<(string | null)[]> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }
    return this.client.mget(...keys);
  }

  /**
   * Set multiple keys
   */
  async mset(keyValues: Record<string, string>): Promise<void> {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    const args: string[] = [];
    for (const [key, value] of Object.entries(keyValues)) {
      args.push(key, value);
    }

    await this.client.mset(...args);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.client) {
      return {
        healthy: false,
        error: 'Client not initialized',
      };
    }

    const startTime = Date.now();

    try {
      await this.client.ping();
      const latency = Date.now() - startTime;

      const info = await this.client.info('stats');
      const connections = this.parseInfoValue(info, 'connected_clients');

      return {
        healthy: true,
        latency,
        details: {
          connections: parseInt(connections || '0', 10),
          db: this.config.db || 0,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Parse a value from Redis INFO command
   */
  private parseInfoValue(info: string, key: string): string | null {
    const match = info.match(new RegExp(`${key}:([^\r\n]+)`));
    return match ? match[1] : null;
  }

  /**
   * Disconnect from Redis
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      logger.info('Redis connection closed');
    }
  }
}
