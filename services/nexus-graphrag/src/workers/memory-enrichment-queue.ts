/**
 * Memory Enrichment Queue
 *
 * BullMQ-based queue for background memory enrichment operations.
 * Part of the async-first architecture to achieve <200ms store latency.
 *
 * Flow:
 * 1. Store endpoint receives memory → returns immediately with UUID
 * 2. Enrichment job enqueued here → processes entities/facts in background
 * 3. Worker processes job → updates memory with enrichment data
 */

import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { logger } from '../utils/logger';

/**
 * Tenant context for multi-tenant isolation
 */
export interface TenantContext {
  companyId: string;
  appId: string;
  userId?: string;
}

/**
 * Memory enrichment job data
 */
export interface MemoryEnrichmentJob {
  /** Unique memory ID (UUID) */
  memoryId: string;

  /** Original content to enrich */
  content: string;

  /** Pre-computed embedding vector (1024 dimensions) */
  embedding: number[];

  /** Embedding model used */
  embeddingModel: string;

  /** Tenant isolation context */
  tenantContext: TenantContext;

  /** Initial triage decision (from heuristics) */
  triageDecision?: string;

  /** Timestamp when memory was stored */
  storedAt: string;

  /** Optional metadata from original request */
  metadata?: Record<string, unknown>;
}

/**
 * Enrichment result after processing
 */
export interface EnrichmentResult {
  memoryId: string;
  entities: Array<{
    name: string;
    type: string;
    confidence: number;
  }>;
  facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
  }>;
  summary?: string;
  enrichedAt: string;
  processingTimeMs: number;
}

/**
 * Queue configuration
 */
export interface QueueConfig {
  redisConnection: Redis;
  queueName?: string;
  defaultJobOptions?: {
    removeOnComplete?: number | boolean;
    removeOnFail?: number | boolean;
    attempts?: number;
    backoff?: {
      type: 'fixed' | 'exponential';
      delay: number;
    };
  };
}

// Queue instance (singleton)
let enrichmentQueue: Queue<MemoryEnrichmentJob> | null = null;
let queueEvents: QueueEvents | null = null;

/**
 * Initialize the memory enrichment queue
 */
export function initializeEnrichmentQueue(config: QueueConfig): Queue<MemoryEnrichmentJob> {
  if (enrichmentQueue) {
    logger.debug('[ENRICHMENT-QUEUE] Returning existing queue instance');
    return enrichmentQueue;
  }

  const queueName = config.queueName || 'memory-enrichment';

  enrichmentQueue = new Queue<MemoryEnrichmentJob>(queueName, {
    connection: config.redisConnection,
    defaultJobOptions: {
      removeOnComplete: config.defaultJobOptions?.removeOnComplete ?? 1000,
      removeOnFail: config.defaultJobOptions?.removeOnFail ?? 5000,
      attempts: config.defaultJobOptions?.attempts ?? 3,
      backoff: config.defaultJobOptions?.backoff ?? {
        type: 'exponential',
        delay: 1000
      }
    }
  });

  // Initialize queue events for monitoring
  queueEvents = new QueueEvents(queueName, {
    connection: config.redisConnection.duplicate()
  });

  // Log queue events
  queueEvents.on('completed', ({ jobId }) => {
    logger.debug('[ENRICHMENT-QUEUE] Job completed', { jobId });
  });

  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.warn('[ENRICHMENT-QUEUE] Job failed', { jobId, failedReason });
  });

  queueEvents.on('stalled', ({ jobId }) => {
    logger.warn('[ENRICHMENT-QUEUE] Job stalled', { jobId });
  });

  logger.info('[ENRICHMENT-QUEUE] Queue initialized', { queueName });

  return enrichmentQueue;
}

/**
 * Get the enrichment queue instance
 */
export function getEnrichmentQueue(): Queue<MemoryEnrichmentJob> | null {
  return enrichmentQueue;
}

/**
 * Enqueue a memory for background enrichment
 *
 * @param job - Memory enrichment job data
 * @returns Job ID for tracking
 */
export async function enqueueEnrichment(job: MemoryEnrichmentJob): Promise<string> {
  if (!enrichmentQueue) {
    throw new Error('Enrichment queue not initialized. Call initializeEnrichmentQueue first.');
  }

  const startTime = Date.now();

  try {
    const bullJob = await enrichmentQueue.add('enrich', job, {
      jobId: job.memoryId, // Use memory ID as job ID for easy lookup
      priority: 1 // Normal priority
    });

    const enqueuedIn = Date.now() - startTime;

    logger.debug('[ENRICHMENT-QUEUE] Job enqueued', {
      jobId: bullJob.id,
      memoryId: job.memoryId,
      contentLength: job.content.length,
      tenantContext: job.tenantContext,
      enqueuedInMs: enqueuedIn
    });

    return bullJob.id!;
  } catch (error: any) {
    logger.error('[ENRICHMENT-QUEUE] Failed to enqueue job', {
      memoryId: job.memoryId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get job status by memory ID
 */
export async function getEnrichmentStatus(memoryId: string): Promise<{
  status: 'pending' | 'active' | 'completed' | 'failed' | 'not_found';
  progress?: number;
  result?: EnrichmentResult;
  failedReason?: string;
}> {
  if (!enrichmentQueue) {
    return { status: 'not_found' };
  }

  try {
    const job = await enrichmentQueue.getJob(memoryId);

    if (!job) {
      return { status: 'not_found' };
    }

    const state = await job.getState();

    switch (state) {
      case 'waiting':
      case 'delayed':
        return { status: 'pending' };
      case 'active':
        return {
          status: 'active',
          progress: job.progress as number || 0
        };
      case 'completed':
        return {
          status: 'completed',
          result: job.returnvalue as EnrichmentResult
        };
      case 'failed':
        return {
          status: 'failed',
          failedReason: job.failedReason
        };
      default:
        return { status: 'not_found' };
    }
  } catch (error: any) {
    logger.error('[ENRICHMENT-QUEUE] Failed to get job status', {
      memoryId,
      error: error.message
    });
    return { status: 'not_found' };
  }
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  if (!enrichmentQueue) {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    enrichmentQueue.getWaitingCount(),
    enrichmentQueue.getActiveCount(),
    enrichmentQueue.getCompletedCount(),
    enrichmentQueue.getFailedCount(),
    enrichmentQueue.getDelayedCount()
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Gracefully close the queue
 */
export async function closeEnrichmentQueue(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

  if (enrichmentQueue) {
    await enrichmentQueue.close();
    enrichmentQueue = null;
  }

  logger.info('[ENRICHMENT-QUEUE] Queue closed');
}
