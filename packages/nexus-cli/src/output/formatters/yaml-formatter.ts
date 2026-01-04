/**
 * YAML Formatter
 *
 * YAML output formatting for configuration files
 */

import YAML from 'yaml';
import type { OutputFormatter, FormatOptions, OutputFormat } from '../../types/output.js';

export class YAMLFormatter implements OutputFormatter {
  readonly format: OutputFormat = 'yaml';

  /**
   * Format result as YAML
   */
  formatResult(result: any, options?: FormatOptions): string {
    const indent = options?.indent ?? 2;

    try {
      // Configure YAML stringify options
      const yamlOptions: YAML.DocumentOptions & YAML.SchemaOptions & YAML.ParseOptions & YAML.CreateNodeOptions & YAML.ToStringOptions = {
        indent,
        lineWidth: options?.maxWidth ?? 80,
        minContentWidth: 20,
        schema: 'core',
      };

      // Handle special types
      const processed = this.preprocessValue(result);

      return YAML.stringify(processed, yamlOptions);
    } catch (error) {
      // Fallback for serialization errors
      return `# Error formatting YAML\n# ${(error as Error).message}\n`;
    }
  }

  /**
   * Check if formatter supports given format
   */
  supports(format: OutputFormat): boolean {
    return format === 'yaml';
  }

  /**
   * Preprocess value to handle special types
   */
  private preprocessValue(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle errors
    if (value instanceof Error) {
      return {
        error: value.message,
        name: value.name,
        stack: value.stack?.split('\n'),
      };
    }

    // Handle dates
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle RegExp
    if (value instanceof RegExp) {
      return {
        pattern: value.source,
        flags: value.flags,
      };
    }

    // Handle Set
    if (value instanceof Set) {
      return Array.from(value);
    }

    // Handle Map
    if (value instanceof Map) {
      return Object.fromEntries(value.entries());
    }

    // Handle BigInt
    if (typeof value === 'bigint') {
      return value.toString();
    }

    // Handle Symbol
    if (typeof value === 'symbol') {
      return `Symbol(${value.description || ''})`;
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item) => this.preprocessValue(item));
    }

    // Handle objects
    if (typeof value === 'object') {
      const processed: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        processed[key] = this.preprocessValue(val);
      }
      return processed;
    }

    return value;
  }

  /**
   * Parse YAML string
   */
  parse<T = any>(yamlString: string): T | null {
    try {
      return YAML.parse(yamlString);
    } catch {
      return null;
    }
  }

  /**
   * Validate YAML string
   */
  isValid(yamlString: string): boolean {
    try {
      YAML.parse(yamlString);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Format with comments
   */
  formatWithComments(result: any, comments: Record<string, string>): string {
    const yaml = this.formatResult(result);
    const lines = yaml.split('\n');

    // Add comments after relevant keys
    const commented = lines.map((line) => {
      const match = line.match(/^(\s*)([^:]+):/);
      if (match) {
        const key = match[2].trim();
        if (comments[key]) {
          return `${line}  # ${comments[key]}`;
        }
      }
      return line;
    });

    return commented.join('\n');
  }

  /**
   * Format as compact YAML (flow style)
   */
  formatCompact(result: any): string {
    try {
      const doc = new YAML.Document(result);
      doc.setSchema('1.2');
      doc.contents = doc.createNode(result, {
        flow: true
      });
      return doc.toString();
    } catch {
      return this.formatResult(result);
    }
  }

  /**
   * Format multiple documents
   */
  formatMultiple(documents: any[]): string {
    return documents
      .map((doc) => '---\n' + this.formatResult(doc))
      .join('\n');
  }

  /**
   * Format with metadata header
   */
  formatWithMetadata(result: any, metadata: Record<string, any>): string {
    const header = Object.entries(metadata)
      .map(([key, value]) => `# ${key}: ${value}`)
      .join('\n');

    return `${header}\n---\n${this.formatResult(result)}`;
  }

  /**
   * Format error as YAML
   */
  formatError(error: Error | string): string {
    const errorObj =
      typeof error === 'string'
        ? { error }
        : {
            error: error.message,
            name: error.name,
            stack: error.stack?.split('\n'),
          };

    return this.formatResult(errorObj);
  }

  /**
   * Convert JSON to YAML
   */
  fromJSON(jsonString: string): string {
    try {
      const parsed = JSON.parse(jsonString);
      return this.formatResult(parsed);
    } catch (error) {
      return `# Error parsing JSON\n# ${(error as Error).message}\n`;
    }
  }

  /**
   * Convert YAML to JSON
   */
  toJSON(yamlString: string): string {
    try {
      const parsed = YAML.parse(yamlString);
      return JSON.stringify(parsed, null, 2);
    } catch (error) {
      return JSON.stringify({
        error: 'Failed to parse YAML',
        message: (error as Error).message,
      });
    }
  }

  /**
   * Merge multiple YAML documents
   */
  merge(...yamls: string[]): string {
    try {
      const parsed = yamls.map((yaml) => YAML.parse(yaml));
      const merged = Object.assign({}, ...parsed);
      return this.formatResult(merged);
    } catch (error) {
      return `# Error merging YAML\n# ${(error as Error).message}\n`;
    }
  }

  /**
   * Quote strings that need quoting
   */
  private quoteIfNeeded(value: string): string {
    // Quote if contains special characters
    if (/[:#@\[\]{}|>]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
      return `"${value}"`;
    }
    return value;
  }

  /**
   * Format key-value pairs
   */
  formatKeyValue(data: Record<string, any>, options?: FormatOptions): string {
    return this.formatResult(data, options);
  }
}

export const yamlFormatter = new YAMLFormatter();
