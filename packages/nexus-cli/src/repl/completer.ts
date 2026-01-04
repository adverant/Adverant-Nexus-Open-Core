/**
 * Tab Completion for Nexus REPL
 *
 * Provides intelligent tab completion for commands, options, and arguments
 */

import type { Command } from '../types/command.js';
import type { REPLContext } from '../core/session/context-manager.js';

export interface CompletionResult {
  completions: string[];
  line: string;
}

export class Completer {
  private commands: Map<string, Command[]> = new Map();
  private builtInCommands = [
    'help',
    'services',
    'use',
    'history',
    'clear',
    'save',
    'load',
    'sessions',
    'config',
    'exit',
    'quit',
  ];

  constructor(commands: Map<string, Command[]>) {
    this.commands = commands;
  }

  /**
   * Complete the given line
   * Returns [completions, originalLine]
   */
  complete(line: string, context: REPLContext): [string[], string] {
    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);

    // Empty line - show all available commands
    if (trimmed.length === 0) {
      return [this.getAllCompletions(context), line];
    }

    // First word - complete command or namespace
    if (parts.length === 1) {
      const completions = this.completeCommand(parts[0], context);
      return [completions, line];
    }

    // Second word onwards - complete options or arguments
    const command = parts[0];
    const currentWord = parts[parts.length - 1];

    // Check if completing an option
    if (currentWord.startsWith('--')) {
      return [this.completeOption(command, currentWord, context), line];
    }

    if (currentWord.startsWith('-')) {
      return [this.completeShortOption(command, currentWord, context), line];
    }

    // Complete argument values
    return [this.completeArgument(command, parts.length - 1, currentWord, context), line];
  }

  /**
   * Complete command names
   */
  private completeCommand(partial: string, context: REPLContext): string[] {
    const allCommands = this.getAllCompletions(context);
    return allCommands.filter(cmd => cmd.startsWith(partial));
  }

  /**
   * Get all available completions
   */
  private getAllCompletions(context: REPLContext): string[] {
    const completions: string[] = [];

    // Add built-in REPL commands
    completions.push(...this.builtInCommands);

    // If in a namespace, add namespace-specific commands
    if (context.namespace) {
      const namespaceCommands = this.commands.get(context.namespace) || [];
      completions.push(...namespaceCommands.map(cmd => cmd.name));
    } else {
      // Add all namespaces
      completions.push(...this.commands.keys());

      // Add global commands (no namespace)
      const globalCommands = this.commands.get('') || [];
      completions.push(...globalCommands.map(cmd => cmd.name));
    }

    return [...new Set(completions)].sort();
  }

  /**
   * Complete long options (--option)
   */
  private completeOption(
    commandName: string,
    partial: string,
    context: REPLContext
  ): string[] {
    const command = this.findCommand(commandName, context);

    if (!command || !command.options) {
      return [];
    }

    const options = command.options
      .map(opt => `--${opt.long}`)
      .filter(opt => opt.startsWith(partial));

    return options;
  }

  /**
   * Complete short options (-o)
   */
  private completeShortOption(
    commandName: string,
    partial: string,
    context: REPLContext
  ): string[] {
    const command = this.findCommand(commandName, context);

    if (!command || !command.options) {
      return [];
    }

    const options = command.options
      .filter(opt => opt.short)
      .map(opt => `-${opt.short}`)
      .filter(opt => opt.startsWith(partial));

    return options;
  }

  /**
   * Complete argument values
   */
  private completeArgument(
    commandName: string,
    argIndex: number,
    partial: string,
    context: REPLContext
  ): string[] {
    const command = this.findCommand(commandName, context);

    if (!command || !command.args) {
      return [];
    }

    const arg = command.args[argIndex - 1]; // -1 because first part is command name

    if (!arg) {
      return [];
    }

    // If arg has choices, return matching choices
    if (arg.choices) {
      return arg.choices
        .map(c => String(c))
        .filter(c => c.startsWith(partial));
    }

    // For file/directory types, could do path completion (not implemented here)
    if (arg.type === 'file' || arg.type === 'directory') {
      // TODO: Implement path completion
      return [];
    }

    return [];
  }

  /**
   * Find command by name in current context
   */
  private findCommand(name: string, context: REPLContext): Command | undefined {
    // If in namespace, look there first
    if (context.namespace) {
      const namespaceCommands = this.commands.get(context.namespace) || [];
      const found = namespaceCommands.find(cmd => cmd.name === name);
      if (found) return found;
    }

    // Look in all namespaces
    for (const commands of this.commands.values()) {
      const found = commands.find(cmd => cmd.name === name);
      if (found) return found;
    }

    return undefined;
  }

  /**
   * Update available commands
   */
  updateCommands(commands: Map<string, Command[]>): void {
    this.commands = commands;
  }

  /**
   * Get help text for a completion
   */
  getCompletionHelp(completion: string, context: REPLContext): string | undefined {
    // Check if it's a built-in command
    if (this.builtInCommands.includes(completion)) {
      return this.getBuiltInHelp(completion);
    }

    // Check if it's a namespace
    if (this.commands.has(completion)) {
      const commands = this.commands.get(completion) || [];
      return `Namespace with ${commands.length} commands`;
    }

    // Check if it's a command
    const command = this.findCommand(completion, context);
    if (command) {
      return command.description;
    }

    return undefined;
  }

  /**
   * Get help for built-in commands
   */
  private getBuiltInHelp(command: string): string {
    const helpTexts: Record<string, string> = {
      help: 'Show available commands',
      services: 'List discovered services',
      use: 'Switch to a service namespace',
      history: 'Show command history',
      clear: 'Clear the screen',
      save: 'Save current session',
      load: 'Load a saved session',
      sessions: 'List available sessions',
      config: 'Show configuration',
      exit: 'Exit REPL',
      quit: 'Exit REPL',
    };

    return helpTexts[command] || '';
  }
}
