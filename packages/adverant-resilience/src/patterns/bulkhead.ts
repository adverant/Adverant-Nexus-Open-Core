/**
 * Bulkhead Pattern
 * Limit concurrent executions to prevent resource exhaustion
 */

import { BulkheadOptions } from '../types';

export class BulkheadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkheadError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class Bulkhead {
  private currentConcurrent = 0;
  private queue: Array<{
    fn: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout?: NodeJS.Timeout;
  }> = [];

  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly queueTimeout: number | undefined;
  private readonly onCapacity?: () => void;

  constructor(options: BulkheadOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueue = options.maxQueue || 0;
    this.queueTimeout = options.queueTimeout;
    this.onCapacity = options.onCapacity;
  }

  /**
   * Execute function with bulkhead protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we can execute immediately
    if (this.currentConcurrent < this.maxConcurrent) {
      return this.executeImmediately(fn);
    }

    // Check if we can queue
    if (this.queue.length >= this.maxQueue) {
      this.onCapacity?.();
      throw new BulkheadError(
        `Bulkhead at capacity: ${this.currentConcurrent} concurrent, ${this.queue.length} queued`
      );
    }

    // Queue the execution
    return this.queueExecution(fn);
  }

  /**
   * Execute function immediately
   */
  private async executeImmediately<T>(fn: () => Promise<T>): Promise<T> {
    this.currentConcurrent++;

    try {
      return await fn();
    } finally {
      this.currentConcurrent--;
      this.processQueue();
    }
  }

  /**
   * Queue execution for later
   */
  private queueExecution<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queueItem = { fn, resolve, reject, timeout: undefined as NodeJS.Timeout | undefined };

      // Set timeout if configured
      if (this.queueTimeout) {
        queueItem.timeout = setTimeout(() => {
          // Remove from queue
          const index = this.queue.indexOf(queueItem);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }

          reject(new BulkheadError(`Queued execution timed out after ${this.queueTimeout}ms`));
        }, this.queueTimeout);
      }

      this.queue.push(queueItem);
    });
  }

  /**
   * Process queued executions
   */
  private processQueue(): void {
    if (this.queue.length === 0) return;
    if (this.currentConcurrent >= this.maxConcurrent) return;

    const item = this.queue.shift();
    if (!item) return;

    // Clear timeout if set
    if (item.timeout) {
      clearTimeout(item.timeout);
    }

    // Execute
    this.executeImmediately(item.fn)
      .then(item.resolve)
      .catch(item.reject);
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      currentConcurrent: this.currentConcurrent,
      queueLength: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      utilization: (this.currentConcurrent / this.maxConcurrent) * 100,
    };
  }

  /**
   * Clear queue
   */
  clearQueue(): void {
    for (const item of this.queue) {
      if (item.timeout) {
        clearTimeout(item.timeout);
      }
      item.reject(new BulkheadError('Queue cleared'));
    }
    this.queue = [];
  }
}

/**
 * Create bulkhead
 */
export function createBulkhead(options: BulkheadOptions): Bulkhead {
  return new Bulkhead(options);
}
