/**
 * Docker Compose Parser
 *
 * Parses docker-compose.yml files (v3.8) to extract service metadata
 */

import { readFile } from 'fs/promises';
import { load as yamlLoad } from 'js-yaml';
import type {
  DockerComposeConfig,
  DockerComposeService,
  ServiceMetadata,
  PortMapping,
  ServiceCapability
} from '../../types/service.js';
import { ServiceStatus } from '../../types/service.js';

export interface DockerParserOptions {
  defaultProtocol?: 'http' | 'https';
  defaultHost?: string;
}

/**
 * Parse docker-compose YAML file
 */
export async function parseDockerCompose(
  filePath: string,
  options: DockerParserOptions = {}
): Promise<DockerComposeConfig> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = yamlLoad(content) as DockerComposeConfig;

    if (!parsed.services) {
      throw new Error('Invalid docker-compose file: missing services section');
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse docker-compose file: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Extract service metadata from docker-compose service definition
 */
export function extractServiceMetadata(
  name: string,
  service: DockerComposeService,
  options: DockerParserOptions = {}
): ServiceMetadata {
  const {
    defaultProtocol = 'http',
    defaultHost = 'localhost'
  } = options;

  // Parse port mappings
  const ports = parsePortMappings(service.ports || []);

  // Determine primary port (first HTTP port)
  const primaryPort = ports.find(p => p.host > 0)?.host || 0;

  // Extract environment variables
  const environment = parseEnvironment(service.environment || {});

  // Generate API URL
  const apiUrl = primaryPort > 0
    ? `${defaultProtocol}://${defaultHost}:${primaryPort}`
    : '';

  // Detect WebSocket support
  const wsPort = detectWebSocketPort(service, ports);
  const wsUrl = wsPort > 0
    ? `ws://${defaultHost}:${wsPort}`
    : undefined;

  // Extract dependencies
  const dependencies = extractDependencies(service.depends_on);

  // Detect service capabilities
  const capabilities = detectCapabilities(name, service, environment);

  // Generate display name (convert nexus-graphrag → GraphRAG)
  const displayName = generateDisplayName(name);

  // Extract description from service metadata or generate
  const description = generateDescription(name, service);

  // Determine health endpoint
  const healthEndpoint = detectHealthEndpoint(service, primaryPort);

  return {
    name: name.replace(/^nexus-/, ''), // Remove nexus- prefix for cleaner names
    displayName,
    description,
    version: service.image?.split(':')[1] || 'latest',
    status: ServiceStatus.UNKNOWN,
    container: service.container_name || name,
    ports,
    healthEndpoint,
    apiUrl,
    wsUrl,
    openApiSpec: detectOpenApiSpec(name, primaryPort),
    graphqlSchema: detectGraphQLSchema(name, environment),
    capabilities,
    dependencies,
    environment
  };
}

/**
 * Parse port mappings from docker-compose format
 */
function parsePortMappings(ports: string[]): PortMapping[] {
  return ports.map(portStr => {
    // Format: "host:container" or "host:container/protocol"
    const [mapping, protocol = 'tcp'] = portStr.split('/');
    const [hostStr, containerStr] = mapping.split(':');

    return {
      host: parseInt(hostStr, 10),
      container: containerStr ? parseInt(containerStr, 10) : parseInt(hostStr, 10),
      protocol: protocol as 'tcp' | 'udp'
    };
  });
}

/**
 * Parse environment variables (array or object format)
 */
function parseEnvironment(env: Record<string, string> | string[]): Record<string, string> {
  if (Array.isArray(env)) {
    const result: Record<string, string> = {};
    for (const item of env) {
      const [key, ...valueParts] = item.split('=');
      if (key) {
        result[key] = valueParts.join('=') || '';
      }
    }
    return result;
  }
  return env;
}

/**
 * Extract service dependencies
 */
function extractDependencies(depends_on?: string[] | Record<string, any>): string[] {
  if (!depends_on) return [];

  if (Array.isArray(depends_on)) {
    return depends_on.map(dep => dep.replace(/^nexus-/, ''));
  }

  return Object.keys(depends_on).map(dep => dep.replace(/^nexus-/, ''));
}

/**
 * Detect WebSocket port from service configuration
 */
function detectWebSocketPort(
  service: DockerComposeService,
  ports: PortMapping[]
): number {
  // Check environment variables for WS_PORT
  const env = parseEnvironment(service.environment || {});
  const wsPortEnv = env.WS_PORT || env.WEBSOCKET_PORT;

  if (wsPortEnv) {
    // Find the host port that maps to this container port
    const containerPort = parseInt(wsPortEnv, 10);
    const mapping = ports.find(p => p.container === containerPort);
    return mapping?.host || 0;
  }

  // Check if service name suggests WebSocket support
  const serviceName = service.container_name || '';
  if (serviceName.includes('gateway') || serviceName.includes('api')) {
    // Second port is often WebSocket
    return ports[1]?.host || 0;
  }

  return 0;
}

/**
 * Detect service capabilities based on name and configuration
 */
function detectCapabilities(
  name: string,
  service: DockerComposeService,
  env: Record<string, string>
): ServiceCapability[] {
  const capabilities: ServiceCapability[] = [];
  const ports = parsePortMappings(service.ports || []);
  const primaryPort = ports[0]?.host || 0;

  // REST API capability (most services have this)
  if (primaryPort > 0) {
    capabilities.push({
      name: 'REST API',
      type: 'rest',
      endpoint: `/api`,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
    });
  }

  // WebSocket capability
  const wsPort = detectWebSocketPort(service, ports);
  if (wsPort > 0) {
    capabilities.push({
      name: 'WebSocket',
      type: 'websocket',
      endpoint: `/`,
      methods: []
    });
  }

  // GraphQL capability
  if (env.GRAPHQL_ENABLED === 'true' || name.includes('graphql')) {
    capabilities.push({
      name: 'GraphQL',
      type: 'graphql',
      endpoint: `/graphql`,
      methods: ['POST']
    });
  }

  // MCP capability
  if (name.includes('mcp') || env.MCP_MODE === 'true') {
    capabilities.push({
      name: 'MCP Server',
      type: 'mcp',
      endpoint: `/`,
      methods: []
    });
  }

  return capabilities;
}

/**
 * Generate display name from service name
 */
function generateDisplayName(name: string): string {
  // Remove nexus- prefix
  const cleanName = name.replace(/^nexus-/, '');

  // Handle special cases
  const specialCases: Record<string, string> = {
    'graphrag': 'GraphRAG',
    'mageagent': 'MageAgent',
    'learningagent': 'LearningAgent',
    'orchestrationagent': 'OrchestrationAgent',
    'videoagent': 'VideoAgent',
    'geoagent': 'GeoAgent',
    'fileprocess-api': 'FileProcess API',
    'fileprocess-worker': 'FileProcess Worker',
    'api-gateway': 'API Gateway',
    'mcp-server': 'MCP Server',
    'mcp-gateway': 'MCP Gateway',
    'auth-service': 'Auth Service',
    'plugin-manager': 'Plugin Manager',
    'postgres': 'PostgreSQL',
    'redis': 'Redis',
    'neo4j': 'Neo4j',
    'qdrant': 'Qdrant',
    'nginx': 'Nginx',
    'kafka': 'Kafka',
    'zookeeper': 'Zookeeper',
    'minio': 'MinIO',
    'jaeger': 'Jaeger',
    'robotics': 'NexusRobotics',
    'sandbox': 'Sandbox',
    'nested-learning': 'Nested Learning Coordinator'
  };

  if (specialCases[cleanName]) {
    return specialCases[cleanName];
  }

  // Default: capitalize first letter of each word
  return cleanName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Generate service description
 */
function generateDescription(name: string, service: DockerComposeService): string {
  const cleanName = name.replace(/^nexus-/, '');

  const descriptions: Record<string, string> = {
    'graphrag': 'Document storage, retrieval, and knowledge graph management',
    'mageagent': 'Multi-agent orchestration and consensus engine',
    'learningagent': 'Progressive learning and information discovery',
    'orchestrationagent': 'Autonomous meta-agent with ReAct loop',
    'videoagent-api': 'Video processing API gateway',
    'videoagent-worker': 'Video processing worker',
    'geoagent': 'Geospatial AI and mapping services',
    'fileprocess-api': 'Document processing API gateway',
    'fileprocess-worker': 'Document processing worker',
    'api-gateway': 'HTTP REST + WebSocket server',
    'mcp-server': 'Model Context Protocol interface',
    'mcp-gateway': 'MCP stdio adapter',
    'auth-service': 'Authentication and authorization',
    'plugin-manager': 'Plugin registry and management',
    'sandbox': 'Code execution and LLM inference',
    'postgres': 'Primary database',
    'redis': 'Cache layer and job queue',
    'neo4j': 'Graph database',
    'qdrant': 'Vector database',
    'nginx': 'Reverse proxy',
    'kafka': 'Message broker',
    'zookeeper': 'Kafka coordinator',
    'minio': 'Object storage',
    'jaeger': 'Distributed tracing',
    'robotics': 'Autonomous systems and drone control',
    'nested-learning': 'Real-time streaming and meta-learning'
  };

  return descriptions[cleanName] || `${generateDisplayName(name)} service`;
}

/**
 * Detect health endpoint
 */
function detectHealthEndpoint(service: DockerComposeService, port: number): string | undefined {
  const healthcheck = service.healthcheck;

  if (!healthcheck) {
    // Default health endpoints
    if (port > 0) {
      return '/health';
    }
    return undefined;
  }

  // Parse health check command to extract endpoint
  const test = Array.isArray(healthcheck.test)
    ? healthcheck.test.join(' ')
    : healthcheck.test;

  // Extract endpoint from wget/curl commands
  const curlMatch = test.match(/curl.*?(https?:\/\/[^\s]+)/);
  const wgetMatch = test.match(/wget.*?(https?:\/\/[^\s]+)/);

  if (curlMatch || wgetMatch) {
    const url = curlMatch?.[1] || wgetMatch?.[1];
    if (url) {
      // Extract path from URL
      try {
        const urlObj = new URL(url);
        return urlObj.pathname;
      } catch {
        return '/health';
      }
    }
  }

  return '/health';
}

/**
 * Detect OpenAPI spec endpoint
 */
function detectOpenApiSpec(name: string, port: number): string | undefined {
  if (port === 0) return undefined;

  // Services that typically expose OpenAPI specs
  const openApiServices = [
    'graphrag', 'mageagent', 'learningagent', 'orchestrationagent',
    'videoagent', 'geoagent', 'fileprocess', 'sandbox', 'api-gateway'
  ];

  const cleanName = name.replace(/^nexus-/, '');
  const hasOpenApi = openApiServices.some(svc => cleanName.includes(svc));

  if (hasOpenApi) {
    return '/openapi.json'; // or /api-docs or /swagger.json
  }

  return undefined;
}

/**
 * Detect GraphQL schema endpoint
 */
function detectGraphQLSchema(name: string, env: Record<string, string>): string | undefined {
  if (env.GRAPHQL_ENABLED !== 'true' && !name.includes('graphql')) {
    return undefined;
  }

  return '/graphql';
}

/**
 * Parse multiple docker-compose files and merge services
 */
export async function parseMultipleComposeFiles(
  filePaths: string[],
  options: DockerParserOptions = {}
): Promise<Map<string, ServiceMetadata>> {
  const services = new Map<string, ServiceMetadata>();

  for (const filePath of filePaths) {
    try {
      const config = await parseDockerCompose(filePath, options);

      for (const [name, service] of Object.entries(config.services)) {
        const metadata = extractServiceMetadata(name, service, options);
        services.set(metadata.name, metadata);
      }
    } catch (error) {
      console.warn(`Warning: Could not parse ${filePath}:`, error);
      // Continue with other files
    }
  }

  return services;
}

/**
 * Filter services by type (exclude databases, infrastructure)
 */
export function filterApplicationServices(
  services: Map<string, ServiceMetadata>
): Map<string, ServiceMetadata> {
  const infraServices = new Set([
    'postgres', 'postgresql', 'redis', 'neo4j', 'qdrant',
    'kafka', 'zookeeper', 'nginx', 'minio', 'jaeger'
  ]);

  const filtered = new Map<string, ServiceMetadata>();

  for (const [name, service] of services) {
    const cleanName = name.toLowerCase().replace(/^nexus-/, '');
    if (!infraServices.has(cleanName)) {
      filtered.set(name, service);
    }
  }

  return filtered;
}
