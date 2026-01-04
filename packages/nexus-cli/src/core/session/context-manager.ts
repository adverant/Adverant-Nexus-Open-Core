/**
 * Context Manager for Nexus CLI
 *
 * Manages REPL context including namespace, workspace, and session metadata
 */

import type { CommandContext, WorkspaceInfo } from '../../types/command.js';
import type { NexusConfig } from '../../types/config.js';
import type { SessionContext } from '../../types/session.js';

export interface REPLContext extends CommandContext {
  namespace?: string;
  lastResult?: any;
  sessionStart: Date;
  commandCount: number;
}

export class ContextManager {
  private context: REPLContext;

  constructor(
    workspace: WorkspaceInfo | undefined,
    config: NexusConfig,
    services: Map<string, any>
  ) {
    this.context = {
      cwd: process.cwd(),
      config,
      workspace,
      services,
      verbose: config.defaults?.verbose || false,
      quiet: config.defaults?.quiet || false,
      outputFormat: config.defaults?.outputFormat || 'text',
      transport: null,
      namespace: undefined,
      lastResult: undefined,
      sessionStart: new Date(),
      commandCount: 0,
    };
  }

  /**
   * Get current context
   */
  getContext(): REPLContext {
    return { ...this.context };
  }

  /**
   * Update context with partial values
   */
  updateContext(updates: Partial<REPLContext>): void {
    this.context = {
      ...this.context,
      ...updates,
    };
  }

  /**
   * Get current namespace
   */
  getNamespace(): string | undefined {
    return this.context.namespace;
  }

  /**
   * Set current namespace
   */
  setNamespace(namespace: string | undefined): void {
    this.context.namespace = namespace;
  }

  /**
   * Get last command result
   */
  getLastResult(): any {
    return this.context.lastResult;
  }

  /**
   * Set last command result
   */
  setLastResult(result: any): void {
    this.context.lastResult = result;
  }

  /**
   * Increment command count
   */
  incrementCommandCount(): void {
    this.context.commandCount++;
  }

  /**
   * Get session duration in milliseconds
   */
  getSessionDuration(): number {
    return Date.now() - this.context.sessionStart.getTime();
  }

  /**
   * Export context to session context
   */
  toSessionContext(): SessionContext {
    return {
      workspace: this.context.workspace,
      cwd: this.context.cwd,
      config: this.context.config,
      environment: process.env as Record<string, string>,
      services: Object.fromEntries(this.context.services.entries()),
    };
  }

  /**
   * Get context metadata
   */
  getMetadata() {
    return {
      namespace: this.context.namespace,
      commandCount: this.context.commandCount,
      sessionDuration: this.getSessionDuration(),
      workspace: this.context.workspace?.type,
      outputFormat: this.context.outputFormat,
    };
  }

  /**
   * Reset context to initial state
   */
  reset(): void {
    this.context.namespace = undefined;
    this.context.lastResult = undefined;
    this.context.commandCount = 0;
    this.context.sessionStart = new Date();
  }
}
