/**
 * Compute Logs Command
 *
 * Stream or view logs from local compute jobs.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../../utils/logger.js';
import { LocalComputeClient } from './lib/local-compute-client.js';

export interface LogsOptions {
  follow?: boolean;
  tail?: number;
  timestamps?: boolean;
}

export function createComputeLogsCommand(): Command {
  const command = new Command('logs')
    .description('View logs from a compute job')
    .argument('<jobId>', 'Job ID to get logs from')
    .option('-f, --follow', 'Follow log output in real-time', false)
    .option('-n, --tail <lines>', 'Number of lines to show from the end', '100')
    .option('-t, --timestamps', 'Show timestamps', false)
    .action(async (jobId: string, options: LogsOptions) => {
      try {
        const client = new LocalComputeClient();

        // Check if agent is running first
        if (!(await client.isAgentRunning())) {
          console.log(chalk.yellow('\n⚠️  Local compute agent is not running'));
          console.log(chalk.gray('   Start it with: nexus compute agent start'));
          process.exit(1);
        }

        if (options.follow) {
          // Stream logs in real-time using async generator
          console.log(chalk.gray(`Streaming logs for job ${jobId}... (Ctrl+C to exit)\n`));

          for await (const line of client.streamJobLogs(jobId)) {
            const timestamp = options.timestamps
              ? chalk.gray(`[${new Date().toISOString()}] `)
              : '';
            console.log(`${timestamp}${line}`);
          }
        } else {
          // Get log history from job status
          const spinner = ora('Fetching logs...').start();

          const job = await client.getJobStatus(jobId);

          spinner.stop();

          if (!job) {
            console.log(chalk.red(`\n❌ Job not found: ${jobId}`));
            console.log(chalk.gray('   List jobs with: nexus compute list'));
            process.exit(1);
          }

          const logs = job.logs || [];
          const tailCount = parseInt(options.tail?.toString() || '100', 10);
          const displayLogs = logs.slice(-tailCount);

          if (displayLogs.length === 0) {
            console.log(chalk.yellow('\n⚠️  No logs available for this job'));
            return;
          }

          console.log(chalk.cyan(`\n📜 Logs for job ${jobId}`));
          console.log(chalk.gray('─'.repeat(80)));

          for (const line of displayLogs) {
            const timestamp = options.timestamps
              ? chalk.gray(`[${new Date().toISOString()}] `)
              : '';
            console.log(`${timestamp}${line}`);
          }

          console.log(chalk.gray('─'.repeat(80)));
          console.log(chalk.gray(`Showing last ${displayLogs.length} log entries`));
          console.log();
        }
      } catch (error: any) {
        if (error.code === 'ECONNREFUSED') {
          console.log(chalk.yellow('\n⚠️  Local compute agent is not running'));
          console.log(chalk.gray('   Start it with: nexus compute agent start'));
        } else if (error.message?.includes('not found')) {
          console.log(chalk.red(`\n❌ Job not found: ${jobId}`));
          console.log(chalk.gray('   List jobs with: nexus compute list'));
        } else {
          logger.error('Logs error:', error);
        }
        process.exit(1);
      }
    });

  return command;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

/**
 * Get chalk color for log level
 */
function getLogLevelColor(level: string): typeof chalk {
  switch (level.toLowerCase()) {
    case 'error':
      return chalk.red;
    case 'warn':
    case 'warning':
      return chalk.yellow;
    case 'info':
      return chalk.blue;
    case 'debug':
      return chalk.gray;
    case 'success':
      return chalk.green;
    default:
      return chalk.white;
  }
}

export default createComputeLogsCommand;
