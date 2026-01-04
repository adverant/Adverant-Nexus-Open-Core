/**
 * Pattern Learning Service
 *
 * Learns from file processing outcomes to improve future UOM decisions.
 * Persists patterns to Redis for durability across restarts.
 *
 * Key Features:
 * - Consumes decision outcome events from Redis Streams
 * - Persists patterns to Redis with TTL
 * - Updates confidence based on success/failure ratios
 * - Provides pattern lookup for similar files
 */

import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { Counter, Histogram, Gauge } from 'prom-client';
import {
  DecisionOutcome,
  ThreatLevel,
  UOMDecisionPoint,
  FILE_STREAM_KEYS,
  FILE_CONSUMER_GROUPS
} from '@adverant/nexus-telemetry';

// ============================================================================
// Prometheus Metrics
// ============================================================================

const patternsLearned = new Counter({
  name: 'fileprocess_patterns_learned_total',
  help: 'Total patterns learned from outcomes',
  labelNames: ['decision_point', 'outcome']
});

const patternLookups = new Counter({
  name: 'fileprocess_pattern_lookups_total',
  help: 'Total pattern lookups',
  labelNames: ['result'] // 'hit', 'miss'
});

const patternConfidenceHistogram = new Histogram({
  name: 'fileprocess_pattern_confidence',
  help: 'Distribution of pattern confidence scores',
  labelNames: ['decision_point'],
  buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]
});

const activePatterns = new Gauge({
  name: 'fileprocess_active_patterns',
  help: 'Number of active patterns in the system'
});

// ============================================================================
// Types
// ============================================================================

/**
 * Persisted pattern structure
 */
interface PersistedPattern {
  id: string;
  key: string;
  decisionPoint: UOMDecisionPoint;
  decision: Record<string, unknown>;
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  createdAt: number;
  updatedAt: number;
  metadata: {
    fileExtensions: string[];
    mimeTypes: string[];
    sizeRange: [number, number];
    threatLevels: ThreatLevel[];
  };
}

/**
 * Pattern lookup request
 */
interface PatternLookupRequest {
  filename: string;
  mimeType: string;
  fileSize: number;
  decisionPoint: UOMDecisionPoint;
  sandboxResult?: {
    classification?: {
      category: string;
    };
    security?: {
      threatLevel: ThreatLevel;
    };
  };
}

/**
 * Pattern lookup result
 */
interface PatternLookupResult {
  found: boolean;
  pattern?: PersistedPattern;
  confidence?: number;
  alternatives?: PersistedPattern[];
}

/**
 * Pattern Learning Service Configuration
 */
interface PatternLearningConfig {
  redisUrl: string;
  patternTtlDays: number;
  minConfidenceThreshold: number;
  maxPatternsPerKey: number;
  confidenceDecay: number;
  learningEnabled: boolean;
}

// ============================================================================
// Pattern Learning Service
// ============================================================================

export class PatternLearningService {
  private redis: Redis | null = null;
  private config: PatternLearningConfig;
  private isConsuming = false;
  private consumerId: string;

  // Redis key prefixes
  private readonly PATTERN_PREFIX = 'nexus:file:patterns:';
  private readonly PATTERN_INDEX = 'nexus:file:patterns:index';
  private readonly STATS_KEY = 'nexus:file:patterns:stats';

  constructor(config?: Partial<PatternLearningConfig>) {
    this.config = {
      redisUrl: config?.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379',
      patternTtlDays: config?.patternTtlDays || 30,
      minConfidenceThreshold: config?.minConfidenceThreshold || 0.7,
      maxPatternsPerKey: config?.maxPatternsPerKey || 100,
      confidenceDecay: config?.confidenceDecay || 0.99,
      learningEnabled: config?.learningEnabled ?? true
    };

    this.consumerId = `pattern-learning-${process.pid}-${Date.now()}`;

    logger.info('PatternLearningService initialized', {
      learningEnabled: this.config.learningEnabled,
      patternTtlDays: this.config.patternTtlDays,
      minConfidenceThreshold: this.config.minConfidenceThreshold
    });
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  /**
   * Initialize Redis connection
   */
  async initialize(): Promise<void> {
    try {
      this.redis = new Redis(this.config.redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 100, 3000),
        lazyConnect: true
      });

      await this.redis.connect();

      // Ensure consumer group exists for outcome stream
      try {
        await this.redis.xgroup(
          'CREATE',
          FILE_STREAM_KEYS.DECISION_OUTCOMES,
          FILE_CONSUMER_GROUPS.LEARNING,
          '0',
          'MKSTREAM'
        );
      } catch (err: unknown) {
        // Group already exists - that's fine
        if (err instanceof Error && !err.message.includes('BUSYGROUP')) {
          throw err;
        }
      }

      // Load current pattern count
      const count = await this.redis.scard(this.PATTERN_INDEX);
      activePatterns.set(count);

      logger.info('PatternLearningService connected to Redis', {
        url: this.config.redisUrl,
        patternCount: count
      });
    } catch (error) {
      logger.error('Failed to initialize PatternLearningService', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  /**
   * Start consuming decision outcome events
   */
  async startConsuming(): Promise<void> {
    if (!this.config.learningEnabled) {
      logger.info('Pattern learning disabled, not consuming outcomes');
      return;
    }

    if (this.isConsuming) {
      logger.warn('Already consuming outcome events');
      return;
    }

    this.isConsuming = true;
    logger.info('Starting decision outcome consumption');

    // Start background consumer
    this.consumeOutcomes().catch(error => {
      logger.error('Outcome consumer crashed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      this.isConsuming = false;
    });
  }

  /**
   * Stop consuming
   */
  async stopConsuming(): Promise<void> {
    this.isConsuming = false;
    logger.info('Stopping decision outcome consumption');
  }

  /**
   * Close connections
   */
  async close(): Promise<void> {
    this.isConsuming = false;
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    logger.info('PatternLearningService closed');
  }

  // ============================================================================
  // Pattern Lookup
  // ============================================================================

  /**
   * Look up existing patterns for a file
   */
  async lookupPattern(request: PatternLookupRequest): Promise<PatternLookupResult> {
    if (!this.redis) {
      patternLookups.labels('error').inc();
      return { found: false };
    }

    try {
      const key = this.generatePatternKey(request);
      const patternData = await this.redis.get(`${this.PATTERN_PREFIX}${key}`);

      if (!patternData) {
        patternLookups.labels('miss').inc();
        return { found: false };
      }

      const pattern = JSON.parse(patternData) as PersistedPattern;

      // Check confidence threshold
      const effectiveConfidence = this.calculateEffectiveConfidence(pattern);
      if (effectiveConfidence < this.config.minConfidenceThreshold) {
        patternLookups.labels('miss').inc();
        return { found: false };
      }

      // Update last used timestamp
      pattern.lastUsed = Date.now();
      await this.redis.set(
        `${this.PATTERN_PREFIX}${key}`,
        JSON.stringify(pattern),
        'EX',
        this.config.patternTtlDays * 24 * 60 * 60
      );

      patternLookups.labels('hit').inc();
      patternConfidenceHistogram.labels(request.decisionPoint).observe(effectiveConfidence);

      logger.debug('Pattern found', {
        key,
        confidence: effectiveConfidence,
        successCount: pattern.successCount
      });

      return {
        found: true,
        pattern,
        confidence: effectiveConfidence
      };
    } catch (error) {
      patternLookups.labels('error').inc();
      logger.error('Pattern lookup failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return { found: false };
    }
  }

  /**
   * Find similar patterns for alternatives
   */
  async findSimilarPatterns(
    request: PatternLookupRequest,
    limit: number = 3
  ): Promise<PersistedPattern[]> {
    if (!this.redis) return [];

    try {
      // Get all patterns for this decision point
      const cursor = this.redis.scanStream({
        match: `${this.PATTERN_PREFIX}${request.decisionPoint}|*`,
        count: 100
      });

      const patterns: PersistedPattern[] = [];

      for await (const keys of cursor) {
        if (patterns.length >= limit * 3) break; // Get more than needed for filtering

        for (const key of keys as string[]) {
          const data = await this.redis.get(key);
          if (data) {
            const pattern = JSON.parse(data) as PersistedPattern;
            const confidence = this.calculateEffectiveConfidence(pattern);
            if (confidence >= this.config.minConfidenceThreshold) {
              patterns.push(pattern);
            }
          }
        }
      }

      // Sort by confidence and return top results
      return patterns
        .sort((a, b) => this.calculateEffectiveConfidence(b) - this.calculateEffectiveConfidence(a))
        .slice(0, limit);
    } catch (error) {
      logger.error('Failed to find similar patterns', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return [];
    }
  }

  // ============================================================================
  // Pattern Learning
  // ============================================================================

  /**
   * Learn from a decision outcome
   */
  async learnFromOutcome(outcome: DecisionOutcome): Promise<void> {
    if (!this.config.learningEnabled || !this.redis) return;

    try {
      const key = this.generatePatternKeyFromOutcome(outcome);
      const existingData = await this.redis.get(`${this.PATTERN_PREFIX}${key}`);

      let pattern: PersistedPattern;

      if (existingData) {
        // Update existing pattern
        pattern = JSON.parse(existingData) as PersistedPattern;

        if (outcome.outcome.success) {
          pattern.successCount++;
          // Boost confidence on success
          pattern.confidence = Math.min(1.0, pattern.confidence * 1.05);
        } else {
          pattern.failureCount++;
          // Reduce confidence on failure
          pattern.confidence = Math.max(0.1, pattern.confidence * 0.9);
        }

        pattern.updatedAt = Date.now();
        pattern.lastUsed = Date.now();

        // Update metadata
        this.updatePatternMetadata(pattern, outcome);

      } else {
        // Create new pattern
        pattern = {
          id: uuidv4(),
          key,
          decisionPoint: outcome.decisionPoint,
          decision: outcome.decision.decision as Record<string, unknown>,
          confidence: outcome.outcome.success ? 0.8 : 0.5,
          successCount: outcome.outcome.success ? 1 : 0,
          failureCount: outcome.outcome.success ? 0 : 1,
          lastUsed: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: {
            fileExtensions: [this.extractExtension(outcome.request.file.filename)],
            mimeTypes: [outcome.request.file.mimeType],
            sizeRange: [outcome.request.file.fileSize, outcome.request.file.fileSize],
            threatLevels: outcome.request.sandboxResult?.security?.threatLevel
              ? [outcome.request.sandboxResult.security.threatLevel]
              : []
          }
        };

        // Add to index
        await this.redis.sadd(this.PATTERN_INDEX, key);
        activePatterns.inc();
      }

      // Persist pattern
      await this.redis.set(
        `${this.PATTERN_PREFIX}${key}`,
        JSON.stringify(pattern),
        'EX',
        this.config.patternTtlDays * 24 * 60 * 60
      );

      // Update stats
      await this.updateStats(outcome);

      patternsLearned.labels(
        outcome.decisionPoint,
        outcome.outcome.success ? 'success' : 'failure'
      ).inc();

      logger.debug('Pattern learned', {
        key,
        confidence: pattern.confidence,
        success: outcome.outcome.success,
        successCount: pattern.successCount,
        failureCount: pattern.failureCount
      });

    } catch (error) {
      logger.error('Failed to learn from outcome', {
        error: error instanceof Error ? error.message : 'Unknown error',
        decisionPoint: outcome.decisionPoint
      });
    }
  }

  /**
   * Record pattern success (called after successful processing)
   */
  async recordSuccess(
    request: PatternLookupRequest,
    decision: Record<string, unknown>
  ): Promise<void> {
    if (!this.config.learningEnabled || !this.redis) return;

    const key = this.generatePatternKey(request);
    const existingData = await this.redis.get(`${this.PATTERN_PREFIX}${key}`);

    if (existingData) {
      const pattern = JSON.parse(existingData) as PersistedPattern;
      pattern.successCount++;
      pattern.confidence = Math.min(1.0, pattern.confidence * 1.03);
      pattern.lastUsed = Date.now();
      pattern.updatedAt = Date.now();

      await this.redis.set(
        `${this.PATTERN_PREFIX}${key}`,
        JSON.stringify(pattern),
        'EX',
        this.config.patternTtlDays * 24 * 60 * 60
      );

      patternsLearned.labels(request.decisionPoint, 'success').inc();
    } else {
      // Create new pattern from success
      const pattern: PersistedPattern = {
        id: uuidv4(),
        key,
        decisionPoint: request.decisionPoint,
        decision,
        confidence: 0.8,
        successCount: 1,
        failureCount: 0,
        lastUsed: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          fileExtensions: [this.extractExtension(request.filename)],
          mimeTypes: [request.mimeType],
          sizeRange: [request.fileSize, request.fileSize],
          threatLevels: request.sandboxResult?.security?.threatLevel
            ? [request.sandboxResult.security.threatLevel]
            : []
        }
      };

      await this.redis.set(
        `${this.PATTERN_PREFIX}${key}`,
        JSON.stringify(pattern),
        'EX',
        this.config.patternTtlDays * 24 * 60 * 60
      );
      await this.redis.sadd(this.PATTERN_INDEX, key);
      activePatterns.inc();

      patternsLearned.labels(request.decisionPoint, 'new_success').inc();
    }
  }

  /**
   * Record pattern failure (called after failed processing)
   */
  async recordFailure(request: PatternLookupRequest): Promise<void> {
    if (!this.config.learningEnabled || !this.redis) return;

    const key = this.generatePatternKey(request);
    const existingData = await this.redis.get(`${this.PATTERN_PREFIX}${key}`);

    if (existingData) {
      const pattern = JSON.parse(existingData) as PersistedPattern;
      pattern.failureCount++;
      pattern.confidence = Math.max(0.1, pattern.confidence * 0.85);
      pattern.updatedAt = Date.now();

      // Remove pattern if failure rate is too high
      const total = pattern.successCount + pattern.failureCount;
      const failureRate = pattern.failureCount / total;

      if (total >= 5 && failureRate > 0.5) {
        // Pattern is unreliable, remove it
        await this.redis.del(`${this.PATTERN_PREFIX}${key}`);
        await this.redis.srem(this.PATTERN_INDEX, key);
        activePatterns.dec();

        logger.info('Pattern removed due to high failure rate', {
          key,
          failureRate,
          successCount: pattern.successCount,
          failureCount: pattern.failureCount
        });
      } else {
        await this.redis.set(
          `${this.PATTERN_PREFIX}${key}`,
          JSON.stringify(pattern),
          'EX',
          this.config.patternTtlDays * 24 * 60 * 60
        );
      }

      patternsLearned.labels(request.decisionPoint, 'failure').inc();
    }
  }

  // ============================================================================
  // Stream Consumer
  // ============================================================================

  /**
   * Background consumer for decision outcomes
   */
  private async consumeOutcomes(): Promise<void> {
    if (!this.redis) return;

    while (this.isConsuming) {
      try {
        const results = await this.redis.xreadgroup(
          'GROUP',
          FILE_CONSUMER_GROUPS.LEARNING,
          this.consumerId,
          'COUNT',
          10,
          'BLOCK',
          5000,
          'STREAMS',
          FILE_STREAM_KEYS.DECISION_OUTCOMES,
          '>'
        );

        if (!results || !Array.isArray(results) || results.length === 0) continue;

        // Type the results properly: Array<[streamName, Array<[messageId, fields[]]>]>
        type StreamMessage = [string, string[]];
        type StreamEntry = [string, StreamMessage[]];

        for (const entry of results as StreamEntry[]) {
          const [, messages] = entry;
          if (!messages || !Array.isArray(messages)) continue;

          for (const message of messages) {
            const [messageId, fields] = message;
            try {
              // Parse message fields
              const data: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                data[fields[i]] = fields[i + 1];
              }

              if (data.outcome) {
                const outcome = JSON.parse(data.outcome) as DecisionOutcome;
                await this.learnFromOutcome(outcome);
              }

              // Acknowledge message
              await this.redis.xack(
                FILE_STREAM_KEYS.DECISION_OUTCOMES,
                FILE_CONSUMER_GROUPS.LEARNING,
                messageId
              );
            } catch (parseError) {
              logger.error('Failed to process outcome message', {
                messageId,
                error: parseError instanceof Error ? parseError.message : 'Unknown error'
              });
            }
          }
        }
      } catch (error) {
        if (this.isConsuming) {
          logger.error('Error consuming outcome stream', {
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Generate pattern key from lookup request
   */
  private generatePatternKey(request: PatternLookupRequest): string {
    const ext = this.extractExtension(request.filename);
    const mimeCategory = request.mimeType.split('/')[0] || 'unknown';
    const sizeCategory = this.categorizeFileSize(request.fileSize);
    const category = request.sandboxResult?.classification?.category || 'unknown';
    const threatLevel = request.sandboxResult?.security?.threatLevel || 'unknown';

    return [
      request.decisionPoint,
      ext,
      mimeCategory,
      sizeCategory,
      category,
      threatLevel
    ].join('|');
  }

  /**
   * Generate pattern key from outcome
   */
  private generatePatternKeyFromOutcome(outcome: DecisionOutcome): string {
    const { file, sandboxResult } = outcome.request;

    const ext = this.extractExtension(file.filename);
    const mimeCategory = file.mimeType.split('/')[0] || 'unknown';
    const sizeCategory = this.categorizeFileSize(file.fileSize);
    const category = sandboxResult?.classification?.category || 'unknown';
    const threatLevel = sandboxResult?.security?.threatLevel || 'unknown';

    return [
      outcome.decisionPoint,
      ext,
      mimeCategory,
      sizeCategory,
      category,
      threatLevel
    ].join('|');
  }

  /**
   * Extract file extension
   */
  private extractExtension(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ext && ext.length <= 10 ? ext : 'unknown';
  }

  /**
   * Categorize file size
   */
  private categorizeFileSize(size: number): string {
    if (size < 1024 * 1024) return 'small';
    if (size < 10 * 1024 * 1024) return 'medium';
    if (size < 100 * 1024 * 1024) return 'large';
    return 'xlarge';
  }

  /**
   * Calculate effective confidence with decay
   */
  private calculateEffectiveConfidence(pattern: PersistedPattern): number {
    const total = pattern.successCount + pattern.failureCount;
    if (total === 0) return pattern.confidence;

    // Base confidence from success rate
    const successRate = pattern.successCount / total;

    // Apply time decay (older patterns get slightly less confidence)
    const ageMs = Date.now() - pattern.lastUsed;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const decayFactor = Math.pow(this.config.confidenceDecay, ageDays);

    // Blend stored confidence with success rate
    const baseConfidence = (pattern.confidence * 0.4) + (successRate * 0.6);

    return baseConfidence * decayFactor;
  }

  /**
   * Update pattern metadata from outcome
   */
  private updatePatternMetadata(pattern: PersistedPattern, outcome: DecisionOutcome): void {
    const { file, sandboxResult } = outcome.request;

    // Update extensions
    const ext = this.extractExtension(file.filename);
    if (!pattern.metadata.fileExtensions.includes(ext)) {
      pattern.metadata.fileExtensions.push(ext);
      if (pattern.metadata.fileExtensions.length > 10) {
        pattern.metadata.fileExtensions = pattern.metadata.fileExtensions.slice(-10);
      }
    }

    // Update mime types
    if (!pattern.metadata.mimeTypes.includes(file.mimeType)) {
      pattern.metadata.mimeTypes.push(file.mimeType);
      if (pattern.metadata.mimeTypes.length > 10) {
        pattern.metadata.mimeTypes = pattern.metadata.mimeTypes.slice(-10);
      }
    }

    // Update size range
    pattern.metadata.sizeRange = [
      Math.min(pattern.metadata.sizeRange[0], file.fileSize),
      Math.max(pattern.metadata.sizeRange[1], file.fileSize)
    ];

    // Update threat levels
    const threatLevel = sandboxResult?.security?.threatLevel;
    if (threatLevel && !pattern.metadata.threatLevels.includes(threatLevel)) {
      pattern.metadata.threatLevels.push(threatLevel);
    }
  }

  /**
   * Update learning statistics
   */
  private async updateStats(outcome: DecisionOutcome): Promise<void> {
    if (!this.redis) return;

    const today = new Date().toISOString().split('T')[0];

    await this.redis.hincrby(
      this.STATS_KEY,
      `${today}:${outcome.decisionPoint}:${outcome.outcome.success ? 'success' : 'failure'}`,
      1
    );
  }

  // ============================================================================
  // Statistics and Management
  // ============================================================================

  /**
   * Get learning statistics
   */
  async getStatistics(): Promise<{
    totalPatterns: number;
    patternsByDecisionPoint: Record<string, number>;
    avgConfidence: number;
    learningEnabled: boolean;
  }> {
    if (!this.redis) {
      return {
        totalPatterns: 0,
        patternsByDecisionPoint: {},
        avgConfidence: 0,
        learningEnabled: this.config.learningEnabled
      };
    }

    try {
      const totalPatterns = await this.redis.scard(this.PATTERN_INDEX);

      const patternsByDecisionPoint: Record<string, number> = {
        initial_triage: 0,
        security_assessment: 0,
        processing_route: 0,
        post_processing: 0
      };

      let totalConfidence = 0;
      let count = 0;

      // Scan through patterns
      const cursor = this.redis.scanStream({
        match: `${this.PATTERN_PREFIX}*`,
        count: 100
      });

      for await (const keys of cursor) {
        for (const key of keys as string[]) {
          const data = await this.redis.get(key);
          if (data) {
            const pattern = JSON.parse(data) as PersistedPattern;
            patternsByDecisionPoint[pattern.decisionPoint]++;
            totalConfidence += this.calculateEffectiveConfidence(pattern);
            count++;
          }
        }
      }

      return {
        totalPatterns,
        patternsByDecisionPoint,
        avgConfidence: count > 0 ? totalConfidence / count : 0,
        learningEnabled: this.config.learningEnabled
      };
    } catch (error) {
      logger.error('Failed to get statistics', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        totalPatterns: 0,
        patternsByDecisionPoint: {},
        avgConfidence: 0,
        learningEnabled: this.config.learningEnabled
      };
    }
  }

  /**
   * Clear all patterns (use with caution!)
   */
  async clearAllPatterns(): Promise<void> {
    if (!this.redis) return;

    logger.warn('Clearing all patterns');

    const keys = await this.redis.smembers(this.PATTERN_INDEX);
    if (keys.length > 0) {
      await this.redis.del(...keys.map(k => `${this.PATTERN_PREFIX}${k}`));
    }
    await this.redis.del(this.PATTERN_INDEX);

    activePatterns.set(0);
    logger.info('All patterns cleared');
  }

  /**
   * Export patterns for backup
   */
  async exportPatterns(): Promise<PersistedPattern[]> {
    if (!this.redis) return [];

    const patterns: PersistedPattern[] = [];

    const cursor = this.redis.scanStream({
      match: `${this.PATTERN_PREFIX}*`,
      count: 100
    });

    for await (const keys of cursor) {
      for (const key of keys as string[]) {
        const data = await this.redis.get(key);
        if (data) {
          patterns.push(JSON.parse(data) as PersistedPattern);
        }
      }
    }

    return patterns;
  }

  /**
   * Import patterns from backup
   */
  async importPatterns(patterns: PersistedPattern[]): Promise<number> {
    if (!this.redis) return 0;

    let imported = 0;

    for (const pattern of patterns) {
      await this.redis.set(
        `${this.PATTERN_PREFIX}${pattern.key}`,
        JSON.stringify(pattern),
        'EX',
        this.config.patternTtlDays * 24 * 60 * 60
      );
      await this.redis.sadd(this.PATTERN_INDEX, pattern.key);
      imported++;
    }

    activePatterns.set(await this.redis.scard(this.PATTERN_INDEX));
    logger.info('Patterns imported', { count: imported });

    return imported;
  }
}

// ============================================================================
// Singleton Management
// ============================================================================

let patternLearningInstance: PatternLearningService | null = null;

/**
 * Get or create the pattern learning service instance
 */
export function getPatternLearningService(): PatternLearningService {
  if (!patternLearningInstance) {
    patternLearningInstance = new PatternLearningService();
  }
  return patternLearningInstance;
}

/**
 * Initialize the pattern learning service
 */
export async function initializePatternLearning(): Promise<PatternLearningService> {
  const service = getPatternLearningService();
  await service.initialize();
  await service.startConsuming();
  return service;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetPatternLearningService(): void {
  if (patternLearningInstance) {
    patternLearningInstance.close().catch(() => {});
    patternLearningInstance = null;
  }
}
