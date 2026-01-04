/**
 * List Services Command
 *
 * Lists all discovered services with their status
 */

import type { Command, CommandHandler } from '../../types/command.js';

export const listHandler: CommandHandler = async (args, context) => {
  const { services, outputFormat } = context;

  const serviceList = Array.from(services.values()).map((service) => ({
    name: service.name,
    displayName: service.displayName,
    status: service.status,
    container: service.container,
    ports: service.ports.map((p) => `${p.host}:${p.container}`).join(', '),
    apiUrl: service.apiUrl,
    dependencies: service.dependencies.join(', '),
  }));

  if (serviceList.length === 0) {
    return {
      success: true,
      message: 'No services discovered. Make sure docker-compose files are present.',
      data: [],
    };
  }

  return {
    success: true,
    data: serviceList,
    message: `Found ${serviceList.length} services`,
  };
};

export const listCommand: Command = {
  name: 'list',
  namespace: 'services',
  description: 'List all discovered services',
  handler: listHandler,
  examples: [
    'nexus services list',
    'nexus services list --output-format json',
    'nexus services list --output-format table',
  ],
  usage: 'nexus services list [options]',
  category: 'service-management',
};
