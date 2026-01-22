/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures and enables fast failure for unhealthy services
 */

import { logger } from './logger.js';

export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',           // Service is down, fail fast
  HALF_OPEN = 'HALF_OPEN'  // Testing recovery
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening circuit
  successThreshold: number;       // Number of successes in HALF_OPEN to close
  timeout: number;                // Time in ms before trying HALF_OPEN from OPEN
  monitoringPeriod: number;       // Time window for counting failures
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailure: number | null;
  lastSuccess: number | null;
  nextAttempt: number | null;
}

/**
 * CircuitBreaker class - Implements circuit breaker pattern for service calls
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number = 0;
  private successes: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private nextAttemptTime: number | null = null;
  private config: CircuitBreakerConfig;
  private name: string;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    this.name = name;
    this.config = {
      failureThreshold: config?.failureThreshold || 5,
      successThreshold: config?.successThreshold || 2,
      timeout: config?.timeout || 30000, // 30 seconds
      monitoringPeriod: config?.monitoringPeriod || 60000 // 1 minute
    };

    logger.debug('Circuit breaker created', {
      name: this.name,
      config: this.config
    });
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        logger.info('Circuit breaker attempting reset', { name: this.name });
        this.state = CircuitState.HALF_OPEN;
        this.successes = 0;
      } else {
        const waitTime = this.nextAttemptTime ? this.nextAttemptTime - Date.now() : 0;
        logger.warn('Circuit breaker is OPEN, failing fast', {
          name: this.name,
          waitTime: `${Math.ceil(waitTime / 1000)}s`
        });
        throw new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.name}. Service is currently unavailable. Retry in ${Math.ceil(waitTime / 1000)}s.`
        );
      }
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
    this.lastSuccessTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++;
      logger.debug('Circuit breaker success in HALF_OPEN', {
        name: this.name,
        successes: this.successes,
        threshold: this.config.successThreshold
      });

      if (this.successes >= this.config.successThreshold) {
        this.reset();
        logger.info('Circuit breaker CLOSED - service recovered', { name: this.name });
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success in CLOSED state
      this.failures = 0;
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    logger.debug('Circuit breaker failure recorded', {
      name: this.name,
      failures: this.failures,
      threshold: this.config.failureThreshold,
      state: this.state
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in HALF_OPEN reopens the circuit
      this.trip();
      logger.warn('Circuit breaker reopened - recovery attempt failed', { name: this.name });
    } else if (this.state === CircuitState.CLOSED) {
      // Check if we should trip the circuit
      if (this.failures >= this.config.failureThreshold) {
        this.trip();
        logger.error('Circuit breaker OPENED - failure threshold exceeded', {
          name: this.name,
          failures: this.failures,
          threshold: this.config.failureThreshold
        });
      }
    }
  }

  /**
   * Trip the circuit breaker (move to OPEN state)
   */
  private trip(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.config.timeout;
    this.successes = 0;
  }

  /**
   * Reset the circuit breaker (move to CLOSED state)
   */
  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.nextAttemptTime = null;
  }

  /**
   * Check if we should attempt to reset from OPEN to HALF_OPEN
   */
  private shouldAttemptReset(): boolean {
    return this.nextAttemptTime !== null && Date.now() >= this.nextAttemptTime;
  }

  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailure: this.lastFailureTime,
      lastSuccess: this.lastSuccessTime,
      nextAttempt: this.nextAttemptTime
    };
  }

  /**
   * Force reset the circuit breaker
   */
  forceReset(): void {
    logger.info('Circuit breaker force reset', { name: this.name });
    this.reset();
  }

  /**
   * Force trip the circuit breaker
   */
  forceTrip(): void {
    logger.info('Circuit breaker force trip', { name: this.name });
    this.trip();
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit breaker is healthy (not OPEN)
   */
  isHealthy(): boolean {
    return this.state !== CircuitState.OPEN;
  }
}

/**
 * Circuit Breaker Error
 */
export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Circuit Breaker Manager - Manages multiple circuit breakers
 */
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create circuit breaker for a service
   */
  getBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(name);

    if (!breaker) {
      breaker = new CircuitBreaker(name, config);
      this.breakers.set(name, breaker);
      logger.debug('Circuit breaker registered', { name });
    }

    return breaker;
  }

  /**
   * Get all circuit breaker stats
   */
  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};

    for (const [name, breaker] of this.breakers.entries()) {
      stats[name] = breaker.getStats();
    }

    return stats;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    logger.info('Resetting all circuit breakers');
    for (const breaker of this.breakers.values()) {
      breaker.forceReset();
    }
  }

  /**
   * Check if all services are healthy
   */
  allHealthy(): boolean {
    for (const breaker of this.breakers.values()) {
      if (!breaker.isHealthy()) {
        return false;
      }
    }
    return true;
  }
}

// Export singleton instance
export const circuitBreakerManager = new CircuitBreakerManager();
