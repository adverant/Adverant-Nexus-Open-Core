/**
 * Command Evaluator for Nexus REPL
 *
 * Parses and executes REPL commands
 */

import type { Command, CommandResult } from '../types/command.js';
import type { REPLContext } from '../core/session/context-manager.js';

export interface ParsedCommand {
  type: 'builtin' | 'service' | 'namespace';
  command: string;
  args: string[];
  options: Record<string, any>;
  namespace?: string;
}

export class CommandEvaluator {
  private commands: Map<string, Command[]> = new Map();

  constructor(commands: Map<string, Command[]>) {
    this.commands = commands;
  }

  /**
   * Parse input line into command structure
   */
  parseInput(line: string, context: REPLContext): ParsedCommand | null {
    const trimmed = line.trim();

    if (!trimmed) {
      return null;
    }

    // Split into tokens (handle quoted strings)
    const tokens = this.tokenize(trimmed);

    if (tokens.length === 0) {
      return null;
    }

    const commandName = tokens[0];

    // Check if built-in REPL command
    if (this.isBuiltInCommand(commandName)) {
      return {
        type: 'builtin',
        command: commandName,
        args: tokens.slice(1),
        options: this.parseOptions(tokens.slice(1)),
      };
    }

    // Check if namespace switch
    if (commandName === 'use') {
      return {
        type: 'namespace',
        command: 'use',
        args: tokens.slice(1),
        options: {},
      };
    }

    // In namespace context
    if (context.namespace) {
      return {
        type: 'service',
        command: commandName,
        args: tokens.slice(1),
        options: this.parseOptions(tokens.slice(1)),
        namespace: context.namespace,
      };
    }

    // Check if namespace.command format
    if (commandName.includes('.')) {
      const [namespace, cmd] = commandName.split('.');
      return {
        type: 'service',
        command: cmd,
        args: tokens.slice(1),
        options: this.parseOptions(tokens.slice(1)),
        namespace,
      };
    }

    // Default to service command in global context
    return {
      type: 'service',
      command: commandName,
      args: tokens.slice(1),
      options: this.parseOptions(tokens.slice(1)),
    };
  }

  /**
   * Evaluate parsed command
   */
  async evaluate(
    parsed: ParsedCommand,
    context: REPLContext,
    builtInHandler?: (parsed: ParsedCommand) => Promise<CommandResult>
  ): Promise<CommandResult> {
    try {
      // Handle built-in commands
      if (parsed.type === 'builtin') {
        if (!builtInHandler) {
          return {
            success: false,
            error: 'Built-in command handler not available',
          };
        }
        return await builtInHandler(parsed);
      }

      // Handle namespace switch
      if (parsed.type === 'namespace') {
        if (parsed.args.length === 0) {
          return {
            success: false,
            error: 'Usage: use <namespace>',
          };
        }

        const namespace = parsed.args[0];
        if (!this.commands.has(namespace)) {
          return {
            success: false,
            error: `Unknown namespace: ${namespace}`,
          };
        }

        return {
          success: true,
          data: { namespace },
          message: `Switched to namespace: ${namespace}`,
        };
      }

      // Handle service commands
      if (parsed.type === 'service') {
        const command = this.findCommand(parsed.command, parsed.namespace, context);

        if (!command) {
          return {
            success: false,
            error: `Unknown command: ${parsed.command}${
              parsed.namespace ? ` in namespace ${parsed.namespace}` : ''
            }`,
          };
        }

        // Build command args
        const commandArgs = this.buildCommandArgs(parsed, command);

        // Execute command
        const startTime = Date.now();
        const result = await command.handler(commandArgs, context);
        const duration = Date.now() - startTime;

        return {
          ...result,
          metadata: {
            ...result.metadata,
            duration,
            service: parsed.namespace,
          },
        };
      }

      return {
        success: false,
        error: 'Invalid command type',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Tokenize input line (handle quotes)
   */
  private tokenize(line: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if ((char === '"' || char === "'") && !inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuote) {
        inQuote = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuote) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  /**
   * Parse options from tokens
   */
  private parseOptions(tokens: string[]): Record<string, any> {
    const options: Record<string, any> = {};

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      // Long option: --key=value or --key value
      if (token.startsWith('--')) {
        const key = token.slice(2);

        if (key.includes('=')) {
          const [optKey, optValue] = key.split('=');
          options[optKey] = this.parseValue(optValue);
        } else {
          // Check if next token is the value
          if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
            options[key] = this.parseValue(tokens[i + 1]);
            i++;
          } else {
            // Boolean flag
            options[key] = true;
          }
        }
      }
      // Short option: -k value
      else if (token.startsWith('-') && token.length === 2) {
        const key = token.slice(1);

        if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
          options[key] = this.parseValue(tokens[i + 1]);
          i++;
        } else {
          options[key] = true;
        }
      }
    }

    return options;
  }

  /**
   * Parse value (convert types)
   */
  private parseValue(value: string): any {
    // Boolean
    if (value === 'true') return true;
    if (value === 'false') return false;

    // Number
    if (!isNaN(Number(value)) && value !== '') {
      return Number(value);
    }

    // JSON
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return JSON.parse(value);
      } catch {
        // Not valid JSON, return as string
      }
    }

    return value;
  }

  /**
   * Build command args from parsed input
   */
  private buildCommandArgs(parsed: ParsedCommand, command: Command): any {
    const args: any = {
      _: parsed.args.filter(arg => !arg.startsWith('-')),
      ...parsed.options,
    };

    return args;
  }

  /**
   * Find command by name
   */
  private findCommand(
    name: string,
    namespace: string | undefined,
    context: REPLContext
  ): Command | undefined {
    // If namespace specified, look there
    if (namespace) {
      const commands = this.commands.get(namespace) || [];
      return commands.find(cmd => cmd.name === name);
    }

    // Look in context namespace
    if (context.namespace) {
      const commands = this.commands.get(context.namespace) || [];
      const found = commands.find(cmd => cmd.name === name);
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
   * Check if command is built-in
   */
  private isBuiltInCommand(command: string): boolean {
    return [
      'help',
      'services',
      'history',
      'clear',
      'save',
      'load',
      'sessions',
      'config',
      'exit',
      'quit',
    ].includes(command);
  }

  /**
   * Update available commands
   */
  updateCommands(commands: Map<string, Command[]>): void {
    this.commands = commands;
  }
}
