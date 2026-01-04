/**
 * nexus-cli register command
 * Register plugin with Nexus Nexus
 */

import fs from 'fs-extra';
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
import type { ApiResponse, PluginRegistrationResponse } from '../types/api.js';

interface RegisterOptions {
  config: string;
}

export async function registerCommand(options: RegisterOptions): Promise<void> {
  console.log(chalk.blue('\n📝 Registering plugin with Nexus Nexus\n'));

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.error(chalk.red('Not authenticated. Run: nexus-cli login'));
    process.exit(1);
  }

  const spinner = ora('Loading plugin configuration...').start();

  try {
    // Load plugin config
    const configPath = options.config;
    if (!(await fs.pathExists(configPath))) {
      spinner.fail(chalk.red(`Config file not found: ${configPath}`));
      process.exit(1);
    }

    const pluginConfig = await fs.readJson(configPath);
    spinner.text = 'Validating configuration...';

    // Validate required fields
    const required = ['name', 'displayName', 'description', 'version', 'author'];
    for (const field of required) {
      if (!pluginConfig[field]) {
        spinner.fail(chalk.red(`Missing required field: ${field}`));
        process.exit(1);
      }
    }

    spinner.text = 'Registering plugin...';

    const apiUrl = await getApiUrl();
    const response: AxiosResponse<ApiResponse<PluginRegistrationResponse>> = await axios.post(
      `${apiUrl}/api/v1/plugins`,
      pluginConfig,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000 // 15 second timeout
      }
    );

    spinner.succeed(chalk.green('Plugin registered successfully!'));

    const plugin = response.data.data;
    console.log(chalk.white(`\nPlugin ID: ${chalk.bold(plugin.id)}`));
    console.log(chalk.white(`Status: ${chalk.yellow(plugin.status)}`));
    console.log(chalk.white(`\nNext: nexus-cli deploy --environment staging\n`));

  } catch (error: unknown) {
    spinner.fail(chalk.red('Registration failed'));

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
      } else if (statusCode === 409) {
        console.error(chalk.yellow('\nA plugin with this name already exists.'));
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
