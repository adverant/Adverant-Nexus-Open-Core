/**
 * Circuit Breaker Pattern Implementation
 * Prevents cascading failures by temporarily blocking requests to failing services
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests are rejected immediately
 * - HALF_OPEN: Testing if service has recovered
 */

import { logger } from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',          // Failing, reject requests
  HALF_OPEN = 'HALF_OPEN' // Testing recovery
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Number of successes needed to close from half-open */
  successThreshold: number;
  /** Time in milliseconds to wait before trying half-open */
  timeout: number;
  /** Name for logging and identification */
  name: string;
  /** Optional: Monitor function called on state changes */
  onStateChange?: (state: CircuitState, name: string) => void;
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string, public serviceName: string, public nextAttemptTime: Date) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Circuit Breaker implementation
 * Wraps service calls and manages failure/recovery states
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private nextAttempt: number = Date.now();
  private lastError: Error | null = null;

  constructor(private config: CircuitBreakerConfig) {
    logger.info('Circuit breaker initialized', {
      name: config.name,
      failureThreshold: config.failureThreshold,
      timeout: config.timeout
    });
  }

  /**
   * Execute a function with circuit breaker protection
   * Throws CircuitBreakerOpenError if circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check circuit state
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        const nextAttemptDate = new Date(this.nextAttempt);
        throw new CircuitBreakerOpenError(
          `Circuit breaker '${this.config.name}' is OPEN. ` +
          `Service is temporarily unavailable. Next attempt at ${nextAttemptDate.toISOString()}. ` +
          `Last error: ${this.lastError?.message || 'Unknown'}`,
          this.config.name,
          nextAttemptDate
        );
      }

      // Transition to HALF_OPEN to test recovery
      this.transitionTo(CircuitState.HALF_OPEN);
      logger.info(`Circuit breaker '${this.config.name}' transitioning to HALF_OPEN (testing recovery)`);
    }

    // Execute the function
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error: any) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.failureCount = 0;
    this.lastError = null;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;

      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
        this.successCount = 0;
        logger.info(`Circuit breaker '${this.config.name}' CLOSED (service recovered)`, {
          successCount: this.config.successThreshold
        });
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: Error): void {
    this.failureCount++;
    this.successCount = 0;
    this.lastError = error;

    logger.warn(`Circuit breaker '${this.config.name}' recorded failure`, {
      failureCount: this.failureCount,
      threshold: this.config.failureThreshold,
      error: error.message
    });

    if (this.failureCount >= this.config.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
      this.nextAttempt = Date.now() + this.config.timeout;

      logger.error(
        `Circuit breaker '${this.config.name}' OPENED due to ${this.failureCount} consecutive failures. ` +
        `Will retry at ${new Date(this.nextAttempt).toISOString()}`,
        {
          failureCount: this.failureCount,
          threshold: this.config.failureThreshold,
          timeout: this.config.timeout,
          lastError: error.message
        }
      );
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (this.config.onStateChange) {
      this.config.onStateChange(newState, this.config.name);
    }

    logger.info(`Circuit breaker '${this.config.name}' state transition`, {
      from: oldState,
      to: newState
    });
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    return {
      name: this.config.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttempt: this.state === CircuitState.OPEN ? new Date(this.nextAttempt) : null,
      lastError: this.lastError?.message || null
    };
  }

  /**
   * Manually reset the circuit breaker (use with caution)
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastError = null;

    logger.info(`Circuit breaker '${this.config.name}' manually reset to CLOSED`);
  }
}

/**
 * Pre-configured circuit breakers for external services
 */

// Voyage AI circuit breaker
export const voyageCircuitBreaker = new CircuitBreaker({
  name: 'VoyageAI',
  failureThreshold: 5,      // Open after 5 consecutive failures
  successThreshold: 2,      // Close after 2 successes in half-open
  timeout: 60000,          // 1 minute before retry
  onStateChange: (state, name) => {
    logger.info(`${name} circuit breaker state changed`, { state });
  }
});

// OpenRouter circuit breaker
export const openRouterCircuitBreaker = new CircuitBreaker({
  name: 'OpenRouter',
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60000,
  onStateChange: (state, name) => {
    logger.info(`${name} circuit breaker state changed`, { state });
  }
});

// Neo4j circuit breaker
export const neo4jCircuitBreaker = new CircuitBreaker({
  name: 'Neo4j',
  failureThreshold: 3,      // More sensitive for database
  successThreshold: 2,
  timeout: 30000,          // 30 seconds for database
  onStateChange: (state, name) => {
    logger.info(`${name} circuit breaker state changed`, { state });
  }
});

// Qdrant circuit breaker
export const qdrantCircuitBreaker = new CircuitBreaker({
  name: 'Qdrant',
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 30000,
  onStateChange: (state, name) => {
    logger.info(`${name} circuit breaker state changed`, { state });
  }
});

/**
 * Get all circuit breaker metrics
 */
export function getAllCircuitBreakerMetrics() {
  return {
    voyageAI: voyageCircuitBreaker.getMetrics(),
    openRouter: openRouterCircuitBreaker.getMetrics(),
    neo4j: neo4jCircuitBreaker.getMetrics(),
    qdrant: qdrantCircuitBreaker.getMetrics()
  };
}

/**
 * Reset all circuit breakers (use with extreme caution)
 */
export function resetAllCircuitBreakers(): void {
  voyageCircuitBreaker.reset();
  openRouterCircuitBreaker.reset();
  neo4jCircuitBreaker.reset();
  qdrantCircuitBreaker.reset();
  logger.warn('All circuit breakers have been manually reset');
}
