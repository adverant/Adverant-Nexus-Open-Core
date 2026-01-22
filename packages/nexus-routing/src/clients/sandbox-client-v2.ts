/**
 * Sandbox Client V2 - Enhanced with Connection Pool, Circuit Breaker, Service Discovery
 * Production-ready wrapper around Unified Nexus Sandbox service HTTP API
 */

import { SmartConnectionPool, type ConnectionPoolStats } from '../utils/connection-pool.js';
import { circuitBreakerManager, type CircuitBreakerStats } from '../utils/circuit-breaker.js';
import { serviceDiscovery } from '../utils/service-discovery.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ServiceUnavailableError } from '../utils/error-handler.js';

export type ExecutionEngine = 'ignite' | 'docker';
export type ExecutionType = 'code' | 'llm' | 'image-gen' | 'web' | 'mobile' | 'custom';
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'completed' | 'failed' | 'error' | 'timeout';

export interface SandboxExecutionRequest {
  type: ExecutionType;
  template: string;
  config: {
    code?: string;
    command?: string;
    model?: string;
    timeout?: number;
    env?: Record<string, string>;
    ports?: number[];
    volumes?: string[];
    cpus?: number;
    memory?: string;
    gpus?: string | number;
  };
  metadata?: Record<string, any>;
}

export interface SandboxExecutionResult {
  id: string;
  status: ExecutionStatus;
  output: string;
  error?: string;
  metrics: {
    startTime?: number;
    endTime?: number;
    duration: number;
    cpuUsage?: number;
    memoryUsage?: number;
    gpuUsage?: number;
    fromPool?: boolean;
    engine?: ExecutionEngine;
  };
  artifacts?: Array<{
    type: string;
    path: string;
    size: number;
  }>;
}

export interface SandboxTemplate {
  name: string;
  type: ExecutionType;
  description: string;
  engine: ExecutionEngine;
  image: string;
  supports: string[];
}

export class SandboxClientV2 {
  private pool: SmartConnectionPool | null = null;
  private initialized = false;

  constructor() {
    // Lazy initialization
  }

  /**
   * Lazy initialization - discover endpoint and create connection pool
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      // Discover working endpoint
      const endpoint = await serviceDiscovery.discover({
        name: 'sandbox',
        candidates: config.sandbox.endpoints,
        healthPath: config.sandbox.healthPath,
        timeout: config.sandbox.healthTimeout
      });

      if (!endpoint.healthy) {
        logger.warn('Sandbox endpoint discovered but unhealthy', {
          url: endpoint.url
        });
      }

      // Create connection pool with discovered endpoint
      this.pool = new SmartConnectionPool(endpoint.url, config.connectionPool);
      this.initialized = true;

      logger.info('Sandbox client initialized', {
        endpoint: endpoint.url,
        latency: `${endpoint.latency}ms`
      });
    } catch (error) {
      logger.error('Failed to initialize Sandbox client', {
        error: (error as Error).message
      });
      throw new ServiceUnavailableError('sandbox', {
        message: 'Failed to discover Sandbox endpoint',
        candidates: config.sandbox.endpoints
      });
    }
  }

  /**
   * Execute request with circuit breaker protection
   */
  private async executeWithProtection<T>(
    toolName: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    const breaker = circuitBreakerManager.getBreaker(
      'sandbox',
      config.circuitBreaker
    );

    try {
      return await breaker.execute(fn);
    } catch (error) {
      logger.error(`Sandbox ${toolName} failed`, {
        error: (error as Error).message,
        breakerState: breaker.getStats().state
      });
      throw error;
    }
  }

  /**
   * Generic POST request with timeout
   */
  private async post(path: string, data: any, toolName: string): Promise<any> {
    if (!this.pool) {
      throw new Error('Sandbox client not initialized');
    }

    const response = await this.pool.post(path, data, {}, config.sandbox.timeout);

    // Response is AxiosResponse, extract data
    const result = response.data;

    if (result.success === false && result.error) {
      throw new Error(`Sandbox ${toolName} error: ${result.error}`);
    }

    return result;
  }

  /**
   * Generic GET request with timeout
   */
  private async get(path: string, toolName: string): Promise<any> {
    if (!this.pool) {
      throw new Error('Sandbox client not initialized');
    }

    const response = await this.pool.get(path, {}, config.sandbox.timeout);

    // Response is AxiosResponse, extract data
    const result = response.data;

    if (result.success === false && result.error) {
      throw new Error(`Sandbox ${toolName} error: ${result.error}`);
    }

    return result;
  }

  /**
   * Check health (without circuit breaker)
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      if (!this.pool) return false;

      const response = await this.pool.get('/health', {}, 5000);
      return response.data?.success === true;
    } catch (error) {
      logger.warn('Sandbox health check failed', {
        error: (error as Error).message
      });
      return false;
    }
  }

  /**
   * Execute code in sandbox environment
   */
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    return this.executeWithProtection('execute', async () => {
      const response = await this.post('/api/execute', request, 'execute');
      return response.result;
    });
  }

  /**
   * List all available templates
   */
  async listTemplates(): Promise<{
    templates: SandboxTemplate[];
    stats: {
      total: number;
      byType: Record<ExecutionType, number>;
      byEngine: Record<ExecutionEngine, number>;
    };
  }> {
    return this.executeWithProtection('listTemplates', async () => {
      const response = await this.get('/api/templates', 'listTemplates');
      return {
        templates: response.templates,
        stats: response.stats
      };
    });
  }

  /**
   * Get detailed information about a specific template
   */
  async getTemplate(name: string): Promise<SandboxTemplate> {
    return this.executeWithProtection('getTemplate', async () => {
      const response = await this.get(`/api/templates/${name}`, 'getTemplate');
      return response;
    });
  }

  /**
   * Get connection pool statistics
   */
  getConnectionStats(): ConnectionPoolStats | null {
    return this.pool?.getStats() || null;
  }

  /**
   * Get circuit breaker statistics
   */
  getCircuitBreakerStats(): CircuitBreakerStats {
    return circuitBreakerManager.getBreaker('sandbox', config.circuitBreaker).getStats();
  }
}

// Singleton instance
export const sandboxClientV2 = new SandboxClientV2();
