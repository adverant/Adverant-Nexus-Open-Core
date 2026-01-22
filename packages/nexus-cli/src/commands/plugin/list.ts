/**
 * Plugin List Command
 *
 * List installed plugins
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { pluginManager } from '../../plugins/plugin-manager.js';
import { logger } from '../../utils/logger.js';

export const listCommand = new Command('list')
  .description('List installed plugins')
  .option('-a, --all', 'Show all plugins (including disabled)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      // Initialize plugin manager
      await pluginManager.initialize();

      // Get plugins
      const plugins = options.all
        ? pluginManager.list()
        : pluginManager.getEnabledPlugins();

      if (plugins.length === 0) {
        console.log(chalk.yellow('No plugins installed'));
        console.log();
        console.log(chalk.dim('To install a plugin, run:'));
        console.log(chalk.dim('  nexus plugin install <path>'));
        return;
      }

      // JSON output
      if (options.json) {
        console.log(
          JSON.stringify(
            plugins.map((p) => ({
              name: p.name,
              version: p.version,
              description: p.description,
              author: p.author,
              enabled: p.enabled,
              commands: p.commands.length,
            })),
            null,
            2
          )
        );
        return;
      }

      // Table output
      const table = new Table({
        head: [
          chalk.bold('Plugin'),
          chalk.bold('Version'),
          chalk.bold('Status'),
          chalk.bold('Commands'),
          chalk.bold('Description'),
        ],
        colWidths: [20, 10, 10, 10, 40],
      });

      for (const plugin of plugins) {
        table.push([
          chalk.cyan(plugin.name),
          plugin.version,
          plugin.enabled ? chalk.green('enabled') : chalk.gray('disabled'),
          plugin.commands.length.toString(),
          plugin.description || '-',
        ]);
      }

      console.log();
      console.log(table.toString());
      console.log();
      console.log(
        chalk.dim(`Total: ${plugins.length} plugin${plugins.length !== 1 ? 's' : ''}`)
      );
    } catch (error) {
      logger.error('Failed to list plugins:', error);
      process.exit(1);
    }
  });
