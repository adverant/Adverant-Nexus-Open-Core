/**
 * Dead Letter Queue Processor
 *
 * **Purpose**: Background process that monitors and processes DLQ entries.
 * Provides automated retry with approval, manual review workflow, and cleanup.
 *
 * **Features**:
 * - Periodic polling for pending DLQ entries
 * - Automated retry for transient failures (with approval)
 * - Manual review workflow for permanent failures
 * - Automatic archival of old resolved entries (30 days)
 * - Metrics and monitoring
 *
 * **Design Pattern**: Consumer Pattern with Approval Workflow
 *
 * @module DLQProcessor
 */

import { DeadLetterQueue, StoredDeadLetterEntry, DLQStats } from './dead-letter-queue';
import { TaskManager } from '../core/task-manager';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export interface DLQProcessorOptions {
  /**
   * Polling interval for checking pending DLQ entries (ms)
   * Default: 60000 (1 minute)
   */
  pollingInterval?: number;

  /**
   * Maximum number of entries to process per poll cycle
   * Default: 10
   */
  batchSize?: number;

  /**
   * Age threshold for archiving resolved entries (ms)
   * Default: 2592000000 (30 days)
   */
  archivalThresholdMs?: number;

  /**
   * Enable automatic retry for transient failures
   * Default: false (requires manual approval)
   */
  enableAutoRetry?: boolean;

  /**
   * Transient failure patterns that can be auto-retried
   * Default: ['timeout', 'network', 'connection']
   */
  transientFailurePatterns?: string[];
}

export interface ProcessingStats {
  totalProcessed: number;
  retriesAttempted: number;
  retriesSucceeded: number;
  retriesFailed: number;
  entriesArchived: number;
  lastProcessedAt?: Date;
  lastArchivedAt?: Date;
}

export class DLQProcessor extends EventEmitter {
  private dlq: DeadLetterQueue;
  private taskManager: TaskManager;
  private options: Required<DLQProcessorOptions>;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private stats: ProcessingStats = {
    totalProcessed: 0,
    retriesAttempted: 0,
    retriesSucceeded: 0,
    retriesFailed: 0,
    entriesArchived: 0
  };

  constructor(
    dlq: DeadLetterQueue,
    taskManager: TaskManager,
    options: DLQProcessorOptions = {}
  ) {
    super();

    this.dlq = dlq;
    this.taskManager = taskManager;
    this.options = {
      pollingInterval: options.pollingInterval ?? 60000, // 1 minute
      batchSize: options.batchSize ?? 10,
      archivalThresholdMs: options.archivalThresholdMs ?? 2592000000, // 30 days
      enableAutoRetry: options.enableAutoRetry ?? false,
      transientFailurePatterns: options.transientFailurePatterns ?? ['timeout', 'network', 'connection']
    };

    logger.info('DLQProcessor initialized', {
      pollingInterval: this.options.pollingInterval,
      batchSize: this.options.batchSize,
      enableAutoRetry: this.options.enableAutoRetry
    });
  }

  /**
   * Start the DLQ processor
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('DLQProcessor already running');
      return;
    }

    this.isRunning = true;

    logger.info('Starting DLQProcessor', {
      pollingInterval: this.options.pollingInterval,
      batchSize: this.options.batchSize
    });

    // Start polling
    this.pollingTimer = setInterval(
      () => this.processPendingEntries(),
      this.options.pollingInterval
    );

    // Run immediately on start
    this.processPendingEntries().catch(error => {
      logger.error('Error in initial DLQ processing', { error: error.message });
    });

    // Start archival process (runs every hour)
    setInterval(
      () => this.archiveOldEntries(),
      3600000 // 1 hour
    );

    this.emit('started');
  }

  /**
   * Stop the DLQ processor
   */
  stop(): void {
    if (!this.isRunning) {
      logger.warn('DLQProcessor not running');
      return;
    }

    this.isRunning = false;

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    logger.info('DLQProcessor stopped');
    this.emit('stopped');
  }

  /**
   * Process pending DLQ entries
   */
  private async processPendingEntries(): Promise<void> {
    try {
      logger.debug('Polling for pending DLQ entries');

      // Query pending entries
      const pendingEntries = await this.dlq.query({
        status: 'pending',
        limit: this.options.batchSize,
        sortBy: 'timestamp',
        sortOrder: 'asc' // Oldest first
      });

      if (pendingEntries.length === 0) {
        logger.debug('No pending DLQ entries found');
        return;
      }

      logger.info('Found pending DLQ entries', { count: pendingEntries.length });

      // Process each entry
      for (const entry of pendingEntries) {
        await this.processEntry(entry);
      }

      this.stats.lastProcessedAt = new Date();
      this.emit('batchProcessed', { count: pendingEntries.length });

    } catch (error: any) {
      logger.error('Error processing pending DLQ entries', {
        error: error.message,
        stack: error.stack
      });
      this.emit('error', error);
    }
  }

  /**
   * Process a single DLQ entry
   */
  private async processEntry(entry: StoredDeadLetterEntry): Promise<void> {
    logger.info('Processing DLQ entry', {
      id: entry.id,
      taskId: entry.taskId,
      reason: entry.reason,
      attempts: entry.attempts
    });

    this.stats.totalProcessed++;

    try {
      // Check if this is a transient failure that can be auto-retried
      const isTransient = this.isTransientFailure(entry);

      if (this.options.enableAutoRetry && isTransient) {
        // Attempt automatic retry
        await this.retryEntry(entry);
      } else {
        // Mark for manual review
        await this.markForManualReview(entry);
      }

    } catch (error: any) {
      logger.error('Error processing DLQ entry', {
        id: entry.id,
        taskId: entry.taskId,
        error: error.message
      });
      this.emit('processingError', { entry, error });
    }
  }

  /**
   * Check if a DLQ entry represents a transient failure
   */
  private isTransientFailure(entry: StoredDeadLetterEntry): boolean {
    const reason = entry.reason.toLowerCase();
    return this.options.transientFailurePatterns.some(pattern =>
      reason.includes(pattern.toLowerCase())
    );
  }

  /**
   * Retry a DLQ entry
   */
  private async retryEntry(entry: StoredDeadLetterEntry): Promise<void> {
    logger.info('Retrying DLQ entry', {
      id: entry.id,
      taskId: entry.taskId
    });

    this.stats.retriesAttempted++;

    try {
      // Update status to processing
      await this.dlq.updateStatus(entry.id, 'processing');

      // Create new task with original parameters
      // Note: This requires access to original task parameters stored in metadata
      if (!entry.metadata?.taskType || !entry.metadata?.params) {
        throw new Error('Cannot retry: missing task metadata');
      }

      const newTaskId = await this.taskManager.createTask(
        entry.metadata.taskType,
        entry.metadata.params
      );

      logger.info('DLQ entry retry initiated', {
        originalTaskId: entry.taskId,
        newTaskId,
        dlqEntryId: entry.id
      });

      // Mark as resolved
      await this.dlq.resolve(entry.id, 'system', 'Automatically retried');

      this.stats.retriesSucceeded++;
      this.emit('entryRetried', { entry, newTaskId });

    } catch (error: any) {
      logger.error('Failed to retry DLQ entry', {
        id: entry.id,
        taskId: entry.taskId,
        error: error.message
      });

      // Update status back to pending
      await this.dlq.updateStatus(entry.id, 'pending');

      this.stats.retriesFailed++;
      this.emit('retryFailed', { entry, error });
    }
  }

  /**
   * Mark entry for manual review
   */
  private async markForManualReview(entry: StoredDeadLetterEntry): Promise<void> {
    logger.info('Marking DLQ entry for manual review', {
      id: entry.id,
      taskId: entry.taskId,
      reason: entry.reason
    });

    // Keep status as pending but emit event for dashboard/notification
    this.emit('manualReviewRequired', {
      entry,
      message: `Task ${entry.taskId} requires manual review: ${entry.reason}`,
      attempts: entry.attempts,
      duration: entry.duration,
      errors: entry.errors
    });
  }

  /**
   * Archive old resolved entries
   */
  private async archiveOldEntries(): Promise<void> {
    try {
      logger.debug('Archiving old DLQ entries');

      // Convert threshold from ms to days
      const olderThanDays = Math.floor(this.options.archivalThresholdMs / (1000 * 60 * 60 * 24));

      const archived = await this.dlq.archiveOldEntries(olderThanDays);

      if (archived > 0) {
        logger.info('Archived old DLQ entries', {
          count: archived,
          olderThanDays
        });

        this.stats.entriesArchived += archived;
        this.stats.lastArchivedAt = new Date();
        this.emit('entriesArchived', { count: archived });
      }

    } catch (error: any) {
      logger.error('Error archiving old DLQ entries', {
        error: error.message,
        stack: error.stack
      });
      this.emit('error', error);
    }
  }

  /**
   * Manually approve and retry a DLQ entry
   */
  async manualRetry(entryId: string, approvedBy: string): Promise<string> {
    logger.info('Manual retry requested', { entryId, approvedBy });

    // Get the entry
    const entries = await this.dlq.query({ limit: 1 });
    const entry = entries.find(e => e.id === entryId);

    if (!entry) {
      throw new Error(`DLQ entry ${entryId} not found`);
    }

    if (entry.status !== 'pending') {
      throw new Error(`DLQ entry ${entryId} is not in pending status (current: ${entry.status})`);
    }

    // Retry the entry
    await this.retryEntry(entry);

    // Log approval
    await this.dlq.resolve(entryId, approvedBy, 'Manually approved and retried');

    return entry.taskId;
  }

  /**
   * Manually resolve a DLQ entry without retry
   */
  async manualResolve(entryId: string, resolvedBy: string, resolution: string): Promise<void> {
    logger.info('Manual resolution requested', { entryId, resolvedBy, resolution });

    await this.dlq.resolve(entryId, resolvedBy, resolution);

    this.emit('entryResolved', { entryId, resolvedBy, resolution });
  }

  /**
   * Get current processing statistics
   */
  getStats(): ProcessingStats {
    return { ...this.stats };
  }

  /**
   * Get DLQ statistics
   */
  async getDLQStats(): Promise<DLQStats> {
    return await this.dlq.getStats();
  }

  /**
   * Check if processor is running
   */
  isProcessorRunning(): boolean {
    return this.isRunning;
  }
}
