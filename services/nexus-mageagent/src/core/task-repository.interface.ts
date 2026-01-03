/**
 * Task Repository Interface - Repository Pattern for Task Persistence
 *
 * Provides abstraction over task storage, enabling:
 * - Dependency Inversion Principle (SOLID)
 * - Easy testing with mock implementations
 * - Flexible storage backends (Redis, PostgreSQL, in-memory)
 * - Clean separation of concerns
 *
 * @pattern Repository Pattern
 * @pattern Dependency Inversion Principle (SOLID)
 */

import type { Task, TaskType, TaskStatus } from './task-manager.js';

/**
 * Repository interface for task persistence operations
 * Implementations must guarantee atomicity and consistency
 */
export interface ITaskRepository {
  /**
   * Save a new task to persistent storage
   * @throws {RepositoryError} if save operation fails
   */
  save(task: Task): Promise<void>;

  /**
   * Retrieve a task by ID from persistent storage
   * @returns Task if found, null otherwise
   */
  findById(taskId: string): Promise<Task | null>;

  /**
   * Update an existing task atomically with optimistic locking
   * @param taskId - Task ID to update
   * @param updates - Partial task updates to apply
   * @param options - Update options including expectedVersion for optimistic locking
   * @returns true if update succeeded, false if task not found or concurrent modification
   * @throws {ConflictError} if expectedVersion doesn't match current version
   */
  update(
    taskId: string,
    updates: Partial<Task>,
    options?: { expectedVersion?: number }
  ): Promise<boolean>;

  /**
   * Delete a task from persistent storage
   * @returns true if deleted, false if not found
   */
  delete(taskId: string): Promise<boolean>;

  /**
   * List tasks with pagination
   * @param cursor - Pagination cursor (empty string for first page)
   * @param limit - Maximum tasks to return
   * @returns Tasks and next cursor for pagination
   */
  list(cursor: string, limit: number): Promise<{
    tasks: Task[];
    nextCursor: string;
  }>;

  /**
   * Find tasks by type
   * @param type - Task type to filter by
   * @param limit - Maximum tasks to return
   */
  findByType(type: TaskType, limit?: number): Promise<Task[]>;

  /**
   * Find tasks by status
   * @param status - Task status to filter by
   * @param limit - Maximum tasks to return
   */
  findByStatus(status: TaskStatus, limit?: number): Promise<Task[]>;

  /**
   * Clean up expired tasks (TTL-based)
   * @returns Number of tasks cleaned up
   */
  cleanup(): Promise<number>;

  /**
   * Get total count of tasks in repository
   */
  count(): Promise<number>;

  /**
   * Health check for repository
   * @returns true if repository is operational
   */
  healthCheck(): Promise<boolean>;
}

/**
 * Repository-specific error class
 */
export class RepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RepositoryError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration for repository implementations
 */
export interface RepositoryConfig {
  /**
   * TTL for task entries (in seconds)
   * Default: 86400 (24 hours)
   */
  ttl?: number;

  /**
   * Key prefix for namespacing
   * Default: 'nexus:tasks'
   */
  keyPrefix?: string;

  /**
   * Maximum retry attempts for optimistic locking
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Initial retry delay in milliseconds
   * Default: 100ms
   */
  retryDelay?: number;
}
