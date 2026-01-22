/**
 * Service Health Command
 */

import type { Command, CommandHandler } from '../../types/command.js';
import { getServiceHealth } from '../../core/discovery/service-discovery.js';

export const healthHandler: CommandHandler = async (args, context) => {
  const { services } = context;
  const serviceName = args._[0] as string | undefined;
  const checkAll = args.all || !serviceName;

  if (serviceName && !checkAll) {
    const service = services.get(serviceName);
    if (!service) {
      return {
        success: false,
        error: `Service '${serviceName}' not found`,
      };
    }

    const health = await getServiceHealth(service);
    return {
      success: health.healthy,
      data: {
        service: service.name,
        ...health,
      },
      message: health.message,
    };
  } else {
    const healthChecks = await Promise.all(
      Array.from(services.values()).map(async (service) => {
        const health = await getServiceHealth(service);
        return {
          service: service.name,
          ...health,
        };
      })
    );

    const allHealthy = healthChecks.every((h) => h.healthy);
    const healthyCount = healthChecks.filter((h) => h.healthy).length;

    return {
      success: allHealthy,
      data: healthChecks,
      message: `${healthyCount}/${healthChecks.length} services healthy`,
    };
  }
};

export const healthCommand: Command = {
  name: 'health',
  namespace: 'services',
  description: 'Check service health',
  handler: healthHandler,
  args: [
    {
      name: 'service',
      description: 'Service name (optional)',
      required: false,
      type: 'string',
    },
  ],
  options: [
    {
      long: 'all',
      description: 'Check all services',
      type: 'boolean',
      default: false,
    },
  ],
  examples: [
    'nexus services health',
    'nexus services health --all',
    'nexus services health graphrag',
  ],
  usage: 'nexus services health [service] [--all]',
  category: 'service-management',
};
