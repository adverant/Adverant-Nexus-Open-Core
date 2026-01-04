/**
 * Service Start Command
 */

import { execSync } from 'child_process';
import type { Command, CommandHandler } from '../../types/command.js';

export const startHandler: CommandHandler = async (args, context) => {
  const { services } = context;
  const serviceName = args._[0] as string | undefined;

  try {
    if (serviceName) {
      const service = services.get(serviceName);
      if (!service) {
        return {
          success: false,
          error: `Service '${serviceName}' not found`,
        };
      }

      execSync(`docker start ${service.container}`, {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      return {
        success: true,
        message: `Started service: ${service.name}`,
        data: { service: service.name, container: service.container },
      };
    } else {
      // Start all services via docker-compose
      execSync('docker-compose -f docker/docker-compose.nexus.yml up -d', {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      return {
        success: true,
        message: 'Started all services',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to start service(s)',
    };
  }
};

export const startCommand: Command = {
  name: 'start',
  namespace: 'services',
  description: 'Start service(s)',
  handler: startHandler,
  args: [
    {
      name: 'service',
      description: 'Service name (optional, starts all if omitted)',
      required: false,
      type: 'string',
    },
  ],
  examples: [
    'nexus services start',
    'nexus services start graphrag',
    'nexus services start mageagent',
  ],
  usage: 'nexus services start [service]',
  category: 'service-management',
};
