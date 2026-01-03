/**
 * Entity Classification Prometheus Metrics
 * Tracks entity extraction quality, stopword filtering, and classification accuracy
 *
 * Metrics:
 * - Entity extraction counters (total, accepted, filtered by reason)
 * - Confidence distribution histograms
 * - Classification type counters
 * - Fact extraction counters
 * - Processing duration histograms
 */

import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import { logger } from '../utils/logger';

export class ClassificationMetrics {
  private readonly registry: Registry;

  // Entity extraction counters
  private readonly entityExtractedTotal: Counter;
  private readonly entityFilteredTotal: Counter;
  private readonly entityAcceptedTotal: Counter;

  // Filter reason breakdown
  private readonly filterReasonCounter: Counter;

  // Confidence distribution
  private readonly confidenceHistogram: Histogram;

  // Classification type distribution
  private readonly classificationTypeCounter: Counter;

  // Fact extraction counters
  private readonly factExtractedTotal: Counter;
  private readonly factFilteredTotal: Counter;

  // Processing duration
  private readonly extractionDurationMs: Histogram;

  // Entity source tracking
  private readonly entitySourceCounter: Counter;

  // Quality gauges (updated periodically)
  private readonly stopwordFilterRate: Gauge;
  private readonly averageEntityConfidence: Gauge;

  constructor(registry?: Registry) {
    this.registry = registry || new Registry();

    // Entity extraction counters
    this.entityExtractedTotal = new Counter({
      name: 'nexus_entity_extracted_total',
      help: 'Total entities extracted before filtering',
      labelNames: ['source'], // 'llm', 'regex', 'pre-identified'
      registers: [this.registry]
    });

    this.entityFilteredTotal = new Counter({
      name: 'nexus_entity_filtered_total',
      help: 'Total entities filtered by validation',
      labelNames: ['reason', 'source'],
      registers: [this.registry]
    });

    this.entityAcceptedTotal = new Counter({
      name: 'nexus_entity_accepted_total',
      help: 'Total entities accepted after validation',
      labelNames: ['type', 'source'],
      registers: [this.registry]
    });

    // Detailed filter reason breakdown
    this.filterReasonCounter = new Counter({
      name: 'nexus_entity_filter_reason_total',
      help: 'Entities filtered by specific reason',
      labelNames: ['reason'], // 'stopword', 'non_entity_phrase', 'duplicate', 'too_short', 'numeric', 'low_confidence'
      registers: [this.registry]
    });

    // Confidence distribution histogram
    this.confidenceHistogram = new Histogram({
      name: 'nexus_entity_confidence_distribution',
      help: 'Distribution of entity confidence scores',
      labelNames: ['outcome'], // 'accepted', 'rejected'
      buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      registers: [this.registry]
    });

    // Classification type distribution
    this.classificationTypeCounter = new Counter({
      name: 'nexus_entity_classification_type_total',
      help: 'Entities by classified type',
      labelNames: ['type'], // 'person', 'organization', 'location', 'technology', 'concept', 'file', 'function', 'other'
      registers: [this.registry]
    });

    // Fact extraction counters
    this.factExtractedTotal = new Counter({
      name: 'nexus_fact_extracted_total',
      help: 'Total facts extracted',
      labelNames: ['pattern_type'], // 'is_pattern', 'uses_pattern', 'relationship_pattern'
      registers: [this.registry]
    });

    this.factFilteredTotal = new Counter({
      name: 'nexus_fact_filtered_total',
      help: 'Total facts filtered',
      labelNames: ['reason'], // 'stopword_subject', 'too_short', 'duplicate'
      registers: [this.registry]
    });

    // Processing duration histogram
    this.extractionDurationMs = new Histogram({
      name: 'nexus_entity_extraction_duration_ms',
      help: 'Entity extraction duration in milliseconds',
      labelNames: ['method'], // 'llm', 'regex', 'combined'
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
      registers: [this.registry]
    });

    // Entity source tracking
    this.entitySourceCounter = new Counter({
      name: 'nexus_entity_source_total',
      help: 'Entities by extraction source',
      labelNames: ['source'], // 'llm', 'regex', 'pre-identified'
      registers: [this.registry]
    });

    // Quality gauges
    this.stopwordFilterRate = new Gauge({
      name: 'nexus_stopword_filter_rate',
      help: 'Percentage of entities filtered as stopwords (0-100)',
      registers: [this.registry]
    });

    this.averageEntityConfidence = new Gauge({
      name: 'nexus_average_entity_confidence',
      help: 'Average confidence score of accepted entities',
      registers: [this.registry]
    });

    logger.info('[CLASSIFICATION-METRICS] Classification metrics initialized');
  }

  /**
   * Track entity extraction (before filtering)
   */
  trackEntityExtracted(source: 'llm' | 'regex' | 'pre-identified', count: number): void {
    this.entityExtractedTotal.inc({ source }, count);
    this.entitySourceCounter.inc({ source }, count);
  }

  /**
   * Track entity filtered with reason
   */
  trackEntityFiltered(
    reason: 'stopword' | 'non_entity_phrase' | 'duplicate' | 'too_short' | 'numeric' | 'low_confidence',
    source: 'llm' | 'regex' | 'pre-identified'
  ): void {
    this.entityFilteredTotal.inc({ reason, source });
    this.filterReasonCounter.inc({ reason });
  }

  /**
   * Track entity accepted after validation
   */
  trackEntityAccepted(
    type: 'person' | 'organization' | 'location' | 'technology' | 'concept' | 'file' | 'function' | 'temporal' | 'other',
    source: 'llm' | 'regex' | 'pre-identified',
    confidence: number
  ): void {
    this.entityAcceptedTotal.inc({ type, source });
    this.classificationTypeCounter.inc({ type });
    this.confidenceHistogram.observe({ outcome: 'accepted' }, confidence);
  }

  /**
   * Track rejected entity by confidence
   */
  trackEntityRejectedByConfidence(confidence: number): void {
    this.confidenceHistogram.observe({ outcome: 'rejected' }, confidence);
    this.filterReasonCounter.inc({ reason: 'low_confidence' });
  }

  /**
   * Track fact extraction
   */
  trackFactExtracted(patternType: 'is_pattern' | 'uses_pattern' | 'relationship_pattern'): void {
    this.factExtractedTotal.inc({ pattern_type: patternType });
  }

  /**
   * Track fact filtered
   */
  trackFactFiltered(reason: 'stopword_subject' | 'too_short' | 'duplicate'): void {
    this.factFilteredTotal.inc({ reason });
  }

  /**
   * Track extraction duration
   */
  trackExtractionDuration(method: 'llm' | 'regex' | 'combined', durationMs: number): void {
    this.extractionDurationMs.observe({ method }, durationMs);
  }

  /**
   * Update quality gauges (call periodically)
   */
  updateQualityGauges(filterRate: number, avgConfidence: number): void {
    this.stopwordFilterRate.set(filterRate);
    this.averageEntityConfidence.set(avgConfidence);
  }

  /**
   * Track a complete validation batch
   */
  trackValidationBatch(stats: {
    source: 'llm' | 'regex' | 'pre-identified';
    total: number;
    accepted: number;
    filtered: {
      stopword: number;
      nonEntityPhrase: number;
      duplicate: number;
      tooShort: number;
      numeric: number;
      lowConfidence: number;
    };
  }): void {
    // Track total extracted
    this.trackEntityExtracted(stats.source, stats.total);

    // Track each filter reason
    if (stats.filtered.stopword > 0) {
      for (let i = 0; i < stats.filtered.stopword; i++) {
        this.trackEntityFiltered('stopword', stats.source);
      }
    }
    if (stats.filtered.nonEntityPhrase > 0) {
      for (let i = 0; i < stats.filtered.nonEntityPhrase; i++) {
        this.trackEntityFiltered('non_entity_phrase', stats.source);
      }
    }
    if (stats.filtered.duplicate > 0) {
      for (let i = 0; i < stats.filtered.duplicate; i++) {
        this.trackEntityFiltered('duplicate', stats.source);
      }
    }
    if (stats.filtered.tooShort > 0) {
      for (let i = 0; i < stats.filtered.tooShort; i++) {
        this.trackEntityFiltered('too_short', stats.source);
      }
    }
    if (stats.filtered.numeric > 0) {
      for (let i = 0; i < stats.filtered.numeric; i++) {
        this.trackEntityFiltered('numeric', stats.source);
      }
    }
    if (stats.filtered.lowConfidence > 0) {
      for (let i = 0; i < stats.filtered.lowConfidence; i++) {
        this.trackEntityFiltered('low_confidence', stats.source);
      }
    }

    // Calculate and update filter rate
    const filterRate = stats.total > 0 ? ((stats.total - stats.accepted) / stats.total) * 100 : 0;
    this.stopwordFilterRate.set(filterRate);

    logger.debug('[CLASSIFICATION-METRICS] Validation batch tracked', {
      source: stats.source,
      total: stats.total,
      accepted: stats.accepted,
      filterRate: `${filterRate.toFixed(1)}%`
    });
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
   * Get the registry for custom operations
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.registry.resetMetrics();
    logger.info('[CLASSIFICATION-METRICS] All metrics reset');
  }
}

// Singleton instance
let classificationMetricsInstance: ClassificationMetrics | null = null;

/**
 * Get or create the classification metrics instance
 */
export function getClassificationMetrics(registry?: Registry): ClassificationMetrics {
  if (!classificationMetricsInstance) {
    classificationMetricsInstance = new ClassificationMetrics(registry);
    logger.info('[CLASSIFICATION-METRICS] Created singleton classification metrics instance');
  }
  return classificationMetricsInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetClassificationMetrics(): void {
  if (classificationMetricsInstance) {
    classificationMetricsInstance.reset();
    classificationMetricsInstance = null;
    logger.info('[CLASSIFICATION-METRICS] Reset singleton classification metrics instance');
  }
}
