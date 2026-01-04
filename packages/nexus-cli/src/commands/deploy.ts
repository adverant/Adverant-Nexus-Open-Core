/**
 * nexus-cli deploy command
 * Deploy plugin to Nexus Nexus
 */

import chalk from 'chalk';
import ora from 'ora';
import axios, { AxiosResponse } from 'axios';
import { getApiKey, getApiUrl, validateApiHealth } from '../utils/config.js';
import { execSync } from 'child_process';
import {
  isHttpError,
  isNetworkError,
  getErrorMessage,
  getHttpStatus
} from '../types/errors.js';
import type { ApiResponse, DeploymentResponse } from '../types/api.js';

interface DeployOptions {
  environment: 'staging' | 'production';
  build: boolean;
}

export async function deployCommand(options: DeployOptions): Promise<void> {
  console.log(chalk.blue(`\n🚀 Deploying to ${chalk.bold(options.environment)}\n`));

  const apiKey = await getApiKey();
  if (!apiKey) {
    console.error(chalk.red('Not authenticated. Run: nexus-cli login'));
    process.exit(1);
  }

  // Health check before deployment
  let spinner = ora('Checking Nexus Nexus API health...').start();

  try {
    const apiUrl = await getApiUrl();
    const healthResult = await validateApiHealth(apiUrl, 5000);

    if (!healthResult.healthy) {
      spinner.fail(chalk.red('Nexus Nexus API health check failed'));
      console.error(chalk.red(`\nStatus: ${healthResult.status}`));
      console.error(chalk.yellow(`Message: ${healthResult.message}`));

      if (healthResult.warnings && healthResult.warnings.length > 0) {
        console.error(chalk.yellow('\nIssues detected:'));
        healthResult.warnings.forEach(warning => {
          console.error(chalk.white(`  - ${warning}`));
        });
      }

      console.error(chalk.red('\nDeployment aborted due to API health issues.'));
      console.error(chalk.yellow('Please ensure all Nexus Nexus services are running and healthy.'));
      process.exit(1);
    }

    // Show warning if degraded but allow deployment
    if (healthResult.status === 'degraded') {
      spinner.warn(chalk.yellow('Nexus Nexus API is degraded'));
      if (healthResult.warnings && healthResult.warnings.length > 0) {
        console.log(chalk.yellow('Warnings:'));
        healthResult.warnings.forEach(warning => {
          console.log(chalk.white(`  - ${warning}`));
        });
      }
      console.log(chalk.yellow('Proceeding with deployment, but some features may be affected.\n'));
    } else {
      spinner.succeed(chalk.green('Nexus Nexus API is healthy'));
    }

    spinner = ora('Loading plugin configuration...').start();

    // Build if requested
    if (options.build) {
      spinner.text = 'Building plugin...';
      try {
        execSync('npm run build', { stdio: 'inherit' });
      } catch (error) {
        spinner.fail(chalk.red('Build failed'));
        process.exit(1);
      }
    }

    spinner.text = 'Packaging plugin...';

    // Create deployment package (simplified)
    const packageInfo = {
      environment: options.environment,
      timestamp: new Date().toISOString()
    };

    spinner.text = 'Uploading to Nexus Nexus...';

    const response: AxiosResponse<ApiResponse<DeploymentResponse>> = await axios.post(
      `${apiUrl}/api/v1/plugins/deploy`,
      packageInfo,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout for large deployments
      }
    );

    spinner.succeed(chalk.green(`Deployed to ${options.environment} successfully!`));

    const deployment = response.data.data.deployment;
    console.log(chalk.white(`\nDeployment ID: ${chalk.bold(deployment.id)}`));
    console.log(chalk.white(`Status: ${chalk.green(deployment.status)}`));
    console.log(chalk.white(`URL: ${chalk.cyan(deployment.url)}\n`));

  } catch (error: unknown) {
    spinner.fail(chalk.red('Deployment failed'));

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
      } else if (statusCode === 403) {
        console.error(chalk.yellow('\nInsufficient permissions for deployment.'));
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
