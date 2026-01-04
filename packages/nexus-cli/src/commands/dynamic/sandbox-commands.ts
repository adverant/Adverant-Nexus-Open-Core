/**
 * Sandbox Service Commands
 */

import type { Command, CommandHandler } from '../../types/command.js';
import { createHTTPClient } from '../../core/transport/http-client.js';

export const executeHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('sandbox');
  if (!service) {
    return { success: false, error: 'Sandbox service not found' };
  }

  const client = createHTTPClient({ baseUrl: service.apiUrl });
  const code = args.code as string | undefined;
  const file = args.file as string | undefined;
  const language = args.language as string;

  if (!code && !file) {
    return { success: false, error: '--code or --file is required' };
  }

  try {
    const response = await client.post('/execute', {
      code: code || file,
      language: language || 'python',
      stream: args.stream || false,
    });

    return {
      success: true,
      data: response,
      message: 'Execution completed',
    };
  } catch (error: any) {
    return { success: false, error: error.message || 'Execution failed' };
  }
};

export const listLanguagesHandler: CommandHandler = async (args, context) => {
  const service = context.services.get('sandbox');
  if (!service) {
    return { success: false, error: 'Sandbox service not found' };
  }

  const client = createHTTPClient({ baseUrl: service.apiUrl });

  try {
    const response = await client.get('/languages');
    return {
      success: true,
      data: response,
      message: 'Available languages',
    };
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to list languages' };
  }
};

export const sandboxCommands: Command[] = [
  {
    name: 'execute',
    namespace: 'sandbox',
    description: 'Execute code in sandbox',
    handler: executeHandler,
    options: [
      { long: 'code', description: 'Code to execute', type: 'string' },
      { long: 'file', description: 'File to execute', type: 'file' },
      { long: 'language', description: 'Language', type: 'string', default: 'python' },
      { long: 'stream', description: 'Stream output', type: 'boolean', default: false },
    ],
    examples: [
      'nexus sandbox execute --code "print(1+1)" --language python',
      'nexus sandbox execute --file script.py',
    ],
    usage: 'nexus sandbox execute --code <code> --language <lang>',
    category: 'sandbox',
  },
  {
    name: 'list-languages',
    namespace: 'sandbox',
    description: 'List supported languages',
    handler: listLanguagesHandler,
    examples: ['nexus sandbox list-languages'],
    usage: 'nexus sandbox list-languages',
    category: 'sandbox',
  },
];
