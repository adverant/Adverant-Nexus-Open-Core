/**
 * Agent Status Command
 *
 * Check the status of a running or completed agent task
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { AgentClient } from '../../core/agent-client.js';
import type { AgentStatus } from '../../types/agent.js';

export function createAgentStatusCommand(): Command {
  const command = new Command('status')
    .description('Check agent task status')
    .requiredOption('--id <task-id>', 'Agent task ID')
    .option('--output-format <format>', 'Output format (text|json|table)', 'text')
    .option('--agent-url <url>', 'OrchestrationAgent service URL', 'http://localhost:9109')
    .option('--verbose', 'Show detailed information', false)
    .action(async (options) => {
      try {
        const client = new AgentClient(options.agentUrl);
        const status = await client.getStatus(options.id);

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(status, null, 2));
        } else if (options.outputFormat === 'table') {
          displayStatusTable(status);
        } else {
          displayStatusText(status, options.verbose);
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
 * Display status as formatted text
 */
function displayStatusText(status: AgentStatus, verbose: boolean): void {
  console.log(chalk.bold.cyan('\n🤖 Agent Task Status\n'));

  console.log(chalk.bold('Task ID:'), status.taskId);
  console.log(chalk.bold('Status:'), getStatusDisplay(status.status));
  console.log(
    chalk.bold('Progress:'),
    `${status.currentIteration}/${status.maxIterations} iterations`
  );

  if (status.startedAt) {
    console.log(chalk.bold('Started:'), status.startedAt.toLocaleString());
  }

  if (status.completedAt) {
    console.log(chalk.bold('Completed:'), status.completedAt.toLocaleString());
  }

  if (status.estimatedCompletion && status.status === 'running') {
    console.log(
      chalk.bold('Estimated Completion:'),
      status.estimatedCompletion.toLocaleString()
    );
  }

  if (status.metadata) {
    if (status.metadata.totalCost) {
      console.log(chalk.bold('Cost:'), `$${status.metadata.totalCost.toFixed(4)}`);
    }
    if (status.metadata.tokensUsed) {
      console.log(chalk.bold('Tokens Used:'), status.metadata.tokensUsed.toLocaleString());
    }
    if (status.metadata.toolsCalled) {
      console.log(chalk.bold('Tools Called:'), status.metadata.toolsCalled);
    }
  }

  if (verbose) {
    displayDetailedProgress(status);
  }

  if (status.error) {
    console.log(chalk.bold.red('\nError:'), status.error);
  }

  if (status.result) {
    console.log(chalk.bold.green('\n✅ Result:'));
    console.log(chalk.gray('   ' + status.result.summary));

    if (status.result.artifacts && status.result.artifacts.length > 0) {
      console.log(chalk.bold('\nArtifacts:'));
      status.result.artifacts.forEach(artifact => {
        console.log(chalk.gray(`   - ${artifact.name} (${artifact.type})`));
      });
    }
  }
}

/**
 * Display detailed progress information
 */
function displayDetailedProgress(status: AgentStatus): void {
  if (status.thoughts.length > 0) {
    console.log(chalk.bold('\n💭 Recent Thoughts:'));
    status.thoughts.slice(-3).forEach(thought => {
      console.log(
        chalk.gray(`   [${thought.iteration}] ${thought.content.substring(0, 100)}${thought.content.length > 100 ? '...' : ''}`)
      );
    });
  }

  if (status.actions.length > 0) {
    console.log(chalk.bold('\n⚡ Recent Actions:'));
    status.actions.slice(-3).forEach(action => {
      console.log(
        chalk.gray(`   [${action.iteration}] ${action.action}${action.tool ? ` (${action.tool})` : ''}`)
      );
    });
  }

  if (status.observations.length > 0) {
    console.log(chalk.bold('\n👁️  Recent Observations:'));
    status.observations.slice(-3).forEach(obs => {
      const icon = obs.success ? '✓' : '✗';
      console.log(
        chalk.gray(`   [${obs.iteration}] ${icon} ${obs.content.substring(0, 100)}${obs.content.length > 100 ? '...' : ''}`)
      );
    });
  }
}

/**
 * Display status as table
 */
function displayStatusTable(status: AgentStatus): void {
  const table = new Table({
    head: [chalk.bold('Property'), chalk.bold('Value')],
    colWidths: [25, 55],
  });

  table.push(
    ['Task ID', status.taskId],
    ['Status', getStatusDisplay(status.status)],
    ['Progress', `${status.currentIteration}/${status.maxIterations}`]
  );

  if (status.startedAt) {
    table.push(['Started', status.startedAt.toLocaleString()]);
  }

  if (status.completedAt) {
    table.push(['Completed', status.completedAt.toLocaleString()]);
  }

  if (status.metadata?.totalCost) {
    table.push(['Cost', `$${status.metadata.totalCost.toFixed(4)}`]);
  }

  if (status.metadata?.tokensUsed) {
    table.push(['Tokens Used', status.metadata.tokensUsed.toLocaleString()]);
  }

  if (status.result) {
    table.push(['Summary', status.result.summary]);
  }

  if (status.error) {
    table.push(['Error', status.error]);
  }

  console.log(table.toString());
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
      return chalk.green('Completed');
    case 'failed':
      return chalk.red('Failed');
    case 'cancelled':
      return chalk.red('Cancelled');
    default:
      return status;
  }
}

export default createAgentStatusCommand;
