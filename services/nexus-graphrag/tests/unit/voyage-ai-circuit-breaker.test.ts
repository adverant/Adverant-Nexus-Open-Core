/**
 * Voyage AI Circuit Breaker Unit Tests
 * Phase 3.2: Test circuit breaker state transitions and behavior
 *
 * Tests:
 * - Circuit state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
 * - Failure threshold detection
 * - Automatic recovery after timeout
 * - Request blocking when circuit is open
 * - Half-open state probing
 */

import { CircuitBreaker, CircuitBreakerState } from '@adverant/resilience';
import { logger } from '../../src/utils/logger';

describe('Voyage AI Circuit Breaker Unit Tests', () => {
  let circuitBreaker: CircuitBreaker;

  // Mock function that can be controlled to succeed or fail
  let mockVoyageRequest: jest.Mock;

  beforeEach(() => {
    // Create circuit breaker with test-friendly thresholds
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,       // Open after 3 failures
      successThreshold: 2,       // Close after 2 successes in half-open
      timeout: 1000,             // 1 second timeout for tests
      monitoringPeriod: 10000    // 10 second monitoring window
    });

    // Create mock function for Voyage AI requests
    mockVoyageRequest = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Phase 3.2.1: Initial State', () => {
    test('should start in CLOSED state', () => {
      const state = circuitBreaker.getState();
      expect(state).toBe(CircuitBreakerState.CLOSED);

      logger.info('[TEST] Circuit breaker starts in CLOSED state');
    });

    test('should allow requests in CLOSED state', async () => {
      mockVoyageRequest.mockResolvedValue({ success: true });

      const result = await circuitBreaker.execute(mockVoyageRequest);

      expect(result).toEqual({ success: true });
      expect(mockVoyageRequest).toHaveBeenCalledTimes(1);

      logger.info('[TEST] Requests allowed in CLOSED state');
    });

    test('should track metrics in CLOSED state', async () => {
      mockVoyageRequest.mockResolvedValue({ success: true });

      await circuitBreaker.execute(mockVoyageRequest);
      await circuitBreaker.execute(mockVoyageRequest);

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successCount).toBe(2);
      expect(metrics.failureCount).toBe(0);

      logger.info('[TEST] Metrics tracked in CLOSED state', metrics);
    });
  });

  describe('Phase 3.2.2: Transition to OPEN State', () => {
    test('should open circuit after failure threshold reached', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Fail 3 times (threshold)
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected to throw
        }
      }

      const state = circuitBreaker.getState();
      expect(state).toBe(CircuitBreakerState.OPEN);

      logger.info('[TEST] Circuit opened after failure threshold');
    });

    test('should block requests when circuit is OPEN', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      // Reset mock call count
      mockVoyageRequest.mockClear();

      // Try another request
      await expect(
        circuitBreaker.execute(mockVoyageRequest)
      ).rejects.toThrow(/circuit.*open/i);

      // Request should be blocked without calling the function
      expect(mockVoyageRequest).not.toHaveBeenCalled();

      logger.info('[TEST] Requests blocked when circuit OPEN');
    });

    test('should track failure count correctly', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      let failureCount = 0;
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          failureCount++;
        }
      }

      expect(failureCount).toBe(3);

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBe(3);
      expect(metrics.successCount).toBe(0);

      logger.info('[TEST] Failure count tracked correctly', metrics);
    });
  });

  describe('Phase 3.2.3: Transition to HALF_OPEN State', () => {
    test('should transition to HALF_OPEN after timeout', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Wait for timeout (1 second)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Circuit should transition to HALF_OPEN
      const state = circuitBreaker.getState();
      expect(state).toBe(CircuitBreakerState.HALF_OPEN);

      logger.info('[TEST] Circuit transitioned to HALF_OPEN after timeout');
    }, 10000);

    test('should allow probe request in HALF_OPEN state', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      // Wait for transition to HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Now set mock to succeed
      mockVoyageRequest.mockResolvedValue({ success: true });
      mockVoyageRequest.mockClear();

      // Try a probe request
      const result = await circuitBreaker.execute(mockVoyageRequest);

      expect(result).toEqual({ success: true });
      expect(mockVoyageRequest).toHaveBeenCalledTimes(1);

      logger.info('[TEST] Probe request allowed in HALF_OPEN state');
    }, 10000);

    test('should return to OPEN if probe request fails', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      // Wait for transition to HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);

      // Probe request fails
      try {
        await circuitBreaker.execute(mockVoyageRequest);
      } catch (error) {
        // Expected
      }

      // Should return to OPEN
      const state = circuitBreaker.getState();
      expect(state).toBe(CircuitBreakerState.OPEN);

      logger.info('[TEST] Circuit returned to OPEN after failed probe');
    }, 10000);
  });

  describe('Phase 3.2.4: Recovery to CLOSED State', () => {
    test('should close circuit after success threshold in HALF_OPEN', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      // Wait for transition to HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Now set mock to succeed
      mockVoyageRequest.mockResolvedValue({ success: true });

      // Execute 2 successful requests (success threshold)
      await circuitBreaker.execute(mockVoyageRequest);
      await circuitBreaker.execute(mockVoyageRequest);

      // Should transition back to CLOSED
      const state = circuitBreaker.getState();
      expect(state).toBe(CircuitBreakerState.CLOSED);

      logger.info('[TEST] Circuit closed after success threshold');
    }, 10000);

    test('should reset failure count when circuit closes', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      // Wait for transition to HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Close circuit with successful requests
      mockVoyageRequest.mockResolvedValue({ success: true });
      await circuitBreaker.execute(mockVoyageRequest);
      await circuitBreaker.execute(mockVoyageRequest);

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      // Failure count should be reset
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBe(0);

      logger.info('[TEST] Failure count reset when circuit closed', metrics);
    }, 10000);

    test('should handle full recovery cycle', async () => {
      // Start: CLOSED state
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      // Phase 1: Fail and open circuit
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Phase 2: Wait for timeout → HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);

      // Phase 3: Successful probes → CLOSED
      mockVoyageRequest.mockResolvedValue({ success: true });
      await circuitBreaker.execute(mockVoyageRequest);
      await circuitBreaker.execute(mockVoyageRequest);
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      logger.info('[TEST] Full recovery cycle completed', {
        cycle: 'CLOSED → OPEN → HALF_OPEN → CLOSED'
      });
    }, 10000);
  });

  describe('Phase 3.2.5: Edge Cases', () => {
    test('should handle mixed success/failure in CLOSED state', async () => {
      // Success
      mockVoyageRequest.mockResolvedValueOnce({ success: true });
      await circuitBreaker.execute(mockVoyageRequest);

      // Failure
      mockVoyageRequest.mockRejectedValueOnce(new Error('Error'));
      try {
        await circuitBreaker.execute(mockVoyageRequest);
      } catch (error) {
        // Expected
      }

      // Success
      mockVoyageRequest.mockResolvedValueOnce({ success: true });
      await circuitBreaker.execute(mockVoyageRequest);

      // Should still be CLOSED (not enough consecutive failures)
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successCount).toBe(2);
      expect(metrics.failureCount).toBe(1);

      logger.info('[TEST] Mixed success/failure handled correctly', metrics);
    });

    test('should handle rapid successive failures', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Execute 10 failures rapidly
      const promises = Array.from({ length: 10 }, () =>
        circuitBreaker.execute(mockVoyageRequest).catch(() => {})
      );

      await Promise.all(promises);

      // Circuit should be OPEN
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Subsequent requests should be blocked
      mockVoyageRequest.mockClear();
      await expect(
        circuitBreaker.execute(mockVoyageRequest)
      ).rejects.toThrow(/circuit.*open/i);

      expect(mockVoyageRequest).not.toHaveBeenCalled();

      logger.info('[TEST] Rapid successive failures handled correctly');
    });

    test('should handle timeout during request execution', async () => {
      // Mock a request that takes longer than circuit timeout
      mockVoyageRequest.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ success: true }), 2000))
      );

      // This should timeout and count as failure
      try {
        await circuitBreaker.execute(mockVoyageRequest, { timeout: 500 });
      } catch (error) {
        expect((error as Error).message).toMatch(/timeout/i);
      }

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBeGreaterThan(0);

      logger.info('[TEST] Request timeout handled as failure', metrics);
    }, 10000);

    test('should not open circuit if failures are spread over time', async () => {
      mockVoyageRequest.mockRejectedValue(new Error('API Error'));

      // Fail twice
      for (let i = 0; i < 2; i++) {
        try {
          await circuitBreaker.execute(mockVoyageRequest);
        } catch (error) {
          // Expected
        }
      }

      // Wait longer than monitoring period
      await new Promise(resolve => setTimeout(resolve, 11000));

      // Failure count should reset
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failureCount).toBe(0);

      // Circuit should still be CLOSED
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      logger.info('[TEST] Failures spread over time do not open circuit');
    }, 20000);
  });

  describe('Phase 3.2.6: Integration with Voyage AI Client', () => {
    test('should protect Voyage AI embedding requests', async () => {
      // Simulate Voyage AI request function
      const voyageEmbedRequest = jest.fn().mockRejectedValue(
        new Error('Voyage AI service unavailable')
      );

      const protectedRequest = () => circuitBreaker.execute(voyageEmbedRequest);

      // Fail threshold times to open circuit
      for (let i = 0; i < 3; i++) {
        try {
          await protectedRequest();
        } catch (error) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Further requests should fail fast without calling Voyage API
      voyageEmbedRequest.mockClear();

      await expect(protectedRequest()).rejects.toThrow(/circuit.*open/i);
      expect(voyageEmbedRequest).not.toHaveBeenCalled();

      logger.info('[TEST] Circuit breaker protects Voyage AI requests');
    });

    test('should allow recovery when Voyage AI service recovers', async () => {
      const voyageEmbedRequest = jest.fn();

      // Fail to open circuit
      voyageEmbedRequest.mockRejectedValue(new Error('Service down'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(voyageEmbedRequest);
        } catch (error) {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Wait for HALF_OPEN
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Service recovers
      voyageEmbedRequest.mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: 'voyage-3'
      });

      // Successful probes
      await circuitBreaker.execute(voyageEmbedRequest);
      await circuitBreaker.execute(voyageEmbedRequest);

      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);

      logger.info('[TEST] Circuit recovers when Voyage AI service recovers');
    }, 10000);

    test('should track Voyage AI request metrics', async () => {
      const voyageEmbedRequest = jest.fn().mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
        model: 'voyage-3'
      });

      // Execute multiple successful requests
      for (let i = 0; i < 5; i++) {
        await circuitBreaker.execute(voyageEmbedRequest);
      }

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successCount).toBe(5);
      expect(metrics.failureCount).toBe(0);
      expect(metrics.totalRequests).toBe(5);

      logger.info('[TEST] Voyage AI request metrics tracked', metrics);
    });
  });

  describe('Phase 3.2.7: Configuration Validation', () => {
    test('should reject invalid failure threshold', () => {
      expect(() => {
        new CircuitBreaker({
          failureThreshold: 0, // Invalid
          successThreshold: 2,
          timeout: 1000
        });
      }).toThrow();

      logger.info('[TEST] Invalid failure threshold rejected');
    });

    test('should reject invalid success threshold', () => {
      expect(() => {
        new CircuitBreaker({
          failureThreshold: 3,
          successThreshold: 0, // Invalid
          timeout: 1000
        });
      }).toThrow();

      logger.info('[TEST] Invalid success threshold rejected');
    });

    test('should reject invalid timeout', () => {
      expect(() => {
        new CircuitBreaker({
          failureThreshold: 3,
          successThreshold: 2,
          timeout: -1 // Invalid
        });
      }).toThrow();

      logger.info('[TEST] Invalid timeout rejected');
    });

    test('should use default values when not provided', () => {
      const cb = new CircuitBreaker({});

      const metrics = cb.getMetrics();
      expect(metrics).toBeDefined();

      logger.info('[TEST] Default configuration values used');
    });
  });
});
