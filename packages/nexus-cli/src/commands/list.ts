/**
 * nexus-cli list command
 * List all plugins
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
import type { ApiResponse, PluginListResponse, PluginMetadata } from '../types/api.js';

interface ListOptions {
  all: boolean;
}

export async function listCommand(options: ListOptions): Promise<void> {
  console.log(chalk.blue('\n📦 Your Plugins\n'));

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.error(chalk.red('Not authenticated. Run: nexus-cli login'));
    process.exit(1);
  }

  const spinner = ora('Fetching plugins...').start();

  try {
    const apiUrl = await getApiUrl();
    const response: AxiosResponse<ApiResponse<PluginListResponse>> = await axios.get(
      `${apiUrl}/api/v1/developers/me/plugins`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        params: {
          all: options.all
        },
        timeout: 10000 // 10 second timeout
      }
    );

    spinner.stop();

    const plugins: PluginMetadata[] = response.data.data.plugins;

    if (plugins.length === 0) {
      console.log(chalk.yellow('No plugins found. Create one with: nexus-cli init <name>'));
      return;
    }

    console.log(chalk.white(`Found ${chalk.bold(plugins.length)} plugin(s):\n`));

    plugins.forEach((plugin: PluginMetadata) => {
      const statusColor = plugin.status === 'active' ? chalk.green :
                          plugin.status === 'inactive' ? chalk.yellow :
                          chalk.red;

      console.log(chalk.bold(plugin.displayName));
      console.log(chalk.gray(`  ID: ${plugin.id}`));
      console.log(chalk.gray(`  Name: ${plugin.name}`));
      console.log(chalk.gray(`  Version: ${plugin.version}`));
      console.log(chalk.gray(`  Status: ${statusColor(plugin.status)}`));
      console.log(chalk.gray(`  Author: ${plugin.author}`));
      console.log(chalk.gray(`  Updated: ${new Date(plugin.updatedAt).toLocaleString()}`));
      console.log('');
    });

  } catch (error: unknown) {
    spinner.fail(chalk.red('Failed to fetch plugins'));

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
