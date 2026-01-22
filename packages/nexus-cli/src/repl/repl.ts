/**
 * Interactive REPL for Nexus CLI
 *
 * Provides an interactive shell for executing commands with tab completion and history
 */

import readline from 'readline';
import chalk from 'chalk';
import type { Command, CommandResult } from '../types/command.js';
import type { NexusConfig } from '../types/config.js';
import type { WorkspaceInfo } from '../types/command.js';
import { ContextManager } from '../core/session/context-manager.js';
import { HistoryManager } from '../core/session/history-manager.js';
import { SessionManager } from '../core/session/session-manager.js';
import { Completer } from './completer.js';
import { CommandEvaluator } from './evaluator.js';
import { REPLRenderer } from './renderer.js';

export interface REPLOptions {
  workspace?: WorkspaceInfo;
  config: NexusConfig;
  services: Map<string, any>;
  commands: Map<string, Command[]>;
  version: string;
}

export class REPL {
  private contextManager: ContextManager;
  private historyManager: HistoryManager;
  private sessionManager: SessionManager;
  private completer: Completer;
  private evaluator: CommandEvaluator;
  private renderer: REPLRenderer;
  private rl: readline.Interface | null = null;
  private running = false;
  private commands: Map<string, Command[]>;
  private version: string;

  constructor(options: REPLOptions) {
    this.contextManager = new ContextManager(
      options.workspace,
      options.config,
      options.services
    );
    this.historyManager = new HistoryManager();
    this.sessionManager = new SessionManager();
    this.completer = new Completer(options.commands);
    this.evaluator = new CommandEvaluator(options.commands);
    this.renderer = new REPLRenderer();
    this.commands = options.commands;
    this.version = options.version;
  }

  /**
   * Start the REPL
   */
  async start(): Promise<void> {
    this.running = true;

    // Show welcome banner
    this.renderer.renderWelcome(this.version, this.commands.size);

    // Create readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.renderer.getPrompt(),
      completer: (line: string) => {
        const context = this.contextManager.getContext();
        return this.completer.complete(line, context);
      },
      history: this.historyManager.getCommands(),
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Show prompt
    this.rl.prompt();

    // Wait for REPL to exit
    await new Promise<void>(resolve => {
      this.rl?.on('close', () => {
        resolve();
      });
    });
  }

  /**
   * Set up readline event handlers
   */
  private setupEventHandlers(): void {
    if (!this.rl) return;

    // Handle line input
    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim();

      if (!trimmed) {
        this.rl?.prompt();
        return;
      }

      // Add to history
      this.historyManager.resetIndex();

      try {
        await this.handleCommand(trimmed);
      } catch (error) {
        this.renderer.renderError(error as Error);
      }

      // Show prompt
      if (this.running) {
        this.updatePrompt();
        this.rl?.prompt();
      }
    });

    // Handle Ctrl+C
    this.rl.on('SIGINT', () => {
      console.log('\n');
      this.renderer.renderInfo('Press Ctrl+C again to exit, or type "exit"');
      this.rl?.prompt();
    });

    // Handle close
    this.rl.on('close', () => {
      console.log(chalk.cyan('\nGoodbye!'));
      process.exit(0);
    });
  }

  /**
   * Handle command execution
   */
  private async handleCommand(line: string): Promise<void> {
    const startTime = Date.now();
    const context = this.contextManager.getContext();

    // Parse command
    const parsed = this.evaluator.parseInput(line, context);

    if (!parsed) {
      return;
    }

    // Evaluate command
    const result = await this.evaluator.evaluate(
      parsed,
      context,
      async p => this.handleBuiltIn(p)
    );

    const duration = Date.now() - startTime;

    // Store in history
    const historyEntry = this.historyManager.createEntry(
      line,
      parsed.args,
      parsed.namespace,
      result.success,
      duration
    );
    this.historyManager.add(historyEntry);

    // Update context
    this.contextManager.incrementCommandCount();
    this.contextManager.setLastResult(result.data);

    // Handle namespace switch
    if (parsed.type === 'namespace' && result.success) {
      this.contextManager.setNamespace(result.data.namespace);
      this.updatePrompt();
    }

    // Render result
    this.renderer.renderResult(result);
  }

  /**
   * Handle built-in REPL commands
   */
  private async handleBuiltIn(parsed: any): Promise<CommandResult> {
    switch (parsed.command) {
      case 'help':
        return this.handleHelp();

      case 'services':
        return this.handleServices();

      case 'history':
        return this.handleHistory(parsed.args);

      case 'clear':
        return this.handleClear();

      case 'save':
        return this.handleSave(parsed.args);

      case 'load':
        return this.handleLoad(parsed.args);

      case 'sessions':
        return this.handleSessions();

      case 'config':
        return this.handleConfig();

      case 'exit':
      case 'quit':
        return this.handleExit();

      default:
        return {
          success: false,
          error: `Unknown built-in command: ${parsed.command}`,
        };
    }
  }

  /**
   * Handle help command
   */
  private handleHelp(): CommandResult {
    const context = this.contextManager.getContext();
    const allCommands: string[] = [];

    // Built-in commands
    allCommands.push(
      chalk.bold.cyan('Built-in Commands:'),
      '  help        - Show this help',
      '  services    - List discovered services',
      '  use <name>  - Switch to service namespace',
      '  history     - Show command history',
      '  clear       - Clear screen',
      '  save <name> - Save current session',
      '  load <name> - Load saved session',
      '  sessions    - List saved sessions',
      '  config      - Show configuration',
      '  exit        - Exit REPL',
      ''
    );

    // Service namespaces
    if (this.commands.size > 0) {
      allCommands.push(chalk.bold.cyan('Available Namespaces:'));
      for (const namespace of this.commands.keys()) {
        if (namespace) {
          const commands = this.commands.get(namespace) || [];
          allCommands.push(`  ${chalk.cyan(namespace)} (${commands.length} commands)`);
        }
      }
      allCommands.push('');
    }

    // Current namespace commands
    if (context.namespace) {
      const commands = this.commands.get(context.namespace) || [];
      allCommands.push(chalk.bold.cyan(`Commands in ${context.namespace}:`));
      for (const cmd of commands) {
        allCommands.push(`  ${chalk.cyan(cmd.name)} - ${cmd.description}`);
      }
    }

    console.log('\n' + allCommands.join('\n'));

    return { success: true };
  }

  /**
   * Handle services command
   */
  private handleServices(): CommandResult {
    const services = Array.from(this.commands.keys()).filter(k => k !== '');

    return {
      success: true,
      data: services.map(name => ({
        name,
        commands: this.commands.get(name)?.length || 0,
      })),
    };
  }

  /**
   * Handle history command
   */
  private handleHistory(args: string[]): CommandResult {
    const limit = args.length > 0 ? parseInt(args[0]) : 20;
    const entries = this.historyManager.list(limit);

    return {
      success: true,
      data: entries.map((entry, index) => ({
        '#': entries.length - index,
        command: entry.command,
        timestamp: entry.timestamp.toISOString(),
        success: entry.success ? '✔' : '✖',
        duration: `${entry.duration}ms`,
      })),
    };
  }

  /**
   * Handle clear command
   */
  private handleClear(): CommandResult {
    this.renderer.clear();
    return { success: true };
  }

  /**
   * Handle save command
   */
  private async handleSave(args: string[]): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Usage: save <name>',
      };
    }

    const name = args[0];
    const context = this.contextManager.toSessionContext();
    const session = this.sessionManager.createSession(name, context);

    // Add current history
    session.history = this.historyManager.list(100);

    await this.sessionManager.save(session);

    return {
      success: true,
      message: `Session saved: ${name}`,
    };
  }

  /**
   * Handle load command
   */
  private async handleLoad(args: string[]): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: 'Usage: load <name>',
      };
    }

    const name = args[0];
    const session = await this.sessionManager.load(name);

    if (!session) {
      return {
        success: false,
        error: `Session not found: ${name}`,
      };
    }

    // TODO: Restore session context
    // This would require rebuilding the context from the session data

    return {
      success: true,
      message: `Session loaded: ${name}`,
      data: {
        commands: session.metadata.totalCommands,
        created: session.created,
      },
    };
  }

  /**
   * Handle sessions command
   */
  private async handleSessions(): Promise<CommandResult> {
    const sessions = await this.sessionManager.list();

    return {
      success: true,
      data: sessions.map(s => ({
        name: s.name,
        created: s.created.toISOString(),
        updated: s.updated.toISOString(),
        commands: s.commandCount,
        tags: s.tags.join(', '),
      })),
    };
  }

  /**
   * Handle config command
   */
  private handleConfig(): CommandResult {
    const context = this.contextManager.getContext();

    return {
      success: true,
      data: {
        namespace: context.namespace || '(global)',
        workspace: context.workspace?.type || 'unknown',
        outputFormat: context.outputFormat,
        verbose: context.verbose,
        commandCount: context.commandCount,
        sessionDuration: `${Math.round(this.contextManager.getSessionDuration() / 1000)}s`,
      },
    };
  }

  /**
   * Handle exit command
   */
  private handleExit(): CommandResult {
    this.running = false;
    this.rl?.close();

    return {
      success: true,
      message: 'Goodbye!',
    };
  }

  /**
   * Update prompt based on current context
   */
  private updatePrompt(): void {
    const context = this.contextManager.getContext();
    const prompt = this.renderer.getPrompt(context.namespace);
    this.rl?.setPrompt(prompt);
  }

  /**
   * Stop the REPL
   */
  stop(): void {
    this.running = false;
    this.rl?.close();
  }
}
