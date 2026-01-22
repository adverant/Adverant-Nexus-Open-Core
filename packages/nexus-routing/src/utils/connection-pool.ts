/**
 * Smart Connection Pool for HTTP Requests
 * Manages HTTP connections with keep-alive, pooling, and request queueing
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { logger } from './logger.js';

export interface ConnectionPoolConfig {
  maxSockets: number;
  maxFreeSockets: number;
  timeout: number;
  keepAlive: boolean;
  keepAliveMsecs: number;
}

export interface RequestQueueItem {
  config: AxiosRequestConfig;
  resolve: (value: AxiosResponse) => void;
  reject: (error: Error) => void;
  timestamp: number;
  timeout: number;
}

export interface ConnectionPoolStats {
  activeConnections: number;
  queuedRequests: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  timeouts: number;
}

/**
 * SmartConnectionPool class - Manages HTTP connections with pooling
 */
export class SmartConnectionPool {
  private client: AxiosInstance;
  private queue: RequestQueueItem[] = [];
  private activeRequests: number = 0;
  private stats: ConnectionPoolStats;
  private config: ConnectionPoolConfig;
  private baseURL: string;
  private latencies: number[] = [];
  private maxLatencies: number = 100; // Keep last 100 latencies

  constructor(baseURL: string, config?: Partial<ConnectionPoolConfig>) {
    this.baseURL = baseURL;
    this.config = {
      maxSockets: config?.maxSockets || 10,
      maxFreeSockets: config?.maxFreeSockets || 5,
      timeout: config?.timeout || 30000,
      keepAlive: config?.keepAlive !== false,
      keepAliveMsecs: config?.keepAliveMsecs || 60000
    };

    this.stats = {
      activeConnections: 0,
      queuedRequests: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      timeouts: 0
    };

    // Create HTTP/HTTPS agents with connection pooling
    const httpAgent = new HttpAgent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveMsecs,
      maxSockets: this.config.maxSockets,
      maxFreeSockets: this.config.maxFreeSockets
    });

    const httpsAgent = new HttpsAgent({
      keepAlive: this.config.keepAlive,
      keepAliveMsecs: this.config.keepAliveMsecs,
      maxSockets: this.config.maxSockets,
      maxFreeSockets: this.config.maxFreeSockets
    });

    // Build default headers including tenant context for multi-tenancy
    const defaultHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    // Inject tenant headers from environment variables
    const companyId = process.env.NEXUS_COMPANY_ID || process.env.X_COMPANY_ID;
    const appId = process.env.NEXUS_APP_ID || process.env.X_APP_ID;
    const userId = process.env.NEXUS_USER_ID || process.env.X_USER_ID;

    if (companyId) {
      defaultHeaders['X-Company-ID'] = companyId;
    }
    if (appId) {
      defaultHeaders['X-App-ID'] = appId;
    }
    if (userId) {
      defaultHeaders['X-User-ID'] = userId;
    }

    logger.debug('Connection pool tenant headers configured', {
      hasCompanyId: !!companyId,
      hasAppId: !!appId,
      hasUserId: !!userId
    });

    // Create axios instance with pooled agents and tenant headers
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: this.config.timeout,
      httpAgent,
      httpsAgent,
      headers: defaultHeaders,
      validateStatus: () => true // Handle all statuses manually
    });

    logger.debug('Connection pool created', {
      baseURL,
      maxSockets: this.config.maxSockets,
      keepAlive: this.config.keepAlive
    });
  }

  /**
   * Execute HTTP request with connection pooling and queueing
   */
  async request<T = any>(
    config: AxiosRequestConfig,
    timeout?: number
  ): Promise<AxiosResponse<T>> {
    this.stats.totalRequests++;
    this.stats.queuedRequests++;

    const requestTimeout = timeout || this.config.timeout;
    const startTime = Date.now();

    try {
      // Check if we're at capacity
      if (this.activeRequests >= this.config.maxSockets) {
        logger.debug('Request queued - at capacity', {
          active: this.activeRequests,
          max: this.config.maxSockets,
          queued: this.queue.length
        });

        // Add to queue and wait
        const response = await this.enqueue(config, requestTimeout);
        this.recordLatency(Date.now() - startTime);
        return response as AxiosResponse<T>;
      }

      // Execute immediately
      this.activeRequests++;
      this.stats.activeConnections = this.activeRequests;

      const response = await this.executeRequest<T>(config, requestTimeout);

      this.stats.successfulRequests++;
      this.recordLatency(Date.now() - startTime);

      return response;
    } catch (error) {
      this.stats.failedRequests++;

      if (error instanceof TimeoutError) {
        this.stats.timeouts++;
      }

      logger.debug('Request failed', {
        url: config.url,
        method: config.method,
        error: (error as Error).message
      });

      throw error;
    } finally {
      this.activeRequests--;
      this.stats.activeConnections = this.activeRequests;
      this.stats.queuedRequests--;

      // Process next queued request
      this.processQueue();
    }
  }

  /**
   * Execute HTTP request with timeout
   */
  private async executeRequest<T = any>(
    config: AxiosRequestConfig,
    timeout: number
  ): Promise<AxiosResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.client.request<T>({
        ...config,
        signal: controller.signal
      });

      if (response.status >= 400) {
        throw new HttpError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          response
        );
      }

      return response;
    } catch (error) {
      if (axios.isCancel(error) || (error as any).code === 'ECONNABORTED') {
        throw new TimeoutError(`Request timeout after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Add request to queue
   */
  private enqueue(config: AxiosRequestConfig, timeout: number): Promise<AxiosResponse> {
    return new Promise((resolve, reject) => {
      const item: RequestQueueItem = {
        config,
        resolve,
        reject,
        timestamp: Date.now(),
        timeout
      };

      this.queue.push(item);

      // Reject if timeout expires while in queue
      setTimeout(() => {
        const index = this.queue.indexOf(item);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new TimeoutError(`Request timeout in queue after ${timeout}ms`));
        }
      }, timeout);
    });
  }

  /**
   * Process next request in queue
   */
  private processQueue(): void {
    if (this.queue.length === 0 || this.activeRequests >= this.config.maxSockets) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    const remainingTimeout = item.timeout - (Date.now() - item.timestamp);

    if (remainingTimeout <= 0) {
      item.reject(new TimeoutError('Request timeout before processing'));
      return;
    }

    this.activeRequests++;
    this.stats.activeConnections = this.activeRequests;

    this.executeRequest(item.config, remainingTimeout)
      .then(response => {
        item.resolve(response);
        this.stats.successfulRequests++;
      })
      .catch(error => {
        item.reject(error);
        this.stats.failedRequests++;
      })
      .finally(() => {
        this.activeRequests--;
        this.stats.activeConnections = this.activeRequests;
        this.processQueue(); // Process next in queue
      });
  }

  /**
   * Record request latency
   */
  private recordLatency(latency: number): void {
    this.latencies.push(latency);

    // Keep only last N latencies
    if (this.latencies.length > this.maxLatencies) {
      this.latencies.shift();
    }

    // Update average
    this.stats.averageLatency =
      this.latencies.reduce((sum, l) => sum + l, 0) / this.latencies.length;
  }

  /**
   * GET request shorthand
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig, timeout?: number): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url }, timeout);
  }

  /**
   * POST request shorthand
   */
  async post<T = any>(url: string, data?: any, config?: AxiosRequestConfig, timeout?: number): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, data }, timeout);
  }

  /**
   * PUT request shorthand
   */
  async put<T = any>(url: string, data?: any, config?: AxiosRequestConfig, timeout?: number): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'PUT', url, data }, timeout);
  }

  /**
   * DELETE request shorthand
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig, timeout?: number): Promise<AxiosResponse<T>> {
    return this.request<T>({ ...config, method: 'DELETE', url }, timeout);
  }

  /**
   * Get connection pool statistics
   */
  getStats(): ConnectionPoolStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      activeConnections: this.activeRequests,
      queuedRequests: this.queue.length,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      timeouts: 0
    };
    this.latencies = [];
    logger.debug('Connection pool stats reset');
  }

  /**
   * Get base URL
   */
  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Update base URL (forces new connection pool)
   */
  setBaseURL(baseURL: string): void {
    if (baseURL !== this.baseURL) {
      logger.info('Connection pool base URL updated', {
        old: this.baseURL,
        new: baseURL
      });
      this.baseURL = baseURL;
      // Recreate client with new baseURL
      const currentConfig = this.client.defaults;
      this.client = axios.create({
        ...currentConfig,
        baseURL
      });
    }
  }
}

/**
 * Timeout Error
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * HTTP Error with status code
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: AxiosResponse
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
