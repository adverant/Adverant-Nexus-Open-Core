/**
 * Job Repository - Unified abstraction for job management
 *
 * Implements Repository Pattern to provide single source of truth for job data.
 * Uses PostgreSQL as authoritative data store and RedisQueue for job submission.
 *
 * Design Decisions:
 * - PostgreSQL: All job queries (authoritative state)
 * - RedisQueue: Job submission only (worker communication)
 * - Atomic operations: Job creation writes to both systems
 *
 * This eliminates the BullMQ inconsistency by using a single data source.
 */

import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { RedisQueue } from '../queue/redis-queue';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Job data transfer object
 */
export interface Job {
  id: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  fileSize: number | null;
  status: JobStatus;
  confidence: number | null;
  processingTimeMs: number | null;
  documentDnaId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  ocrTierUsed: string | null;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/**
 * Job submission request
 */
export interface SubmitJobRequest {
  userId: string;
  filename: string;
  mimeType?: string;
  fileSize?: number;
  fileBuffer?: string; // base64
  fileUrl?: string;
  metadata?: Record<string, any>;
}

/**
 * Job filter for listing
 */
export interface JobFilter {
  userId?: string;
  status?: JobStatus;
  limit?: number;
  offset?: number;
}

/**
 * Queue statistics
 */
export interface QueueStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
}

/**
 * Repository interface for job management
 */
export interface IJobRepository {
  submitJob(request: SubmitJobRequest): Promise<string>;
  getJobById(jobId: string): Promise<Job | null>;
  cancelJob(jobId: string): Promise<boolean>;
  listJobs(filter: JobFilter): Promise<Job[]>;
  getQueueStats(): Promise<QueueStats>;
}

/**
 * PostgreSQL + Redis implementation of job repository
 *
 * Single Source of Truth: PostgreSQL
 * Queue Communication: RedisQueue
 */
export class PostgreSQLJobRepository implements IJobRepository {
  private pool: Pool;
  private redis: Redis;
  private queue: RedisQueue;

  constructor(pool: Pool, redis: Redis) {
    this.pool = pool;
    this.redis = redis;
    this.queue = new RedisQueue(redis, 'fileprocess:jobs');
  }

  /**
   * Submit a new job for processing
   *
   * Atomic Operation:
   * 1. INSERT into PostgreSQL (authoritative record)
   * 2. LPUSH to Redis queue (worker notification)
   *
   * If Redis fails, job still exists in DB but won't be processed.
   * Worker can poll PostgreSQL for stuck jobs as fallback.
   */
  async submitJob(request: SubmitJobRequest): Promise<string> {
    const jobId = uuidv4();
    const now = new Date();

    try {
      // Step 1: Insert into PostgreSQL (authoritative)
      const query = `
        INSERT INTO fileprocess.processing_jobs (
          id, user_id, filename, mime_type, file_size,
          status, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
        RETURNING id
      `;

      const values = [
        jobId,
        request.userId,
        request.filename,
        request.mimeType || null,
        request.fileSize || null,
        'queued',
        JSON.stringify(request.metadata || {}),
        now,
        now,
      ];

      const result = await this.pool.query(query, values);

      if (result.rows.length === 0) {
        throw new Error('Failed to insert job into PostgreSQL');
      }

      logger.info('Job inserted into PostgreSQL', {
        jobId,
        userId: request.userId,
        filename: request.filename,
      });

      // Step 2: Enqueue to Redis (worker notification)
      try {
        await this.queue.addJob('process_document', {
          jobId,
          userId: request.userId,
          filename: request.filename,
          mimeType: request.mimeType,
          fileSize: request.fileSize,
          fileBuffer: request.fileBuffer,
          fileUrl: request.fileUrl,
          metadata: request.metadata || {},
        });

        logger.info('Job enqueued to Redis', { jobId });
      } catch (redisError) {
        // Redis failure is non-fatal - job exists in PostgreSQL
        // Worker can poll PostgreSQL for stuck jobs
        logger.error('Failed to enqueue job to Redis (job exists in PostgreSQL)', {
          jobId,
          error: redisError instanceof Error ? redisError.message : String(redisError),
        });

        // Update job status to indicate queue issue
        await this.pool.query(
          `UPDATE fileprocess.processing_jobs
           SET metadata = metadata || $1, updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify({ queueError: 'Failed to enqueue to Redis' }), jobId]
        );
      }

      return jobId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to submit job', {
        error: errorMessage,
        request,
      });
      throw new Error(`Job submission failed: ${errorMessage}`);
    }
  }

  /**
   * Get job by ID from PostgreSQL
   */
  async getJobById(jobId: string): Promise<Job | null> {
    try {
      const query = `
        SELECT
          id, user_id, filename, mime_type, file_size,
          status, confidence, processing_time_ms, document_dna_id,
          error_code, error_message, ocr_tier_used, metadata,
          created_at, updated_at
        FROM fileprocess.processing_jobs
        WHERE id = $1::uuid
      `;

      const result = await this.pool.query(query, [jobId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return this.mapRowToJob(row);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job by ID', {
        jobId,
        error: errorMessage,
      });
      throw new Error(`Failed to retrieve job: ${errorMessage}`);
    }
  }

  /**
   * Cancel a job
   *
   * Updates status to 'cancelled' in PostgreSQL.
   * If job is in Redis queue, attempts to remove it.
   */
  async cancelJob(jobId: string): Promise<boolean> {
    try {
      // Get current job status
      const job = await this.getJobById(jobId);

      if (!job) {
        logger.warn('Cannot cancel job - not found', { jobId });
        return false;
      }

      // Cannot cancel completed or failed jobs
      if (job.status === 'completed' || job.status === 'failed') {
        logger.warn('Cannot cancel job - already finished', {
          jobId,
          status: job.status,
        });
        return false;
      }

      // Update status to cancelled in PostgreSQL
      const query = `
        UPDATE fileprocess.processing_jobs
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1::uuid AND status NOT IN ('completed', 'failed')
        RETURNING id
      `;

      const result = await this.pool.query(query, [jobId]);

      if (result.rows.length === 0) {
        logger.warn('Job already finished, cannot cancel', { jobId });
        return false;
      }

      logger.info('Job cancelled successfully', { jobId });

      // Best-effort: Try to remove from Redis queue
      // This is non-critical since worker checks PostgreSQL status
      try {
        const queuedJobData = await this.redis.hget(
          'fileprocess:jobs:data',
          jobId
        );
        if (queuedJobData) {
          await this.redis.lrem('fileprocess:jobs', 1, jobId);
          await this.redis.hdel('fileprocess:jobs:data', jobId);
          logger.info('Job removed from Redis queue', { jobId });
        }
      } catch (redisError) {
        logger.warn('Failed to remove job from Redis queue (non-critical)', {
          jobId,
          error: redisError instanceof Error ? redisError.message : String(redisError),
        });
      }

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to cancel job', {
        jobId,
        error: errorMessage,
      });
      throw new Error(`Job cancellation failed: ${errorMessage}`);
    }
  }

  /**
   * List jobs with filtering
   */
  async listJobs(filter: JobFilter): Promise<Job[]> {
    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      // Build WHERE clause
      if (filter.userId) {
        conditions.push(`user_id = $${paramIndex++}`);
        values.push(filter.userId);
      }

      if (filter.status) {
        conditions.push(`status = $${paramIndex++}`);
        values.push(filter.status);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      const limit = filter.limit || 100;
      const offset = filter.offset || 0;

      const query = `
        SELECT
          id, user_id, filename, mime_type, file_size,
          status, confidence, processing_time_ms, document_dna_id,
          error_code, error_message, ocr_tier_used, metadata,
          created_at, updated_at
        FROM fileprocess.processing_jobs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;

      values.push(limit, offset);

      const result = await this.pool.query(query, values);

      return result.rows.map(row => this.mapRowToJob(row));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to list jobs', {
        filter,
        error: errorMessage,
      });
      throw new Error(`Failed to list jobs: ${errorMessage}`);
    }
  }

  /**
   * Get queue statistics from PostgreSQL
   */
  async getQueueStats(): Promise<QueueStats> {
    try {
      const query = `
        SELECT
          status,
          COUNT(*) as count
        FROM fileprocess.processing_jobs
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY status
      `;

      const result = await this.pool.query(query);

      const stats: QueueStats = {
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };

      for (const row of result.rows) {
        const status = row.status as JobStatus;
        stats[status] = parseInt(row.count, 10);
      }

      return stats;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get queue stats', {
        error: errorMessage,
      });
      throw new Error(`Failed to retrieve queue statistics: ${errorMessage}`);
    }
  }

  /**
   * Map PostgreSQL row to Job object
   */
  private mapRowToJob(row: any): Job {
    return {
      id: row.id,
      userId: row.user_id,
      filename: row.filename,
      mimeType: row.mime_type,
      fileSize: row.file_size,
      status: row.status,
      confidence: row.confidence,
      processingTimeMs: row.processing_time_ms,
      documentDnaId: row.document_dna_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      ocrTierUsed: row.ocr_tier_used,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/**
 * Singleton instance
 */
let jobRepositoryInstance: IJobRepository | null = null;

/**
 * Get or create job repository instance
 */
export function getJobRepository(pool?: Pool, redis?: Redis): IJobRepository {
  if (!jobRepositoryInstance) {
    if (!pool || !redis) {
      throw new Error('JobRepository not initialized - provide Pool and Redis instances');
    }
    jobRepositoryInstance = new PostgreSQLJobRepository(pool, redis);
  }
  return jobRepositoryInstance;
}

/**
 * Initialize job repository (call during server startup)
 */
export function initJobRepository(pool: Pool, redis: Redis): IJobRepository {
  jobRepositoryInstance = new PostgreSQLJobRepository(pool, redis);
  logger.info('JobRepository initialized');
  return jobRepositoryInstance;
}
