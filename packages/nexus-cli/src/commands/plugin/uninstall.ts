/**
 * Plugin Uninstall Command
 *
 * Uninstall a plugin
 */

import { Command } from 'commander';
import prompts from 'prompts';
import ora from 'ora';
import chalk from 'chalk';
import { pluginManager } from '../../plugins/plugin-manager.js';
import { logger } from '../../utils/logger.js';

export const uninstallCommand = new Command('uninstall')
  .description('Uninstall a plugin')
  .argument('<name>', 'Plugin name')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (name: string, options) => {
    try {
      // Initialize plugin manager
      await pluginManager.initialize();

      // Check if plugin exists
      const plugin = pluginManager.get(name);
      if (!plugin) {
        console.log(chalk.red(`Plugin ${name} not found`));
        process.exit(1);
      }

      // Confirm uninstallation
      if (!options.yes) {
        const response = await prompts({
          type: 'confirm',
          name: 'confirm',
          message: `Are you sure you want to uninstall ${chalk.bold(name)}?`,
          initial: false,
        });

        if (!response.confirm) {
          console.log('Uninstallation cancelled');
          return;
        }
      }

      const spinner = ora(`Uninstalling plugin: ${name}...`).start();

      // Uninstall plugin
      await pluginManager.uninstall(name);

      spinner.succeed(`Plugin ${chalk.bold(name)} uninstalled successfully!`);
    } catch (error) {
      logger.error('Failed to uninstall plugin:', error);
      process.exit(1);
    }
  });
