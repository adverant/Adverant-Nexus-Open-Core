/**
 * Session Load Command
 *
 * Load a saved session from disk
 */

import { Command } from 'commander';
import chalk from 'chalk';
import SessionStorage from '../../core/session/session-storage.js';

export function createSessionLoadCommand(): Command {
  const command = new Command('load')
    .description('Load a saved session')
    .argument('<name>', 'Session name or ID')
    .option('--output-format <format>', 'Output format (text|json)', 'text')
    .action(async (name: string, options) => {
      try {
        const storage = new SessionStorage();
        const session = await storage.load(name);

        if (!session) {
          console.error(chalk.red(`Session not found: ${name}`));
          process.exit(1);
        }

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(session, null, 2));
        } else {
          displaySession(session);
        }

        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Display session information
 */
function displaySession(session: any): void {
  console.log(chalk.bold.cyan('\n📋 Session Loaded\n'));

  console.log(chalk.bold('Name:'), session.name);
  console.log(chalk.bold('ID:'), session.id);
  console.log(chalk.bold('Created:'), new Date(session.created).toLocaleString());
  console.log(chalk.bold('Updated:'), new Date(session.updated).toLocaleString());

  console.log(chalk.bold('\nContext:'));
  console.log(chalk.gray(`  Working Directory: ${session.context.cwd}`));

  if (session.metadata) {
    console.log(chalk.bold('\nStatistics:'));
    console.log(chalk.gray(`  Total Commands: ${session.metadata.totalCommands}`));
    console.log(chalk.gray(`  Successful: ${session.metadata.successfulCommands}`));
    console.log(chalk.gray(`  Failed: ${session.metadata.failedCommands}`));

    if (session.metadata.totalDuration) {
      console.log(
        chalk.gray(`  Total Duration: ${(session.metadata.totalDuration / 1000).toFixed(2)}s`)
      );
    }

    if (session.metadata.tags && session.metadata.tags.length > 0) {
      console.log(chalk.gray(`  Tags: ${session.metadata.tags.join(', ')}`));
    }
  }

  if (session.history && session.history.length > 0) {
    console.log(chalk.bold('\nRecent Commands:'));
    session.history.slice(-5).forEach((entry: any) => {
      console.log(chalk.gray(`  - ${entry.command}`));
    });
  }

  if (session.nexusMemories && session.nexusMemories.length > 0) {
    console.log(chalk.bold('\nLinked Nexus Memories:'), session.nexusMemories.length);
  }
}

export default createSessionLoadCommand;
