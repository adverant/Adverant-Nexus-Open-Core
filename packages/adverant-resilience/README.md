# @adverant/resilience

**Resilience patterns for Nexus stack services** - Circuit breakers, retry logic, timeouts, and bulkheads to prevent cascading failures and improve system reliability.

## Features

- **Circuit Breaker**: Fail fast when services are down, prevent cascading failures
- **Retry Logic**: Automatic retry with exponential backoff and jitter
- **Timeout**: Enforce operation time limits
- **Bulkhead**: Limit concurrent executions to prevent resource exhaustion
- **Combined Patterns**: Easily combine multiple resilience patterns
- **TypeScript**: Full type safety with comprehensive type definitions
- **Observable**: Rich callbacks and state management for monitoring
- **Production-Ready**: Battle-tested patterns with defensive programming

## Installation

```bash
npm install @adverant/resilience
```

## Quick Start

### Circuit Breaker

Prevent cascading failures by failing fast when a service is experiencing errors:

```typescript
import { createCircuitBreaker } from '@adverant/resilience';

const breaker = createCircuitBreaker({
  name: 'user-service',
  timeout: 5000,
  errorThreshold: 50, // Open circuit at 50% error rate
  volumeThreshold: 10, // Minimum 10 requests before evaluating
  resetTimeout: 30000, // Try to close after 30 seconds
});

// Execute operation with circuit breaker protection
try {
  const user = await breaker.execute(() => fetchUser(userId));
  console.log('User fetched:', user);
} catch (error) {
  if (error.message.includes('Circuit breaker')) {
    console.log('Service is down - circuit breaker is OPEN');
  }
}

// Monitor state
console.log('Circuit state:', breaker.getState()); // CLOSED, OPEN, or HALF_OPEN
console.log('Statistics:', breaker.getStats());
```

### Retry Logic

Automatically retry failed operations with exponential backoff:

```typescript
import { createRetry } from '@adverant/resilience';

const retryHelper = createRetry({
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffStrategy: 'exponential',
  jitter: true, // Prevent thundering herd
  onRetry: (error, attempt, delay) => {
    console.log(`Retry attempt ${attempt} after ${delay}ms`);
  },
});

const result = await retryHelper.execute(async () => {
  return await fetchDataFromAPI();
});

console.log(`Success after ${result.attempts} attempts`);
console.log(`Total delay: ${result.totalDelay}ms`);
```

### Timeout

Enforce operation time limits:

```typescript
import { withTimeout, TimeoutError } from '@adverant/resilience';

try {
  const data = await withTimeout(
    () => slowDatabaseQuery(),
    {
      timeout: 5000,
      onTimeout: () => console.log('Query timed out'),
    }
  );
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log(`Operation timed out after ${error.timeoutMs}ms`);
  }
}
```

### Bulkhead

Limit concurrent executions to prevent resource exhaustion:

```typescript
import { createBulkhead } from '@adverant/resilience';

const bulkhead = createBulkhead({
  maxConcurrent: 10, // Maximum 10 concurrent operations
  maxQueue: 20, // Queue up to 20 additional requests
  queueTimeout: 5000, // Reject queued requests after 5 seconds
  onCapacity: () => console.log('Bulkhead at capacity'),
});

try {
  const result = await bulkhead.execute(() => processRequest());
  console.log('Request processed:', result);
} catch (error) {
  if (error.name === 'BulkheadError') {
    console.log('Too many concurrent requests');
  }
}

// Monitor utilization
const stats = bulkhead.getStats();
console.log(`Utilization: ${stats.utilization}%`);
console.log(`Queue length: ${stats.queueLength}`);
```

### Combined Resilient Executor

Combine circuit breaker and retry for maximum resilience:

```typescript
import { createResilientExecutor } from '@adverant/resilience';

const resilientExecutor = createResilientExecutor({
  name: 'payment-service',
  circuitBreaker: {
    timeout: 5000,
    errorThreshold: 50,
    volumeThreshold: 10,
    resetTimeout: 30000,
  },
  retry: {
    maxRetries: 3,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
  },
});

// Execute with both circuit breaker and retry protection
const paymentResult = await resilientExecutor(async () => {
  return await processPayment(orderId);
});
```

## Circuit Breaker Pattern

### States

The circuit breaker operates in three states:

1. **CLOSED**: Normal operation, requests pass through
2. **OPEN**: Service is failing, requests fail fast without calling service
3. **HALF_OPEN**: Testing if service has recovered

### Configuration Options

```typescript
interface CircuitBreakerOptions {
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

  /** Callback when circuit state changes */
  onStateChange?: (state: CircuitState) => void;

  /** Callback when circuit opens */
  onOpen?: () => void;

  /** Callback when circuit closes */
  onClose?: () => void;

  /** Callback when circuit half-opens */
  onHalfOpen?: () => void;
}
```

### Advanced Usage

```typescript
const breaker = createCircuitBreaker({
  name: 'database',
  timeout: 3000,
  errorThreshold: 40,
  volumeThreshold: 20,
  maxConcurrent: 50,
  onStateChange: (state) => {
    console.log(`Circuit breaker state changed to ${state}`);
    // Send metrics to monitoring system
    metrics.gauge('circuit_breaker_state', stateToNumber(state));
  },
  onOpen: () => {
    // Alert on-call engineer
    alerting.send('Database circuit breaker opened');
  },
});

// Get detailed statistics
const stats = breaker.getStats();
console.log({
  state: stats.state,
  errorRate: stats.errorRate.toFixed(2) + '%',
  totalRequests: stats.totalRequests,
  successfulRequests: stats.successfulRequests,
  failedRequests: stats.failedRequests,
  rejectedRequests: stats.rejectedRequests,
  timeoutRequests: stats.timeoutRequests,
  currentConcurrent: stats.currentConcurrent,
});

// Manually control circuit
breaker.reset(); // Force close
breaker.open(); // Force open

// Cleanup when shutting down
breaker.destroy();
```

## Retry Pattern

### Backoff Strategies

1. **Exponential**: Delay = initialDelay × (multiplier ^ attempt)
2. **Linear**: Delay = initialDelay × attempt
3. **Constant**: Delay = initialDelay

### Configuration Options

```typescript
interface RetryOptions {
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
```

### Advanced Usage

```typescript
const retryHelper = createRetry({
  maxRetries: 5,
  initialDelay: 500,
  maxDelay: 10000,
  backoffMultiplier: 2,
  backoffStrategy: 'exponential',
  jitter: true,
  shouldRetry: (error, attempt) => {
    // Don't retry client errors (4xx)
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return false;
    }
    // Don't retry after 3 attempts for specific errors
    if (error.code === 'RATE_LIMITED' && attempt >= 3) {
      return false;
    }
    // Retry server errors and network issues
    return true;
  },
  onRetry: (error, attempt, delay) => {
    console.log(`Retry ${attempt}: ${error.message} (waiting ${delay}ms)`);
    metrics.increment('retry_attempts', { error: error.code });
  },
});

// Use the retry helper
const result = await retryHelper.execute(async () => {
  const response = await fetch('https://api.example.com/data');
  if (!response.ok) {
    const error: any = new Error(`HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  return response.json();
});

console.log(`Operation succeeded after ${result.attempts} attempts`);
console.log(`Total time spent waiting: ${result.totalDelay}ms`);
```

### Standalone Retry Function

```typescript
import { retry } from '@adverant/resilience';

// Quick retry with default options
const result = await retry(() => fetchData());

// With custom options
const result = await retry(
  () => fetchData(),
  { maxRetries: 5, initialDelay: 2000 }
);
```

## Timeout Pattern

### Configuration Options

```typescript
interface TimeoutOptions {
  /** Timeout in milliseconds */
  timeout: number;

  /** Custom timeout error */
  timeoutError?: Error;

  /** Callback when timeout occurs */
  onTimeout?: () => void;
}
```

### Advanced Usage

```typescript
// Custom timeout error
const customError = new Error('Database query took too long');

try {
  const result = await withTimeout(
    () => database.query('SELECT * FROM large_table'),
    {
      timeout: 10000,
      timeoutError: customError,
      onTimeout: () => {
        console.log('Cancelling database query...');
        database.cancel();
      },
    }
  );
} catch (error) {
  if (error === customError) {
    console.log('Query timed out');
  }
}

// Create reusable timeout wrapper
const timeoutWrapper = createTimeout(5000);

// Use wrapper with default timeout
const result1 = await timeoutWrapper(() => operation1());

// Override timeout for specific operation
const result2 = await timeoutWrapper(() => operation2(), 10000);
```

## Bulkhead Pattern

### Configuration Options

```typescript
interface BulkheadOptions {
  /** Maximum concurrent executions */
  maxConcurrent: number;

  /** Maximum queue size (default: 0 - no queue) */
  maxQueue?: number;

  /** Timeout for queued requests in milliseconds */
  queueTimeout?: number;

  /** Callback when at capacity */
  onCapacity?: () => void;
}
```

### Advanced Usage

```typescript
const bulkhead = createBulkhead({
  maxConcurrent: 20,
  maxQueue: 50,
  queueTimeout: 10000,
  onCapacity: () => {
    console.log('Bulkhead at capacity - rejecting requests');
    metrics.increment('bulkhead_capacity_reached');
  },
});

// Execute with bulkhead protection
try {
  const result = await bulkhead.execute(async () => {
    return await expensiveOperation();
  });
} catch (error) {
  if (error.name === 'BulkheadError') {
    if (error.message.includes('timed out')) {
      console.log('Request queued too long');
    } else {
      console.log('Too many concurrent requests');
    }
  }
}

// Monitor bulkhead statistics
const stats = bulkhead.getStats();
console.log({
  currentConcurrent: stats.currentConcurrent,
  queueLength: stats.queueLength,
  maxConcurrent: stats.maxConcurrent,
  maxQueue: stats.maxQueue,
  utilization: `${stats.utilization.toFixed(1)}%`,
});

// Clear queue if needed (rejects all queued requests)
bulkhead.clearQueue();
```

## Best Practices

### 1. Circuit Breaker Configuration

```typescript
// Set volumeThreshold high enough to avoid false positives
const breaker = createCircuitBreaker({
  name: 'api-service',
  volumeThreshold: 20, // At least 20 requests before evaluating
  errorThreshold: 50, // Open at 50% error rate
  resetTimeout: 30000, // Wait 30s before trying again
});
```

### 2. Combine Patterns for Maximum Resilience

```typescript
// Bulkhead to limit concurrent requests
const bulkhead = createBulkhead({ maxConcurrent: 10 });

// Circuit breaker to fail fast when service is down
const breaker = createCircuitBreaker({
  name: 'service',
  errorThreshold: 50,
});

// Retry for transient failures
const retryHelper = createRetry({
  maxRetries: 3,
  backoffStrategy: 'exponential',
});

// Execute with all protections
async function resilientCall() {
  return bulkhead.execute(() =>
    breaker.execute(() =>
      retryHelper.execute(() => callExternalAPI())
    )
  );
}
```

### 3. Monitor and Alert

```typescript
const breaker = createCircuitBreaker({
  name: 'critical-service',
  onStateChange: (state) => {
    metrics.gauge('circuit_state', stateToNumber(state));
  },
  onOpen: () => {
    alerting.critical('Circuit breaker opened for critical-service');
  },
  onClose: () => {
    alerting.info('Circuit breaker closed for critical-service');
  },
});

// Periodic stats reporting
setInterval(() => {
  const stats = breaker.getStats();
  metrics.gauge('circuit_error_rate', stats.errorRate);
  metrics.gauge('circuit_concurrent', stats.currentConcurrent);
}, 10000);
```

### 4. Custom Retry Logic

```typescript
const retryHelper = createRetry({
  shouldRetry: (error, attempt) => {
    // Don't retry authentication errors
    if (error.statusCode === 401 || error.statusCode === 403) {
      return false;
    }

    // Retry rate limits with longer delays
    if (error.statusCode === 429) {
      return attempt <= 5;
    }

    // Retry network errors
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(error.code);
  },
  onRetry: (error, attempt, delay) => {
    logger.warn('Retrying operation', { error, attempt, delay });
  },
});
```

### 5. Graceful Degradation

```typescript
async function getUserData(userId: string) {
  try {
    // Try primary service with resilience patterns
    return await resilientExecutor(() => primaryService.getUser(userId));
  } catch (error) {
    if (error.message.includes('Circuit breaker')) {
      // Primary service is down, try fallback
      logger.warn('Primary service down, using cache');
      return await cache.get(`user:${userId}`);
    }
    throw error;
  }
}
```

## Migration Guide

### From Existing Circuit Breaker

```typescript
// Before: Manual circuit breaker logic
let failureCount = 0;
let isOpen = false;

async function callService() {
  if (isOpen) {
    throw new Error('Service unavailable');
  }

  try {
    const result = await service.call();
    failureCount = 0;
    return result;
  } catch (error) {
    failureCount++;
    if (failureCount > 5) {
      isOpen = true;
      setTimeout(() => { isOpen = false; }, 30000);
    }
    throw error;
  }
}

// After: @adverant/resilience
const breaker = createCircuitBreaker({
  name: 'service',
  volumeThreshold: 5,
  errorThreshold: 50,
  resetTimeout: 30000,
});

async function callService() {
  return breaker.execute(() => service.call());
}
```

### From Manual Retry Logic

```typescript
// Before: Manual retry with setTimeout
async function fetchWithRetry(url: string, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
}

// After: @adverant/resilience
const retryHelper = createRetry({
  maxRetries: 3,
  initialDelay: 1000,
  backoffStrategy: 'exponential',
});

async function fetchWithRetry(url: string) {
  const result = await retryHelper.execute(() => fetch(url));
  return result.result;
}
```

## API Reference

### Circuit Breaker

- `createCircuitBreaker(options)`: Create circuit breaker instance
- `breaker.execute<T>(fn)`: Execute function with protection
- `breaker.getState()`: Get current state (CLOSED/OPEN/HALF_OPEN)
- `breaker.getStats()`: Get statistics
- `breaker.reset()`: Manually close circuit
- `breaker.open()`: Manually open circuit
- `breaker.destroy()`: Cleanup resources

### Retry

- `createRetry(options)`: Create retry helper instance
- `retry.execute<T>(fn)`: Execute function with retry logic
- `retry<T>(fn, options)`: Standalone retry function

### Timeout

- `withTimeout<T>(fn, options)`: Execute function with timeout
- `createTimeout(defaultTimeout)`: Create timeout wrapper
- `TimeoutError`: Timeout error class

### Bulkhead

- `createBulkhead(options)`: Create bulkhead instance
- `bulkhead.execute<T>(fn)`: Execute function with concurrency limit
- `bulkhead.getStats()`: Get statistics
- `bulkhead.clearQueue()`: Clear queued requests
- `BulkheadError`: Bulkhead error class

### Combined

- `createResilientExecutor(options)`: Create combined executor with circuit breaker and retry

## Performance Considerations

- **Circuit Breaker**: Minimal overhead (~1-2ms per request)
- **Retry**: Adds delay based on backoff strategy
- **Timeout**: Uses Promise.race, minimal overhead
- **Bulkhead**: Minimal overhead for queue management

## License

MIT

## Contributing

See the main Nexus repository for contribution guidelines.
