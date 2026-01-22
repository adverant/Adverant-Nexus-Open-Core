/**
 * Global Retry Budget Manager
 *
 * Prevents infinite retry loops by enforcing hard limits:
 * - MAX 10 retries per task
 * - MAX 5 minutes total retry duration
 *
 * Sends tasks to Dead Letter Queue when budget is exhausted.
 *
 * @module retry-budget-manager
 * @version 1.0.0
 */

import { logger } from '../utils/logger';
import { DeadLetterQueue } from './dead-letter-queue';

// ============================================================================
// Type Definitions
// ============================================================================

export interface RetryBudget {
  taskId: string;
  attempts: number;
  startTime: number;
  patterns: Set<string>;
  errors: Array<{
    message: string;
    timestamp: number;
    patternId?: string;
  }>;
  lastAttemptTime: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  attemptsRemaining?: number;
  timeRemaining?: number;
}

export interface BudgetStats {
  totalBudgets: number;
  exhaustedBudgets: number;
  avgAttempts: number;
  avgDuration: number;
}

// ============================================================================
// Retry Budget Manager
// ============================================================================

export class RetryBudgetManager {
  private budgets = new Map<string, RetryBudget>();
  private readonly MAX_RETRIES: number;
  private readonly MAX_DURATION_MS: number;
  private exhaustedCount = 0;
  private totalChecks = 0;

  constructor(
    private deadLetterQueue: DeadLetterQueue,
    options?: {
      maxRetries?: number;
      maxDurationMs?: number;
    }
  ) {
    this.MAX_RETRIES = options?.maxRetries || 10;
    this.MAX_DURATION_MS = options?.maxDurationMs || 300000; // 5 minutes

    logger.info('RetryBudgetManager initialized', {
      maxRetries: this.MAX_RETRIES,
      maxDurationMs: this.MAX_DURATION_MS,
      component: 'retry-budget-manager'
    });
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Check if task has remaining retry budget.
   *
   * Creates budget if not exists. Updates budget on each check.
   * Returns false and sends to DLQ if budget exceeded.
   *
   * Performance: < 5ms
   */
  async checkBudget(
    taskId: string,
    error: Error,
    patternId?: string
  ): Promise<BudgetCheckResult> {
    this.totalChecks++;

    let budget = this.budgets.get(taskId);

    if (!budget) {
      // Create new budget
      budget = {
        taskId,
        attempts: 0,
        startTime: Date.now(),
        patterns: new Set(),
        errors: [],
        lastAttemptTime: Date.now()
      };
      this.budgets.set(taskId, budget);

      logger.debug('Created new retry budget', {
        taskId,
        maxRetries: this.MAX_RETRIES,
        maxDurationMs: this.MAX_DURATION_MS,
        component: 'retry-budget-manager'
      });
    }

    // Check retry count limit
    if (budget.attempts >= this.MAX_RETRIES) {
      logger.error('Global retry limit exceeded', {
        taskId,
        attempts: budget.attempts,
        maxRetries: this.MAX_RETRIES,
        patterns: Array.from(budget.patterns),
        duration: Date.now() - budget.startTime,
        component: 'retry-budget-manager'
      });

      await this.exhaustBudget(budget, 'retry_limit_exceeded');

      return {
        allowed: false,
        reason: `Retry limit exceeded: ${budget.attempts}/${this.MAX_RETRIES} attempts`,
        attemptsRemaining: 0,
        timeRemaining: 0
      };
    }

    // Check duration limit
    const elapsed = Date.now() - budget.startTime;
    if (elapsed > this.MAX_DURATION_MS) {
      logger.error('Global retry duration exceeded', {
        taskId,
        elapsed,
        maxDuration: this.MAX_DURATION_MS,
        attempts: budget.attempts,
        patterns: Array.from(budget.patterns),
        component: 'retry-budget-manager'
      });

      await this.exhaustBudget(budget, 'retry_duration_exceeded');

      return {
        allowed: false,
        reason: `Retry duration exceeded: ${(elapsed / 1000).toFixed(1)}s / ${(this.MAX_DURATION_MS / 1000).toFixed(1)}s`,
        attemptsRemaining: 0,
        timeRemaining: 0
      };
    }

    // Budget available - update and allow
    budget.attempts++;
    budget.lastAttemptTime = Date.now();
    budget.errors.push({
      message: error.message,
      timestamp: Date.now(),
      patternId
    });

    if (patternId) {
      budget.patterns.add(patternId);
    }

    const attemptsRemaining = this.MAX_RETRIES - budget.attempts;
    const timeRemaining = this.MAX_DURATION_MS - elapsed;

    logger.debug('Retry budget check passed', {
      taskId,
      attempts: budget.attempts,
      attemptsRemaining,
      timeRemainingMs: timeRemaining,
      patterns: Array.from(budget.patterns),
      component: 'retry-budget-manager'
    });

    return {
      allowed: true,
      attemptsRemaining,
      timeRemaining
    };
  }

  /**
   * Release budget for completed task.
   *
   * Removes budget from tracking to free memory.
   */
  releaseBudget(taskId: string): void {
    const budget = this.budgets.get(taskId);

    if (budget) {
      logger.debug('Released retry budget', {
        taskId,
        attempts: budget.attempts,
        duration: Date.now() - budget.startTime,
        patterns: Array.from(budget.patterns),
        component: 'retry-budget-manager'
      });

      this.budgets.delete(taskId);
    }
  }

  /**
   * Get current budget stats for task.
   *
   * Returns null if no budget exists.
   */
  getBudgetStats(taskId: string): RetryBudget | null {
    const budget = this.budgets.get(taskId);

    if (!budget) {
      return null;
    }

    // Return deep copy to prevent modification
    return {
      taskId: budget.taskId,
      attempts: budget.attempts,
      startTime: budget.startTime,
      patterns: new Set(budget.patterns),
      errors: [...budget.errors],
      lastAttemptTime: budget.lastAttemptTime
    };
  }

  /**
   * Get aggregate statistics for monitoring.
   */
  getAggregateStats(): BudgetStats {
    const budgets = Array.from(this.budgets.values());

    const totalBudgets = budgets.length;
    const avgAttempts = totalBudgets > 0
      ? budgets.reduce((sum, b) => sum + b.attempts, 0) / totalBudgets
      : 0;
    const avgDuration = totalBudgets > 0
      ? budgets.reduce((sum, b) => sum + (Date.now() - b.startTime), 0) / totalBudgets
      : 0;

    return {
      totalBudgets,
      exhaustedBudgets: this.exhaustedCount,
      avgAttempts,
      avgDuration
    };
  }

  /**
   * Force exhaust budget for task (manual intervention).
   *
   * Useful for testing or admin operations.
   */
  async forceExhaustBudget(taskId: string, reason: string): Promise<void> {
    const budget = this.budgets.get(taskId);

    if (!budget) {
      logger.warn('Cannot force exhaust budget - task not found', {
        taskId,
        reason,
        component: 'retry-budget-manager'
      });
      return;
    }

    logger.warn('Force exhausting retry budget', {
      taskId,
      reason,
      attempts: budget.attempts,
      duration: Date.now() - budget.startTime,
      component: 'retry-budget-manager'
    });

    await this.exhaustBudget(budget, reason);
  }

  /**
   * Clear all budgets (use with caution - for testing/maintenance only).
   */
  clearAllBudgets(): void {
    const count = this.budgets.size;
    this.budgets.clear();
    this.exhaustedCount = 0;
    this.totalChecks = 0;

    logger.warn('Cleared all retry budgets', {
      clearedCount: count,
      component: 'retry-budget-manager'
    });
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Exhaust budget and send to Dead Letter Queue.
   *
   * Increments exhausted count and removes budget from tracking.
   */
  private async exhaustBudget(budget: RetryBudget, reason: string): Promise<void> {
    try {
      this.exhaustedCount++;

      // Send to Dead Letter Queue
      await this.deadLetterQueue.add({
        taskId: budget.taskId,
        reason,
        attempts: budget.attempts,
        duration: Date.now() - budget.startTime,
        errors: budget.errors.map(e => e.message),
        patterns: Array.from(budget.patterns),
        timestamp: new Date(),
        firstAttemptTime: new Date(budget.startTime),
        lastAttemptTime: new Date(budget.lastAttemptTime)
      });

      // Remove from active budgets
      this.budgets.delete(budget.taskId);

      logger.info('Task sent to Dead Letter Queue', {
        taskId: budget.taskId,
        reason,
        attempts: budget.attempts,
        duration: Date.now() - budget.startTime,
        patterns: Array.from(budget.patterns),
        errorCount: budget.errors.length,
        component: 'retry-budget-manager'
      });

      // Emit metric for monitoring
      this.emitExhaustionMetric(budget, reason);

    } catch (error) {
      logger.error('Failed to exhaust budget', {
        taskId: budget.taskId,
        error: error instanceof Error ? error.message : String(error),
        component: 'retry-budget-manager'
      });

      // Still remove from active budgets to prevent memory leak
      this.budgets.delete(budget.taskId);
    }
  }

  /**
   * Emit exhaustion metric for monitoring.
   */
  private emitExhaustionMetric(budget: RetryBudget, reason: string): void {
    // TODO: Integrate with metrics system (Prometheus, CloudWatch, etc.)
    logger.info('METRIC: retry_budget_exhausted', {
      taskId: budget.taskId,
      reason,
      attempts: budget.attempts,
      duration: Date.now() - budget.startTime,
      patterns: Array.from(budget.patterns),
      errorCount: budget.errors.length,
      totalExhausted: this.exhaustedCount,
      totalChecks: this.totalChecks,
      exhaustionRate: this.exhaustedCount / this.totalChecks,
      component: 'retry-budget-manager'
    });
  }
}
