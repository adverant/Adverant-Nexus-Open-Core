/**
 * Circuit Breaker Pattern
 * Prevents cascading failures by failing fast when a service is down
 */

import { CircuitBreakerOptions, CircuitState, CircuitBreakerStats, CircuitBreakerEvent, CircuitBreakerEventType } from '../types';

export class CircuitBreaker {
  private name: string;
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private requestCount = 0;
  private rejectedCount = 0;
  private timeoutCount = 0;
  private lastFailureTime: Date | null = null;
  private lastStateChange: Date | null = null;
  private currentConcurrent = 0;
  private resetTimer: NodeJS.Timeout | null = null;

  private readonly timeout: number;
  private readonly errorThreshold: number;
  private readonly volumeThreshold: number;
  private readonly resetTimeout: number;
  private readonly maxConcurrent: number;
  private readonly failFast: boolean;
  private readonly monitoringHook?: (event: CircuitBreakerEvent) => void;
  private readonly onStateChange?: (state: CircuitState) => void;
  private readonly onOpen?: () => void;
  private readonly onClose?: () => void;
  private readonly onHalfOpen?: () => void;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.timeout = options.timeout || 5000;
    this.errorThreshold = options.errorThreshold || 50;
    this.volumeThreshold = options.volumeThreshold || 10;
    this.resetTimeout = options.resetTimeout || 30000;
    this.maxConcurrent = options.maxConcurrent || Infinity;
    this.failFast = options.failFast ?? true;
    this.monitoringHook = options.monitoringHook;
    this.onStateChange = options.onStateChange;
    this.onOpen = options.onOpen;
    this.onClose = options.onClose;
    this.onHalfOpen = options.onHalfOpen;
  }

  /**
   * Emit monitoring event
   */
  private emitEvent(type: CircuitBreakerEventType, data?: CircuitBreakerEvent['data']): void {
    if (this.monitoringHook) {
      this.monitoringHook({
        type,
        circuitName: this.name,
        timestamp: new Date(),
        state: this.state,
        data,
      });
    }
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const startTime = Date.now();

    // Emit attempt event
    this.emitEvent('attempt');

    // Check if circuit is open
    if (this.state === 'OPEN') {
      if (this.failFast) {
        this.rejectedCount++;
        this.emitEvent('rejected', { stats: this.getStats() });
        throw new Error(`Circuit breaker '${this.name}' is OPEN - failing fast`);
      }
    }

    // Check concurrent limit
    if (this.currentConcurrent >= this.maxConcurrent) {
      this.rejectedCount++;
      this.emitEvent('rejected', { stats: this.getStats() });
      throw new Error(`Circuit breaker '${this.name}' at max concurrency (${this.maxConcurrent})`);
    }

    this.currentConcurrent++;
    this.requestCount++;

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(fn);

      // Success
      const duration = Date.now() - startTime;
      this.onSuccess(duration);
      return result;
    } catch (error) {
      // Failure
      const duration = Date.now() - startTime;
      this.onFailure(error, duration);
      throw error;
    } finally {
      this.currentConcurrent--;
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          this.timeoutCount++;
          const timeoutError = new Error(`Circuit breaker '${this.name}' timeout after ${this.timeout}ms`);
          this.emitEvent('timeout', { error: timeoutError });
          reject(timeoutError);
        }, this.timeout);
      }),
    ]);
  }

  /**
   * Handle successful execution
   */
  private onSuccess(duration: number): void {
    this.successCount++;
    this.failureCount = 0; // Reset failure count on success

    // Emit success event
    this.emitEvent('success', { duration, stats: this.getStats() });

    // Transition from HALF_OPEN to CLOSED
    if (this.state === 'HALF_OPEN') {
      this.transitionTo('CLOSED');
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: any, duration: number): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    // Emit failure event
    this.emitEvent('failure', {
      duration,
      error: error instanceof Error ? error : new Error(String(error)),
      stats: this.getStats()
    });

    // Check if we should open the circuit
    if (this.shouldOpen()) {
      this.transitionTo('OPEN');
    }
  }

  /**
   * Check if circuit should open
   */
  private shouldOpen(): boolean {
    // Need minimum volume before opening
    if (this.requestCount < this.volumeThreshold) {
      return false;
    }

    // Calculate error rate
    const errorRate = (this.failureCount / this.requestCount) * 100;

    return errorRate >= this.errorThreshold;
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = new Date();

    // Emit state change event
    this.emitEvent('stateChange', {
      oldState,
      newState,
      stats: this.getStats(),
    });

    // Clear existing timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Handle state-specific logic
    switch (newState) {
      case 'OPEN':
        // Reset counters
        this.resetCounters();

        // Schedule transition to HALF_OPEN
        this.resetTimer = setTimeout(() => {
          this.transitionTo('HALF_OPEN');
        }, this.resetTimeout);

        this.onOpen?.();
        break;

      case 'HALF_OPEN':
        // Reset counters for testing
        this.resetCounters();
        this.onHalfOpen?.();
        break;

      case 'CLOSED':
        // Reset counters
        this.resetCounters();
        this.onClose?.();
        break;
    }

    this.onStateChange?.(newState);
  }

  /**
   * Reset counters
   */
  private resetCounters(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.requestCount = 0;
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get statistics
   */
  getStats(): CircuitBreakerStats {
    const totalRequests = this.requestCount;
    const errorRate = totalRequests > 0
      ? (this.failureCount / totalRequests) * 100
      : 0;

    return {
      state: this.state,
      totalRequests,
      successfulRequests: this.successCount,
      failedRequests: this.failureCount,
      rejectedRequests: this.rejectedCount,
      timeoutRequests: this.timeoutCount,
      currentConcurrent: this.currentConcurrent,
      lastStateChange: this.lastStateChange,
      errorRate,
    };
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    this.transitionTo('CLOSED');
  }

  /**
   * Manually open circuit breaker
   */
  open(): void {
    this.transitionTo('OPEN');
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}

/**
 * Create circuit breaker
 */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options);
}
