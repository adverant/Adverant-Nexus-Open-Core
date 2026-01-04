/**
 * Compute List Command
 *
 * List local compute jobs.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../../utils/logger.js';
import { LocalComputeClient } from './lib/local-compute-client.js';

export interface ListOptions {
  status?: string;
  limit?: number;
  json?: boolean;
}

export function createComputeListCommand(): Command {
  const command = new Command('list')
    .alias('ls')
    .description('List local compute jobs')
    .option('-s, --status <status>', 'Filter by status (running, completed, failed, pending)')
    .option('-l, --limit <n>', 'Maximum number of jobs to show', '20')
    .option('--json', 'Output as JSON', false)
    .action(async (options: ListOptions) => {
      const spinner = ora('Fetching jobs...').start();

      try {
        const client = new LocalComputeClient();

        // Check if agent is running first
        if (!(await client.isAgentRunning())) {
          spinner.fail('Local compute agent is not running');
          console.log(chalk.yellow('\n⚠️  Start the agent with: nexus compute agent start'));
          process.exit(1);
        }

        const rawJobs = await client.listJobs({
          status: options.status,
          limit: parseInt(options.limit?.toString() || '20', 10),
        });

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(rawJobs, null, 2));
          return;
        }

        if (rawJobs.length === 0) {
          console.log(chalk.yellow('\n⚠️  No jobs found'));
          console.log(chalk.gray('   Submit a job with: nexus compute submit <script>'));
          return;
        }

        // Transform to display format
        const jobs: Job[] = rawJobs.map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          progress: job.status === 'completed' ? 100 : job.status === 'running' ? 50 : 0,
          startTime: job.startedAt?.toString(),
          endTime: job.completedAt?.toString(),
          duration: job.startedAt && job.completedAt
            ? formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())
            : undefined,
          resources: {
            gpu: job.resources.gpu ? 1 : 0,
            cpu: job.resources.cpuCores || 1,
            memory: job.resources.memoryGb ? `${job.resources.memoryGb}G` : '4G',
          },
        }));

        displayJobList(jobs);
      } catch (error: any) {
        spinner.fail('Failed to list jobs');

        if (error.code === 'ECONNREFUSED') {
          console.log(chalk.yellow('\n⚠️  Local compute agent is not running'));
          console.log(chalk.gray('   Start it with: nexus compute agent start'));
        } else {
          logger.error('List error:', error);
        }
        process.exit(1);
      }
    });

  return command;
}

interface Job {
  id: string;
  name: string;
  status: string;
  progress: number;
  startTime?: string;
  endTime?: string;
  duration?: string;
  resources: {
    gpu: number;
    cpu: number;
    memory: string;
  };
}

/**
 * Display job list as table
 */
function displayJobList(jobs: Job[]): void {
  console.log(chalk.cyan.bold('\n📋 Local Compute Jobs'));
  console.log(chalk.gray('─'.repeat(100)));

  // Table header
  console.log(
    chalk.gray(
      padEnd('ID', 12) +
      padEnd('NAME', 30) +
      padEnd('STATUS', 12) +
      padEnd('PROGRESS', 12) +
      padEnd('RESOURCES', 20) +
      'DURATION'
    )
  );
  console.log(chalk.gray('─'.repeat(100)));

  // Table rows
  for (const job of jobs) {
    const statusColor = getStatusColor(job.status);
    const progressBar = createProgressBar(job.progress, 8);

    console.log(
      chalk.gray(job.id.substring(0, 10)) + '  ' +
      chalk.white(padEnd(truncate(job.name, 28), 30)) +
      statusColor(padEnd(job.status.toUpperCase(), 12)) +
      progressBar + padEnd(` ${job.progress}%`, 4) +
      chalk.gray(padEnd(`${job.resources.gpu}G/${job.resources.cpu}C/${job.resources.memory}`, 20)) +
      chalk.gray(job.duration || '-')
    );
  }

  console.log(chalk.gray('─'.repeat(100)));
  console.log(chalk.gray(`Total: ${jobs.length} jobs`));
  console.log();
}

/**
 * Get chalk color for status
 */
function getStatusColor(status: string): typeof chalk {
  switch (status.toLowerCase()) {
    case 'running':
      return chalk.blue;
    case 'completed':
      return chalk.green;
    case 'failed':
      return chalk.red;
    case 'pending':
      return chalk.yellow;
    case 'cancelled':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * Create a mini progress bar
 */
function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent === 100 ? chalk.green : chalk.blue;
  return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

/**
 * Pad string to fixed width
 */
function padEnd(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 2) + '..';
}

/**
 * Format duration in milliseconds to human readable
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export default createComputeListCommand;
