/**
 * Orchestrator Retry Integration
 *
 * Extends the Orchestrator class with intelligent retry capabilities.
 * Implements executeWithIntelligentRetry wrapper for all operations.
 *
 * @module retry/orchestrator-integration
 * @version 1.0.0
 */

import { EventEmitter } from 'events';
import { RetryAnalyzer } from './retry-analyzer';
import { RetryOptions, RetryMetrics } from './types';
import { logger } from '../utils/logger';

// ============================================================================
// Retry Execution Engine
// ============================================================================

export class RetryExecutor extends EventEmitter {
  private retryAnalyzer: RetryAnalyzer;
  private activeRetries: Map<string, RetryState>;

  constructor(retryAnalyzer: RetryAnalyzer) {
    super();

    if (!retryAnalyzer) {
      throw new Error(
        'RetryExecutor initialization failed:\n' +
        'RetryAnalyzer is required but was not provided.\n' +
        'Please ensure RetryAnalyzer is instantiated before creating RetryExecutor.'
      );
    }

    this.retryAnalyzer = retryAnalyzer;
    this.activeRetries = new Map();

    logger.info('RetryExecutor initialized', { component: 'retry-executor' });
  }

  /**
   * Execute operation with intelligent retry logic.
   *
   * Core retry engine that:
   * 1. Analyzes errors using ML-based pattern recognition
   * 2. Applies adaptive backoff strategies
   * 3. Emits real-time WebSocket events
   * 4. Records outcomes for continuous learning
   *
   * @param operation - Async operation to execute
   * @param options - Retry configuration options
   * @returns Operation result
   * @throws Last error if all retries exhausted
   */
  async executeWithIntelligentRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions
  ): Promise<T> {
    const taskId = options.taskId || `retry-${Date.now()}`;
    const startTime = Date.now();

    // Initialize retry state
    const state: RetryState = {
      taskId,
      operation: options.operation,
      attempt: 0,
      maxAttempts: options.retryConfig?.maxRetries || 3,
      startTime,
      lastError: null,
      modifications: []
    };

    this.activeRetries.set(taskId, state);

    try {
      return await this.executeWithRetryLoop(operation, options, state);
    } finally {
      this.activeRetries.delete(taskId);
    }
  }

  /**
   * Main retry loop implementation.
   *
   * Implements:
   * - Error analysis and strategy recommendation
   * - Adaptive backoff with jitter
   * - Operation modification based on ML recommendations
   * - Comprehensive event emission for monitoring
   */
  private async executeWithRetryLoop<T>(
    operation: () => Promise<T>,
    options: RetryOptions,
    state: RetryState
  ): Promise<T> {
    while (true) {
      state.attempt++;

      try {
        // Emit attempt event (for attempts after first failure)
        if (state.attempt > 1) {
          this.emitRetryAttemptEvent(state, options);
        }

        // Execute operation with timeout if configured
        const result = await this.executeWithTimeout(
          operation,
          options.retryConfig?.timeout
        );

        // Success! Record for learning if this was a retry
        if (state.attempt > 1) {
          await this.recordSuccessfulRetry(state, options);
          this.emitRetrySuccessEvent(state);
        }

        return result;

      } catch (error) {
        state.lastError = error as Error;

        // Analyze error and get recommendation
        const recommendation = await this.retryAnalyzer.analyzeError(
          state.lastError,
          {
            service: 'mageagent',
            operation: options.operation,
            context: options.context,
            attempt: state.attempt,
            taskId: state.taskId
          }
        );

        // Emit analysis event
        this.emitRetryAnalysisEvent(state, recommendation, state.lastError);

        // Check if should retry
        const shouldRetry = this.shouldRetry(
          recommendation,
          state.attempt,
          state.maxAttempts
        );

        if (!shouldRetry) {
          // Record final failure
          await this.recordFailedRetry(state, options, state.lastError);
          this.emitRetryExhaustedEvent(state, state.lastError);

          // Throw with enhanced error message
          throw this.enhanceError(state.lastError, state, recommendation);
        }

        // Calculate backoff with jitter
        const backoffMs = this.calculateBackoff(
          recommendation.strategy,
          state.attempt
        );

        // Emit backoff event
        this.emitRetryBackoffEvent(state, backoffMs);

        // Wait before retry
        await this.sleep(backoffMs);

        // Apply recommended modifications
        if (recommendation.modifications) {
          this.applyModifications(options, recommendation.modifications);
          state.modifications.push(...recommendation.modifications);
        }

        // Continue to next attempt
      }
    }
  }

  /**
   * Execute operation with timeout.
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    if (!timeoutMs) {
      return await operation();
    }

    return await Promise.race([
      operation(),
      this.createTimeoutPromise(timeoutMs)
    ]) as T;
  }

  /**
   * Create timeout promise.
   */
  private createTimeoutPromise<T>(timeoutMs: number): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(
          `Operation timed out after ${timeoutMs}ms:\n` +
          `The operation exceeded the configured timeout limit.\n` +
          `This may indicate a stalled process or insufficient timeout configuration.\n` +
          `Consider increasing the timeout or investigating the operation's performance.`
        ));
      }, timeoutMs);
    });
  }

  /**
   * Determine if should retry based on recommendation and attempt count.
   */
  private shouldRetry(
    recommendation: any,
    attempt: number,
    maxAttempts: number
  ): boolean {
    // Don't retry if recommendation says not to
    if (!recommendation.shouldRetry) {
      return false;
    }

    // Don't retry if max attempts reached
    if (attempt >= maxAttempts) {
      return false;
    }

    // Check recommendation's max retries
    if (attempt >= recommendation.strategy.maxRetries) {
      return false;
    }

    return true;
  }

  /**
   * Calculate backoff time with jitter.
   *
   * Implements exponential backoff with optional jitter to prevent thundering herd.
   */
  private calculateBackoff(strategy: any, attempt: number): number {
    const baseBackoff = strategy.backoffMs[attempt - 1] ||
                       strategy.backoffMs[strategy.backoffMs.length - 1];

    if (!strategy.exponentialBackoff) {
      return baseBackoff;
    }

    // Add jitter (±20% randomness)
    const jitter = strategy.jitterMs || Math.floor(baseBackoff * 0.2);
    const randomJitter = Math.floor(Math.random() * jitter * 2) - jitter;

    return Math.max(0, baseBackoff + randomJitter);
  }

  /**
   * Apply recommended modifications to operation options.
   */
  private applyModifications(
    options: RetryOptions,
    modifications: any[]
  ): void {
    if (!options.context) {
      options.context = {};
    }

    for (const mod of modifications) {
      if (mod.type === 'parameter_change') {
        Object.assign(options.context, mod.changes);
      }
    }

    logger.debug('Applied retry modifications', {
      operation: options.operation,
      modifications: modifications.length,
      component: 'retry-executor'
    });
  }

  /**
   * Record successful retry for learning.
   */
  private async recordSuccessfulRetry(
    state: RetryState,
    options: RetryOptions
  ): Promise<void> {
    const executionTime = Date.now() - state.startTime;

    try {
      await this.retryAnalyzer.recordAttempt({
        taskId: state.taskId,
        agentId: options.agentId,
        attempt: state.attempt,
        strategyApplied: options.retryConfig!,
        modificationsApplied: state.modifications,
        success: true,
        executionTimeMs: executionTime
      });

      logger.info('Retry succeeded - recorded for learning', {
        taskId: state.taskId,
        attempt: state.attempt,
        executionTime,
        operation: options.operation,
        component: 'retry-executor'
      });

    } catch (error) {
      logger.error('Failed to record successful retry', {
        error: error instanceof Error ? error.message : String(error),
        taskId: state.taskId,
        component: 'retry-executor'
      });
    }
  }

  /**
   * Record failed retry for learning.
   */
  private async recordFailedRetry(
    state: RetryState,
    options: RetryOptions,
    error: Error
  ): Promise<void> {
    const executionTime = Date.now() - state.startTime;

    try {
      await this.retryAnalyzer.recordAttempt({
        taskId: state.taskId,
        agentId: options.agentId,
        attempt: state.attempt,
        strategyApplied: options.retryConfig!,
        modificationsApplied: state.modifications,
        success: false,
        executionTimeMs: executionTime,
        error: error.message
      });

      logger.warn('All retries exhausted - recorded for learning', {
        taskId: state.taskId,
        totalAttempts: state.attempt,
        executionTime,
        operation: options.operation,
        finalError: error.message,
        component: 'retry-executor'
      });

    } catch (recordError) {
      logger.error('Failed to record failed retry', {
        error: recordError instanceof Error ? recordError.message : String(recordError),
        taskId: state.taskId,
        component: 'retry-executor'
      });
    }
  }

  /**
   * Enhance error with retry context.
   */
  private enhanceError(
    error: Error,
    state: RetryState,
    recommendation: any
  ): Error {
    const enhancedMessage =
      `Operation failed after ${state.attempt} attempts:\n\n` +
      `Operation: ${state.operation}\n` +
      `Task ID: ${state.taskId}\n` +
      `Total Duration: ${Date.now() - state.startTime}ms\n` +
      `Error Category: ${recommendation.category}\n` +
      `Error Severity: ${recommendation.severity}\n\n` +
      `Original Error: ${error.message}\n\n` +
      `Retry Strategy Used:\n` +
      `- Max Retries: ${recommendation.strategy.maxRetries}\n` +
      `- Backoff: ${recommendation.strategy.backoffMs.join(', ')}ms\n` +
      `- Confidence: ${(recommendation.confidence * 100).toFixed(1)}%\n\n` +
      `Reasoning: ${recommendation.reasoning}\n\n` +
      (state.modifications.length > 0
        ? `Modifications Applied:\n${state.modifications.map(m => `- ${m.description}`).join('\n')}\n\n`
        : '') +
      `This error has been logged for ML-based pattern recognition and future retry optimization.`;

    const enhancedError = new Error(enhancedMessage);
    enhancedError.name = error.name;
    enhancedError.stack = error.stack;

    return enhancedError;
  }

  /**
   * Sleep utility with promise.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ==========================================================================
  // WebSocket Event Emission
  // ==========================================================================

  private emitRetryAttemptEvent(state: RetryState, options: RetryOptions): void {
    this.emit('retry:attempt', {
      type: 'retry:attempt',
      taskId: state.taskId,
      attempt: state.attempt,
      strategy: options.retryConfig,
      timestamp: new Date().toISOString()
    });
  }

  private emitRetryAnalysisEvent(
    state: RetryState,
    recommendation: any,
    error: Error
  ): void {
    this.emit('retry:analysis', {
      type: 'retry:analysis',
      taskId: state.taskId,
      attempt: state.attempt,
      error: error.message,
      recommendation,
      timestamp: new Date().toISOString()
    });
  }

  private emitRetryBackoffEvent(state: RetryState, backoffMs: number): void {
    this.emit('retry:backoff', {
      type: 'retry:backoff',
      taskId: state.taskId,
      attempt: state.attempt,
      backoffMs,
      nextAttempt: state.attempt + 1,
      timestamp: new Date().toISOString()
    });
  }

  private emitRetrySuccessEvent(state: RetryState): void {
    this.emit('retry:success', {
      type: 'retry:success',
      taskId: state.taskId,
      totalAttempts: state.attempt,
      timestamp: new Date().toISOString()
    });
  }

  private emitRetryExhaustedEvent(state: RetryState, error: Error): void {
    this.emit('retry:exhausted', {
      type: 'retry:exhausted',
      taskId: state.taskId,
      totalAttempts: state.attempt,
      finalError: error.message,
      timestamp: new Date().toISOString()
    });
  }

  // ==========================================================================
  // Monitoring & Metrics
  // ==========================================================================

  /**
   * Get metrics for active retries.
   */
  getActiveRetries(): RetryState[] {
    return Array.from(this.activeRetries.values());
  }

  /**
   * Get retry metrics.
   */
  async getMetrics(): Promise<RetryMetrics[]> {
    const active = this.getActiveRetries();

    return active.map(state => ({
      operation: state.operation,
      attempts: state.attempt,
      success: false, // Still in progress
      totalTimeMs: Date.now() - state.startTime,
      backoffTimeMs: 0, // Would need to track separately
      pattern: undefined
    }));
  }
}

// ============================================================================
// Internal Types
// ============================================================================

interface RetryState {
  taskId: string;
  operation: string;
  attempt: number;
  maxAttempts: number;
  startTime: number;
  lastError: Error | null;
  modifications: any[];
}

// ============================================================================
// Export Factory Function
// ============================================================================

/**
 * Create retry executor instance.
 *
 * Usage in orchestrator:
 * ```typescript
 * this.retryExecutor = createRetryExecutor(this.retryAnalyzer);
 * ```
 */
export function createRetryExecutor(retryAnalyzer: RetryAnalyzer): RetryExecutor {
  return new RetryExecutor(retryAnalyzer);
}
