/**
 * Port Registry - Centralized Port Management
 *
 * Single source of truth for all port allocations across the Nexus Nexus stack.
 * Prevents port conflicts and provides type-safe port access.
 *
 * @module port-registry
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * Port configuration for a service
 */
export interface ServicePortConfig {
  container_name?: string;
  docker?: {
    host_port: number;
    container_port: number;
    protocol: 'tcp' | 'udp';
  };
  kubernetes?: {
    service_name: string;
    port: number;
    target_port: number;
    type?: 'ClusterIP' | 'LoadBalancer' | 'NodePort';
  };
  istio?: {
    virtual_service?: string;
    gateway?: string;
    host?: string;
    enabled?: boolean;
    websocket?: boolean;
    routes?: Array<{
      path: string;
      timeout?: string;
    }>;
  };
  description: string;
  health_check?: string;
  status?: 'active' | 'reserved';
}

/**
 * Port registry structure
 */
export interface PortRegistry {
  metadata: {
    version: string;
    last_updated: string;
    managed_by: string;
    description: string;
  };
  services: Record<string, ServicePortConfig>;
  istio_gateways?: Record<string, any>;
  port_allocation: {
    used_ports: number[];
    available_ranges: Array<{
      start: number;
      end: number;
      description: string;
    }>;
    next_available: number;
  };
  migration?: {
    docker_to_kubernetes: string[];
    kubernetes_to_istio: string[];
    port_reassignments_applied?: Array<{
      service: string;
      old_port: number;
      new_port: number;
      reason: string;
    }>;
  };
}

/**
 * Type-safe port accessor with environment-aware resolution
 */
export class PortRegistryManager {
  private registry: PortRegistry;
  private environment: 'docker' | 'kubernetes' | 'istio';

  constructor(registryPath?: string, environment?: 'docker' | 'kubernetes' | 'istio') {
    // Default to root .port-registry.yaml
    const path = registryPath || join(__dirname, '../../../.port-registry.yaml');

    try {
      const content = readFileSync(path, 'utf8');
      this.registry = parseYaml(content) as PortRegistry;
    } catch (error) {
      throw new Error(`Failed to load port registry from ${path}: ${error}`);
    }

    // Auto-detect environment from environment variables
    this.environment = environment || this.detectEnvironment();
  }

  /**
   * Detect runtime environment
   */
  private detectEnvironment(): 'docker' | 'kubernetes' | 'istio' {
    if (process.env.KUBERNETES_SERVICE_HOST) {
      // Running in Kubernetes
      if (process.env.ISTIO_ENABLED === 'true') {
        return 'istio';
      }
      return 'kubernetes';
    }
    // Default to Docker Compose environment
    return 'docker';
  }

  /**
   * Get port for a service based on current environment
   *
   * @param serviceName - Service name from port registry
   * @returns Port number or throws if not found
   *
   * @example
   * ```typescript
   * const registry = new PortRegistryManager();
   * const port = registry.getPort('mageagent-http'); // 9080 (docker) or 8080 (k8s)
   * ```
   */
  public getPort(serviceName: string): number {
    const service = this.registry.services[serviceName];

    if (!service) {
      throw new Error(`Service '${serviceName}' not found in port registry`);
    }

    switch (this.environment) {
      case 'docker':
        if (!service.docker) {
          throw new Error(`Service '${serviceName}' has no Docker port configuration`);
        }
        return service.docker.host_port;

      case 'kubernetes':
      case 'istio':
        if (!service.kubernetes) {
          throw new Error(`Service '${serviceName}' has no Kubernetes port configuration`);
        }
        // In K8s, use the service port (not target_port, which is internal)
        return service.kubernetes.port;

      default:
        throw new Error(`Unknown environment: ${this.environment}`);
    }
  }

  /**
   * Get container/target port (internal port) for a service
   */
  public getContainerPort(serviceName: string): number {
    const service = this.registry.services[serviceName];

    if (!service) {
      throw new Error(`Service '${serviceName}' not found in port registry`);
    }

    if (this.environment === 'docker' && service.docker) {
      return service.docker.container_port;
    }

    if ((this.environment === 'kubernetes' || this.environment === 'istio') && service.kubernetes) {
      return service.kubernetes.target_port;
    }

    throw new Error(`Service '${serviceName}' has no container port configuration for ${this.environment}`);
  }

  /**
   * Get service URL based on current environment
   *
   * @param serviceName - Service name from port registry
   * @param protocol - Protocol (http, https, ws, wss)
   * @returns Full service URL
   *
   * @example
   * ```typescript
   * const registry = new PortRegistryManager();
   * const url = registry.getServiceUrl('graphrag-http', 'http');
   * // Docker: 'http://localhost:9090'
   * // K8s: 'http://graphrag:9090'
   * // Istio: 'http://graphrag.nexus.local'
   * ```
   */
  public getServiceUrl(serviceName: string, protocol: 'http' | 'https' | 'ws' | 'wss' = 'http'): string {
    const service = this.registry.services[serviceName];

    if (!service) {
      throw new Error(`Service '${serviceName}' not found in port registry`);
    }

    switch (this.environment) {
      case 'docker': {
        const port = this.getPort(serviceName);
        const host = process.env.DOCKER_HOST_IP || 'localhost';
        return `${protocol}://${host}:${port}`;
      }

      case 'kubernetes': {
        const k8sConfig = service.kubernetes;
        if (!k8sConfig) {
          throw new Error(`Service '${serviceName}' has no Kubernetes configuration`);
        }
        const host = k8sConfig.service_name;
        const port = k8sConfig.port;
        return `${protocol}://${host}:${port}`;
      }

      case 'istio': {
        const istioConfig = service.istio;
        if (!istioConfig || !istioConfig.host) {
          // Fallback to Kubernetes config
          const k8sConfig = service.kubernetes;
          if (!k8sConfig) {
            throw new Error(`Service '${serviceName}' has no Istio/Kubernetes configuration`);
          }
          return `${protocol}://${k8sConfig.service_name}:${k8sConfig.port}`;
        }
        // Use Istio virtual service hostname
        return `${protocol}://${istioConfig.host}`;
      }

      default:
        throw new Error(`Unknown environment: ${this.environment}`);
    }
  }

  /**
   * Check if a port is available
   */
  public isPortAvailable(port: number): boolean {
    return !this.registry.port_allocation.used_ports.includes(port);
  }

  /**
   * Get next available port
   */
  public getNextAvailablePort(): number {
    return this.registry.port_allocation.next_available;
  }

  /**
   * Get all services
   */
  public getAllServices(): string[] {
    return Object.keys(this.registry.services);
  }

  /**
   * Get service configuration
   */
  public getServiceConfig(serviceName: string): ServicePortConfig {
    const service = this.registry.services[serviceName];
    if (!service) {
      throw new Error(`Service '${serviceName}' not found in port registry`);
    }
    return service;
  }

  /**
   * Get registry metadata
   */
  public getMetadata() {
    return this.registry.metadata;
  }

  /**
   * Get current environment
   */
  public getEnvironment(): 'docker' | 'kubernetes' | 'istio' {
    return this.environment;
  }
}

/**
 * Singleton instance for convenience
 */
let globalRegistry: PortRegistryManager | null = null;

/**
 * Get global port registry instance
 */
export function getPortRegistry(): PortRegistryManager {
  if (!globalRegistry) {
    globalRegistry = new PortRegistryManager();
  }
  return globalRegistry;
}

/**
 * Reset global registry (useful for testing)
 */
export function resetPortRegistry(): void {
  globalRegistry = null;
}

/**
 * Typed port constants for common services (for type safety and autocomplete)
 */
export const PORTS = {
  MCP_SERVER: 'mcp-server',
  MAGEAGENT_HTTP: 'mageagent-http',
  MAGEAGENT_WS: 'mageagent-ws',
  GRAPHRAG_HTTP: 'graphrag-http',
  GRAPHRAG_WS: 'graphrag-ws',
  API_GATEWAY_HTTP: 'api-gateway-http',
  API_GATEWAY_WS: 'api-gateway-ws',
  SANDBOX_HTTP: 'sandbox-http',
  SANDBOX_WS: 'sandbox-ws',
  LEARNINGAGENT_HTTP: 'learningagent-http',
  LEARNINGAGENT_WS: 'learningagent-ws',
  FILEPROCESS_API_HTTP: 'fileprocess-api-http',
  FILEPROCESS_API_WS: 'fileprocess-api-ws',
  AUTH_SERVICE: 'auth-service',
  VIDEOAGENT_API: 'videoagent-api',
  QDRANT_HTTP: 'qdrant-http',
  QDRANT_GRPC: 'qdrant-grpc',
  REDIS: 'redis',
  POSTGRES: 'postgres',
  NEO4J_HTTP: 'neo4j-http',
  NEO4J_BOLT: 'neo4j-bolt',
} as const;

export type ServiceName = typeof PORTS[keyof typeof PORTS];
