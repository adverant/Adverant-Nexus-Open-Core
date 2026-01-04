/**
 * Repository Export Command
 *
 * Export analysis results to various formats
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import type { CommandResult } from '../../types/command.js';

type ExportFormat = 'markdown' | 'json' | 'html';

interface ExportOptions {
  format: ExportFormat;
  output?: string;
  input?: string;
  includeToc: boolean;
}

export function createRepoExportCommand(): Command {
  const command = new Command('export')
    .description('Export analysis results to various formats')
    .option(
      '-f, --format <format>',
      'Export format: markdown, json, html',
      'markdown'
    )
    .option('-o, --output <path>', 'Output file path')
    .option(
      '-i, --input <path>',
      'Input JSON file with previous analysis results'
    )
    .option('--include-toc', 'Include table of contents (markdown only)', true)
    .option('--no-include-toc', 'Exclude table of contents')
    .action(async (options: ExportOptions) => {
      try {
        const result = await exportAnalysis(options);

        if (!result.success) {
          console.error(chalk.red('Error:'), result.error);
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
 * Export analysis results
 */
async function exportAnalysis(options: ExportOptions): Promise<CommandResult> {
  const spinner = ora({
    text: chalk.cyan('Preparing export...'),
    color: 'cyan',
  }).start();

  try {
    // Load analysis data
    let analysisData: any;

    if (options.input) {
      const inputPath = resolve(options.input);
      if (!existsSync(inputPath)) {
        spinner.fail(chalk.red('Input file not found'));
        return {
          success: false,
          error: `Input file not found: ${inputPath}`,
          message: 'Specify a valid input file with -i option',
        };
      }

      const content = readFileSync(inputPath, 'utf-8');
      try {
        analysisData = JSON.parse(content);
      } catch {
        spinner.fail(chalk.red('Invalid JSON input'));
        return {
          success: false,
          error: 'Invalid JSON in input file',
          message: 'The input file must contain valid JSON',
        };
      }
    } else {
      // Look for recent analysis in cache
      spinner.fail(chalk.red('No input specified'));
      console.log('');
      console.log(chalk.yellow('Usage:'));
      console.log(
        chalk.gray('  1. Run analysis first:') +
          chalk.white(' nexus repo analyze <repo> --output-format json > analysis.json')
      );
      console.log(
        chalk.gray('  2. Then export:') +
          chalk.white(' nexus repo export -i analysis.json -f markdown -o README.arch.md')
      );
      return {
        success: false,
        error: 'No input data',
        message:
          'Use -i option to specify an input JSON file with analysis results',
      };
    }

    spinner.text = chalk.cyan(`Generating ${options.format} output...`);

    // Import the output generator
    const { OutputGenerator } = await import('@adverant/repo-analyzer');
    const generator = new OutputGenerator();

    let output: string;
    let extension: string;

    switch (options.format) {
      case 'markdown':
        output = generator.generateMarkdown(analysisData, {
          format: 'markdown',
          includeToc: options.includeToc,
        });
        extension = '.md';
        break;

      case 'json':
        output = generator.generateJson(analysisData);
        extension = '.json';
        break;

      case 'html':
        output = generator.generateHtml(analysisData, { format: 'html' });
        extension = '.html';
        break;

      default:
        spinner.fail(chalk.red('Unsupported format'));
        return {
          success: false,
          error: `Unsupported format: ${options.format}`,
          message: 'Supported formats: markdown, json, html',
        };
    }

    // Determine output path
    let outputPath: string;
    if (options.output) {
      outputPath = resolve(options.output);
    } else if (options.input) {
      // Derive from input filename
      const inputBase = basename(options.input, '.json');
      outputPath = resolve(dirname(options.input), `${inputBase}${extension}`);
    } else {
      outputPath = resolve(`analysis${extension}`);
    }

    // Write output
    writeFileSync(outputPath, output, 'utf-8');

    spinner.succeed(chalk.green('Export complete'));

    console.log('');
    console.log(chalk.bold('Output written to: ') + chalk.cyan(outputPath));
    console.log(chalk.gray(`Format: ${options.format}`));
    console.log(chalk.gray(`Size: ${(output.length / 1024).toFixed(1)} KB`));

    return {
      success: true,
      data: { outputPath, format: options.format, size: output.length },
      message: `Exported to ${outputPath}`,
    };
  } catch (error) {
    spinner.fail(chalk.red('Export failed'));

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

export default createRepoExportCommand;
