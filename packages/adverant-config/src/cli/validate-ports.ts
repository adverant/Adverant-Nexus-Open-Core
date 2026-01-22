#!/usr/bin/env node
/**
 * Port Registry Validation CLI
 *
 * Validates the port registry for conflicts and issues.
 * Can be run manually or as part of CI/CD pipeline.
 *
 * Usage:
 *   npx ts-node src/cli/validate-ports.ts
 *   npm run validate:ports
 *
 * Exit codes:
 *   0 - Success (no conflicts)
 *   1 - Validation failed (conflicts found)
 *   2 - Error loading registry
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { PortRegistry } from '../port-registry';
import {
  validatePortRegistry,
  formatValidationResult,
  getPortStatistics
} from '../validators/port-conflict-validator';

function main(): void {
  console.log('='.repeat(80));
  console.log('PORT REGISTRY VALIDATION');
  console.log('='.repeat(80));
  console.log('');

  // Load port registry
  const registryPath = join(__dirname, '../../../../.port-registry.yaml');
  let registry: PortRegistry;

  try {
    console.log(`Loading port registry from: ${registryPath}`);
    const content = readFileSync(registryPath, 'utf8');
    registry = parseYaml(content) as PortRegistry;
    console.log(`✓ Registry loaded successfully`);
    console.log(`  Version: ${registry.metadata.version}`);
    console.log(`  Last Updated: ${registry.metadata.last_updated}`);
    console.log(`  Managed By: ${registry.metadata.managed_by}`);
    console.log('');
  } catch (error) {
    console.error(`✗ Failed to load port registry: ${error}`);
    process.exit(2);
  }

  // Validate registry
  console.log('Running validation...');
  console.log('');

  const result = validatePortRegistry(registry);
  const formattedResult = formatValidationResult(result);
  console.log(formattedResult);

  // Display statistics
  console.log('PORT ALLOCATION STATISTICS:');
  console.log('');

  const stats = getPortStatistics(registry);
  console.log(`  Port Range: ${stats.total_range.min} - ${stats.total_range.max}`);
  console.log(`  Used Ports: ${stats.used_count}`);
  console.log(`  Available Ports: ${stats.available_count}`);
  console.log(`  Utilization: ${stats.utilization_percent}%`);
  console.log('');

  if (stats.port_gaps.length > 0) {
    console.log('  Largest Port Gaps:');
    const topGaps = stats.port_gaps.slice(0, 5);
    for (const gap of topGaps) {
      console.log(`    ${gap.start}-${gap.end} (${gap.size} ports available)`);
    }
    console.log('');
  }

  // Migration tracking
  if (registry.migration?.port_reassignments_applied) {
    console.log('PORT REASSIGNMENTS APPLIED:');
    console.log('');
    for (const reassignment of registry.migration.port_reassignments_applied) {
      console.log(`  ${reassignment.service}:`);
      console.log(`    ${reassignment.old_port} → ${reassignment.new_port}`);
      console.log(`    Reason: ${reassignment.reason}`);
      console.log('');
    }
  }

  // Exit with appropriate code
  if (!result.valid) {
    console.error('✗ VALIDATION FAILED - Port conflicts detected!');
    console.error('  Please fix the conflicts listed above.');
    process.exit(1);
  }

  if (result.warnings.length > 0) {
    console.warn('⚠ VALIDATION PASSED WITH WARNINGS');
    console.warn('  Consider addressing the warnings listed above.');
    process.exit(0);
  }

  console.log('✓ VALIDATION PASSED - No conflicts detected!');
  process.exit(0);
}

// Run if executed directly
if (require.main === module) {
  main();
}
