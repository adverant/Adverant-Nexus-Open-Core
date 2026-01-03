/**
 * @adverant/resilience
 * Resilience patterns for Nexus stack services
 */

export { CircuitBreaker, createCircuitBreaker } from './patterns/circuit-breaker';
export { Retry, createRetry, retry } from './patterns/retry';
export { withTimeout, createTimeout, TimeoutError } from './patterns/timeout';
export { Bulkhead, createBulkhead, BulkheadError } from './patterns/bulkhead';

export type {
  CircuitBreakerOptions,
  CircuitState,
  CircuitBreakerStats,
  CircuitBreakerEvent,
  CircuitBreakerEventType,
  RetryOptions,
  RetryResult,
  TimeoutOptions,
  BulkheadOptions,
} from './types';

/**
 * Create resilient wrapper with circuit breaker and retry
 */
import { createCircuitBreaker } from './patterns/circuit-breaker';
import { createRetry } from './patterns/retry';
import { CircuitBreakerOptions, RetryOptions } from './types';

export function createResilientExecutor(options: {
  name: string;
  circuitBreaker?: CircuitBreakerOptions;
  retry?: RetryOptions;
}) {
  const breaker = createCircuitBreaker({
    name: options.name,
    ...options.circuitBreaker,
  });

  const retryHelper = createRetry(options.retry);

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    return breaker.execute(async () => {
      const result = await retryHelper.execute(fn);
      return result.result;
    });
  };
}
