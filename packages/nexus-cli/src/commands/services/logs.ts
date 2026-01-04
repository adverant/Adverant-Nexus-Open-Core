/**
 * Service Logs Command
 */

import { spawn } from 'child_process';
import type { Command, CommandHandler } from '../../types/command.js';

export const logsHandler: CommandHandler = async (args, context) => {
  const { services } = context;
  const serviceName = args._[0] as string;

  if (!serviceName) {
    return {
      success: false,
      error: 'Service name is required',
    };
  }

  const service = services.get(serviceName);
  if (!service) {
    return {
      success: false,
      error: `Service '${serviceName}' not found`,
    };
  }

  const follow = args.follow || args.f || false;
  const lines = args.lines || args.n || 100;
  const timestamps = args.timestamps || args.t || false;

  const dockerArgs = ['logs'];
  
  if (follow) {
    dockerArgs.push('--follow');
  }
  
  if (lines) {
    dockerArgs.push('--tail', String(lines));
  }
  
  if (timestamps) {
    dockerArgs.push('--timestamps');
  }
  
  dockerArgs.push(service.container);

  try {
    const child = spawn('docker', dockerArgs, {
      stdio: 'inherit',
    });

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          resolve(undefined);
        } else {
          reject(new Error(`docker logs exited with code ${code}`));
        }
      });
      child.on('error', reject);
    });

    return {
      success: true,
      message: `Logs for ${service.name}`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to get logs',
    };
  }
};

export const logsCommand: Command = {
  name: 'logs',
  namespace: 'services',
  description: 'View service logs',
  handler: logsHandler,
  args: [
    {
      name: 'service',
      description: 'Service name',
      required: true,
      type: 'string',
    },
  ],
  options: [
    {
      short: 'f',
      long: 'follow',
      description: 'Follow log output',
      type: 'boolean',
      default: false,
    },
    {
      short: 'n',
      long: 'lines',
      description: 'Number of lines to show from the end',
      type: 'number',
      default: 100,
    },
    {
      short: 't',
      long: 'timestamps',
      description: 'Show timestamps',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    'nexus services logs graphrag',
    'nexus services logs graphrag --follow',
    'nexus services logs graphrag -f -n 50',
    'nexus services logs mageagent --timestamps',
  ],
  usage: 'nexus services logs <service> [--follow] [--lines N]',
  category: 'service-management',
};
