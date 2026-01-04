/**
 * Session List Command
 *
 * List all saved sessions
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import SessionStorage from '../../core/session/session-storage.js';

export function createSessionListCommand(): Command {
  const command = new Command('list')
    .description('List all saved sessions')
    .option('--output-format <format>', 'Output format (text|json|table)', 'table')
    .option('--limit <n>', 'Maximum number of sessions to show', '20')
    .action(async (options) => {
      try {
        const storage = new SessionStorage();
        let sessions = await storage.list();

        // Limit results
        const limit = parseInt(options.limit, 10);
        sessions = sessions.slice(0, limit);

        if (sessions.length === 0) {
          console.log(chalk.yellow('No saved sessions found'));
          console.log(chalk.gray('Use "nexus session save" to create a session'));
          process.exit(0);
        }

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (options.outputFormat === 'table') {
          displaySessionsTable(sessions);
        } else {
          displaySessionsText(sessions);
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
 * Display sessions as table
 */
function displaySessionsTable(sessions: any[]): void {
  const table = new Table({
    head: [
      chalk.bold('Name'),
      chalk.bold('Commands'),
      chalk.bold('Created'),
      chalk.bold('Updated'),
      chalk.bold('Tags'),
    ],
    colWidths: [25, 12, 20, 20, 25],
  });

  sessions.forEach(session => {
    table.push([
      session.name,
      session.commandCount.toString(),
      new Date(session.created).toLocaleDateString(),
      new Date(session.updated).toLocaleDateString(),
      session.tags.join(', ') || '-',
    ]);
  });

  console.log(table.toString());
  console.log(chalk.gray(`\nTotal: ${sessions.length} sessions`));
}

/**
 * Display sessions as text
 */
function displaySessionsText(sessions: any[]): void {
  console.log(chalk.bold.cyan(`\n📋 Saved Sessions (${sessions.length})\n`));

  sessions.forEach(session => {
    console.log(chalk.bold('Name:'), session.name);
    console.log(chalk.gray(`  Created: ${new Date(session.created).toLocaleString()}`));
    console.log(chalk.gray(`  Updated: ${new Date(session.updated).toLocaleString()}`));
    console.log(chalk.gray(`  Commands: ${session.commandCount}`));

    if (session.tags.length > 0) {
      console.log(chalk.gray(`  Tags: ${session.tags.join(', ')}`));
    }

    console.log(''); // Empty line
  });
}

export default createSessionListCommand;
