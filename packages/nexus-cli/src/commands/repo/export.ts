/**
 * Repository Export Command
 *
 * Export analysis results to various formats.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { OutputGenerator } from '@adverant/repo-analyzer';

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
      const spinner = ora({
        text: chalk.cyan('Preparing export...'),
        color: 'cyan',
      }).start();

      try {
        // Load analysis data
        let analysisData: unknown;

        if (options.input) {
          const inputPath = resolve(options.input);
          if (!existsSync(inputPath)) {
            spinner.fail(chalk.red('Input file not found'));
            console.log(chalk.red(`File not found: ${inputPath}`));
            process.exit(1);
          }

          const content = readFileSync(inputPath, 'utf-8');
          try {
            analysisData = JSON.parse(content);
          } catch {
            spinner.fail(chalk.red('Invalid JSON input'));
            console.log(chalk.red('The input file must contain valid JSON'));
            process.exit(1);
          }
        } else {
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
          process.exit(1);
        }

        spinner.text = chalk.cyan(`Generating ${options.format} output...`);

        const generator = new OutputGenerator();

        let output: string;
        let extension: string;

        switch (options.format) {
          case 'markdown':
            output = generator.generateMarkdown(analysisData as Parameters<typeof generator.generateMarkdown>[0], {
              format: 'markdown',
              includeToc: options.includeToc,
            });
            extension = '.md';
            break;

          case 'json':
            output = generator.generateJson(analysisData as Parameters<typeof generator.generateJson>[0]);
            extension = '.json';
            break;

          case 'html':
            output = generator.generateHtml(analysisData as Parameters<typeof generator.generateHtml>[0], { format: 'html' });
            extension = '.html';
            break;

          default:
            spinner.fail(chalk.red('Unsupported format'));
            console.log(chalk.red(`Unsupported format: ${options.format}`));
            console.log(chalk.gray('Supported formats: markdown, json, html'));
            process.exit(1);
        }

        // Determine output path
        let outputPath: string;
        if (options.output) {
          outputPath = resolve(options.output);
        } else if (options.input) {
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

        process.exit(0);
      } catch (error) {
        spinner.fail(chalk.red('Export failed'));
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });

  return command;
}

export default createRepoExportCommand;
