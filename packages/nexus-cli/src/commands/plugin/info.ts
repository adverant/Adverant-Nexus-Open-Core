/**
 * Plugin Info Command
 *
 * Show detailed information about a plugin
 */

import { Command } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import { pluginManager } from '../../plugins/plugin-manager.js';
import { logger } from '../../utils/logger.js';

export const infoCommand = new Command('info')
  .description('Show plugin information')
  .argument('<name>', 'Plugin name')
  .option('--json', 'Output as JSON')
  .action(async (name: string, options) => {
    try {
      // Initialize plugin manager
      await pluginManager.initialize();

      // Get plugin
      const plugin = pluginManager.get(name);

      if (!plugin) {
        console.log(chalk.red(`Plugin ${name} not found`));
        console.log();
        console.log(chalk.dim('To see all plugins, run:'));
        console.log(chalk.dim('  nexus plugin list --all'));
        process.exit(1);
      }

      // JSON output
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              name: plugin.name,
              version: plugin.version,
              description: plugin.description,
              author: plugin.author,
              homepage: plugin.homepage,
              repository: plugin.repository,
              enabled: plugin.enabled,
              installed: plugin.installed,
              main: plugin.main,
              commands: plugin.commands.map((cmd) => ({
                name: cmd.name,
                description: cmd.description,
                args: cmd.args,
                options: cmd.options,
              })),
              dependencies: plugin.dependencies,
              permissions: plugin.permissions,
              mcp: plugin.mcp,
            },
            null,
            2
          )
        );
        return;
      }

      // Pretty output
      console.log();
      console.log(
        boxen(
          `${chalk.bold.cyan(plugin.name)} ${chalk.gray(`v${plugin.version}`)}`,
          {
            padding: 1,
            margin: 1,
            borderStyle: 'round',
            borderColor: 'cyan',
          }
        )
      );

      console.log(chalk.bold('Description:'));
      console.log(`  ${plugin.description || '-'}`);
      console.log();

      console.log(chalk.bold('Author:'));
      console.log(`  ${plugin.author}`);
      console.log();

      if (plugin.homepage) {
        console.log(chalk.bold('Homepage:'));
        console.log(`  ${plugin.homepage}`);
        console.log();
      }

      if (plugin.repository) {
        console.log(chalk.bold('Repository:'));
        console.log(`  ${plugin.repository}`);
        console.log();
      }

      console.log(chalk.bold('Status:'));
      console.log(
        `  ${plugin.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
      );
      console.log();

      if (plugin.commands.length > 0) {
        console.log(chalk.bold('Commands:'));
        plugin.commands.forEach((cmd) => {
          console.log(`  ${chalk.cyan(cmd.name)}`);
          console.log(`    ${cmd.description}`);

          if (cmd.args && cmd.args.length > 0) {
            console.log(`    Arguments:`);
            cmd.args.forEach((arg) => {
              const required = arg.required ? chalk.red('*') : '';
              console.log(
                `      ${arg.name}${required} (${arg.type}): ${arg.description}`
              );
            });
          }

          if (cmd.options && cmd.options.length > 0) {
            console.log(`    Options:`);
            cmd.options.forEach((opt) => {
              const short = opt.short ? `-${opt.short}, ` : '';
              console.log(
                `      ${short}--${opt.long} (${opt.type}): ${opt.description}`
              );
            });
          }

          console.log();
        });
      }

      if (plugin.dependencies && plugin.dependencies.length > 0) {
        console.log(chalk.bold('Dependencies:'));
        plugin.dependencies.forEach((dep) => {
          console.log(`  - ${dep}`);
        });
        console.log();
      }

      if (plugin.permissions && plugin.permissions.length > 0) {
        console.log(chalk.bold('Permissions:'));
        plugin.permissions.forEach((perm) => {
          console.log(`  - ${perm}`);
        });
        console.log();
      }

      if (plugin.mcp) {
        console.log(chalk.bold('MCP Server:'));
        console.log(
          `  ${plugin.mcp.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
        );
        if (plugin.mcp.enabled) {
          console.log(`  Command: ${plugin.mcp.command}`);
        }
        console.log();
      }
    } catch (error) {
      logger.error('Failed to get plugin info:', error);
      process.exit(1);
    }
  });
