/**
 * Example: Using the Nexus REPL
 *
 * This example shows how to integrate and start the REPL mode
 */

import { REPL } from '../src/repl/index.js';
import type { Command } from '../src/types/command.js';
import type { NexusConfig } from '../src/types/config.js';

// Example: Start REPL with discovered services and commands

async function startREPL() {
  // Mock service discovery (in real implementation, this comes from service-discovery.ts)
  const services = new Map([
    ['graphrag', { name: 'graphrag', port: 9090, healthy: true }],
    ['mageagent', { name: 'mageagent', port: 9080, healthy: true }],
    ['sandbox', { name: 'sandbox', port: 9070, healthy: true }],
  ]);

  // Mock commands (in real implementation, these are auto-generated from OpenAPI/MCP)
  const commands = new Map<string, Command[]>([
    [
      'graphrag',
      [
        {
          name: 'store-document',
          description: 'Store a document in GraphRAG',
          handler: async (args, ctx) => {
            return {
              success: true,
              message: 'Document stored successfully',
              data: { id: 'doc_123' },
            };
          },
          args: [
            {
              name: 'file',
              description: 'File path to store',
              required: true,
              type: 'file',
            },
          ],
          options: [
            {
              long: 'title',
              description: 'Document title',
              type: 'string',
            },
          ],
        },
        {
          name: 'query',
          description: 'Query GraphRAG',
          handler: async (args, ctx) => {
            return {
              success: true,
              data: {
                results: [
                  { id: 1, title: 'Result 1', score: 0.95 },
                  { id: 2, title: 'Result 2', score: 0.87 },
                ],
              },
            };
          },
          options: [
            {
              long: 'text',
              description: 'Query text',
              required: true,
              type: 'string',
            },
            {
              long: 'limit',
              description: 'Result limit',
              type: 'number',
              default: 10,
            },
          ],
        },
      ],
    ],
    [
      'mageagent',
      [
        {
          name: 'orchestrate',
          description: 'Orchestrate multi-agent task',
          handler: async (args, ctx) => {
            return {
              success: true,
              message: 'Task orchestration started',
              data: { taskId: 'task_456', agents: 3 },
            };
          },
          options: [
            {
              long: 'task',
              description: 'Task description',
              required: true,
              type: 'string',
            },
            {
              long: 'max-agents',
              description: 'Maximum agents',
              type: 'number',
              default: 5,
            },
          ],
        },
      ],
    ],
  ]);

  // Configuration
  const config: NexusConfig = {
    defaults: {
      outputFormat: 'text',
      verbose: false,
    },
    services: {
      apiUrl: 'http://localhost:9092',
    },
  };

  // Create and start REPL
  const repl = new REPL({
    workspace: {
      root: process.cwd(),
      type: 'typescript',
      git: true,
      dockerCompose: ['docker-compose.yml'],
    },
    config,
    services,
    commands,
    version: '2.0.0',
  });

  await repl.start();
}

// Example REPL session:
/*
┌──────────────────────────────────────────────┐
│                                              │
│                 NEXUS CLI                    │
│                                              │
│            Version: 2.0.0                    │
│         Services: 3 discovered               │
│                                              │
│    Type help for available commands          │
│         Type exit to quit                    │
│                                              │
└──────────────────────────────────────────────┘

nexus > help

Built-in Commands:
  help        - Show this help
  services    - List discovered services
  use <name>  - Switch to service namespace
  history     - Show command history
  clear       - Clear screen
  save <name> - Save current session
  load <name> - Load saved session
  sessions    - List saved sessions
  config      - Show configuration
  exit        - Exit REPL

Available Namespaces:
  graphrag (2 commands)
  mageagent (1 commands)

nexus > services
┌───────────┬──────────┐
│ name      │ commands │
├───────────┼──────────┤
│ graphrag  │ 2        │
│ mageagent │ 1        │
└───────────┴──────────┘

nexus > use graphrag
✔ Switched to namespace: graphrag

nexus:graphrag > help

Commands in graphrag:
  store-document - Store a document in GraphRAG
  query - Query GraphRAG

nexus:graphrag > query --text "user authentication" --limit 5
results:
  [0]
    id: 1
    title: Result 1
    score: 0.95
  [1]
    id: 2
    title: Result 2
    score: 0.87

nexus:graphrag > history
┌───┬────────────────────────────────────┬──────────────────────────┬─────────┬──────────┐
│ # │ command                             │ timestamp                │ success │ duration │
├───┼────────────────────────────────────┼──────────────────────────┼─────────┼──────────┤
│ 4 │ query --text "..." --limit 5       │ 2025-11-14T10:15:30.000Z │ ✔       │ 45ms     │
│ 3 │ help                                │ 2025-11-14T10:15:20.000Z │ ✔       │ 2ms      │
│ 2 │ use graphrag                        │ 2025-11-14T10:15:10.000Z │ ✔       │ 1ms      │
│ 1 │ services                            │ 2025-11-14T10:15:00.000Z │ ✔       │ 3ms      │
└───┴────────────────────────────────────┴──────────────────────────┴─────────┴──────────┘

nexus:graphrag > save my-work
✔ Session saved: my-work

nexus:graphrag > config
namespace: graphrag
workspace: typescript
outputFormat: text
verbose: false
commandCount: 6
sessionDuration: 45s

nexus:graphrag > exit
✔ Goodbye!

Goodbye!
*/

// Start the REPL
if (import.meta.url === `file://${process.argv[1]}`) {
  startREPL().catch(console.error);
}
