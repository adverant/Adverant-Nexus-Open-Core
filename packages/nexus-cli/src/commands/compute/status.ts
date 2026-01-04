/**
 * Compute Status Command
 *
 * Check the status of local compute jobs and the agent.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../../utils/logger.js';
import { LocalComputeClient } from './lib/local-compute-client.js';

export interface StatusOptions {
  jobId?: string;
  json?: boolean;
}

export function createComputeStatusCommand(): Command {
  const command = new Command('status')
    .description('Check status of local compute jobs')
    .argument('[jobId]', 'Specific job ID to check')
    .option('--json', 'Output as JSON', false)
    .action(async (jobId: string | undefined, options: StatusOptions) => {
      const spinner = ora('Fetching status...').start();

      try {
        const client = new LocalComputeClient();

        // Check if agent is running first
        const isRunning = await client.isAgentRunning();

        if (jobId) {
          // Get specific job status
          if (!isRunning) {
            spinner.fail('Local compute agent is not running');
            console.log(chalk.yellow('\n⚠️  Start the agent with: nexus compute agent start'));
            process.exit(1);
          }

          const job = await client.getJobStatus(jobId);
          spinner.stop();

          if (!job) {
            console.log(chalk.red(`\n❌ Job not found: ${jobId}`));
            console.log(chalk.gray('   List jobs with: nexus compute list'));
            process.exit(1);
          }

          if (options.json) {
            console.log(JSON.stringify(job, null, 2));
            return;
          }

          // Convert to display format
          const displayJob: JobStatus = {
            id: job.id,
            name: job.name,
            status: job.status as JobStatus['status'],
            progress: job.status === 'completed' ? 100 : job.status === 'running' ? 50 : 0,
            startTime: job.startedAt?.toString(),
            endTime: job.completedAt?.toString(),
            resources: {
              gpu: job.resources.gpu ? 1 : 0,
              cpu: job.resources.cpuCores || 1,
              memory: job.resources.memoryGb ? `${job.resources.memoryGb}G` : '4G',
            },
            metrics: job.metrics ? {
              peakMemory: job.metrics.peakMemoryGb,
              cpuUtil: job.metrics.cpuUtilization,
              gpuUtil: job.metrics.gpuUtilization,
            } : undefined,
          };

          displayJobStatus(displayJob);
        } else {
          // Get overall status
          spinner.stop();

          if (!isRunning) {
            const displayStatus: AgentStatus = {
              running: false,
              version: '2.0.0',
              hostname: '',
              gpuType: 'Unknown',
              gpuMemory: 0,
              jobs: { running: 0, completed: 0, failed: 0, queued: 0 },
              resources: { cpuUsage: 0, memoryUsage: 0, gpuUsage: 0, gpuMemoryUsage: 0 },
            };

            if (options.json) {
              console.log(JSON.stringify(displayStatus, null, 2));
              return;
            }

            displayOverallStatus(displayStatus);
            return;
          }

          const status = await client.getAgentStatus();

          if (!status) {
            console.log(chalk.red('\n❌ Failed to get agent status'));
            process.exit(1);
          }

          if (options.json) {
            console.log(JSON.stringify(status, null, 2));
            return;
          }

          // Convert to display format
          const displayStatus: AgentStatus = {
            running: true,
            pid: undefined, // Not available from gateway status
            uptime: undefined, // Not available from gateway status
            version: '2.0.0',
            hostname: status.name,
            gpuType: status.hardware?.gpu?.type || 'Unknown',
            gpuMemory: status.hardware?.gpu?.memory || 0,
            jobs: {
              running: status.currentJob ? 1 : 0,
              completed: status.jobsCompleted,
              failed: status.jobsFailed,
              queued: 0,
            },
            resources: {
              cpuUsage: 0, // Would need real-time metrics
              memoryUsage: 0,
              gpuUsage: 0,
              gpuMemoryUsage: 0,
            },
          };

          displayOverallStatus(displayStatus);
        }
      } catch (error: any) {
        spinner.fail('Failed to get status');

        if (error.code === 'ECONNREFUSED') {
          console.log(chalk.yellow('\n⚠️  Local compute agent is not running'));
          console.log(chalk.gray('   Start it with: nexus compute agent start'));
        } else {
          logger.error('Status error:', error);
        }
        process.exit(1);
      }
    });

  return command;
}

interface JobStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  startTime?: string;
  endTime?: string;
  resources: {
    gpu: number;
    cpu: number;
    memory: string;
  };
  metrics?: {
    peakMemory?: number;
    cpuUtil?: number;
    gpuUtil?: number;
  };
}

interface AgentStatus {
  running: boolean;
  pid?: number;
  uptime?: string;
  version: string;
  hostname: string;
  gpuType: string;
  gpuMemory: number;
  jobs: {
    running: number;
    completed: number;
    failed: number;
    queued: number;
  };
  resources: {
    cpuUsage: number;
    memoryUsage: number;
    gpuUsage: number;
    gpuMemoryUsage: number;
  };
}

/**
 * Display single job status
 */
function displayJobStatus(job: JobStatus): void {
  console.log(chalk.cyan.bold(`\n📋 Job: ${job.name}`));
  console.log(chalk.gray('─'.repeat(50)));

  const statusColors: Record<string, typeof chalk> = {
    pending: chalk.yellow,
    running: chalk.blue,
    completed: chalk.green,
    failed: chalk.red,
    cancelled: chalk.gray,
  };
  const statusColor = statusColors[job.status] || chalk.white;

  console.log(`   ID:          ${chalk.gray(job.id)}`);
  console.log(`   Status:      ${statusColor(job.status.toUpperCase())}`);

  if (job.status === 'running') {
    const progressBar = createProgressBar(job.progress, 30);
    console.log(`   Progress:    ${progressBar} ${job.progress}%`);
  }

  console.log(`   Resources:   ${chalk.cyan(`${job.resources.gpu} GPU, ${job.resources.cpu} CPU, ${job.resources.memory}`)}`);

  if (job.startTime) {
    console.log(`   Started:     ${chalk.gray(job.startTime)}`);
  }
  if (job.endTime) {
    console.log(`   Ended:       ${chalk.gray(job.endTime)}`);
  }

  if (job.metrics) {
    console.log(chalk.white.bold('\n   Resource Metrics:'));
    if (job.metrics.peakMemory !== undefined) {
      console.log(`   Peak Memory: ${chalk.cyan(job.metrics.peakMemory.toFixed(2))} GB`);
    }
    if (job.metrics.cpuUtil !== undefined) {
      console.log(`   CPU Usage:   ${chalk.cyan(job.metrics.cpuUtil.toFixed(1))}%`);
    }
    if (job.metrics.gpuUtil !== undefined) {
      console.log(`   GPU Usage:   ${chalk.cyan(job.metrics.gpuUtil.toFixed(1))}%`);
    }
  }
  console.log();
}

/**
 * Display overall agent status
 */
function displayOverallStatus(status: AgentStatus): void {
  console.log(chalk.cyan.bold('\n╔═══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║              Local Compute Agent Status                     ║'));
  console.log(chalk.cyan.bold('╚═══════════════════════════════════════════════════════════╝\n'));

  // Agent status
  const agentStatus = status.running
    ? chalk.green('● Running')
    : chalk.red('○ Stopped');
  console.log(`   Agent:        ${agentStatus}`);

  if (status.running) {
    console.log(`   PID:          ${chalk.gray(status.pid)}`);
    console.log(`   Uptime:       ${chalk.gray(status.uptime)}`);
    console.log(`   Version:      ${chalk.gray(status.version)}`);
    console.log(`   Hostname:     ${chalk.gray(status.hostname)}`);
    console.log(`   GPU:          ${chalk.cyan(status.gpuType)} (${status.gpuMemory} GB)`);
    console.log();

    // Jobs
    console.log(chalk.white.bold('   Jobs:'));
    console.log(`     Running:    ${chalk.blue(status.jobs.running)}`);
    console.log(`     Queued:     ${chalk.yellow(status.jobs.queued)}`);
    console.log(`     Completed:  ${chalk.green(status.jobs.completed)}`);
    console.log(`     Failed:     ${chalk.red(status.jobs.failed)}`);
    console.log();

    // Resources
    console.log(chalk.white.bold('   Resource Usage:'));
    console.log(`     CPU:        ${createUsageBar(status.resources.cpuUsage, 20)} ${status.resources.cpuUsage}%`);
    console.log(`     Memory:     ${createUsageBar(status.resources.memoryUsage, 20)} ${status.resources.memoryUsage}%`);
    console.log(`     GPU:        ${createUsageBar(status.resources.gpuUsage, 20)} ${status.resources.gpuUsage}%`);
    console.log(`     GPU Mem:    ${createUsageBar(status.resources.gpuMemoryUsage, 20)} ${status.resources.gpuMemoryUsage}%`);
  }
  console.log();
}

/**
 * Create a progress bar
 */
function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `${chalk.green('█'.repeat(filled))}${chalk.gray('░'.repeat(empty))}`;
}

/**
 * Create a usage bar with color coding
 */
function createUsageBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent > 80 ? chalk.red : percent > 50 ? chalk.yellow : chalk.green;
  return `${color('█'.repeat(filled))}${chalk.gray('░'.repeat(empty))}`;
}

export default createComputeStatusCommand;
