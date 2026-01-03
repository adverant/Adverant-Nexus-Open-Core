# Port Registry System

## Overview

The Port Registry System provides centralized port management for all Nexus services across Docker and Kubernetes deployments. It prevents port conflicts, provides type-safe port access, and enables environment-aware service URL resolution.

## Features

- **Single Source of Truth**: All port allocations defined in `.port-registry.yaml`
- **Compile-time Validation**: Automatic port conflict detection at module load
- **Environment-Aware**: Automatically detects Docker, Kubernetes, or Istio environments
- **Type-Safe Access**: TypeScript types for all services and ports
- **CI/CD Integration**: CLI validation tool for continuous integration
- **Migration Tracking**: Documents all port reassignments with reasons

## Quick Start

### Installation

The port registry is part of `@adverant/config` package:

```typescript
import { getPortRegistry, PORTS } from '@adverant/config';

const registry = getPortRegistry();
```

### Basic Usage

```typescript
import { getPortRegistry, PORTS } from '@adverant/config';

// Get port for a service
const registry = getPortRegistry();
const mageagentPort = registry.getPort(PORTS.MAGEAGENT_HTTP);
console.log(`MageAgent HTTP port: ${mageagentPort}`);
// Docker: 9080, Kubernetes: 8080

// Get service URL
const mageagentUrl = registry.getServiceUrl(PORTS.MAGEAGENT_HTTP, 'http');
console.log(`MageAgent URL: ${mageagentUrl}`);
// Docker: http://localhost:9080
// Kubernetes: http://nexus-mageagent:8080
// Istio: http://mageagent.nexus.local
```

### Environment Detection

The port registry automatically detects the runtime environment:

```typescript
const registry = getPortRegistry();
const environment = registry.getEnvironment();
// Returns: 'docker' | 'kubernetes' | 'istio'

// Manual override
const dockerRegistry = new PortRegistryManager(undefined, 'docker');
```

Environment detection logic:
- **Istio**: If `KUBERNETES_SERVICE_HOST` and `ISTIO_ENABLED=true`
- **Kubernetes**: If `KUBERNETES_SERVICE_HOST` exists
- **Docker**: Default (Docker Compose environment)

## Port Allocation Strategy

### Port Ranges

| Range | Purpose | Example Services |
|-------|---------|------------------|
| 9000-9099 | Core Services | MCP Server, GraphRAG, MageAgent, API Gateway |
| 9100-9149 | Extended Services | LearningAgent, ProseCreator, FileProcess |
| 9150-9199 | Future Expansion | Reserved for new services |
| 9200-9299 | Special Services | Reserved |
| 9300-9399 | Infrastructure | Qdrant, Redis, Postgres, Neo4j |
| 16000+ | Monitoring | Jaeger, Prometheus |

### Finding Available Ports

```typescript
import { findAvailablePort, getPortRegistry } from '@adverant/config';

const registry = getPortRegistry();

// Find next available port in default range (9134-9199)
const port = findAvailablePort(registry);
console.log(`Next available port: ${port}`);

// Find in custom range
const customPort = findAvailablePort(registry, 9200, 9250);
```

## Validation

### Compile-time Validation

The port registry is validated automatically when the module loads:

```typescript
import { enforceValidation, getPortRegistry } from '@adverant/config';

const registry = getPortRegistry();
enforceValidation(registry); // Throws if conflicts detected
```

### CLI Validation

Run validation manually or in CI/CD:

```bash
# From package root
npm run validate:ports

# Or directly
npx ts-node packages/adverant-config/src/cli/validate-ports.ts
```

Output includes:
- Conflict detection
- Port allocation statistics
- Migration tracking
- Warnings for configuration issues

### CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/ci.yml
- name: Validate Port Registry
  run: |
    cd packages/adverant-config
    npm run validate:ports
```

## Service Configuration

### Adding a New Service

1. **Update `.port-registry.yaml`**:

```yaml
services:
  my-new-service-http:
    container_name: nexus-my-service
    docker:
      host_port: 9134  # Use findAvailablePort() to determine
      container_port: 8080
      protocol: tcp
    kubernetes:
      service_name: nexus-my-service
      port: 8080
      target_port: 8080
      type: ClusterIP
    istio:
      enabled: true
      virtual_service: nexus-my-service
      gateway: nexus-gateway
      host: my-service.nexus.local
    description: "My New Service - What it does"
    health_check: "/health"
    status: active

port_allocation:
  used_ports:
    - 9134  # Add to used_ports list
```

2. **Update `PORTS` constant** in `port-registry.ts`:

```typescript
export const PORTS = {
  // ... existing ports
  MY_SERVICE_HTTP: 'my-new-service-http',
} as const;
```

3. **Validate**:

```bash
npm run validate:ports
```

## Port Reassignments Applied

The following port reassignments were made to resolve conflicts:

| Service | Old Port | New Port | Reason |
|---------|----------|----------|--------|
| nexus-auth-service | 9116 | 9121 | Conflict with nexus-prosecreator |
| nexus-prosecreator-audiobook | 9118 | 9122 | Task requirement - port reassignment |
| nexus-robotics | 9113 | 9123 | Conflict with nexus-mcp-orchestrator |
| nexus-security | 9200 | 9124 | Task requirement - port reassignment |
| nexus-videoagent-api | 9200 | 9127 | Conflict with nexus-security |
| nexus-learningagent WS | 9098 | 9101 | Conflict with nexus-nested-learning |
| nexus-kafka | 9102 | 9128 | Conflict with prosecreator-audiobook-ws |
| minio-api | 9117 | 9129 | Conflict with prosecreator-ws |
| minio-console | 9118 | 9130 | Conflict with prosecreator-audiobook |
| nexus-mcp-orchestrator WS | 9113 | 9131 | Conflict with robotics |

## Advanced Usage

### Port Statistics

Get detailed port allocation statistics:

```typescript
import { getPortStatistics, getPortRegistry } from '@adverant/config';

const registry = getPortRegistry();
const stats = getPortStatistics(registry);

console.log(`Total ports used: ${stats.used_count}`);
console.log(`Utilization: ${stats.utilization_percent}%`);
console.log('Largest gaps:', stats.port_gaps);
```

### Custom Validation

```typescript
import { validatePortRegistry, formatValidationResult } from '@adverant/config';

const result = validatePortRegistry(registry);

if (!result.valid) {
  console.error('Conflicts found:', result.conflicts);
}

if (result.warnings.length > 0) {
  console.warn('Warnings:', result.warnings);
}

// Pretty print
console.log(formatValidationResult(result));
```

### Service Configuration Access

```typescript
const registry = getPortRegistry();

// Get full service configuration
const config = registry.getServiceConfig(PORTS.GRAPHRAG_HTTP);
console.log('Service:', config.description);
console.log('Docker port:', config.docker?.host_port);
console.log('Kubernetes port:', config.kubernetes?.port);
console.log('Health check:', config.health_check);
console.log('Status:', config.status);

// List all services
const allServices = registry.getAllServices();
console.log('Available services:', allServices);
```

## Docker Compose Integration

Update your `docker-compose.yml`:

```yaml
services:
  my-service:
    ports:
      - "${MY_SERVICE_PORT:-9134}:8080"  # Use port from registry
```

Set environment variables:

```bash
export MY_SERVICE_PORT=9134  # From .port-registry.yaml
```

## Kubernetes Integration

The registry includes Kubernetes-specific configuration:

```typescript
const config = registry.getServiceConfig(PORTS.GRAPHRAG_HTTP);
const k8sConfig = config.kubernetes;

// Use in Kubernetes manifests
console.log(`Service name: ${k8sConfig.service_name}`);
console.log(`Port: ${k8sConfig.port}`);
console.log(`Target port: ${k8sConfig.target_port}`);
console.log(`Service type: ${k8sConfig.type}`);
```

## Istio Integration

For services with Istio enabled:

```typescript
const config = registry.getServiceConfig(PORTS.GRAPHRAG_HTTP);
if (config.istio?.enabled) {
  console.log(`Virtual Service: ${config.istio.virtual_service}`);
  console.log(`Gateway: ${config.istio.gateway}`);
  console.log(`Host: ${config.istio.host}`);
  console.log(`WebSocket: ${config.istio.websocket}`);
}
```

## Migration Guide

### From Hardcoded Ports

**Before:**
```typescript
const GRAPHRAG_PORT = 9090;
const url = `http://localhost:${GRAPHRAG_PORT}`;
```

**After:**
```typescript
import { getPortRegistry, PORTS } from '@adverant/config';

const registry = getPortRegistry();
const url = registry.getServiceUrl(PORTS.GRAPHRAG_HTTP, 'http');
```

### From Environment Variables

**Before:**
```typescript
const port = process.env.GRAPHRAG_PORT || 9090;
```

**After:**
```typescript
import { getPortRegistry, PORTS } from '@adverant/config';

const registry = getPortRegistry();
const port = registry.getPort(PORTS.GRAPHRAG_HTTP);
```

## Best Practices

1. **Always use the registry** - Never hardcode ports in service code
2. **Validate in CI/CD** - Add `npm run validate:ports` to your pipeline
3. **Document reassignments** - Update migration tracking when changing ports
4. **Use type-safe constants** - Use `PORTS.*` instead of string literals
5. **Check conflicts** - Run validation before adding new services
6. **Update all references** - When changing ports, update Docker, K8s, and configs

## Troubleshooting

### Port Conflict Detected

```
✗ ERROR: Docker host port 9100 is used by multiple services: service-a, service-b
```

**Solution**: Use `findAvailablePort()` to get next available port and reassign one service.

### Service Not Found

```
Error: Service 'my-service' not found in port registry
```

**Solution**: Ensure the service is defined in `.port-registry.yaml` and matches the `PORTS` constant.

### Environment Detection Issues

If the wrong environment is detected, manually override:

```typescript
const registry = new PortRegistryManager(undefined, 'docker');
```

## File Structure

```
Adverant-Nexus/
├── .port-registry.yaml              # Port definitions (YAML)
└── packages/adverant-config/
    ├── src/
    │   ├── port-registry.ts         # Port registry manager
    │   ├── cli/
    │   │   └── validate-ports.ts    # CLI validation tool
    │   └── validators/
    │       └── port-conflict-validator.ts  # Validation logic
    └── PORT_REGISTRY.md             # This file
```

## Support

For issues or questions:
- Check validation output: `npm run validate:ports`
- Review `.port-registry.yaml` for conflicts
- Consult CLAUDE.md for infrastructure guidelines
