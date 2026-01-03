/**
 * Worker Watchdog - External Timeout Protection for Worker Processes
 *
 * **Purpose**: Prevents workers from hanging indefinitely by implementing
 * an external timeout that force-kills stalled tasks.
 *
 * **Root Cause Addressed**: Workers could hang indefinitely if:
 * - Processor timeout fails
 * - Circular awaits in task code
 * - External API calls never return
 * - Database queries hang
 *
 * **Design Pattern**: Timeout Wrapper with Grace Period
 * - Primary timeout: Task-specified timeout
 * - Watchdog timeout: Primary + 30s grace period
 * - Force-kill: Marks task as failed if watchdog triggers
 *
 * @module WorkerWatchdog
 */

import { Logger } from 'winston';
import { TimeoutError, WorkerWatchdogTimeoutError } from '../utils/errors';
import { TaskManager } from './task-manager';

export interface WatchdogMetrics {
  totalMonitored: number;
  totalTimeouts: number;
  totalSuccess: number;
  totalErrors: number;
  averageExecutionTime: number;
  lastTimeout?: Date;
}

export interface WatchdogOptions {
  /**
   * Grace period added to task timeout before watchdog triggers
   * Default: 30000ms (30 seconds)
   */
  gracePeriod?: number;

  /**
   * Enable automatic task failure on watchdog timeout
   * Default: true
   */
  enableForceKill?: boolean;

  /**
   * Enable metrics collection
   * Default: true
   */
  enableMetrics?: boolean;
}

export class WorkerWatchdog {
  private metrics: WatchdogMetrics = {
    totalMonitored: 0,
    totalTimeouts: 0,
    totalSuccess: 0,
    totalErrors: 0,
    averageExecutionTime: 0
  };

  private readonly gracePeriod: number;
  private readonly enableForceKill: boolean;
  private readonly enableMetrics: boolean;

  constructor(
    private readonly logger: Logger,
    private readonly taskManager: TaskManager,
    options: WatchdogOptions = {}
  ) {
    this.gracePeriod = options.gracePeriod ?? 30000; // 30 seconds default
    this.enableForceKill = options.enableForceKill ?? true;
    this.enableMetrics = options.enableMetrics ?? true;

    this.logger.info('WorkerWatchdog initialized', {
      gracePeriod: this.gracePeriod,
      enableForceKill: this.enableForceKill,
      enableMetrics: this.enableMetrics
    });
  }

  /**
   * Monitor a worker operation with external timeout protection
   *
   * @param taskId - Task identifier
   * @param taskType - Type of task being processed
   * @param timeout - Task timeout in milliseconds
   * @param operation - Async operation to monitor
   * @returns Result of the operation
   * @throws WorkerWatchdogTimeoutError if watchdog timeout triggers
   */
  async monitor<T>(
    taskId: string,
    taskType: string,
    timeout: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const watchdogTimeout = timeout + this.gracePeriod;
    const startTime = Date.now();

    this.logger.debug('Watchdog monitoring started', {
      taskId,
      taskType,
      taskTimeout: timeout,
      watchdogTimeout,
      gracePeriod: this.gracePeriod
    });

    if (this.enableMetrics) {
      this.metrics.totalMonitored++;
    }

    // Create timeout promise that rejects after watchdog timeout
    // PHASE 29c FIX: Store timerId outside Promise to avoid temporal dead zone
    let watchdogTimerId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      watchdogTimerId = setTimeout(() => {
        reject(new WorkerWatchdogTimeoutError(
          `Worker watchdog timeout: Task exceeded ${watchdogTimeout}ms (task timeout: ${timeout}ms + grace period: ${this.gracePeriod}ms)`,
          {
            taskId,
            taskType,
            taskTimeout: timeout,
            watchdogTimeout,
            gracePeriod: this.gracePeriod,
            elapsed: Date.now() - startTime
          },
          `Check task processor for infinite loops, hanging API calls, or database query timeouts. ` +
          `Task should have completed within ${timeout}ms but exceeded watchdog limit of ${watchdogTimeout}ms.`
        ));
      }, watchdogTimeout);
    });

    try {
      // Race between operation and watchdog timeout
      const result = await Promise.race([
        operation(),
        timeoutPromise
      ]);

      // Operation completed successfully
      const elapsed = Date.now() - startTime;

      this.logger.debug('Watchdog monitoring completed successfully', {
        taskId,
        taskType,
        elapsed,
        remainingTime: watchdogTimeout - elapsed
      });

      if (this.enableMetrics) {
        this.metrics.totalSuccess++;
        this.updateAverageExecutionTime(elapsed);
      }

      // Clear timeout using external timer ID variable (PHASE 29c FIX)
      clearTimeout(watchdogTimerId!);

      return result;

    } catch (error) {
      const elapsed = Date.now() - startTime;

      // Clear timeout using external timer ID variable (PHASE 29c FIX)
      clearTimeout(watchdogTimerId!);

      // Check if watchdog timeout triggered
      if (error instanceof WorkerWatchdogTimeoutError) {
        this.logger.error('Worker watchdog triggered - force killing task', {
          taskId,
          taskType,
          timeout: watchdogTimeout,
          elapsed,
          errorId: error.errorId
        });

        if (this.enableMetrics) {
          this.metrics.totalTimeouts++;
          this.metrics.lastTimeout = new Date();
        }

        // Force fail the task if enabled
        if (this.enableForceKill) {
          try {
            await this.taskManager.forceFailTask(
              taskId,
              'Worker watchdog timeout - task exceeded maximum execution time'
            );
            this.logger.info('Task force-failed by watchdog', { taskId });
          } catch (failError: any) {
            this.logger.error('Failed to force-fail task after watchdog timeout', {
              taskId,
              error: failError.message
            });
          }
        }

        // Re-throw watchdog error
        throw error;
      }

      // Other error occurred during operation
      this.logger.error('Operation failed during watchdog monitoring', {
        taskId,
        taskType,
        elapsed,
        error: error instanceof Error ? error.message : String(error)
      });

      if (this.enableMetrics) {
        this.metrics.totalErrors++;
      }

      throw error;
    }
  }

  /**
   * Get current watchdog metrics
   */
  getMetrics(): Readonly<WatchdogMetrics> {
    return { ...this.metrics };
  }

  /**
   * Reset metrics counters
   */
  resetMetrics(): void {
    this.metrics = {
      totalMonitored: 0,
      totalTimeouts: 0,
      totalSuccess: 0,
      totalErrors: 0,
      averageExecutionTime: 0
    };
    this.logger.info('Watchdog metrics reset');
  }

  /**
   * Update average execution time using running average
   */
  private updateAverageExecutionTime(newTime: number): void {
    const total = this.metrics.totalSuccess;
    const currentAvg = this.metrics.averageExecutionTime;

    // Running average formula: new_avg = (old_avg * (n-1) + new_value) / n
    this.metrics.averageExecutionTime =
      (currentAvg * (total - 1) + newTime) / total;
  }
}
