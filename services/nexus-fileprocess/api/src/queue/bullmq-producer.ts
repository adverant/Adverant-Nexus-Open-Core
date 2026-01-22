/**
 * BullMQ Producer for FileProcessAgent
 *
 * Manages the job queue for document processing tasks.
 * Uses Redis for reliable, distributed queue management.
 *
 * Queue Architecture:
 * - Single queue: "fileprocess:jobs"
 * - Priority support: 1-10 (10 = highest)
 * - Job lifecycle: pending → queued → processing → completed/failed
 * - Retry logic: 3 retries with exponential backoff
 * - Dead letter queue for permanently failed jobs
 */

import { Queue, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';
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

/**
 * BullMQ Producer for managing document processing jobs
 * FIXED: Changed queue name from 'fileprocess-jobs' to 'fileprocess:jobs' to match Worker (Go)
 */
export class FileProcessQueueProducer {
  private queue: Queue<ProcessJobData>;
  private queueEvents: QueueEvents;
  private connection: IORedis;
  private readonly queueName = 'fileprocess:jobs';

  constructor() {
    // Parse Redis URL to extract connection details
    const redisUrl = new URL(config.redisUrl);

    // Create Redis connection with proper configuration
    this.connection = new IORedis({
      host: redisUrl.hostname,
      port: parseInt(redisUrl.port || '6379', 10),
      password: redisUrl.password || undefined,
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 1000, 10000);
        logger.warn(`Redis reconnection attempt ${times}, retrying in ${delay}ms`);
        return delay;
      },
    });

    // Create BullMQ queue
    this.queue = new Queue<ProcessJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // Start with 5 seconds
        },
        removeOnComplete: {
          age: 86400, // Keep completed jobs for 24 hours
          count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: {
          age: 604800, // Keep failed jobs for 7 days
          count: 5000, // Keep last 5000 failed jobs
        },
      },
    });

    // Create queue events for monitoring
    this.queueEvents = new QueueEvents(this.queueName, {
      connection: this.connection.duplicate(),
    });

    // Set up event listeners
    this.setupEventListeners();

    logger.info('FileProcessQueueProducer initialized', {
      queueName: this.queueName,
      redisUrl: config.redisUrl
    });
  }

  /**
   * Set up event listeners for queue monitoring
   */
  private setupEventListeners(): void {
    this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      logger.info('Job completed', { jobId, returnvalue });
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error('Job failed', { jobId, failedReason });
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      logger.debug('Job progress', { jobId, progress: data });
    });

    this.queueEvents.on('stalled', ({ jobId }) => {
      logger.warn('Job stalled', { jobId });
    });

    this.connection.on('error', (error) => {
      logger.error('Redis connection error', { error: error.message });
    });

    this.connection.on('ready', () => {
      logger.info('Redis connection ready');
    });
  }

  /**
   * Add a new processing job to the queue
   *
   * @param jobData - Job data including file information
   * @param priority - Job priority (1-10, 10 = highest)
   * @returns BullMQ Job instance
   */
  async addJob(
    jobData: ProcessJobData,
    priority: number = 5
  ): Promise<Job<ProcessJobData>> {
    try {
      logger.debug('Adding job to queue', {
        jobId: jobData.jobId,
        filename: jobData.filename,
        priority
      });

      const job = await this.queue.add(
        'process-document',
        jobData,
        {
          jobId: jobData.jobId,
          priority,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
        }
      );

      logger.info('Job added to queue', {
        jobId: job.id,
        filename: jobData.filename,
        queuePosition: await job.getState()
      });

      return job;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to add job to queue', {
        jobId: jobData.jobId,
        error: errorMessage
      });
      throw new Error(`Failed to add job to queue: ${errorMessage}`);
    }
  }

  /**
   * Get job status and details
   *
   * @param jobId - Job ID to query
   * @returns Job instance or null if not found
   */
  async getJob(jobId: string): Promise<Job<ProcessJobData> | null> {
    try {
      const job = await this.queue.getJob(jobId);
      return job || null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job', { jobId, error: errorMessage });
      throw new Error(`Failed to get job: ${errorMessage}`);
    }
  }

  /**
   * Get job state (waiting, active, completed, failed, etc.)
   *
   * @param jobId - Job ID to query
   * @returns Job state or null if not found
   */
  async getJobState(jobId: string): Promise<string | null> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) return null;

      const state = await job.getState();
      return state;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get job state', { jobId, error: errorMessage });
      return null;
    }
  }

  /**
   * Cancel a job
   *
   * @param jobId - Job ID to cancel
   * @returns True if cancelled, false if job not found
   */
  async cancelJob(jobId: string): Promise<boolean> {
    try {
      const job = await this.queue.getJob(jobId);
      if (!job) {
        logger.warn('Cannot cancel job - not found', { jobId });
        return false;
      }

      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        logger.warn('Cannot cancel job - already finished', { jobId, state });
        return false;
      }

      await job.remove();
      logger.info('Job cancelled', { jobId });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to cancel job', { jobId, error: errorMessage });
      throw new Error(`Failed to cancel job: ${errorMessage}`);
    }
  }

  /**
   * Get queue statistics
   *
   * @returns Queue statistics (waiting, active, completed, failed, delayed)
   */
  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        this.queue.getWaitingCount(),
        this.queue.getActiveCount(),
        this.queue.getCompletedCount(),
        this.queue.getFailedCount(),
        this.queue.getDelayedCount(),
      ]);

      return { waiting, active, completed, failed, delayed };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get queue stats', { error: errorMessage });
      throw new Error(`Failed to get queue stats: ${errorMessage}`);
    }
  }

  /**
   * Get all jobs in a specific state
   *
   * @param state - Job state to filter by
   * @param start - Pagination start (default: 0)
   * @param end - Pagination end (default: 100)
   * @returns Array of jobs
   */
  async getJobsByState(
    state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed',
    start: number = 0,
    end: number = 100
  ): Promise<Job<ProcessJobData>[]> {
    try {
      let jobs: Job<ProcessJobData>[] = [];

      switch (state) {
        case 'waiting':
          jobs = await this.queue.getWaiting(start, end);
          break;
        case 'active':
          jobs = await this.queue.getActive(start, end);
          break;
        case 'completed':
          jobs = await this.queue.getCompleted(start, end);
          break;
        case 'failed':
          jobs = await this.queue.getFailed(start, end);
          break;
        case 'delayed':
          jobs = await this.queue.getDelayed(start, end);
          break;
      }

      return jobs;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get jobs by state', { state, error: errorMessage });
      throw new Error(`Failed to get jobs by state: ${errorMessage}`);
    }
  }

  /**
   * Clean old jobs from the queue
   *
   * @param grace - Grace period in milliseconds (jobs older than this will be cleaned)
   * @param limit - Maximum number of jobs to clean
   * @param type - Job type to clean (completed or failed)
   */
  async cleanOldJobs(
    grace: number = 86400000, // 24 hours
    limit: number = 1000,
    type: 'completed' | 'failed' = 'completed'
  ): Promise<string[]> {
    try {
      logger.info('Cleaning old jobs', { grace, limit, type });

      const jobs = await this.queue.clean(grace, limit, type);

      logger.info('Old jobs cleaned', { count: jobs.length, type });
      return jobs;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to clean old jobs', { error: errorMessage });
      throw new Error(`Failed to clean old jobs: ${errorMessage}`);
    }
  }

  /**
   * Pause the queue (stop processing new jobs)
   */
  async pause(): Promise<void> {
    try {
      await this.queue.pause();
      logger.info('Queue paused');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to pause queue', { error: errorMessage });
      throw new Error(`Failed to pause queue: ${errorMessage}`);
    }
  }

  /**
   * Resume the queue (start processing jobs again)
   */
  async resume(): Promise<void> {
    try {
      await this.queue.resume();
      logger.info('Queue resumed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to resume queue', { error: errorMessage });
      throw new Error(`Failed to resume queue: ${errorMessage}`);
    }
  }

  /**
   * Check if queue is paused
   */
  async isPaused(): Promise<boolean> {
    try {
      return await this.queue.isPaused();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to check if queue is paused', { error: errorMessage });
      throw new Error(`Failed to check if queue is paused: ${errorMessage}`);
    }
  }

  /**
   * Close the queue and clean up resources
   */
  async close(): Promise<void> {
    try {
      await this.queueEvents.close();
      await this.queue.close();
      await this.connection.quit();
      logger.info('FileProcessQueueProducer closed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to close queue producer', { error: errorMessage });
      throw new Error(`Failed to close queue producer: ${errorMessage}`);
    }
  }
}

// Singleton instance
let queueProducerInstance: FileProcessQueueProducer | null = null;

/**
 * Get or create the singleton queue producer instance
 */
export function getQueueProducer(): FileProcessQueueProducer {
  if (!queueProducerInstance) {
    queueProducerInstance = new FileProcessQueueProducer();
  }
  return queueProducerInstance;
}
