/**
 * Circuit Breaker Adapters
 * Pre-configured circuit breakers for GraphRAG services using @adverant/resilience
 */

import { CircuitBreaker } from '@adverant/resilience';
import { CircuitBreakerOpenError } from '@adverant/errors';
import { logger } from './logger';

// Re-export CircuitBreakerOpenError for backward compatibility
export { CircuitBreakerOpenError };

// Voyage AI circuit breaker
export const voyageCircuitBreaker = new CircuitBreaker({
  name: 'VoyageAI',
  errorThreshold: 50,
  volumeThreshold: 5,
  resetTimeout: 60000,
  timeout: 30000,
  onStateChange: (state) => {
    logger.info('VoyageAI circuit breaker state changed', { state });
  }
});

// OpenRouter circuit breaker
export const openRouterCircuitBreaker = new CircuitBreaker({
  name: 'OpenRouter',
  errorThreshold: 50,
  volumeThreshold: 5,
  resetTimeout: 60000,
  timeout: 60000,
  onStateChange: (state) => {
    logger.info('OpenRouter circuit breaker state changed', { state });
  }
});

// Neo4j circuit breaker
export const neo4jCircuitBreaker = new CircuitBreaker({
  name: 'Neo4j',
  errorThreshold: 30,
  volumeThreshold: 3,
  resetTimeout: 30000,
  timeout: 10000,
  onStateChange: (state) => {
    logger.info('Neo4j circuit breaker state changed', { state });
  }
});

// Qdrant circuit breaker
export const qdrantCircuitBreaker = new CircuitBreaker({
  name: 'Qdrant',
  errorThreshold: 30,
  volumeThreshold: 3,
  resetTimeout: 30000,
  timeout: 10000,
  onStateChange: (state) => {
    logger.info('Qdrant circuit breaker state changed', { state });
  }
});

/**
 * Get all circuit breaker metrics
 */
export function getAllCircuitBreakerMetrics() {
  return {
    voyageAI: voyageCircuitBreaker.getStats(),
    openRouter: openRouterCircuitBreaker.getStats(),
    neo4j: neo4jCircuitBreaker.getStats(),
    qdrant: qdrantCircuitBreaker.getStats()
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
