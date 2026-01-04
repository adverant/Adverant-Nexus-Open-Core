/**
 * Agent List Command
 *
 * List all active and recent agent tasks
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { AgentClient } from '../../core/agent-client.js';
import type { AgentStatus } from '../../types/agent.js';

export function createAgentListCommand(): Command {
  const command = new Command('list')
    .description('List all agent tasks')
    .option('--status <status>', 'Filter by status (running|completed|failed)', '')
    .option('--limit <n>', 'Maximum number of tasks to show', '20')
    .option('--output-format <format>', 'Output format (text|json|table)', 'table')
    .option('--agent-url <url>', 'OrchestrationAgent service URL', 'http://localhost:9109')
    .action(async (options) => {
      try {
        const client = new AgentClient(options.agentUrl);
        let tasks = await client.listTasks();

        // Filter by status if specified
        if (options.status) {
          tasks = tasks.filter(task => task.status === options.status);
        }

        // Limit results
        const limit = parseInt(options.limit, 10);
        tasks = tasks.slice(0, limit);

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(tasks, null, 2));
        } else if (options.outputFormat === 'table') {
          displayTasksTable(tasks);
        } else {
          displayTasksText(tasks);
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
 * Display tasks as formatted text
 */
function displayTasksText(tasks: AgentStatus[]): void {
  if (tasks.length === 0) {
    console.log(chalk.yellow('No agent tasks found'));
    return;
  }

  console.log(chalk.bold.cyan(`\n🤖 Agent Tasks (${tasks.length})\n`));

  tasks.forEach(task => {
    console.log(chalk.bold('Task ID:'), task.taskId);
    console.log(chalk.bold('Status:'), getStatusDisplay(task.status));
    console.log(
      chalk.bold('Progress:'),
      `${task.currentIteration}/${task.maxIterations} iterations`
    );

    if (task.startedAt) {
      console.log(chalk.bold('Started:'), task.startedAt.toLocaleString());
    }

    if (task.result?.summary) {
      console.log(chalk.bold('Summary:'), task.result.summary.substring(0, 80) + '...');
    }

    console.log(''); // Empty line between tasks
  });
}

/**
 * Display tasks as table
 */
function displayTasksTable(tasks: AgentStatus[]): void {
  if (tasks.length === 0) {
    console.log(chalk.yellow('No agent tasks found'));
    return;
  }

  const table = new Table({
    head: [
      chalk.bold('Task ID'),
      chalk.bold('Status'),
      chalk.bold('Progress'),
      chalk.bold('Started'),
      chalk.bold('Summary'),
    ],
    colWidths: [15, 12, 12, 20, 45],
  });

  tasks.forEach(task => {
    table.push([
      task.taskId.substring(0, 12) + '...',
      getStatusDisplay(task.status),
      `${task.currentIteration}/${task.maxIterations}`,
      task.startedAt ? task.startedAt.toLocaleString() : '-',
      task.result?.summary
        ? task.result.summary.substring(0, 42) + '...'
        : task.error
        ? chalk.red('Error: ' + task.error.substring(0, 35))
        : '-',
    ]);
  });

  console.log(table.toString());
  console.log(chalk.gray(`\nShowing ${tasks.length} tasks`));
}

/**
 * Get colored status display
 */
function getStatusDisplay(status: string): string {
  switch (status) {
    case 'pending':
      return chalk.gray('Pending');
    case 'running':
      return chalk.yellow('Running');
    case 'completed':
      return chalk.green('Complete');
    case 'failed':
      return chalk.red('Failed');
    case 'cancelled':
      return chalk.red('Cancelled');
    default:
      return status;
  }
}

export default createAgentListCommand;
