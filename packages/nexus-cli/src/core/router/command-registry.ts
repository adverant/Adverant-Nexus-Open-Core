/**
 * Command Registry
 *
 * Central registry for all CLI commands
 */

import type {
  Command,
  CommandRegistry as ICommandRegistry,
  DynamicCommandSource,
} from '../../types/command.js';

export class CommandRegistry implements ICommandRegistry {
  private commands: Map<string, Command> = new Map();
  private dynamicSources: Map<string, DynamicCommandSource> = new Map();

  /**
   * Register a command
   */
  register(command: Command): void {
    const key = this.getCommandKey(command.name, command.namespace);
    
    if (this.commands.has(key)) {
      console.warn(`Command ${key} is already registered, overwriting`);
    }

    this.commands.set(key, command);
  }

  /**
   * Register multiple commands
   */
  registerMany(commands: Command[]): void {
    for (const command of commands) {
      this.register(command);
    }
  }

  /**
   * Unregister a command
   */
  unregister(name: string, namespace?: string): void {
    const key = this.getCommandKey(name, namespace);
    this.commands.delete(key);
  }

  /**
   * Get a command by name and namespace
   */
  get(name: string, namespace?: string): Command | undefined {
    const key = this.getCommandKey(name, namespace);
    return this.commands.get(key);
  }

  /**
   * Check if command exists
   */
  has(name: string, namespace?: string): boolean {
    const key = this.getCommandKey(name, namespace);
    return this.commands.has(key);
  }

  /**
   * List all commands, optionally filtered by namespace
   */
  list(namespace?: string): Command[] {
    const commands = Array.from(this.commands.values());

    if (namespace) {
      return commands.filter((cmd) => cmd.namespace === namespace);
    }

    return commands;
  }

  /**
   * List all namespaces
   */
  listNamespaces(): string[] {
    const namespaces = new Set<string>();
    
    for (const command of this.commands.values()) {
      if (command.namespace) {
        namespaces.add(command.namespace);
      }
    }

    return Array.from(namespaces).sort();
  }

  /**
   * Register a dynamic command source
   */
  registerDynamicSource(source: DynamicCommandSource): void {
    this.dynamicSources.set(source.namespace, source);
  }

  /**
   * Discover and register commands from all dynamic sources
   */
  async discoverDynamicCommands(): Promise<void> {
    for (const source of this.dynamicSources.values()) {
      try {
        const commands = await source.discover();
        this.registerMany(commands);
      } catch (error) {
        console.error(`Failed to discover commands from ${source.namespace}:`, error);
      }
    }
  }

  /**
   * Refresh commands from dynamic sources
   */
  async refresh(): Promise<void> {
    for (const source of this.dynamicSources.values()) {
      try {
        await source.refresh();
        const commands = await source.discover();
        
        // Remove old commands from this namespace
        const existing = this.list(source.namespace);
        for (const cmd of existing) {
          this.unregister(cmd.name, cmd.namespace);
        }

        // Register new commands
        this.registerMany(commands);
      } catch (error) {
        console.error(`Failed to refresh commands from ${source.namespace}:`, error);
      }
    }
  }

  /**
   * Get command by full name (namespace:command or just command)
   */
  resolve(fullName: string): Command | undefined {
    if (fullName.includes(':')) {
      const [namespace, name] = fullName.split(':', 2);
      return this.get(name, namespace);
    }

    // Try to find command without namespace
    return this.get(fullName);
  }

  /**
   * Search commands by keyword
   */
  search(keyword: string): Command[] {
    const lowerKeyword = keyword.toLowerCase();
    return Array.from(this.commands.values()).filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(lowerKeyword) ||
        cmd.description.toLowerCase().includes(lowerKeyword) ||
        cmd.namespace?.toLowerCase().includes(lowerKeyword)
    );
  }

  private getCommandKey(name: string, namespace?: string): string {
    return namespace ? `${namespace}:${name}` : name;
  }
}

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry();
}
