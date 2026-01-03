/**
 * Retry Budget & Agent Disposal Metrics
 *
 * Comprehensive monitoring for Phase 2 improvements:
 * - Retry budget exhaustion tracking
 * - Dead letter queue statistics
 * - Agent disposal success/failure rates
 * - Memory leak detection
 *
 * @module retry-disposal-metrics
 * @version 1.0.0
 */

import { logger } from '../utils/logger';
import { DisposableResource } from '../utils/disposable';
import { RetryBudgetManager } from '../retry/retry-budget-manager';
import { DeadLetterQueue } from '../retry/dead-letter-queue';

// ============================================================================
// Type Definitions
// ============================================================================

export interface RetryMetrics {
  totalBudgetChecks: number;
  budgetsExhausted: number;
  exhaustionRate: number;
  avgAttempts: number;
  avgDuration: number;
  activeBudgets: number;
}

export interface DisposalMetrics {
  totalDisposed: number;
  successfulDisposals: number;
  failedDisposals: number;
  disposalSuccessRate: number;
  avgDisposalTimeMs: number;
  undisposedResources: number;
  memoryLeaksDetected: number;
}

export interface DLQMetrics {
  totalEntries: number;
  pendingEntries: number;
  processingEntries: number;
  resolvedEntries: number;
  archivedEntries: number;
  avgAttempts: number;
  avgDuration: number;
  reasonBreakdown: Record<string, number>;
  oldestEntry?: Date;
  newestEntry?: Date;
}

export interface CombinedMetrics {
  retry: RetryMetrics;
  disposal: DisposalMetrics;
  dlq: DLQMetrics;
  timestamp: Date;
  health: 'healthy' | 'warning' | 'critical';
  alerts: string[];
}

// ============================================================================
// Metrics Collector
// ============================================================================

export class RetryDisposalMetricsCollector {
  private retryBudgetManager?: RetryBudgetManager;
  private deadLetterQueue?: DeadLetterQueue;
  private memoryLeaksDetected = 0;

  // Alert thresholds
  private readonly EXHAUSTION_RATE_WARNING = 0.1; // 10%
  private readonly EXHAUSTION_RATE_CRITICAL = 0.25; // 25%
  private readonly DISPOSAL_FAILURE_RATE_WARNING = 0.05; // 5%
  private readonly DISPOSAL_FAILURE_RATE_CRITICAL = 0.15; // 15%
  private readonly UNDISPOSED_WARNING = 10;
  private readonly UNDISPOSED_CRITICAL = 50;

  constructor(
    retryBudgetManager?: RetryBudgetManager,
    deadLetterQueue?: DeadLetterQueue
  ) {
    this.retryBudgetManager = retryBudgetManager;
    this.deadLetterQueue = deadLetterQueue;

    logger.info('RetryDisposalMetricsCollector initialized', {
      hasRetryBudgetManager: !!retryBudgetManager,
      hasDeadLetterQueue: !!deadLetterQueue,
      component: 'metrics-collector'
    });
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Collect all metrics and generate combined report.
   *
   * Performance: < 100ms
   */
  async collect(): Promise<CombinedMetrics> {
    const startTime = Date.now();

    try {
      // Collect retry metrics
      const retryMetrics = await this.collectRetryMetrics();

      // Collect disposal metrics
      const disposalMetrics = this.collectDisposalMetrics();

      // Collect DLQ metrics
      const dlqMetrics = await this.collectDLQMetrics();

      // Calculate health status and alerts
      const { health, alerts } = this.calculateHealth(retryMetrics, disposalMetrics, dlqMetrics);

      const metrics: CombinedMetrics = {
        retry: retryMetrics,
        disposal: disposalMetrics,
        dlq: dlqMetrics,
        timestamp: new Date(),
        health,
        alerts
      };

      const latency = Date.now() - startTime;

      logger.debug('Metrics collected', {
        latency,
        health,
        alertCount: alerts.length,
        component: 'metrics-collector'
      });

      return metrics;

    } catch (error) {
      logger.error('Failed to collect metrics', {
        error: error instanceof Error ? error.message : String(error),
        component: 'metrics-collector'
      });

      throw error;
    }
  }

  /**
   * Increment memory leak counter.
   *
   * Called by FinalizationRegistry when agent is GC'd without disposal.
   */
  incrementMemoryLeaks(): void {
    this.memoryLeaksDetected++;

    logger.warn('Memory leak detected', {
      totalLeaks: this.memoryLeaksDetected,
      component: 'metrics-collector'
    });
  }

  /**
   * Get current health status.
   */
  async getHealthStatus(): Promise<'healthy' | 'warning' | 'critical'> {
    const metrics = await this.collect();
    return metrics.health;
  }

  /**
   * Check if system is healthy.
   */
  async isHealthy(): Promise<boolean> {
    const health = await this.getHealthStatus();
    return health === 'healthy';
  }

  /**
   * Get active alerts.
   */
  async getActiveAlerts(): Promise<string[]> {
    const metrics = await this.collect();
    return metrics.alerts;
  }

  /**
   * Export metrics in Prometheus format.
   *
   * Useful for integration with monitoring systems.
   */
  async exportPrometheusMetrics(): Promise<string> {
    const metrics = await this.collect();
    const lines: string[] = [];

    // Retry metrics
    lines.push(`# HELP retry_budget_checks_total Total number of retry budget checks`);
    lines.push(`# TYPE retry_budget_checks_total counter`);
    lines.push(`retry_budget_checks_total ${metrics.retry.totalBudgetChecks}`);

    lines.push(`# HELP retry_budgets_exhausted_total Total number of exhausted retry budgets`);
    lines.push(`# TYPE retry_budgets_exhausted_total counter`);
    lines.push(`retry_budgets_exhausted_total ${metrics.retry.budgetsExhausted}`);

    lines.push(`# HELP retry_exhaustion_rate Current retry exhaustion rate`);
    lines.push(`# TYPE retry_exhaustion_rate gauge`);
    lines.push(`retry_exhaustion_rate ${metrics.retry.exhaustionRate.toFixed(4)}`);

    lines.push(`# HELP retry_active_budgets Current number of active retry budgets`);
    lines.push(`# TYPE retry_active_budgets gauge`);
    lines.push(`retry_active_budgets ${metrics.retry.activeBudgets}`);

    // Disposal metrics
    lines.push(`# HELP agent_disposals_total Total number of agent disposals`);
    lines.push(`# TYPE agent_disposals_total counter`);
    lines.push(`agent_disposals_total ${metrics.disposal.totalDisposed}`);

    lines.push(`# HELP agent_disposal_failures_total Total number of failed disposals`);
    lines.push(`# TYPE agent_disposal_failures_total counter`);
    lines.push(`agent_disposal_failures_total ${metrics.disposal.failedDisposals}`);

    lines.push(`# HELP agent_disposal_success_rate Current disposal success rate`);
    lines.push(`# TYPE agent_disposal_success_rate gauge`);
    lines.push(`agent_disposal_success_rate ${metrics.disposal.disposalSuccessRate.toFixed(4)}`);

    lines.push(`# HELP agent_undisposed_resources Current number of undisposed resources`);
    lines.push(`# TYPE agent_undisposed_resources gauge`);
    lines.push(`agent_undisposed_resources ${metrics.disposal.undisposedResources}`);

    lines.push(`# HELP agent_memory_leaks_detected_total Total number of memory leaks detected`);
    lines.push(`# TYPE agent_memory_leaks_detected_total counter`);
    lines.push(`agent_memory_leaks_detected_total ${metrics.disposal.memoryLeaksDetected}`);

    // DLQ metrics
    lines.push(`# HELP dlq_entries_total Total number of DLQ entries`);
    lines.push(`# TYPE dlq_entries_total counter`);
    lines.push(`dlq_entries_total ${metrics.dlq.totalEntries}`);

    lines.push(`# HELP dlq_pending_entries Current number of pending DLQ entries`);
    lines.push(`# TYPE dlq_pending_entries gauge`);
    lines.push(`dlq_pending_entries ${metrics.dlq.pendingEntries}`);

    // Health status
    const healthValue = metrics.health === 'healthy' ? 0 : metrics.health === 'warning' ? 1 : 2;
    lines.push(`# HELP system_health_status Current system health status (0=healthy, 1=warning, 2=critical)`);
    lines.push(`# TYPE system_health_status gauge`);
    lines.push(`system_health_status ${healthValue}`);

    return lines.join('\n');
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Collect retry budget metrics.
   */
  private async collectRetryMetrics(): Promise<RetryMetrics> {
    if (!this.retryBudgetManager) {
      return {
        totalBudgetChecks: 0,
        budgetsExhausted: 0,
        exhaustionRate: 0,
        avgAttempts: 0,
        avgDuration: 0,
        activeBudgets: 0
      };
    }

    const stats = this.retryBudgetManager.getAggregateStats();

    return {
      totalBudgetChecks: stats.totalBudgets + stats.exhaustedBudgets,
      budgetsExhausted: stats.exhaustedBudgets,
      exhaustionRate: stats.totalBudgets + stats.exhaustedBudgets > 0
        ? stats.exhaustedBudgets / (stats.totalBudgets + stats.exhaustedBudgets)
        : 0,
      avgAttempts: stats.avgAttempts,
      avgDuration: stats.avgDuration,
      activeBudgets: stats.totalBudgets
    };
  }

  /**
   * Collect disposal metrics.
   */
  private collectDisposalMetrics(): DisposalMetrics {
    const stats = DisposableResource.getStats();

    return {
      totalDisposed: stats.totalDisposed,
      successfulDisposals: stats.successfulDisposals,
      failedDisposals: stats.failedDisposals,
      disposalSuccessRate: stats.totalDisposed > 0
        ? stats.successfulDisposals / stats.totalDisposed
        : 1.0,
      avgDisposalTimeMs: stats.avgDisposalTimeMs,
      undisposedResources: stats.undisposedResources,
      memoryLeaksDetected: this.memoryLeaksDetected
    };
  }

  /**
   * Collect DLQ metrics.
   */
  private async collectDLQMetrics(): Promise<DLQMetrics> {
    if (!this.deadLetterQueue) {
      return {
        totalEntries: 0,
        pendingEntries: 0,
        processingEntries: 0,
        resolvedEntries: 0,
        archivedEntries: 0,
        avgAttempts: 0,
        avgDuration: 0,
        reasonBreakdown: {}
      };
    }

    return await this.deadLetterQueue.getStats();
  }

  /**
   * Calculate overall health status and generate alerts.
   */
  private calculateHealth(
    retry: RetryMetrics,
    disposal: DisposalMetrics,
    dlq: DLQMetrics
  ): { health: 'healthy' | 'warning' | 'critical'; alerts: string[] } {
    const alerts: string[] = [];
    let health: 'healthy' | 'warning' | 'critical' = 'healthy';

    // Check retry exhaustion rate
    if (retry.exhaustionRate >= this.EXHAUSTION_RATE_CRITICAL) {
      health = 'critical';
      alerts.push(
        `CRITICAL: Retry exhaustion rate is ${(retry.exhaustionRate * 100).toFixed(1)}% ` +
        `(threshold: ${this.EXHAUSTION_RATE_CRITICAL * 100}%)`
      );
    } else if (retry.exhaustionRate >= this.EXHAUSTION_RATE_WARNING) {
      health = health === 'healthy' ? 'warning' : health;
      alerts.push(
        `WARNING: Retry exhaustion rate is ${(retry.exhaustionRate * 100).toFixed(1)}% ` +
        `(threshold: ${this.EXHAUSTION_RATE_WARNING * 100}%)`
      );
    }

    // Check disposal failure rate
    const disposalFailureRate = 1.0 - disposal.disposalSuccessRate;
    if (disposalFailureRate >= this.DISPOSAL_FAILURE_RATE_CRITICAL) {
      health = 'critical';
      alerts.push(
        `CRITICAL: Disposal failure rate is ${(disposalFailureRate * 100).toFixed(1)}% ` +
        `(threshold: ${this.DISPOSAL_FAILURE_RATE_CRITICAL * 100}%)`
      );
    } else if (disposalFailureRate >= this.DISPOSAL_FAILURE_RATE_WARNING) {
      health = health === 'healthy' ? 'warning' : health;
      alerts.push(
        `WARNING: Disposal failure rate is ${(disposalFailureRate * 100).toFixed(1)}% ` +
        `(threshold: ${this.DISPOSAL_FAILURE_RATE_WARNING * 100}%)`
      );
    }

    // Check undisposed resources
    if (disposal.undisposedResources >= this.UNDISPOSED_CRITICAL) {
      health = 'critical';
      alerts.push(
        `CRITICAL: ${disposal.undisposedResources} undisposed resources ` +
        `(threshold: ${this.UNDISPOSED_CRITICAL})`
      );
    } else if (disposal.undisposedResources >= this.UNDISPOSED_WARNING) {
      health = health === 'healthy' ? 'warning' : health;
      alerts.push(
        `WARNING: ${disposal.undisposedResources} undisposed resources ` +
        `(threshold: ${this.UNDISPOSED_WARNING})`
      );
    }

    // Check memory leaks
    if (disposal.memoryLeaksDetected > 0) {
      health = health === 'healthy' ? 'warning' : health;
      alerts.push(
        `WARNING: ${disposal.memoryLeaksDetected} memory leaks detected ` +
        `(agents garbage collected without disposal)`
      );
    }

    // Check DLQ pending entries
    if (dlq.pendingEntries > 100) {
      health = 'critical';
      alerts.push(
        `CRITICAL: ${dlq.pendingEntries} pending DLQ entries require attention`
      );
    } else if (dlq.pendingEntries > 20) {
      health = health === 'healthy' ? 'warning' : health;
      alerts.push(
        `WARNING: ${dlq.pendingEntries} pending DLQ entries`
      );
    }

    return { health, alerts };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalMetricsCollector: RetryDisposalMetricsCollector | null = null;

/**
 * Initialize global metrics collector.
 */
export function initializeMetricsCollector(
  retryBudgetManager?: RetryBudgetManager,
  deadLetterQueue?: DeadLetterQueue
): void {
  globalMetricsCollector = new RetryDisposalMetricsCollector(
    retryBudgetManager,
    deadLetterQueue
  );

  logger.info('Global metrics collector initialized', {
    component: 'metrics-collector'
  });
}

/**
 * Get global metrics collector instance.
 *
 * Throws if not initialized.
 */
export function getMetricsCollector(): RetryDisposalMetricsCollector {
  if (!globalMetricsCollector) {
    throw new Error(
      'Metrics collector not initialized. Call initializeMetricsCollector() first.'
    );
  }

  return globalMetricsCollector;
}

/**
 * Export metrics endpoint handler for Express.
 *
 * Example:
 * ```typescript
 * app.get('/metrics', metricsEndpoint);
 * ```
 */
export async function metricsEndpoint(_req: any, res: any): Promise<void> {
  try {
    const collector = getMetricsCollector();
    const prometheusMetrics = await collector.exportPrometheusMetrics();

    res.set('Content-Type', 'text/plain; version=0.0.4');
    res.send(prometheusMetrics);

  } catch (error) {
    logger.error('Failed to export metrics', {
      error: error instanceof Error ? error.message : String(error),
      component: 'metrics-collector'
    });

    res.status(500).json({
      error: 'Failed to export metrics',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
