/**
 * Session Commands
 *
 * Commands for session management and checkpointing
 */

import { Command } from 'commander';
import { createSessionSaveCommand } from './save.js';
import { createSessionLoadCommand } from './load.js';
import { createSessionListCommand } from './list.js';
import { createSessionDeleteCommand } from './delete.js';
import { createSessionExportCommand } from './export.js';
import { createSessionImportCommand } from './import.js';
import { createSessionResumeCommand } from './resume.js';

export function createSessionCommand(): Command {
  const command = new Command('session')
    .description('Session management commands');

  // Add subcommands
  command.addCommand(createSessionSaveCommand());
  command.addCommand(createSessionLoadCommand());
  command.addCommand(createSessionListCommand());
  command.addCommand(createSessionDeleteCommand());
  command.addCommand(createSessionExportCommand());
  command.addCommand(createSessionImportCommand());
  command.addCommand(createSessionResumeCommand());

  return command;
}

export default createSessionCommand;
