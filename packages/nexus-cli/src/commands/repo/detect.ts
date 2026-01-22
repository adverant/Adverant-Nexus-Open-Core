/**
 * Repository Detect Command
 *
 * Quick type detection without full analysis
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { CommandResult } from '../../types/command.js';

interface DetectOptions {
  outputFormat: string;
  verbose: boolean;
}

export function createRepoDetectCommand(): Command {
  const command = new Command('detect')
    .description('Quick repository type detection without full analysis')
    .argument('<target>', 'Repository URL or local path')
    .option('--output-format <format>', 'Output format (text|json)', 'text')
    .option('-v, --verbose', 'Show detailed detection indicators', false)
    .action(async (target: string, options: DetectOptions) => {
      try {
        const result = await detectRepositoryType(target, options);

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(result, null, 2));
        }

        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  return command;
}

/**
 * Execute type detection
 */
async function detectRepositoryType(
  target: string,
  options: DetectOptions
): Promise<CommandResult> {
  const spinner = ora({
    text: chalk.cyan('Detecting repository type...'),
    color: 'cyan',
  }).start();

  try {
    // Dynamically import the analyzer
    const { RepositoryAnalyzer } = await import('@adverant/repo-analyzer');

    const analyzer = new RepositoryAnalyzer({
      enableAiAnalysis: false, // Quick detection doesn't need AI
    });

    // Determine if target is URL or local path
    const isUrl =
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('git@');

    const isLocalPath = !isUrl && existsSync(resolve(target));

    if (!isUrl && !isLocalPath) {
      spinner.fail(chalk.red('Invalid target: not a valid URL or local path'));
      return {
        success: false,
        error: 'Invalid target',
        message: 'Target must be a valid repository URL or local directory path',
      };
    }

    const repoUrl = isUrl ? target : `file://${resolve(target)}`;
    const typeResult = await analyzer.detectType(repoUrl);

    spinner.succeed(chalk.green('Detection complete'));

    // Display results
    if (options.outputFormat === 'text') {
      displayTextResults(typeResult, options.verbose);
    }

    return {
      success: true,
      data: typeResult,
      message: `Detected type: ${typeResult.primaryType}`,
      metadata: {
        service: 'repo-analyzer',
      },
    };
  } catch (error) {
    spinner.fail(chalk.red('Detection failed'));

    // Check if it's a module not found error
    if (
      error instanceof Error &&
      error.message.includes('Cannot find module')
    ) {
      console.log(
        chalk.yellow('\nNote: @adverant/repo-analyzer package not found.')
      );
      console.log(
        chalk.gray('Install it with: npm install @adverant/repo-analyzer')
      );
    }

    throw error;
  }
}

/**
 * Display text results in terminal
 */
function displayTextResults(result: any, verbose: boolean): void {
  console.log('');
  console.log(chalk.bold.underline('Repository Type Detection'));
  console.log('');

  // Primary type with icon
  const typeIcons: Record<string, string> = {
    backend: '\u{1F5A5}', // Desktop computer
    frontend: '\u{1F310}', // Globe
    mobile: '\u{1F4F1}', // Mobile phone
    'infra-as-code': '\u{2601}', // Cloud
    library: '\u{1F4DA}', // Books
    monorepo: '\u{1F4C1}', // Folder
    unknown: '\u{2753}', // Question mark
  };

  const icon = typeIcons[result.primaryType] || '\u{1F4C4}';
  const confidence = Math.round(result.confidence * 100);

  console.log(
    `${icon} ` +
      chalk.bold('Type: ') +
      chalk.cyan.bold(result.primaryType) +
      chalk.gray(` (${confidence}% confidence)`)
  );

  // Confidence bar
  const barLength = 20;
  const filledLength = Math.round((confidence / 100) * barLength);
  const bar =
    chalk.green('\u{2588}'.repeat(filledLength)) +
    chalk.gray('\u{2591}'.repeat(barLength - filledLength));
  console.log(chalk.gray('Confidence: ') + bar);

  // Tech stack
  if (result.techStack && result.techStack.length > 0) {
    console.log('');
    console.log(
      chalk.bold('Tech Stack: ') +
        chalk.white(result.techStack.slice(0, 10).join(', '))
    );
    if (result.techStack.length > 10) {
      console.log(
        chalk.gray(`  ... and ${result.techStack.length - 10} more`)
      );
    }
  }

  // Verbose: show indicators
  if (verbose && result.indicators && result.indicators.length > 0) {
    console.log('');
    console.log(chalk.bold('Detection Indicators:'));
    for (const indicator of result.indicators) {
      const weight = indicator.weight ? chalk.gray(` (${indicator.weight})`) : '';
      console.log(chalk.gray('  - ') + indicator.reason + weight);
    }
  }

  // Secondary types if detected
  if (result.secondaryTypes && result.secondaryTypes.length > 0) {
    console.log('');
    console.log(
      chalk.bold('Secondary Types: ') +
        chalk.gray(result.secondaryTypes.join(', '))
    );
  }

  console.log('');
}

export default createRepoDetectCommand;
