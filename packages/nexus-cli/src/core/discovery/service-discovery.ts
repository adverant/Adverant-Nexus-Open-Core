/**
 * Service Discovery Engine
 *
 * Main orchestrator that discovers services, commands, and capabilities
 * Caches results for performance
 */

import axios from 'axios';
import { resolve, join } from 'path';
import type {
  ServiceMetadata,
  ServiceHealth,
  ServiceCommand
} from '../../types/service.js';
import { ServiceStatus } from '../../types/service.js';
import type { Plugin } from '../../types/plugin.js';
import {
  parseDockerCompose,
  extractServiceMetadata,
  parseMultipleComposeFiles,
  filterApplicationServices
} from './docker-parser.js';
import {
  fetchOpenAPISpec,
  parseOpenAPIToCommands
} from './openapi-parser.js';
import {
  discoverMCPCommands
} from './mcp-discovery.js';
import {
  discoverPlugins,
  getPluginCommands
} from './plugin-discovery.js';

export interface ServiceDiscoveryOptions {
  composeFiles?: string[];
  mcpUrl?: string;
  pluginDir?: string;
  skipHealthCheck?: boolean;
  skipOpenAPI?: boolean;
  skipMCP?: boolean;
  skipPlugins?: boolean;
  cacheTimeout?: number; // TTL in milliseconds
}

export interface DiscoveryResult {
  services: Map<string, ServiceMetadata>;
  commands: Map<string, ServiceCommand[]>;
  plugins: Plugin[];
  nexusCommands: ServiceCommand[];
  timestamp: Date;
}

// In-memory cache
let discoveryCache: DiscoveryResult | null = null;
let cacheTimestamp: number = 0;
const DEFAULT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Discover all services from docker-compose files
 */
export async function discoverServices(
  options: ServiceDiscoveryOptions = {}
): Promise<Map<string, ServiceMetadata>> {
  const {
    composeFiles = ['/home/user/Adverant-Nexus/docker/docker-compose.unified-nexus.yml'],
    skipHealthCheck = false
  } = options;

  // Parse docker-compose files
  const services = await parseMultipleComposeFiles(composeFiles);

  // Filter out infrastructure services (databases, etc.)
  const appServices = filterApplicationServices(services);

  // Check health status if not skipped
  if (!skipHealthCheck) {
    await updateHealthStatus(appServices);
  }

  return appServices;
}

/**
 * Refresh discovery cache
 */
export async function refreshDiscovery(
  options: ServiceDiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const {
    skipOpenAPI = false,
    skipMCP = false,
    skipPlugins = false,
    cacheTimeout = DEFAULT_CACHE_TTL
  } = options;

  console.log('🔍 Discovering services...');

  // Discover services from docker-compose
  const services = await discoverServices(options);
  console.log(`✅ Found ${services.size} services`);

  // Discover commands from OpenAPI specs
  const commands = new Map<string, ServiceCommand[]>();

  if (!skipOpenAPI) {
    console.log('📚 Discovering OpenAPI endpoints...');
    await discoverServiceCommands(services, commands);
    const totalCommands = Array.from(commands.values()).reduce((sum, cmds) => sum + cmds.length, 0);
    console.log(`✅ Found ${totalCommands} commands from ${commands.size} services`);
  }

  // Discover Nexus MCP commands
  let nexusCommands: ServiceCommand[] = [];

  if (!skipMCP) {
    console.log('🧠 Discovering Nexus MCP tools...');
    nexusCommands = await discoverMCPCommands({
      mcpUrl: options.mcpUrl
    });
    console.log(`✅ Found ${nexusCommands.length} Nexus tools`);
  }

  // Discover plugins
  let plugins: Plugin[] = [];

  if (!skipPlugins) {
    console.log('🔌 Discovering plugins...');
    plugins = await discoverPlugins({
      pluginDir: options.pluginDir
    });
    console.log(`✅ Found ${plugins.length} plugins`);

    // Add plugin commands to command map
    const pluginCommands = getPluginCommands(plugins);
    for (const [pluginName, cmds] of pluginCommands) {
      commands.set(`plugin:${pluginName}`, cmds as any);
    }
  }

  // Update cache
  const result: DiscoveryResult = {
    services,
    commands,
    plugins,
    nexusCommands,
    timestamp: new Date()
  };

  discoveryCache = result;
  cacheTimestamp = Date.now();

  console.log('✨ Discovery complete!');

  return result;
}

/**
 * Get cached discovery result or refresh if expired
 */
export async function getDiscovery(
  options: ServiceDiscoveryOptions = {}
): Promise<DiscoveryResult> {
  const { cacheTimeout = DEFAULT_CACHE_TTL } = options;

  // Check if cache is valid
  if (discoveryCache && (Date.now() - cacheTimestamp) < cacheTimeout) {
    return discoveryCache;
  }

  // Refresh cache
  return await refreshDiscovery(options);
}

/**
 * Update health status for all services
 */
async function updateHealthStatus(services: Map<string, ServiceMetadata>): Promise<void> {
  const healthChecks = Array.from(services.values()).map(async (service) => {
    const health = await getServiceHealth(service);
    service.status = health.status;
  });

  await Promise.all(healthChecks);
}

/**
 * Get service health status
 */
export async function getServiceHealth(service: ServiceMetadata): Promise<ServiceHealth> {
  const startTime = Date.now();

  if (!service.apiUrl || !service.healthEndpoint) {
    return {
      healthy: false,
      status: ServiceStatus.UNKNOWN,
      lastCheck: new Date(),
      message: 'No health endpoint configured'
    };
  }

  try {
    const url = `${service.apiUrl}${service.healthEndpoint}`;

    const response = await axios.get(url, {
      timeout: 5000,
      validateStatus: (status) => status < 500
    });

    const latency = Date.now() - startTime;

    if (response.status === 200) {
      return {
        healthy: true,
        status: ServiceStatus.RUNNING,
        latency,
        lastCheck: new Date(),
        details: response.data
      };
    } else {
      return {
        healthy: false,
        status: ServiceStatus.UNHEALTHY,
        latency,
        lastCheck: new Date(),
        message: `HTTP ${response.status}`
      };
    }
  } catch (error) {
    return {
      healthy: false,
      status: ServiceStatus.STOPPED,
      lastCheck: new Date(),
      message: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Discover commands from service OpenAPI specs
 */
async function discoverServiceCommands(
  services: Map<string, ServiceMetadata>,
  commandMap: Map<string, ServiceCommand[]>
): Promise<void> {
  for (const [name, service] of services) {
    if (!service.openApiSpec || !service.apiUrl) {
      continue;
    }

    try {
      const specUrl = `${service.apiUrl}${service.openApiSpec}`;
      const spec = await fetchOpenAPISpec(specUrl, { timeout: 5000 });

      if (spec) {
        const commands = await parseOpenAPIToCommands(spec, name);
        if (commands.length > 0) {
          commandMap.set(name, commands);
        }
      }
    } catch (error) {
      console.warn(`Warning: Could not fetch OpenAPI spec for ${name}:`, error);
      // Continue with other services
    }
  }
}

/**
 * Get service by name
 */
export async function getService(
  name: string,
  options: ServiceDiscoveryOptions = {}
): Promise<ServiceMetadata | null> {
  const discovery = await getDiscovery(options);
  return discovery.services.get(name) || null;
}

/**
 * Get all commands for a service
 */
export async function getServiceCommands(
  serviceName: string,
  options: ServiceDiscoveryOptions = {}
): Promise<ServiceCommand[]> {
  const discovery = await getDiscovery(options);
  return discovery.commands.get(serviceName) || [];
}

/**
 * Get all Nexus commands
 */
export async function getNexusCommands(
  options: ServiceDiscoveryOptions = {}
): Promise<ServiceCommand[]> {
  const discovery = await getDiscovery(options);
  return discovery.nexusCommands;
}

/**
 * Get all plugins
 */
export async function getPlugins(
  options: ServiceDiscoveryOptions = {}
): Promise<Plugin[]> {
  const discovery = await getDiscovery(options);
  return discovery.plugins;
}

/**
 * Search for commands across all services
 */
export async function searchCommands(
  query: string,
  options: ServiceDiscoveryOptions = {}
): Promise<Array<{ service: string; command: ServiceCommand }>> {
  const discovery = await getDiscovery(options);
  const results: Array<{ service: string; command: ServiceCommand }> = [];
  const lowerQuery = query.toLowerCase();

  // Search service commands
  for (const [serviceName, commands] of discovery.commands) {
    for (const command of commands) {
      if (
        command.name.toLowerCase().includes(lowerQuery) ||
        command.description.toLowerCase().includes(lowerQuery)
      ) {
        results.push({ service: serviceName, command });
      }
    }
  }

  // Search Nexus commands
  for (const command of discovery.nexusCommands) {
    if (
      command.name.toLowerCase().includes(lowerQuery) ||
      command.description.toLowerCase().includes(lowerQuery)
    ) {
      results.push({ service: 'nexus', command });
    }
  }

  return results;
}

/**
 * Get service statistics
 */
export async function getServiceStats(
  options: ServiceDiscoveryOptions = {}
): Promise<{
  totalServices: number;
  runningServices: number;
  totalCommands: number;
  totalPlugins: number;
  totalNexusTools: number;
}> {
  const discovery = await getDiscovery(options);

  const runningServices = Array.from(discovery.services.values()).filter(
    s => s.status === ServiceStatus.RUNNING
  ).length;

  const totalCommands = Array.from(discovery.commands.values()).reduce(
    (sum, cmds) => sum + cmds.length,
    0
  );

  return {
    totalServices: discovery.services.size,
    runningServices,
    totalCommands,
    totalPlugins: discovery.plugins.length,
    totalNexusTools: discovery.nexusCommands.length
  };
}

/**
 * Clear discovery cache
 */
export function clearCache(): void {
  discoveryCache = null;
  cacheTimestamp = 0;
}

/**
 * Get cache status
 */
export function getCacheStatus(): {
  cached: boolean;
  age: number; // milliseconds
  timestamp: Date | null;
} {
  return {
    cached: discoveryCache !== null,
    age: discoveryCache ? Date.now() - cacheTimestamp : 0,
    timestamp: discoveryCache?.timestamp || null
  };
}

/**
 * Validate service configuration
 */
export async function validateService(
  serviceName: string,
  options: ServiceDiscoveryOptions = {}
): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const service = await getService(serviceName, options);

  if (!service) {
    errors.push(`Service '${serviceName}' not found`);
    return { valid: false, errors, warnings };
  }

  // Check if service has API URL
  if (!service.apiUrl) {
    errors.push('Service has no API URL');
  }

  // Check if service is running
  if (service.status !== ServiceStatus.RUNNING) {
    warnings.push(`Service status is ${service.status}, not running`);
  }

  // Check if health endpoint is accessible
  const health = await getServiceHealth(service);
  if (!health.healthy) {
    errors.push(`Health check failed: ${health.message}`);
  }

  // Check if OpenAPI spec is accessible
  if (service.openApiSpec) {
    try {
      const spec = await fetchOpenAPISpec(`${service.apiUrl}${service.openApiSpec}`, {
        timeout: 5000
      });
      if (!spec) {
        warnings.push('OpenAPI spec endpoint exists but returned invalid data');
      }
    } catch {
      warnings.push('OpenAPI spec endpoint is not accessible');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Get service dependency graph
 */
export async function getServiceDependencies(
  options: ServiceDiscoveryOptions = {}
): Promise<Map<string, string[]>> {
  const discovery = await getDiscovery(options);
  const deps = new Map<string, string[]>();

  for (const [name, service] of discovery.services) {
    deps.set(name, service.dependencies);
  }

  return deps;
}

/**
 * Check if all service dependencies are satisfied
 */
export async function checkDependencies(
  serviceName: string,
  options: ServiceDiscoveryOptions = {}
): Promise<{
  satisfied: boolean;
  missing: string[];
  available: string[];
}> {
  const discovery = await getDiscovery(options);
  const service = discovery.services.get(serviceName);

  if (!service) {
    return {
      satisfied: false,
      missing: [],
      available: []
    };
  }

  const missing: string[] = [];
  const available: string[] = [];

  for (const dep of service.dependencies) {
    const depService = discovery.services.get(dep);

    if (!depService || depService.status !== ServiceStatus.RUNNING) {
      missing.push(dep);
    } else {
      available.push(dep);
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
    available
  };
}
