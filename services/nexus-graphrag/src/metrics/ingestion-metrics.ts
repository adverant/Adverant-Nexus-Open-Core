/**
 * Ingestion Quality Metrics Tracker
 *
 * Tracks document ingestion quality metrics:
 * - Deduplication rate
 * - Ingestion success/failure rate
 * - Average document size
 * - Chunking performance
 * - Vector embedding success rate
 */

import { logger } from '../utils/logger';

export interface IngestionMetric {
  timestamp: Date;
  operation: 'store_document' | 'store_episode' | 'store_entity';
  success: boolean;
  duplicate: boolean;
  documentSize?: number;
  chunkCount?: number;
  processingTime: number;
  error?: string;
}

export interface MetricsSummary {
  totalIngestions: number;
  successCount: number;
  failureCount: number;
  duplicateCount: number;
  successRate: number;
  deduplicationRate: number;
  avgDocumentSize: number;
  avgChunkCount: number;
  avgProcessingTime: number;
  timeRange: {
    start: Date;
    end: Date;
  };
}

/**
 * Ingestion Metrics Manager
 * Tracks and aggregates ingestion quality metrics
 */
export class IngestionMetricsManager {
  private metrics: IngestionMetric[] = [];
  private readonly MAX_METRICS = 10000; // Keep last 10k metrics
  private readonly RETENTION_HOURS = 24; // Retain metrics for 24 hours

  /**
   * Record an ingestion event
   */
  recordIngestion(metric: Omit<IngestionMetric, 'timestamp'>): void {
    const fullMetric: IngestionMetric = {
      ...metric,
      timestamp: new Date()
    };

    this.metrics.push(fullMetric);

    // Log significant events
    if (!metric.success) {
      logger.warn('Ingestion failed', {
        operation: metric.operation,
        error: metric.error
      });
    } else if (metric.duplicate) {
      logger.debug('Duplicate document detected', {
        operation: metric.operation
      });
    } else {
      logger.debug('Ingestion successful', {
        operation: metric.operation,
        processingTime: `${metric.processingTime}ms`
      });
    }

    // Cleanup old metrics
    this.cleanupOldMetrics();
  }

  /**
   * Get metrics summary for a time range
   */
  getSummary(hoursBack: number = 24): MetricsSummary {
    const now = new Date();
    const startTime = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

    // Filter metrics in time range
    const relevantMetrics = this.metrics.filter(
      m => m.timestamp >= startTime && m.timestamp <= now
    );

    if (relevantMetrics.length === 0) {
      return {
        totalIngestions: 0,
        successCount: 0,
        failureCount: 0,
        duplicateCount: 0,
        successRate: 0,
        deduplicationRate: 0,
        avgDocumentSize: 0,
        avgChunkCount: 0,
        avgProcessingTime: 0,
        timeRange: { start: startTime, end: now }
      };
    }

    // Calculate metrics
    const totalIngestions = relevantMetrics.length;
    const successCount = relevantMetrics.filter(m => m.success).length;
    const failureCount = relevantMetrics.filter(m => !m.success).length;
    const duplicateCount = relevantMetrics.filter(m => m.duplicate).length;

    const successRate = (successCount / totalIngestions) * 100;
    const deduplicationRate = (duplicateCount / totalIngestions) * 100;

    // Calculate averages (excluding nulls)
    const documentsWithSize = relevantMetrics.filter(m => m.documentSize !== undefined);
    const avgDocumentSize = documentsWithSize.length > 0
      ? documentsWithSize.reduce((sum, m) => sum + (m.documentSize || 0), 0) / documentsWithSize.length
      : 0;

    const documentsWithChunks = relevantMetrics.filter(m => m.chunkCount !== undefined);
    const avgChunkCount = documentsWithChunks.length > 0
      ? documentsWithChunks.reduce((sum, m) => sum + (m.chunkCount || 0), 0) / documentsWithChunks.length
      : 0;

    const avgProcessingTime = relevantMetrics.reduce((sum, m) => sum + m.processingTime, 0) / totalIngestions;

    return {
      totalIngestions,
      successCount,
      failureCount,
      duplicateCount,
      successRate,
      deduplicationRate,
      avgDocumentSize,
      avgChunkCount,
      avgProcessingTime,
      timeRange: { start: startTime, end: now }
    };
  }

  /**
   * Get recent failures for debugging
   */
  getRecentFailures(limit: number = 10): IngestionMetric[] {
    return this.metrics
      .filter(m => !m.success)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get recent duplicates
   */
  getRecentDuplicates(limit: number = 10): IngestionMetric[] {
    return this.metrics
      .filter(m => m.duplicate)
      .slice(-limit)
      .reverse();
  }

  /**
   * Get performance percentiles
   */
  getPerformancePercentiles(): {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  } {
    if (this.metrics.length === 0) {
      return { p50: 0, p90: 0, p95: 0, p99: 0 };
    }

    const sortedTimes = this.metrics
      .map(m => m.processingTime)
      .sort((a, b) => a - b);

    const getPercentile = (p: number): number => {
      const index = Math.ceil((p / 100) * sortedTimes.length) - 1;
      return sortedTimes[Math.max(0, index)];
    };

    return {
      p50: getPercentile(50),
      p90: getPercentile(90),
      p95: getPercentile(95),
      p99: getPercentile(99)
    };
  }

  /**
   * Get metrics by operation type
   */
  getMetricsByOperation(): Record<string, MetricsSummary> {
    const operations = ['store_document', 'store_episode', 'store_entity'] as const;
    const result: Record<string, MetricsSummary> = {};

    for (const operation of operations) {
      const operationMetrics = this.metrics.filter(m => m.operation === operation);

      if (operationMetrics.length === 0) {
        continue;
      }

      const successCount = operationMetrics.filter(m => m.success).length;
      const duplicateCount = operationMetrics.filter(m => m.duplicate).length;
      const totalIngestions = operationMetrics.length;

      result[operation] = {
        totalIngestions,
        successCount,
        failureCount: operationMetrics.filter(m => !m.success).length,
        duplicateCount,
        successRate: (successCount / totalIngestions) * 100,
        deduplicationRate: (duplicateCount / totalIngestions) * 100,
        avgDocumentSize: 0, // Could calculate if needed
        avgChunkCount: 0,
        avgProcessingTime: operationMetrics.reduce((sum, m) => sum + m.processingTime, 0) / totalIngestions,
        timeRange: {
          start: operationMetrics[0].timestamp,
          end: operationMetrics[operationMetrics.length - 1].timestamp
        }
      };
    }

    return result;
  }

  /**
   * Cleanup old metrics beyond retention period
   */
  private cleanupOldMetrics(): void {
    // Remove metrics beyond max count
    if (this.metrics.length > this.MAX_METRICS) {
      const removeCount = this.metrics.length - this.MAX_METRICS;
      this.metrics.splice(0, removeCount);
      logger.debug('Cleaned up old metrics', { removed: removeCount });
    }

    // Remove metrics beyond retention period
    const cutoffTime = new Date(Date.now() - this.RETENTION_HOURS * 60 * 60 * 1000);
    const originalLength = this.metrics.length;
    this.metrics = this.metrics.filter(m => m.timestamp >= cutoffTime);

    const removedCount = originalLength - this.metrics.length;
    if (removedCount > 0) {
      logger.debug('Removed expired metrics', { removed: removedCount });
    }
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.metrics = [];
    logger.info('Metrics reset');
  }

  /**
   * Get raw metrics (for export/analysis)
   */
  getRawMetrics(limit?: number): IngestionMetric[] {
    if (limit) {
      return this.metrics.slice(-limit);
    }
    return [...this.metrics];
  }
}

// Export singleton instance
export const ingestionMetrics = new IngestionMetricsManager();
