/**
 * REPL Renderer for Nexus CLI
 *
 * Formats and displays results in the REPL
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';
import { inspect } from 'util';
import type { CommandResult } from '../types/command.js';

export class REPLRenderer {
  /**
   * Render command result
   */
  renderResult(result: CommandResult): void {
    if (!result.success) {
      this.renderError(result.error || 'Command failed');
      return;
    }

    if (result.message) {
      console.log(chalk.cyan(result.message));
    }

    if (result.data !== undefined) {
      this.renderData(result.data);
    }

    // Show metadata in verbose mode
    if (result.metadata && process.env.VERBOSE) {
      console.log(chalk.dim('\n' + this.formatMetadata(result.metadata)));
    }
  }

  /**
   * Render error message
   */
  renderError(error: Error | string): void {
    const message = error instanceof Error ? error.message : error;
    console.log(chalk.red(`✖ Error: ${message}`));

    // Show stack trace in debug mode
    if (error instanceof Error && process.env.DEBUG) {
      console.log(chalk.dim(error.stack));
    }
  }

  /**
   * Render warning message
   */
  renderWarning(message: string): void {
    console.log(chalk.yellow(`⚠ ${message}`));
  }

  /**
   * Render info message
   */
  renderInfo(message: string): void {
    console.log(chalk.blue(`ℹ ${message}`));
  }

  /**
   * Render success message
   */
  renderSuccess(message: string): void {
    console.log(chalk.green(`✔ ${message}`));
  }

  /**
   * Render data based on type
   */
  private renderData(data: any): void {
    // Null or undefined
    if (data === null || data === undefined) {
      return;
    }

    // String
    if (typeof data === 'string') {
      console.log(data);
      return;
    }

    // Number or boolean
    if (typeof data === 'number' || typeof data === 'boolean') {
      console.log(String(data));
      return;
    }

    // Array
    if (Array.isArray(data)) {
      if (data.length === 0) {
        console.log(chalk.dim('(empty array)'));
        return;
      }

      // Try to render as table if objects with same keys
      if (this.canRenderAsTable(data)) {
        this.renderTable(data);
      } else {
        this.renderArray(data);
      }
      return;
    }

    // Object
    if (typeof data === 'object') {
      this.renderObject(data);
      return;
    }

    // Fallback
    console.log(data);
  }

  /**
   * Render array
   */
  private renderArray(data: any[]): void {
    data.forEach((item, index) => {
      if (typeof item === 'object') {
        console.log(chalk.cyan(`[${index}]`));
        console.log(this.formatObject(item, 2));
      } else {
        console.log(chalk.cyan(`[${index}]`), String(item));
      }
    });
  }

  /**
   * Render object
   */
  private renderObject(data: Record<string, any>): void {
    console.log(this.formatObject(data));
  }

  /**
   * Render table
   */
  private renderTable(data: any[]): void {
    if (data.length === 0) {
      return;
    }

    // Get all keys
    const keys = Array.from(
      new Set(data.flatMap(item => Object.keys(item)))
    );

    const table = new Table({
      head: keys.map(k => chalk.cyan(k)),
      style: {
        head: [],
        border: [],
      },
    });

    data.forEach(item => {
      table.push(
        keys.map(key => {
          const value = item[key];
          return this.formatValue(value);
        })
      );
    });

    console.log(table.toString());
  }

  /**
   * Format object for display
   */
  private formatObject(obj: Record<string, any>, indent = 0): string {
    const lines: string[] = [];
    const prefix = ' '.repeat(indent);

    for (const [key, value] of Object.entries(obj)) {
      const formattedKey = chalk.cyan(`${key}:`);

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        lines.push(`${prefix}${formattedKey}`);
        lines.push(this.formatObject(value, indent + 2));
      } else if (Array.isArray(value)) {
        lines.push(`${prefix}${formattedKey}`);
        value.forEach((item, index) => {
          if (typeof item === 'object') {
            lines.push(`${prefix}  [${index}]`);
            lines.push(this.formatObject(item, indent + 4));
          } else {
            lines.push(`${prefix}  [${index}] ${this.formatValue(item)}`);
          }
        });
      } else {
        lines.push(`${prefix}${formattedKey} ${this.formatValue(value)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format value based on type
   */
  private formatValue(value: any): string {
    if (value === null) {
      return chalk.dim('null');
    }

    if (value === undefined) {
      return chalk.dim('undefined');
    }

    if (typeof value === 'boolean') {
      return value ? chalk.green('true') : chalk.red('false');
    }

    if (typeof value === 'number') {
      return chalk.yellow(String(value));
    }

    if (typeof value === 'string') {
      // Truncate long strings
      if (value.length > 100) {
        return `${value.slice(0, 100)}${chalk.dim('...')}`;
      }
      return value;
    }

    if (typeof value === 'object') {
      return inspect(value, { colors: true, depth: 2, compact: true });
    }

    return String(value);
  }

  /**
   * Format metadata
   */
  private formatMetadata(metadata: Record<string, any>): string {
    const parts: string[] = [];

    if (metadata.duration !== undefined) {
      parts.push(`Duration: ${metadata.duration}ms`);
    }

    if (metadata.service) {
      parts.push(`Service: ${metadata.service}`);
    }

    if (metadata.streaming) {
      parts.push('Streaming: enabled');
    }

    return parts.join(' | ');
  }

  /**
   * Check if array can be rendered as table
   */
  private canRenderAsTable(data: any[]): boolean {
    if (data.length === 0) {
      return false;
    }

    // All items must be objects
    if (!data.every(item => typeof item === 'object' && item !== null)) {
      return false;
    }

    // Get first item keys
    const firstKeys = Object.keys(data[0]);

    // All items should have similar structure
    return data.every(item => {
      const keys = Object.keys(item);
      return (
        keys.length === firstKeys.length &&
        keys.every(key => firstKeys.includes(key))
      );
    });
  }

  /**
   * Render welcome banner
   */
  renderWelcome(version: string, servicesCount: number): void {
    const banner = boxen(
      chalk.bold.cyan('NEXUS CLI') +
        '\n\n' +
        chalk.dim(`Version: ${version}`) +
        '\n' +
        chalk.dim(`Services: ${servicesCount} discovered`) +
        '\n\n' +
        chalk.white('Type ') +
        chalk.cyan('help') +
        chalk.white(' for available commands') +
        '\n' +
        chalk.white('Type ') +
        chalk.cyan('exit') +
        chalk.white(' to quit'),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'cyan',
        align: 'center',
      }
    );

    console.log(banner);
  }

  /**
   * Render help text
   */
  renderHelp(commands: string[]): void {
    console.log(chalk.bold.cyan('\nAvailable Commands:'));
    console.log();

    commands.forEach(cmd => {
      console.log(`  ${chalk.cyan(cmd)}`);
    });

    console.log();
    console.log(chalk.dim('Tip: Use <Tab> for auto-completion'));
  }

  /**
   * Clear screen
   */
  clear(): void {
    console.clear();
  }

  /**
   * Render prompt
   */
  getPrompt(namespace?: string): string {
    if (namespace) {
      return chalk.cyan(`nexus:${namespace}`) + chalk.gray(' > ');
    }
    return chalk.cyan('nexus') + chalk.gray(' > ');
  }
}
