/**
 * Plugin Install Command
 *
 * Install a plugin from local path or registry
 */

import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import path from 'path';
import { pluginManager } from '../../plugins/plugin-manager.js';
import { logger } from '../../utils/logger.js';

export const installCommand = new Command('install')
  .description('Install a plugin')
  .argument('<path-or-name>', 'Plugin path or name')
  .option('--no-enable', 'Do not enable plugin after installation')
  .action(async (pathOrName: string, options) => {
    const spinner = ora('Installing plugin...').start();

    try {
      // Resolve path
      const pluginPath = path.resolve(process.cwd(), pathOrName);

      // Install plugin
      const plugin = await pluginManager.install(pluginPath);

      spinner.text = `Plugin installed: ${plugin.name}`;

      // Enable plugin by default
      if (options.enable !== false) {
        await pluginManager.enable(plugin.name);
        spinner.succeed(
          `Plugin ${chalk.bold(plugin.name)} installed and enabled successfully!`
        );
      } else {
        spinner.succeed(`Plugin ${chalk.bold(plugin.name)} installed successfully!`);
      }

      // Show plugin info
      console.log();
      console.log(chalk.bold('Plugin Info:'));
      console.log(`  Name: ${plugin.name}`);
      console.log(`  Version: ${plugin.version}`);
      console.log(`  Description: ${plugin.description}`);
      console.log(`  Author: ${plugin.author}`);
      console.log(`  Commands: ${plugin.commands.length}`);

      if (plugin.commands.length > 0) {
        console.log();
        console.log(chalk.bold('Available Commands:'));
        plugin.commands.forEach((cmd) => {
          console.log(`  - ${chalk.cyan(cmd.name)}: ${cmd.description}`);
        });
      }

      console.log();
      console.log(
        chalk.dim(
          `Use ${chalk.bold(`nexus plugin ${plugin.name} <command>`)} to run plugin commands`
        )
      );
    } catch (error) {
      spinner.fail('Failed to install plugin');
      logger.error('Installation error:', error);
      process.exit(1);
    }
  });
