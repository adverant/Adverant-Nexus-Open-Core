/**
 * Service Restart Command
 */

import { execSync } from 'child_process';
import type { Command, CommandHandler } from '../../types/command.js';

export const restartHandler: CommandHandler = async (args, context) => {
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

      execSync(`docker restart ${service.container}`, {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      return {
        success: true,
        message: `Restarted service: ${service.name}`,
        data: { service: service.name, container: service.container },
      };
    } else {
      // Restart all services via docker-compose
      execSync('docker-compose -f docker/docker-compose.nexus.yml restart', {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      return {
        success: true,
        message: 'Restarted all services',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to restart service(s)',
    };
  }
};

export const restartCommand: Command = {
  name: 'restart',
  namespace: 'services',
  description: 'Restart service(s)',
  handler: restartHandler,
  args: [
    {
      name: 'service',
      description: 'Service name (optional, restarts all if omitted)',
      required: false,
      type: 'string',
    },
  ],
  examples: [
    'nexus services restart',
    'nexus services restart graphrag',
    'nexus services restart mageagent',
  ],
  usage: 'nexus services restart [service]',
  category: 'service-management',
};
