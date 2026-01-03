/**
 * Retry Pattern
 * Automatically retry failed operations with exponential backoff
 */

import { RetryOptions, RetryResult } from '../types';

export class Retry {
  private maxRetries: number;
  private initialDelay: number;
  private maxDelay: number;
  private backoffMultiplier: number;
  private backoffStrategy: 'exponential' | 'linear' | 'constant';
  private jitter: boolean;
  private shouldRetry: (error: any, attempt: number) => boolean;
  private onRetry?: (error: any, attempt: number, delay: number) => void;

  constructor(options: RetryOptions = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.initialDelay = options.initialDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffMultiplier = options.backoffMultiplier || 2;
    this.backoffStrategy = options.backoffStrategy || 'exponential';
    this.jitter = options.jitter ?? true;
    this.shouldRetry = options.shouldRetry || this.defaultShouldRetry;
    this.onRetry = options.onRetry;
  }

  /**
   * Execute function with retry logic
   */
  async execute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    let lastError: any;
    let attempt = 0;
    let totalDelay = 0;

    while (attempt <= this.maxRetries) {
      try {
        const result = await fn();
        return { result, attempts: attempt + 1, totalDelay };
      } catch (error) {
        lastError = error;
        attempt++;

        // Check if we should retry
        if (attempt > this.maxRetries || !this.shouldRetry(error, attempt)) {
          throw error;
        }

        // Calculate delay
        const delay = this.calculateDelay(attempt);
        totalDelay += delay;

        // Callback before retry
        this.onRetry?.(error, attempt, delay);

        // Wait before retry
        await this.sleep(delay);
      }
    }

    // Max retries exceeded
    throw lastError;
  }

  /**
   * Calculate delay based on attempt number and strategy
   */
  private calculateDelay(attempt: number): number {
    let delay: number;

    switch (this.backoffStrategy) {
      case 'exponential':
        delay = this.initialDelay * Math.pow(this.backoffMultiplier, attempt - 1);
        break;

      case 'linear':
        delay = this.initialDelay * attempt;
        break;

      case 'constant':
        delay = this.initialDelay;
        break;

      default:
        delay = this.initialDelay;
    }

    // Cap at max delay
    delay = Math.min(delay, this.maxDelay);

    // Add jitter if enabled
    if (this.jitter) {
      delay = this.addJitter(delay);
    }

    return delay;
  }

  /**
   * Add jitter to delay to prevent thundering herd
   */
  private addJitter(delay: number): number {
    // Random jitter between 0-25% of delay
    const jitterAmount = delay * 0.25 * Math.random();
    return delay + jitterAmount;
  }

  /**
   * Default retry logic - retry on network/timeout errors
   */
  private defaultShouldRetry(error: any, attempt: number): boolean {
    // Don't retry on client errors (4xx)
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return false;
    }

    // Retry on network errors, timeouts, server errors (5xx)
    return (
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNREFUSED' ||
      error.message?.includes('timeout') ||
      error.statusCode >= 500
    );
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create retry helper
 */
export function createRetry(options?: RetryOptions): Retry {
  return new Retry(options);
}

/**
 * Retry function with default options
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<RetryResult<T>> {
  const retryHelper = new Retry(options);
  return retryHelper.execute(fn);
}
