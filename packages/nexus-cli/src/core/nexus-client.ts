/**
 * Nexus API Client
 *
 * Client for interacting with Nexus API Gateway (port 9092)
 * Handles health checks, operation queuing, and graceful degradation
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { EventEmitter } from 'eventemitter3';
import type { RetryConfig, TransportError } from '../types/transport.js';

export interface NexusClientConfig {
  baseUrl?: string;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
  healthCheckInterval?: number;
}

export interface NexusHealth {
  graphrag: {
    healthy: boolean;
    latency?: number;
    collections?: string[];
  };
  mageagent: {
    healthy: boolean;
    latency?: number;
    activeAgents?: number;
  };
  learningagent: {
    healthy: boolean;
    queuedLearning?: number;
  };
}

export interface QueuedOperation {
  id: string;
  operation: string;
  params: any;
  timestamp: Date;
  retries: number;
}

export class NexusClient extends EventEmitter {
  private client: AxiosInstance;
  private config: Required<NexusClientConfig>;
  private healthCheckTimer?: NodeJS.Timeout;
  private isHealthy: boolean = false;
  private operationQueue: QueuedOperation[] = [];
  private retryConfig: RetryConfig = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    factor: 2,
    retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'],
  };

  constructor(config: NexusClientConfig = {}) {
    super();

    this.config = {
      baseUrl: config.baseUrl || 'http://localhost:9092',
      timeout: config.timeout || 30000,
      retries: config.retries || 3,
      headers: config.headers || {},
      healthCheckInterval: config.healthCheckInterval || 30000,
    };

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
    });

    this.setupInterceptors();
  }

  /**
   * Setup axios interceptors for retry and error handling
   */
  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        this.emit('request', { url: config.url, method: config.method });
        return config;
      },
      (error) => Promise.reject(this.createTransportError(error))
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        this.emit('response', { url: response.config.url, status: response.status });
        return response;
      },
      async (error: AxiosError) => {
        const transportError = this.createTransportError(error);

        // Retry logic for retryable errors
        if (this.isRetryable(transportError)) {
          const config = error.config;
          if (config && !(config as any).__retryCount) {
            (config as any).__retryCount = 0;
          }

          if (config && (config as any).__retryCount < this.config.retries) {
            (config as any).__retryCount += 1;
            const delay = this.calculateBackoff((config as any).__retryCount);

            this.emit('retry', {
              attempt: (config as any).__retryCount,
              delay,
              error: transportError,
            });

            await this.sleep(delay);
            return this.client.request(config);
          }
        }

        return Promise.reject(transportError);
      }
    );
  }

  /**
   * Create a standardized transport error
   */
  private createTransportError(error: any): TransportError {
    const transportError = new Error(error.message) as TransportError;
    transportError.code = error.code || 'UNKNOWN_ERROR';
    transportError.statusCode = error.response?.status;
    transportError.details = error.response?.data;
    transportError.retryable = this.isRetryable(error);

    return transportError;
  }

  /**
   * Check if an error is retryable
   */
  private isRetryable(error: any): boolean {
    if (error.code && this.retryConfig.retryableErrors?.includes(error.code)) {
      return true;
    }

    if (error.statusCode && [408, 429, 500, 502, 503, 504].includes(error.statusCode)) {
      return true;
    }

    return false;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoff(attempt: number): number {
    const delay = Math.min(
      this.retryConfig.initialDelay * Math.pow(this.retryConfig.factor, attempt - 1),
      this.retryConfig.maxDelay
    );
    return delay;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start automatic health checks
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) {
      return;
    }

    // Initial health check
    this.checkHealth().catch(() => {});

    // Periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, this.config.healthCheckInterval);

    this.emit('health-check:started');
  }

  /**
   * Stop automatic health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      this.emit('health-check:stopped');
    }
  }

  /**
   * Check Nexus system health
   */
  async checkHealth(detailed: boolean = false): Promise<NexusHealth> {
    try {
      const response = await this.client.get('/health', {
        params: { detailed },
      });

      const health: NexusHealth = response.data;
      const wasHealthy = this.isHealthy;
      this.isHealthy = health.graphrag.healthy;

      // Emit health change events
      if (wasHealthy !== this.isHealthy) {
        if (this.isHealthy) {
          this.emit('health:recovered');
          await this.processQueue();
        } else {
          this.emit('health:degraded');
        }
      }

      return health;
    } catch (error) {
      const wasHealthy = this.isHealthy;
      this.isHealthy = false;

      if (wasHealthy) {
        this.emit('health:degraded');
      }

      throw error;
    }
  }

  /**
   * Get current health status
   */
  getHealthStatus(): { healthy: boolean } {
    return { healthy: this.isHealthy };
  }

  /**
   * Execute a Nexus API operation
   */
  async execute<T = any>(
    endpoint: string,
    method: 'get' | 'post' | 'put' | 'delete' = 'post',
    data?: any,
    options?: { params?: any; queueOnFailure?: boolean }
  ): Promise<T> {
    try {
      let response;

      switch (method) {
        case 'get':
          response = await this.client.get(endpoint, {
            params: options?.params,
          });
          break;
        case 'post':
          response = await this.client.post(endpoint, data, {
            params: options?.params,
          });
          break;
        case 'put':
          response = await this.client.put(endpoint, data, {
            params: options?.params,
          });
          break;
        case 'delete':
          response = await this.client.delete(endpoint, {
            params: options?.params,
          });
          break;
      }

      return response.data;
    } catch (error) {
      // Queue operation if requested and health check fails
      if (options?.queueOnFailure && !this.isHealthy) {
        this.queueOperation(endpoint, method, data, options?.params);
        throw new Error('Nexus unavailable - operation queued for retry');
      }

      throw error;
    }
  }

  /**
   * Queue an operation for later execution
   */
  private queueOperation(
    endpoint: string,
    method: string,
    data?: any,
    params?: any
  ): void {
    const operation: QueuedOperation = {
      id: `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      operation: `${method.toUpperCase()} ${endpoint}`,
      params: { endpoint, method, data, params },
      timestamp: new Date(),
      retries: 0,
    };

    this.operationQueue.push(operation);
    this.emit('operation:queued', operation);
  }

  /**
   * Process queued operations
   */
  private async processQueue(): Promise<void> {
    if (this.operationQueue.length === 0) {
      return;
    }

    this.emit('queue:processing', { count: this.operationQueue.length });

    const operations = [...this.operationQueue];
    this.operationQueue = [];

    for (const op of operations) {
      try {
        await this.execute(
          op.params.endpoint,
          op.params.method,
          op.params.data,
          { params: op.params.params, queueOnFailure: false }
        );

        this.emit('operation:completed', op);
      } catch (error) {
        op.retries += 1;

        // Re-queue if under max retries
        if (op.retries < this.retryConfig.maxAttempts) {
          this.operationQueue.push(op);
          this.emit('operation:requeued', op);
        } else {
          this.emit('operation:failed', { operation: op, error });
        }
      }
    }

    this.emit('queue:processed', {
      completed: operations.length - this.operationQueue.length,
      remaining: this.operationQueue.length,
    });
  }

  /**
   * Get queue status
   */
  getQueueStatus(): { count: number; operations: QueuedOperation[] } {
    return {
      count: this.operationQueue.length,
      operations: [...this.operationQueue],
    };
  }

  /**
   * Clear the operation queue
   */
  clearQueue(): void {
    const count = this.operationQueue.length;
    this.operationQueue = [];
    this.emit('queue:cleared', { count });
  }

  /**
   * Close the client and cleanup
   */
  close(): void {
    this.stopHealthChecks();
    this.removeAllListeners();
  }
}

/**
 * Create a default Nexus client instance
 */
export function createNexusClient(config?: NexusClientConfig): NexusClient {
  return new NexusClient(config);
}
