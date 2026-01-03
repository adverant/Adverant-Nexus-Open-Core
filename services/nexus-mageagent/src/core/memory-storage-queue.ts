/**
 * Memory Storage Queue - Decoupled Memory Operations with Retry Logic
 *
 * Implements Command Pattern + Dead Letter Queue Pattern
 * Ensures task completion is independent of memory storage success
 */

import Bull, { Queue, Job, JobOptions } from 'bull';
import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';
import { CircuitBreaker, CircuitBreakerOptions } from '@adverant/resilience';
// PHASE 45: Import tenant context types and client factory for multi-tenant isolation
import { TenantContext } from '../middleware/tenant-context.js';
import { createGraphRAGClient } from '../clients/graphrag-client.js';

const logger = createLogger('MemoryStorageQueue');

export type MemoryOperationType = 'episode' | 'entity' | 'document' | 'fact' | 'memory';

export interface MemoryOperation {
  id: string;
  type: MemoryOperationType;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  metadata: {
    taskId?: string;
    agentId?: string;
    timestamp: Date;
    priority: number;
    retryCount: number;
    maxRetries: number;
  };
  // PHASE 45: Add tenant context for multi-tenant isolation
  tenantContext?: TenantContext;
}

export interface MemoryStorageQueueConfig {
  redisUrl: string;
  concurrency?: number;
  retryStrategy?: RetryStrategyConfig;
  deadLetterQueueEnabled?: boolean;
  circuitBreaker?: Partial<CircuitBreakerOptions>;
}

export interface RetryStrategyConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
}

export class MemoryStorageQueue extends EventEmitter {
  private queue: Queue;
  private deadLetterQueue: Queue;
  private config: Required<MemoryStorageQueueConfig>;
  private circuitBreaker: CircuitBreaker;
  private graphragClient: any; // Will be injected

  constructor(config: MemoryStorageQueueConfig) {
    super();

    this.config = {
      redisUrl: config.redisUrl,
      concurrency: config.concurrency || 3,
      retryStrategy: config.retryStrategy || {
        maxRetries: 5,
        initialDelay: 1000,
        maxDelay: 60000,
        backoffMultiplier: 2,
        retryableStatusCodes: [408, 429, 500, 502, 503, 504]
      },
      deadLetterQueueEnabled: config.deadLetterQueueEnabled ?? true,
      circuitBreaker: config.circuitBreaker || {
        name: 'memory-storage',
        errorThreshold: 50,
        volumeThreshold: 5,
        resetTimeout: 60000,
        timeout: 30000
      }
    };

    // Initialize main queue
    this.queue = new Bull('memory-storage', this.config.redisUrl, {
      defaultJobOptions: {
        attempts: this.config.retryStrategy.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.config.retryStrategy.initialDelay
        },
        removeOnComplete: false, // Keep for audit trail
        removeOnFail: false       // Move to DLQ instead
      }
    });

    // Initialize dead letter queue
    this.deadLetterQueue = new Bull('memory-storage-dlq', this.config.redisUrl, {
      defaultJobOptions: {
        removeOnComplete: false
      }
    });

    // Initialize circuit breaker with name and callbacks
    const circuitBreakerConfig: CircuitBreakerOptions = {
      name: 'memory-storage',
      ...this.config.circuitBreaker,
      onOpen: () => {
        logger.error('Circuit breaker OPEN - GraphRAG service failing');
        this.emit('circuit:open');
      },
      onHalfOpen: () => {
        logger.info('Circuit breaker HALF_OPEN - Testing GraphRAG recovery');
        this.emit('circuit:halfOpen');
      },
      onClose: () => {
        logger.info('Circuit breaker CLOSED - GraphRAG service recovered');
        this.emit('circuit:closed');
      }
    };
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);

    this.setupQueueProcessors();
    this.setupEventListeners();

    logger.info('MemoryStorageQueue initialized', {
      concurrency: this.config.concurrency,
      maxRetries: this.config.retryStrategy.maxRetries,
      dlqEnabled: this.config.deadLetterQueueEnabled
    });
  }

  /**
   * Set GraphRAG client for memory operations
   */
  setGraphRAGClient(client: any): void {
    this.graphragClient = client;
  }

  /**
   * Queue a memory storage operation (non-blocking)
   */
  async queueMemoryOperation(operation: Omit<MemoryOperation, 'id'>): Promise<string> {
    const operationId = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const fullOperation: MemoryOperation = {
      id: operationId,
      ...operation,
      metadata: {
        ...operation.metadata,
        timestamp: new Date(),
        retryCount: 0
      }
    };

    const jobOptions: JobOptions = {
      priority: operation.metadata.priority || 0,
      jobId: operationId
    };

    try {
      await this.queue.add('store', fullOperation, jobOptions);

      logger.debug('Memory operation queued', {
        operationId,
        type: operation.type,
        taskId: operation.metadata.taskId
      });

      this.emit('operation:queued', fullOperation);

      return operationId;
    } catch (error: any) {
      logger.error('Failed to queue memory operation', {
        operationId,
        error: error.message
      });
      throw new Error(`Failed to queue memory operation: ${error.message}`);
    }
  }

  /**
   * Setup queue processors
   */
  private setupQueueProcessors(): void {
    // Main queue processor
    this.queue.process('store', this.config.concurrency, async (job: Job) => {
      const operation: MemoryOperation = job.data;

      logger.debug('Processing memory operation', {
        operationId: operation.id,
        type: operation.type,
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts
      });

      // Check circuit breaker state
      if (this.circuitBreaker.getState() === 'OPEN') {
        const error = new Error('Circuit breaker OPEN - GraphRAG service unavailable');
        logger.warn('Circuit breaker preventing memory operation', {
          operationId: operation.id,
          state: 'OPEN'
        });
        throw error; // Will be retried when circuit closes
      }

      try {
        // Execute memory storage with circuit breaker protection
        const result = await this.circuitBreaker.execute(async () => {
          return await this.executeMemoryOperation(operation);
        });

        logger.info('Memory operation completed', {
          operationId: operation.id,
          type: operation.type,
          taskId: operation.metadata.taskId,
          attempt: job.attemptsMade + 1
        });

        this.emit('operation:completed', operation, result);

        return result;
      } catch (error: any) {
        operation.metadata.retryCount = job.attemptsMade + 1;

        logger.error('Memory operation failed', {
          operationId: operation.id,
          type: operation.type,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts,
          error: error.message,
          statusCode: error.statusCode
        });

        // Check if error is retryable
        if (this.isRetryableError(error)) {
          this.emit('operation:retrying', operation, error);
          throw error; // BullMQ will retry with backoff
        } else {
          // Non-retryable error - move to DLQ
          await this.moveToDLQ(operation, error);
          this.emit('operation:failed', operation, error);
          throw new Error(`Non-retryable error: ${error.message}`);
        }
      }
    });

    // Dead letter queue processor (manual review)
    if (this.config.deadLetterQueueEnabled) {
      this.deadLetterQueue.process(async (job: Job) => {
        logger.info('DLQ operation ready for manual review', {
          operationId: job.data.operation.id,
          reason: job.data.reason,
          timestamp: job.data.timestamp
        });
        // Manual intervention required - log and notify
        this.emit('dlq:operation', job.data);
      });
    }
  }

  /**
   * Execute the actual memory storage operation
   * PHASE 45: Use tenant-aware client when tenant context is available
   */
  private async executeMemoryOperation(operation: MemoryOperation): Promise<any> {
    if (!this.graphragClient) {
      throw new Error('GraphRAG client not initialized');
    }

    // PHASE 45: Create tenant-aware client if tenant context is present
    // This ensures multi-tenant isolation by injecting X-Company-ID and X-App-ID headers
    const client = operation.tenantContext
      ? createGraphRAGClient(operation.tenantContext)
      : this.graphragClient;

    // PHASE 45: Log tenant context usage for audit trail
    if (operation.tenantContext) {
      logger.debug('Executing memory operation with tenant context', {
        operationId: operation.id,
        type: operation.type,
        companyId: operation.tenantContext.companyId,
        appId: operation.tenantContext.appId,
        userId: operation.tenantContext.userId
      });
    } else {
      logger.warn('Executing memory operation WITHOUT tenant context - multi-tenant isolation may be compromised', {
        operationId: operation.id,
        type: operation.type
      });
    }

    switch (operation.type) {
      case 'episode':
        return await client.storeEpisode(operation.payload);

      case 'entity':
        return await client.storeEntity(operation.payload);

      case 'document':
        return await client.storeDocument(operation.payload);

      case 'fact':
        return await client.storeFact(operation.payload);

      case 'memory':
        return await client.storeMemory(operation.payload);

      default:
        throw new Error(`Unknown memory operation type: ${operation.type}`);
    }
  }

  /**
   * Determine if error is retryable
   */
  private isRetryableError(error: any): boolean {
    const statusCode = error.statusCode || error.response?.status;

    if (!statusCode) {
      // Network errors are retryable
      return true;
    }

    return this.config.retryStrategy.retryableStatusCodes.includes(statusCode);
  }

  /**
   * Move failed operation to dead letter queue
   */
  private async moveToDLQ(operation: MemoryOperation, error: any): Promise<void> {
    if (!this.config.deadLetterQueueEnabled) {
      logger.warn('Dead letter queue disabled, discarding operation', {
        operationId: operation.id
      });
      return;
    }

    try {
      await this.deadLetterQueue.add({
        operation,
        error: {
          message: error.message,
          statusCode: error.statusCode,
          stack: error.stack
        },
        timestamp: new Date(),
        reason: 'Max retries exceeded'
      });

      logger.warn('Memory operation moved to DLQ', {
        operationId: operation.id,
        retryCount: operation.metadata.retryCount
      });
    } catch (dlqError: any) {
      logger.error('Failed to move operation to DLQ', {
        operationId: operation.id,
        error: dlqError.message
      });
    }
  }

  /**
   * Setup event listeners for monitoring
   */
  private setupEventListeners(): void {
    this.queue.on('completed', (job: Job) => {
      logger.debug('Queue job completed', { jobId: job.id });
    });

    this.queue.on('failed', (job: Job, error: Error) => {
      logger.warn('Queue job failed', {
        jobId: job.id,
        attempts: job.attemptsMade,
        error: error.message
      });
    });

    this.queue.on('stalled', (job: Job) => {
      logger.warn('Queue job stalled', { jobId: job.id });
    });
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<any> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount()
    ]);

    const dlqCount = this.config.deadLetterQueueEnabled
      ? await this.deadLetterQueue.getCompletedCount()
      : 0;

    const cbStats = this.circuitBreaker.getStats();
    return {
      queue: { waiting, active, completed, failed, delayed },
      deadLetterQueue: { count: dlqCount },
      circuitBreaker: {
        state: cbStats.state,
        failures: cbStats.failedRequests,
        errorRate: cbStats.errorRate
      }
    };
  }

  /**
   * Retry all operations in dead letter queue
   */
  async retryDLQ(limit?: number): Promise<number> {
    if (!this.config.deadLetterQueueEnabled) {
      logger.warn('Dead letter queue disabled, no operations to retry');
      return 0;
    }

    const jobs = await this.deadLetterQueue.getCompleted(0, limit || 100);
    let retried = 0;

    for (const job of jobs) {
      try {
        const operation = job.data.operation;
        operation.metadata.retryCount = 0; // Reset retry count
        await this.queueMemoryOperation(operation);
        await job.remove();
        retried++;
      } catch (error: any) {
        logger.error('Failed to retry DLQ operation', {
          jobId: job.id,
          error: error.message
        });
      }
    }

    logger.info('DLQ retry completed', { retried, total: jobs.length });
    return retried;
  }

  /**
   * Graceful shutdown
   * PHASE 4 FIX: Added EventEmitter cleanup
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down MemoryStorageQueue');

    // Close Bull queues
    await Promise.all([
      this.queue.close(),
      this.deadLetterQueue.close()
    ]);

    // PHASE 4 FIX: Remove all EventEmitter listeners
    this.removeAllListeners();

    logger.info('MemoryStorageQueue shutdown complete');
  }
}
