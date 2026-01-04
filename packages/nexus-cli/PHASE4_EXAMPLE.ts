/**
 * Phase 4 Integration Example
 *
 * Example showing how to integrate all Phase 4 components
 */

import { createCommandRegistry, createCommandRouter } from './core/router/index.js';
import { createServiceDiscovery } from './core/discovery/index.js';
import { createHTTPClient } from './core/transport/index.js';

// Import all commands
import {
  listCommand,
  statusCommand,
  healthCommand,
  infoCommand,
  logsCommand,
  startCommand,
  stopCommand,
  restartCommand,
  portsCommand,
} from './commands/services/index.js';

import { allDynamicCommands } from './commands/dynamic/index.js';

import type { CommandContext } from './types/command.js';

/**
 * Initialize the CLI with all Phase 4 components
 */
async function initializeCLI() {
  // 1. Create service discovery
  const discovery = createServiceDiscovery();
  const services = await discovery.discover();

  console.log(`Discovered ${services.size} services`);

  // 2. Create command registry
  const registry = createCommandRegistry();

  // 3. Register service management commands
  registry.register(listCommand);
  registry.register(statusCommand);
  registry.register(healthCommand);
  registry.register(infoCommand);
  registry.register(logsCommand);
  registry.register(startCommand);
  registry.register(stopCommand);
  registry.register(restartCommand);
  registry.register(portsCommand);

  // 4. Register dynamic service commands (GraphRAG, MageAgent, Sandbox)
  registry.registerMany(allDynamicCommands);

  console.log(`Registered ${registry.list().length} commands`);

  // 5. Create command router
  const router = createCommandRouter(registry);

  // 6. Create HTTP transport for API communication
  const transport = createHTTPClient({
    baseUrl: 'http://localhost:9092',
    timeout: 30000,
    retries: 3,
  });

  return { router, services, transport, discovery };
}

/**
 * Execute a command
 */
async function executeCommand(
  router: any,
  commandName: string,
  args: any,
  services: any,
  transport: any
) {
  const context: CommandContext = {
    cwd: process.cwd(),
    config: {},
    services,
    verbose: false,
    quiet: false,
    outputFormat: 'json',
    transport,
  };

  const result = await router.route(commandName, args, context);

  if (result.success) {
    console.log('Success:', result.message);
    console.log('Data:', JSON.stringify(result.data, null, 2));
  } else {
    console.error('Error:', result.error);
  }

  return result;
}

/**
 * Example usage
 */
async function main() {
  const { router, services, transport, discovery } = await initializeCLI();

  // Example 1: List all services
  console.log('\n=== Example 1: List Services ===');
  await executeCommand(router, 'services:list', { _: [] }, services, transport);

  // Example 2: Check GraphRAG health
  console.log('\n=== Example 2: Check GraphRAG Health ===');
  await executeCommand(router, 'graphrag:health', { _: [], detailed: true }, services, transport);

  // Example 3: Query GraphRAG
  console.log('\n=== Example 3: Query GraphRAG ===');
  await executeCommand(
    router,
    'graphrag:query',
    { _: [], text: 'user authentication', limit: 5 },
    services,
    transport
  );

  // Example 4: MageAgent orchestration
  console.log('\n=== Example 4: MageAgent Orchestration ===');
  await executeCommand(
    router,
    'mageagent:orchestrate',
    { _: [], task: 'Analyze security vulnerabilities', 'max-agents': 3 },
    services,
    transport
  );

  // Example 5: Execute code in sandbox
  console.log('\n=== Example 5: Sandbox Execution ===');
  await executeCommand(
    router,
    'sandbox:execute',
    { _: [], code: 'print("Hello from Nexus CLI")', language: 'python' },
    services,
    transport
  );

  // Example 6: Get service info
  console.log('\n=== Example 6: Service Info ===');
  await executeCommand(router, 'services:info', { _: ['graphrag'] }, services, transport);
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { initializeCLI, executeCommand };
