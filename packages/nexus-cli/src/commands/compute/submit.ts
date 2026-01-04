/**
 * Compute Submit Command
 *
 * Submit ML jobs to local or remote compute.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../../utils/logger.js';
import { LocalComputeClient } from './lib/local-compute-client.js';

export interface SubmitOptions {
  name?: string;
  gpu?: number;
  cpu?: number;
  memory?: string;
  framework?: string;
  remote?: boolean;
  cluster?: string;
  environment?: string[];
}

export function createComputeSubmitCommand(): Command {
  const command = new Command('submit')
    .description('Submit ML job to local or remote compute')
    .argument('<script>', 'Path to training script or job definition')
    .option('-n, --name <name>', 'Job name')
    .option('-g, --gpu <count>', 'Number of GPUs', '1')
    .option('-c, --cpu <count>', 'Number of CPU cores', '4')
    .option('-m, --memory <size>', 'Memory allocation', '16GB')
    .option('-f, --framework <name>', 'ML framework (pytorch, tensorflow, mlx)', 'pytorch')
    .option('-r, --remote', 'Submit to remote HPC instead of local', false)
    .option('--cluster <name>', 'Target cluster for remote submission')
    .option('-e, --environment <vars...>', 'Environment variables (KEY=VALUE)')
    .action(async (script: string, options: SubmitOptions) => {
      const spinner = ora('Submitting job...').start();

      try {
        const client = new LocalComputeClient();

        // Check if agent is running first
        if (!(await client.isAgentRunning())) {
          spinner.fail('Local compute agent is not running');
          console.log(chalk.yellow('\n⚠️  Start the agent with: nexus compute agent start'));
          process.exit(1);
        }

        // Parse environment variables
        const environment: Record<string, string> = {};
        if (options.environment) {
          for (const env of options.environment) {
            const [key, value] = env.split('=');
            if (key && value) {
              environment[key] = value;
            }
          }
        }

        const gpuCount = parseInt(String(options.gpu ?? 1), 10);
        const cpuCount = parseInt(String(options.cpu ?? 4), 10);

        const jobConfig = {
          name: options.name || generateJobName(script),
          script,
          resources: {
            gpu: gpuCount > 0,
            cpuCores: cpuCount,
            memory: options.memory || '16GB',
          },
          framework: (options.framework || 'pytorch') as 'pytorch' | 'tensorflow' | 'mlx' | 'jax',
          environment,
        };

        if (options.remote) {
          spinner.text = `Submitting to remote cluster ${options.cluster || 'auto'}...`;
          console.log(chalk.yellow('\n⚠️  Remote submission is not yet supported'));
          console.log(chalk.gray('   Jobs are submitted to the local compute agent'));
        }

        const result = await client.submitJob(jobConfig);

        spinner.succeed('Job submitted successfully');

        console.log(chalk.cyan('\n📤 Job Submitted'));
        console.log(chalk.gray('─'.repeat(50)));
        console.log(`   ID:          ${chalk.white(result.id)}`);
        console.log(`   Name:        ${chalk.white(result.name)}`);
        console.log(`   Target:      ${chalk.cyan('Local')}`);
        console.log(`   Status:      ${chalk.yellow(result.status)}`);
        console.log(`   Resources:   ${chalk.gray(`${result.resources.gpu ? '1' : '0'} GPU, ${result.resources.cpuCores || 1} CPU, ${result.resources.memoryGb || 16}GB`)}`);
        console.log(`   Framework:   ${chalk.gray(result.framework)}`);
        console.log();
        console.log(chalk.gray(`Monitor with: nexus compute status ${result.id}`));
        console.log(chalk.gray(`View logs:    nexus compute logs ${result.id}`));
        console.log();
      } catch (error: any) {
        spinner.fail('Failed to submit job');

        if (error.code === 'ECONNREFUSED') {
          console.log(chalk.yellow('\n⚠️  Local compute agent is not running'));
          console.log(chalk.gray('   Start it with: nexus compute agent start'));
        } else {
          logger.error('Submit error:', error);
        }
        process.exit(1);
      }
    });

  return command;
}

/**
 * Generate job name from script path
 */
function generateJobName(script: string): string {
  const baseName = script.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'job';
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
  return `${baseName}-${timestamp}`;
}

export default createComputeSubmitCommand;
