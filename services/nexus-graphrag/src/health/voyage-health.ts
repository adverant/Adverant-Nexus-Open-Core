/**
 * Voyage AI Health Check Module
 * Phase 5.1: Comprehensive health endpoint for Voyage AI integration
 *
 * Provides detailed health status including:
 * - API connectivity
 * - Model availability
 * - Circuit breaker state
 * - Metrics summary
 * - Configuration validation
 */

import { VoyageAIUnifiedClient } from '../clients/voyage-ai-unified-client';
import { voyageCircuitBreaker, CircuitState } from '../utils/circuit-breaker';
import { getVoyageMetrics } from '../metrics/voyage-metrics';
import { logger } from '../utils/logger';
import { config } from '../config';

// Check if fail-fast is enabled for Voyage AI (defaults to true for production safety)
const VOYAGE_FAIL_FAST = process.env.VOYAGE_FAIL_FAST !== 'false';

export interface VoyageHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  responseTimeMs: number;
  details: {
    apiConnectivity: {
      status: 'ok' | 'error';
      latencyMs?: number;
      error?: string;
    };
    circuitBreaker: {
      state: string;
      isOpen: boolean;
      stats: {
        totalRequests: number;
        successfulRequests: number;
        failedRequests: number;
        errorRate: number;
      };
    };
    models: {
      available: number;
      tested: number;
      healthy: number;
      unhealthy: string[];
    };
    configuration: {
      apiKeyConfigured: boolean;
      failFastEnabled: boolean;
      baseUrl: string;
    };
    metrics?: {
      requestsTotal: number;
      requestsSuccess: number;
      requestsFailure: number;
      avgLatencyMs: number;
    };
  };
}

export class VoyageHealthChecker {
  private client: VoyageAIUnifiedClient | null = null;
  private metrics = getVoyageMetrics();

  constructor() {
    // Lazy initialization - client created on first check
  }

  /**
   * Perform comprehensive health check
   */
  async check(options: { includeModelTest?: boolean; timeout?: number } = {}): Promise<VoyageHealthStatus> {
    const startTime = Date.now();
    const { includeModelTest = false, timeout = 10000 } = options;

    logger.info('[PHASE5.1-HEALTH] Starting Voyage AI health check', {
      includeModelTest,
      timeout
    });

    const result: VoyageHealthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      responseTimeMs: 0,
      details: {
        apiConnectivity: { status: 'ok' },
        circuitBreaker: {
          state: 'UNKNOWN',
          isOpen: false,
          stats: {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            errorRate: 0
          }
        },
        models: {
          available: 0,
          tested: 0,
          healthy: 0,
          unhealthy: []
        },
        configuration: {
          apiKeyConfigured: false,
          failFastEnabled: VOYAGE_FAIL_FAST,
          baseUrl: 'https://api.voyageai.com/v1'
        }
      }
    };

    try {
      // Check configuration
      const apiKey = config.voyageAI.apiKey;
      result.details.configuration.apiKeyConfigured = !!apiKey && apiKey.length > 0;
      result.details.configuration.failFastEnabled = VOYAGE_FAIL_FAST;

      if (!result.details.configuration.apiKeyConfigured) {
        result.status = 'unhealthy';
        result.details.apiConnectivity = {
          status: 'error',
          error: 'VOYAGE_API_KEY not configured'
        };
        result.responseTimeMs = Date.now() - startTime;
        return result;
      }

      // Initialize client if needed
      if (!this.client) {
        this.client = new VoyageAIUnifiedClient(apiKey!);
      }

      // Check circuit breaker state using getMetrics()
      const cbMetrics = voyageCircuitBreaker.getMetrics();
      result.details.circuitBreaker = {
        state: cbMetrics.state,
        isOpen: cbMetrics.state === CircuitState.OPEN,
        stats: {
          totalRequests: cbMetrics.failureCount + cbMetrics.successCount,
          successfulRequests: cbMetrics.successCount,
          failedRequests: cbMetrics.failureCount,
          errorRate: (cbMetrics.failureCount + cbMetrics.successCount) > 0
            ? (cbMetrics.failureCount / (cbMetrics.failureCount + cbMetrics.successCount)) * 100
            : 0
        }
      };

      // If circuit breaker is open, mark as degraded
      if (cbMetrics.state === CircuitState.OPEN) {
        result.status = 'degraded';
        result.details.apiConnectivity = {
          status: 'error',
          error: 'Circuit breaker is OPEN - API temporarily unavailable'
        };
      }

      // Test API connectivity with timeout
      const connectivityStart = Date.now();
      try {
        const availableModels = await Promise.race([
          this.client.getAvailableModels(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Health check timeout')), timeout)
          )
        ]);

        result.details.apiConnectivity = {
          status: 'ok',
          latencyMs: Date.now() - connectivityStart
        };

        result.details.models.available = availableModels.length;

        // Optionally test individual models
        if (includeModelTest && availableModels.length > 0) {
          const modelResults = await this.client.testConnection();
          const healthyModels = Object.entries(modelResults).filter(([, ok]) => ok);
          const unhealthyModels = Object.entries(modelResults).filter(([, ok]) => !ok);

          result.details.models.tested = Object.keys(modelResults).length;
          result.details.models.healthy = healthyModels.length;
          result.details.models.unhealthy = unhealthyModels.map(([id]) => id);

          if (unhealthyModels.length > 0 && healthyModels.length > 0) {
            result.status = 'degraded';
          } else if (unhealthyModels.length > 0 && healthyModels.length === 0) {
            result.status = 'unhealthy';
          }
        }
      } catch (error: any) {
        result.details.apiConnectivity = {
          status: 'error',
          latencyMs: Date.now() - connectivityStart,
          error: error.message || 'API connectivity test failed'
        };
        result.status = 'unhealthy';
      }

      // Get metrics summary
      try {
        const metricsJson = await this.metrics.getMetricsJSON();
        const requestsTotal = metricsJson.find((m: any) => m.name.includes('requests_total'));
        const requestsSuccess = metricsJson.find((m: any) => m.name.includes('requests_success_total'));
        const requestsFailure = metricsJson.find((m: any) => m.name.includes('requests_failure_total'));
        const requestDuration = metricsJson.find((m: any) => m.name.includes('request_duration_ms'));

        if (requestsTotal || requestsSuccess || requestsFailure) {
          result.details.metrics = {
            requestsTotal: this.sumMetricValues(requestsTotal),
            requestsSuccess: this.sumMetricValues(requestsSuccess),
            requestsFailure: this.sumMetricValues(requestsFailure),
            avgLatencyMs: this.getAverageFromHistogram(requestDuration)
          };
        }
      } catch (error) {
        // Metrics are optional, don't fail health check
        logger.debug('[PHASE5.1-HEALTH] Failed to get metrics summary', { error });
      }

    } catch (error: any) {
      result.status = 'unhealthy';
      result.details.apiConnectivity = {
        status: 'error',
        error: error.message || 'Unknown error during health check'
      };
    }

    result.responseTimeMs = Date.now() - startTime;

    logger.info('[PHASE5.1-HEALTH] Voyage AI health check completed', {
      status: result.status,
      responseTimeMs: result.responseTimeMs,
      modelsAvailable: result.details.models.available
    });

    return result;
  }

  /**
   * Quick health check - minimal overhead
   */
  async quickCheck(): Promise<{ status: 'ok' | 'error'; message: string }> {
    try {
      // Check API key
      if (!config.voyageAI.apiKey) {
        return { status: 'error', message: 'VOYAGE_API_KEY not configured' };
      }

      // Check circuit breaker using getMetrics()
      const cbMetrics = voyageCircuitBreaker.getMetrics();
      if (cbMetrics.state === CircuitState.OPEN) {
        return { status: 'error', message: 'Circuit breaker is OPEN' };
      }

      return { status: 'ok', message: 'Voyage AI is operational' };
    } catch (error: any) {
      return { status: 'error', message: error.message || 'Health check failed' };
    }
  }

  // Helper methods

  private sumMetricValues(metric: any): number {
    if (!metric?.values) return 0;
    return metric.values.reduce((sum: number, v: any) => sum + (v.value || 0), 0);
  }

  private getAverageFromHistogram(metric: any): number {
    if (!metric?.values) return 0;
    const sums = metric.values.filter((v: any) => v.metricName?.endsWith('_sum'));
    const counts = metric.values.filter((v: any) => v.metricName?.endsWith('_count'));

    if (sums.length === 0 || counts.length === 0) return 0;

    const totalSum = sums.reduce((s: number, v: any) => s + (v.value || 0), 0);
    const totalCount = counts.reduce((c: number, v: any) => c + (v.value || 0), 0);

    return totalCount > 0 ? Math.round(totalSum / totalCount) : 0;
  }
}

// Singleton instance
let healthCheckerInstance: VoyageHealthChecker | null = null;

/**
 * Get or create the Voyage AI health checker instance
 */
export function getVoyageHealthChecker(): VoyageHealthChecker {
  if (!healthCheckerInstance) {
    healthCheckerInstance = new VoyageHealthChecker();
    logger.info('[PHASE5.1-HEALTH] Created singleton Voyage health checker instance');
  }
  return healthCheckerInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetVoyageHealthChecker(): void {
  healthCheckerInstance = null;
  logger.info('[PHASE5.1-HEALTH] Reset singleton Voyage health checker instance');
}
