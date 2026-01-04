/**
 * Session Export Command
 *
 * Export session to JSON file or stdout
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs-extra';
import SessionStorage from '../../core/session/session-storage.js';

export function createSessionExportCommand(): Command {
  const command = new Command('export')
    .description('Export session to JSON')
    .argument('<name>', 'Session name or ID')
    .option('--output <file>', 'Output file path (default: stdout)')
    .action(async (name: string, options) => {
      try {
        const storage = new SessionStorage();
        const json = await storage.export(name);

        if (options.output) {
          await fs.writeFile(options.output, json, 'utf-8');
          console.log(chalk.green(`✅ Session exported to: ${options.output}`));
        } else {
          console.log(json);
        }

        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

export default createSessionExportCommand;
