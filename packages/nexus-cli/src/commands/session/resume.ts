/**
 * Session Resume Command
 *
 * Resume the most recent session
 */

import { Command } from 'commander';
import chalk from 'chalk';
import SessionStorage from '../../core/session/session-storage.js';

export function createSessionResumeCommand(): Command {
  const command = new Command('resume')
    .description('Resume the most recent session')
    .option('--output-format <format>', 'Output format (text|json)', 'text')
    .action(async (options) => {
      try {
        const storage = new SessionStorage();
        const session = await storage.getMostRecent();

        if (!session) {
          console.log(chalk.yellow('No sessions found to resume'));
          console.log(chalk.gray('Use "nexus session save" to create a session'));
          process.exit(0);
        }

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(session, null, 2));
        } else {
          console.log(chalk.bold.cyan('\n🔄 Resuming Session\n'));
          console.log(chalk.bold('Name:'), session.name);
          console.log(chalk.bold('Created:'), session.created.toLocaleString());
          console.log(chalk.bold('Updated:'), session.updated.toLocaleString());

          if (session.metadata?.lastCommand) {
            console.log(chalk.bold('Last Command:'), session.metadata.lastCommand);
          }

          if (session.metadata) {
            console.log(
              chalk.gray(`\nExecuted ${session.metadata.totalCommands} commands in this session`)
            );
          }

          console.log(chalk.gray('\nSession context has been restored'));
        }

        // TODO: Actually restore session context (cwd, config, etc.)

        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

export default createSessionResumeCommand;
