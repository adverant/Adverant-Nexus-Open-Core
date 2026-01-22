/**
 * Task Recovery Strategies - Graceful Degradation via Strategy Pattern
 *
 * Handles scenarios where task exists in Bull queue but not in task registry:
 * - Service restart cleared in-memory registry
 * - Repository temporarily unavailable
 * - Concurrent access race conditions
 *
 * Two strategies implemented:
 * 1. RebuildRecoveryStrategy - Reconstruct task from Bull job metadata (graceful)
 * 2. StrictRecoveryStrategy - Fail fast, require explicit resolution (safe)
 *
 * @pattern Strategy Pattern
 * @pattern Dependency Injection
 */

import type { Job } from 'bull';
import type { Task, TaskType, TaskStatus } from './task-manager.js';
import type { ITaskRepository } from './task-repository.interface.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TaskRecoveryStrategy');

/**
 * Recovery strategy interface
 */
export interface ITaskRecoveryStrategy {
  /**
   * Attempt to recover task from Bull job when not found in repository
   *
   * @param taskId - Task ID to recover
   * @param job - Bull job associated with task
   * @returns Recovered Task object
   * @throws {RecoveryError} if recovery fails
   */
  recover(taskId: string, job: Job): Promise<Task>;

  /**
   * Strategy name for logging and debugging
   */
  readonly name: string;
}

/**
 * Recovery-specific error class
 */
export class RecoveryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly taskId: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RecoveryError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Rebuild Recovery Strategy - Reconstruct task from Bull job metadata
 *
 * Use when:
 * - Service restart cleared in-memory registry
 * - Repository temporarily unavailable
 * - Graceful degradation is acceptable
 *
 * Limitations:
 * - May not have full task metadata
 * - Depends on Bull job data completeness
 */
export class RebuildRecoveryStrategy implements ITaskRecoveryStrategy {
  readonly name = 'RebuildRecoveryStrategy';

  constructor(private readonly repository: ITaskRepository) {
    if (!repository) {
      throw new RecoveryError(
        'Repository is required for RebuildRecoveryStrategy',
        'INVALID_CONFIG',
        'N/A'
      );
    }
  }

  async recover(taskId: string, job: Job): Promise<Task> {
    logger.info('Attempting to rebuild task from Bull job', {
      taskId,
      jobId: job.id,
      jobName: job.name,
      strategy: this.name
    });

    try {
      // Map Bull job state to TaskStatus
      const jobState = await job.getState();
      const status = this.mapJobStateToTaskStatus(jobState);

      // Reconstruct Task from Bull job metadata
      const task: Task = {
        id: taskId,
        type: job.name as TaskType,
        status,
        params: job.data.params || {},
        result: job.returnvalue,
        error: job.failedReason,
        progress: (typeof job.progress === 'number' ? job.progress : 0) as number,
        createdAt: new Date(job.timestamp),
        startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
        metadata: job.data.metadata || {},
        version: 1 // Default version for recovered tasks
      };

      // Attempt to re-register in repository for future lookups
      try {
        await this.repository.save(task);
        logger.info('Task successfully rebuilt and registered', {
          taskId,
          type: task.type,
          status: task.status
        });
      } catch (repoError) {
        // Log but don't fail - we still recovered the task
        logger.warn('Failed to re-register rebuilt task in repository', {
          taskId,
          error: repoError instanceof Error ? repoError.message : String(repoError)
        });
      }

      return task;
    } catch (error) {
      throw new RecoveryError(
        `Failed to rebuild task from Bull job: ${error instanceof Error ? error.message : String(error)}`,
        'REBUILD_FAILED',
        taskId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Map Bull job state to TaskStatus
   */
  private mapJobStateToTaskStatus(state: string): TaskStatus {
    switch (state) {
      case 'waiting':
      case 'delayed':
        return 'pending';
      case 'active':
        return 'running';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        logger.warn('Unknown job state, defaulting to pending', { state });
        return 'pending';
    }
  }
}

/**
 * Strict Recovery Strategy - Fail fast, require explicit resolution
 *
 * Use when:
 * - Data integrity is critical
 * - You want to detect and manually resolve desynchronization
 * - Automated recovery is too risky
 *
 * Characteristics:
 * - Throws error immediately on missing task
 * - Forces explicit handling of desynchronization
 * - Prevents silent data inconsistencies
 */
export class StrictRecoveryStrategy implements ITaskRecoveryStrategy {
  readonly name = 'StrictRecoveryStrategy';

  async recover(taskId: string, job: Job): Promise<Task> {
    logger.error('Task desynchronization detected with strict recovery enabled', {
      taskId,
      jobId: job.id,
      jobName: job.name,
      strategy: this.name
    });

    throw new RecoveryError(
      `Task ${taskId} exists in Bull queue but not in task registry. ` +
      `Strict recovery mode requires manual intervention. ` +
      `Job: ${job.name} (ID: ${job.id})`,
      'DESYNCHRONIZATION_DETECTED',
      taskId
    );
  }
}

/**
 * Factory for creating recovery strategies
 *
 * @pattern Factory Pattern
 */
export class TaskRecoveryStrategyFactory {
  /**
   * Create recovery strategy by type
   *
   * @param type - Strategy type ('rebuild' | 'strict')
   * @param repository - Optional repository (required for 'rebuild' strategy)
   */
  static create(
    type: 'rebuild' | 'strict',
    repository?: ITaskRepository
  ): ITaskRecoveryStrategy {
    switch (type) {
      case 'rebuild':
        if (!repository) {
          throw new RecoveryError(
            'Repository is required for RebuildRecoveryStrategy',
            'INVALID_CONFIG',
            'N/A'
          );
        }
        return new RebuildRecoveryStrategy(repository);

      case 'strict':
        return new StrictRecoveryStrategy();

      default:
        throw new RecoveryError(
          `Unknown recovery strategy type: ${type}`,
          'UNKNOWN_STRATEGY',
          'N/A'
        );
    }
  }
}
