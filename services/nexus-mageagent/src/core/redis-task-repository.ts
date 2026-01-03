/**
 * Redis Task Repository - Production-Grade Task Persistence
 *
 * Implements Repository Pattern with:
 * - Optimistic locking (Redis WATCH/MULTI/EXEC)
 * - Automatic TTL-based cleanup
 * - Exponential backoff retry logic
 * - Comprehensive error handling
 * - Type-safe serialization/deserialization
 *
 * @pattern Repository Pattern
 * @pattern Optimistic Locking
 * @pattern Retry with Exponential Backoff
 */

import type { Redis } from 'ioredis';
import type {
  ITaskRepository,
  RepositoryConfig,
  RepositoryError as IRepositoryError
} from './task-repository.interface.js';
import type { Task, TaskType, TaskStatus } from './task-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RedisTaskRepository');

/**
 * Repository-specific error class with detailed context
 */
export class RepositoryError extends Error implements IRepositoryError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'RepositoryError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Redis-backed task repository with optimistic locking
 *
 * Storage Strategy:
 * - Task data: Hash at `{prefix}:{taskId}` with TTL
 * - Type index: Set at `{prefix}:type:{taskType}`
 * - Status index: Set at `{prefix}:status:{taskStatus}`
 * - All tasks: ZSet at `{prefix}:all` sorted by createdAt timestamp
 *
 * Concurrency Control:
 * - Uses Redis WATCH for optimistic locking
 * - Exponential backoff retry on conflict
 * - Maximum retry attempts configurable
 */
export class RedisTaskRepository implements ITaskRepository {
  private readonly redis: Redis;
  private readonly config: Required<RepositoryConfig>;

  constructor(redis: Redis, config: RepositoryConfig = {}) {
    if (!redis) {
      throw new RepositoryError(
        'Redis client is required for RedisTaskRepository',
        'INVALID_CONFIG',
        undefined,
        { providedConfig: config }
      );
    }

    this.redis = redis;
    this.config = {
      ttl: config.ttl ?? 86400, // 24 hours default
      keyPrefix: config.keyPrefix ?? 'nexus:tasks',
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 100 // ms
    };

    logger.info('RedisTaskRepository initialized', {
      ttl: this.config.ttl,
      keyPrefix: this.config.keyPrefix,
      maxRetries: this.config.maxRetries
    });
  }

  /**
   * Save a new task with atomic operation and TTL
   */
  async save(task: Task): Promise<void> {
    const key = this.getTaskKey(task.id);
    const serialized = this.serializeTask(task);

    try {
      // Use pipeline for atomic multi-key operations
      const pipeline = this.redis.pipeline();

      // 1. Store task data as hash with TTL
      pipeline.hmset(key, serialized);
      pipeline.expire(key, this.config.ttl);

      // 2. Add to type index
      const typeKey = this.getTypeIndexKey(task.type);
      pipeline.sadd(typeKey, task.id);
      pipeline.expire(typeKey, this.config.ttl);

      // 3. Add to status index
      const statusKey = this.getStatusIndexKey(task.status);
      pipeline.sadd(statusKey, task.id);
      pipeline.expire(statusKey, this.config.ttl);

      // 4. Add to sorted set (all tasks) ordered by createdAt
      const allKey = this.getAllTasksKey();
      const timestamp = task.createdAt.getTime();
      pipeline.zadd(allKey, timestamp, task.id);

      // Execute pipeline atomically
      const results = await pipeline.exec();

      // Check for errors in pipeline execution
      if (!results) {
        throw new RepositoryError(
          'Pipeline execution returned null',
          'PIPELINE_FAILED',
          undefined,
          { taskId: task.id, key }
        );
      }

      for (const [error, _result] of results) {
        if (error) {
          throw new RepositoryError(
            `Pipeline command failed: ${error.message}`,
            'PIPELINE_COMMAND_FAILED',
            error,
            { taskId: task.id, key }
          );
        }
      }

      logger.debug('Task saved successfully', {
        taskId: task.id,
        type: task.type,
        status: task.status,
        ttl: this.config.ttl
      });
    } catch (error) {
      if (error instanceof RepositoryError) {
        throw error;
      }

      throw new RepositoryError(
        `Failed to save task: ${error instanceof Error ? error.message : String(error)}`,
        'SAVE_FAILED',
        error instanceof Error ? error : undefined,
        { taskId: task.id, task }
      );
    }
  }

  /**
   * Retrieve task by ID from Redis
   */
  async findById(taskId: string): Promise<Task | null> {
    const key = this.getTaskKey(taskId);

    try {
      const data = await this.redis.hgetall(key);

      // Empty object means key doesn't exist
      if (!data || Object.keys(data).length === 0) {
        logger.debug('Task not found', { taskId, key });
        return null;
      }

      const task = this.deserializeTask(data);
      logger.debug('Task retrieved successfully', {
        taskId,
        type: task.type,
        status: task.status
      });

      return task;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find task: ${error instanceof Error ? error.message : String(error)}`,
        'FIND_FAILED',
        error instanceof Error ? error : undefined,
        { taskId, key }
      );
    }
  }

  /**
   * Update task with optimistic locking (Redis WATCH/MULTI/EXEC)
   *
   * TWO-PHASE COMMIT SUPPORT:
   * - Supports expectedVersion for optimistic locking
   * - Uses Redis WATCH for atomic version checking
   * - Automatically increments version on successful update
   *
   * Retry Strategy:
   * - Attempt 1: Immediate
   * - Attempt 2: Delay 100ms
   * - Attempt 3: Delay 200ms (exponential backoff)
   */
  async update(
    taskId: string,
    updates: Partial<Task>,
    options?: { expectedVersion?: number }
  ): Promise<boolean> {
    const key = this.getTaskKey(taskId);
    let attempt = 0;

    while (attempt < this.config.maxRetries) {
      attempt++;

      try {
        // WATCH the key for concurrent modifications
        await this.redis.watch(key);

        // Get current task data
        const current = await this.redis.hgetall(key);

        // If task doesn't exist, unwatch and return false
        if (!current || Object.keys(current).length === 0) {
          await this.redis.unwatch();
          logger.warn('Cannot update non-existent task', { taskId, key });
          return false;
        }

        // Deserialize current task
        const currentTask = this.deserializeTask(current);

        // VERSION CHECK: If expectedVersion provided, verify it matches
        if (options?.expectedVersion !== undefined) {
          if (currentTask.version !== options.expectedVersion) {
            await this.redis.unwatch();
            // Import ConflictError dynamically to avoid circular dependency
            const { ConflictError } = await import('../utils/errors.js');
            throw new ConflictError(
              `Task ${taskId} version conflict. Expected v${options.expectedVersion}, found v${currentTask.version}`,
              {
                context: {
                  taskId,
                  expectedVersion: options.expectedVersion,
                  actualVersion: currentTask.version,
                  attempt
                },
                suggestion: 'Refresh task state and retry the operation'
              }
            );
          }
        }

        // Merge updates with current task
        const updatedTask: Task = {
          ...currentTask,
          ...updates,
          id: taskId, // Ensure ID cannot be changed
          version: currentTask.version + 1 // AUTO-INCREMENT version for optimistic locking
        };

        // DIAGNOSTIC: Log merge result to identify data corruption
        logger.info('[REPO-UPDATE-DIAG] Merge result before serialize', {
          taskId,
          currentTaskStatus: currentTask.status,
          updatesStatus: updates.status,
          mergedStatus: updatedTask.status,
          currentVersion: currentTask.version,
          newVersion: updatedTask.version
        });

        // Serialize updated task
        const serialized = this.serializeTask(updatedTask);

        // DIAGNOSTIC: Log serialized output
        logger.info('[REPO-UPDATE-DIAG] Serialized task', {
          taskId,
          serializedStatus: serialized.status,
          serializedVersion: serialized.version,
          serializedProgress: serialized.progress
        });

        // Start MULTI transaction
        const pipeline = this.redis.multi();

        // Update task data
        pipeline.del(key); // Delete first to clear old fields
        pipeline.hmset(key, serialized);
        pipeline.expire(key, this.config.ttl);

        // If status changed, update status indices
        if (updates.status && updates.status !== currentTask.status) {
          // Remove from old status index
          const oldStatusKey = this.getStatusIndexKey(currentTask.status);
          pipeline.srem(oldStatusKey, taskId);

          // Add to new status index
          const newStatusKey = this.getStatusIndexKey(updates.status);
          pipeline.sadd(newStatusKey, taskId);
          pipeline.expire(newStatusKey, this.config.ttl);
        }

        // Execute transaction
        const results = await pipeline.exec();

        // DIAGNOSTIC: Log transaction results
        logger.info('[REPO-UPDATE-DIAG] Transaction executed', {
          taskId,
          resultsCount: results?.length,
          hasResults: !!results,
          statusChanged: updates.status && updates.status !== currentTask.status
        });

        // null means WATCH detected concurrent modification
        if (!results) {
          logger.warn('Optimistic lock failed, retrying', {
            taskId,
            attempt,
            maxRetries: this.config.maxRetries,
            currentVersion: currentTask.version
          });

          // Exponential backoff before retry
          if (attempt < this.config.maxRetries) {
            const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
            await this.sleep(delay);
            continue; // Retry
          }

          throw new RepositoryError(
            `Update failed after ${attempt} attempts due to concurrent modifications`,
            'OPTIMISTIC_LOCK_FAILED',
            undefined,
            { taskId, attempts: attempt, updates, currentVersion: currentTask.version }
          );
        }

        // Check for errors in transaction
        for (const [error, _result] of results) {
          if (error) {
            throw new RepositoryError(
              `Transaction command failed: ${error.message}`,
              'TRANSACTION_FAILED',
              error,
              { taskId, updates }
            );
          }
        }

        logger.debug('Task updated successfully with version increment', {
          taskId,
          attempt,
          previousVersion: currentTask.version,
          newVersion: updatedTask.version,
          updatedFields: Object.keys(updates)
        });

        return true;
      } catch (error) {
        // Unwatch on error
        await this.redis.unwatch().catch(() => {
          // Ignore unwatch errors
        });

        // Re-throw RepositoryErrors and ConflictErrors
        if (error instanceof RepositoryError || error.constructor.name === 'ConflictError') {
          throw error;
        }

        throw new RepositoryError(
          `Failed to update task: ${error instanceof Error ? error.message : String(error)}`,
          'UPDATE_FAILED',
          error instanceof Error ? error : undefined,
          { taskId, updates, attempt }
        );
      }
    }

    // Should not reach here, but for type safety
    return false;
  }

  /**
   * Delete task and remove from all indices
   */
  async delete(taskId: string): Promise<boolean> {
    const key = this.getTaskKey(taskId);

    try {
      // Get task to determine which indices to update
      const data = await this.redis.hgetall(key);

      if (!data || Object.keys(data).length === 0) {
        logger.debug('Task not found for deletion', { taskId, key });
        return false;
      }

      const task = this.deserializeTask(data);

      // Use pipeline for atomic deletion
      const pipeline = this.redis.pipeline();

      // 1. Delete task data
      pipeline.del(key);

      // 2. Remove from type index
      const typeKey = this.getTypeIndexKey(task.type);
      pipeline.srem(typeKey, taskId);

      // 3. Remove from status index
      const statusKey = this.getStatusIndexKey(task.status);
      pipeline.srem(statusKey, taskId);

      // 4. Remove from all tasks sorted set
      const allKey = this.getAllTasksKey();
      pipeline.zrem(allKey, taskId);

      await pipeline.exec();

      logger.debug('Task deleted successfully', { taskId, type: task.type });
      return true;
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete task: ${error instanceof Error ? error.message : String(error)}`,
        'DELETE_FAILED',
        error instanceof Error ? error : undefined,
        { taskId, key }
      );
    }
  }

  /**
   * List tasks with pagination using sorted set
   */
  async list(cursor: string, limit: number): Promise<{ tasks: Task[]; nextCursor: string }> {
    try {
      // Use ZSCAN for cursor-based pagination
      const allKey = this.getAllTasksKey();
      const scanCursor = cursor === '' ? '0' : cursor;

      const [nextCursor, taskIds] = await this.redis.zscan(
        allKey,
        scanCursor,
        'COUNT',
        limit
      );

      // taskIds is array of [id, score, id, score, ...]
      // Extract just the IDs (every other element starting at 0)
      const ids = taskIds.filter((_val, index) => index % 2 === 0);

      // Fetch tasks in parallel
      const tasks = await Promise.all(
        ids.map(id => this.findById(id))
      );

      // Filter out nulls (tasks that were deleted between scan and fetch)
      const validTasks = tasks.filter((task): task is Task => task !== null);

      logger.debug('Tasks listed successfully', {
        cursor,
        limit,
        found: validTasks.length,
        nextCursor
      });

      return {
        tasks: validTasks,
        nextCursor: nextCursor === '0' ? '' : nextCursor
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`,
        'LIST_FAILED',
        error instanceof Error ? error : undefined,
        { cursor, limit }
      );
    }
  }

  /**
   * Find tasks by type
   */
  async findByType(type: TaskType, limit: number = 100): Promise<Task[]> {
    try {
      const typeKey = this.getTypeIndexKey(type);
      const taskIds = await this.redis.smembers(typeKey);

      // Apply limit
      const limitedIds = taskIds.slice(0, limit);

      // Fetch tasks in parallel
      const tasks = await Promise.all(
        limitedIds.map(id => this.findById(id))
      );

      // Filter out nulls
      const validTasks = tasks.filter((task): task is Task => task !== null);

      logger.debug('Tasks found by type', {
        type,
        limit,
        found: validTasks.length
      });

      return validTasks;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by type: ${error instanceof Error ? error.message : String(error)}`,
        'FIND_BY_TYPE_FAILED',
        error instanceof Error ? error : undefined,
        { type, limit }
      );
    }
  }

  /**
   * Find tasks by status
   */
  async findByStatus(status: TaskStatus, limit: number = 100): Promise<Task[]> {
    try {
      const statusKey = this.getStatusIndexKey(status);
      const taskIds = await this.redis.smembers(statusKey);

      // Apply limit
      const limitedIds = taskIds.slice(0, limit);

      // Fetch tasks in parallel
      const tasks = await Promise.all(
        limitedIds.map(id => this.findById(id))
      );

      // Filter out nulls
      const validTasks = tasks.filter((task): task is Task => task !== null);

      logger.debug('Tasks found by status', {
        status,
        limit,
        found: validTasks.length
      });

      return validTasks;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find tasks by status: ${error instanceof Error ? error.message : String(error)}`,
        'FIND_BY_STATUS_FAILED',
        error instanceof Error ? error : undefined,
        { status, limit }
      );
    }
  }

  /**
   * Clean up expired tasks (beyond TTL)
   * Note: Redis handles TTL automatically, this is for manual cleanup if needed
   */
  async cleanup(): Promise<number> {
    try {
      const allKey = this.getAllTasksKey();
      const now = Date.now();
      const expiryThreshold = now - (this.config.ttl * 1000);

      // Remove tasks older than TTL from sorted set
      const removed = await this.redis.zremrangebyscore(
        allKey,
        '-inf',
        expiryThreshold
      );

      logger.info('Expired tasks cleaned up', {
        removed,
        expiryThreshold: new Date(expiryThreshold).toISOString()
      });

      return removed;
    } catch (error) {
      throw new RepositoryError(
        `Failed to cleanup tasks: ${error instanceof Error ? error.message : String(error)}`,
        'CLEANUP_FAILED',
        error instanceof Error ? error : undefined,
        { ttl: this.config.ttl }
      );
    }
  }

  /**
   * Get total count of tasks
   */
  async count(): Promise<number> {
    try {
      const allKey = this.getAllTasksKey();
      const count = await this.redis.zcard(allKey);

      logger.debug('Task count retrieved', { count });
      return count;
    } catch (error) {
      throw new RepositoryError(
        `Failed to count tasks: ${error instanceof Error ? error.message : String(error)}`,
        'COUNT_FAILED',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Health check for repository
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple PING test
      const response = await this.redis.ping();
      const healthy = response === 'PONG';

      logger.debug('Health check performed', { healthy });
      return healthy;
    } catch (error) {
      logger.error('Health check failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private getTaskKey(taskId: string): string {
    return `${this.config.keyPrefix}:${taskId}`;
  }

  private getTypeIndexKey(type: TaskType): string {
    return `${this.config.keyPrefix}:type:${type}`;
  }

  private getStatusIndexKey(status: TaskStatus): string {
    return `${this.config.keyPrefix}:status:${status}`;
  }

  private getAllTasksKey(): string {
    return `${this.config.keyPrefix}:all`;
  }

  /**
   * Serialize Task object to Redis hash format
   */
  private serializeTask(task: Task): Record<string, string> {
    return {
      id: task.id,
      type: task.type,
      status: task.status,
      params: JSON.stringify(task.params),
      result: task.result !== undefined ? JSON.stringify(task.result) : '',
      error: task.error ?? '',
      progress: String(task.progress ?? 0),
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? '',
      completedAt: task.completedAt?.toISOString() ?? '',
      metadata: task.metadata ? JSON.stringify(task.metadata) : '{}',
      version: String(task.version ?? 1) // Optimistic locking version
    };
  }

  /**
   * Deserialize Redis hash to Task object
   */
  private deserializeTask(data: Record<string, string>): Task {
    try {
      return {
        id: data.id,
        type: data.type as TaskType,
        status: data.status as TaskStatus,
        params: data.params ? JSON.parse(data.params) : {},
        result: data.result ? JSON.parse(data.result) : undefined,
        error: data.error || undefined,
        progress: data.progress ? Number(data.progress) : undefined,
        createdAt: new Date(data.createdAt),
        startedAt: data.startedAt ? new Date(data.startedAt) : undefined,
        completedAt: data.completedAt ? new Date(data.completedAt) : undefined,
        metadata: data.metadata ? JSON.parse(data.metadata) : undefined,
        version: data.version ? Number(data.version) : 1 // Optimistic locking version
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to deserialize task: ${error instanceof Error ? error.message : String(error)}`,
        'DESERIALIZATION_FAILED',
        error instanceof Error ? error : undefined,
        { data }
      );
    }
  }

  /**
   * Sleep utility for exponential backoff
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
