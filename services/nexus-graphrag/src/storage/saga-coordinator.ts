/**
 * Saga Pattern Coordinator for Multi-Database Writes
 *
 * Implements the Saga pattern to ensure atomic multi-database operations
 * with compensating transactions for rollback on failure.
 *
 * CRITICAL: This prevents data corruption from partial writes across
 * PostgreSQL, Qdrant, and Neo4j.
 *
 * @see REMEDIATION_PLAN.md Task 2.1
 */

import { logger } from '../utils/logger';

/**
 * Saga Step Definition
 *
 * Each step represents an atomic operation with its compensating transaction.
 */
export interface SagaStep<T = any> {
  /** Unique name for logging and debugging */
  name: string;

  /** Forward operation - execute the transaction */
  execute: () => Promise<T>;

  /** Compensating transaction - undo the forward operation */
  compensate: () => Promise<void>;

  /**
   * Idempotency flag - if true, retrying this step is safe
   * All database operations MUST be idempotent
   */
  isIdempotent: boolean;

  /**
   * Optional timeout in milliseconds
   * Default: 30000ms (30 seconds)
   */
  timeout?: number;

  /**
   * Optional retry configuration
   */
  retries?: {
    maxAttempts: number;
    backoffMs: number;
  };
}

/**
 * Saga Execution Context
 *
 * Tracks execution state and results for debugging and observability.
 */
export interface SagaContext {
  sagaId: string;
  startTime: number;
  completedSteps: Array<{
    name: string;
    result: any;
    duration: number;
  }>;
  failedStep?: {
    name: string;
    error: Error;
    duration: number;
  };
  rollbackResults: Array<{
    name: string;
    success: boolean;
    error?: Error;
    duration: number;
  }>;
}

/**
 * Saga Execution Result
 */
export interface SagaResult {
  success: boolean;
  context: SagaContext;
  error?: Error;
}

/**
 * Saga Coordinator
 *
 * Orchestrates multi-step distributed transactions with automatic rollback.
 *
 * Usage:
 * ```typescript
 * const saga = new SagaCoordinator(logger);
 * const steps: SagaStep[] = [
 *   {
 *     name: 'store-postgres',
 *     execute: async () => { ... },
 *     compensate: async () => { ... },
 *     isIdempotent: true
 *   },
 *   // ... more steps
 * ];
 *
 * const result = await saga.execute(steps);
 * ```
 */
export class SagaCoordinator {
  private executedSteps: Array<{ step: SagaStep; result: any }> = [];
  private context: SagaContext;

  constructor(
    private readonly loggerInstance: typeof logger,
    private readonly sagaId: string = `saga-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  ) {
    this.context = {
      sagaId: this.sagaId,
      startTime: Date.now(),
      completedSteps: [],
      rollbackResults: []
    };
  }

  /**
   * Execute saga with automatic rollback on failure
   *
   * @param steps - Array of saga steps to execute sequentially
   * @returns Promise<SagaResult> - Success status and execution context
   *
   * @throws Never throws - all errors are captured in SagaResult
   */
  async execute(steps: SagaStep[]): Promise<SagaResult> {
    this.executedSteps = [];

    this.loggerInstance.info('[SAGA] Starting saga execution', {
      sagaId: this.context.sagaId,
      stepCount: steps.length,
      steps: steps.map(s => s.name)
    });

    try {
      // Execute all steps sequentially
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepStartTime = Date.now();

        this.loggerInstance.info(`[SAGA] Executing step ${i + 1}/${steps.length}: ${step.name}`, {
          sagaId: this.context.sagaId,
          stepName: step.name,
          isIdempotent: step.isIdempotent
        });

        try {
          // Execute step with timeout
          const result = await this.executeStepWithTimeout(step);

          // Record success
          const duration = Date.now() - stepStartTime;
          this.executedSteps.push({ step, result });
          this.context.completedSteps.push({
            name: step.name,
            result,
            duration
          });

          this.loggerInstance.info(`[SAGA] Step completed successfully: ${step.name}`, {
            sagaId: this.context.sagaId,
            stepName: step.name,
            duration,
            resultPreview: this.sanitizeResult(result)
          });

        } catch (error: any) {
          // Record failure
          const duration = Date.now() - stepStartTime;
          this.context.failedStep = {
            name: step.name,
            error,
            duration
          };

          this.loggerInstance.error(`[SAGA] Step failed: ${step.name}`, {
            sagaId: this.context.sagaId,
            stepName: step.name,
            error: error.message,
            stack: error.stack,
            duration,
            completedSteps: this.executedSteps.length
          });

          // Trigger rollback
          throw error;
        }
      }

      // All steps completed successfully
      const totalDuration = Date.now() - this.context.startTime;
      this.loggerInstance.info('[SAGA] Saga completed successfully', {
        sagaId: this.context.sagaId,
        stepsExecuted: this.executedSteps.length,
        totalDuration
      });

      return {
        success: true,
        context: this.context
      };

    } catch (error: any) {
      // Saga failed - initiate rollback
      this.loggerInstance.warn('[SAGA] Saga failed, starting rollback', {
        sagaId: this.context.sagaId,
        stepsToRollback: this.executedSteps.length,
        failedStep: this.context.failedStep?.name,
        error: error.message
      });

      await this.rollback();

      return {
        success: false,
        context: this.context,
        error
      };
    }
  }

  /**
   * Execute a single step with timeout protection
   */
  private async executeStepWithTimeout<T>(step: SagaStep<T>): Promise<T> {
    const timeout = step.timeout || 30000; // Default 30 seconds
    const retries = step.retries || { maxAttempts: 1, backoffMs: 0 };

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retries.maxAttempts; attempt++) {
      try {
        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(
              `Step timeout exceeded: ${step.name} (${timeout}ms). ` +
              `This may indicate a hung database connection or deadlock.`
            ));
          }, timeout);
        });

        // Race between execution and timeout
        const result = await Promise.race([
          step.execute(),
          timeoutPromise
        ]);

        return result;

      } catch (error: any) {
        lastError = error;

        if (attempt < retries.maxAttempts) {
          const backoff = retries.backoffMs * attempt;
          this.loggerInstance.warn(`[SAGA] Step failed, retrying (${attempt}/${retries.maxAttempts})`, {
            sagaId: this.context.sagaId,
            stepName: step.name,
            attempt,
            backoff,
            error: error.message
          });
          await this.sleep(backoff);
        }
      }
    }

    // All retries exhausted
    throw new Error(
      `Step failed after ${retries.maxAttempts} attempts: ${step.name}. ` +
      `Last error: ${lastError?.message}`
    );
  }

  /**
   * Rollback all executed steps in reverse order
   *
   * CRITICAL: Best-effort rollback - we log errors but don't stop
   * even if compensating transactions fail.
   */
  private async rollback(): Promise<void> {
    const rollbackStartTime = Date.now();
    const rollbackErrors: Array<{ step: string; error: Error }> = [];

    this.loggerInstance.info('[SAGA] Starting rollback', {
      sagaId: this.context.sagaId,
      stepsToRollback: this.executedSteps.length
    });

    // Rollback in reverse order
    for (let i = this.executedSteps.length - 1; i >= 0; i--) {
      const { step, result } = this.executedSteps[i];
      const compensateStartTime = Date.now();

      try {
        this.loggerInstance.info(`[SAGA] Rolling back step: ${step.name}`, {
          sagaId: this.context.sagaId,
          stepName: step.name,
          stepIndex: i
        });

        // Execute compensating transaction with timeout
        const compensateTimeout = (step.timeout || 30000) * 1.5; // 1.5x timeout for rollback
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(
              `Compensation timeout exceeded: ${step.name} (${compensateTimeout}ms)`
            ));
          }, compensateTimeout);
        });

        await Promise.race([
          step.compensate(),
          timeoutPromise
        ]);

        const duration = Date.now() - compensateStartTime;
        this.context.rollbackResults.push({
          name: step.name,
          success: true,
          duration
        });

        this.loggerInstance.info(`[SAGA] Successfully rolled back step: ${step.name}`, {
          sagaId: this.context.sagaId,
          stepName: step.name,
          duration
        });

      } catch (compensationError: any) {
        const duration = Date.now() - compensateStartTime;

        rollbackErrors.push({
          step: step.name,
          error: compensationError
        });

        this.context.rollbackResults.push({
          name: step.name,
          success: false,
          error: compensationError,
          duration
        });

        this.loggerInstance.error(`[SAGA] Compensation failed for step: ${step.name}`, {
          sagaId: this.context.sagaId,
          stepName: step.name,
          error: compensationError.message,
          stack: compensationError.stack,
          duration
        });

        // Continue with other compensations - best effort
      }
    }

    const totalRollbackDuration = Date.now() - rollbackStartTime;

    if (rollbackErrors.length > 0) {
      this.loggerInstance.error('[SAGA] Rollback completed with errors', {
        sagaId: this.context.sagaId,
        totalSteps: this.executedSteps.length,
        successfulRollbacks: this.executedSteps.length - rollbackErrors.length,
        failedRollbacks: rollbackErrors.length,
        errors: rollbackErrors.map(e => ({ step: e.step, error: e.error.message })),
        totalDuration: totalRollbackDuration
      });

      // CRITICAL: Manual intervention may be required
      this.loggerInstance.error('[SAGA] MANUAL INTERVENTION MAY BE REQUIRED', {
        sagaId: this.context.sagaId,
        message: 'Some compensating transactions failed. Database state may be inconsistent.',
        failedSteps: rollbackErrors.map(e => e.step),
        recommendation: 'Review database state and manually clean up failed compensations'
      });
    } else {
      this.loggerInstance.info('[SAGA] Rollback completed successfully', {
        sagaId: this.context.sagaId,
        stepsRolledBack: this.executedSteps.length,
        totalDuration: totalRollbackDuration
      });
    }
  }

  /**
   * Get saga execution context for debugging
   */
  getContext(): SagaContext {
    return { ...this.context };
  }

  /**
   * Sanitize result for logging (remove sensitive data, truncate large objects)
   */
  private sanitizeResult(result: any): any {
    if (result === null || result === undefined) {
      return result;
    }

    if (typeof result === 'object') {
      // Truncate large objects
      const sanitized: any = {};
      const keys = Object.keys(result).slice(0, 5); // Max 5 keys
      for (const key of keys) {
        if (typeof result[key] === 'string' && result[key].length > 100) {
          sanitized[key] = result[key].substring(0, 100) + '...';
        } else {
          sanitized[key] = result[key];
        }
      }
      return sanitized;
    }

    return result;
  }

  /**
   * Sleep utility for retries
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory function for creating saga coordinators
 */
export function createSaga(logger: typeof import('../utils/logger').logger, sagaId?: string): SagaCoordinator {
  return new SagaCoordinator(logger, sagaId);
}
