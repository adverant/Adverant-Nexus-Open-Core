/**
 * Service Ports Command
 */

import type { Command, CommandHandler } from '../../types/command.js';

export const portsHandler: CommandHandler = async (args, context) => {
  const { services } = context;
  const serviceName = args._[0] as string | undefined;

  if (serviceName) {
    const service = services.get(serviceName);
    if (!service) {
      return {
        success: false,
        error: `Service '${serviceName}' not found`,
      };
    }

    const portMappings = service.ports.map((port) => ({
      service: service.name,
      host: port.host,
      container: port.container,
      protocol: port.protocol || 'tcp',
      url: `http://localhost:${port.host}`,
    }));

    return {
      success: true,
      data: portMappings,
      message: `Port mappings for ${service.name}`,
    };
  } else {
    const allPorts = Array.from(services.values()).flatMap((service) =>
      service.ports.map((port) => ({
        service: service.name,
        displayName: service.displayName,
        host: port.host,
        container: port.container,
        protocol: port.protocol || 'tcp',
        url: `http://localhost:${port.host}`,
      }))
    );

    return {
      success: true,
      data: allPorts,
      message: `Total ${allPorts.length} port mappings`,
    };
  }
};

export const portsCommand: Command = {
  name: 'ports',
  namespace: 'services',
  description: 'Show service port mappings',
  handler: portsHandler,
  args: [
    {
      name: 'service',
      description: 'Service name (optional, shows all if omitted)',
      required: false,
      type: 'string',
    },
  ],
  examples: [
    'nexus services ports',
    'nexus services ports graphrag',
    'nexus services ports --output-format table',
  ],
  usage: 'nexus services ports [service]',
  category: 'service-management',
};
