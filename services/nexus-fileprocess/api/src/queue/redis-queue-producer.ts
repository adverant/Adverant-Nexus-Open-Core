/**
 * Redis LIST Queue Producer for FileProcessAgent
 *
 * Simple Redis LIST-based queue implementation that matches the Worker's
 * queue consumer implementation in Go.
 *
 * Queue Architecture:
 * - Redis LIST: "fileprocess:jobs" (job IDs)
 * - Redis HASH: "fileprocess:jobs:data" (job payloads)
 * - Redis SET: "fileprocess:jobs:processing" (currently processing)
 * - Redis SET: "fileprocess:jobs:completed" (completed jobs)
 * - Redis SET: "fileprocess:jobs:failed" (failed jobs)
 * - Redis HASH: "fileprocess:jobs:results" (job results)
 */

import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ProcessJobData {
  jobId: string;
  userId: string;
  filename: string;
  mimeType?: string;
  fileSize?: number;
  fileUrl?: string;
  fileBuffer?: Buffer;
  metadata?: Record<string, unknown>;
}

export interface RedisJobEnvelope {
  id: string; // Redis queue ID (same as jobId for simplicity)
  type: string;
  payload: ProcessJobData;
  createdAt: string;
  attempts: number;
  maxRetries: number;
}

/**
 * Redis LIST-based queue producer matching Worker's implementation
 * FIXED: Changed queue name from 'fileprocess-jobs' to 'fileprocess:jobs' to match Worker (Go)
 */
export class RedisListQueueProducer {
  private client: IORedis;
  private readonly queueName = 'fileprocess:jobs';

  constructor() {
    // Parse Redis URL to extract connection details
    const redisUrl = new URL(config.redisUrl);

    // Create Redis connection
    this.client = new IORedis({
      host: redisUrl.hostname,
      port: parseInt(redisUrl.port || '6379', 10),
      password: redisUrl.password || undefined,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 10000);
        logger.warn(`Redis reconnection attempt ${times}, retrying in ${delay}ms`);
        return delay;
      },
    });

    // Handle Redis errors
    this.client.on('error', (error) => {
      logger.error('Redis client error', { error: error.message });
    });

    // Handle connection events
    this.client.on('connect', () => {
      logger.info('Redis client connected', { queueName: this.queueName });
    });

    logger.info('RedisListQueueProducer initialized', {
      queueName: this.queueName,
      redisUrl: `${redisUrl.hostname}:${redisUrl.port}`,
    });
  }

  /**
   * Add a job to the queue
   * Returns the job ID that can be used to track the job
   */
  async addJob(type: string, data: ProcessJobData): Promise<string> {
    const jobId = uuidv4();
    const job: RedisJobEnvelope = {
      id: jobId,
      type,
      payload: {
        jobId, // Use the queue job ID as the application job ID
        userId: data.userId,
        filename: data.filename,
        mimeType: data.mimeType,
        fileSize: data.fileSize,
        fileUrl: data.fileUrl,
        fileBuffer: data.fileBuffer,
        metadata: data.metadata,
      },
      createdAt: new Date().toISOString(),
      attempts: 0,
      maxRetries: 3,
    };

    try {
      // Convert Buffer to base64 for JSON serialization
      const jobForStorage = {
        ...job,
        payload: {
          ...job.payload,
          fileBuffer: job.payload.fileBuffer
            ? job.payload.fileBuffer.toString('base64')
            : undefined,
        },
      };

      // Store job data in hash
      await this.client.hset(
        `${this.queueName}:data`,
        jobId,
        JSON.stringify(jobForStorage)
      );

      // Add job ID to queue (LPUSH adds to head, Worker uses RPOPLPUSH from tail)
      await this.client.lpush(this.queueName, jobId);

      logger.info('Job added to Redis LIST queue', {
        jobId,
        type,
        filename: data.filename,
        fileSize: data.fileSize,
      });

      return jobId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to add job to Redis LIST queue', {
        jobId,
        error: errorMessage,
      });
      throw new Error(`Failed to queue job: ${errorMessage}`);
    }
  }

  /**
   * Get job data by ID
   */
  async getJob(jobId: string): Promise<RedisJobEnvelope | null> {
    try {
      const jobData = await this.client.hget(`${this.queueName}:data`, jobId);

      if (!jobData) {
        return null;
      }

      const job = JSON.parse(jobData) as RedisJobEnvelope;

      // Convert base64 back to Buffer if present
      if (job.payload.fileBuffer && typeof job.payload.fileBuffer === 'string') {
        job.payload.fileBuffer = Buffer.from(job.payload.fileBuffer, 'base64');
      }

      return job;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job from Redis', { jobId, error: errorMessage });
      return null;
    }
  }

  /**
   * Get job result by ID
   */
  async getJobResult(jobId: string): Promise<any | null> {
    try {
      const resultData = await this.client.hget(`${this.queueName}:results`, jobId);

      if (!resultData) {
        return null;
      }

      return JSON.parse(resultData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job result from Redis', { jobId, error: errorMessage });
      return null;
    }
  }

  /**
   * Get job state by ID
   */
  async getJobState(jobId: string): Promise<string> {
    try {
      // Check in different sets to determine state
      const [isProcessing, isCompleted, isFailed] = await Promise.all([
        this.client.sismember(`${this.queueName}:processing`, jobId),
        this.client.sismember(`${this.queueName}:completed`, jobId),
        this.client.sismember(`${this.queueName}:failed`, jobId),
      ]);

      if (isCompleted) return 'completed';
      if (isFailed) return 'failed';
      if (isProcessing) return 'processing';

      // Check if still in queue
      const queueLength = await this.client.llen(this.queueName);
      if (queueLength > 0) {
        const queueJobs = await this.client.lrange(this.queueName, 0, -1);
        if (queueJobs.includes(jobId)) {
          return 'queued';
        }
      }

      return 'unknown';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job state from Redis', { jobId, error: errorMessage });
      return 'unknown';
    }
  }

  /**
   * Cancel a job by ID
   */
  async cancelJob(jobId: string): Promise<boolean> {
    try {
      // Remove from queue if still queued
      const removed = await this.client.lrem(this.queueName, 0, jobId);

      // Remove from processing set if processing
      await this.client.srem(`${this.queueName}:processing`, jobId);

      // Add to failed set
      await this.client.sadd(`${this.queueName}:failed`, jobId);

      // Store cancellation reason
      await this.client.hset(
        `${this.queueName}:errors`,
        jobId,
        JSON.stringify({ error: 'Job cancelled by user', cancelledAt: new Date().toISOString() })
      );

      logger.info('Job cancelled', { jobId });

      return removed > 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to cancel job', { jobId, error: errorMessage });
      return false;
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        this.client.llen(this.queueName),
        this.client.scard(`${this.queueName}:processing`),
        this.client.scard(`${this.queueName}:completed`),
        this.client.scard(`${this.queueName}:failed`),
      ]);

      return { waiting, active, completed, failed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get queue stats', { error: errorMessage });
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
  }

  /**
   * Get jobs by state with pagination
   */
  async getJobsByState(
    state: 'waiting' | 'active' | 'completed' | 'failed',
    start: number = 0,
    end: number = 100
  ): Promise<RedisJobEnvelope[]> {
    try {
      let jobIds: string[] = [];

      switch (state) {
        case 'waiting':
          jobIds = await this.client.lrange(this.queueName, start, end - 1);
          break;
        case 'active':
        case 'completed':
        case 'failed':
          const setKey = `${this.queueName}:${state === 'active' ? 'processing' : state}`;
          const allIds = await this.client.smembers(setKey);
          jobIds = allIds.slice(start, end);
          break;
      }

      // Fetch job data for all IDs
      const jobs = await Promise.all(
        jobIds.map((jobId) => this.getJob(jobId))
      );

      return jobs.filter((job): job is RedisJobEnvelope => job !== null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get jobs by state', { state, error: errorMessage });
      return [];
    }
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.client.quit();
    logger.info('RedisListQueueProducer closed');
  }
}

// Singleton instance
let queueProducer: RedisListQueueProducer | null = null;

/**
 * Get or create queue producer instance
 */
export function getQueueProducer(): RedisListQueueProducer {
  if (!queueProducer) {
    queueProducer = new RedisListQueueProducer();
  }
  return queueProducer;
}
