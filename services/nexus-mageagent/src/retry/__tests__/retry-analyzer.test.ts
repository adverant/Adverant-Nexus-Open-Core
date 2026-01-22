/**
 * Retry Analyzer - Unit Tests
 *
 * Comprehensive test suite for ML-based error pattern recognition.
 *
 * @module retry/__tests__/retry-analyzer.test
 */

import { Pool } from 'pg';
import { RetryAnalyzer } from '../retry-analyzer';
import { ErrorContext } from '../types';

// Mock PostgreSQL pool
const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn()
} as any as Pool;

describe('RetryAnalyzer', () => {
  let analyzer: RetryAnalyzer;

  beforeEach(() => {
    jest.clearAllMocks();
    analyzer = new RetryAnalyzer(mockPool);
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('Initialization', () => {
    it('should initialize with database pool', () => {
      expect(analyzer).toBeInstanceOf(RetryAnalyzer);
    });

    it('should throw error if pool not provided', () => {
      expect(() => new RetryAnalyzer(null as any)).toThrow(
        'RetryAnalyzer initialization failed'
      );
    });
  });

  // ==========================================================================
  // Error Analysis Tests
  // ==========================================================================

  describe('analyzeError', () => {
    const mockContext: ErrorContext = {
      service: 'mageagent',
      operation: 'agent_execution',
      attempt: 1
    };

    it('should analyze timeout error and recommend retry', async () => {
      // Mock pattern found in database
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pattern-123',
            error_type: 'TimeoutError',
            service_name: 'mageagent',
            operation_name: 'agent_execution',
            category: 'transient',
            severity: 'medium',
            retryable: true,
            success_rate: 0.78,
            retry_success_count: 78,
            retry_failure_count: 22,
            occurrence_count: 150,
            recommended_strategy: {
              maxRetries: 3,
              backoffMs: [2000, 4000, 8000],
              exponentialBackoff: true
            },
            last_seen_at: new Date()
          }
        ]
      });

      const error = new Error('Request timeout after 30 seconds');
      error.name = 'TimeoutError';

      const recommendation = await analyzer.analyzeError(error, mockContext);

      expect(recommendation).toMatchObject({
        patternId: 'pattern-123',
        shouldRetry: true,
        confidence: 0.78,
        category: 'transient',
        severity: 'medium'
      });

      expect(recommendation.strategy).toMatchObject({
        maxRetries: 3,
        backoffMs: [2000, 4000, 8000],
        exponentialBackoff: true
      });
    });

    it('should create new pattern for unknown error', async () => {
      // No existing pattern
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // Pattern creation
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // Check existing
      mockPool.query.mockResolvedValueOnce({
        // Insert new
        rows: [
          {
            id: 'new-pattern-456',
            error_type: 'CustomError',
            service_name: 'mageagent',
            operation_name: 'agent_execution',
            category: 'unknown',
            severity: 'medium',
            retryable: true,
            success_rate: null,
            retry_success_count: 0,
            retry_failure_count: 0,
            occurrence_count: 1,
            recommended_strategy: {
              maxRetries: 2,
              backoffMs: [1000, 2000],
              exponentialBackoff: true
            },
            normalized_message: 'new error occurred',
            message_hash: 'hash123',
            last_seen_at: new Date()
          }
        ]
      });

      const error = new Error('New error occurred');
      error.name = 'CustomError';

      const recommendation = await analyzer.analyzeError(error, mockContext);

      expect(recommendation.patternId).toBe('new-pattern-456');
      expect(recommendation.shouldRetry).toBe(true);
      expect(recommendation.confidence).toBe(0.5); // Default for new patterns
    });

    it('should handle non-retryable errors', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pattern-auth',
            error_type: 'AuthenticationError',
            service_name: 'mageagent',
            operation_name: 'agent_execution',
            category: 'configuration',
            severity: 'high',
            retryable: false,
            success_rate: 0.0,
            retry_success_count: 0,
            retry_failure_count: 10,
            occurrence_count: 10,
            recommended_strategy: {
              maxRetries: 0,
              backoffMs: [],
              exponentialBackoff: false
            },
            last_seen_at: new Date()
          }
        ]
      });

      const error = new Error('Authentication failed');
      error.name = 'AuthenticationError';

      const recommendation = await analyzer.analyzeError(error, mockContext);

      expect(recommendation.shouldRetry).toBe(false);
      expect(recommendation.strategy.maxRetries).toBe(0);
    });

    it('should respect max attempt limit', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pattern-123',
            retryable: true,
            success_rate: 0.5,
            recommended_strategy: {
              maxRetries: 3,
              backoffMs: [1000, 2000, 4000],
              exponentialBackoff: true
            },
            category: 'transient',
            severity: 'medium',
            retry_success_count: 50,
            retry_failure_count: 50,
            occurrence_count: 100,
            last_seen_at: new Date()
          }
        ]
      });

      const error = new Error('Transient error');
      const context = { ...mockContext, attempt: 4 }; // Already at max

      const recommendation = await analyzer.analyzeError(error, context);

      expect(recommendation.shouldRetry).toBe(false); // Exceeded max
    });
  });

  // ==========================================================================
  // Pattern Matching Tests
  // ==========================================================================

  describe('Pattern Matching', () => {
    it('should match patterns by exact hash', async () => {
      const messageHash = '1234567890abcdef';

      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pattern-exact',
            message_hash: messageHash,
            recommended_strategy: { maxRetries: 3, backoffMs: [1000, 2000, 4000], exponentialBackoff: true },
            retryable: true,
            success_rate: 0.9,
            category: 'transient',
            severity: 'low',
            retry_success_count: 90,
            retry_failure_count: 10,
            occurrence_count: 100,
            last_seen_at: new Date()
          }
        ]
      });

      const error = new Error('Exact match error');
      const recommendation = await analyzer.analyzeError(error, {
        service: 'test',
        operation: 'test'
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('message_hash = $1'),
        expect.arrayContaining([expect.any(String)])
      );
    });

    it('should fall back to service + operation match', async () => {
      // First query (exact hash) returns nothing
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // Second query (service + operation) returns match
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'pattern-fallback',
            service_name: 'mageagent',
            operation_name: 'agent_execution',
            error_type: 'TimeoutError',
            recommended_strategy: { maxRetries: 2, backoffMs: [2000, 4000], exponentialBackoff: true },
            retryable: true,
            success_rate: 0.7,
            category: 'transient',
            severity: 'medium',
            retry_success_count: 70,
            retry_failure_count: 30,
            occurrence_count: 100,
            last_seen_at: new Date()
          }
        ]
      });

      const error = new Error('Timeout occurred');
      error.name = 'TimeoutError';

      const recommendation = await analyzer.analyzeError(error, {
        service: 'mageagent',
        operation: 'agent_execution'
      });

      expect(recommendation.patternId).toBe('pattern-fallback');
    });
  });

  // ==========================================================================
  // Retry Recording Tests
  // ==========================================================================

  describe('recordAttempt', () => {
    it('should record successful retry attempt', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'attempt-123' }]
      });

      await analyzer.recordAttempt({
        taskId: 'task-123',
        agentId: 'agent-456',
        patternId: 'pattern-789',
        attempt: 2,
        strategyApplied: {
          maxRetries: 3,
          backoffMs: [1000, 2000, 4000],
          exponentialBackoff: true
        },
        success: true,
        executionTimeMs: 1500
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO retry_intelligence.retry_attempts'),
        expect.arrayContaining([
          'pattern-789',
          'task-123',
          'agent-456',
          2,
          expect.any(String), // JSON strategy
          null,
          true,
          1500,
          null,
          null
        ])
      );
    });

    it('should record failed retry attempt with error', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 'attempt-failed' }]
      });

      await analyzer.recordAttempt({
        taskId: 'task-123',
        attempt: 3,
        strategyApplied: {
          maxRetries: 3,
          backoffMs: [1000, 2000, 4000],
          exponentialBackoff: true
        },
        success: false,
        error: 'Connection refused',
        executionTimeMs: 500
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          null, // No pattern ID
          'task-123',
          null, // No agent ID
          3,
          expect.any(String),
          null,
          false,
          500,
          'Connection refused',
          null
        ])
      );
    });

    it('should handle recording errors gracefully', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database error'));

      // Should not throw
      await expect(
        analyzer.recordAttempt({
          taskId: 'task-123',
          attempt: 1,
          strategyApplied: {
            maxRetries: 3,
            backoffMs: [1000],
            exponentialBackoff: false
          },
          success: true
        })
      ).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // Success Rate Tests
  // ==========================================================================

  describe('getSuccessRate', () => {
    it('should return success rate for known pattern', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ success_rate: 0.85 }]
      });

      const rate = await analyzer.getSuccessRate('timeout error', 'mageagent');

      expect(rate).toBe(0.85);
    });

    it('should return default rate for unknown pattern', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: []
      });

      const rate = await analyzer.getSuccessRate('unknown error', 'mageagent');

      expect(rate).toBe(0.5); // Default
    });

    it('should handle database errors', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database error'));

      const rate = await analyzer.getSuccessRate('error', 'service');

      expect(rate).toBe(0.5); // Default on error
    });
  });

  // ==========================================================================
  // Analytics Tests
  // ==========================================================================

  describe('getAnalytics', () => {
    it('should return comprehensive analytics', async () => {
      // Mock stats query
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            total_patterns: 150,
            retryable_patterns: 120,
            avg_success_rate: 0.75,
            total_successes: 1500,
            total_failures: 500
          }
        ]
      });

      // Mock top patterns query
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            service_name: 'mageagent',
            operation_name: 'agent_execution',
            category: 'transient',
            pattern_count: 50,
            avg_success_rate: 0.8
          }
        ]
      });

      // Mock recent activity query
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            attempts_last_hour: 100,
            successes_last_hour: 75,
            failures_last_hour: 25
          }
        ]
      });

      const analytics = await analyzer.getAnalytics();

      expect(analytics).toMatchObject({
        stats: {
          total_patterns: 150,
          retryable_patterns: 120,
          avg_success_rate: 0.75
        },
        topPatterns: expect.any(Array),
        recentActivity: {
          attempts_last_hour: 100,
          successes_last_hour: 75,
          failures_last_hour: 25
        }
      });
    });

    it('should handle analytics errors', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('Database error'));

      const analytics = await analyzer.getAnalytics();

      expect(analytics).toMatchObject({
        error: 'Failed to retrieve analytics'
      });
    });
  });
});

// ==========================================================================
// Integration Tests
// ==========================================================================

describe('RetryAnalyzer Integration', () => {
  // These tests require a real database connection
  // Skip in CI environments without database

  it.skip('should perform end-to-end error analysis', async () => {
    // Real database integration test
    // Requires PostgreSQL with retry_intelligence schema
  });

  it.skip('should update pattern statistics on retry recording', async () => {
    // Test trigger functionality
    // Verify automatic statistics update
  });
});
