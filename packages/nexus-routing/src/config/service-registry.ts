/**
 * Centralized Service Discovery Registry
 * SOLID Principle: Single source of truth for all service endpoints
 * Fail-Fast: Validates connectivity at startup
 */

export interface ServiceEndpoint {
  name: string;
  host: string;
  port: number;
  healthPath: string;
  expectedTools?: string[]; // Tools this service should provide
}

export interface ServiceRegistry {
  mageagent: ServiceEndpoint;
  apiGateway: ServiceEndpoint;
  graphrag: ServiceEndpoint;
  mcpGateway: ServiceEndpoint;
}

/**
 * Service Registry - Production Configuration
 * Environment-aware with validation
 */
export const SERVICE_REGISTRY: ServiceRegistry = {
  mageagent: {
    name: 'MageAgent',
    host: process.env.MAGEAGENT_HOST || 'nexus-mageagent',
    port: parseInt(process.env.MAGEAGENT_PORT || '8080', 10),
    healthPath: '/health',
    expectedTools: ['nexus_orchestrate', 'nexus_sandbox_execute']
  },
  apiGateway: {
    name: 'API Gateway (Nexus)',
    host: process.env.API_GATEWAY_HOST || 'nexus-api-gateway',
    port: parseInt(process.env.API_GATEWAY_PORT || '8092', 10),
    healthPath: '/health',
    expectedTools: [
      'nexus_ingest_url',
      'nexus_ingest_url_confirm',
      'nexus_validate_url',
      'nexus_check_ingestion_job'
    ]
  },
  graphrag: {
    name: 'GraphRAG',
    host: process.env.GRAPHRAG_HOST || 'nexus-graphrag',
    port: parseInt(process.env.GRAPHRAG_PORT || '8090', 10),
    healthPath: '/health',
    expectedTools: ['nexus_store_document', 'nexus_store_memory']
  },
  mcpGateway: {
    name: 'MCP Gateway',
    host: process.env.MCP_GATEWAY_HOST || 'nexus-mcp-gateway',
    port: parseInt(process.env.MCP_GATEWAY_PORT || '8092', 10),
    healthPath: '/health',
    expectedTools: []
  }
};

/**
 * Get external (host-accessible) port mapping
 * Used for documentation and user-facing URLs
 */
export const EXTERNAL_PORT_MAP = {
  mageagent: 9080,
  apiGateway: 9092,
  graphrag: 9090,
  mcpServer: 9000
} as const;

/**
 * Validate service endpoint connectivity
 * Throws descriptive error if service unreachable
 */
export async function validateServiceEndpoint(
  endpoint: ServiceEndpoint
): Promise<{ healthy: boolean; error?: string }> {
  try {
    const url = `http://${endpoint.host}:${endpoint.port}${endpoint.healthPath}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        healthy: false,
        error: `Service ${endpoint.name} returned HTTP ${response.status}`
      };
    }

    console.debug(`Service ${endpoint.name} health check passed`, { url });
    return { healthy: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      healthy: false,
      error: `Cannot reach ${endpoint.name} at ${endpoint.host}:${endpoint.port} - ${message}`
    };
  }
}

/**
 * Validate all service endpoints at startup
 * Fail-fast if critical services unavailable
 */
export async function validateAllServices(
  required: (keyof ServiceRegistry)[] = ['apiGateway', 'graphrag']
): Promise<void> {
  console.log('🔍 Validating service registry...');

  const results = await Promise.all(
    required.map(async (key) => {
      const endpoint = SERVICE_REGISTRY[key];
      const result = await validateServiceEndpoint(endpoint);
      return { key, endpoint, ...result };
    })
  );

  const failures = results.filter((r) => !r.healthy);

  if (failures.length > 0) {
    const errorMessage =
      `SERVICE REGISTRY VALIDATION FAILED\n\n` +
      `The following required services are unavailable:\n\n` +
      failures
        .map(
          (f) =>
            `  - ${f.endpoint.name}\n` +
            `    Host: ${f.endpoint.host}:${f.endpoint.port}\n` +
            `    Error: ${f.error}\n` +
            `    Health endpoint: ${f.endpoint.healthPath}\n`
        )
        .join('\n') +
      `\nTroubleshooting:\n` +
      `1. Verify services are running: docker ps | grep nexus\n` +
      `2. Check service logs: docker logs <service-name>\n` +
      `3. Verify network connectivity: docker network inspect nexus-network\n`;

    console.error('Service registry validation failed', { failures });
    throw new Error(errorMessage);
  }

  console.log('✅ All required services validated', {
    services: required.map((k) => SERVICE_REGISTRY[k].name)
  });
}
