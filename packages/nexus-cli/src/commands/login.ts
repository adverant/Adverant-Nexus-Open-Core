/**
 * nexus-cli login command
 * Authenticate with Nexus Nexus
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import axios, { AxiosResponse } from 'axios';
import { saveConfig, getApiUrl } from '../utils/config.js';
import {
  isHttpError,
  isNetworkError,
  getErrorMessage,
  getHttpStatus
} from '../types/errors.js';
import type { AuthVerifyResponse } from '../types/api.js';

interface LoginOptions {
  apiKey?: string;
}

interface InquirerAnswers {
  apiKey: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  console.log(chalk.blue('\n🔐 Login to Nexus Nexus\n'));

  let apiKey = options.apiKey;

  // Prompt for API key if not provided
  if (!apiKey) {
    const answers = await inquirer.prompt<InquirerAnswers>([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your API key:',
        validate: (input: string) => input.length > 0 || 'API key is required'
      }
    ]);
    apiKey = answers.apiKey;
  }

  // Get API URL from environment/config (supports multi-environment deployment)
  const apiUrl = await getApiUrl();
  const verifyEndpoint = `${apiUrl}/api/v1/auth/verify`;

  const spinner = ora(`Verifying API key with ${apiUrl}...`).start();

  try {
    // Verify API key with Nexus Nexus
    const response: AxiosResponse<AuthVerifyResponse> = await axios.get(verifyEndpoint, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      timeout: 10000 // 10 second timeout for network resilience
    });

    if (response.data.valid) {
      // Save to config
      await saveConfig({
        apiKey,
        apiUrl // Save the discovered/configured URL for future commands
      });

      spinner.succeed(chalk.green('Authentication successful!'));
      console.log(chalk.white(`\nWelcome, ${response.data.user?.name || 'Developer'}!`));
      console.log(chalk.gray(`Connected to: ${apiUrl}`));
    } else {
      spinner.fail(chalk.red('Invalid API key'));
      process.exit(1);
    }
  } catch (error: unknown) {
    spinner.fail(chalk.red('Authentication failed'));

    // Type-safe error handling with type guards
    if (isNetworkError(error) && error.code === 'ECONNREFUSED') {
      console.error(chalk.red(`\nError: Could not connect to Nexus Nexus at ${apiUrl}`));
      console.error(chalk.yellow('\nTroubleshooting:'));
      console.error(chalk.white('  1. Check if Nexus Nexus services are running'));
      console.error(chalk.white('  2. Verify network connectivity'));
      console.error(chalk.white('  3. Set NEXUS_API_URL environment variable if using custom endpoint'));
      console.error(chalk.gray(`\n  Example: export NEXUS_API_URL=https://your-domain.com`));
    } else if (isHttpError(error)) {
      const errorMessage = getErrorMessage(error);
      const statusCode = getHttpStatus(error);

      console.error(chalk.red(`\nError: ${errorMessage}`));

      if (statusCode === 401) {
        console.error(chalk.yellow('\nThe API key may be invalid or expired. Please check your credentials.'));
      }
    } else if (isNetworkError(error) && error.code === 'ENOTFOUND') {
      console.error(chalk.red(`\nError: DNS lookup failed for ${apiUrl}`));
      console.error(chalk.yellow('\nThe hostname could not be resolved. Check your network configuration.'));
    } else {
      const errorMessage = getErrorMessage(error);
      console.error(chalk.red(`\nError: ${errorMessage}`));
    }

    process.exit(1);
  }
}
