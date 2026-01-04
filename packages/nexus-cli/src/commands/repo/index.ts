/**
 * Repository Analysis Commands
 *
 * Commands for AI-powered repository analysis and architecture discovery
 */

import { Command } from 'commander';
import { createRepoAnalyzeCommand } from './analyze.js';
import { createRepoDetectCommand } from './detect.js';
import { createRepoExportCommand } from './export.js';

export function createRepoCommand(): Command {
  const command = new Command('repo')
    .description('AI-powered repository analysis and architecture discovery');

  // Add subcommands
  command.addCommand(createRepoAnalyzeCommand());
  command.addCommand(createRepoDetectCommand());
  command.addCommand(createRepoExportCommand());

  return command;
}

export default createRepoCommand;
