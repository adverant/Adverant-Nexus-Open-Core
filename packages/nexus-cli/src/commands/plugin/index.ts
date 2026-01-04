/**
 * Plugin Commands
 *
 * Main plugin command with subcommands
 */

import { Command } from 'commander';
import { initCommand } from './init.js';
import { installCommand } from './install.js';
import { listCommand } from './list.js';
import { enableCommand } from './enable.js';
import { disableCommand } from './disable.js';
import { uninstallCommand } from './uninstall.js';
import { infoCommand } from './info.js';

export const pluginCommand = new Command('plugin')
  .description('Manage Nexus CLI plugins')
  .addCommand(initCommand)
  .addCommand(installCommand)
  .addCommand(listCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(uninstallCommand)
  .addCommand(infoCommand);
