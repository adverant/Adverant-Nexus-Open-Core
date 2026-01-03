/**
 * Resilience Manager - Production-grade resilience patterns implementation
 * Implements: Circuit Breaker, Retry with Exponential Backoff, Request Deduplication, Caching
 */

import { EventEmitter } from 'events';
import { logger } from './logger';
import crypto from 'crypto';

// Types
export interface ResilienceOptions {
  maxRetries?: number;
  initialRetryDelay?: number;
  maxRetryDelay?: number;
  backoffMultiplier?: number;
  cacheTTL?: number;
  deduplicationWindow?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface PendingRequest<T> {
  promise: Promise<T>;
  timestamp: number;
}

enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open'
}

export class ResilienceManager extends EventEmitter {
  private readonly cache = new Map<string, CacheEntry<any>>();
  private readonly pendingRequests = new Map<string, PendingRequest<any>>();
  private readonly circuitState = new Map<string, CircuitState>();
  private readonly circuitFailures = new Map<string, number>();
  private readonly circuitLastFailure = new Map<string, number>();

  private readonly options: Required<ResilienceOptions>;
  private cleanupInterval: NodeJS.Timeout;

  constructor(options: ResilienceOptions = {}) {
    super();

    this.options = {
      maxRetries: options.maxRetries ?? 3,
      initialRetryDelay: options.initialRetryDelay ?? 1000,
      maxRetryDelay: options.maxRetryDelay ?? 30000,
      backoffMultiplier: options.backoffMultiplier ?? 2,
      cacheTTL: options.cacheTTL ?? 60000, // 1 minute
      deduplicationWindow: options.deduplicationWindow ?? 5000, // 5 seconds
      circuitBreakerThreshold: options.circuitBreakerThreshold ?? 5,
      circuitBreakerTimeout: options.circuitBreakerTimeout ?? 60000 // 1 minute
    };

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
  }

  /**
   * Execute a function with full resilience patterns
   */
  async execute<T>(
    key: string,
    fn: () => Promise<T>,
    options: Partial<ResilienceOptions> = {}
  ): Promise<T> {
    const opts = { ...this.options, ...options };

    // Check circuit breaker
    if (this.isCircuitOpen(key)) {
      throw new Error(`Circuit breaker is open for ${key}`);
    }

    // Check cache
    const cached = this.getFromCache<T>(key);
    if (cached !== null) {
      this.emit('cache-hit', key);
      return cached;
    }

    // Check for pending duplicate request
    const pending = this.getPendingRequest<T>(key);
    if (pending) {
      this.emit('deduplicated', key);
      return pending;
    }

    // Execute with retry logic
    const requestPromise = this.executeWithRetry(key, fn, opts);

    // Store as pending for deduplication
    this.pendingRequests.set(key, {
      promise: requestPromise,
      timestamp: Date.now()
    });

    try {
      const result = await requestPromise;

      // Cache successful result
      this.cacheResult(key, result, opts.cacheTTL);

      // Reset circuit breaker on success
      this.circuitSuccess(key);

      return result;
    } catch (error) {
      // Record circuit breaker failure
      this.circuitFailure(key);

      throw error;
    } finally {
      // Remove from pending
      this.pendingRequests.delete(key);
    }
  }

  /**
   * Execute with exponential backoff retry
   */
  private async executeWithRetry<T>(
    key: string,
    fn: () => Promise<T>,
    options: Required<ResilienceOptions>
  ): Promise<T> {
    let lastError: Error | undefined;
    let delay = options.initialRetryDelay;

    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        // Add jitter to prevent thundering herd
        const jitter = Math.random() * 200;
        if (attempt > 0) {
          await this.sleep(delay + jitter);
        }

        const result = await fn();

        if (attempt > 0) {
          logger.info(`Retry succeeded for ${key} on attempt ${attempt + 1}`);
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on non-retryable errors
        if (this.isNonRetryableError(lastError)) {
          throw lastError;
        }

        if (attempt < options.maxRetries) {
          logger.warn(`Retry attempt ${attempt + 1}/${options.maxRetries} for ${key}`, {
            error: lastError.message
          });

          // Calculate next delay with exponential backoff
          delay = Math.min(delay * options.backoffMultiplier, options.maxRetryDelay);
        }
      }
    }

    throw lastError || new Error(`All retry attempts failed for ${key}`);
  }

  /**
   * Check if error is non-retryable
   */
  private isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('invalid') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('not found') ||
      message.includes('bad request')
    );
  }

  /**
   * Circuit breaker checks
   */
  private isCircuitOpen(key: string): boolean {
    const state = this.circuitState.get(key) || CircuitState.CLOSED;

    if (state === CircuitState.OPEN) {
      const lastFailure = this.circuitLastFailure.get(key) || 0;
      const timeSinceFailure = Date.now() - lastFailure;

      if (timeSinceFailure > this.options.circuitBreakerTimeout) {
        // Try half-open state
        this.circuitState.set(key, CircuitState.HALF_OPEN);
        logger.info(`Circuit breaker for ${key} entering HALF_OPEN state`);
        return false;
      }

      return true;
    }

    return false;
  }

  private circuitSuccess(key: string): void {
    const state = this.circuitState.get(key);

    if (state === CircuitState.HALF_OPEN) {
      this.circuitState.set(key, CircuitState.CLOSED);
      this.circuitFailures.set(key, 0);
      logger.info(`Circuit breaker for ${key} is now CLOSED`);
    }

    this.circuitFailures.set(key, 0);
  }

  private circuitFailure(key: string): void {
    const failures = (this.circuitFailures.get(key) || 0) + 1;
    this.circuitFailures.set(key, failures);
    this.circuitLastFailure.set(key, Date.now());

    if (failures >= this.options.circuitBreakerThreshold) {
      const currentState = this.circuitState.get(key);

      if (currentState !== CircuitState.OPEN) {
        this.circuitState.set(key, CircuitState.OPEN);
        logger.error(`Circuit breaker for ${key} is now OPEN after ${failures} failures`);
        this.emit('circuit-open', key);
      }
    }
  }

  /**
   * Cache management
   */
  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  private cacheResult<T>(key: string, data: T, ttl: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  /**
   * Request deduplication
   */
  private getPendingRequest<T>(key: string): Promise<T> | null {
    const pending = this.pendingRequests.get(key);

    if (!pending) return null;

    const age = Date.now() - pending.timestamp;
    if (age > this.options.deduplicationWindow) {
      this.pendingRequests.delete(key);
      return null;
    }

    return pending.promise as Promise<T>;
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();

    // Clean cache
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }

    // Clean pending requests
    for (const [key, pending] of this.pendingRequests.entries()) {
      if (now - pending.timestamp > this.options.deduplicationWindow * 2) {
        this.pendingRequests.delete(key);
      }
    }

    // Force garbage collection if available
    if (global.gc && Math.random() < 0.1) {
      global.gc();
    }
  }

  /**
   * Generate cache key from request parameters
   */
  static generateKey(prefix: string, params: any): string {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(params))
      .digest('hex')
      .substring(0, 16);

    return `${prefix}:${hash}`;
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      cacheSize: this.cache.size,
      pendingRequests: this.pendingRequests.size,
      circuitStates: Array.from(this.circuitState.entries()).map(([key, state]) => ({
        key,
        state,
        failures: this.circuitFailures.get(key) || 0
      }))
    };
  }

  /**
   * Utility sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cache.clear();
    this.pendingRequests.clear();
    this.circuitState.clear();
    this.circuitFailures.clear();
    this.circuitLastFailure.clear();

    this.removeAllListeners();
  }
}

// Singleton instance
export const resilienceManager = new ResilienceManager();