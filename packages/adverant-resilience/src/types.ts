/**
 * Type definitions for @adverant/resilience
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type CircuitBreakerEventType =
  | 'attempt'
  | 'success'
  | 'failure'
  | 'timeout'
  | 'rejected'
  | 'stateChange';

export interface CircuitBreakerEvent {
  type: CircuitBreakerEventType;
  circuitName: string;
  timestamp: Date;
  state: CircuitState;
  data?: {
    duration?: number;
    error?: Error;
    oldState?: CircuitState;
    newState?: CircuitState;
    stats?: CircuitBreakerStats;
  };
}

export interface CircuitBreakerOptions {
  /** Circuit breaker name for logging/metrics */
  name: string;

  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;

  /** Error threshold percentage to open circuit (default: 50) */
  errorThreshold?: number;

  /** Minimum number of requests before evaluating (default: 10) */
  volumeThreshold?: number;

  /** Time in milliseconds before attempting to close circuit (default: 30000) */
  resetTimeout?: number;

  /** Maximum concurrent requests (default: Infinity) */
  maxConcurrent?: number;

  /** Whether to fail fast when circuit is open (default: true) */
  failFast?: boolean;

  /** Monitoring hook for all circuit breaker events */
  monitoringHook?: (event: CircuitBreakerEvent) => void;

  /** Callback when circuit state changes */
  onStateChange?: (state: CircuitState) => void;

  /** Callback when circuit opens */
  onOpen?: () => void;

  /** Callback when circuit closes */
  onClose?: () => void;

  /** Callback when circuit half-opens */
  onHalfOpen?: () => void;
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;

  /** Maximum delay in milliseconds (default: 30000) */
  maxDelay?: number;

  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;

  /** Backoff strategy */
  backoffStrategy?: 'exponential' | 'linear' | 'constant';

  /** Whether to add jitter to delay (default: true) */
  jitter?: boolean;

  /** Function to determine if error should be retried */
  shouldRetry?: (error: any, attempt: number) => boolean;

  /** Callback before retry */
  onRetry?: (error: any, attempt: number, delay: number) => void;
}

export interface TimeoutOptions {
  /** Timeout in milliseconds */
  timeout: number;

  /** Custom timeout error */
  timeoutError?: Error;

  /** Callback when timeout occurs */
  onTimeout?: () => void;
}

export interface BulkheadOptions {
  /** Maximum concurrent executions */
  maxConcurrent: number;

  /** Maximum queue size (default: 0 - no queue) */
  maxQueue?: number;

  /** Timeout for queued requests in milliseconds */
  queueTimeout?: number;

  /** Callback when at capacity */
  onCapacity?: () => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  rejectedRequests: number;
  timeoutRequests: number;
  currentConcurrent: number;
  lastStateChange: Date | null;
  errorRate: number;
}

export interface RetryResult<T> {
  result: T;
  attempts: number;
  totalDelay: number;
}
