/**
 * Compute Agent Command
 *
 * Starts a local compute agent that:
 * - Detects local hardware (Apple Silicon, NVIDIA GPU)
 * - Registers with nexus-hpc-gateway
 * - Executes ML jobs locally using PyTorch MPS, Metal, etc.
 * - Streams logs back to the dashboard
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../../utils/logger.js';
import { detectHardware, type HardwareInfo } from './lib/hardware-detection.js';
import { LocalComputeAgent } from './lib/local-compute-agent.js';

export interface AgentOptions {
  gateway?: string;
  name?: string;
  maxMemory?: number;
  allowRemoteJobs?: boolean;
  daemonize?: boolean;
  port?: number;
}

export function createComputeAgentCommand(): Command {
  const command = new Command('agent')
    .description('Manage local compute agent');

  // Start subcommand
  command
    .command('start')
    .description('Start the local compute agent')
    .option('-g, --gateway <url>', 'HPC gateway URL', 'https://api.adverant.ai/hpc')
    .option('-n, --name <name>', 'Custom name for this compute node')
    .option('--max-memory <percent>', 'Maximum memory usage percentage', '75')
    .option('--allow-remote-jobs', 'Allow remote job submissions', false)
    .option('-d, --daemonize', 'Run as background daemon', false)
    .option('-p, --port <port>', 'Local agent port', '9099')
    .action(async (options: AgentOptions) => {
      const spinner = ora('Detecting hardware...').start();

      try {
        // Detect local hardware
        const hardware = await detectHardware();
        spinner.succeed('Hardware detected');

        displayHardwareInfo(hardware);

        // Determine agent name
        const agentName = options.name || generateAgentName(hardware);

        console.log(chalk.cyan('\n📡 Starting Local Compute Agent'));
        console.log(chalk.gray(`   Name: ${agentName}`));
        console.log(chalk.gray(`   Gateway: ${options.gateway}`));
        console.log(chalk.gray(`   Max Memory: ${options.maxMemory}%`));
        console.log(chalk.gray(`   Allow Remote Jobs: ${options.allowRemoteJobs ? 'Yes' : 'No'}`));
        console.log();

        // Create and start agent
        const agent = new LocalComputeAgent({
          name: agentName,
          gatewayUrl: options.gateway || 'https://api.adverant.ai/hpc',
          maxMemoryPercent: parseInt(String(options.maxMemory ?? 75), 10),
          allowRemoteJobs: options.allowRemoteJobs || false,
          apiPort: parseInt(String(options.port ?? 9099), 10),
        });

        if (options.daemonize) {
          await agent.startDaemon();
          console.log(chalk.green('✓ Agent started as daemon'));
          console.log(chalk.gray(`  PID file: ~/.nexus/compute-agent.pid`));
          console.log(chalk.gray(`  Logs: ~/.nexus/logs/compute-agent.log`));
        } else {
          // Run in foreground
          await agent.start();
        }
      } catch (error) {
        spinner.fail('Failed to start compute agent');
        logger.error('Agent start error:', error);
        process.exit(1);
      }
    });

  // Stop subcommand
  command
    .command('stop')
    .description('Stop the local compute agent')
    .action(async () => {
      const spinner = ora('Stopping compute agent...').start();

      try {
        const agent = new LocalComputeAgent({} as any);
        await agent.stop();
        spinner.succeed('Compute agent stopped');
      } catch (error) {
        spinner.fail('Failed to stop compute agent');
        logger.error('Agent stop error:', error);
        process.exit(1);
      }
    });

  // Status subcommand
  command
    .command('status')
    .description('Check compute agent status')
    .action(async () => {
      try {
        const agent = new LocalComputeAgent({} as any);
        const status = await agent.getStatus();

        if (status.running) {
          console.log(chalk.green('● Agent is running'));
          console.log(chalk.gray(`  PID: ${status.pid}`));
          console.log(chalk.gray(`  Uptime: ${status.uptime}`));
          console.log(chalk.gray(`  Jobs Completed: ${status.jobsCompleted}`));
          console.log(chalk.gray(`  Jobs Running: ${status.jobsRunning}`));
        } else {
          console.log(chalk.yellow('○ Agent is not running'));
          console.log(chalk.gray('  Run: nexus compute agent start'));
        }
      } catch (error) {
        console.log(chalk.red('○ Agent is not running'));
        logger.debug('Status check error:', error);
      }
    });

  return command;
}

/**
 * Display detected hardware information
 */
function displayHardwareInfo(hardware: HardwareInfo): void {
  console.log(chalk.cyan('\n🖥️  Hardware Detected:'));

  // CPU Info
  console.log(chalk.white('   CPU:'));
  console.log(chalk.gray(`      Model: ${hardware.cpu.model}`));
  console.log(chalk.gray(`      Cores: ${hardware.cpu.cores} (${hardware.cpu.performanceCores}P + ${hardware.cpu.efficiencyCores}E)`));

  // Memory Info
  console.log(chalk.white('   Memory:'));
  console.log(chalk.gray(`      Total: ${hardware.memory.total} GB`));
  console.log(chalk.gray(`      Type: ${hardware.memory.unified ? 'Unified (shared with GPU)' : 'Discrete'}`));

  // GPU Info
  if (hardware.gpu) {
    console.log(chalk.white('   GPU/Accelerator:'));
    console.log(chalk.gray(`      Type: ${hardware.gpu.type}`));
    console.log(chalk.gray(`      Memory: ${hardware.gpu.memory} GB`));
    console.log(chalk.gray(`      API: ${hardware.gpu.api}`));

    if (hardware.gpu.neuralEngine) {
      console.log(chalk.gray(`      Neural Engine: ${hardware.gpu.neuralEngineTops} TOPS`));
    }
  }

  // Supported Frameworks
  console.log(chalk.white('   Supported Frameworks:'));
  const frameworks = hardware.frameworks || [];
  if (frameworks.length > 0) {
    frameworks.forEach((fw) => {
      const statusIcon = fw.available ? chalk.green('✓') : chalk.red('✗');
      console.log(chalk.gray(`      ${statusIcon} ${fw.name} ${fw.version || ''}`));
    });
  } else {
    console.log(chalk.gray('      None detected'));
  }
}

/**
 * Generate agent name from hardware
 */
function generateAgentName(hardware: HardwareInfo): string {
  const hostname = process.env.HOSTNAME || require('os').hostname();
  const gpuType = hardware.gpu?.type.replace(/\s+/g, '-') || 'CPU';
  return `${hostname}-${gpuType}`.toLowerCase();
}

export default createComputeAgentCommand;
