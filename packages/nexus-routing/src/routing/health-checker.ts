/**
 * Health Checker for Nexus Routing
 * Monitors backend service health with automatic failover
 */

import { logger } from '../utils/logger.js';
import { graphragClient } from '../clients/graphrag-client.js';
import { mageagentClient } from '../clients/mageagent-client.js';

export interface ServiceHealth {
  healthy: boolean;
  lastCheck: Date;
  error?: string;
}

export interface HealthStatus {
  overall: boolean;
  graphrag: ServiceHealth;
  mageagent: ServiceHealth;
  timestamp: Date;
}

/**
 * HealthChecker class - Monitors backend service availability
 */
export class HealthChecker {
  private healthStatus: HealthStatus;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor() {
    this.healthStatus = {
      overall: false,
      graphrag: {
        healthy: false,
        lastCheck: new Date()
      },
      mageagent: {
        healthy: false,
        lastCheck: new Date()
      },
      timestamp: new Date()
    };
  }

  /**
   * Start periodic health checks
   */
  start(intervalMs: number = 30000): void {
    if (this.isRunning) {
      logger.warn('Health checker already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting health checker', { intervalMs });

    // Immediate check
    this.checkServices().catch(error => {
      logger.error('Initial health check failed', { error: error.message });
    });

    // Periodic checks
    this.healthCheckInterval = setInterval(() => {
      this.checkServices().catch(error => {
        logger.error('Health check failed', { error: error.message });
      });
    }, intervalMs);
  }

  /**
   * Stop health checks
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    logger.info('Health checker stopped');
  }

  /**
   * Check health of all services
   */
  async checkServices(): Promise<HealthStatus> {
    logger.debug('Checking service health');

    const [graphragHealthy, mageagentHealthy] = await Promise.all([
      this.checkGraphRAG(),
      this.checkMageAgent()
    ]);

    this.healthStatus = {
      overall: graphragHealthy && mageagentHealthy,
      graphrag: {
        healthy: graphragHealthy,
        lastCheck: new Date(),
        error: graphragHealthy ? undefined : 'Service unavailable or not responding'
      },
      mageagent: {
        healthy: mageagentHealthy,
        lastCheck: new Date(),
        error: mageagentHealthy ? undefined : 'Service unavailable or not responding'
      },
      timestamp: new Date()
    };

    // Log status changes
    if (!this.healthStatus.overall) {
      logger.warn('Service health degraded', {
        graphrag: this.healthStatus.graphrag.healthy,
        mageagent: this.healthStatus.mageagent.healthy
      });
    } else {
      logger.debug('All services healthy');
    }

    return this.healthStatus;
  }

  /**
   * Check GraphRAG service health
   */
  private async checkGraphRAG(): Promise<boolean> {
    try {
      return await graphragClient.checkHealth();
    } catch (error) {
      logger.error('GraphRAG health check error', {
        error: (error as Error).message
      });
      return false;
    }
  }

  /**
   * Check MageAgent service health
   */
  private async checkMageAgent(): Promise<boolean> {
    try {
      return await mageagentClient.checkHealth();
    } catch (error) {
      logger.error('MageAgent health check error', {
        error: (error as Error).message
      });
      return false;
    }
  }

  /**
   * Get current health status
   */
  getHealthStatus(): HealthStatus {
    return this.healthStatus;
  }

  /**
   * Check if a specific service is healthy
   */
  isServiceHealthy(service: 'graphrag' | 'mageagent'): boolean {
    return this.healthStatus[service].healthy;
  }

  /**
   * Check if all services are healthy
   */
  isHealthy(): boolean {
    return this.healthStatus.overall;
  }
}

// Export singleton instance
export const healthChecker = new HealthChecker();
