/**
 * Compute Commands
 *
 * Commands for local compute management and job submission.
 * Enables using local machines (MacBook, Mac Studio) as ML compute nodes.
 */

import { Command } from 'commander';
import { createComputeAgentCommand } from './agent.js';
import { createComputeResourcesCommand } from './resources.js';
import { createComputeStatusCommand } from './status.js';
import { createComputeSubmitCommand } from './submit.js';
import { createComputeListCommand } from './list.js';
import { createComputeLogsCommand } from './logs.js';

export function createComputeCommand(): Command {
  const command = new Command('compute')
    .description('Local compute management - use your Mac as an ML compute node');

  // Add subcommands
  command.addCommand(createComputeAgentCommand());
  command.addCommand(createComputeResourcesCommand());
  command.addCommand(createComputeStatusCommand());
  command.addCommand(createComputeSubmitCommand());
  command.addCommand(createComputeListCommand());
  command.addCommand(createComputeLogsCommand());

  return command;
}

export default createComputeCommand;
