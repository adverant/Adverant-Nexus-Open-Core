/**
 * Output Manager
 *
 * Centralized output management coordinating formatters and renderers
 */

import type {
  OutputFormat,
  OutputFormatter,
  FormatOptions,
  OutputRenderer,
  ProgressOptions,
  ProgressController,
  TableColumn,
} from '../types/output.js';

import { textFormatter } from './formatters/text-formatter.js';
import { jsonFormatter } from './formatters/json-formatter.js';
import { yamlFormatter } from './formatters/yaml-formatter.js';
import { tableFormatter } from './formatters/table-formatter.js';
import { streamFormatter } from './formatters/stream-formatter.js';
import { terminalRenderer } from './renderers/terminal-renderer.js';
import { progressRenderer } from './renderers/progress-renderer.js';

export interface OutputOptions {
  format?: OutputFormat;
  verbose?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  pretty?: boolean;
}

export class OutputManager {
  private formatters: Map<OutputFormat, OutputFormatter>;
  private renderer: OutputRenderer;
  private options: Required<OutputOptions>;

  constructor(options?: OutputOptions) {
    // Initialize formatters
    this.formatters = new Map<OutputFormat, OutputFormatter>([
      ['text', textFormatter],
      ['json', jsonFormatter],
      ['yaml', yamlFormatter],
      ['table', tableFormatter],
      ['stream-json', streamFormatter],
    ]);

    // Initialize renderer
    this.renderer = terminalRenderer;

    // Set options
    this.options = {
      format: options?.format ?? 'text',
      verbose: options?.verbose ?? false,
      quiet: options?.quiet ?? false,
      noColor: options?.noColor ?? false,
      pretty: options?.pretty ?? true,
    };

    // Configure renderer
    if (this.options.noColor) {
      terminalRenderer.setNoColor(true);
      progressRenderer.setNoColor(true);
    }
  }

  /**
   * Output result with appropriate formatter
   */
  output(result: any, formatOptions?: FormatOptions): void {
    if (this.options.quiet) return;

    const formatter = this.getFormatter(this.options.format);
    const formatted = formatter.formatResult(result, {
      ...formatOptions,
      colors: !this.options.noColor,
      pretty: this.options.pretty,
    });

    this.renderer.render(formatted);
  }

  /**
   * Output with specific format
   */
  outputAs(result: any, format: OutputFormat, formatOptions?: FormatOptions): void {
    if (this.options.quiet) return;

    const formatter = this.getFormatter(format);
    const formatted = formatter.formatResult(result, {
      ...formatOptions,
      colors: !this.options.noColor,
      pretty: this.options.pretty,
    });

    this.renderer.render(formatted);
  }

  /**
   * Output table
   */
  outputTable(data: any[], columns?: TableColumn[]): void {
    if (this.options.quiet) return;

    if (columns) {
      this.renderer.renderTable(data, columns);
    } else {
      const formatted = tableFormatter.formatResult(data, {
        colors: !this.options.noColor,
      });
      this.renderer.render(formatted);
    }
  }

  /**
   * Output list
   */
  outputList(items: any[]): void {
    if (this.options.quiet) return;

    this.renderer.renderList(items);
  }

  /**
   * Output success message
   */
  success(message: string): void {
    if (this.options.quiet) return;
    this.renderer.success(message);
  }

  /**
   * Output error message
   */
  error(message: string | Error): void {
    // Always show errors even in quiet mode
    const errorMessage = typeof message === 'string' ? message : message.message;
    this.renderer.error(errorMessage);

    // Show stack trace in verbose mode
    if (this.options.verbose && typeof message !== 'string' && message.stack) {
      this.renderer.render(message.stack, { dim: true });
    }
  }

  /**
   * Output warning message
   */
  warning(message: string): void {
    if (this.options.quiet) return;
    this.renderer.warning(message);
  }

  /**
   * Output info message
   */
  info(message: string): void {
    if (this.options.quiet) return;
    this.renderer.info(message);
  }

  /**
   * Output debug message (only in verbose mode)
   */
  debug(message: string): void {
    if (!this.options.verbose) return;
    this.renderer.render(`[DEBUG] ${message}`, { dim: true });
  }

  /**
   * Output verbose message (only in verbose mode)
   */
  verbose(message: string): void {
    if (!this.options.verbose) return;
    this.renderer.render(message, { dim: true });
  }

  /**
   * Create progress indicator
   */
  progress(options: ProgressOptions): ProgressController {
    if (this.options.quiet) {
      // Return no-op controller for quiet mode
      return {
        update: () => {},
        succeed: () => {},
        fail: () => {},
        warn: () => {},
        info: () => {},
        stop: () => {},
      };
    }

    return this.renderer.renderProgress(options);
  }

  /**
   * Output box
   */
  outputBox(content: string, title?: string): void {
    if (this.options.quiet) return;

    this.renderer.renderBox(content, {
      title,
      borderColor: 'cyan',
    });
  }

  /**
   * Output header
   */
  outputHeader(text: string): void {
    if (this.options.quiet) return;
    this.renderer.renderHeader(text);
  }

  /**
   * Output separator
   */
  outputSeparator(): void {
    if (this.options.quiet) return;
    this.renderer.renderSeparator();
  }

  /**
   * Clear terminal
   */
  clear(): void {
    this.renderer.clear();
  }

  /**
   * Output blank line
   */
  newline(): void {
    if (this.options.quiet) return;
    this.renderer.renderBlankLine();
  }

  /**
   * Output raw text
   */
  raw(text: string): void {
    if (this.options.quiet) return;
    this.renderer.render(text);
  }

  /**
   * Set output format
   */
  setFormat(format: OutputFormat): void {
    this.options.format = format;
  }

  /**
   * Set verbose mode
   */
  setVerbose(verbose: boolean): void {
    this.options.verbose = verbose;
  }

  /**
   * Set quiet mode
   */
  setQuiet(quiet: boolean): void {
    this.options.quiet = quiet;
  }

  /**
   * Set no-color mode
   */
  setNoColor(noColor: boolean): void {
    this.options.noColor = noColor;
    terminalRenderer.setNoColor(noColor);
    progressRenderer.setNoColor(noColor);
  }

  /**
   * Set pretty mode
   */
  setPretty(pretty: boolean): void {
    this.options.pretty = pretty;
  }

  /**
   * Get current options
   */
  getOptions(): Required<OutputOptions> {
    return { ...this.options };
  }

  /**
   * Get formatter for format
   */
  private getFormatter(format: OutputFormat): OutputFormatter {
    const formatter = this.formatters.get(format);
    if (!formatter) {
      throw new Error(`Unsupported output format: ${format}`);
    }
    return formatter;
  }

  /**
   * Register custom formatter
   */
  registerFormatter(formatter: OutputFormatter): void {
    this.formatters.set(formatter.format, formatter);
  }

  /**
   * Get available formats
   */
  getAvailableFormats(): OutputFormat[] {
    return Array.from(this.formatters.keys());
  }

  /**
   * Check if format is supported
   */
  supportsFormat(format: OutputFormat): boolean {
    return this.formatters.has(format);
  }

  /**
   * Format data without outputting
   */
  format(data: any, format?: OutputFormat, options?: FormatOptions): string {
    const targetFormat = format ?? this.options.format;
    const formatter = this.getFormatter(targetFormat);

    return formatter.formatResult(data, {
      ...options,
      colors: !this.options.noColor,
      pretty: this.options.pretty,
    });
  }

  /**
   * Stream output (for stream-json format)
   */
  streamOutput(event: any): void {
    if (this.options.quiet) return;

    if (this.options.format === 'stream-json') {
      const formatted = streamFormatter.formatEvent(event);
      this.renderer.render(formatted, { newline: false });
    }
  }

  /**
   * Output progress event (stream-json)
   */
  streamProgress(current: number, total: number, message?: string): void {
    if (this.options.quiet) return;

    if (this.options.format === 'stream-json') {
      const formatted = streamFormatter.formatProgress(current, total, message);
      this.renderer.render(formatted, { newline: false });
    }
  }

  /**
   * Output complete event (stream-json)
   */
  streamComplete(summary?: any): void {
    if (this.options.quiet) return;

    if (this.options.format === 'stream-json') {
      const formatted = streamFormatter.formatComplete(summary);
      this.renderer.render(formatted, { newline: false });
    }
  }

  /**
   * Create logger instance
   */
  createLogger() {
    return {
      debug: (message: string) => this.debug(message),
      info: (message: string) => this.info(message),
      warn: (message: string) => this.warning(message),
      error: (message: string | Error) => this.error(message),
      success: (message: string) => this.success(message),
      verbose: (message: string) => this.verbose(message),
    };
  }
}

// Export singleton instance
export const outputManager = new OutputManager();
