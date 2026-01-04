/**
 * CLI Setup and Command Registration for Nexus CLI
 *
 * Sets up Commander.js with all commands, global options,
 * and help system integration.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { logger } from './utils/logger.js';
import { setupGlobalErrorHandlers } from './utils/error-handler.js';
import { configManager } from './core/config/config-manager.js';
import { createComputeCommand } from './commands/compute/index.js';
import { createRepoCommand } from './commands/repo/index.js';
import type { OutputFormat } from './types/output.js';

export interface GlobalOptions {
  config?: string;
  profile?: string;
  outputFormat?: OutputFormat;
  verbose?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  timeout?: number;
  retries?: number;
}

/**
 * Create and configure the CLI program
 */
export function createCLI(): Command {
  const program = new Command();

  // Basic configuration
  program
    .name('nexus')
    .description('World-class CLI for Adverant-Nexus - Surpassing Claude Code and Gemini CLI')
    .version('2.0.0', '-V, --version', 'Output the current version');

  // Global options
  program
    .option('--config <path>', 'Use specific config file')
    .option('--profile <name>', 'Use specific profile')
    .option(
      '-o, --output-format <format>',
      'Output format (text|json|yaml|table|stream-json)',
      'text'
    )
    .option('-v, --verbose', 'Verbose output (debug level)', false)
    .option('-q, --quiet', 'Minimal output (errors only)', false)
    .option('--no-color', 'Disable colors', false)
    .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
    .option('--retries <n>', 'Number of retries', '3');

  // Add help command
  program
    .command('help [command]')
    .description('Display help for command')
    .action((command?: string) => {
      if (command) {
        program.outputHelp({ error: false });
      } else {
        program.help();
      }
    });

  return program;
}

/**
 * Setup CLI with global configuration and error handling
 */
export async function setupCLI(): Promise<Command> {
  const program = createCLI();

  // Initialize configuration
  try {
    await configManager.initialize();
  } catch (error) {
    logger.warn('Failed to initialize configuration, using defaults');
  }

  // Hook to process global options before command execution
  program.hook('preAction', async (thisCommand: Command) => {
    const opts = thisCommand.opts() as GlobalOptions;

    // Apply global options
    if (opts.verbose) {
      logger.setVerbose(true);
    }
    if (opts.quiet) {
      logger.setQuiet(true);
    }

    // Setup error handlers with verbose mode
    setupGlobalErrorHandlers(opts.verbose || false);

    logger.debug('Global options:', opts);
  });

  return program;
}

/**
 * Register all commands (called from index.ts)
 */
export function registerCommands(program: Command): void {
  // Register compute command (local ML compute management)
  program.addCommand(createComputeCommand());

  // Register repo command (repository analysis)
  program.addCommand(createRepoCommand());

  // Version command
  program
    .command('version')
    .description('Show version information')
    .action(() => {
      console.log(chalk.cyan.bold('Nexus CLI v2.0.0'));
      console.log(chalk.gray('World-class CLI for Adverant-Nexus'));
    });

  program
    .command('config')
    .description('Configuration management')
    .action(() => {
      console.log(chalk.yellow('Config commands will be implemented in Phase 2'));
    });

  program
    .command('workspace')
    .description('Workspace management')
    .action(() => {
      console.log(chalk.yellow('Workspace commands will be implemented in Phase 2'));
    });

  program
    .command('services')
    .description('Service management')
    .action(() => {
      console.log(chalk.yellow('Service commands will be implemented in Phase 2'));
    });

  program
    .command('nexus')
    .description('Nexus MCP commands')
    .action(() => {
      console.log(chalk.yellow('Nexus commands will be implemented in Phase 2'));
    });

  program
    .command('agent')
    .description('Autonomous agent commands')
    .action(() => {
      console.log(chalk.yellow('Agent commands will be implemented in Phase 2'));
    });

  program
    .command('repl')
    .description('Start interactive REPL mode')
    .action(() => {
      console.log(chalk.yellow('REPL mode will be implemented in Phase 6'));
    });
}

/**
 * Parse CLI arguments and execute
 */
export async function runCLI(argv?: string[]): Promise<void> {
  const program = await setupCLI();
  registerCommands(program);

  // Parse arguments
  await program.parseAsync(argv || process.argv);
}
