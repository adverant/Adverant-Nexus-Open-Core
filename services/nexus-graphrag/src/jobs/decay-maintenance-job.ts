/**
 * Decay Maintenance Job for Nexus Memory Lens
 *
 * Background worker that periodically updates stability and retrievability
 * scores for all episodes using BullMQ.
 *
 * Features:
 * - Runs hourly (configurable)
 * - Batch processing (1000 nodes per batch)
 * - Records stability history
 * - Tenant-aware processing
 */

import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import winston from 'winston';
import { RelevanceEngine } from '../relevance/relevance-engine';
import { EnhancedTenantContext } from '../middleware/tenant-context';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'decay-maintenance-job' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Job data for decay maintenance
 */
export interface DecayMaintenanceJobData {
  /** Job ID */
  jobId: string;
  /** Tenant context */
  tenantContext: EnhancedTenantContext;
  /** When this job was scheduled */
  scheduledAt: string;
}

/**
 * Job result
 */
export interface DecayMaintenanceJobResult {
  /** Job ID */
  jobId: string;
  /** Number of nodes updated */
  nodesUpdated: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Timestamp */
  completedAt: string;
  /** Any errors encountered */
  errors?: string[];
}

/**
 * Decay Maintenance Job Configuration
 */
export interface DecayMaintenanceJobConfig {
  /** Redis connection */
  redis: Redis;
  /** Relevance engine instance */
  relevanceEngine: RelevanceEngine;
  /** Job interval in milliseconds (default: 3600000 = 1 hour) */
  intervalMs?: number;
  /** Enable automatic scheduling */
  autoSchedule?: boolean;
}

/**
 * Decay Maintenance Job Queue
 */
export class DecayMaintenanceJobQueue {
  private queue: Queue<DecayMaintenanceJobData>;
  private worker: Worker<DecayMaintenanceJobData, DecayMaintenanceJobResult>;
  private redis: Redis;
  private relevanceEngine: RelevanceEngine;
  private intervalMs: number;
  private autoSchedule: boolean;
  private schedulerInterval?: NodeJS.Timeout;

  constructor(config: DecayMaintenanceJobConfig) {
    // Clone Redis connection for BullMQ
    this.redis = config.redis.duplicate({
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    this.relevanceEngine = config.relevanceEngine;
    this.intervalMs = config.intervalMs || 3600000; // 1 hour default
    this.autoSchedule = config.autoSchedule !== false;

    // Create queue
    this.queue = new Queue<DecayMaintenanceJobData>('decay-maintenance', {
      connection: this.redis,
      defaultJobOptions: {
        removeOnComplete: {
          age: 86400, // Keep for 24 hours
          count: 100
        },
        removeOnFail: {
          age: 172800, // Keep failures for 48 hours
          count: 50
        },
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 60000 // Start with 1 minute
        }
      }
    });

    // Create worker
    this.worker = new Worker<DecayMaintenanceJobData, DecayMaintenanceJobResult>(
      'decay-maintenance',
      async (job) => this.processJob(job),
      {
        connection: this.redis,
        concurrency: 1 // Only one maintenance job at a time
      }
    );

    // Setup event handlers
    this.setupEventHandlers();

    logger.info('DecayMaintenanceJobQueue initialized', {
      intervalMs: this.intervalMs,
      autoSchedule: this.autoSchedule
    });

    // Start auto-scheduling if enabled
    if (this.autoSchedule) {
      this.startScheduler();
    }
  }

  /**
   * Schedule a decay maintenance job
   *
   * @param tenantContext - Tenant context to process
   * @returns Job ID
   */
  async scheduleJob(tenantContext: EnhancedTenantContext): Promise<string> {
    const jobId = `decay-${tenantContext.tenantId}-${Date.now()}`;

    const jobData: DecayMaintenanceJobData = {
      jobId,
      tenantContext,
      scheduledAt: new Date().toISOString()
    };

    await this.queue.add(`maintenance-${jobId}`, jobData, {
      jobId
    });

    logger.info('Decay maintenance job scheduled', {
      jobId,
      tenantId: tenantContext.tenantId
    });

    return jobId;
  }

  /**
   * Process a decay maintenance job
   *
   * @private
   */
  private async processJob(
    job: Job<DecayMaintenanceJobData>
  ): Promise<DecayMaintenanceJobResult> {
    const { jobId, tenantContext } = job.data;
    const startTime = Date.now();
    const errors: string[] = [];

    logger.info('Processing decay maintenance job', {
      jobId,
      tenantId: tenantContext.tenantId
    });

    try {
      // Update progress
      await job.updateProgress(10);

      // Run batch stability update
      const nodesUpdated = await this.relevanceEngine.batchUpdateStability(tenantContext);

      await job.updateProgress(90);

      const result: DecayMaintenanceJobResult = {
        jobId,
        nodesUpdated,
        processingTimeMs: Date.now() - startTime,
        completedAt: new Date().toISOString(),
        errors: errors.length > 0 ? errors : undefined
      };

      await job.updateProgress(100);

      logger.info('Decay maintenance job completed', {
        ...result
      });

      return result;
    } catch (error) {
      logger.error('Decay maintenance job failed', {
        jobId,
        error: (error as Error).message,
        stack: (error as Error).stack
      });

      errors.push((error as Error).message);

      throw error;
    }
  }

  /**
   * Start automatic scheduler
   *
   * Schedules jobs at regular intervals for all active tenants.
   *
   * @private
   */
  private startScheduler(): void {
    // Schedule initial job immediately
    this.scheduleDefaultJob();

    // Schedule recurring jobs
    this.schedulerInterval = setInterval(() => {
      this.scheduleDefaultJob();
    }, this.intervalMs);

    logger.info('Decay maintenance scheduler started', {
      intervalMs: this.intervalMs
    });
  }

  /**
   * Stop automatic scheduler
   */
  stopScheduler(): void {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = undefined;
      logger.info('Decay maintenance scheduler stopped');
    }
  }

  /**
   * Schedule job for default/system tenant
   *
   * @private
   */
  private async scheduleDefaultJob(): Promise<void> {
    try {
      // Create default tenant context
      const tenantContext: EnhancedTenantContext = {
        companyId: 'system',
        appId: 'graphrag',
        tenantId: 'system:graphrag',
        userId: 'decay-maintenance',
        requestId: `decay-${Date.now()}`,
        timestamp: new Date().toISOString(),
        source: 'system'
      };

      await this.scheduleJob(tenantContext);
    } catch (error) {
      logger.error('Failed to schedule default maintenance job', {
        error: (error as Error).message
      });
    }
  }

  /**
   * Get job status
   *
   * @param jobId - Job ID
   * @returns Job status
   */
  async getJobStatus(jobId: string): Promise<any> {
    const job = await this.queue.getJob(jobId);

    if (!job) {
      return null;
    }

    const state = await job.getState();
    const progress = job.progress;

    return {
      jobId,
      state,
      progress,
      data: job.data,
      result: job.returnvalue,
      failedReason: job.failedReason,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn
    };
  }

  /**
   * Setup event handlers
   *
   * @private
   */
  private setupEventHandlers(): void {
    this.worker.on('completed', (job) => {
      logger.info('Decay maintenance job completed', {
        jobId: job.id,
        result: job.returnvalue
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('Decay maintenance job failed', {
        jobId: job?.id,
        error: error.message,
        stack: error.stack
      });
    });

    this.worker.on('error', (error) => {
      logger.error('Decay maintenance worker error', {
        error: error.message
      });
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down DecayMaintenanceJobQueue...');

    this.stopScheduler();
    await this.worker.close();
    await this.queue.close();

    logger.info('DecayMaintenanceJobQueue shutdown complete');
  }
}

/**
 * Create and start decay maintenance job queue
 *
 * @param config - Configuration
 * @returns DecayMaintenanceJobQueue instance
 */
export function createDecayMaintenanceQueue(
  config: DecayMaintenanceJobConfig
): DecayMaintenanceJobQueue {
  return new DecayMaintenanceJobQueue(config);
}
