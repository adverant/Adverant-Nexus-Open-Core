/**
 * Voyage AI Prometheus Metrics
 * Phase 4.1: Comprehensive metrics tracking for Voyage AI integration
 *
 * Metrics:
 * - Request counters (total, success, failure)
 * - Request duration histograms
 * - Request size histograms
 * - Circuit breaker state gauge
 * - Model usage counters
 * - Error type counters
 * - Batch operation metrics
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { CircuitState } from '@adverant/resilience';
import { logger } from '../utils/logger';

export class VoyageMetrics {
  private readonly registry: Registry;

  // Request counters
  private readonly requestsTotal: Counter;
  private readonly requestsSuccess: Counter;
  private readonly requestsFailure: Counter;

  // Request duration histogram
  private readonly requestDurationMs: Histogram;

  // Request/Response size histograms
  private readonly requestSizeBytes: Histogram;
  private readonly responseSizeBytes: Histogram;

  // Model-specific counters
  private readonly modelUsageCounter: Counter;

  // Error type counters
  private readonly errorTypeCounter: Counter;

  // Circuit breaker state gauge
  private readonly circuitBreakerState: Gauge;

  // Batch operation metrics
  private readonly batchSizeHistogram: Histogram;
  private readonly batchDurationMs: Histogram;

  // API key validation metrics
  private readonly apiKeyValidationCounter: Counter;

  // Model discovery metrics
  private readonly modelDiscoveryDurationMs: Histogram;
  private readonly modelDiscoveryCounter: Counter;

  // Cache metrics
  private readonly cacheHitCounter: Counter;
  private readonly cacheMissCounter: Counter;

  constructor(serviceName: string = 'nexus_graphrag') {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: serviceName });

    // Collect default Node.js metrics
    collectDefaultMetrics({ register: this.registry });

    // Request counters
    this.requestsTotal = new Counter({
      name: `${serviceName}_voyage_requests_total`,
      help: 'Total number of Voyage AI API requests',
      labelNames: ['operation', 'model', 'content_type'],
      registers: [this.registry]
    });

    this.requestsSuccess = new Counter({
      name: `${serviceName}_voyage_requests_success_total`,
      help: 'Total number of successful Voyage AI requests',
      labelNames: ['operation', 'model', 'content_type'],
      registers: [this.registry]
    });

    this.requestsFailure = new Counter({
      name: `${serviceName}_voyage_requests_failure_total`,
      help: 'Total number of failed Voyage AI requests',
      labelNames: ['operation', 'model', 'content_type', 'error_type'],
      registers: [this.registry]
    });

    // Request duration histogram
    this.requestDurationMs = new Histogram({
      name: `${serviceName}_voyage_request_duration_ms`,
      help: 'Voyage AI request duration in milliseconds',
      labelNames: ['operation', 'model', 'content_type'],
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
      registers: [this.registry]
    });

    // Request/Response size histograms
    this.requestSizeBytes = new Histogram({
      name: `${serviceName}_voyage_request_size_bytes`,
      help: 'Voyage AI request payload size in bytes',
      labelNames: ['operation', 'model'],
      buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
      registers: [this.registry]
    });

    this.responseSizeBytes = new Histogram({
      name: `${serviceName}_voyage_response_size_bytes`,
      help: 'Voyage AI response payload size in bytes',
      labelNames: ['operation', 'model'],
      buckets: [100, 500, 1000, 5000, 10000, 50000, 100000, 500000],
      registers: [this.registry]
    });

    // Model usage counter
    this.modelUsageCounter = new Counter({
      name: `${serviceName}_voyage_model_usage_total`,
      help: 'Total number of requests per Voyage AI model',
      labelNames: ['model', 'content_type'],
      registers: [this.registry]
    });

    // Error type counter
    this.errorTypeCounter = new Counter({
      name: `${serviceName}_voyage_errors_by_type_total`,
      help: 'Total errors by type',
      labelNames: ['error_type', 'model', 'operation'],
      registers: [this.registry]
    });

    // Circuit breaker state gauge
    this.circuitBreakerState = new Gauge({
      name: `${serviceName}_voyage_circuit_breaker_state`,
      help: 'Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
      registers: [this.registry]
    });

    // Batch operation metrics
    this.batchSizeHistogram = new Histogram({
      name: `${serviceName}_voyage_batch_size`,
      help: 'Number of items in batch requests',
      labelNames: ['model'],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500],
      registers: [this.registry]
    });

    this.batchDurationMs = new Histogram({
      name: `${serviceName}_voyage_batch_duration_ms`,
      help: 'Batch request duration in milliseconds',
      labelNames: ['model', 'batch_size_range'],
      buckets: [100, 500, 1000, 5000, 10000, 30000, 60000, 120000],
      registers: [this.registry]
    });

    // API key validation metrics
    this.apiKeyValidationCounter = new Counter({
      name: `${serviceName}_voyage_api_key_validation_total`,
      help: 'Total API key validation attempts',
      labelNames: ['result'],
      registers: [this.registry]
    });

    // Model discovery metrics
    this.modelDiscoveryDurationMs = new Histogram({
      name: `${serviceName}_voyage_model_discovery_duration_ms`,
      help: 'Model discovery operation duration in milliseconds',
      labelNames: ['cache_status'],
      buckets: [10, 50, 100, 500, 1000, 5000],
      registers: [this.registry]
    });

    this.modelDiscoveryCounter = new Counter({
      name: `${serviceName}_voyage_model_discovery_total`,
      help: 'Total model discovery operations',
      labelNames: ['cache_status', 'models_found'],
      registers: [this.registry]
    });

    // Cache metrics
    this.cacheHitCounter = new Counter({
      name: `${serviceName}_voyage_cache_hit_total`,
      help: 'Total cache hits',
      labelNames: ['cache_type'],
      registers: [this.registry]
    });

    this.cacheMissCounter = new Counter({
      name: `${serviceName}_voyage_cache_miss_total`,
      help: 'Total cache misses',
      labelNames: ['cache_type'],
      registers: [this.registry]
    });

    logger.info('[PHASE4.1-METRICS] Voyage AI metrics initialized', {
      metricsCount: this.registry.getMetricsAsArray().length
    });
  }

  /**
   * Track request start and return a function to complete tracking
   */
  trackRequest(operation: string, model: string, contentType?: string) {
    const startTime = Date.now();

    this.requestsTotal.inc({
      operation,
      model,
      content_type: contentType || 'unknown'
    });

    this.modelUsageCounter.inc({
      model,
      content_type: contentType || 'unknown'
    });

    return {
      success: (requestSizeBytes?: number, responseSizeBytes?: number) => {
        const duration = Date.now() - startTime;

        this.requestsSuccess.inc({
          operation,
          model,
          content_type: contentType || 'unknown'
        });

        this.requestDurationMs.observe(
          {
            operation,
            model,
            content_type: contentType || 'unknown'
          },
          duration
        );

        if (requestSizeBytes !== undefined) {
          this.requestSizeBytes.observe({ operation, model }, requestSizeBytes);
        }

        if (responseSizeBytes !== undefined) {
          this.responseSizeBytes.observe({ operation, model }, responseSizeBytes);
        }

        logger.debug('[PHASE4.1-METRICS] Request succeeded', {
          operation,
          model,
          contentType,
          durationMs: duration
        });
      },

      failure: (errorType: string, error?: Error) => {
        const duration = Date.now() - startTime;

        this.requestsFailure.inc({
          operation,
          model,
          content_type: contentType || 'unknown',
          error_type: errorType
        });

        this.requestDurationMs.observe(
          {
            operation,
            model,
            content_type: contentType || 'unknown'
          },
          duration
        );

        this.errorTypeCounter.inc({
          error_type: errorType,
          model,
          operation
        });

        logger.warn('[PHASE4.1-METRICS] Request failed', {
          operation,
          model,
          contentType,
          errorType,
          durationMs: duration,
          error: error?.message
        });
      }
    };
  }

  /**
   * Track batch request
   */
  trackBatchRequest(model: string, batchSize: number) {
    const startTime = Date.now();

    this.batchSizeHistogram.observe({ model }, batchSize);

    return {
      complete: (success: boolean) => {
        const duration = Date.now() - startTime;
        const batchSizeRange = this.getBatchSizeRange(batchSize);

        this.batchDurationMs.observe(
          { model, batch_size_range: batchSizeRange },
          duration
        );

        logger.info('[PHASE4.1-METRICS] Batch request completed', {
          model,
          batchSize,
          batchSizeRange,
          durationMs: duration,
          success
        });
      }
    };
  }

  /**
   * Update circuit breaker state
   */
  updateCircuitBreakerState(state: CircuitState): void {
    const stateValue = this.circuitStateToNumber(state);
    this.circuitBreakerState.set(stateValue);

    logger.info('[PHASE4.1-METRICS] Circuit breaker state updated', {
      state,
      stateValue
    });
  }

  /**
   * Track API key validation
   */
  trackApiKeyValidation(success: boolean): void {
    this.apiKeyValidationCounter.inc({
      result: success ? 'success' : 'failure'
    });

    logger.info('[PHASE4.1-METRICS] API key validation tracked', {
      success
    });
  }

  /**
   * Track model discovery operation
   */
  trackModelDiscovery(fromCache: boolean, modelsFound: number) {
    const startTime = Date.now();

    return {
      complete: () => {
        const duration = Date.now() - startTime;

        this.modelDiscoveryDurationMs.observe(
          { cache_status: fromCache ? 'hit' : 'miss' },
          duration
        );

        this.modelDiscoveryCounter.inc({
          cache_status: fromCache ? 'hit' : 'miss',
          models_found: modelsFound.toString()
        });

        logger.info('[PHASE4.1-METRICS] Model discovery completed', {
          fromCache,
          modelsFound,
          durationMs: duration
        });
      }
    };
  }

  /**
   * Track cache hit
   */
  trackCacheHit(cacheType: string): void {
    this.cacheHitCounter.inc({ cache_type: cacheType });

    logger.debug('[PHASE4.1-METRICS] Cache hit', { cacheType });
  }

  /**
   * Track cache miss
   */
  trackCacheMiss(cacheType: string): void {
    this.cacheMissCounter.inc({ cache_type: cacheType });

    logger.debug('[PHASE4.1-METRICS] Cache miss', { cacheType });
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Get metrics as JSON
   */
  async getMetricsJSON(): Promise<any[]> {
    return this.registry.getMetricsAsJSON();
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.registry.resetMetrics();
    logger.info('[PHASE4.1-METRICS] All metrics reset');
  }

  /**
   * Get registry for custom operations
   */
  getRegistry(): Registry {
    return this.registry;
  }

  // Private helper methods

  private circuitStateToNumber(state: CircuitState): number {
    switch (state) {
      case 'CLOSED':
        return 0;
      case 'OPEN':
        return 1;
      case 'HALF_OPEN':
        return 2;
      default:
        return -1;
    }
  }

  private getBatchSizeRange(size: number): string {
    if (size <= 5) return '1-5';
    if (size <= 10) return '6-10';
    if (size <= 25) return '11-25';
    if (size <= 50) return '26-50';
    if (size <= 100) return '51-100';
    if (size <= 250) return '101-250';
    return '251+';
  }
}

// Singleton instance
let voyageMetricsInstance: VoyageMetrics | null = null;

/**
 * Get or create the Voyage AI metrics instance
 */
export function getVoyageMetrics(serviceName?: string): VoyageMetrics {
  if (!voyageMetricsInstance) {
    voyageMetricsInstance = new VoyageMetrics(serviceName);
    logger.info('[PHASE4.1-METRICS] Created singleton Voyage metrics instance');
  }
  return voyageMetricsInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetVoyageMetrics(): void {
  if (voyageMetricsInstance) {
    voyageMetricsInstance.reset();
    voyageMetricsInstance = null;
    logger.info('[PHASE4.1-METRICS] Reset singleton Voyage metrics instance');
  }
}
