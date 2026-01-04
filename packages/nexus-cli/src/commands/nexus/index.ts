/**
 * Nexus Commands Index
 *
 * Main entry point for all Nexus MCP commands
 * Registers the 'nexus' namespace and dynamically loads all Nexus tools
 */

import { Command as CommanderCommand } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { Command } from '../../types/command.js';
import {
  NexusCommandGenerator,
  createNexusCommandGenerator,
} from '../dynamic/nexus-commands.js';

export interface NexusCommandsConfig {
  program: CommanderCommand;
  nexusApiUrl?: string;
  autoDiscover?: boolean;
}

export class NexusCommands {
  private generator: NexusCommandGenerator;
  private program: CommanderCommand;
  private nexusCommand?: CommanderCommand;
  private initialized: boolean = false;

  constructor(private config: NexusCommandsConfig) {
    this.program = config.program;
    this.generator = createNexusCommandGenerator({
      nexusApiUrl: config.nexusApiUrl,
      autoDiscover: config.autoDiscover !== false,
    });
  }

  /**
   * Initialize Nexus commands
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Create nexus command namespace
    this.nexusCommand = this.program
      .command('nexus')
      .description('Nexus MCP tools - Memory, Knowledge Graph, Code Analysis, Multi-Agent')
      .option('--api-url <url>', 'Nexus API URL', 'http://localhost:9092')
      .hook('preAction', async () => {
        // Start health monitoring
        this.generator.startHealthMonitoring();
      });

    // Add list subcommand
    this.nexusCommand
      .command('list')
      .description('List all available Nexus tools')
      .option('-c, --category <category>', 'Filter by category')
      .option('-v, --verbose', 'Show detailed information')
      .action(async (options) => {
        await this.listTools(options);
      });

    // Add categories subcommand
    this.nexusCommand
      .command('categories')
      .description('List all Nexus tool categories')
      .action(async () => {
        await this.listCategories();
      });

    // Add refresh subcommand
    this.nexusCommand
      .command('refresh')
      .description('Refresh Nexus tools (re-discover from MCP server)')
      .action(async () => {
        await this.refreshTools();
      });

    // Discover and register all Nexus tools
    await this.discoverAndRegisterTools();

    this.initialized = true;
  }

  /**
   * Discover and register all Nexus tools as CLI commands
   */
  private async discoverAndRegisterTools(): Promise<void> {
    try {
      const commands = await this.generator.discover();

      if (commands.length === 0) {
        console.warn(
          chalk.yellow(
            '⚠️  No Nexus tools discovered - Nexus system may be unavailable'
          )
        );
        return;
      }

      // Register each command
      for (const command of commands) {
        this.registerCommand(command);
      }

      console.log(
        chalk.green(
          `✅ Registered ${commands.length} Nexus commands across ${this.generator.getCategories().length} categories`
        )
      );
    } catch (error) {
      console.error(chalk.red('❌ Failed to discover Nexus tools:'), error);
    }
  }

  /**
   * Register a single Nexus command
   */
  private registerCommand(command: Command): void {
    if (!this.nexusCommand) {
      throw new Error('Nexus command namespace not initialized');
    }

    // Create commander command
    const cmd = this.nexusCommand
      .command(command.name)
      .description(command.description);

    // Add options
    if (command.options) {
      for (const option of command.options) {
        const flags = option.short
          ? `${option.short}, ${option.long}`
          : option.long;

        const description = option.required
          ? `${option.description} (required)`
          : option.description;

        if (option.default !== undefined) {
          cmd.option(flags, description, option.default);
        } else if (option.choices && option.choices.length > 0) {
          cmd.option(
            flags,
            `${description} (choices: ${option.choices.join(', ')})`
          );
        } else {
          cmd.option(flags, description);
        }
      }
    }

    // Add streaming option
    if (command.streaming) {
      cmd.option('--stream', 'Enable streaming output', false);
    }

    // Add examples to help
    if (command.examples && command.examples.length > 0) {
      const examplesText = command.examples
        .map((ex, i) => `  ${i + 1}. ${ex}`)
        .join('\n');
      cmd.addHelpText('after', `\nExamples:\n${examplesText}\n`);
    }

    // Add command handler
    cmd.action(async (options) => {
      try {
        const result = await command.handler(options, {
          cwd: process.cwd(),
          config: {},
          services: new Map(),
          verbose: options.verbose || false,
          quiet: options.quiet || false,
          outputFormat: options.stream ? 'stream-json' : 'json',
          transport: null,
        });

        if (result.success) {
          this.displayResult(result.data, options);
        } else {
          const errorMessage = typeof result.error === 'string'
            ? result.error
            : result.error?.message || 'Unknown error';
          console.error(chalk.red('Error:'), errorMessage);
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red('Execution error:'), error);
        process.exit(1);
      }
    });
  }

  /**
   * Display command result
   */
  private displayResult(data: any, options: any): void {
    if (!data) {
      console.log(chalk.gray('No data returned'));
      return;
    }

    if (options.json || options.outputFormat === 'json') {
      console.log(JSON.stringify(data, null, 2));
    } else if (options.yaml) {
      // Would need yaml library to stringify
      console.log(data);
    } else {
      // Pretty print for terminal
      if (Array.isArray(data)) {
        this.displayArrayResult(data);
      } else if (typeof data === 'object') {
        this.displayObjectResult(data);
      } else {
        console.log(data);
      }
    }
  }

  /**
   * Display array results as table
   */
  private displayArrayResult(data: any[]): void {
    if (data.length === 0) {
      console.log(chalk.gray('No results'));
      return;
    }

    // If array of objects, display as table
    if (typeof data[0] === 'object') {
      const keys = Object.keys(data[0]);
      const table = new Table({
        head: keys.map((k) => chalk.cyan(k)),
      });

      for (const item of data.slice(0, 20)) {
        // Limit to 20 rows
        table.push(keys.map((k) => this.formatValue(item[k])));
      }

      console.log(table.toString());

      if (data.length > 20) {
        console.log(chalk.gray(`\n... and ${data.length - 20} more results`));
      }
    } else {
      // Simple array
      data.forEach((item, i) => {
        console.log(`${i + 1}. ${item}`);
      });
    }
  }

  /**
   * Display object result
   */
  private displayObjectResult(data: any): void {
    const table = new Table();

    for (const [key, value] of Object.entries(data)) {
      table.push({
        [chalk.cyan(key)]: this.formatValue(value),
      });
    }

    console.log(table.toString());
  }

  /**
   * Format value for display
   */
  private formatValue(value: any): string {
    if (value === null || value === undefined) {
      return chalk.gray('null');
    }

    if (typeof value === 'boolean') {
      return value ? chalk.green('true') : chalk.red('false');
    }

    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        return `[${value.length} items]`;
      }
      return JSON.stringify(value, null, 2);
    }

    return String(value);
  }

  /**
   * List all available Nexus tools
   */
  private async listTools(options: { category?: string; verbose?: boolean }): Promise<void> {
    const commands = options.category
      ? this.generator.getCommandsByCategory(options.category)
      : this.generator.getCommands();

    if (commands.length === 0) {
      console.log(
        chalk.yellow(
          options.category
            ? `No tools found in category '${options.category}'`
            : 'No tools available'
        )
      );
      return;
    }

    if (options.verbose) {
      // Detailed list
      for (const cmd of commands) {
        console.log(chalk.cyan.bold(`\n${cmd.name}`));
        console.log(`  ${cmd.description}`);
        if (cmd.category) {
          console.log(`  Category: ${chalk.gray(cmd.category)}`);
        }
        if (cmd.examples && cmd.examples.length > 0) {
          console.log(`  Example: ${chalk.gray(cmd.examples[0])}`);
        }
      }
    } else {
      // Table view
      const table = new Table({
        head: [chalk.cyan('Command'), chalk.cyan('Description'), chalk.cyan('Category')],
        colWidths: [30, 50, 20],
      });

      for (const cmd of commands) {
        table.push([cmd.name, cmd.description, cmd.category || 'general']);
      }

      console.log(table.toString());
      console.log(
        chalk.gray(`\nTotal: ${commands.length} commands`)
      );
    }
  }

  /**
   * List all tool categories
   */
  private async listCategories(): Promise<void> {
    const categories = this.generator.getCategories();

    if (categories.length === 0) {
      console.log(chalk.yellow('No categories available'));
      return;
    }

    const table = new Table({
      head: [chalk.cyan('Category'), chalk.cyan('Tool Count')],
    });

    for (const category of categories) {
      const tools = this.generator.getCommandsByCategory(category);
      table.push([category, String(tools.length)]);
    }

    console.log(table.toString());
    console.log(
      chalk.gray(
        `\nUse 'nexus nexus list --category <name>' to see tools in a category`
      )
    );
  }

  /**
   * Refresh tools from MCP server
   */
  private async refreshTools(): Promise<void> {
    console.log(chalk.cyan('Refreshing Nexus tools...'));

    try {
      const commands = await this.generator.refresh();

      console.log(
        chalk.green(
          `✅ Refreshed: ${commands.length} commands across ${this.generator.getCategories().length} categories`
        )
      );
    } catch (error) {
      console.error(chalk.red('❌ Failed to refresh tools:'), error);
      process.exit(1);
    }
  }

  /**
   * Close and cleanup
   */
  close(): void {
    this.generator.close();
  }
}

/**
 * Register Nexus commands with CLI program
 */
export async function registerNexusCommands(
  program: CommanderCommand,
  config?: Partial<NexusCommandsConfig>
): Promise<NexusCommands> {
  const nexusCommands = new NexusCommands({
    program,
    ...config,
  });

  await nexusCommands.initialize();

  return nexusCommands;
}
