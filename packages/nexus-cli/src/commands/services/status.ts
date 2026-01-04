/**
 * Service Status Command
 *
 * Shows detailed status of a specific service or all services
 */

import { execSync } from 'child_process';
import type { Command, CommandHandler } from '../../types/command.js';

export const statusHandler: CommandHandler = async (args, context) => {
  const { services } = context;
  const serviceName = args._[0] as string | undefined;

  if (serviceName) {
    // Show status for specific service
    const service = services.get(serviceName);
    if (!service) {
      return {
        success: false,
        error: `Service '${serviceName}' not found`,
      };
    }

    const containerStatus = await getContainerStatus(service.container);
    return {
      success: true,
      data: {
        name: service.name,
        displayName: service.displayName,
        container: service.container,
        status: service.status,
        ...containerStatus,
        ports: service.ports,
        apiUrl: service.apiUrl,
        healthEndpoint: service.healthEndpoint,
        dependencies: service.dependencies,
      },
    };
  } else {
    // Show status for all services
    const statusList = await Promise.all(
      Array.from(services.values()).map(async (service) => {
        const containerStatus = await getContainerStatus(service.container);
        return {
          name: service.name,
          displayName: service.displayName,
          container: service.container,
          status: service.status,
          uptime: containerStatus.uptime,
          health: containerStatus.health,
        };
      })
    );

    return {
      success: true,
      data: statusList,
      message: `Status for ${statusList.length} services`,
    };
  }
};

async function getContainerStatus(containerName: string): Promise<any> {
  try {
    const inspect = execSync(
      `docker inspect ${containerName} --format '{{json .}}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );

    const data = JSON.parse(inspect);
    const state = data.State || {};

    return {
      running: state.Running || false,
      status: state.Status || 'unknown',
      health: state.Health?.Status || 'none',
      startedAt: state.StartedAt,
      finishedAt: state.FinishedAt,
      exitCode: state.ExitCode,
      pid: state.Pid,
      uptime: state.Running ? calculateUptime(state.StartedAt) : null,
    };
  } catch (error) {
    return {
      running: false,
      status: 'not-found',
      error: 'Container not found or not accessible',
    };
  }
}

function calculateUptime(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const diff = now.getTime() - start.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const remainingHours = hours - (days * 24);
  const remainingMinutes = minutes - (hours * 60);
  const remainingSeconds = seconds - (minutes * 60);

  if (days > 0) return `${days}d ${remainingHours}h`;
  if (hours > 0) return `${hours}h ${remainingMinutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${seconds}s`;
}

export const statusCommand: Command = {
  name: 'status',
  namespace: 'services',
  description: 'Show service status',
  handler: statusHandler,
  args: [
    {
      name: 'service',
      description: 'Service name (optional, shows all if omitted)',
      required: false,
      type: 'string',
    },
  ],
  examples: [
    'nexus services status',
    'nexus services status graphrag',
    'nexus services status mageagent --output-format json',
  ],
  usage: 'nexus services status [service]',
  category: 'service-management',
};
