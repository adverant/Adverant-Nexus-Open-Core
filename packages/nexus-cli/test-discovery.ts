#!/usr/bin/env tsx

/**
 * Test Service Discovery
 *
 * Simple script to test the service discovery engine
 */

import { refreshDiscovery } from './src/core/discovery/index.js';

async function testDiscovery() {
  console.log('Testing Service Discovery Engine\n');
  console.log('='.repeat(80));
  console.log();

  try {
    // Run discovery with all features enabled
    const result = await refreshDiscovery({
      composeFiles: ['/home/user/Adverant-Nexus/docker/docker-compose.unified-nexus.yml'],
      skipHealthCheck: true, // Skip health checks to avoid network errors
      skipOpenAPI: true,     // Skip OpenAPI discovery for now
      skipMCP: true,         // Skip MCP discovery for now
      skipPlugins: true      // Skip plugin discovery for now
    });

    console.log('\n' + '='.repeat(80));
    console.log('Discovery Summary');
    console.log('='.repeat(80));
    console.log();

    console.log(`Services discovered: ${result.services.size}`);
    console.log(`Commands discovered: ${Array.from(result.commands.values()).reduce((sum, cmds) => sum + cmds.length, 0)}`);
    console.log(`Nexus tools: ${result.nexusCommands.length}`);
    console.log(`Plugins: ${result.plugins.length}`);
    console.log();

    console.log('='.repeat(80));
    console.log('Discovered Services');
    console.log('='.repeat(80));
    console.log();

    for (const [name, service] of result.services) {
      console.log(`📦 ${service.displayName} (${name})`);
      console.log(`   Description: ${service.description}`);
      console.log(`   Container: ${service.container}`);
      console.log(`   API URL: ${service.apiUrl || 'N/A'}`);

      if (service.ports.length > 0) {
        console.log(`   Ports: ${service.ports.map(p => `${p.host}:${p.container}`).join(', ')}`);
      }

      if (service.dependencies.length > 0) {
        console.log(`   Dependencies: ${service.dependencies.join(', ')}`);
      }

      if (service.capabilities.length > 0) {
        console.log(`   Capabilities: ${service.capabilities.map(c => c.type).join(', ')}`);
      }

      console.log();
    }

    console.log('='.repeat(80));
    console.log('✅ Discovery test complete!');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n❌ Discovery test failed:', error);
    process.exit(1);
  }
}

testDiscovery();
