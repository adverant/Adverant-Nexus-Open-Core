import CircuitBreaker from 'opossum';
import { logger } from './logger';

export interface CircuitBreakerOptions {
  timeout?: number;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  volumeThreshold?: number;
  name?: string;
}

export class ServiceCircuitBreaker {
  private breaker: CircuitBreaker;
  private name: string;

  constructor(
    asyncFunction: (...args: any[]) => Promise<any>,
    options: CircuitBreakerOptions = {}
  ) {
    this.name = options.name || 'Service';

    const defaultOptions = {
      timeout: 30000, // 30 seconds
      errorThresholdPercentage: 50, // Open circuit at 50% error rate
      resetTimeout: 30000, // Try again after 30 seconds
      volumeThreshold: 10, // Minimum 10 requests before calculating error percentage
      ...options
    };

    this.breaker = new CircuitBreaker(asyncFunction, defaultOptions);

    // Setup event handlers
    this.setupEventHandlers();

    // Add fallback
    this.breaker.fallback(this.handleFallback.bind(this));
  }

  private setupEventHandlers(): void {
    this.breaker.on('open', () => {
      logger.error(`${this.name} circuit breaker opened`, {
        stats: this.breaker.stats
      });
    });

    this.breaker.on('halfOpen', () => {
      logger.warn(`${this.name} circuit breaker half-open, testing...`);
    });

    this.breaker.on('close', () => {
      logger.info(`${this.name} circuit breaker closed`);
    });

    this.breaker.on('timeout', (duration) => {
      logger.warn(`${this.name} request timeout`, { duration });
    });

    this.breaker.on('reject', () => {
      logger.warn(`${this.name} request rejected (circuit open)`);
    });

    this.breaker.on('failure', (error) => {
      logger.error(`${this.name} request failed`, {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    });

    this.breaker.on('success', (_result, latency) => {
      logger.debug(`${this.name} request successful`, { latency });
    });
  }

  private handleFallback(error: Error, args: any[]): any {
    logger.warn(`${this.name} fallback triggered`, {
      error: error.message,
      args: args.length
    });

    // Return service-specific fallback response
    if (this.name.includes('GraphRAG')) {
      return {
        memories: [],
        success: false,
        fallback: true,
        error: 'Service temporarily unavailable'
      };
    }

    if (this.name.includes('OpenRouter')) {
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: 'I apologize, but I am temporarily unable to process your request. Please try again in a moment.'
          }
        }],
        fallback: true
      };
    }

    // Generic fallback
    return {
      success: false,
      fallback: true,
      error: 'Service temporarily unavailable'
    };
  }

  async fire(...args: any[]): Promise<any> {
    return this.breaker.fire(...args);
  }

  getStats(): any {
    return this.breaker.stats;
  }

  getState(): string {
    return this.breaker.opened ? 'open' :
           this.breaker.halfOpen ? 'half-open' : 'closed';
  }

  isOpen(): boolean {
    return this.breaker.opened;
  }

  close(): void {
    this.breaker.close();
  }

  open(): void {
    this.breaker.open();
  }

  disable(): void {
    this.breaker.disable();
  }

  enable(): void {
    this.breaker.enable();
  }
}

// Factory function to create circuit breakers for different services
export function createCircuitBreaker(
  serviceName: string,
  asyncFunction: (...args: any[]) => Promise<any>,
  customOptions: CircuitBreakerOptions = {}
): ServiceCircuitBreaker {
  const options: CircuitBreakerOptions = {
    name: serviceName,
    ...customOptions
  };

  // Service-specific configurations
  switch (serviceName) {
    case 'OpenRouter':
      options.timeout = options.timeout || 60000; // 60s for AI completions
      options.errorThresholdPercentage = options.errorThresholdPercentage || 30;
      break;

    case 'GraphRAG':
      options.timeout = options.timeout || 30000; // 30s for memory operations
      options.errorThresholdPercentage = options.errorThresholdPercentage || 40;
      break;

    case 'MemAgent':
      options.timeout = options.timeout || 30000;
      options.errorThresholdPercentage = options.errorThresholdPercentage || 40;
      break;

    case 'Database':
      options.timeout = options.timeout || 10000; // 10s for DB operations
      options.errorThresholdPercentage = options.errorThresholdPercentage || 20;
      options.volumeThreshold = options.volumeThreshold || 5;
      break;

    default:
      // Use default options
      break;
  }

  return new ServiceCircuitBreaker(asyncFunction, options);
}