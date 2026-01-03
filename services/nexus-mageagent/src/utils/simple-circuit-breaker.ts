/**
 * Simple Circuit Breaker Pattern Implementation
 *
 * States:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Too many failures, reject all requests immediately
 * - HALF_OPEN: Testing recovery, allow limited requests through
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

const logger = createLogger('CircuitBreaker');

export interface CircuitBreakerConfig {
  failureThreshold: number;   // Number of failures before opening circuit
  resetTimeout: number;        // Time in ms to wait before attempting recovery
  halfOpenRetries: number;     // Number of test requests in half-open state
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private successCount: number = 0;
  private nextAttempt: number = Date.now();
  private config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    super();
    this.config = config;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();

    // Check circuit state
    if (this.state === 'open') {
      if (now < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN - service unavailable');
      }
      // Time to test recovery
      this.transitionToHalfOpen();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === 'half_open') {
      this.successCount++;

      if (this.successCount >= this.config.halfOpenRetries) {
        this.transitionToClosed();
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failureCount++;

    if (this.state === 'half_open') {
      // Failed during recovery test - reopen circuit
      this.transitionToOpen();
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.transitionToOpen();
    }
  }

  /**
   * Transition to OPEN state
   */
  private transitionToOpen(): void {
    this.state = 'open';
    this.nextAttempt = Date.now() + this.config.resetTimeout;

    logger.error('Circuit breaker opened', {
      failureCount: this.failureCount,
      nextAttempt: new Date(this.nextAttempt).toISOString()
    });

    this.emit('open');
  }

  /**
   * Transition to HALF_OPEN state
   */
  private transitionToHalfOpen(): void {
    this.state = 'half_open';
    this.successCount = 0;
    this.failureCount = 0;

    logger.info('Circuit breaker half-open - testing recovery');

    this.emit('halfOpen');
  }

  /**
   * Transition to CLOSED state
   */
  private transitionToClosed(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;

    logger.info('Circuit breaker closed - service recovered');

    this.emit('closed');
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    this.transitionToClosed();
  }

  /**
   * PHASE 4 FIX: Cleanup method to remove event listeners
   * Prevents memory leaks from EventEmitter
   */
  destroy(): void {
    // Reset state
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;

    // Remove all event listeners
    this.removeAllListeners();

    logger.debug('CircuitBreaker destroyed');
  }
}
