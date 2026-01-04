/**
 * Session Delete Command
 *
 * Delete a saved session
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import SessionStorage from '../../core/session/session-storage.js';

export function createSessionDeleteCommand(): Command {
  const command = new Command('delete')
    .description('Delete a saved session')
    .argument('<name>', 'Session name or ID')
    .option('--force', 'Skip confirmation prompt', false)
    .action(async (name: string, options) => {
      try {
        const storage = new SessionStorage();

        // Verify session exists
        const session = await storage.load(name);
        if (!session) {
          console.error(chalk.red(`Session not found: ${name}`));
          process.exit(1);
        }

        // Confirm deletion unless --force
        if (!options.force) {
          const answer = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Are you sure you want to delete session "${session.name}"?`,
              default: false,
            },
          ]);

          if (!answer.confirm) {
            console.log(chalk.yellow('Deletion cancelled'));
            process.exit(0);
          }
        }

        await storage.delete(name);

        console.log(chalk.green(`✅ Session deleted: ${session.name}`));
        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

export default createSessionDeleteCommand;
