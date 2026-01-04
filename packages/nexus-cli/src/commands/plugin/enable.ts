/**
 * Plugin Enable Command
 *
 * Enable a disabled plugin
 */

import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { pluginManager } from '../../plugins/plugin-manager.js';
import { logger } from '../../utils/logger.js';

export const enableCommand = new Command('enable')
  .description('Enable a plugin')
  .argument('<name>', 'Plugin name')
  .action(async (name: string) => {
    const spinner = ora(`Enabling plugin: ${name}...`).start();

    try {
      // Initialize plugin manager
      await pluginManager.initialize();

      // Enable plugin
      await pluginManager.enable(name);

      spinner.succeed(`Plugin ${chalk.bold(name)} enabled successfully!`);

      const plugin = pluginManager.get(name);
      if (plugin && plugin.commands.length > 0) {
        console.log();
        console.log(chalk.bold('Available Commands:'));
        plugin.commands.forEach((cmd) => {
          console.log(`  - ${chalk.cyan(cmd.name)}: ${cmd.description}`);
        });
      }
    } catch (error) {
      spinner.fail(`Failed to enable plugin: ${name}`);
      logger.error('Enable error:', error);
      process.exit(1);
    }
  });
