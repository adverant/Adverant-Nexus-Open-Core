/**
 * Unified Event Bus Manager
 *
 * Consolidates all event infrastructure across the Nexus stack:
 * - Bull queue for async job processing
 * - Typed EventEmitter for local events
 * - Socket.IO for WebSocket streaming
 * - Redis pub/sub for inter-service communication
 * - Async operation tracking
 *
 * Part of Phase 2.3: Event Bus Consolidation
 */

import { EventEmitter } from 'events';
import Bull, { Queue, Job, JobOptions } from 'bull';
import Redis from 'ioredis';
import { createLogger } from '@adverant/logger';
import {
  OperationStatus,
  OperationType,
} from './types.js';
import type {
  EventBusConfig,
  JobType,
  JobPayload,
  EventType,
  EventPayload,
  PubSubChannel,
  PubSubMessage,
  AsyncOperation,
  EventBusStats,
  QueueStats,
  HealthCheckResult,
} from './types.js';

const logger = createLogger({ service: 'event-bus' });

/**
 * Event Bus Manager
 *
 * Central coordinator for all event-driven communication in the Nexus stack
 */
export class EventBusManager extends EventEmitter {
  private config: Required<EventBusConfig>;
  private isInitialized: boolean = false;

  // Queue infrastructure
  private queue?: Queue;
  private processors: Map<JobType, (job: Job) => Promise<any>> = new Map();

  // Redis pub/sub
  private redisPublisher?: Redis;
  private redisSubscriber?: Redis;
  private subscriptions: Map<PubSubChannel, Set<(message: PubSubMessage) => void>> = new Map();

  // Operation tracking
  private operations: Map<string, AsyncOperation> = new Map();
  private readonly MAX_OPERATIONS = 10000; // LRU limit

  // Statistics
  private stats = {
    publishedMessages: 0,
    receivedMessages: 0,
    completedJobs: 0,
    failedJobs: 0,
  };

  constructor(config: EventBusConfig) {
    super();

    // Set defaults
    this.config = {
      redisUrl: config.redisUrl || 'redis://nexus-redis:6379',
      enableQueue: config.enableQueue ?? true,
      enableWebSocket: config.enableWebSocket ?? true,
      enablePubSub: config.enablePubSub ?? true,
      concurrency: config.concurrency || 5,
      defaultTimeout: config.defaultTimeout || 300000, // 5 minutes
      maxTimeout: config.maxTimeout || 1800000, // 30 minutes
      removeOnComplete: config.removeOnComplete ?? false,
      removeOnFail: config.removeOnFail ?? false,
    };

    logger.info('EventBusManager created', {
      enableQueue: this.config.enableQueue,
      enableWebSocket: this.config.enableWebSocket,
      enablePubSub: this.config.enablePubSub,
    });
  }

  /**
   * Initialize event bus
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('EventBusManager already initialized');
      return;
    }

    try {
      logger.info('Initializing EventBusManager...');

      // Initialize queue
      if (this.config.enableQueue) {
        await this.initializeQueue();
      }

      // Initialize pub/sub
      if (this.config.enablePubSub) {
        await this.initializePubSub();
      }

      this.isInitialized = true;
      logger.info('EventBusManager initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to initialize EventBusManager', { error: errorMessage });
      throw error;
    }
  }

  /**
   * Initialize Bull queue
   */
  private async initializeQueue(): Promise<void> {
    this.queue = new Bull('nexus-event-queue', this.config.redisUrl, {
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: this.config.removeOnComplete,
        removeOnFail: this.config.removeOnFail,
      },
    });

    // Setup queue event listeners
    this.queue.on('completed', (job: Job) => {
      this.stats.completedJobs++;
      this.emit('job:completed', {
        jobId: job.id,
        type: job.data.type,
        timestamp: new Date(),
      });
      logger.debug('Job completed', { jobId: job.id, type: job.data.type });
    });

    this.queue.on('failed', (job: Job, error: Error) => {
      this.stats.failedJobs++;
      this.emit('job:failed', {
        jobId: job.id,
        type: job.data.type,
        error: error.message,
        timestamp: new Date(),
      });
      logger.error('Job failed', {
        jobId: job.id,
        type: job.data.type,
        error: error.message,
      });
    });

    this.queue.on('stalled', (job: Job) => {
      logger.warn('Job stalled', { jobId: job.id });
    });

    logger.info('Queue initialized', { name: 'nexus-event-queue' });
  }

  /**
   * Initialize Redis pub/sub
   */
  private async initializePubSub(): Promise<void> {
    // Create separate Redis clients for pub/sub
    this.redisPublisher = new Redis(this.config.redisUrl);
    this.redisSubscriber = new Redis(this.config.redisUrl);

    // Setup subscriber handlers
    this.redisSubscriber.on('message', (channel: string, message: string) => {
      try {
        const parsed: PubSubMessage = JSON.parse(message);
        this.stats.receivedMessages++;

        // Notify local subscribers
        const handlers = this.subscriptions.get(channel as PubSubChannel);
        if (handlers) {
          handlers.forEach((handler) => handler(parsed));
        }

        // Emit event for general listeners
        this.emit('pubsub:message', { channel, message: parsed });

        logger.debug('Pub/sub message received', {
          channel,
          event: parsed.event,
        });
      } catch (error) {
        logger.error('Failed to parse pub/sub message', {
          channel,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    this.redisSubscriber.on('error', (error) => {
      logger.error('Redis subscriber error', {
        error: error.message,
      });
    });

    logger.info('Pub/sub initialized');
  }

  /**
   * Queue a job for processing
   */
  async queueJob(payload: JobPayload, options?: JobOptions): Promise<string> {
    if (!this.queue) {
      throw new Error('Queue not initialized. Set enableQueue: true in config.');
    }

    const job = await this.queue.add(payload.type, payload, {
      ...options,
      priority: payload.metadata?.priority || 0,
      timeout: payload.metadata?.timeout || this.config.defaultTimeout,
    });

    const jobId = job.id?.toString();
    if (!jobId) {
      throw new Error('Job ID is undefined');
    }

    this.emit('job:queued', {
      jobId,
      type: payload.type,
      timestamp: new Date(),
    });

    logger.debug('Job queued', {
      jobId,
      type: payload.type,
    });

    return jobId;
  }

  /**
   * Register a job processor
   */
  registerProcessor(type: JobType, processor: (job: Job) => Promise<any>): void {
    if (!this.queue) {
      throw new Error('Queue not initialized');
    }

    this.processors.set(type, processor);

    // Register with Bull queue
    this.queue.process(type, this.config.concurrency, async (job: Job) => {
      logger.debug('Processing job', {
        jobId: job.id,
        type: job.data.type,
        attempt: job.attemptsMade + 1,
      });

      const processor = this.processors.get(job.data.type as JobType);
      if (!processor) {
        throw new Error(`No processor registered for job type: ${job.data.type}`);
      }

      return await processor(job);
    });

    logger.info('Processor registered', { type });
  }

  /**
   * Publish message to channel
   */
  async publish(channel: PubSubChannel, event: EventType, data: Record<string, any>, source?: string): Promise<void> {
    if (!this.redisPublisher) {
      throw new Error('Pub/sub not initialized. Set enablePubSub: true in config.');
    }

    const message: PubSubMessage = {
      channel,
      event,
      data,
      timestamp: new Date(),
      source,
    };

    await this.redisPublisher.publish(channel, JSON.stringify(message));
    this.stats.publishedMessages++;

    this.emit('pubsub:published', { channel, event });

    logger.debug('Message published', {
      channel,
      event,
      source,
    });
  }

  /**
   * Subscribe to channel
   */
  async subscribe(channel: PubSubChannel, handler: (message: PubSubMessage) => void): Promise<void> {
    if (!this.redisSubscriber) {
      throw new Error('Pub/sub not initialized. Set enablePubSub: true in config.');
    }

    // Add handler to subscriptions
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      // Subscribe to Redis channel
      await this.redisSubscriber.subscribe(channel);
      logger.info('Subscribed to channel', { channel });
    }

    this.subscriptions.get(channel)!.add(handler);
  }

  /**
   * Unsubscribe from channel
   */
  async unsubscribe(channel: PubSubChannel, handler: (message: PubSubMessage) => void): Promise<void> {
    const handlers = this.subscriptions.get(channel);
    if (handlers) {
      handlers.delete(handler);

      // If no more handlers, unsubscribe from Redis
      if (handlers.size === 0) {
        this.subscriptions.delete(channel);
        await this.redisSubscriber?.unsubscribe(channel);
        logger.info('Unsubscribed from channel', { channel });
      }
    }
  }

  /**
   * Track async operation
   */
  trackOperation(
    id: string,
    type: OperationType,
    metadata?: Record<string, any>
  ): AsyncOperation {
    const operation: AsyncOperation = {
      id,
      type,
      status: OperationStatus.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata,
    };

    this.operations.set(id, operation);

    // LRU eviction if limit exceeded
    if (this.operations.size > this.MAX_OPERATIONS) {
      const oldestKey = this.operations.keys().next().value as string;
      if (oldestKey) {
        this.operations.delete(oldestKey);
      }
    }

    this.emit('operation:tracked', operation);
    return operation;
  }

  /**
   * Update operation status
   */
  updateOperation(
    id: string,
    update: Partial<AsyncOperation>
  ): AsyncOperation | undefined {
    const operation = this.operations.get(id);
    if (!operation) {
      logger.warn('Operation not found for update', { id });
      return undefined;
    }

    Object.assign(operation, {
      ...update,
      updatedAt: Date.now(),
    });

    this.emit('operation:updated', operation);
    return operation;
  }

  /**
   * Get operation status
   */
  getOperation(id: string): AsyncOperation | undefined {
    return this.operations.get(id);
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<QueueStats | undefined> {
    if (!this.queue) return undefined;

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      totalProcessed: this.stats.completedJobs + this.stats.failedJobs,
    };
  }

  /**
   * Get event bus statistics
   */
  async getStats(): Promise<EventBusStats> {
    return {
      queue: await this.getQueueStats(),
      websocket: {
        connections: 0, // Populated by WebSocket server
        namespaces: 0,
        subscriptions: 0,
      },
      pubsub: {
        channels: this.subscriptions.size,
        subscribers: Array.from(this.subscriptions.values()).reduce((sum, set) => sum + set.size, 0),
        published: this.stats.publishedMessages,
        received: this.stats.receivedMessages,
      },
    };
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.isInitialized) {
      return {
        healthy: false,
        error: 'Not initialized',
      };
    }

    const startTime = Date.now();

    try {
      // Check Redis connectivity
      if (this.redisPublisher) {
        await this.redisPublisher.ping();
      }

      const latency = Date.now() - startTime;
      const queueStats = await this.getQueueStats();

      return {
        healthy: true,
        latency,
        details: {
          queue: queueStats,
          pubsub: {
            channels: this.subscriptions.size,
            subscribers: Array.from(this.subscriptions.values()).reduce((sum, set) => sum + set.size, 0),
          },
        },
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Close and cleanup
   */
  async close(): Promise<void> {
    logger.info('Closing EventBusManager...');

    // Close queue
    if (this.queue) {
      await this.queue.close();
    }

    // Close Redis connections
    if (this.redisPublisher) {
      await this.redisPublisher.quit();
    }
    if (this.redisSubscriber) {
      await this.redisSubscriber.quit();
    }

    // Clear state
    this.operations.clear();
    this.subscriptions.clear();
    this.processors.clear();

    // Remove all event listeners
    this.removeAllListeners();

    this.isInitialized = false;
    logger.info('EventBusManager closed');
  }

  /**
   * Get queue instance (for advanced usage)
   */
  getQueue(): Queue | undefined {
    return this.queue;
  }

  /**
   * Check if initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}
