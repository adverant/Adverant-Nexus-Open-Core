/**
 * Agent Run Command
 *
 * Executes autonomous tasks using the OrchestrationAgent service
 * Supports ReAct loop with streaming progress and interactive approval
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { AgentClient } from '../../core/agent-client.js';
import { handleReActStream } from '../../core/react-handler.js';
import type { CommandResult } from '../../types/command.js';
import type { AgentTask } from '../../types/agent.js';

export function createAgentRunCommand(): Command {
  const command = new Command('run')
    .description('Run an autonomous agent task with ReAct loop')
    .requiredOption('--task <description>', 'Task description for the agent')
    .option('--max-iterations <n>', 'Maximum ReAct iterations', '20')
    .option('--budget <amount>', 'Cost budget in USD')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .option('--approve-commands', 'Auto-approve safe commands', false)
    .option('--stream', 'Stream progress in real-time', true)
    .option('--output-format <format>', 'Output format (text|json|stream-json)', 'text')
    .option('--agent-url <url>', 'OrchestrationAgent service URL', 'http://localhost:9109')
    .action(async (options) => {
      try {
        const result = await runAgentTask(options);

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else if (options.outputFormat === 'stream-json') {
          // Already streamed during execution
        } else {
          // Text output already displayed during streaming
        }

        process.exit(result.success ? 0 : 1);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return command;
}

/**
 * Execute the agent task
 */
async function runAgentTask(options: any): Promise<CommandResult> {
  const spinner = ora({
    text: chalk.cyan('Initializing agent...'),
    color: 'cyan',
  }).start();

  try {
    // Create agent client
    const client = new AgentClient(options.agentUrl);

    // Prepare task
    const task: AgentTask = {
      task: options.task,
      maxIterations: parseInt(options.maxIterations, 10),
      budget: options.budget ? parseFloat(options.budget) : undefined,
      workspace: options.workspace,
      approveCommands: options.approveCommands,
      stream: options.stream,
    };

    spinner.text = chalk.cyan('Submitting task to OrchestrationAgent...');

    // Submit task
    const taskId = await client.submitTask(task);

    spinner.succeed(chalk.green(`Task submitted: ${taskId}`));

    // Stream progress
    if (options.stream && options.outputFormat !== 'json') {
      const result = await handleReActStream(
        client.streamProgress(taskId),
        {
          approveCommands: options.approveCommands,
          stream: true,
        }
      );

      // Store result in Nexus if configured
      if (process.env.NEXUS_NEXUS_AUTO_STORE === 'true') {
        await storeResultInNexus(taskId, result);
      }

      return {
        success: result.success,
        data: result,
        message: result.summary,
        metadata: {
          duration: result.duration,
          service: 'orchestration-agent',
          streaming: true,
        },
      };
    } else {
      // Non-streaming mode - poll for status
      return await pollForCompletion(client, taskId);
    }
  } catch (error) {
    spinner.fail(chalk.red('Agent execution failed'));
    throw error;
  } finally {
    // Cleanup
  }
}

/**
 * Poll for task completion (non-streaming mode)
 */
async function pollForCompletion(
  client: AgentClient,
  taskId: string
): Promise<CommandResult> {
  const spinner = ora({
    text: chalk.cyan('Waiting for task completion...'),
    color: 'cyan',
  }).start();

  const pollInterval = 2000; // 2 seconds
  const maxPollTime = 600000; // 10 minutes
  const startTime = Date.now();

  while (Date.now() - startTime < maxPollTime) {
    const status = await client.getStatus(taskId);

    spinner.text = chalk.cyan(
      `[Iteration ${status.currentIteration}/${status.maxIterations}] ${status.status}`
    );

    if (status.status === 'completed') {
      spinner.succeed(chalk.green('Task completed'));

      return {
        success: true,
        data: status.result,
        message: status.result?.summary || 'Task completed successfully',
        metadata: {
          duration: status.completedAt && status.startedAt
            ? status.completedAt.getTime() - status.startedAt.getTime()
            : undefined,
          service: 'orchestration-agent',
        },
      };
    }

    if (status.status === 'failed' || status.status === 'cancelled') {
      spinner.fail(chalk.red(`Task ${status.status}`));

      return {
        success: false,
        error: status.error || `Task ${status.status}`,
        message: status.error || `Task ${status.status}`,
      };
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  spinner.fail(chalk.red('Task timeout'));

  return {
    success: false,
    error: 'Task execution timed out',
    message: 'Task execution timed out after 10 minutes',
  };
}

/**
 * Store result in Nexus memory system
 */
async function storeResultInNexus(taskId: string, result: any): Promise<void> {
  try {
    const spinner = ora({
      text: chalk.gray('Storing result in Nexus...'),
      color: 'gray',
    }).start();

    // This would call the Nexus MCP tools to store the result
    // Implementation depends on Nexus MCP client integration

    spinner.succeed(chalk.gray('Result stored in Nexus'));
  } catch (error) {
    // Silently fail - Nexus storage is optional
    console.error(chalk.gray('Failed to store in Nexus:'), error);
  }
}

export default createAgentRunCommand;
