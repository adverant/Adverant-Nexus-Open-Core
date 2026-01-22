/**
 * Context Monitor - Phase 4 Implementation
 *
 * Provides monitoring, metrics, and adaptive relevance tuning for
 * the context management system.
 *
 * @module context-monitor
 */

import { logger } from '../utils/logger.js';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ContextMetrics {
  totalInjections: number;
  successfulInjections: number;
  timedOutInjections: number;
  averageLatency: number;
  cacheHitRate: number;
  storageEvents: StorageMetrics;
  performance: PerformanceMetrics;
}

export interface StorageMetrics {
  episodesStored: number;
  documentsStored: number;
  memoriesStored: number;
  patternsStored: number;
  checkpointsCreated: number;
  storageFailures: number;
}

export interface PerformanceMetrics {
  averageInjectionLatency: number;
  p95InjectionLatency: number;
  p99InjectionLatency: number;
  cacheHitRate: number;
  retrievalSuccessRate: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
  timestamp: string;
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  value?: any;
  threshold?: any;
}

export interface AdaptiveConfig {
  relevanceThreshold: number; // 0-1
  maxContextTokens: number;
  injectionTimeout: number;
  cacheEnabled: boolean;
}

// ============================================================================
// CONTEXT MONITOR CLASS
// ============================================================================

export class ContextMonitor {
  private metrics: ContextMetrics;
  private latencies: number[] = [];
  private maxLatencyHistory: number = 1000;
  private adaptiveConfig: AdaptiveConfig;

  constructor() {
    this.metrics = {
      totalInjections: 0,
      successfulInjections: 0,
      timedOutInjections: 0,
      averageLatency: 0,
      cacheHitRate: 0,
      storageEvents: {
        episodesStored: 0,
        documentsStored: 0,
        memoriesStored: 0,
        patternsStored: 0,
        checkpointsCreated: 0,
        storageFailures: 0
      },
      performance: {
        averageInjectionLatency: 0,
        p95InjectionLatency: 0,
        p99InjectionLatency: 0,
        cacheHitRate: 0,
        retrievalSuccessRate: 0
      }
    };

    this.adaptiveConfig = {
      relevanceThreshold: 0.7,
      maxContextTokens: 2000,
      injectionTimeout: 50,
      cacheEnabled: true
    };

    logger.info('ContextMonitor initialized');
  }

  // ============================================================================
  // METRICS RECORDING
  // ============================================================================

  /**
   * Record context injection attempt
   */
  recordInjection(latency: number, success: boolean, timedOut: boolean): void {
    this.metrics.totalInjections++;

    if (success) {
      this.metrics.successfulInjections++;
    }

    if (timedOut) {
      this.metrics.timedOutInjections++;
    }

    // Track latency
    this.latencies.push(latency);
    if (this.latencies.length > this.maxLatencyHistory) {
      this.latencies.shift();
    }

    // Update average
    this.metrics.averageLatency = this.calculateAverage(this.latencies);

    // Update performance metrics
    this.updatePerformanceMetrics();
  }

  /**
   * Record storage event
   */
  recordStorage(type: 'episode' | 'document' | 'memory' | 'pattern' | 'checkpoint', success: boolean): void {
    if (success) {
      switch (type) {
        case 'episode':
          this.metrics.storageEvents.episodesStored++;
          break;
        case 'document':
          this.metrics.storageEvents.documentsStored++;
          break;
        case 'memory':
          this.metrics.storageEvents.memoriesStored++;
          break;
        case 'pattern':
          this.metrics.storageEvents.patternsStored++;
          break;
        case 'checkpoint':
          this.metrics.storageEvents.checkpointsCreated++;
          break;
      }
    } else {
      this.metrics.storageEvents.storageFailures++;
    }
  }

  /**
   * Record cache hit/miss
   */
  recordCacheAccess(hit: boolean): void {
    // Simple exponential moving average
    const hitValue = hit ? 1 : 0;
    this.metrics.cacheHitRate = 0.9 * this.metrics.cacheHitRate + 0.1 * hitValue;
  }

  // ============================================================================
  // HEALTH MONITORING
  // ============================================================================

  /**
   * Get current health status
   */
  getHealthStatus(): HealthStatus {
    const checks: HealthCheck[] = [];

    // Check 1: Injection success rate
    const successRate = this.metrics.totalInjections > 0
      ? this.metrics.successfulInjections / this.metrics.totalInjections
      : 1;

    checks.push({
      name: 'Injection Success Rate',
      status: successRate > 0.9 ? 'pass' : successRate > 0.7 ? 'warn' : 'fail',
      message: `${(successRate * 100).toFixed(1)}% successful injections`,
      value: successRate,
      threshold: 0.9
    });

    // Check 2: Average latency
    checks.push({
      name: 'Injection Latency',
      status: this.metrics.averageLatency < 50 ? 'pass' : this.metrics.averageLatency < 100 ? 'warn' : 'fail',
      message: `${this.metrics.averageLatency.toFixed(1)}ms average latency`,
      value: this.metrics.averageLatency,
      threshold: 50
    });

    // Check 3: Timeout rate
    const timeoutRate = this.metrics.totalInjections > 0
      ? this.metrics.timedOutInjections / this.metrics.totalInjections
      : 0;

    checks.push({
      name: 'Timeout Rate',
      status: timeoutRate < 0.1 ? 'pass' : timeoutRate < 0.3 ? 'warn' : 'fail',
      message: `${(timeoutRate * 100).toFixed(1)}% timeouts`,
      value: timeoutRate,
      threshold: 0.1
    });

    // Check 4: Storage success
    const totalStorage = this.metrics.storageEvents.episodesStored +
      this.metrics.storageEvents.documentsStored +
      this.metrics.storageEvents.memoriesStored +
      this.metrics.storageEvents.patternsStored;

    const storageFailureRate = totalStorage > 0
      ? this.metrics.storageEvents.storageFailures / (totalStorage + this.metrics.storageEvents.storageFailures)
      : 0;

    checks.push({
      name: 'Storage Health',
      status: storageFailureRate < 0.05 ? 'pass' : storageFailureRate < 0.15 ? 'warn' : 'fail',
      message: `${(storageFailureRate * 100).toFixed(1)}% storage failures`,
      value: storageFailureRate,
      threshold: 0.05
    });

    // Check 5: Cache performance
    checks.push({
      name: 'Cache Performance',
      status: this.metrics.cacheHitRate > 0.5 ? 'pass' : this.metrics.cacheHitRate > 0.2 ? 'warn' : 'fail',
      message: `${(this.metrics.cacheHitRate * 100).toFixed(1)}% cache hit rate`,
      value: this.metrics.cacheHitRate,
      threshold: 0.5
    });

    // Determine overall status
    const hasFailures = checks.some(c => c.status === 'fail');
    const hasWarnings = checks.some(c => c.status === 'warn');

    return {
      status: hasFailures ? 'unhealthy' : hasWarnings ? 'degraded' : 'healthy',
      checks,
      timestamp: new Date().toISOString()
    };
  }

  // ============================================================================
  // ADAPTIVE TUNING
  // ============================================================================

  /**
   * Adapt configuration based on performance metrics
   */
  adaptConfiguration(): void {
    const health = this.getHealthStatus();

    // Adapt timeout based on latency
    if (this.metrics.averageLatency > 45 && this.adaptiveConfig.injectionTimeout < 100) {
      this.adaptiveConfig.injectionTimeout += 10;
      logger.info(`Adapted injection timeout to ${this.adaptiveConfig.injectionTimeout}ms due to high latency`);
    } else if (this.metrics.averageLatency < 30 && this.adaptiveConfig.injectionTimeout > 50) {
      this.adaptiveConfig.injectionTimeout -= 5;
      logger.info(`Adapted injection timeout to ${this.adaptiveConfig.injectionTimeout}ms due to low latency`);
    }

    // Adapt relevance threshold based on success rate
    const successRate = this.metrics.totalInjections > 0
      ? this.metrics.successfulInjections / this.metrics.totalInjections
      : 1;

    if (successRate < 0.8 && this.adaptiveConfig.relevanceThreshold > 0.5) {
      this.adaptiveConfig.relevanceThreshold -= 0.05;
      logger.info(`Lowered relevance threshold to ${this.adaptiveConfig.relevanceThreshold} to improve success rate`);
    } else if (successRate > 0.95 && this.adaptiveConfig.relevanceThreshold < 0.85) {
      this.adaptiveConfig.relevanceThreshold += 0.05;
      logger.info(`Raised relevance threshold to ${this.adaptiveConfig.relevanceThreshold} for better precision`);
    }

    // Disable cache if performance is poor
    if (this.metrics.cacheHitRate < 0.1 && this.adaptiveConfig.cacheEnabled) {
      this.adaptiveConfig.cacheEnabled = false;
      logger.warn('Disabled cache due to poor hit rate');
    } else if (this.metrics.cacheHitRate > 0.3 && !this.adaptiveConfig.cacheEnabled) {
      this.adaptiveConfig.cacheEnabled = true;
      logger.info('Re-enabled cache due to improved hit rate');
    }
  }

  /**
   * Get adaptive configuration
   */
  getAdaptiveConfig(): AdaptiveConfig {
    return { ...this.adaptiveConfig };
  }

  /**
   * Manually update adaptive configuration
   */
  updateAdaptiveConfig(updates: Partial<AdaptiveConfig>): void {
    this.adaptiveConfig = {
      ...this.adaptiveConfig,
      ...updates
    };

    logger.info('Adaptive configuration updated:', this.adaptiveConfig);
  }

  // ============================================================================
  // METRICS REPORTING
  // ============================================================================

  /**
   * Get current metrics
   */
  getMetrics(): ContextMetrics {
    return { ...this.metrics };
  }

  /**
   * Get performance summary
   */
  getPerformanceSummary(): string {
    const health = this.getHealthStatus();

    return `
Context Management Performance Summary
========================================

Status: ${health.status.toUpperCase()}

Injection Metrics:
- Total: ${this.metrics.totalInjections}
- Successful: ${this.metrics.successfulInjections} (${((this.metrics.successfulInjections / Math.max(this.metrics.totalInjections, 1)) * 100).toFixed(1)}%)
- Timed Out: ${this.metrics.timedOutInjections} (${((this.metrics.timedOutInjections / Math.max(this.metrics.totalInjections, 1)) * 100).toFixed(1)}%)
- Avg Latency: ${this.metrics.averageLatency.toFixed(1)}ms
- P95 Latency: ${this.metrics.performance.p95InjectionLatency.toFixed(1)}ms
- P99 Latency: ${this.metrics.performance.p99InjectionLatency.toFixed(1)}ms

Storage Metrics:
- Episodes: ${this.metrics.storageEvents.episodesStored}
- Documents: ${this.metrics.storageEvents.documentsStored}
- Memories: ${this.metrics.storageEvents.memoriesStored}
- Patterns: ${this.metrics.storageEvents.patternsStored}
- Checkpoints: ${this.metrics.storageEvents.checkpointsCreated}
- Failures: ${this.metrics.storageEvents.storageFailures}

Cache Performance:
- Hit Rate: ${(this.metrics.cacheHitRate * 100).toFixed(1)}%

Adaptive Configuration:
- Relevance Threshold: ${this.adaptiveConfig.relevanceThreshold}
- Max Context Tokens: ${this.adaptiveConfig.maxContextTokens}
- Injection Timeout: ${this.adaptiveConfig.injectionTimeout}ms
- Cache Enabled: ${this.adaptiveConfig.cacheEnabled}

Health Checks:
${health.checks.map(c => `- ${c.name}: ${c.status.toUpperCase()} - ${c.message}`).join('\n')}
`;
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalInjections: 0,
      successfulInjections: 0,
      timedOutInjections: 0,
      averageLatency: 0,
      cacheHitRate: 0,
      storageEvents: {
        episodesStored: 0,
        documentsStored: 0,
        memoriesStored: 0,
        patternsStored: 0,
        checkpointsCreated: 0,
        storageFailures: 0
      },
      performance: {
        averageInjectionLatency: 0,
        p95InjectionLatency: 0,
        p99InjectionLatency: 0,
        cacheHitRate: 0,
        retrievalSuccessRate: 0
      }
    };

    this.latencies = [];

    logger.info('Metrics reset');
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Calculate average of array
   */
  private calculateAverage(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
  }

  /**
   * Calculate percentile
   */
  private calculatePercentile(arr: number[], percentile: number): number {
    if (arr.length === 0) return 0;

    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;

    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(): void {
    this.metrics.performance.averageInjectionLatency = this.calculateAverage(this.latencies);
    this.metrics.performance.p95InjectionLatency = this.calculatePercentile(this.latencies, 95);
    this.metrics.performance.p99InjectionLatency = this.calculatePercentile(this.latencies, 99);
    this.metrics.performance.cacheHitRate = this.metrics.cacheHitRate;

    const retrievalSuccessRate = this.metrics.totalInjections > 0
      ? this.metrics.successfulInjections / this.metrics.totalInjections
      : 0;
    this.metrics.performance.retrievalSuccessRate = retrievalSuccessRate;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let monitorInstance: ContextMonitor | null = null;

/**
 * Get singleton monitor instance
 */
export function getContextMonitor(): ContextMonitor {
  if (!monitorInstance) {
    monitorInstance = new ContextMonitor();
  }
  return monitorInstance;
}

// ============================================================================
// EXPORTS
// ============================================================================

export default ContextMonitor;
