/**
 * Idempotency Middleware - Prevents Duplicate Request Processing
 *
 * **Purpose**: Ensures write operations (POST, PUT, PATCH) are processed
 * exactly once, even if the client retries due to network failures or timeouts.
 *
 * **Root Cause Addressed**: Clients retrying requests after network failures
 * or timeouts can cause duplicate writes, violating data integrity.
 *
 * **Design Pattern**: Idempotency Key + Response Caching
 * - Client provides Idempotency-Key header (or auto-generated)
 * - First request: Process normally and cache response in Redis
 * - Duplicate requests: Return cached response immediately
 * - TTL: 24 hours (configurable)
 *
 * **HTTP Semantics**:
 * - GET, DELETE: Naturally idempotent (not protected)
 * - POST, PUT, PATCH: Protected by idempotency middleware
 *
 * @module IdempotencyMiddleware
 */

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { createLogger } from '@adverant/logger';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('IdempotencyMiddleware');

export interface IdempotencyOptions {
  redis: Redis;
  keyPrefix?: string;
  ttl?: number; // seconds
  methods?: string[];
  autoGenerate?: boolean; // Auto-generate key if not provided
}

export interface CachedResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: any;
  timestamp: Date;
}

export class IdempotencyMiddleware {
  private redis: Redis;
  private keyPrefix: string;
  private ttl: number;
  private methods: Set<string>;
  private autoGenerate: boolean;

  constructor(options: IdempotencyOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix || 'idempotency';
    this.ttl = options.ttl || 86400; // 24 hours default
    this.methods = new Set(options.methods || ['POST', 'PUT', 'PATCH']);
    this.autoGenerate = options.autoGenerate ?? false;

    logger.info('IdempotencyMiddleware initialized', {
      keyPrefix: this.keyPrefix,
      ttl: this.ttl,
      methods: Array.from(this.methods),
      autoGenerate: this.autoGenerate
    });
  }

  /**
   * Express middleware function
   */
  middleware() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // Only apply to specified methods (POST, PUT, PATCH by default)
      if (!this.methods.has(req.method)) {
        return next();
      }

      // Get or generate idempotency key
      let idempotencyKey = req.headers['idempotency-key'] as string;

      if (!idempotencyKey) {
        if (this.autoGenerate) {
          // Auto-generate for safety (prevents duplicates even if client doesn't provide key)
          idempotencyKey = uuidv4();
          logger.debug('Auto-generated idempotency key', {
            key: idempotencyKey,
            method: req.method,
            path: req.path
          });
        } else {
          // No key provided and auto-generation disabled - allow request through
          logger.warn('No idempotency key provided and auto-generation disabled', {
            method: req.method,
            path: req.path
          });
          return next();
        }
      }

      const redisKey = `${this.keyPrefix}:${idempotencyKey}`;

      try {
        // Check if request was already processed
        const cached = await this.redis.get(redisKey);

        if (cached) {
          const cachedResponse: CachedResponse = JSON.parse(cached);

          logger.info('Returning cached response for duplicate request', {
            idempotencyKey,
            method: req.method,
            path: req.path,
            statusCode: cachedResponse.statusCode,
            cachedAt: cachedResponse.timestamp
          });

          // Increment duplicate request counter
          await this.redis.incr(`${this.keyPrefix}:stats:duplicates`).catch(() => {});

          // Return cached response
          res.status(cachedResponse.statusCode);

          // Set cached response headers
          if (cachedResponse.headers) {
            Object.entries(cachedResponse.headers).forEach(([key, value]) => {
              res.set(key, value);
            });
          }

          // Add header to indicate this is a cached response
          res.set('X-Idempotency-Cached', 'true');
          res.set('X-Idempotency-Key', idempotencyKey);

          return res.json(cachedResponse.body);
        }

        // Request not cached - process normally and cache response
        logger.debug('Processing new idempotent request', {
          idempotencyKey,
          method: req.method,
          path: req.path
        });

        // Store original res.json and res.status to intercept response
        const originalJson = res.json.bind(res);
        const originalStatus = res.status.bind(res);
        let statusCode = 200;

        // Override res.status to capture status code
        res.status = function (code: number) {
          statusCode = code;
          return originalStatus(code);
        };

        // Override res.json to cache response
        res.json = function (body: any) {
          const response: CachedResponse = {
            statusCode: statusCode || res.statusCode,
            headers: {},
            body,
            timestamp: new Date()
          };

          // Cache successful responses (2xx) and client errors (4xx)
          // Don't cache server errors (5xx) as they might be transient
          if (response.statusCode < 500) {
            // Don't await - cache in background
            IdempotencyMiddleware.cacheResponse(
              this.redis,
              redisKey,
              response,
              this.ttl,
              logger
            ).catch(error => {
              logger.error('Failed to cache idempotent response', {
                error: error.message,
                idempotencyKey,
                statusCode: response.statusCode
              });
            });

            // Set header to indicate this response is now cached
            res.set('X-Idempotency-Cached', 'false');
            res.set('X-Idempotency-Key', idempotencyKey);
          } else {
            logger.warn('Not caching 5xx response for idempotency', {
              idempotencyKey,
              statusCode: response.statusCode
            });
          }

          return originalJson(body);
        }.bind(this);

        // Add idempotency key to request for access in handlers
        (req as any).idempotencyKey = idempotencyKey;

        next();
      } catch (error: any) {
        logger.error('Idempotency middleware error', {
          error: error.message,
          stack: error.stack,
          idempotencyKey,
          method: req.method,
          path: req.path
        });

        // On Redis error, allow request through (fail-open)
        // Better to risk duplicate than to block all requests
        next();
      }
    };
  }

  /**
   * Cache response in Redis with TTL
   */
  private static async cacheResponse(
    redis: Redis,
    key: string,
    response: CachedResponse,
    ttl: number,
    logger: any
  ): Promise<void> {
    try {
      await redis.setex(key, ttl, JSON.stringify(response));
      logger.debug('Cached idempotent response', {
        key,
        ttl,
        statusCode: response.statusCode,
        timestamp: response.timestamp
      });
    } catch (error: any) {
      logger.error('Failed to cache response', {
        error: error.message,
        key
      });
      throw error;
    }
  }

  /**
   * Manually invalidate cached response
   */
  async invalidate(idempotencyKey: string): Promise<boolean> {
    const redisKey = `${this.keyPrefix}:${idempotencyKey}`;
    try {
      const result = await this.redis.del(redisKey);
      logger.info('Invalidated idempotency key', {
        idempotencyKey,
        existed: result === 1
      });
      return result === 1;
    } catch (error: any) {
      logger.error('Failed to invalidate idempotency key', {
        error: error.message,
        idempotencyKey
      });
      return false;
    }
  }

  /**
   * Get idempotency statistics
   */
  async getStats(): Promise<{
    duplicates: number;
    cached: number;
  }> {
    try {
      const [duplicates, cached] = await Promise.all([
        this.redis.get(`${this.keyPrefix}:stats:duplicates`),
        this.redis.dbsize() // Approximate
      ]);

      return {
        duplicates: parseInt(duplicates || '0', 10),
        cached
      };
    } catch (error: any) {
      logger.error('Failed to get idempotency stats', {
        error: error.message
      });
      return {
        duplicates: 0,
        cached: 0
      };
    }
  }
}

/**
 * Export factory function for creating idempotency middleware
 */
export function createIdempotencyMiddleware(options: IdempotencyOptions) {
  const middleware = new IdempotencyMiddleware(options);
  return middleware.middleware();
}
