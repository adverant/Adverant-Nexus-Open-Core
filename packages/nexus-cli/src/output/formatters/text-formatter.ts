/**
 * Text Formatter
 *
 * Human-readable text output formatting
 */

import chalk from 'chalk';
import { inspect } from 'util';
import type { OutputFormatter, FormatOptions, OutputFormat } from '../../types/output.js';

export class TextFormatter implements OutputFormatter {
  readonly format: OutputFormat = 'text';

  /**
   * Format result as human-readable text
   */
  formatResult(result: any, options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    const pretty = options?.pretty ?? true;
    const maxWidth = options?.maxWidth ?? 100;
    const indent = options?.indent ?? 2;
    const headers = options?.headers ?? true;

    return this.formatValue(result, 0, { colors, pretty, maxWidth, indent, headers });
  }

  /**
   * Check if formatter supports given format
   */
  supports(format: OutputFormat): boolean {
    return format === 'text';
  }

  /**
   * Format any value
   */
  private formatValue(
    value: any,
    depth: number,
    options: Required<FormatOptions>
  ): string {
    const { colors, pretty, maxWidth, indent } = options;

    // Null/undefined
    if (value === null) {
      return colors ? chalk.dim('null') : 'null';
    }
    if (value === undefined) {
      return colors ? chalk.dim('undefined') : 'undefined';
    }

    // Primitives
    if (typeof value === 'string') {
      return this.formatString(value, colors, maxWidth);
    }
    if (typeof value === 'number') {
      return colors ? chalk.cyan(String(value)) : String(value);
    }
    if (typeof value === 'boolean') {
      return colors
        ? value
          ? chalk.green('true')
          : chalk.red('false')
        : String(value);
    }

    // Arrays
    if (Array.isArray(value)) {
      return this.formatArray(value, depth, options);
    }

    // Objects
    if (typeof value === 'object') {
      return this.formatObject(value, depth, options);
    }

    // Functions, symbols, etc.
    return colors ? chalk.dim(String(value)) : String(value);
  }

  /**
   * Format string value
   */
  private formatString(value: string, colors: boolean, maxWidth: number): string {
    // Truncate long strings
    const truncated = value.length > maxWidth ? value.slice(0, maxWidth) + '...' : value;

    return colors ? chalk.green(`"${truncated}"`) : `"${truncated}"`;
  }

  /**
   * Format array
   */
  private formatArray(
    array: any[],
    depth: number,
    options: Required<FormatOptions>
  ): string {
    const { colors, pretty, indent } = options;

    if (array.length === 0) {
      return colors ? chalk.dim('[]') : '[]';
    }

    if (!pretty || depth > 3) {
      // Compact format for deep nesting
      return `[${array.length} items]`;
    }

    const indentStr = ' '.repeat(indent * (depth + 1));
    const closeIndentStr = ' '.repeat(indent * depth);

    const items = array.map((item, index) => {
      const formattedValue = this.formatValue(item, depth + 1, options);
      const prefix = colors ? chalk.dim(`${index}:`) : `${index}:`;
      return `${indentStr}${prefix} ${formattedValue}`;
    });

    return `[\n${items.join(',\n')}\n${closeIndentStr}]`;
  }

  /**
   * Format object
   */
  private formatObject(
    obj: Record<string, any>,
    depth: number,
    options: Required<FormatOptions>
  ): string {
    const { colors, pretty, indent } = options;

    const keys = Object.keys(obj);

    if (keys.length === 0) {
      return colors ? chalk.dim('{}') : '{}';
    }

    if (!pretty || depth > 3) {
      // Compact format for deep nesting
      return `{${keys.length} properties}`;
    }

    const indentStr = ' '.repeat(indent * (depth + 1));
    const closeIndentStr = ' '.repeat(indent * depth);

    const entries = keys.map((key) => {
      const value = obj[key];
      const formattedKey = colors ? chalk.blue(key) : key;
      const formattedValue = this.formatValue(value, depth + 1, options);
      return `${indentStr}${formattedKey}: ${formattedValue}`;
    });

    return `{\n${entries.join(',\n')}\n${closeIndentStr}}`;
  }

  /**
   * Format with headers and labels
   */
  formatWithHeader(result: any, header: string, options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    const formattedHeader = colors ? chalk.bold.underline(header) : header;
    const formattedResult = this.formatResult(result, options);

    return `${formattedHeader}\n\n${formattedResult}`;
  }

  /**
   * Format list of items
   */
  formatList(items: any[], options?: FormatOptions): string {
    const colors = options?.colors ?? true;

    return items
      .map((item, index) => {
        const bullet = colors ? chalk.dim('•') : '•';
        const formattedItem = this.formatValue(item, 0, {
          colors,
          pretty: options?.pretty ?? true,
          maxWidth: options?.maxWidth ?? 100,
          indent: options?.indent ?? 2,
          headers: options?.headers ?? true,
        });
        return `${bullet} ${formattedItem}`;
      })
      .join('\n');
  }

  /**
   * Format key-value pairs
   */
  formatKeyValue(
    data: Record<string, any>,
    options?: FormatOptions
  ): string {
    const colors = options?.colors ?? true;
    const maxKeyLength = Math.max(...Object.keys(data).map((k) => k.length));

    return Object.entries(data)
      .map(([key, value]) => {
        const paddedKey = key.padEnd(maxKeyLength);
        const formattedKey = colors ? chalk.blue(paddedKey) : paddedKey;
        const formattedValue = this.formatValue(value, 0, {
          colors,
          pretty: options?.pretty ?? false,
          maxWidth: options?.maxWidth ?? 100,
          indent: options?.indent ?? 2,
          headers: options?.headers ?? true,
        });
        return `${formattedKey}  ${formattedValue}`;
      })
      .join('\n');
  }

  /**
   * Format error
   */
  formatError(error: Error | string, options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    const message = typeof error === 'string' ? error : error.message;
    const stack = typeof error === 'object' ? error.stack : undefined;

    let output = colors ? chalk.red(`Error: ${message}`) : `Error: ${message}`;

    if (stack && options?.pretty) {
      const stackLines = stack.split('\n').slice(1); // Skip first line (message)
      const formattedStack = stackLines.map((line) =>
        colors ? chalk.dim(line) : line
      ).join('\n');
      output += '\n\n' + formattedStack;
    }

    return output;
  }

  /**
   * Format success message
   */
  formatSuccess(message: string, options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    return colors ? chalk.green(`✓ ${message}`) : `✓ ${message}`;
  }

  /**
   * Format warning message
   */
  formatWarning(message: string, options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    return colors ? chalk.yellow(`⚠ ${message}`) : `⚠ ${message}`;
  }

  /**
   * Format info message
   */
  formatInfo(message: string, options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    return colors ? chalk.blue(`ℹ ${message}`) : `ℹ ${message}`;
  }
}

export const textFormatter = new TextFormatter();
