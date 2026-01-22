/**
 * Workers Index
 *
 * Exports for BullMQ-based background workers.
 * Part of the async-first architecture for <200ms response times.
 */

export {
  // Queue types and functions
  MemoryEnrichmentJob,
  EnrichmentResult,
  TenantContext,
  QueueConfig,
  initializeEnrichmentQueue,
  getEnrichmentQueue,
  enqueueEnrichment,
  getEnrichmentStatus,
  getQueueStats,
  closeEnrichmentQueue
} from './memory-enrichment-queue';

export {
  // Worker types and functions
  WorkerConfig,
  MemoryEnrichmentWorker,
  startEnrichmentWorker,
  getEnrichmentWorker,
  stopEnrichmentWorker
} from './memory-enrichment-worker';
