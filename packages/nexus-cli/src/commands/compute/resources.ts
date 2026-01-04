/**
 * Compute Resources Command
 *
 * Shows local hardware capabilities and resource usage.
 * Detects Apple Silicon specs, NVIDIA GPUs, and available frameworks.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../../utils/logger.js';
import { detectHardware, type HardwareInfo } from './lib/hardware-detection.js';

export interface ResourcesOptions {
  json?: boolean;
  verbose?: boolean;
}

export function createComputeResourcesCommand(): Command {
  const command = new Command('resources')
    .description('Show local compute resources and capabilities')
    .option('--json', 'Output as JSON', false)
    .option('-v, --verbose', 'Show detailed information', false)
    .action(async (options: ResourcesOptions) => {
      const spinner = ora('Detecting hardware...').start();

      try {
        const hardware = await detectHardware();
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(hardware, null, 2));
          return;
        }

        displayResources(hardware, options.verbose || false);
      } catch (error) {
        spinner.fail('Failed to detect hardware');
        logger.error('Hardware detection error:', error);
        process.exit(1);
      }
    });

  return command;
}

/**
 * Display resources in formatted output
 */
function displayResources(hardware: HardwareInfo, verbose: boolean): void {
  console.log(chalk.cyan.bold('\n╔═══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║              Local Compute Resources                        ║'));
  console.log(chalk.cyan.bold('╚═══════════════════════════════════════════════════════════╝\n'));

  // System Info
  console.log(chalk.white.bold('📱 System'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`   Platform:      ${chalk.cyan(hardware.platform)}`);
  console.log(`   Architecture:  ${chalk.cyan(hardware.arch)}`);
  console.log(`   Hostname:      ${chalk.cyan(hardware.hostname)}`);
  console.log();

  // CPU Info
  console.log(chalk.white.bold('🔲 CPU'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`   Model:         ${chalk.cyan(hardware.cpu.model)}`);
  console.log(`   Cores:         ${chalk.cyan(hardware.cpu.cores)} total`);
  if (hardware.cpu.performanceCores) {
    console.log(`                  ${chalk.green(hardware.cpu.performanceCores)} Performance + ${chalk.yellow(hardware.cpu.efficiencyCores)} Efficiency`);
  }
  if (verbose && hardware.cpu.speed) {
    console.log(`   Speed:         ${chalk.cyan(hardware.cpu.speed)} MHz`);
  }
  console.log();

  // Memory Info
  console.log(chalk.white.bold('💾 Memory'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`   Total:         ${chalk.cyan(hardware.memory.total)} GB`);
  console.log(`   Available:     ${chalk.green(hardware.memory.available)} GB`);
  console.log(`   Type:          ${chalk.cyan(hardware.memory.unified ? 'Unified (shared with GPU)' : 'Discrete')}`);

  // Memory usage bar
  const usedPercent = Math.round((1 - hardware.memory.available / hardware.memory.total) * 100);
  const usageBar = createUsageBar(usedPercent, 30);
  console.log(`   Usage:         ${usageBar} ${usedPercent}%`);
  console.log();

  // GPU/Accelerator Info
  if (hardware.gpu) {
    console.log(chalk.white.bold('🎮 GPU / Accelerator'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log(`   Type:          ${chalk.cyan(hardware.gpu.type)}`);
    console.log(`   Memory:        ${chalk.cyan(hardware.gpu.memory)} GB`);
    console.log(`   API:           ${chalk.cyan(hardware.gpu.api)}`);

    if (hardware.gpu.fp32Tflops) {
      console.log(`   FP32 Compute:  ${chalk.cyan(hardware.gpu.fp32Tflops)} TFLOPS`);
    }
    if (hardware.gpu.fp16Tflops) {
      console.log(`   FP16 Compute:  ${chalk.cyan(hardware.gpu.fp16Tflops)} TFLOPS`);
    }
    if (hardware.gpu.neuralEngine) {
      console.log(`   Neural Engine: ${chalk.cyan(hardware.gpu.neuralEngineTops)} TOPS`);
    }
    if (hardware.gpu.computeCapability) {
      console.log(`   Compute Cap:   ${chalk.cyan(hardware.gpu.computeCapability)}`);
    }
    console.log();
  }

  // Supported Frameworks
  console.log(chalk.white.bold('🧰 ML Frameworks'));
  console.log(chalk.gray('─'.repeat(50)));
  const frameworks = hardware.frameworks || [];
  if (frameworks.length > 0) {
    frameworks.forEach((fw) => {
      const statusIcon = fw.available ? chalk.green('✓') : chalk.gray('○');
      const versionStr = fw.version ? chalk.gray(` (${fw.version})`) : '';
      const gpuStr = fw.gpuSupport ? chalk.green(' [GPU]') : chalk.gray(' [CPU]');
      console.log(`   ${statusIcon} ${chalk.white(fw.name)}${versionStr}${gpuStr}`);
    });
  } else {
    console.log(chalk.yellow('   No ML frameworks detected'));
    console.log(chalk.gray('   Install PyTorch, TensorFlow, or MLX for GPU acceleration'));
  }
  console.log();

  // Recommendations
  console.log(chalk.white.bold('💡 Recommendations'));
  console.log(chalk.gray('─'.repeat(50)));
  displayRecommendations(hardware);
  console.log();
}

/**
 * Create a visual usage bar
 */
function createUsageBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent > 80 ? chalk.red : percent > 50 ? chalk.yellow : chalk.green;
  return `${color('█'.repeat(filled))}${chalk.gray('░'.repeat(empty))}`;
}

/**
 * Display recommendations based on hardware
 */
function displayRecommendations(hardware: HardwareInfo): void {
  const recommendations: string[] = [];

  // Check for Apple Silicon
  if (hardware.gpu?.type.includes('Apple M')) {
    if (!hardware.frameworks?.some(f => f.name === 'PyTorch' && f.gpuSupport)) {
      recommendations.push('Install PyTorch with MPS support: pip install torch torchvision');
    }
    if (!hardware.frameworks?.some(f => f.name === 'MLX')) {
      recommendations.push('Install MLX for Apple Silicon: pip install mlx');
    }
  }

  // Check for NVIDIA GPU
  if (hardware.gpu?.type.includes('NVIDIA')) {
    if (!hardware.frameworks?.some(f => f.name === 'PyTorch' && f.gpuSupport)) {
      recommendations.push('Install PyTorch with CUDA: pip install torch --index-url https://download.pytorch.org/whl/cu121');
    }
  }

  // General recommendations
  if (hardware.memory.total < 16) {
    recommendations.push('Consider using smaller batch sizes due to limited memory');
  }

  if (hardware.memory.total >= 64) {
    recommendations.push('Large unified memory available - ideal for large model training');
  }

  if (recommendations.length > 0) {
    recommendations.forEach((rec, i) => {
      console.log(`   ${i + 1}. ${chalk.gray(rec)}`);
    });
  } else {
    console.log(chalk.green('   ✓ System is well configured for ML workloads'));
  }
}

export default createComputeResourcesCommand;
