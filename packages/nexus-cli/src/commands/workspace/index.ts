/**
 * Workspace Commands
 *
 * Commands for workspace management and git integration
 */

import { Command } from 'commander';
import { createWorkspaceInfoCommand } from './info.js';
import { createWorkspaceInitCommand } from './init.js';
import { createWorkspaceValidateCommand } from './validate.js';
import { createWorkspaceGitStatusCommand } from './git-status.js';
import { createWorkspaceGitCommitCommand } from './git-commit.js';

export function createWorkspaceCommand(): Command {
  const command = new Command('workspace')
    .description('Workspace management commands');

  // Add subcommands
  command.addCommand(createWorkspaceInfoCommand());
  command.addCommand(createWorkspaceInitCommand());
  command.addCommand(createWorkspaceValidateCommand());
  command.addCommand(createWorkspaceGitStatusCommand());
  command.addCommand(createWorkspaceGitCommitCommand());

  return command;
}

export default createWorkspaceCommand;
