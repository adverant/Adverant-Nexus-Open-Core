/**
 * Ingestion Job Queue Infrastructure
 *
 * Manages asynchronous document ingestion from URLs using BullMQ.
 * Provides:
 * - Persistent job storage with Redis
 * - Concurrent processing with backpressure
 * - Progress tracking and WebSocket event emission
 * - Retry logic with exponential backoff
 * - Job cancellation and status monitoring
 *
 * Architecture:
 * - Queue: Stores pending jobs
 * - Worker: Processes jobs concurrently
 * - Events: Emits progress updates via WebSocket
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import PQueue from 'p-queue';
import { v4 as uuidv4 } from 'uuid';
import {
  ContentProviderRegistry,
  FileDescriptor,
} from '../providers/content-provider.interface.js';
import { logger } from '../utils/logger.js';
import axios from 'axios';
import { GraphRAGStorageEngine } from '../storage/storage-engine.js';

/**
 * Ingestion job data
 */
export interface IngestionJobData {
  /** Unique job ID */
  jobId: string;

  /** Files to ingest */
  files: FileDescriptor[];

  /** Ingestion options */
  options: IngestionOptions;

  /** User ID for tracking */
  userId?: string;

  /** Session ID for WebSocket room */
  sessionId?: string;
}

/**
 * Ingestion options
 */
export interface IngestionOptions {
  /** Maximum concurrent downloads (default: 5) */
  maxConcurrency?: number;

  /** Timeout per file in milliseconds (default: 60000) */
  timeout?: number;

  /** Whether to continue on errors (default: true) */
  continueOnError?: boolean;

  /** Custom metadata to attach to documents */
  metadata?: Record<string, any>;

  /** WebSocket server URL for progress events */
  websocketServerUrl?: string;
}

/**
 * Ingestion job result
 */
export interface IngestionJobResult {
  /** Job ID */
  jobId: string;

  /** Total files to process */
  totalFiles: number;

  /** Files successfully ingested */
  successCount: number;

  /** Files that failed */
  failureCount: number;

  /** Files skipped */
  skippedCount: number;

  /** Processing time in milliseconds */
  processingTimeMs: number;

  /** Detailed results per file */
  fileResults: FileIngestionResult[];

  /** Overall status */
  status: 'completed' | 'partial' | 'failed';
}

/**
 * Result for a single file ingestion
 */
export interface FileIngestionResult {
  /** File descriptor */
  file: FileDescriptor;

  /** Status */
  status: 'success' | 'failure' | 'skipped';

  /** Document ID if successful */
  documentId?: string;

  /** Error message if failed */
  error?: string;

  /** Processing time in milliseconds */
  processingTimeMs?: number;
}

/**
 * Job progress event
 */
export interface JobProgressEvent {
  /** Job ID */
  jobId: string;

  /** Current progress percentage (0-100) */
  progress: number;

  /** Files processed so far */
  filesProcessed: number;

  /** Total files */
  totalFiles: number;

  /** Current file being processed */
  currentFile?: string;

  /** Success count */
  successCount: number;

  /** Failure count */
  failureCount: number;

  /** Timestamp */
  timestamp: string;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: Required<Omit<IngestionOptions, 'metadata' | 'websocketServerUrl'>> = {
  maxConcurrency: 5,
  timeout: 60000,
  continueOnError: true
};

/**
 * Ingestion Job Queue Manager
 */
export class IngestionJobQueue {
  private queue: Queue<IngestionJobData>;
  private worker: Worker<IngestionJobData, IngestionJobResult>;
  private queueEvents: QueueEvents;
  private redis: Redis;
  private providerRegistry: ContentProviderRegistry;
  private storageEngine: GraphRAGStorageEngine;

  constructor(
    redisConnection: Redis,
    providerRegistry: ContentProviderRegistry,
    storageEngine: GraphRAGStorageEngine
  ) {
    // BullMQ requires maxRetriesPerRequest to be null
    // Clone the Redis connection with proper options for BullMQ
    this.redis = redisConnection.duplicate({
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    this.providerRegistry = providerRegistry;
    this.storageEngine = storageEngine;

    // Create queue
    this.queue = new Queue<IngestionJobData>('document-ingestion', {
      connection: this.redis,
      defaultJobOptions: {
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 100
        },
        removeOnFail: {
          age: 86400, // Keep failed jobs for 24 hours
          count: 50
        },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      }
    });

    // Create worker
    this.worker = new Worker<IngestionJobData, IngestionJobResult>(
      'document-ingestion',
      async (job) => this.processJob(job),
      {
        connection: this.redis,
        concurrency: 3, // Process up to 3 jobs concurrently
        limiter: {
          max: 10, // Max 10 jobs per duration
          duration: 60000 // 1 minute
        }
      }
    );

    // Create queue events
    this.queueEvents = new QueueEvents('document-ingestion', {
      connection: this.redis
    });

    // Setup event handlers
    this.setupEventHandlers();

    logger.info('IngestionJobQueue initialized');
  }

  /**
   * Add ingestion job to queue
   */
  async addJob(
    files: FileDescriptor[],
    options: IngestionOptions = {}
  ): Promise<string> {
    const jobId = uuidv4();

    const jobData: IngestionJobData = {
      jobId,
      files,
      options: { ...DEFAULT_OPTIONS, ...options }
    };

    await this.queue.add(`ingestion-${jobId}`, jobData, {
      jobId
    });

    logger.info('Ingestion job added to queue', {
      jobId,
      fileCount: files.length,
      options
    });

    return jobId;
  }

  /**
   * Get job status
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
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);

    if (!job) {
      return false;
    }

    const state = await job.getState();

    // Can only cancel waiting or delayed jobs
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
      logger.info('Job cancelled', { jobId });
      return true;
    }

    // For active jobs, mark as failed
    if (state === 'active') {
      await job.moveToFailed(new Error('Job cancelled by user'), '0');
      logger.info('Active job marked as failed', { jobId });
      return true;
    }

    return false;
  }

  /**
   * Process a job
   */
  private async processJob(job: Job<IngestionJobData>): Promise<IngestionJobResult> {
    const { jobId, files, options } = job.data;
    const startTime = Date.now();

    logger.info('Processing ingestion job', {
      jobId,
      fileCount: files.length
    });

    // Initialize result
    const result: IngestionJobResult = {
      jobId,
      totalFiles: files.length,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      processingTimeMs: 0,
      fileResults: [],
      status: 'completed'
    };

    // Create processing queue with concurrency limit
    const processingQueue = new PQueue({
      concurrency: options.maxConcurrency || 5
    });

    let processedCount = 0;

    // Process files
    await Promise.all(
      files.map((file) =>
        processingQueue.add(async () => {
          const fileStartTime = Date.now();

          try {
            // Emit progress event
            await this.emitProgress(job, {
              jobId,
              progress: Math.round((processedCount / files.length) * 100),
              filesProcessed: processedCount,
              totalFiles: files.length,
              currentFile: file.filename,
              successCount: result.successCount,
              failureCount: result.failureCount,
              timestamp: new Date().toISOString()
            });

            // Get provider for file
            const provider = this.providerRegistry.getProvider(file.url);

            // Fetch file content
            logger.debug('Fetching file', {
              jobId,
              file: file.filename,
              url: file.url,
              provider: provider.name
            });

            const content = await provider.fetchFile(file.url);

            // Store document
            const doc = await this.storageEngine.storeDocument(content.toString('utf-8'), {
              title: file.filename,
              source: file.url,
              type: this.inferDocumentType(file.filename),
              format: this.inferDocumentFormat(file.filename),
              tags: options.metadata?.tags || [],
              custom: {
                ...options.metadata,
                ingestionJobId: jobId,
                parentPath: file.parentPath,
                depth: file.depth
              },
              // These will be filled by storeDocument method
              size: 0,
              hash: '',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              version: 1
            });

            // Record success
            result.successCount++;
            result.fileResults.push({
              file,
              status: 'success',
              documentId: doc.documentId,
              processingTimeMs: Date.now() - fileStartTime
            });

            logger.info('File ingested successfully', {
              jobId,
              file: file.filename,
              documentId: doc.documentId
            });
          } catch (error) {
            logger.error('File ingestion failed', {
              jobId,
              file: file.filename,
              error: (error as Error).message
            });

            result.failureCount++;
            result.fileResults.push({
              file,
              status: 'failure',
              error: (error as Error).message,
              processingTimeMs: Date.now() - fileStartTime
            });

            // Throw if not continuing on error
            if (!options.continueOnError) {
              throw error;
            }
          } finally {
            processedCount++;

            // Update job progress
            await job.updateProgress(Math.round((processedCount / files.length) * 100));
          }
        })
      )
    );

    // Calculate final stats
    result.processingTimeMs = Date.now() - startTime;

    if (result.failureCount === 0) {
      result.status = 'completed';
    } else if (result.successCount > 0) {
      result.status = 'partial';
    } else {
      result.status = 'failed';
    }

    logger.info('Ingestion job completed', {
      jobId,
      totalFiles: result.totalFiles,
      successCount: result.successCount,
      failureCount: result.failureCount,
      status: result.status,
      processingTimeMs: result.processingTimeMs
    });

    // Emit completion event
    await this.emitCompletion(job, result);

    return result;
  }

  /**
   * Emit progress event via WebSocket
   */
  private async emitProgress(
    job: Job<IngestionJobData>,
    progress: JobProgressEvent
  ): Promise<void> {
    const { options } = job.data;

    if (!options.websocketServerUrl) {
      return;
    }

    try {
      await axios.post(`${options.websocketServerUrl}/api/websocket/emit`, {
        room: `job:${progress.jobId}`,
        event: 'ingestion:progress',
        data: progress
      });
    } catch (error) {
      logger.error('Failed to emit progress event', {
        jobId: progress.jobId,
        error: (error as Error).message
      });
    }
  }

  /**
   * Emit completion event via WebSocket
   */
  private async emitCompletion(
    job: Job<IngestionJobData>,
    result: IngestionJobResult
  ): Promise<void> {
    const { options } = job.data;

    if (!options.websocketServerUrl) {
      return;
    }

    try {
      await axios.post(`${options.websocketServerUrl}/api/websocket/emit`, {
        room: `job:${result.jobId}`,
        event: 'ingestion:completed',
        data: result
      });
    } catch (error) {
      logger.error('Failed to emit completion event', {
        jobId: result.jobId,
        error: (error as Error).message
      });
    }
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Worker events
    this.worker.on('completed', (job) => {
      logger.info('Job completed', {
        jobId: job.id,
        returnvalue: job.returnvalue
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('Job failed', {
        jobId: job?.id,
        error: error.message
      });
    });

    this.worker.on('error', (error) => {
      logger.error('Worker error', { error: error.message });
    });

    // Queue events
    this.queueEvents.on('waiting', ({ jobId }) => {
      logger.debug('Job waiting', { jobId });
    });

    this.queueEvents.on('active', ({ jobId }) => {
      logger.debug('Job active', { jobId });
    });

    this.queueEvents.on('stalled', ({ jobId }) => {
      logger.warn('Job stalled', { jobId });
    });
  }

  /**
   * Infer document type from filename
   */
  private inferDocumentType(filename: string): 'code' | 'markdown' | 'text' | 'structured' | 'multimodal' {
    const ext = filename.split('.').pop()?.toLowerCase();

    switch (ext) {
      case 'md':
      case 'markdown':
        return 'markdown';
      case 'pdf':
      case 'doc':
      case 'docx':
      case 'txt':
      case 'xls':
      case 'xlsx':
        return 'text';  // These will be parsed and treated as text
      case 'json':
      case 'xml':
      case 'yaml':
      case 'yml':
        return 'structured';
      case 'js':
      case 'ts':
      case 'tsx':
      case 'jsx':
      case 'py':
      case 'java':
      case 'cpp':
      case 'c':
      case 'go':
      case 'rs':
      case 'rb':
      case 'php':
      case 'swift':
        return 'code';
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        return 'multimodal';
      default:
        return 'text';
    }
  }

  /**
   * Infer document format from filename
   */
  private inferDocumentFormat(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ext || 'txt';
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down IngestionJobQueue...');

    await this.worker.close();
    await this.queue.close();
    await this.queueEvents.close();

    logger.info('IngestionJobQueue shutdown complete');
  }
}
