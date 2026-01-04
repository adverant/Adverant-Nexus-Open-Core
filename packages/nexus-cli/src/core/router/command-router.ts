/**
 * Command Router
 *
 * Routes commands to appropriate handlers
 */

import type {
  Command,
  CommandArgs,
  CommandContext,
  CommandResult,
} from '../../types/command.js';
import { CommandRegistry } from './command-registry.js';

export class CommandRouter {
  constructor(private registry: CommandRegistry) {}

  /**
   * Route and execute a command
   */
  async route(
    commandName: string,
    args: CommandArgs,
    context: CommandContext
  ): Promise<CommandResult> {
    // Try to find command
    const command = this.findCommand(commandName);

    if (!command) {
      return {
        success: false,
        error: `Command '${commandName}' not found. Use 'nexus --help' to see available commands.`,
      };
    }

    // Validate arguments if validator exists
    if (command.validator) {
      const validation = await command.validator(args, context);
      if (!validation.valid) {
        const errors = validation.errors?.map((e) => e.message).join(', ');
        return {
          success: false,
          error: `Validation failed: ${errors}`,
        };
      }
    }

    // Execute command handler
    try {
      const startTime = Date.now();
      const result = await command.handler(args, context);
      const duration = Date.now() - startTime;

      return {
        ...result,
        metadata: {
          ...result.metadata,
          duration,
          service: command.namespace,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Command execution failed',
        metadata: {
          service: command.namespace,
        },
      };
    }
  }

  /**
   * Find command by name, trying multiple resolution strategies
   */
  private findCommand(commandName: string): Command | undefined {
    // Strategy 1: Direct lookup
    let command = this.registry.resolve(commandName);
    if (command) return command;

    // Strategy 2: Try with namespace prefix (e.g., "graphrag:query")
    if (commandName.includes(':')) {
      const [namespace, name] = commandName.split(':', 2);
      command = this.registry.get(name, namespace);
      if (command) return command;
    }

    // Strategy 3: Try common namespaces
    const commonNamespaces = ['services', 'graphrag', 'mageagent', 'sandbox', 'nexus'];
    for (const namespace of commonNamespaces) {
      command = this.registry.get(commandName, namespace);
      if (command) return command;
    }

    // Strategy 4: Try aliases
    const allCommands = this.registry.list();
    for (const cmd of allCommands) {
      if (cmd.aliases?.includes(commandName)) {
        return cmd;
      }
    }

    return undefined;
  }

  /**
   * Get all available commands
   */
  listCommands(namespace?: string): Command[] {
    return this.registry.list(namespace);
  }

  /**
   * Get all namespaces
   */
  listNamespaces(): string[] {
    return this.registry.listNamespaces();
  }

  /**
   * Search commands
   */
  searchCommands(keyword: string): Command[] {
    return this.registry.search(keyword);
  }
}

export function createCommandRouter(registry: CommandRegistry): CommandRouter {
  return new CommandRouter(registry);
}
