/**
 * Service Discovery with Endpoint Fallback
 * Auto-detects backend service endpoints with intelligent fallback chain
 */

import axios from 'axios';
import { logger } from './logger.js';

export interface ServiceEndpoint {
  name: string;
  url: string;
  lastChecked: number;
  healthy: boolean;
  latency: number;
}

export interface ServiceDiscoveryConfig {
  name: string;
  candidates: string[];
  healthPath: string;
  timeout: number;
}

/**
 * ServiceDiscovery class - Discovers and validates service endpoints
 */
export class ServiceDiscovery {
  private endpoints: Map<string, ServiceEndpoint> = new Map();
  private checking: Map<string, Promise<ServiceEndpoint>> = new Map();

  /**
   * Discover working endpoint for a service
   */
  async discover(config: ServiceDiscoveryConfig): Promise<ServiceEndpoint> {
    const { name, candidates, healthPath, timeout } = config;

    // Check if we have a recent valid endpoint
    const existing = this.endpoints.get(name);
    if (existing && this.isRecentlyValidated(existing)) {
      logger.debug('Using cached endpoint', { name, url: existing.url });
      return existing;
    }

    // Prevent concurrent discoveries for same service
    const inProgress = this.checking.get(name);
    if (inProgress) {
      logger.debug('Discovery already in progress', { name });
      return inProgress;
    }

    // Start new discovery
    const discoveryPromise = this.performDiscovery(name, candidates, healthPath, timeout);
    this.checking.set(name, discoveryPromise);

    try {
      const endpoint = await discoveryPromise;
      this.endpoints.set(name, endpoint);
      return endpoint;
    } finally {
      this.checking.delete(name);
    }
  }

  /**
   * Perform actual discovery by testing candidates
   */
  private async performDiscovery(
    name: string,
    candidates: string[],
    healthPath: string,
    timeout: number
  ): Promise<ServiceEndpoint> {
    logger.info('Starting service discovery', { name, candidates: candidates.length });

    // Test all candidates in parallel (fastest wins)
    const tests = candidates.map(url =>
      this.testEndpoint(url, healthPath, timeout)
    );

    // Wait for first success or all failures
    const results = await Promise.allSettled(tests);

    // Find first successful endpoint
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value.healthy) {
        const endpoint = result.value;
        logger.info('Service discovered', {
          name,
          url: endpoint.url,
          latency: `${endpoint.latency}ms`
        });
        return endpoint;
      }
    }

    // All endpoints failed
    logger.error('Service discovery failed - all endpoints unreachable', {
      name,
      candidates,
      attempts: results.length
    });

    // Return first candidate as fallback (will fail later, but with proper error)
    return {
      name,
      url: candidates[0],
      lastChecked: Date.now(),
      healthy: false,
      latency: -1
    };
  }

  /**
   * Test a single endpoint
   */
  private async testEndpoint(
    url: string,
    healthPath: string,
    timeout: number
  ): Promise<ServiceEndpoint> {
    const startTime = Date.now();
    const fullUrl = `${url}${healthPath}`;

    try {
      const response = await axios.get(fullUrl, {
        timeout,
        validateStatus: (status) => status === 200
      });

      const latency = Date.now() - startTime;
      const healthy = response.status === 200;

      logger.debug('Endpoint test result', {
        url,
        healthy,
        latency: `${latency}ms`,
        status: response.status
      });

      return {
        name: url,
        url,
        lastChecked: Date.now(),
        healthy,
        latency
      };
    } catch (error) {
      logger.debug('Endpoint test failed', {
        url,
        error: (error as Error).message
      });

      return {
        name: url,
        url,
        lastChecked: Date.now(),
        healthy: false,
        latency: -1
      };
    }
  }

  /**
   * Check if endpoint was recently validated (within 30 seconds)
   */
  private isRecentlyValidated(endpoint: ServiceEndpoint): boolean {
    const age = Date.now() - endpoint.lastChecked;
    return age < 30000 && endpoint.healthy;
  }

  /**
   * Get cached endpoint (if exists)
   */
  getCached(name: string): ServiceEndpoint | undefined {
    return this.endpoints.get(name);
  }

  /**
   * Invalidate cached endpoint (force rediscovery)
   */
  invalidate(name: string): void {
    this.endpoints.delete(name);
    logger.debug('Endpoint cache invalidated', { name });
  }

  /**
   * Clear all cached endpoints
   */
  clearAll(): void {
    this.endpoints.clear();
    logger.debug('All endpoint caches cleared');
  }
}

// Export singleton instance
export const serviceDiscovery = new ServiceDiscovery();
