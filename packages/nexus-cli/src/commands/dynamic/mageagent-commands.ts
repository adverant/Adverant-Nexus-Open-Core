/**
 * MageAgent Service Commands
 */

import type { Command, CommandHandler } from '../../types/command.js';
import { createHTTPClient } from '../../core/transport/http-client.js';

export const orchestrateHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('mageagent');
  if (!service) {
    return { success: false, error: 'MageAgent service not found' };
  }

  const client = createHTTPClient({ baseUrl: service.apiUrl });
  const task = args.task as string;
  const maxAgents = args['max-agents'] as number | undefined;

  if (!task) {
    return { success: false, error: '--task is required' };
  }

  try {
    const response = await client.post('/orchestrate', {
      task,
      maxAgents: maxAgents || 3,
      timeout: 60000,
    });

    return {
      success: true,
      data: response,
      message: 'Orchestration completed',
    };
  } catch (error: any) {
    return { success: false, error: error.message || 'Orchestration failed' };
  }
};

export const analyzeHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('mageagent');
  if (!service) {
    return { success: false, error: 'MageAgent service not found' };
  }

  const client = createHTTPClient({ baseUrl: service.apiUrl });
  const input = args.input as string;
  const focus = args.focus as string[] | undefined;

  if (!input) {
    return { success: false, error: '--input is required' };
  }

  try {
    const response = await client.post('/analyze', {
      input,
      focusAreas: focus || ['security', 'performance'],
    });

    return {
      success: true,
      data: response,
      message: 'Analysis completed',
    };
  } catch (error: any) {
    return { success: false, error: error.message || 'Analysis failed' };
  }
};

export const mageagentCommands: Command[] = [
  {
    name: 'orchestrate',
    namespace: 'mageagent',
    description: 'Run multi-agent orchestration',
    handler: orchestrateHandler,
    options: [
      { long: 'task', description: 'Task description', type: 'string', required: true },
      { long: 'max-agents', description: 'Maximum number of agents', type: 'number', default: 3 },
    ],
    examples: ['nexus mageagent orchestrate --task "Analyze codebase for security issues"'],
    usage: 'nexus mageagent orchestrate --task <description> [--max-agents N]',
    category: 'mageagent',
  },
  {
    name: 'analyze',
    namespace: 'mageagent',
    description: 'Analyze code or data',
    handler: analyzeHandler,
    options: [
      { long: 'input', description: 'Input file or code', type: 'string', required: true },
      { long: 'focus', description: 'Focus areas (comma-separated)', type: 'array' },
    ],
    examples: ['nexus mageagent analyze --input code.ts --focus security,performance'],
    usage: 'nexus mageagent analyze --input <file> [--focus <areas>]',
    category: 'mageagent',
  },
];
