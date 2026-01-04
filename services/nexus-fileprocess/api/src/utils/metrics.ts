/**
 * Prometheus Metrics for FileProcessAgent
 *
 * Tracks:
 * - HTTP requests (duration, status codes, endpoints)
 * - Job processing (created, completed, failed, duration)
 * - MageAgent API calls (latency, errors, model used)
 * - Batch embedding (texts processed, latency, batch size)
 * - System health (PostgreSQL, Redis, GraphRAG)
 * - Resource usage (memory, active connections)
 *
 * Exposes metrics at /metrics endpoint for Prometheus scraping
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import { logger } from './logger';

// Create a Registry
export const register = new Registry();

// Collect default metrics (CPU, memory, etc.)
collectDefaultMetrics({ register });

// ========================================
// HTTP Metrics
// ========================================

export const httpRequestDuration = new Histogram({
  name: 'fileprocess_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5, 10], // seconds
  registers: [register],
});

export const httpRequestTotal = new Counter({
  name: 'fileprocess_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// ========================================
// Job Processing Metrics
// ========================================

export const jobsCreatedTotal = new Counter({
  name: 'fileprocess_jobs_created_total',
  help: 'Total number of jobs created',
  labelNames: ['user_id', 'source'], // source: 'upload' or 'url'
  registers: [register],
});

export const jobsCompletedTotal = new Counter({
  name: 'fileprocess_jobs_completed_total',
  help: 'Total number of jobs completed',
  labelNames: ['status'], // status: 'success' or 'failed'
  registers: [register],
});

export const jobProcessingDuration = new Histogram({
  name: 'fileprocess_job_processing_duration_seconds',
  help: 'Duration of job processing in seconds',
  labelNames: ['status'],
  buckets: [1, 5, 10, 30, 60, 120, 300], // seconds
  registers: [register],
});

export const activeJobsGauge = new Gauge({
  name: 'fileprocess_active_jobs',
  help: 'Number of currently active jobs',
  labelNames: ['status'], // status: 'queued', 'processing'
  registers: [register],
});

// ========================================
// Document Processing Metrics
// ========================================

export const documentsProcessedTotal = new Counter({
  name: 'fileprocess_documents_processed_total',
  help: 'Total number of documents processed',
  labelNames: ['file_type', 'status'], // file_type: 'pdf', 'docx', etc.
  registers: [register],
});

export const documentSizeBytes = new Histogram({
  name: 'fileprocess_document_size_bytes',
  help: 'Size of processed documents in bytes',
  labelNames: ['file_type'],
  buckets: [1024, 10240, 102400, 1048576, 10485760, 104857600], // 1KB to 100MB
  registers: [register],
});

export const documentPagesTotal = new Counter({
  name: 'fileprocess_document_pages_total',
  help: 'Total number of document pages processed',
  labelNames: ['file_type'],
  registers: [register],
});

// ========================================
// MageAgent API Metrics
// ========================================

export const mageagentCallDuration = new Histogram({
  name: 'fileprocess_mageagent_call_duration_seconds',
  help: 'Duration of MageAgent API calls in seconds',
  labelNames: ['operation', 'model', 'status'], // operation: 'ocr', 'table', 'layout'
  buckets: [1, 3, 5, 10, 15, 30], // seconds
  registers: [register],
});

export const mageagentCallsTotal = new Counter({
  name: 'fileprocess_mageagent_calls_total',
  help: 'Total number of MageAgent API calls',
  labelNames: ['operation', 'status'], // status: 'success', 'error'
  registers: [register],
});

export const mageagentErrorsTotal = new Counter({
  name: 'fileprocess_mageagent_errors_total',
  help: 'Total number of MageAgent API errors',
  labelNames: ['operation', 'error_type'],
  registers: [register],
});

// ========================================
// Embedding Metrics
// ========================================

export const embeddingBatchSize = new Histogram({
  name: 'fileprocess_embedding_batch_size',
  help: 'Number of texts in embedding batch',
  labelNames: ['operation'], // operation: 'batch', 'single'
  buckets: [1, 10, 50, 100, 500, 1000],
  registers: [register],
});

export const embeddingDuration = new Histogram({
  name: 'fileprocess_embedding_duration_seconds',
  help: 'Duration of embedding generation in seconds',
  labelNames: ['operation', 'batch_size_range'], // batch_size_range: '1-10', '11-100', '101-1000'
  buckets: [0.5, 1, 2, 5, 10, 30, 60], // seconds
  registers: [register],
});

export const embeddingTextsTotal = new Counter({
  name: 'fileprocess_embedding_texts_total',
  help: 'Total number of texts embedded',
  labelNames: ['operation'],
  registers: [register],
});

// ========================================
// Table Extraction Metrics
// ========================================

export const tablesExtractedTotal = new Counter({
  name: 'fileprocess_tables_extracted_total',
  help: 'Total number of tables extracted',
  labelNames: ['method', 'status'], // method: 'vision', 'heuristic'
  registers: [register],
});

export const tableExtractionConfidence = new Histogram({
  name: 'fileprocess_table_extraction_confidence',
  help: 'Confidence score of table extractions',
  labelNames: ['method'],
  buckets: [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0],
  registers: [register],
});

export const tableCellsTotal = new Counter({
  name: 'fileprocess_table_cells_total',
  help: 'Total number of table cells extracted',
  labelNames: ['method'],
  registers: [register],
});

// ========================================
// Database Metrics
// ========================================

export const databaseQueryDuration = new Histogram({
  name: 'fileprocess_database_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'database'], // database: 'postgres', 'redis'
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2], // seconds
  registers: [register],
});

export const databaseConnectionsActive = new Gauge({
  name: 'fileprocess_database_connections_active',
  help: 'Number of active database connections',
  labelNames: ['database'],
  registers: [register],
});

export const databaseErrorsTotal = new Counter({
  name: 'fileprocess_database_errors_total',
  help: 'Total number of database errors',
  labelNames: ['database', 'error_type'],
  registers: [register],
});

// ========================================
// Health Metrics
// ========================================

export const healthCheckDuration = new Histogram({
  name: 'fileprocess_health_check_duration_seconds',
  help: 'Duration of health checks in seconds',
  labelNames: ['dependency'], // dependency: 'postgres', 'redis', 'graphrag', 'mageagent'
  buckets: [0.1, 0.5, 1, 2, 5], // seconds
  registers: [register],
});

export const healthCheckStatus = new Gauge({
  name: 'fileprocess_health_check_status',
  help: 'Health check status (1 = healthy, 0 = unhealthy)',
  labelNames: ['dependency'],
  registers: [register],
});

// ========================================
// System Metrics
// ========================================

export const systemMemoryUsage = new Gauge({
  name: 'fileprocess_system_memory_usage_bytes',
  help: 'System memory usage in bytes',
  labelNames: ['type'], // type: 'heap', 'rss', 'external'
  registers: [register],
});

export const errorRateTotal = new Counter({
  name: 'fileprocess_errors_total',
  help: 'Total number of errors',
  labelNames: ['type', 'severity'], // severity: 'warning', 'error', 'critical'
  registers: [register],
});

// ========================================
// Pattern Learning Metrics (Phase 60c)
// ========================================

export const patternCacheHits = new Counter({
  name: 'fileprocess_pattern_cache_hits_total',
  help: 'Total number of pattern cache hits',
  labelNames: ['mime_type'],
  registers: [register],
});

export const patternCacheMisses = new Counter({
  name: 'fileprocess_pattern_cache_misses_total',
  help: 'Total number of pattern cache misses',
  labelNames: ['mime_type'],
  registers: [register],
});

export const patternExecutionDuration = new Histogram({
  name: 'fileprocess_pattern_execution_duration_seconds',
  help: 'Duration of cached pattern execution',
  labelNames: ['pattern_id', 'success'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const patternSpeedupFactor = new Histogram({
  name: 'fileprocess_pattern_speedup_factor',
  help: 'Speedup factor achieved by pattern caching',
  buckets: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  registers: [register],
});

export const patternRepositorySize = new Gauge({
  name: 'fileprocess_pattern_repository_size',
  help: 'Number of patterns in repository',
  labelNames: ['storage'], // storage: 'cache', 'database', 'graphrag'
  registers: [register],
});

export const patternLearningTotal = new Counter({
  name: 'fileprocess_pattern_learning_total',
  help: 'Total number of new patterns learned',
  labelNames: ['mime_type', 'source'], // source: 'mageagent', 'sandbox'
  registers: [register],
});

// ========================================
// Circuit Breaker Metrics (Phase 4)
// ========================================

export const circuitBreakerState = new Gauge({
  name: 'fileprocess_circuit_breaker_state',
  help: 'Circuit breaker state (0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN)',
  labelNames: ['circuit_name'],
  registers: [register],
});

export const circuitBreakerTransitions = new Counter({
  name: 'fileprocess_circuit_breaker_transitions_total',
  help: 'Total number of circuit breaker state transitions',
  labelNames: ['circuit_name', 'from_state', 'to_state'],
  registers: [register],
});

export const circuitBreakerFailures = new Counter({
  name: 'fileprocess_circuit_breaker_failures_total',
  help: 'Total number of circuit breaker failures',
  labelNames: ['circuit_name', 'error_type'],
  registers: [register],
});

export const circuitBreakerSuccesses = new Counter({
  name: 'fileprocess_circuit_breaker_successes_total',
  help: 'Total number of circuit breaker successes',
  labelNames: ['circuit_name'],
  registers: [register],
});

// ========================================
// Queue Metrics
// ========================================

export const queueDepth = new Gauge({
  name: 'fileprocess_queue_depth',
  help: 'Number of jobs in queue',
  labelNames: ['queue_name', 'state'], // state: 'waiting', 'active', 'delayed'
  registers: [register],
});

export const queueWorkerHealth = new Gauge({
  name: 'fileprocess_queue_worker_health',
  help: 'Worker health status (1 = healthy, 0 = unhealthy)',
  labelNames: ['worker_id'],
  registers: [register],
});

export const queueJobsProcessed = new Counter({
  name: 'fileprocess_queue_jobs_processed_total',
  help: 'Total number of queue jobs processed',
  labelNames: ['queue_name', 'status'], // status: 'completed', 'failed'
  registers: [register],
});

export const queueJobDuration = new Histogram({
  name: 'fileprocess_queue_job_duration_seconds',
  help: 'Duration of queue job processing',
  labelNames: ['queue_name', 'job_type'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

// ========================================
// Sandbox Metrics
// ========================================

export const sandboxExecutions = new Counter({
  name: 'fileprocess_sandbox_executions_total',
  help: 'Total number of sandbox executions',
  labelNames: ['language', 'success'],
  registers: [register],
});

export const sandboxExecutionDuration = new Histogram({
  name: 'fileprocess_sandbox_execution_duration_seconds',
  help: 'Duration of sandbox code execution',
  labelNames: ['language', 'success'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const sandboxResourceUsage = new Histogram({
  name: 'fileprocess_sandbox_resource_usage',
  help: 'Sandbox resource usage (CPU time or memory peak)',
  labelNames: ['resource_type', 'language'], // resource_type: 'cpu_ms', 'memory_mb'
  buckets: [10, 50, 100, 250, 500, 1000, 2000],
  registers: [register],
});

// ========================================
// Middleware for HTTP Metrics
// ========================================

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  // Capture response finish event
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000; // Convert to seconds
    const route = req.route?.path || req.path;
    const method = req.method;
    const statusCode = res.statusCode.toString();

    // Record metrics
    httpRequestDuration.labels(method, route, statusCode).observe(duration);
    httpRequestTotal.labels(method, route, statusCode).inc();

    logger.debug('HTTP metrics recorded', {
      method,
      route,
      statusCode,
      duration: `${duration.toFixed(3)}s`,
    });
  });

  next();
}

// ========================================
// Metrics Endpoint Handler
// ========================================

export async function metricsHandler(_req: Request, res: Response) {
  try {
    // Update system metrics before serving
    const memUsage = process.memoryUsage();
    systemMemoryUsage.labels('heap').set(memUsage.heapUsed);
    systemMemoryUsage.labels('rss').set(memUsage.rss);
    systemMemoryUsage.labels('external').set(memUsage.external);

    // Serve metrics in Prometheus format
    res.setHeader('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.send(metrics);
  } catch (error) {
    logger.error('Failed to generate metrics', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to generate metrics');
  }
}

// ========================================
// Helper Functions
// ========================================

/**
 * Get batch size range label for metrics
 */
export function getBatchSizeRange(size: number): string {
  if (size === 1) return '1';
  if (size <= 10) return '2-10';
  if (size <= 50) return '11-50';
  if (size <= 100) return '51-100';
  if (size <= 500) return '101-500';
  return '501+';
}

/**
 * Record job creation metric
 */
export function recordJobCreated(userId: string, source: 'upload' | 'url') {
  jobsCreatedTotal.labels(userId, source).inc();
  activeJobsGauge.labels('queued').inc();
}

/**
 * Record job completion metric
 */
export function recordJobCompleted(status: 'success' | 'failed', durationSeconds: number) {
  jobsCompletedTotal.labels(status).inc();
  jobProcessingDuration.labels(status).observe(durationSeconds);
  activeJobsGauge.labels('processing').dec();
}

/**
 * Record document processing metric
 */
export function recordDocumentProcessed(
  fileType: string,
  status: 'success' | 'failed',
  sizeBytes: number,
  pages?: number
) {
  documentsProcessedTotal.labels(fileType, status).inc();
  documentSizeBytes.labels(fileType).observe(sizeBytes);

  if (pages) {
    documentPagesTotal.labels(fileType).inc(pages);
  }
}

/**
 * Record MageAgent API call metric
 */
export function recordMageAgentCall(
  operation: 'ocr' | 'table' | 'layout',
  status: 'success' | 'error',
  durationSeconds: number,
  model?: string
) {
  mageagentCallsTotal.labels(operation, status).inc();
  mageagentCallDuration.labels(operation, model || 'unknown', status).observe(durationSeconds);

  if (status === 'error') {
    mageagentErrorsTotal.labels(operation, 'api_error').inc();
  }
}

/**
 * Record embedding metric
 */
export function recordEmbedding(
  operation: 'batch' | 'single',
  textsCount: number,
  durationSeconds: number
) {
  embeddingTextsTotal.labels(operation).inc(textsCount);
  embeddingBatchSize.labels(operation).observe(textsCount);

  const batchSizeRange = getBatchSizeRange(textsCount);
  embeddingDuration.labels(operation, batchSizeRange).observe(durationSeconds);
}

/**
 * Record table extraction metric
 */
export function recordTableExtraction(
  method: 'vision' | 'heuristic',
  status: 'success' | 'error',
  confidence: number,
  cellsCount: number
) {
  tablesExtractedTotal.labels(method, status).inc();
  tableExtractionConfidence.labels(method).observe(confidence);
  tableCellsTotal.labels(method).inc(cellsCount);
}

/**
 * Record health check metric
 */
export function recordHealthCheck(
  dependency: 'postgres' | 'redis' | 'graphrag' | 'mageagent',
  healthy: boolean,
  durationSeconds: number
) {
  healthCheckStatus.labels(dependency).set(healthy ? 1 : 0);
  healthCheckDuration.labels(dependency).observe(durationSeconds);
}

/**
 * Record database operation metric
 */
export function recordDatabaseOperation(
  operation: string,
  database: 'postgres' | 'redis',
  durationSeconds: number,
  error?: Error
) {
  databaseQueryDuration.labels(operation, database).observe(durationSeconds);

  if (error) {
    databaseErrorsTotal.labels(database, error.name).inc();
  }
}

/**
 * Record error metric
 */
export function recordError(type: string, severity: 'warning' | 'error' | 'critical') {
  errorRateTotal.labels(type, severity).inc();
}

/**
 * Record pattern cache hit
 */
export function recordPatternCacheHit(mimeType: string) {
  patternCacheHits.labels(mimeType).inc();
}

/**
 * Record pattern cache miss
 */
export function recordPatternCacheMiss(mimeType: string) {
  patternCacheMisses.labels(mimeType).inc();
}

/**
 * Record pattern execution
 */
export function recordPatternExecution(
  patternId: string,
  success: boolean,
  durationSeconds: number,
  speedupFactor?: number
) {
  patternExecutionDuration.labels(patternId, success.toString()).observe(durationSeconds);

  if (speedupFactor) {
    patternSpeedupFactor.observe(speedupFactor);
  }
}

/**
 * Record pattern learning
 */
export function recordPatternLearning(
  mimeType: string,
  source: 'mageagent' | 'sandbox'
) {
  patternLearningTotal.labels(mimeType, source).inc();
}

/**
 * Update pattern repository size
 */
export function updatePatternRepositorySize(
  storage: 'cache' | 'database' | 'graphrag',
  size: number
) {
  patternRepositorySize.labels(storage).set(size);
}

/**
 * Record circuit breaker state change
 */
export function recordCircuitBreakerState(
  circuitName: string,
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
) {
  const stateValue = state === 'CLOSED' ? 0 : state === 'OPEN' ? 1 : 2;
  circuitBreakerState.labels(circuitName).set(stateValue);
}

/**
 * Record circuit breaker transition
 */
export function recordCircuitBreakerTransition(
  circuitName: string,
  fromState: string,
  toState: string
) {
  circuitBreakerTransitions.labels(circuitName, fromState, toState).inc();
}

/**
 * Record circuit breaker failure
 */
export function recordCircuitBreakerFailure(
  circuitName: string,
  errorType: string
) {
  circuitBreakerFailures.labels(circuitName, errorType).inc();
}

/**
 * Record circuit breaker success
 */
export function recordCircuitBreakerSuccess(circuitName: string) {
  circuitBreakerSuccesses.labels(circuitName).inc();
}

/**
 * Update queue depth
 */
export function updateQueueDepth(
  queueName: string,
  state: 'waiting' | 'active' | 'delayed',
  count: number
) {
  queueDepth.labels(queueName, state).set(count);
}

/**
 * Update worker health
 */
export function updateWorkerHealth(workerId: string, healthy: boolean) {
  queueWorkerHealth.labels(workerId).set(healthy ? 1 : 0);
}

/**
 * Record queue job processing
 */
export function recordQueueJobProcessed(
  queueName: string,
  status: 'completed' | 'failed',
  durationSeconds: number,
  jobType: string
) {
  queueJobsProcessed.labels(queueName, status).inc();
  queueJobDuration.labels(queueName, jobType).observe(durationSeconds);
}

/**
 * Record sandbox execution
 */
export function recordSandboxExecution(
  language: string,
  success: boolean,
  durationSeconds: number,
  cpuTimeMs?: number,
  memoryPeakMb?: number
) {
  sandboxExecutions.labels(language, success.toString()).inc();
  sandboxExecutionDuration.labels(language, success.toString()).observe(durationSeconds);

  if (cpuTimeMs !== undefined) {
    sandboxResourceUsage.labels('cpu_ms', language).observe(cpuTimeMs);
  }

  if (memoryPeakMb !== undefined) {
    sandboxResourceUsage.labels('memory_mb', language).observe(memoryPeakMb);
  }
}

logger.info('Prometheus metrics initialized', {
  endpoint: '/metrics',
  metrics: [
    'HTTP requests',
    'Job processing',
    'Document processing',
    'MageAgent calls',
    'Embeddings',
    'Table extraction',
    'Database operations',
    'Health checks',
    'System resources',
    'Pattern learning (Phase 60c)',
    'Circuit breakers (Phase 4)',
    'Queue operations',
    'Sandbox executions',
  ],
});
