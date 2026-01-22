/**
 * Parallel Executor - Production-grade parallel task execution with resource management
 */

import { EventEmitter } from 'events';
import { logger } from './logger';
import { performance } from 'perf_hooks';

export interface ParallelTask<T> {
  id: string;
  execute: () => Promise<T>;
  timeout?: number;
  priority?: number;
}

export interface ExecutionResult<T> {
  id: string;
  success: boolean;
  result?: T;
  error?: Error;
  duration: number;
  attempts: number;
}

export interface ParallelExecutorOptions {
  maxConcurrency?: number;
  defaultTimeout?: number;
  retryOnFailure?: boolean;
  maxRetries?: number;
  progressiveTimeout?: boolean;
}

export class ParallelExecutor extends EventEmitter {
  private readonly options: Required<ParallelExecutorOptions>;
  private activeCount = 0;
  private readonly queue: ParallelTask<any>[] = [];
  private readonly results = new Map<string, ExecutionResult<any>>();

  constructor(options: ParallelExecutorOptions = {}) {
    super();

    this.options = {
      maxConcurrency: options.maxConcurrency ?? 5,
      defaultTimeout: options.defaultTimeout ?? 30000,
      retryOnFailure: options.retryOnFailure ?? true,
      maxRetries: options.maxRetries ?? 2,
      progressiveTimeout: options.progressiveTimeout ?? true
    };
  }

  /**
   * Execute tasks in parallel with resource management
   */
  async executeAll<T>(tasks: ParallelTask<T>[]): Promise<Map<string, ExecutionResult<T>>> {
    // Clear previous results
    this.results.clear();
    this.queue.length = 0;
    this.activeCount = 0;

    // Sort tasks by priority (higher priority first)
    const sortedTasks = [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    // Add to queue
    this.queue.push(...sortedTasks);

    // Start execution
    const promises: Promise<void>[] = [];
    const startTime = performance.now();

    // Launch initial batch
    while (this.activeCount < this.options.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        promises.push(this.executeTask(task));
      }
    }

    // Process queue as tasks complete
    await Promise.all(promises);

    // Wait for all active tasks to complete
    while (this.activeCount > 0) {
      await this.sleep(100);
    }

    const totalDuration = performance.now() - startTime;

    // Log execution summary
    const successful = Array.from(this.results.values()).filter(r => r.success).length;
    const failed = this.results.size - successful;

    logger.info(`Parallel execution completed`, {
      totalTasks: tasks.length,
      successful,
      failed,
      duration: `${totalDuration.toFixed(2)}ms`,
      avgDuration: `${(totalDuration / tasks.length).toFixed(2)}ms`
    });

    return new Map(this.results) as Map<string, ExecutionResult<T>>;
  }

  /**
   * Execute a single task with retry logic
   */
  private async executeTask<T>(task: ParallelTask<T>): Promise<void> {
    this.activeCount++;
    const startTime = performance.now();
    let attempts = 0;
    let lastError: Error | undefined;

    try {
      while (attempts <= this.options.maxRetries) {
        attempts++;

        try {
          // Calculate timeout with progressive increase
          const timeout = this.calculateTimeout(task, attempts);

          // Execute with timeout
          const result = await this.executeWithTimeout(task.execute(), timeout);

          // Store successful result
          this.results.set(task.id, {
            id: task.id,
            success: true,
            result,
            duration: performance.now() - startTime,
            attempts
          });

          this.emit('task-success', task.id);
          return;

        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          if (attempts <= this.options.maxRetries && this.options.retryOnFailure) {
            logger.debug(`Retrying task ${task.id} (attempt ${attempts + 1})`, {
              error: lastError.message
            });

            // Add exponential backoff between retries
            await this.sleep(Math.min(1000 * Math.pow(2, attempts - 1), 5000));
          }
        }
      }

      // All attempts failed
      this.results.set(task.id, {
        id: task.id,
        success: false,
        error: lastError,
        duration: performance.now() - startTime,
        attempts
      });

      this.emit('task-failure', task.id, lastError);

    } finally {
      this.activeCount--;

      // Process next task from queue
      if (this.queue.length > 0) {
        const nextTask = this.queue.shift();
        if (nextTask) {
          this.executeTask(nextTask).catch(error => {
            logger.error(`Failed to execute queued task ${nextTask.id}`, { error });
          });
        }
      }
    }
  }

  /**
   * Calculate timeout with progressive increase
   */
  private calculateTimeout(task: ParallelTask<any>, attempt: number): number {
    const baseTimeout = task.timeout || this.options.defaultTimeout;

    if (!this.options.progressiveTimeout) {
      return baseTimeout;
    }

    // Increase timeout by 50% for each retry
    return Math.min(baseTimeout * Math.pow(1.5, attempt - 1), baseTimeout * 3);
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`Task timeout after ${timeout}ms`)), timeout);
      })
    ]);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute tasks in batches
   */
  async executeBatches<T>(
    tasks: ParallelTask<T>[],
    batchSize: number
  ): Promise<Map<string, ExecutionResult<T>>> {
    const allResults = new Map<string, ExecutionResult<T>>();

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      const batchResults = await this.executeAll(batch);

      // Merge results
      for (const [id, result] of batchResults) {
        allResults.set(id, result);
      }

      // Add delay between batches to prevent overload
      if (i + batchSize < tasks.length) {
        await this.sleep(500);
      }
    }

    return allResults;
  }

  /**
   * Get execution metrics
   */
  getMetrics() {
    const results = Array.from(this.results.values());
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    return {
      total: results.length,
      successful: successful.length,
      failed: failed.length,
      averageDuration: results.length > 0
        ? results.reduce((sum, r) => sum + r.duration, 0) / results.length
        : 0,
      averageAttempts: results.length > 0
        ? results.reduce((sum, r) => sum + r.attempts, 0) / results.length
        : 0,
      activeCount: this.activeCount,
      queueLength: this.queue.length
    };
  }
}

// Singleton for shared execution
export const parallelExecutor = new ParallelExecutor({
  maxConcurrency: 3,
  defaultTimeout: 30000,
  retryOnFailure: true,
  maxRetries: 1,
  progressiveTimeout: true
});