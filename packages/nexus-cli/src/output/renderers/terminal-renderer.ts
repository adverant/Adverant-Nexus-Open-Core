/**
 * Terminal Renderer
 *
 * Renders output to terminal with colors and formatting
 */

import chalk from 'chalk';
import boxen, { type Options as BoxenOptions } from 'boxen';
import cliCursor from 'cli-cursor';
import logSymbols from 'log-symbols';
import figures from 'figures';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type {
  OutputRenderer,
  RenderOptions,
  ListOptions,
  BoxOptions,
  ProgressOptions,
  ProgressController,
  TableColumn,
} from '../../types/output.js';

export class TerminalRenderer implements OutputRenderer {
  private terminalWidth: number;
  private noColor: boolean = false;

  constructor() {
    this.terminalWidth = process.stdout.columns || 80;

    // Listen for terminal resize
    process.stdout.on('resize', () => {
      this.terminalWidth = process.stdout.columns || 80;
    });

    // Check for NO_COLOR environment variable
    this.noColor = !!process.env.NO_COLOR;
  }

  /**
   * Render content to terminal
   */
  render(content: string, options?: RenderOptions): void {
    const newline = options?.newline ?? true;
    let output = content;

    // Apply styling
    if (!this.noColor) {
      if (options?.color) {
        const colorFn = (chalk as any)[options.color];
        if (typeof colorFn === 'function') {
          output = colorFn(output);
        }
      }

      if (options?.bold) {
        output = chalk.bold(output);
      }

      if (options?.dim) {
        output = chalk.dim(output);
      }

      if (options?.underline) {
        output = chalk.underline(output);
      }
    }

    // Wrap text to terminal width
    if (stringWidth(output) > this.terminalWidth) {
      output = wrapAnsi(output, this.terminalWidth, { hard: true, trim: false });
    }

    // Output
    if (newline) {
      console.log(output);
    } else {
      process.stdout.write(output);
    }
  }

  /**
   * Render progress (delegated to progress renderer)
   */
  renderProgress(options: ProgressOptions): ProgressController {
    // Import progress renderer to avoid circular dependency
    const { ProgressRenderer } = require('./progress-renderer.js');
    const progressRenderer = new ProgressRenderer();
    return progressRenderer.create(options);
  }

  /**
   * Render table
   */
  renderTable(data: any[], columns: TableColumn[]): void {
    // Use table formatter
    const { tableFormatter } = require('../formatters/table-formatter.js');
    const table = tableFormatter.formatWithColumns(data, columns, {
      colors: !this.noColor,
    });
    this.render(table);
  }

  /**
   * Render list
   */
  renderList(items: any[], options?: ListOptions): void {
    const indent = options?.indent ?? 0;
    const bullet = options?.bullet ?? (this.noColor ? '•' : chalk.dim('•'));
    const ordered = options?.ordered ?? false;

    items.forEach((item, index) => {
      const prefix = ordered ? `${index + 1}.` : bullet;
      const indentStr = ' '.repeat(indent);
      const itemText = typeof item === 'string' ? item : JSON.stringify(item);

      this.render(`${indentStr}${prefix} ${itemText}`);
    });
  }

  /**
   * Render box
   */
  renderBox(content: string, options?: BoxOptions): void {
    const boxOptions: BoxenOptions = {
      padding: options?.padding ?? 1,
      margin: options?.margin ?? 0,
      borderStyle: options?.borderStyle ?? 'round',
      borderColor: !this.noColor ? (options?.borderColor as any) : undefined,
      title: options?.title,
      titleAlignment: options?.align ?? 'center',
    };

    const box = boxen(content, boxOptions);
    this.render(box);
  }

  /**
   * Clear terminal
   */
  clear(): void {
    console.clear();
  }

  /**
   * Clear current line
   */
  clearLine(): void {
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
  }

  /**
   * Move cursor up
   */
  cursorUp(lines: number = 1): void {
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b[${lines}A`);
    }
  }

  /**
   * Move cursor down
   */
  cursorDown(lines: number = 1): void {
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b[${lines}B`);
    }
  }

  /**
   * Hide cursor
   */
  hideCursor(): void {
    cliCursor.hide();
  }

  /**
   * Show cursor
   */
  showCursor(): void {
    cliCursor.show();
  }

  /**
   * Render success message
   */
  success(message: string): void {
    const symbol = this.noColor ? '✓' : logSymbols.success;
    this.render(`${symbol} ${message}`, { color: 'green' });
  }

  /**
   * Render error message
   */
  error(message: string): void {
    const symbol = this.noColor ? '✗' : logSymbols.error;
    this.render(`${symbol} ${message}`, { color: 'red' });
  }

  /**
   * Render warning message
   */
  warning(message: string): void {
    const symbol = this.noColor ? '⚠' : logSymbols.warning;
    this.render(`${symbol} ${message}`, { color: 'yellow' });
  }

  /**
   * Render info message
   */
  info(message: string): void {
    const symbol = this.noColor ? 'ℹ' : logSymbols.info;
    this.render(`${symbol} ${message}`, { color: 'blue' });
  }

  /**
   * Render header
   */
  renderHeader(text: string): void {
    if (this.noColor) {
      this.render(`\n${text}\n${'='.repeat(text.length)}\n`);
    } else {
      this.render(chalk.bold.underline(text));
      this.render('');
    }
  }

  /**
   * Render separator
   */
  renderSeparator(char: string = '─'): void {
    const separator = char.repeat(this.terminalWidth);
    this.render(this.noColor ? separator : chalk.dim(separator));
  }

  /**
   * Render key-value pair
   */
  renderKeyValue(key: string, value: string, indent: number = 0): void {
    const indentStr = ' '.repeat(indent);
    const formattedKey = this.noColor ? key : chalk.blue(key);
    this.render(`${indentStr}${formattedKey}: ${value}`);
  }

  /**
   * Render blank line
   */
  renderBlankLine(): void {
    console.log();
  }

  /**
   * Render multiple lines
   */
  renderLines(lines: string[]): void {
    lines.forEach((line) => this.render(line));
  }

  /**
   * Set no-color mode
   */
  setNoColor(noColor: boolean): void {
    this.noColor = noColor;
  }

  /**
   * Get terminal width
   */
  getTerminalWidth(): number {
    return this.terminalWidth;
  }

  /**
   * Check if terminal supports colors
   */
  supportsColor(): boolean {
    return !this.noColor && !!chalk.level;
  }

  /**
   * Check if output is TTY
   */
  isTTY(): boolean {
    return process.stdout.isTTY ?? false;
  }

  /**
   * Render spinner (simple version)
   */
  renderSpinner(text: string): () => void {
    if (!this.isTTY()) {
      this.render(text);
      return () => {};
    }

    const frames = this.noColor
      ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      : [
          chalk.cyan('⠋'),
          chalk.cyan('⠙'),
          chalk.cyan('⠹'),
          chalk.cyan('⠸'),
          chalk.cyan('⠼'),
          chalk.cyan('⠴'),
          chalk.cyan('⠦'),
          chalk.cyan('⠧'),
          chalk.cyan('⠇'),
          chalk.cyan('⠏'),
        ];

    let i = 0;
    this.hideCursor();

    const interval = setInterval(() => {
      this.clearLine();
      process.stdout.write(`${frames[i]} ${text}`);
      i = (i + 1) % frames.length;
    }, 80);

    return () => {
      clearInterval(interval);
      this.clearLine();
      this.showCursor();
    };
  }

  /**
   * Ask for confirmation (simple version)
   */
  async confirm(message: string, defaultValue: boolean = false): Promise<boolean> {
    // This would typically use inquirer, but for simplicity:
    const suffix = defaultValue ? '[Y/n]' : '[y/N]';
    this.render(`${message} ${suffix}`, { newline: false });

    // Return default for non-interactive
    if (!this.isTTY()) {
      this.render('');
      return defaultValue;
    }

    // Would implement actual prompt here
    return defaultValue;
  }
}

export const terminalRenderer = new TerminalRenderer();
