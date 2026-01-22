/**
 * Port Conflict Validator - Compile-time Port Conflict Detection
 *
 * This validator ensures no port conflicts exist in the port registry.
 * It runs at module load time and throws detailed errors if conflicts are detected.
 *
 * @module port-conflict-validator
 */

import { PortRegistry, ServicePortConfig } from '../port-registry';

export interface PortConflict {
  port: number;
  services: string[];
  environment: 'docker' | 'kubernetes';
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  conflicts: PortConflict[];
  warnings: string[];
  summary: {
    total_services: number;
    total_ports_used: number;
    docker_ports: number;
    kubernetes_ports: number;
    conflicts_found: number;
    warnings_found: number;
  };
}

/**
 * Validates port registry for conflicts and issues
 */
export function validatePortRegistry(registry: PortRegistry): ValidationResult {
  const conflicts: PortConflict[] = [];
  const warnings: string[] = [];

  // Track port usage by environment
  const dockerPorts = new Map<number, string[]>();
  const kubernetesPorts = new Map<number, string[]>();

  // Collect all port allocations
  for (const [serviceName, config] of Object.entries(registry.services)) {
    // Validate Docker ports
    if (config.docker) {
      const hostPort = config.docker.host_port;
      if (!dockerPorts.has(hostPort)) {
        dockerPorts.set(hostPort, []);
      }
      dockerPorts.get(hostPort)!.push(serviceName);
    }

    // Validate Kubernetes ports
    if (config.kubernetes) {
      const servicePort = config.kubernetes.port;
      if (!kubernetesPorts.has(servicePort)) {
        kubernetesPorts.set(servicePort, []);
      }
      kubernetesPorts.get(servicePort)!.push(serviceName);
    }

    // Validate service configuration
    validateServiceConfig(serviceName, config, warnings);
  }

  // Check for Docker port conflicts
  for (const [port, services] of dockerPorts.entries()) {
    if (services.length > 1) {
      conflicts.push({
        port,
        services,
        environment: 'docker',
        severity: 'error',
        message: `Docker host port ${port} is used by multiple services: ${services.join(', ')}`
      });
    }
  }

  // Check for Kubernetes port conflicts (less critical, but worth noting)
  for (const [port, services] of kubernetesPorts.entries()) {
    if (services.length > 1) {
      // In Kubernetes, different services can use the same port (they're namespaced)
      // But it's still worth warning about for clarity
      warnings.push(`Kubernetes port ${port} is used by multiple services: ${services.join(', ')} (This is allowed in K8s but may cause confusion)`);
    }
  }

  // Validate port allocation tracking
  validatePortAllocationTracking(registry, dockerPorts, kubernetesPorts, warnings);

  // Generate summary
  const summary = {
    total_services: Object.keys(registry.services).length,
    total_ports_used: registry.port_allocation.used_ports.length,
    docker_ports: dockerPorts.size,
    kubernetes_ports: kubernetesPorts.size,
    conflicts_found: conflicts.length,
    warnings_found: warnings.length
  };

  return {
    valid: conflicts.length === 0,
    conflicts,
    warnings,
    summary
  };
}

/**
 * Validate individual service configuration
 */
function validateServiceConfig(
  serviceName: string,
  config: ServicePortConfig,
  warnings: string[]
): void {
  // Check if service has at least one port configuration
  if (!config.docker && !config.kubernetes) {
    warnings.push(`Service '${serviceName}' has no port configuration (neither Docker nor Kubernetes)`);
  }

  // Check for missing health check
  if (config.status === 'active' && !config.health_check) {
    warnings.push(`Service '${serviceName}' is active but has no health_check defined`);
  }

  // Validate Docker configuration
  if (config.docker) {
    if (config.docker.host_port < 1024) {
      warnings.push(`Service '${serviceName}' uses privileged port ${config.docker.host_port} (< 1024) which may require root privileges`);
    }

    if (config.docker.host_port > 65535 || config.docker.container_port > 65535) {
      warnings.push(`Service '${serviceName}' has invalid port number (must be 1-65535)`);
    }
  }

  // Validate Kubernetes configuration
  if (config.kubernetes) {
    if (!config.kubernetes.service_name) {
      warnings.push(`Service '${serviceName}' has Kubernetes config but no service_name specified`);
    }

    if (config.kubernetes.port > 65535 || config.kubernetes.target_port > 65535) {
      warnings.push(`Service '${serviceName}' has invalid Kubernetes port number (must be 1-65535)`);
    }
  }

  // Check for container name mismatch
  if (config.container_name && !config.container_name.startsWith('nexus-') && !config.container_name.includes('minio') && !config.container_name.includes('geoagent') && !config.container_name.includes('videoagent')) {
    warnings.push(`Service '${serviceName}' container_name '${config.container_name}' doesn't follow naming convention (should start with 'nexus-')`);
  }
}

/**
 * Validate port allocation tracking matches actual usage
 */
function validatePortAllocationTracking(
  registry: PortRegistry,
  dockerPorts: Map<number, string[]>,
  kubernetesPorts: Map<number, string[]>,
  warnings: string[]
): void {
  const trackedPorts = new Set(registry.port_allocation.used_ports);
  const actualDockerPorts = new Set(dockerPorts.keys());

  // Check if all Docker ports are tracked
  for (const port of actualDockerPorts) {
    if (!trackedPorts.has(port)) {
      warnings.push(`Docker port ${port} is used but not listed in port_allocation.used_ports`);
    }
  }

  // Check if tracked ports are actually used
  for (const port of trackedPorts) {
    if (!actualDockerPorts.has(port)) {
      warnings.push(`Port ${port} is listed in port_allocation.used_ports but not actually used by any Docker service`);
    }
  }

  // Validate available ranges don't overlap with used ports
  for (const range of registry.port_allocation.available_ranges) {
    for (let port = range.start; port <= range.end; port++) {
      if (trackedPorts.has(port)) {
        warnings.push(`Port ${port} is in available range '${range.description}' but is actually used`);
        break; // Only warn once per range
      }
    }
  }

  // Validate next_available is actually available
  if (trackedPorts.has(registry.port_allocation.next_available)) {
    warnings.push(`next_available port ${registry.port_allocation.next_available} is already in use`);
  }
}

/**
 * Format validation result as human-readable string
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push('='.repeat(80));
  lines.push('PORT REGISTRY VALIDATION RESULT');
  lines.push('='.repeat(80));
  lines.push('');

  // Summary
  lines.push('SUMMARY:');
  lines.push(`  Total Services: ${result.summary.total_services}`);
  lines.push(`  Docker Ports: ${result.summary.docker_ports}`);
  lines.push(`  Kubernetes Ports: ${result.summary.kubernetes_ports}`);
  lines.push(`  Conflicts: ${result.summary.conflicts_found}`);
  lines.push(`  Warnings: ${result.summary.warnings_found}`);
  lines.push(`  Status: ${result.valid ? '✓ VALID' : '✗ INVALID'}`);
  lines.push('');

  // Conflicts
  if (result.conflicts.length > 0) {
    lines.push('CONFLICTS (MUST FIX):');
    for (const conflict of result.conflicts) {
      lines.push(`  ✗ ${conflict.severity.toUpperCase()}: ${conflict.message}`);
      lines.push(`    Port: ${conflict.port}`);
      lines.push(`    Environment: ${conflict.environment}`);
      lines.push(`    Conflicting services: ${conflict.services.join(', ')}`);
      lines.push('');
    }
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push('WARNINGS (RECOMMENDED TO FIX):');
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
    lines.push('');
  }

  if (result.valid && result.warnings.length === 0) {
    lines.push('✓ No conflicts or warnings found. Port registry is valid!');
    lines.push('');
  }

  lines.push('='.repeat(80));

  return lines.join('\n');
}

/**
 * Throw error if validation fails
 */
export function enforceValidation(registry: PortRegistry): void {
  const result = validatePortRegistry(registry);

  if (!result.valid) {
    const errorMessage = formatValidationResult(result);
    throw new Error(`Port registry validation failed:\n\n${errorMessage}`);
  }

  // Log warnings even if valid
  if (result.warnings.length > 0) {
    console.warn('Port registry validation passed with warnings:');
    for (const warning of result.warnings) {
      console.warn(`  ⚠ ${warning}`);
    }
  }
}

/**
 * Find available port in a given range
 */
export function findAvailablePort(
  registry: PortRegistry,
  minPort: number = 9134,
  maxPort: number = 9199
): number | null {
  const usedPorts = new Set(registry.port_allocation.used_ports);

  for (let port = minPort; port <= maxPort; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }

  return null;
}

/**
 * Get port allocation statistics
 */
export function getPortStatistics(registry: PortRegistry): {
  total_range: { min: number; max: number };
  used_count: number;
  available_count: number;
  utilization_percent: number;
  port_gaps: Array<{ start: number; end: number; size: number }>;
} {
  const usedPorts = registry.port_allocation.used_ports.sort((a, b) => a - b);
  const minPort = Math.min(...usedPorts);
  const maxPort = Math.max(...usedPorts);
  const totalRange = maxPort - minPort + 1;
  const usedCount = usedPorts.length;
  const availableCount = totalRange - usedCount;
  const utilizationPercent = (usedCount / totalRange) * 100;

  // Find gaps in port allocation
  const portGaps: Array<{ start: number; end: number; size: number }> = [];
  for (let i = 0; i < usedPorts.length - 1; i++) {
    const gap = usedPorts[i + 1] - usedPorts[i] - 1;
    if (gap > 0) {
      portGaps.push({
        start: usedPorts[i] + 1,
        end: usedPorts[i + 1] - 1,
        size: gap
      });
    }
  }

  return {
    total_range: { min: minPort, max: maxPort },
    used_count: usedCount,
    available_count: availableCount,
    utilization_percent: parseFloat(utilizationPercent.toFixed(2)),
    port_gaps: portGaps.sort((a, b) => b.size - a.size) // Largest gaps first
  };
}
