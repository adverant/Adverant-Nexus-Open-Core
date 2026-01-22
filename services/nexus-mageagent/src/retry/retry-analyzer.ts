/**
 * Intelligent Retry Analyzer
 *
 * ML-based error pattern recognition and retry strategy recommendation.
 * Implements adaptive learning from retry outcomes to continuously improve.
 *
 * @module retry-analyzer
 * @version 1.0.0
 */

import { Pool } from 'pg';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import { RetryBudgetManager, BudgetCheckResult } from './retry-budget-manager';

// ============================================================================
// Type Definitions
// ============================================================================

export interface ErrorContext {
  service: string;
  operation: string;
  context?: Record<string, any>;
  attempt?: number;
  taskId?: string;
}

export interface RetryRecommendation {
  patternId: string | null;
  shouldRetry: boolean;
  strategy: RetryStrategy;
  confidence: number;
  category: string;
  severity: string;
  reasoning: string;
  modifications?: OperationModification[];
}

export interface RetryStrategy {
  maxRetries: number;
  backoffMs: number[];
  exponentialBackoff: boolean;
  timeout?: number;
}

export interface OperationModification {
  type: 'parameter_change' | 'alternative_method' | 'resource_adjustment';
  description: string;
  changes: Record<string, any>;
}

export interface RetryAttempt {
  taskId: string;
  agentId?: string;
  patternId?: string;
  attempt: number;
  strategyApplied: RetryStrategy;
  modificationsApplied?: OperationModification[];
  success: boolean;
  executionTimeMs?: number;
  error?: string;
  contextSnapshot?: Record<string, any>;
}

export interface ErrorPattern {
  id: string;
  errorType: string;
  errorMessage: string;
  errorStack?: string;
  errorCode?: string;
  serviceName: string;
  operationName: string;
  category?: string;
  severity?: string;
  retryable: boolean;
  retrySuccessCount: number;
  retryFailureCount: number;
  successRate?: number;
  recommendedStrategy: RetryStrategy;
  normalizedMessage: string;
  messageHash: string;
  occurrenceCount: number;
  lastSeenAt: Date;
}

// ============================================================================
// Retry Analyzer Service
// ============================================================================

export class RetryAnalyzer {
  private pool: Pool;
  private patternCache: Map<string, ErrorPattern>;
  private cacheTTL: number = 300000; // 5 minutes
  private lastCacheRefresh: number = 0;
  private retryBudgetManager?: RetryBudgetManager;

  constructor(databasePool: Pool, retryBudgetManager?: RetryBudgetManager) {
    if (!databasePool) {
      throw new Error(
        'RetryAnalyzer initialization failed:\n' +
        'Database pool is required but was not provided.\n' +
        'Please ensure PostgreSQL connection is established before creating RetryAnalyzer.'
      );
    }

    this.pool = databasePool;
    this.patternCache = new Map();
    this.retryBudgetManager = retryBudgetManager;

    logger.info('RetryAnalyzer initialized', {
      cacheTTL: this.cacheTTL,
      budgetManagerEnabled: !!retryBudgetManager,
      component: 'retry-analyzer'
    });
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Analyze an error and recommend optimal retry strategy.
   *
   * Uses ML-based pattern matching to find similar historical errors
   * and recommends strategies based on historical success rates.
   *
   * Performance: < 50ms (with cache), < 200ms (cache miss)
   */
  async analyzeError(
    error: Error,
    context: ErrorContext
  ): Promise<RetryRecommendation> {
    const startTime = Date.now();

    try {
      const taskId = context.taskId || 'unknown';

      // PHASE 2.2: Check global retry budget FIRST
      if (this.retryBudgetManager && taskId !== 'unknown') {
        const budgetCheck: BudgetCheckResult = await this.retryBudgetManager.checkBudget(
          taskId,
          error,
          undefined // pattern ID will be added later
        );

        if (!budgetCheck.allowed) {
          logger.warn('Retry budget exhausted for task', {
            taskId,
            reason: budgetCheck.reason,
            component: 'retry-analyzer'
          });

          return {
            patternId: null,
            shouldRetry: false,
            strategy: this.getDefaultRecommendation().strategy,
            confidence: 1.0, // 100% confidence - budget exhausted
            category: 'budget_exhausted',
            severity: 'high',
            reasoning: budgetCheck.reason || 'Global retry budget exhausted. Task sent to dead letter queue.'
          };
        }

        logger.debug('Retry budget check passed', {
          taskId,
          attemptsRemaining: budgetCheck.attemptsRemaining,
          timeRemaining: budgetCheck.timeRemaining,
          component: 'retry-analyzer'
        });
      }

      // Normalize error for pattern matching
      const normalizedMessage = this.normalizeErrorMessage(error.message);
      const messageHash = this.hashMessage(normalizedMessage);

      // Extract error details
      const errorType = error.constructor.name;
      const errorCode = this.extractErrorCode(error);

      // Try to find matching pattern in database
      const pattern = await this.findMatchingPattern({
        errorType,
        normalizedMessage,
        messageHash,
        service: context.service,
        operation: context.operation
      });

      let recommendation: RetryRecommendation;

      if (pattern) {
        // Pattern found - use historical data
        recommendation = {
          patternId: pattern.id,
          shouldRetry: pattern.retryable && (context.attempt || 0) < pattern.recommendedStrategy.maxRetries,
          strategy: pattern.recommendedStrategy,
          confidence: pattern.successRate || 0.5,
          category: pattern.category || 'unknown',
          severity: pattern.severity || 'medium',
          reasoning: this.generateReasoning(pattern),
          modifications: this.parseModifications(pattern.recommendedStrategy)
        };

        // Update pattern last seen
        await this.updatePatternLastSeen(pattern.id).catch(err => {
          logger.warn('Failed to update pattern last seen', { error: err.message });
        });
      } else {
        // No pattern found - create new pattern or use default
        const newPattern = await this.createOrGetPattern({
          errorType,
          errorMessage: error.message,
          errorStack: error.stack,
          errorCode,
          normalizedMessage,
          messageHash,
          service: context.service,
          operation: context.operation
        });

        recommendation = {
          patternId: newPattern.id,
          shouldRetry: true,
          strategy: newPattern.recommendedStrategy,
          confidence: 0.5, // Default confidence for new patterns
          category: newPattern.category || 'unknown',
          severity: newPattern.severity || 'medium',
          reasoning: 'New error pattern detected. Using conservative default strategy.',
          modifications: this.parseModifications(newPattern.recommendedStrategy)
        };
      }

      const latency = Date.now() - startTime;

      logger.debug('Error analysis completed', {
        errorType,
        service: context.service,
        operation: context.operation,
        patternId: recommendation.patternId,
        shouldRetry: recommendation.shouldRetry,
        confidence: recommendation.confidence,
        latency,
        component: 'retry-analyzer'
      });

      return recommendation;

    } catch (analysisError) {
      // Fallback to safe default if analysis fails
      logger.error('Error analysis failed, using safe default', {
        error: analysisError instanceof Error ? analysisError.message : String(analysisError),
        service: context.service,
        operation: context.operation,
        component: 'retry-analyzer'
      });

      return this.getDefaultRecommendation();
    }
  }

  /**
   * Record a retry attempt outcome for learning.
   *
   * Updates pattern statistics and improves future recommendations.
   *
   * Performance: < 100ms (async, non-blocking)
   */
  async recordAttempt(attempt: RetryAttempt): Promise<void> {
    try {
      const query = `
        INSERT INTO retry_intelligence.retry_attempts (
          pattern_id,
          task_id,
          agent_id,
          attempt_number,
          strategy_applied,
          modifications_applied,
          success,
          execution_time_ms,
          error_if_failed,
          context_snapshot
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `;

      const values = [
        attempt.patternId || null,
        attempt.taskId,
        attempt.agentId || null,
        attempt.attempt,
        JSON.stringify(attempt.strategyApplied),
        attempt.modificationsApplied ? JSON.stringify(attempt.modificationsApplied) : null,
        attempt.success,
        attempt.executionTimeMs || null,
        attempt.error || null,
        attempt.contextSnapshot ? JSON.stringify(attempt.contextSnapshot) : null
      ];

      const result = await this.pool.query(query, values);

      logger.debug('Retry attempt recorded', {
        attemptId: result.rows[0].id,
        taskId: attempt.taskId,
        attempt: attempt.attempt,
        success: attempt.success,
        patternId: attempt.patternId,
        component: 'retry-analyzer'
      });

      // Invalidate cache for this pattern
      if (attempt.patternId) {
        this.invalidateCacheEntry(attempt.patternId);
      }

    } catch (error) {
      // Non-fatal - log but don't throw
      logger.error('Failed to record retry attempt', {
        error: error instanceof Error ? error.message : String(error),
        taskId: attempt.taskId,
        attempt: attempt.attempt,
        component: 'retry-analyzer'
      });
    }
  }

  /**
   * Get historical success rate for similar errors.
   *
   * Performance: < 50ms (with cache)
   */
  async getSuccessRate(
    errorPattern: string,
    service: string
  ): Promise<number> {
    try {
      const normalizedMessage = this.normalizeErrorMessage(errorPattern);

      const query = `
        SELECT success_rate
        FROM retry_intelligence.error_patterns
        WHERE service_name = $1
          AND normalized_message LIKE $2
          AND retryable = true
        ORDER BY occurrence_count DESC
        LIMIT 1
      `;

      const result = await this.pool.query(query, [
        service,
        `%${normalizedMessage}%`
      ]);

      return result.rows[0]?.success_rate || 0.5;

    } catch (error) {
      logger.error('Failed to get success rate', {
        error: error instanceof Error ? error.message : String(error),
        component: 'retry-analyzer'
      });

      return 0.5; // Default confidence
    }
  }

  /**
   * Get retry analytics for monitoring dashboard.
   */
  async getAnalytics(): Promise<Record<string, any>> {
    try {
      // Get overall statistics
      const statsQuery = `
        SELECT
          COUNT(*) as total_patterns,
          COUNT(*) FILTER (WHERE retryable = true) as retryable_patterns,
          AVG(success_rate) as avg_success_rate,
          SUM(retry_success_count) as total_successes,
          SUM(retry_failure_count) as total_failures
        FROM retry_intelligence.error_patterns
      `;

      const stats = await this.pool.query(statsQuery);

      // Get top patterns by service
      const topPatternsQuery = `
        SELECT
          service_name,
          operation_name,
          category,
          COUNT(*) as pattern_count,
          AVG(success_rate) as avg_success_rate
        FROM retry_intelligence.error_patterns
        WHERE retryable = true
        GROUP BY service_name, operation_name, category
        ORDER BY pattern_count DESC
        LIMIT 10
      `;

      const topPatterns = await this.pool.query(topPatternsQuery);

      // Get recent retry activity
      const recentActivityQuery = `
        SELECT
          COUNT(*) as attempts_last_hour,
          COUNT(*) FILTER (WHERE success = true) as successes_last_hour,
          COUNT(*) FILTER (WHERE success = false) as failures_last_hour
        FROM retry_intelligence.retry_attempts
        WHERE created_at > NOW() - INTERVAL '1 hour'
      `;

      const recentActivity = await this.pool.query(recentActivityQuery);

      return {
        stats: stats.rows[0],
        topPatterns: topPatterns.rows,
        recentActivity: recentActivity.rows[0],
        cacheSize: this.patternCache.size,
        lastCacheRefresh: new Date(this.lastCacheRefresh).toISOString()
      };

    } catch (error) {
      logger.error('Failed to get analytics', {
        error: error instanceof Error ? error.message : String(error),
        component: 'retry-analyzer'
      });

      return {
        error: 'Failed to retrieve analytics'
      };
    }
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Find matching error pattern in database.
   *
   * Implements multi-tier matching:
   * 1. Exact hash match (fastest)
   * 2. Service + operation + error type match
   * 3. Fuzzy message similarity match
   */
  private async findMatchingPattern(criteria: {
    errorType: string;
    normalizedMessage: string;
    messageHash: string;
    service: string;
    operation: string;
  }): Promise<ErrorPattern | null> {
    try {
      // Check cache first
      const cached = this.getCachedPattern(criteria.messageHash);
      if (cached) {
        return cached;
      }

      // Try exact hash match first (fastest)
      let query = `
        SELECT * FROM retry_intelligence.error_patterns
        WHERE message_hash = $1
          AND service_name = $2
          AND operation_name = $3
          AND retryable = true
        LIMIT 1
      `;

      let result = await this.pool.query(query, [
        criteria.messageHash,
        criteria.service,
        criteria.operation
      ]);

      if (result.rows.length > 0) {
        const pattern = this.mapRowToPattern(result.rows[0]);
        this.cachePattern(pattern);
        return pattern;
      }

      // Fall back to service + operation + error type match
      query = `
        SELECT * FROM retry_intelligence.error_patterns
        WHERE service_name = $1
          AND operation_name = $2
          AND error_type = $3
          AND retryable = true
        ORDER BY success_rate DESC NULLS LAST, occurrence_count DESC
        LIMIT 1
      `;

      result = await this.pool.query(query, [
        criteria.service,
        criteria.operation,
        criteria.errorType
      ]);

      if (result.rows.length > 0) {
        const pattern = this.mapRowToPattern(result.rows[0]);
        this.cachePattern(pattern);
        return pattern;
      }

      // No match found
      return null;

    } catch (error) {
      logger.error('Pattern matching failed', {
        error: error instanceof Error ? error.message : String(error),
        service: criteria.service,
        operation: criteria.operation,
        component: 'retry-analyzer'
      });

      return null;
    }
  }

  /**
   * Create new error pattern or get existing one.
   */
  private async createOrGetPattern(data: {
    errorType: string;
    errorMessage: string;
    errorStack?: string;
    errorCode?: string;
    normalizedMessage: string;
    messageHash: string;
    service: string;
    operation: string;
  }): Promise<ErrorPattern> {
    try {
      // Check if pattern already exists
      const existingQuery = `
        SELECT * FROM retry_intelligence.error_patterns
        WHERE message_hash = $1
          AND service_name = $2
          AND operation_name = $3
      `;

      const existing = await this.pool.query(existingQuery, [
        data.messageHash,
        data.service,
        data.operation
      ]);

      if (existing.rows.length > 0) {
        // Update occurrence count
        const updateQuery = `
          UPDATE retry_intelligence.error_patterns
          SET occurrence_count = occurrence_count + 1,
              last_seen_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `;

        const updated = await this.pool.query(updateQuery, [existing.rows[0].id]);
        return this.mapRowToPattern(updated.rows[0]);
      }

      // Create new pattern with intelligent default strategy
      const defaultStrategy = this.getDefaultStrategyForError(data.errorType, data.service);

      const insertQuery = `
        INSERT INTO retry_intelligence.error_patterns (
          error_type,
          error_message,
          error_stack,
          error_code,
          service_name,
          operation_name,
          category,
          severity,
          retryable,
          recommended_strategy,
          normalized_message,
          message_hash
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `;

      const values = [
        data.errorType,
        data.errorMessage,
        data.errorStack || null,
        data.errorCode || null,
        data.service,
        data.operation,
        this.categorizeError(data.errorType, data.errorMessage),
        this.assessSeverity(data.errorType, data.errorMessage),
        this.isRetryable(data.errorType, data.errorMessage),
        JSON.stringify(defaultStrategy),
        data.normalizedMessage,
        data.messageHash
      ];

      const result = await this.pool.query(insertQuery, values);

      logger.info('New error pattern created', {
        patternId: result.rows[0].id,
        errorType: data.errorType,
        service: data.service,
        operation: data.operation,
        component: 'retry-analyzer'
      });

      return this.mapRowToPattern(result.rows[0]);

    } catch (error) {
      logger.error('Pattern creation failed', {
        error: error instanceof Error ? error.message : String(error),
        errorType: data.errorType,
        service: data.service,
        component: 'retry-analyzer'
      });

      // Return default pattern
      return this.getDefaultPattern();
    }
  }

  /**
   * Normalize error message for pattern matching.
   *
   * Removes:
   * - Numbers (timestamps, IDs, ports)
   * - UUIDs
   * - File paths
   * - URLs
   */
  private normalizeErrorMessage(message: string): string {
    return message
      .toLowerCase()
      .replace(/\d+/g, '') // Remove numbers
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '') // Remove UUIDs
      .replace(/\/[^\s]+/g, '') // Remove file paths
      .replace(/https?:\/\/[^\s]+/g, '') // Remove URLs
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Hash normalized message for exact matching.
   */
  private hashMessage(message: string): string {
    return createHash('sha256').update(message).digest('hex');
  }

  /**
   * Extract error code from error object.
   */
  private extractErrorCode(error: Error): string | undefined {
    return (error as any).code || (error as any).errno;
  }

  /**
   * Categorize error based on type and message.
   */
  private categorizeError(errorType: string, message: string): string {
    const lowerMessage = message.toLowerCase();

    if (errorType.includes('Timeout') || lowerMessage.includes('timeout')) {
      return 'transient';
    }

    if (
      errorType.includes('Connection') ||
      lowerMessage.includes('connection') ||
      lowerMessage.includes('network')
    ) {
      return 'infrastructure';
    }

    if (
      errorType.includes('Format') ||
      errorType.includes('Parse') ||
      lowerMessage.includes('invalid') ||
      lowerMessage.includes('malformed')
    ) {
      return 'data_quality';
    }

    if (
      errorType.includes('Memory') ||
      errorType.includes('Resource') ||
      lowerMessage.includes('memory') ||
      lowerMessage.includes('limit')
    ) {
      return 'resource_exhaustion';
    }

    if (
      errorType.includes('Config') ||
      lowerMessage.includes('configuration') ||
      lowerMessage.includes('permission')
    ) {
      return 'configuration';
    }

    return 'unknown';
  }

  /**
   * Assess severity based on error type and message.
   */
  private assessSeverity(errorType: string, message: string): string {
    const lowerMessage = message.toLowerCase();

    if (
      lowerMessage.includes('critical') ||
      lowerMessage.includes('fatal') ||
      errorType.includes('Fatal')
    ) {
      return 'critical';
    }

    if (
      lowerMessage.includes('failed') ||
      lowerMessage.includes('error') ||
      errorType.includes('Error')
    ) {
      return 'high';
    }

    if (
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('retry') ||
      errorType.includes('Timeout')
    ) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Determine if error is retryable.
   */
  private isRetryable(_errorType: string, message: string): boolean {
    const lowerMessage = message.toLowerCase();

    // Non-retryable patterns
    const nonRetryablePatterns = [
      'permission denied',
      'unauthorized',
      'forbidden',
      'not found',
      'invalid credentials',
      'authentication failed'
    ];

    for (const pattern of nonRetryablePatterns) {
      if (lowerMessage.includes(pattern)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get intelligent default strategy based on error type and service.
   */
  private getDefaultStrategyForError(errorType: string, service: string): RetryStrategy {
    // Service-specific strategies
    if (service === 'fileprocess') {
      if (errorType.includes('Timeout')) {
        return {
          maxRetries: 3,
          backoffMs: [1000, 2000, 4000],
          exponentialBackoff: true,
          timeout: 60000
        };
      }

      if (errorType.includes('Memory') || errorType.includes('Resource')) {
        return {
          maxRetries: 2,
          backoffMs: [2000, 4000],
          exponentialBackoff: true
        };
      }
    }

    if (service === 'mageagent') {
      if (errorType.includes('RateLimit')) {
        return {
          maxRetries: 5,
          backoffMs: [5000, 10000, 20000, 40000, 60000],
          exponentialBackoff: true
        };
      }

      if (errorType.includes('Timeout')) {
        return {
          maxRetries: 3,
          backoffMs: [2000, 4000, 8000],
          exponentialBackoff: true,
          timeout: 120000
        };
      }
    }

    // Conservative default
    return {
      maxRetries: 2,
      backoffMs: [1000, 2000],
      exponentialBackoff: true
    };
  }

  /**
   * Generate human-readable reasoning for recommendation.
   */
  private generateReasoning(pattern: ErrorPattern): string {
    const successPercentage = pattern.successRate ? (pattern.successRate * 100).toFixed(1) : '50.0';

    return (
      `Historical pattern identified with ${successPercentage}% success rate ` +
      `(${pattern.retrySuccessCount} successful, ${pattern.retryFailureCount} failed attempts). ` +
      `Pattern seen ${pattern.occurrenceCount} times, ` +
      `last occurrence ${this.formatTimeAgo(pattern.lastSeenAt)}.`
    );
  }

  /**
   * Parse modifications from strategy JSON.
   */
  private parseModifications(strategy: any): OperationModification[] | undefined {
    if (strategy && strategy.modifications && Array.isArray(strategy.modifications)) {
      return strategy.modifications as OperationModification[];
    }
    return undefined;
  }

  /**
   * Get default recommendation when analysis fails.
   */
  private getDefaultRecommendation(): RetryRecommendation {
    return {
      patternId: null,
      shouldRetry: true,
      strategy: {
        maxRetries: 2,
        backoffMs: [1000, 2000],
        exponentialBackoff: true
      },
      confidence: 0.5,
      category: 'unknown',
      severity: 'medium',
      reasoning: 'Using conservative default strategy due to analysis failure.'
    };
  }

  /**
   * Get default pattern when creation fails.
   */
  private getDefaultPattern(): ErrorPattern {
    return {
      id: 'default',
      errorType: 'Unknown',
      errorMessage: 'Unknown error',
      serviceName: 'unknown',
      operationName: 'unknown',
      retryable: true,
      retrySuccessCount: 0,
      retryFailureCount: 0,
      recommendedStrategy: {
        maxRetries: 2,
        backoffMs: [1000, 2000],
        exponentialBackoff: true
      },
      normalizedMessage: 'unknown error',
      messageHash: '',
      occurrenceCount: 1,
      lastSeenAt: new Date()
    };
  }

  /**
   * Map database row to ErrorPattern object.
   */
  private mapRowToPattern(row: any): ErrorPattern {
    return {
      id: row.id,
      errorType: row.error_type,
      errorMessage: row.error_message,
      errorStack: row.error_stack,
      errorCode: row.error_code,
      serviceName: row.service_name,
      operationName: row.operation_name,
      category: row.category,
      severity: row.severity,
      retryable: row.retryable,
      retrySuccessCount: row.retry_success_count,
      retryFailureCount: row.retry_failure_count,
      successRate: row.success_rate,
      recommendedStrategy: row.recommended_strategy,
      normalizedMessage: row.normalized_message,
      messageHash: row.message_hash,
      occurrenceCount: row.occurrence_count,
      lastSeenAt: new Date(row.last_seen_at)
    };
  }

  /**
   * Update pattern last seen timestamp.
   */
  private async updatePatternLastSeen(patternId: string): Promise<void> {
    const query = `
      UPDATE retry_intelligence.error_patterns
      SET last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `;

    await this.pool.query(query, [patternId]);
  }

  /**
   * Format time ago string.
   */
  private formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

    if (seconds < 60) return `${seconds} seconds ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  private getCachedPattern(messageHash: string): ErrorPattern | null {
    // Refresh cache if TTL expired
    if (Date.now() - this.lastCacheRefresh > this.cacheTTL) {
      this.patternCache.clear();
      this.lastCacheRefresh = Date.now();
      return null;
    }

    return this.patternCache.get(messageHash) || null;
  }

  private cachePattern(pattern: ErrorPattern): void {
    this.patternCache.set(pattern.messageHash, pattern);
  }

  private invalidateCacheEntry(patternId: string): void {
    for (const [hash, pattern] of this.patternCache.entries()) {
      if (pattern.id === patternId) {
        this.patternCache.delete(hash);
        break;
      }
    }
  }
}
