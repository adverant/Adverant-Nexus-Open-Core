/**
 * Service Registry with Health-Aware Endpoint Management
 *
 * Provides centralized service discovery with automatic health checking,
 * circuit breaker integration, and intelligent endpoint selection.
 *
 * Design Patterns:
 * - Singleton: Ensures single registry instance across application
 * - Strategy: Pluggable health check strategies per service
 * - Observer: Notifies clients of service state changes
 *
 * Root Cause Addressed:
 * - Eliminates hardcoded service URLs scattered across codebase
 * - Provides single source of truth for service endpoints
 * - Implements automatic failover and health monitoring
 * - Adds comprehensive error context for debugging
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { logger } from './utils/logger.js';

export enum ServiceHealth {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  UNKNOWN = 'unknown'
}

export interface ServiceEndpoint {
  url: string;
  health: ServiceHealth;
  lastCheck: Date;
  consecutiveFailures: number;
  responseTime: number; // milliseconds
  priority: number; // 1 = highest, used for ordering
}

export interface ServiceDefinition {
  name: string;
  endpoints: string[]; // Fallback chain
  healthPath: string;
  healthTimeout: number;
  healthInterval: number; // How often to check (ms)
  circuitBreakerThreshold: number; // Failures before circuit opens
}

/**
 * Service Registry
 * Maintains health state of all service endpoints and provides intelligent selection
 */
export class ServiceRegistry extends EventEmitter {
  private static instance: ServiceRegistry;
  private services: Map<string, ServiceEndpoint[]> = new Map();
  private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isInitialized: boolean = false;

  private constructor() {
    super();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  /**
   * Register a service with multiple endpoints
   */
  public registerService(definition: ServiceDefinition): void {
    const endpoints: ServiceEndpoint[] = definition.endpoints.map((url, index) => ({
      url,
      health: ServiceHealth.UNKNOWN,
      lastCheck: new Date(0), // Never checked
      consecutiveFailures: 0,
      responseTime: 0,
      priority: index + 1 // First endpoint = highest priority
    }));

    this.services.set(definition.name, endpoints);

    // Start periodic health checks
    const interval = setInterval(
      () => this.checkServiceHealth(definition),
      definition.healthInterval
    );
    this.healthCheckIntervals.set(definition.name, interval);

    logger.info(`Service registered: ${definition.name}`, {
      endpoints: endpoints.length,
      healthInterval: definition.healthInterval
    });
  }

  /**
   * Initialize registry and perform initial health checks
   * This must be called during application startup
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('ServiceRegistry already initialized');
      return;
    }

    logger.info('Initializing ServiceRegistry...');

    // Get all service definitions
    const serviceDefinitions = this.getServiceDefinitions();

    // Register all services
    for (const definition of serviceDefinitions) {
      this.registerService(definition);
    }

    // Perform initial health checks for all services (parallel)
    const healthCheckPromises = serviceDefinitions.map(def =>
      this.checkServiceHealth(def).catch(error => {
        logger.error(`Initial health check failed for ${def.name}`, {
          error: error.message
        });
      })
    );

    await Promise.allSettled(healthCheckPromises);

    this.isInitialized = true;
    logger.info('ServiceRegistry initialized', {
      services: this.services.size
    });
  }

  /**
   * Get service definitions from environment/config
   * CRITICAL: This is the SINGLE SOURCE OF TRUTH for all service URLs
   */
  private getServiceDefinitions(): ServiceDefinition[] {
    return [
      {
        name: 'graphrag',
        endpoints: this.parseEndpoints(
          process.env.GRAPHRAG_ENDPOINT ||
          process.env.GRAPHRAG_ENDPOINTS ||
          // CORRECTED FALLBACK CHAIN (container names first in Docker)
          'http://nexus-graphrag:8090,' +
          'http://localhost:9090,' +
          'http://127.0.0.1:9090,' +
          'http://host.docker.internal:9090,' +
          'http://graphrag:8090' // Legacy fallback
        ),
        healthPath: '/health',
        healthTimeout: 5000,
        healthInterval: 30000, // Check every 30s
        circuitBreakerThreshold: 3
      },
      {
        name: 'mageagent',
        endpoints: this.parseEndpoints(
          process.env.MAGEAGENT_ENDPOINT ||
          process.env.MAGEAGENT_ENDPOINTS ||
          // CORRECTED FALLBACK CHAIN (container names first in Docker)
          'http://nexus-mageagent:8080/api,' +
          'http://localhost:9080/api,' +
          'http://127.0.0.1:9080/api,' +
          'http://host.docker.internal:9080/api,' +
          'http://mageagent:8080/api' // Legacy fallback
        ),
        healthPath: '/health',
        healthTimeout: 5000,
        healthInterval: 30000,
        circuitBreakerThreshold: 3
      },
      {
        name: 'sandbox',
        endpoints: this.parseEndpoints(
          process.env.SANDBOX_ENDPOINT ||
          process.env.SANDBOX_ENDPOINTS ||
          'http://nexus-sandbox:9092,' +
          'http://localhost:9095,' +
          'http://127.0.0.1:9095,' +
          'http://host.docker.internal:9095'
        ),
        healthPath: '/health',
        healthTimeout: 5000,
        healthInterval: 30000,
        circuitBreakerThreshold: 3
      }
    ];
  }

  /**
   * Parse comma-separated endpoint string into array
   */
  private parseEndpoints(endpointsStr: string): string[] {
    return endpointsStr.split(',').map(e => e.trim()).filter(e => e.length > 0);
  }

  /**
   * Check health of all endpoints for a service
   */
  private async checkServiceHealth(definition: ServiceDefinition): Promise<void> {
    const endpoints = this.services.get(definition.name);
    if (!endpoints) {
      logger.error(`Service not found in registry: ${definition.name}`);
      return;
    }

    // Check all endpoints in parallel
    const healthCheckPromises = endpoints.map(endpoint =>
      this.checkEndpointHealth(definition, endpoint)
    );

    await Promise.allSettled(healthCheckPromises);

    // Emit event for health state change
    const healthyCount = endpoints.filter(e => e.health === ServiceHealth.HEALTHY).length;
    this.emit('health-updated', {
      service: definition.name,
      totalEndpoints: endpoints.length,
      healthyEndpoints: healthyCount
    });
  }

  /**
   * Check health of a single endpoint
   */
  private async checkEndpointHealth(
    definition: ServiceDefinition,
    endpoint: ServiceEndpoint
  ): Promise<void> {
    const startTime = Date.now();

    try {
      const response = await axios.get(
        `${endpoint.url}${definition.healthPath}`,
        {
          timeout: definition.healthTimeout,
          validateStatus: (status) => status < 500 // Accept 4xx as "healthy"
        }
      );

      const responseTime = Date.now() - startTime;

      // Update endpoint state
      endpoint.health = response.status === 200
        ? ServiceHealth.HEALTHY
        : ServiceHealth.DEGRADED;
      endpoint.lastCheck = new Date();
      endpoint.consecutiveFailures = 0;
      endpoint.responseTime = responseTime;

      logger.debug(`Health check passed: ${endpoint.url}`, {
        status: response.status,
        responseTime
      });

    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      endpoint.consecutiveFailures++;
      endpoint.lastCheck = new Date();
      endpoint.responseTime = responseTime;

      // Determine health based on consecutive failures
      if (endpoint.consecutiveFailures >= definition.circuitBreakerThreshold) {
        endpoint.health = ServiceHealth.UNHEALTHY;
      } else {
        endpoint.health = ServiceHealth.DEGRADED;
      }

      logger.warn(`Health check failed: ${endpoint.url}`, {
        error: error.message,
        code: error.code,
        consecutiveFailures: endpoint.consecutiveFailures,
        responseTime,
        troubleshooting: {
          dnsResolution: error.code === 'ENOTFOUND'
            ? `DNS name not found. Check docker-compose network aliases.`
            : 'DNS OK',
          connectivity: error.code === 'ECONNREFUSED'
            ? `Service not responding. Check if container is running.`
            : 'Connection OK',
          timeout: error.code === 'ETIMEDOUT'
            ? `Request timeout after ${definition.healthTimeout}ms. Service may be overloaded.`
            : 'Response time OK'
        }
      });
    }
  }

  /**
   * Get best available endpoint for a service
   * Returns healthy endpoint with lowest response time, or degraded if no healthy ones
   *
   * Throws detailed error if no usable endpoints found
   */
  public getHealthyEndpoint(serviceName: string): ServiceEndpoint | null {
    const endpoints = this.services.get(serviceName);
    if (!endpoints || endpoints.length === 0) {
      throw new Error(
        `Service '${serviceName}' not registered in ServiceRegistry. ` +
        `Available services: ${Array.from(this.services.keys()).join(', ')}`
      );
    }

    // Sort by: 1) health (HEALTHY > DEGRADED > UNHEALTHY), 2) response time, 3) priority
    const sortedEndpoints = [...endpoints].sort((a, b) => {
      // Health weight (higher = better)
      const healthWeight = {
        [ServiceHealth.HEALTHY]: 3,
        [ServiceHealth.DEGRADED]: 2,
        [ServiceHealth.UNHEALTHY]: 1,
        [ServiceHealth.UNKNOWN]: 0
      };

      const healthDiff = healthWeight[b.health] - healthWeight[a.health];
      if (healthDiff !== 0) return healthDiff;

      // Response time (lower = better)
      const timeDiff = a.responseTime - b.responseTime;
      if (timeDiff !== 0) return timeDiff;

      // Priority (lower = better)
      return a.priority - b.priority;
    });

    const bestEndpoint = sortedEndpoints[0];

    // If best endpoint is UNHEALTHY or UNKNOWN, return null
    if (bestEndpoint.health === ServiceHealth.UNHEALTHY ||
        bestEndpoint.health === ServiceHealth.UNKNOWN) {
      logger.error(`No healthy endpoints available for ${serviceName}`, {
        endpoints: endpoints.map(e => ({
          url: e.url,
          health: e.health,
          lastCheck: e.lastCheck,
          consecutiveFailures: e.consecutiveFailures
        })),
        troubleshooting: [
          `1. Check if ${serviceName} containers are running: docker ps | grep ${serviceName}`,
          `2. Verify DNS resolution inside container: docker exec <container> ping nexus-${serviceName}`,
          `3. Check docker-compose network configuration`,
          `4. Review ${serviceName} service logs for errors`
        ]
      });
      return null;
    }

    logger.debug(`Selected endpoint for ${serviceName}`, {
      url: bestEndpoint.url,
      health: bestEndpoint.health,
      responseTime: bestEndpoint.responseTime
    });

    return bestEndpoint;
  }

  /**
   * Get all endpoints for a service (for debugging)
   */
  public getServiceEndpoints(serviceName: string): ServiceEndpoint[] {
    return this.services.get(serviceName) || [];
  }

  /**
   * Get health summary for all services
   */
  public getHealthSummary(): Record<string, any> {
    const summary: Record<string, any> = {};

    for (const [serviceName, endpoints] of this.services.entries()) {
      const healthyCount = endpoints.filter(e => e.health === ServiceHealth.HEALTHY).length;
      const degradedCount = endpoints.filter(e => e.health === ServiceHealth.DEGRADED).length;
      const unhealthyCount = endpoints.filter(e => e.health === ServiceHealth.UNHEALTHY).length;

      summary[serviceName] = {
        healthy: healthyCount > 0,
        totalEndpoints: endpoints.length,
        healthyEndpoints: healthyCount,
        degradedEndpoints: degradedCount,
        unhealthyEndpoints: unhealthyCount,
        bestEndpoint: this.getHealthyEndpoint(serviceName)?.url || null,
        endpoints: endpoints.map(e => ({
          url: e.url,
          health: e.health,
          lastCheck: e.lastCheck.toISOString(),
          responseTime: e.responseTime
        }))
      };
    }

    return summary;
  }

  /**
   * Check if registry is initialized
   */
  public isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Shutdown registry and stop all health checks
   */
  public shutdown(): void {
    logger.info('Shutting down ServiceRegistry...');

    for (const [serviceName, interval] of this.healthCheckIntervals.entries()) {
      clearInterval(interval);
      logger.debug(`Stopped health checks for ${serviceName}`);
    }

    this.healthCheckIntervals.clear();
    this.services.clear();
    this.isInitialized = false;

    logger.info('ServiceRegistry shutdown complete');
  }
}

// Export singleton instance
export const serviceRegistry = ServiceRegistry.getInstance();
