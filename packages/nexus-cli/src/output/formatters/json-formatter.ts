/**
 * JSON Formatter
 *
 * Machine-parseable JSON output formatting
 */

import type { OutputFormatter, FormatOptions, OutputFormat } from '../../types/output.js';

export class JSONFormatter implements OutputFormatter {
  readonly format: OutputFormat = 'json';

  /**
   * Format result as JSON
   */
  formatResult(result: any, options?: FormatOptions): string {
    const pretty = options?.pretty ?? false;
    const indent = options?.indent ?? 2;

    try {
      // Handle circular references
      const seen = new WeakSet();

      const replacer = (key: string, value: any): any => {
        // Handle special types
        if (value === undefined) {
          return null;
        }

        if (value instanceof Error) {
          return {
            __type: 'Error',
            name: value.name,
            message: value.message,
            stack: value.stack,
          };
        }

        if (value instanceof Date) {
          return {
            __type: 'Date',
            value: value.toISOString(),
          };
        }

        if (value instanceof RegExp) {
          return {
            __type: 'RegExp',
            pattern: value.source,
            flags: value.flags,
          };
        }

        if (value instanceof Set) {
          return {
            __type: 'Set',
            values: Array.from(value),
          };
        }

        if (value instanceof Map) {
          return {
            __type: 'Map',
            entries: Array.from(value.entries()),
          };
        }

        if (typeof value === 'bigint') {
          return {
            __type: 'BigInt',
            value: value.toString(),
          };
        }

        if (typeof value === 'symbol') {
          return {
            __type: 'Symbol',
            description: value.description,
          };
        }

        // Handle circular references
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return { __type: 'Circular', ref: '[Circular]' };
          }
          seen.add(value);
        }

        return value;
      };

      if (pretty) {
        return JSON.stringify(result, replacer, indent);
      } else {
        return JSON.stringify(result, replacer);
      }
    } catch (error) {
      // Fallback for any serialization errors
      return JSON.stringify({
        __error: 'Failed to serialize result',
        message: (error as Error).message,
        type: typeof result,
      });
    }
  }

  /**
   * Check if formatter supports given format
   */
  supports(format: OutputFormat): boolean {
    return format === 'json';
  }

  /**
   * Format as compact JSON (single line)
   */
  formatCompact(result: any): string {
    return this.formatResult(result, { pretty: false });
  }

  /**
   * Format as pretty JSON (indented)
   */
  formatPretty(result: any, indent = 2): string {
    return this.formatResult(result, { pretty: true, indent });
  }

  /**
   * Parse JSON string safely
   */
  parse<T = any>(jsonString: string): T | null {
    try {
      return JSON.parse(jsonString);
    } catch {
      return null;
    }
  }

  /**
   * Validate JSON string
   */
  isValid(jsonString: string): boolean {
    try {
      JSON.parse(jsonString);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Format with metadata wrapper
   */
  formatWithMetadata(result: any, metadata: Record<string, any>): string {
    return this.formatResult({
      metadata,
      data: result,
    });
  }

  /**
   * Format as JSON Lines (newline-delimited JSON)
   */
  formatLines(items: any[]): string {
    return items
      .map((item) => this.formatResult(item, { pretty: false }))
      .join('\n');
  }

  /**
   * Format error as JSON
   */
  formatError(error: Error | string): string {
    const errorObj =
      typeof error === 'string'
        ? { error: error }
        : {
            error: error.message,
            name: error.name,
            stack: error.stack,
          };

    return this.formatResult(errorObj);
  }

  /**
   * Format success response
   */
  formatSuccess(data: any, message?: string): string {
    return this.formatResult({
      success: true,
      message,
      data,
    });
  }

  /**
   * Escape special characters for JSON
   */
  escape(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\f/g, '\\f')
      .replace(/\b/g, '\\b');
  }

  /**
   * Minify JSON (remove whitespace)
   */
  minify(jsonString: string): string {
    try {
      const parsed = JSON.parse(jsonString);
      return JSON.stringify(parsed);
    } catch {
      // If parsing fails, return original
      return jsonString;
    }
  }

  /**
   * Beautify JSON (add indentation)
   */
  beautify(jsonString: string, indent = 2): string {
    try {
      const parsed = JSON.parse(jsonString);
      return JSON.stringify(parsed, null, indent);
    } catch {
      // If parsing fails, return original
      return jsonString;
    }
  }

  /**
   * Merge multiple JSON objects
   */
  merge(...objects: any[]): string {
    const merged = Object.assign({}, ...objects);
    return this.formatResult(merged);
  }

  /**
   * Filter JSON by keys
   */
  filter(result: any, keys: string[]): string {
    if (typeof result !== 'object' || result === null) {
      return this.formatResult(result);
    }

    const filtered: Record<string, any> = {};
    for (const key of keys) {
      if (key in result) {
        filtered[key] = result[key];
      }
    }

    return this.formatResult(filtered);
  }
}

export const jsonFormatter = new JSONFormatter();
