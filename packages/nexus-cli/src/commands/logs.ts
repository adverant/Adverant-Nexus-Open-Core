/**
 * nexus-cli logs command
 * View plugin logs
 */

import chalk from 'chalk';
import ora from 'ora';
import axios, { AxiosResponse } from 'axios';
import { getApiKey, getApiUrl } from '../utils/config.js';
import {
  isHttpError,
  isNetworkError,
  getErrorMessage,
  getHttpStatus
} from '../types/errors.js';
import type { ApiResponse, LogsResponse, LogEntry } from '../types/api.js';

interface LogsOptions {
  follow: boolean;
  lines: string;
}

export async function logsCommand(plugin: string, options: LogsOptions): Promise<void> {
  console.log(chalk.blue(`\n📋 Logs for ${chalk.bold(plugin)}\n`));

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.error(chalk.red('Not authenticated. Run: nexus-cli login'));
    process.exit(1);
  }

  const spinner = ora('Fetching logs...').start();

  try {
    const apiUrl = await getApiUrl();
    const response: AxiosResponse<ApiResponse<LogsResponse>> = await axios.get(
      `${apiUrl}/api/v1/plugins/${plugin}/logs`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        params: {
          lines: parseInt(options.lines, 10),
          follow: options.follow
        },
        timeout: 10000 // 10 second timeout
      }
    );

    spinner.stop();

    const logs: LogEntry[] = response.data.data.logs;

    if (logs.length === 0) {
      console.log(chalk.yellow('No logs available'));
      return;
    }

    logs.forEach((log: LogEntry) => {
      const timestamp = chalk.gray(new Date(log.timestamp).toLocaleString());
      const level = log.level === 'error' ? chalk.red(log.level) :
                    log.level === 'warn' ? chalk.yellow(log.level) :
                    chalk.blue(log.level);

      console.log(`${timestamp} [${level}] ${log.message}`);
    });

    console.log(chalk.gray(`\nShowing ${logs.length} log entries\n`));

  } catch (error: unknown) {
    spinner.fail(chalk.red('Failed to fetch logs'));

    // Type-safe error handling with type guards
    if (isNetworkError(error) && error.code === 'ECONNREFUSED') {
      const apiUrl = await getApiUrl();
      console.error(chalk.red(`\nError: Could not connect to Nexus Nexus at ${apiUrl}`));
      console.error(chalk.yellow('\nTroubleshooting:'));
      console.error(chalk.white('  1. Check if Nexus Nexus services are running'));
      console.error(chalk.white('  2. Verify network connectivity'));
      console.error(chalk.white('  3. Set NEXUS_API_URL environment variable if using custom endpoint'));
    } else if (isHttpError(error)) {
      const errorMessage = getErrorMessage(error);
      const statusCode = getHttpStatus(error);

      console.error(chalk.red(`\nError: ${errorMessage}`));

      if (statusCode === 401) {
        console.error(chalk.yellow('\nThe API key may be invalid or expired. Run: nexus-cli login'));
      } else if (statusCode === 404) {
        console.error(chalk.yellow(`\nPlugin '${plugin}' not found.`));
      }
    } else if (isNetworkError(error) && error.code === 'ENOTFOUND') {
      const apiUrl = await getApiUrl();
      console.error(chalk.red(`\nError: DNS lookup failed for ${apiUrl}`));
      console.error(chalk.yellow('\nThe hostname could not be resolved. Check your network configuration.'));
    } else {
      const errorMessage = getErrorMessage(error);
      console.error(chalk.red(`\nError: ${errorMessage}`));
    }

    process.exit(1);
  }
}
