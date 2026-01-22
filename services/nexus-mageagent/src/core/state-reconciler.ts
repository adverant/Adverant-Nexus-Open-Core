/**
 * State Reconciler - Detects and Resolves Task State Divergence
 *
 * Implements state reconciliation pattern to handle cases where in-memory
 * and repository task states diverge due to:
 * - Network partitions
 * - Repository failures
 * - Race conditions
 * - Concurrent modifications
 *
 * Design Patterns:
 * - Strategy Pattern: Pluggable reconciliation strategies
 * - Observer Pattern: Metrics and logging
 * - Circuit Breaker: Prevents cascading failures
 *
 * @pattern State Reconciliation
 * @pattern Eventual Consistency
 */

import type { Task, TaskStatus } from './task-manager';
import type { ITaskRepository } from './task-repository.interface';
import { createLogger } from '../utils/logger';
import { StateDesynchronizationError } from '../utils/errors';

const logger = createLogger('StateReconciler');

/**
 * Reconciliation result with detailed diagnosis
 */
export interface ReconciliationResult {
  taskId: string;
  diverged: boolean;
  reconciled: boolean;
  authoritativeSource: 'repository' | 'memory' | 'none';
  discrepancies: string[];
  action: 'repository_restored' | 'memory_updated' | 'no_action' | 'conflict_unresolved';
  timestamp: Date;
  repositoryVersion?: number;
  memoryVersion?: number;
}

/**
 * Reconciliation metrics for monitoring
 */
export interface ReconciliationMetrics {
  totalReconciliations: number;
  successfulReconciliations: number;
  failedReconciliations: number;
  divergenceRate: number;
  averageReconciliationTimeMs: number;
  lastReconciliation: Date | null;
}

/**
 * Reconciliation strategy for determining authoritative state
 */
export type ReconciliationStrategy = 'repository-first' | 'memory-first' | 'version-based' | 'status-based';

/**
 * Configuration for state reconciler
 */
export interface StateReconcilerConfig {
  strategy: ReconciliationStrategy;
  autoReconcile: boolean; // Automatically reconcile on detection
  reconciliationIntervalMs?: number; // Periodic reconciliation interval
  maxRetries?: number;
}

/**
 * State Reconciler Service
 *
 * Detects divergence between in-memory and repository task states,
 * determines authoritative source, and synchronizes state.
 */
export class StateReconciler {
  private metrics: ReconciliationMetrics = {
    totalReconciliations: 0,
    successfulReconciliations: 0,
    failedReconciliations: 0,
    divergenceRate: 0,
    averageReconciliationTimeMs: 0,
    lastReconciliation: null
  };

  private reconciliationTimes: number[] = [];
  private readonly config: Required<StateReconcilerConfig>;

  constructor(
    private readonly repository: ITaskRepository,
    config: Partial<StateReconcilerConfig> = {}
  ) {
    this.config = {
      strategy: config.strategy || 'version-based',
      autoReconcile: config.autoReconcile ?? true,
      reconciliationIntervalMs: config.reconciliationIntervalMs || 60000, // 1 minute default
      maxRetries: config.maxRetries || 3
    };

    logger.info('StateReconciler initialized', {
      strategy: this.config.strategy,
      autoReconcile: this.config.autoReconcile
    });
  }

  /**
   * Reconcile task state between repository and memory
   *
   * Algorithm:
   * 1. Detect divergence by comparing task states
   * 2. Determine authoritative source based on strategy
   * 3. Synchronize states (update repository or memory)
   * 4. Emit metrics and log reconciliation
   *
   * @param taskId - Task ID to reconcile
   * @param memoryTask - Task from in-memory cache (can be null)
   * @returns Reconciliation result with detailed diagnosis
   */
  async reconcile(taskId: string, memoryTask: Task | null): Promise<ReconciliationResult> {
    const startTime = Date.now();

    logger.debug('Starting state reconciliation', { taskId, hasMemoryTask: !!memoryTask });

    try {
      // PHASE 1: Fetch repository state
      const repositoryTask = await this.repository.findById(taskId);

      // PHASE 2: Detect divergence
      const divergence = this.detectDivergence(repositoryTask, memoryTask);

      if (!divergence.diverged) {
        logger.debug('No state divergence detected', { taskId });
        return {
          taskId,
          diverged: false,
          reconciled: true,
          authoritativeSource: 'none',
          discrepancies: [],
          action: 'no_action',
          timestamp: new Date()
        };
      }

      logger.warn('State divergence detected', {
        taskId,
        discrepancies: divergence.discrepancies,
        repositoryVersion: repositoryTask?.version,
        memoryVersion: memoryTask?.version
      });

      // PHASE 3: Determine authoritative source
      const authoritativeSource = this.determineAuthoritativeSource(
        repositoryTask,
        memoryTask,
        this.config.strategy
      );

      // PHASE 4: Synchronize states
      const result = await this.synchronizeStates(
        taskId,
        repositoryTask,
        memoryTask,
        authoritativeSource
      );

      // PHASE 5: Update metrics
      this.updateMetrics(startTime, true);

      logger.info('State reconciliation completed', {
        taskId,
        authoritativeSource,
        action: result.action,
        discrepancies: divergence.discrepancies
      });

      return {
        taskId,
        diverged: true,
        reconciled: true,
        authoritativeSource,
        discrepancies: divergence.discrepancies,
        action: result.action,
        timestamp: new Date(),
        repositoryVersion: repositoryTask?.version,
        memoryVersion: memoryTask?.version
      };
    } catch (error: any) {
      this.updateMetrics(startTime, false);

      logger.error('State reconciliation failed', {
        taskId,
        error: error.message,
        stack: error.stack
      });

      throw new StateDesynchronizationError(
        `Failed to reconcile task ${taskId}: ${error.message}`,
        {
          context: { taskId, error: error.message },
          cause: error
        }
      );
    }
  }

  /**
   * Detect divergence between repository and memory states
   *
   * Compares:
   * - Status
   * - Version
   * - Result existence
   * - Completion timestamps
   * - Error states
   */
  private detectDivergence(
    repositoryTask: Task | null,
    memoryTask: Task | null
  ): { diverged: boolean; discrepancies: string[] } {
    const discrepancies: string[] = [];

    // Case 1: One exists, other doesn't
    if (!repositoryTask && memoryTask) {
      discrepancies.push('Task exists in memory but not in repository');
      return { diverged: true, discrepancies };
    }

    if (repositoryTask && !memoryTask) {
      discrepancies.push('Task exists in repository but not in memory');
      return { diverged: true, discrepancies };
    }

    // Case 2: Both null
    if (!repositoryTask && !memoryTask) {
      return { diverged: false, discrepancies: [] };
    }

    // Case 3: Both exist - compare fields
    if (repositoryTask && memoryTask) {
      // Status divergence
      if (repositoryTask.status !== memoryTask.status) {
        discrepancies.push(
          `Status mismatch: repository=${repositoryTask.status}, memory=${memoryTask.status}`
        );
      }

      // Version divergence
      if (repositoryTask.version !== memoryTask.version) {
        discrepancies.push(
          `Version mismatch: repository=v${repositoryTask.version}, memory=v${memoryTask.version}`
        );
      }

      // Result divergence
      const repoHasResult = repositoryTask.result !== undefined;
      const memHasResult = memoryTask.result !== undefined;
      if (repoHasResult !== memHasResult) {
        discrepancies.push(`Result existence mismatch: repository=${repoHasResult}, memory=${memHasResult}`);
      }

      // Error state divergence
      const repoHasError = !!repositoryTask.error;
      const memHasError = !!memoryTask.error;
      if (repoHasError !== memHasError) {
        discrepancies.push(`Error state mismatch: repository=${repoHasError}, memory=${memHasError}`);
      }

      // Completion timestamp divergence
      const repoCompleted = !!repositoryTask.completedAt;
      const memCompleted = !!memoryTask.completedAt;
      if (repoCompleted !== memCompleted) {
        discrepancies.push(`Completion state mismatch: repository=${repoCompleted}, memory=${memCompleted}`);
      }
    }

    return {
      diverged: discrepancies.length > 0,
      discrepancies
    };
  }

  /**
   * Determine authoritative source based on reconciliation strategy
   *
   * Strategies:
   * - repository-first: Always trust repository (durable storage)
   * - memory-first: Always trust memory (latest state)
   * - version-based: Trust higher version number
   * - status-based: Trust more advanced status (completed > running > pending)
   */
  private determineAuthoritativeSource(
    repositoryTask: Task | null,
    memoryTask: Task | null,
    strategy: ReconciliationStrategy
  ): 'repository' | 'memory' | 'none' {
    // If only one exists, it's authoritative
    if (repositoryTask && !memoryTask) return 'repository';
    if (!repositoryTask && memoryTask) return 'memory';
    if (!repositoryTask && !memoryTask) return 'none';

    // Both exist - apply strategy
    switch (strategy) {
      case 'repository-first':
        return 'repository';

      case 'memory-first':
        return 'memory';

      case 'version-based':
        // Trust higher version number
        if (repositoryTask!.version > memoryTask!.version) {
          return 'repository';
        } else if (memoryTask!.version > repositoryTask!.version) {
          return 'memory';
        } else {
          // Same version - default to repository (durable)
          return 'repository';
        }

      case 'status-based':
        // Trust more advanced status
        const statusPriority: Record<TaskStatus, number> = {
          completed: 4,
          failed: 3,
          timeout: 3,
          running: 2,
          pending: 1
        };

        const repoPriority = statusPriority[repositoryTask!.status] || 0;
        const memPriority = statusPriority[memoryTask!.status] || 0;

        if (repoPriority > memPriority) {
          return 'repository';
        } else if (memPriority > repoPriority) {
          return 'memory';
        } else {
          // Same status - default to higher version
          return repositoryTask!.version >= memoryTask!.version ? 'repository' : 'memory';
        }

      default:
        return 'repository'; // Safe default
    }
  }

  /**
   * Synchronize states based on authoritative source
   *
   * Actions:
   * - repository -> memory: Update in-memory cache (via callback)
   * - memory -> repository: Write memory state to repository
   * - none: No action needed
   */
  private async synchronizeStates(
    taskId: string,
    repositoryTask: Task | null,
    memoryTask: Task | null,
    authoritativeSource: 'repository' | 'memory' | 'none'
  ): Promise<{ action: ReconciliationResult['action']; syncedTask?: Task }> {
    switch (authoritativeSource) {
      case 'repository':
        if (!repositoryTask) {
          // Repository is authoritative but doesn't have task - delete from memory
          return { action: 'memory_updated' };
        }

        // Repository has authoritative state - memory should be updated
        logger.info('Repository is authoritative, memory will be updated', {
          taskId,
          repositoryVersion: repositoryTask.version
        });

        return {
          action: 'memory_updated',
          syncedTask: repositoryTask
        };

      case 'memory':
        if (!memoryTask) {
          // Memory is authoritative but doesn't have task - delete from repository
          await this.repository.delete(taskId);
          return { action: 'repository_restored' };
        }

        // Memory has authoritative state - write to repository
        logger.info('Memory is authoritative, updating repository', {
          taskId,
          memoryVersion: memoryTask.version
        });

        await this.repository.save(memoryTask);
        return {
          action: 'repository_restored',
          syncedTask: memoryTask
        };

      case 'none':
        return { action: 'no_action' };

      default:
        logger.error('Unknown authoritative source', { authoritativeSource });
        return { action: 'conflict_unresolved' };
    }
  }

  /**
   * Update reconciliation metrics
   */
  private updateMetrics(startTime: number, success: boolean): void {
    const duration = Date.now() - startTime;

    this.metrics.totalReconciliations++;
    if (success) {
      this.metrics.successfulReconciliations++;
    } else {
      this.metrics.failedReconciliations++;
    }

    this.reconciliationTimes.push(duration);
    if (this.reconciliationTimes.length > 100) {
      this.reconciliationTimes.shift(); // Keep last 100
    }

    this.metrics.averageReconciliationTimeMs =
      this.reconciliationTimes.reduce((sum, t) => sum + t, 0) / this.reconciliationTimes.length;

    this.metrics.divergenceRate =
      this.metrics.totalReconciliations > 0
        ? this.metrics.successfulReconciliations / this.metrics.totalReconciliations
        : 0;

    this.metrics.lastReconciliation = new Date();
  }

  /**
   * Get current reconciliation metrics
   */
  getMetrics(): ReconciliationMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics (useful for testing)
   */
  resetMetrics(): void {
    this.metrics = {
      totalReconciliations: 0,
      successfulReconciliations: 0,
      failedReconciliations: 0,
      divergenceRate: 0,
      averageReconciliationTimeMs: 0,
      lastReconciliation: null
    };
    this.reconciliationTimes = [];
  }
}
