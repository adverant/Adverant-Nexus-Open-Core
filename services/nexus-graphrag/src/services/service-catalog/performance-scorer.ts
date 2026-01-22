/**
 * Performance Scorer
 *
 * Calculates composite scores for services based on:
 * - Health status
 * - Latency performance
 * - Reliability (success rate)
 * - Throughput (current load)
 * - Recency (freshness of last use)
 * - User satisfaction (feedback signals)
 */

import {
  ServiceScore,
  ScoringWeights,
  DEFAULT_SCORING_WEIGHTS,
  PerformanceMetrics,
  ServiceStatus,
} from './types.js';
import { ServiceCatalogRepository } from './service-catalog-repository.js';

/**
 * Performance Scorer Service
 */
export class PerformanceScorer {
  private repository: ServiceCatalogRepository;
  private weights: ScoringWeights;

  // Cache for scores with TTL
  private scoreCache: Map<string, { score: ServiceScore; expiry: number }> = new Map();
  private cacheTtlMs = 60000; // 1 minute cache

  // Target latency for scoring (2 seconds)
  private targetLatencyMs = 2000;

  constructor(repository: ServiceCatalogRepository, weights?: ScoringWeights) {
    this.repository = repository;
    this.weights = weights || DEFAULT_SCORING_WEIGHTS;
  }

  /**
   * Calculate score for a service
   */
  async calculateScore(serviceId: string): Promise<ServiceScore> {
    // Check cache
    const cached = this.scoreCache.get(serviceId);
    if (cached && cached.expiry > Date.now()) {
      return cached.score;
    }

    // Get service and metrics
    const service = await this.repository.getService(serviceId);
    if (!service) {
      return this.defaultScore();
    }

    const metrics = await this.repository.getMetrics(serviceId, 'daily', 7);

    // Calculate individual scores
    const healthScore = this.calculateHealthScore(service.structuredData.status);
    const latencyScore = this.calculateLatencyScore(metrics);
    const reliabilityScore = this.calculateReliabilityScore(metrics);
    const throughputScore = this.calculateThroughputScore(metrics, service);
    const recencyScore = this.calculateRecencyScore(service);
    const satisfactionScore = this.calculateSatisfactionScore(); // Default for now

    // Calculate composite score
    const compositeScore =
      this.weights.health * healthScore +
      this.weights.latency * latencyScore +
      this.weights.reliability * reliabilityScore +
      this.weights.throughput * throughputScore +
      this.weights.recency * recencyScore +
      this.weights.satisfaction * satisfactionScore;

    const score: ServiceScore = {
      healthScore,
      latencyScore,
      reliabilityScore,
      throughputScore,
      recencyScore,
      satisfactionScore,
      compositeScore,
    };

    // Cache the score
    this.scoreCache.set(serviceId, {
      score,
      expiry: Date.now() + this.cacheTtlMs,
    });

    return score;
  }

  /**
   * Calculate health score based on service status
   */
  private calculateHealthScore(status: ServiceStatus): number {
    switch (status) {
      case 'active':
        return 1.0;
      case 'degraded':
        return 0.5;
      case 'offline':
      case 'deprecated':
        return 0.0;
      default:
        return 0.5;
    }
  }

  /**
   * Calculate latency score (inverse normalized to target)
   */
  private calculateLatencyScore(
    metrics: Array<{ structuredData: { metrics: PerformanceMetrics } }>
  ): number {
    if (metrics.length === 0) {
      return 0.5; // Default when no data
    }

    // Calculate weighted average (recent metrics have higher weight)
    let totalLatency = 0;
    let totalWeight = 0;

    for (let i = 0; i < metrics.length; i++) {
      const weight = Math.pow(0.8, i); // Exponential decay
      totalLatency += metrics[i].structuredData.metrics.avgLatencyMs * weight;
      totalWeight += weight;
    }

    const avgLatency = totalLatency / totalWeight;

    // Score: 1.0 if latency <= target, decreasing as latency increases
    return Math.min(this.targetLatencyMs / avgLatency, 1.0);
  }

  /**
   * Calculate reliability score (success rate)
   */
  private calculateReliabilityScore(
    metrics: Array<{ structuredData: { metrics: PerformanceMetrics } }>
  ): number {
    if (metrics.length === 0) {
      return 0.7; // Default when no data
    }

    // Aggregate success rate across all periods
    let totalRequests = 0;
    let totalSuccesses = 0;

    for (const metric of metrics) {
      totalRequests += metric.structuredData.metrics.requests;
      totalSuccesses += metric.structuredData.metrics.successes;
    }

    if (totalRequests === 0) {
      return 0.7;
    }

    return totalSuccesses / totalRequests;
  }

  /**
   * Calculate throughput score (prefer less loaded services)
   */
  private calculateThroughputScore(
    metrics: Array<{ structuredData: { metrics: PerformanceMetrics } }>,
    service: { structuredData: { rateLimits?: { requestsPerMinute: number } } }
  ): number {
    if (metrics.length === 0) {
      return 0.8; // Default when no data (assume not overloaded)
    }

    const latestMetrics = metrics[0]?.structuredData.metrics;
    if (!latestMetrics) {
      return 0.8;
    }

    const currentThroughput = latestMetrics.throughput;
    const maxThroughput = service.structuredData.rateLimits?.requestsPerMinute
      ? service.structuredData.rateLimits.requestsPerMinute / 60
      : 100; // Default max RPS

    // Score decreases as utilization increases
    const utilization = currentThroughput / maxThroughput;
    return Math.max(0, 1 - utilization);
  }

  /**
   * Calculate recency score (exponential decay from last use)
   */
  private calculateRecencyScore(service: {
    metadata: { lastUpdated: string };
  }): number {
    const lastUpdated = new Date(service.metadata.lastUpdated);
    const hoursSinceUpdate =
      (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);

    // Half-life of 1 week (168 hours)
    return Math.exp(-hoursSinceUpdate / 168);
  }

  /**
   * Calculate satisfaction score based on user feedback signals.
   *
   * Currently returns a neutral baseline score (0.7) as user feedback
   * collection is not yet integrated. When feedback data becomes available,
   * this method will aggregate:
   * - Explicit ratings (thumbs up/down, star ratings)
   * - Implicit signals (retry rate, abandonment rate)
   * - Response acceptance rate
   *
   * The 0.7 baseline assumes services perform adequately without negative signals.
   */
  private calculateSatisfactionScore(): number {
    // Baseline satisfaction score - neutral positive assumption
    // Services start with benefit of the doubt until feedback indicates otherwise
    const baselineScore = 0.7;

    return baselineScore;
  }

  /**
   * Default score when no data available
   */
  private defaultScore(): ServiceScore {
    return {
      healthScore: 0.5,
      latencyScore: 0.5,
      reliabilityScore: 0.5,
      throughputScore: 0.5,
      recencyScore: 0.5,
      satisfactionScore: 0.5,
      compositeScore: 0.5,
    };
  }

  /**
   * Compare services for the same capability
   */
  async compareServices(
    serviceIds: string[]
  ): Promise<Array<{ serviceId: string; score: ServiceScore }>> {
    const results = await Promise.all(
      serviceIds.map(async (serviceId) => ({
        serviceId,
        score: await this.calculateScore(serviceId),
      }))
    );

    return results.sort((a, b) => b.score.compositeScore - a.score.compositeScore);
  }

  /**
   * Update weights dynamically (for A/B testing or tuning)
   */
  updateWeights(newWeights: Partial<ScoringWeights>): void {
    this.weights = { ...this.weights, ...newWeights };
    // Clear cache when weights change
    this.scoreCache.clear();
  }

  /**
   * Clear score cache
   */
  clearCache(): void {
    this.scoreCache.clear();
  }

  /**
   * Invalidate cache for a specific service
   */
  invalidateService(serviceId: string): void {
    this.scoreCache.delete(serviceId);
  }
}

// Export factory
export function createPerformanceScorer(
  repository: ServiceCatalogRepository,
  weights?: ScoringWeights
): PerformanceScorer {
  return new PerformanceScorer(repository, weights);
}
