/**
 * Dead Letter Queue (DLQ)
 *
 * Persists tasks that have exhausted their retry budget for manual review.
 * Provides querying, reprocessing, and cleanup capabilities.
 *
 * Storage: PostgreSQL (durable, queryable, transactional)
 *
 * @module dead-letter-queue
 * @version 1.0.0
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger';

// ============================================================================
// Type Definitions
// ============================================================================

export interface DeadLetterEntry {
  taskId: string;
  reason: string;
  attempts: number;
  duration: number;
  errors: string[];
  patterns: string[];
  timestamp: Date;
  firstAttemptTime: Date;
  lastAttemptTime: Date;
  metadata?: Record<string, any>;
}

export interface StoredDeadLetterEntry extends DeadLetterEntry {
  id: string;
  status: 'pending' | 'processing' | 'resolved' | 'archived';
  resolvedAt?: Date;
  resolvedBy?: string;
  resolution?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DLQQueryOptions {
  status?: 'pending' | 'processing' | 'resolved' | 'archived';
  reason?: string;
  minAttempts?: number;
  maxAttempts?: number;
  minDuration?: number;
  maxDuration?: number;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'attempts' | 'duration';
  sortOrder?: 'asc' | 'desc';
}

export interface DLQStats {
  totalEntries: number;
  pendingEntries: number;
  processingEntries: number;
  resolvedEntries: number;
  archivedEntries: number;
  avgAttempts: number;
  avgDuration: number;
  reasonBreakdown: Record<string, number>;
  oldestEntry?: Date;
  newestEntry?: Date;
}

// ============================================================================
// Dead Letter Queue
// ============================================================================

export class DeadLetterQueue {
  private pool: Pool;
  private readonly TABLE_NAME = 'retry_intelligence.dead_letter_queue';

  constructor(databasePool: Pool) {
    if (!databasePool) {
      throw new Error(
        'DeadLetterQueue initialization failed:\n' +
        'Database pool is required but was not provided.\n' +
        'Please ensure PostgreSQL connection is established.'
      );
    }

    this.pool = databasePool;

    logger.info('DeadLetterQueue initialized', {
      tableName: this.TABLE_NAME,
      component: 'dead-letter-queue'
    });

    // Ensure table exists
    this.ensureTableExistsAsync();
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Add task to Dead Letter Queue.
   *
   * Persists to database with full error history.
   *
   * Performance: < 50ms
   */
  async add(entry: DeadLetterEntry): Promise<string> {
    try {
      const query = `
        INSERT INTO ${this.TABLE_NAME} (
          task_id,
          reason,
          attempts,
          duration,
          errors,
          patterns,
          timestamp,
          first_attempt_time,
          last_attempt_time,
          metadata,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `;

      const values = [
        entry.taskId,
        entry.reason,
        entry.attempts,
        entry.duration,
        JSON.stringify(entry.errors),
        JSON.stringify(entry.patterns),
        entry.timestamp,
        entry.firstAttemptTime,
        entry.lastAttemptTime,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        'pending'
      ];

      const result = await this.pool.query(query, values);
      const dlqId = result.rows[0].id;

      logger.info('Task added to Dead Letter Queue', {
        dlqId,
        taskId: entry.taskId,
        reason: entry.reason,
        attempts: entry.attempts,
        duration: entry.duration,
        errorCount: entry.errors.length,
        patterns: entry.patterns,
        component: 'dead-letter-queue'
      });

      return dlqId;

    } catch (error) {
      logger.error('Failed to add task to Dead Letter Queue', {
        taskId: entry.taskId,
        error: error instanceof Error ? error.message : String(error),
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  /**
   * Query Dead Letter Queue with filters.
   *
   * Supports pagination, filtering, and sorting.
   *
   * Performance: < 100ms
   */
  async query(options: DLQQueryOptions = {}): Promise<StoredDeadLetterEntry[]> {
    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      // Build WHERE clause
      if (options.status) {
        conditions.push(`status = $${paramIndex++}`);
        values.push(options.status);
      }

      if (options.reason) {
        conditions.push(`reason = $${paramIndex++}`);
        values.push(options.reason);
      }

      if (options.minAttempts !== undefined) {
        conditions.push(`attempts >= $${paramIndex++}`);
        values.push(options.minAttempts);
      }

      if (options.maxAttempts !== undefined) {
        conditions.push(`attempts <= $${paramIndex++}`);
        values.push(options.maxAttempts);
      }

      if (options.minDuration !== undefined) {
        conditions.push(`duration >= $${paramIndex++}`);
        values.push(options.minDuration);
      }

      if (options.maxDuration !== undefined) {
        conditions.push(`duration <= $${paramIndex++}`);
        values.push(options.maxDuration);
      }

      if (options.startDate) {
        conditions.push(`timestamp >= $${paramIndex++}`);
        values.push(options.startDate);
      }

      if (options.endDate) {
        conditions.push(`timestamp <= $${paramIndex++}`);
        values.push(options.endDate);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      // Build ORDER BY clause
      const sortBy = options.sortBy || 'timestamp';
      const sortOrder = options.sortOrder || 'desc';
      const orderClause = `ORDER BY ${sortBy} ${sortOrder}`;

      // Build LIMIT/OFFSET clause
      const limit = options.limit || 100;
      const offset = options.offset || 0;
      const limitClause = `LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      values.push(limit, offset);

      const query = `
        SELECT * FROM ${this.TABLE_NAME}
        ${whereClause}
        ${orderClause}
        ${limitClause}
      `;

      const result = await this.pool.query(query, values);

      return result.rows.map(row => this.mapRowToEntry(row));

    } catch (error) {
      logger.error('Failed to query Dead Letter Queue', {
        error: error instanceof Error ? error.message : String(error),
        options,
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  /**
   * Get single entry by ID.
   */
  async getById(id: string): Promise<StoredDeadLetterEntry | null> {
    try {
      const query = `SELECT * FROM ${this.TABLE_NAME} WHERE id = $1`;
      const result = await this.pool.query(query, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToEntry(result.rows[0]);

    } catch (error) {
      logger.error('Failed to get DLQ entry by ID', {
        id,
        error: error instanceof Error ? error.message : String(error),
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  /**
   * Update entry status (e.g., mark as processing, resolved).
   */
  async updateStatus(
    id: string,
    status: 'pending' | 'processing' | 'resolved' | 'archived',
    resolution?: string,
    resolvedBy?: string
  ): Promise<void> {
    try {
      const query = `
        UPDATE ${this.TABLE_NAME}
        SET
          status = $1,
          resolution = $2,
          resolved_by = $3,
          resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
          updated_at = NOW()
        WHERE id = $4
      `;

      await this.pool.query(query, [status, resolution || null, resolvedBy || null, id]);

      logger.info('DLQ entry status updated', {
        id,
        status,
        resolution,
        resolvedBy,
        component: 'dead-letter-queue'
      });

    } catch (error) {
      logger.error('Failed to update DLQ entry status', {
        id,
        status,
        error: error instanceof Error ? error.message : String(error),
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  /**
   * Resolve a DLQ entry (mark as resolved with resolution notes).
   *
   * Convenience method that wraps updateStatus() for resolved entries.
   */
  async resolve(id: string, resolvedBy: string, resolution: string): Promise<void> {
    await this.updateStatus(id, 'resolved', resolution, resolvedBy);

    logger.info('DLQ entry resolved', {
      id,
      resolvedBy,
      resolution,
      component: 'dead-letter-queue'
    });
  }

  /**
   * Delete entry by ID (permanent removal).
   *
   * Use with caution - consider archiving instead.
   */
  async delete(id: string): Promise<void> {
    try {
      const query = `DELETE FROM ${this.TABLE_NAME} WHERE id = $1`;
      await this.pool.query(query, [id]);

      logger.warn('DLQ entry permanently deleted', {
        id,
        component: 'dead-letter-queue'
      });

    } catch (error) {
      logger.error('Failed to delete DLQ entry', {
        id,
        error: error instanceof Error ? error.message : String(error),
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  /**
   * Archive old resolved entries (cleanup).
   *
   * Moves resolved entries older than specified days to archived status.
   */
  async archiveOldEntries(olderThanDays: number = 30): Promise<number> {
    try {
      const query = `
        UPDATE ${this.TABLE_NAME}
        SET status = 'archived', updated_at = NOW()
        WHERE status = 'resolved'
          AND resolved_at < NOW() - INTERVAL '${olderThanDays} days'
      `;

      const result = await this.pool.query(query);
      const archivedCount = result.rowCount || 0;

      logger.info('Archived old DLQ entries', {
        archivedCount,
        olderThanDays,
        component: 'dead-letter-queue'
      });

      return archivedCount;

    } catch (error) {
      logger.error('Failed to archive old DLQ entries', {
        error: error instanceof Error ? error.message : String(error),
        olderThanDays,
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  /**
   * Get aggregate statistics for monitoring.
   */
  async getStats(): Promise<DLQStats> {
    try {
      // Get count by status
      const statusQuery = `
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending') as pending_entries,
          COUNT(*) FILTER (WHERE status = 'processing') as processing_entries,
          COUNT(*) FILTER (WHERE status = 'resolved') as resolved_entries,
          COUNT(*) FILTER (WHERE status = 'archived') as archived_entries,
          COUNT(*) as total_entries,
          AVG(attempts) as avg_attempts,
          AVG(duration) as avg_duration,
          MIN(timestamp) as oldest_entry,
          MAX(timestamp) as newest_entry
        FROM ${this.TABLE_NAME}
      `;

      const statusResult = await this.pool.query(statusQuery);
      const stats = statusResult.rows[0];

      // Get reason breakdown
      const reasonQuery = `
        SELECT reason, COUNT(*) as count
        FROM ${this.TABLE_NAME}
        GROUP BY reason
      `;

      const reasonResult = await this.pool.query(reasonQuery);
      const reasonBreakdown: Record<string, number> = {};

      for (const row of reasonResult.rows) {
        reasonBreakdown[row.reason] = parseInt(row.count, 10);
      }

      return {
        totalEntries: parseInt(stats.total_entries, 10),
        pendingEntries: parseInt(stats.pending_entries, 10),
        processingEntries: parseInt(stats.processing_entries, 10),
        resolvedEntries: parseInt(stats.resolved_entries, 10),
        archivedEntries: parseInt(stats.archived_entries, 10),
        avgAttempts: parseFloat(stats.avg_attempts) || 0,
        avgDuration: parseFloat(stats.avg_duration) || 0,
        reasonBreakdown,
        oldestEntry: stats.oldest_entry ? new Date(stats.oldest_entry) : undefined,
        newestEntry: stats.newest_entry ? new Date(stats.newest_entry) : undefined
      };

    } catch (error) {
      logger.error('Failed to get DLQ stats', {
        error: error instanceof Error ? error.message : String(error),
        component: 'dead-letter-queue'
      });

      throw error;
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Ensure table exists (async, non-blocking).
   */
  private async ensureTableExistsAsync(): Promise<void> {
    try {
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ${this.TABLE_NAME} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          task_id VARCHAR(255) NOT NULL,
          reason VARCHAR(255) NOT NULL,
          attempts INTEGER NOT NULL,
          duration INTEGER NOT NULL,
          errors JSONB NOT NULL,
          patterns JSONB NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL,
          first_attempt_time TIMESTAMPTZ NOT NULL,
          last_attempt_time TIMESTAMPTZ NOT NULL,
          metadata JSONB,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          resolution TEXT,
          resolved_by VARCHAR(255),
          resolved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_dlq_status
          ON ${this.TABLE_NAME}(status);

        CREATE INDEX IF NOT EXISTS idx_dlq_reason
          ON ${this.TABLE_NAME}(reason);

        CREATE INDEX IF NOT EXISTS idx_dlq_timestamp
          ON ${this.TABLE_NAME}(timestamp DESC);

        CREATE INDEX IF NOT EXISTS idx_dlq_task_id
          ON ${this.TABLE_NAME}(task_id);
      `;

      await this.pool.query(createTableQuery);

      logger.debug('DLQ table ensured', {
        tableName: this.TABLE_NAME,
        component: 'dead-letter-queue'
      });

    } catch (error) {
      logger.error('Failed to ensure DLQ table exists', {
        error: error instanceof Error ? error.message : String(error),
        component: 'dead-letter-queue'
      });
    }
  }

  /**
   * Map database row to StoredDeadLetterEntry.
   */
  private mapRowToEntry(row: any): StoredDeadLetterEntry {
    return {
      id: row.id,
      taskId: row.task_id,
      reason: row.reason,
      attempts: row.attempts,
      duration: row.duration,
      errors: JSON.parse(row.errors),
      patterns: JSON.parse(row.patterns),
      timestamp: new Date(row.timestamp),
      firstAttemptTime: new Date(row.first_attempt_time),
      lastAttemptTime: new Date(row.last_attempt_time),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      status: row.status,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
      resolvedBy: row.resolved_by,
      resolution: row.resolution,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
