/**
 * ReAct Event Handler
 *
 * Processes and displays ReAct loop events (thought-action-observation cycles)
 * Handles user approval prompts and progress tracking
 */

import ora, { Ora } from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import type {
  ReActEvent,
  ReActOptions,
  AgentResult,
  CommandApproval,
  ApprovalResult,
} from '../types/agent.js';

/**
 * Handle a stream of ReAct events
 * Returns the final agent result
 */
export async function handleReActStream(
  stream: AsyncIterable<ReActEvent>,
  options: ReActOptions = {}
): Promise<AgentResult> {
  let spinner: Ora | null = null;
  let currentIteration = 0;
  let result: AgentResult | null = null;

  console.log(chalk.bold.cyan('\n🤖 Autonomous Agent Starting...\n'));

  try {
    for await (const event of stream) {
      currentIteration = Math.max(currentIteration, event.iteration);

      switch (event.type) {
        case 'thought':
          if (spinner) spinner.stop();
          displayThought(event, currentIteration);
          if (options.onThought) {
            options.onThought({
              iteration: event.iteration,
              content: event.content,
              reasoning: event.metadata?.reasoning,
              timestamp: event.timestamp,
            });
          }
          break;

        case 'action':
          if (spinner) spinner.stop();
          const shouldExecute = await displayAction(event, currentIteration, options);
          if (!shouldExecute) {
            throw new Error('Action denied by user');
          }
          spinner = ora({
            text: chalk.gray('Executing action...'),
            color: 'yellow',
          }).start();
          break;

        case 'observation':
          if (spinner) spinner.stop();
          displayObservation(event, currentIteration);
          if (options.onObservation) {
            options.onObservation({
              iteration: event.iteration,
              content: event.content,
              success: event.metadata?.success ?? true,
              error: event.metadata?.error,
              data: event.metadata?.data,
              timestamp: event.timestamp,
            });
          }
          break;

        case 'approval-required':
          if (spinner) spinner.stop();
          const approval = await handleApprovalRequest(event);
          // Approval is sent back via the client
          break;

        case 'complete':
          if (spinner) spinner.stop();
          result = event.metadata as AgentResult;
          displayCompletion(event, result);
          if (options.onComplete) {
            options.onComplete(result);
          }
          break;

        case 'error':
          if (spinner) spinner.stop();
          displayError(event);
          if (options.onError) {
            options.onError(new Error(event.content));
          }
          throw new Error(event.content);
      }
    }

    if (!result) {
      throw new Error('Agent stream ended without completion event');
    }

    return result;
  } finally {
    if (spinner) spinner.stop();
  }
}

/**
 * Display a thought event
 */
function displayThought(event: ReActEvent, iteration: number): void {
  console.log(
    chalk.magenta(`\n💭 [Iteration ${iteration}] Thought:`)
  );
  console.log(chalk.gray('   ' + event.content));

  if (event.metadata?.reasoning) {
    console.log(chalk.gray('   Reasoning: ' + event.metadata.reasoning));
  }
}

/**
 * Display an action event and handle approval if needed
 */
async function displayAction(
  event: ReActEvent,
  iteration: number,
  options: ReActOptions
): Promise<boolean> {
  console.log(
    chalk.blue(`\n⚡ [Iteration ${iteration}] Action:`)
  );
  console.log(chalk.gray('   ' + event.content));

  if (event.metadata?.tool) {
    console.log(chalk.gray(`   Tool: ${event.metadata.tool}`));
  }

  if (event.metadata?.params) {
    console.log(chalk.gray(`   Params: ${JSON.stringify(event.metadata.params, null, 2).split('\n').join('\n   ')}`));
  }

  // Check if approval is required
  if (event.metadata?.requiresApproval && !options.approveCommands) {
    const approval: CommandApproval = {
      action: {
        iteration: event.iteration,
        action: event.content,
        tool: event.metadata.tool,
        params: event.metadata.params,
        requiresApproval: true,
        timestamp: event.timestamp,
      },
      command: event.content,
      safetyLevel: event.metadata.safetyLevel || 'moderate',
      reason: event.metadata.reason,
    };

    const result = await promptForApproval(approval);

    if (options.onAction) {
      return await options.onAction(approval.action);
    }

    return result.approved;
  }

  // Auto-approve if configured
  if (options.approveCommands || !event.metadata?.requiresApproval) {
    if (options.onAction) {
      return await options.onAction({
        iteration: event.iteration,
        action: event.content,
        tool: event.metadata?.tool,
        params: event.metadata?.params,
        timestamp: event.timestamp,
      });
    }
    return true;
  }

  return true;
}

/**
 * Display an observation event
 */
function displayObservation(event: ReActEvent, iteration: number): void {
  const success = event.metadata?.success !== false;
  const icon = success ? '👁️' : '❌';
  const color = success ? 'green' : 'red';

  console.log(
    chalk[color](`\n${icon} [Iteration ${iteration}] Observation:`)
  );
  console.log(chalk.gray('   ' + event.content));

  if (event.metadata?.error) {
    console.log(chalk.red('   Error: ' + event.metadata.error));
  }
}

/**
 * Display completion event
 */
function displayCompletion(event: ReActEvent, result: AgentResult): void {
  console.log(chalk.bold.green('\n✅ Task Completed!\n'));
  console.log(chalk.bold('Summary:'));
  console.log(chalk.gray('   ' + result.summary));

  if (result.iterations) {
    console.log(chalk.gray(`   Iterations: ${result.iterations}`));
  }

  if (result.duration) {
    console.log(chalk.gray(`   Duration: ${(result.duration / 1000).toFixed(2)}s`));
  }

  if (result.cost) {
    console.log(chalk.gray(`   Cost: $${result.cost.toFixed(4)}`));
  }

  if (result.artifacts && result.artifacts.length > 0) {
    console.log(chalk.bold('\nArtifacts:'));
    result.artifacts.forEach(artifact => {
      console.log(chalk.gray(`   - ${artifact.name} (${artifact.type})`));
    });
  }

  if (result.learnings && result.learnings.length > 0) {
    console.log(chalk.bold('\nLearnings:'));
    result.learnings.forEach(learning => {
      console.log(chalk.gray(`   - ${learning}`));
    });
  }
}

/**
 * Display error event
 */
function displayError(event: ReActEvent): void {
  console.log(chalk.bold.red('\n❌ Agent Error:\n'));
  console.log(chalk.red(event.content));

  if (event.metadata?.stack) {
    console.log(chalk.gray('\nStack trace:'));
    console.log(chalk.gray(event.metadata.stack));
  }
}

/**
 * Handle approval request event
 */
async function handleApprovalRequest(event: ReActEvent): Promise<ApprovalResult> {
  const approval: CommandApproval = {
    action: {
      iteration: event.iteration,
      action: event.content,
      timestamp: event.timestamp,
    },
    command: event.content,
    safetyLevel: event.metadata?.safetyLevel || 'moderate',
    reason: event.metadata?.reason,
  };

  return await promptForApproval(approval);
}

/**
 * Prompt user for approval
 */
async function promptForApproval(approval: CommandApproval): Promise<ApprovalResult> {
  console.log(chalk.yellow('\n⚠️  Approval Required\n'));
  console.log(chalk.bold('Command:'), approval.command);
  console.log(chalk.bold('Safety Level:'), getSafetyLevelDisplay(approval.safetyLevel));

  if (approval.reason) {
    console.log(chalk.bold('Reason:'), approval.reason);
  }

  const answer = await inquirer.prompt([
    {
      type: 'list',
      name: 'decision',
      message: 'Do you want to approve this action?',
      choices: [
        { name: 'Approve', value: 'approve' },
        { name: 'Modify and approve', value: 'modify' },
        { name: 'Deny', value: 'deny' },
        { name: 'Abort task', value: 'abort' },
      ],
    },
  ]);

  switch (answer.decision) {
    case 'approve':
      return { approved: true };

    case 'modify':
      const modifiedAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'command',
          message: 'Enter modified command:',
          default: approval.command,
        },
      ]);
      return {
        approved: true,
        modifiedCommand: modifiedAnswer.command,
      };

    case 'deny':
      return { approved: false, reason: 'User denied' };

    case 'abort':
      throw new Error('Task aborted by user');

    default:
      return { approved: false };
  }
}

/**
 * Get safety level display with color
 */
function getSafetyLevelDisplay(level: 'safe' | 'moderate' | 'dangerous'): string {
  switch (level) {
    case 'safe':
      return chalk.green('Safe');
    case 'moderate':
      return chalk.yellow('Moderate');
    case 'dangerous':
      return chalk.red('Dangerous');
    default:
      return chalk.gray('Unknown');
  }
}

/**
 * Display progress bar for iterations
 */
export function displayProgress(current: number, total: number): void {
  const percentage = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 20);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);

  console.log(
    chalk.cyan(`\nProgress: [${bar}] ${percentage}% (${current}/${total} iterations)`)
  );
}
