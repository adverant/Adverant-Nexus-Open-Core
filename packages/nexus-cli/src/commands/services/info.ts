/**
 * Service Info Command
 */

import type { Command, CommandHandler } from '../../types/command.js';

export const infoHandler: CommandHandler = async (args, context) => {
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

  return {
    success: true,
    data: {
      name: service.name,
      displayName: service.displayName,
      description: service.description,
      version: service.version,
      status: service.status,
      container: service.container,
      ports: service.ports.map((p) => ({
        host: p.host,
        container: p.container,
        protocol: p.protocol || 'tcp',
        url: `http://localhost:${p.host}`,
      })),
      urls: {
        api: service.apiUrl,
        websocket: service.wsUrl,
        health: service.healthEndpoint,
        openapi: service.openApiSpec,
        graphql: service.graphqlSchema,
      },
      capabilities: service.capabilities,
      dependencies: service.dependencies,
      environment: service.environment,
    },
  };
};

export const infoCommand: Command = {
  name: 'info',
  namespace: 'services',
  description: 'Get detailed service information',
  handler: infoHandler,
  args: [
    {
      name: 'service',
      description: 'Service name',
      required: true,
      type: 'string',
    },
  ],
  examples: [
    'nexus services info graphrag',
    'nexus services info mageagent --output-format json',
  ],
  usage: 'nexus services info <service>',
  category: 'service-management',
};
