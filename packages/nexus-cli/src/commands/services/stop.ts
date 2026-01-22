/**
 * Service Stop Command
 */

import { execSync } from 'child_process';
import type { Command, CommandHandler } from '../../types/command.js';

export const stopHandler: CommandHandler = async (args, context) => {
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

      execSync(`docker stop ${service.container}`, {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      return {
        success: true,
        message: `Stopped service: ${service.name}`,
        data: { service: service.name, container: service.container },
      };
    } else {
      // Stop all services via docker-compose (but don't remove)
      execSync('docker-compose -f docker/docker-compose.nexus.yml stop', {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      return {
        success: true,
        message: 'Stopped all services',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to stop service(s)',
    };
  }
};

export const stopCommand: Command = {
  name: 'stop',
  namespace: 'services',
  description: 'Stop service(s)',
  handler: stopHandler,
  args: [
    {
      name: 'service',
      description: 'Service name (optional, stops all if omitted)',
      required: false,
      type: 'string',
    },
  ],
  examples: [
    'nexus services stop',
    'nexus services stop graphrag',
    'nexus services stop mageagent',
  ],
  usage: 'nexus services stop [service]',
  category: 'service-management',
};
