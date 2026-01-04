/**
 * Plugin Disable Command
 *
 * Disable an enabled plugin
 */

import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { pluginManager } from '../../plugins/plugin-manager.js';
import { logger } from '../../utils/logger.js';

export const disableCommand = new Command('disable')
  .description('Disable a plugin')
  .argument('<name>', 'Plugin name')
  .action(async (name: string) => {
    const spinner = ora(`Disabling plugin: ${name}...`).start();

    try {
      // Initialize plugin manager
      await pluginManager.initialize();

      // Disable plugin
      await pluginManager.disable(name);

      spinner.succeed(`Plugin ${chalk.bold(name)} disabled successfully!`);
      console.log();
      console.log(chalk.dim(`To re-enable: nexus plugin enable ${name}`));
    } catch (error) {
      spinner.fail(`Failed to disable plugin: ${name}`);
      logger.error('Disable error:', error);
      process.exit(1);
    }
  });
