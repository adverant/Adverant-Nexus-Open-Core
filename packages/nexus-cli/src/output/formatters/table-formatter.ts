/**
 * Table Formatter
 *
 * Structured table output formatting
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import type {
  OutputFormatter,
  FormatOptions,
  OutputFormat,
  TableColumn,
} from '../../types/output.js';

export class TableFormatter implements OutputFormatter {
  readonly format: OutputFormat = 'table';

  /**
   * Format result as table
   */
  formatResult(result: any, options?: FormatOptions): string {
    const colors = options?.colors ?? true;

    // Handle array of objects
    if (Array.isArray(result) && result.length > 0) {
      return this.formatArrayOfObjects(result, options);
    }

    // Handle single object as vertical table
    if (typeof result === 'object' && result !== null) {
      return this.formatObjectAsVerticalTable(result, options);
    }

    // Handle primitives
    return String(result);
  }

  /**
   * Check if formatter supports given format
   */
  supports(format: OutputFormat): boolean {
    return format === 'table';
  }

  /**
   * Format array of objects as horizontal table
   */
  private formatArrayOfObjects(data: any[], options?: FormatOptions): string {
    const colors = options?.colors ?? true;

    // Auto-detect columns from first row
    const columns = this.detectColumns(data);

    // Create table
    const table = new Table({
      head: columns.map((col) =>
        colors ? chalk.bold.cyan(col.header) : col.header
      ),
      colAligns: columns.map((col) => col.align || 'left'),
      style: {
        head: colors ? ['cyan'] : [],
        border: colors ? ['gray'] : [],
      },
      wordWrap: true,
      wrapOnWordBoundary: false,
    });

    // Add rows
    for (const row of data) {
      const tableRow = columns.map((col) => {
        const value = this.getNestedValue(row, col.key);
        return col.format ? col.format(value) : this.formatValue(value, colors);
      });
      table.push(tableRow);
    }

    return table.toString();
  }

  /**
   * Format object as vertical table (key-value pairs)
   */
  private formatObjectAsVerticalTable(data: Record<string, any>, options?: FormatOptions): string {
    const colors = options?.colors ?? true;

    const table = new Table({
      style: {
        head: colors ? ['cyan'] : [],
        border: colors ? ['gray'] : [],
      },
      wordWrap: true,
      wrapOnWordBoundary: false,
    });

    for (const [key, value] of Object.entries(data)) {
      const formattedKey = colors ? chalk.bold(key) : key;
      const formattedValue = this.formatValue(value, colors);
      table.push({ [formattedKey]: formattedValue });
    }

    return table.toString();
  }

  /**
   * Format data with custom columns
   */
  formatWithColumns(data: any[], columns: TableColumn[], options?: FormatOptions): string {
    const colors = options?.colors ?? true;

    const table = new Table({
      head: columns.map((col) =>
        colors ? chalk.bold.cyan(col.header) : col.header
      ),
      colAligns: columns.map((col) => col.align || 'left'),
      colWidths: columns.map((col) => col.width ?? null),
      style: {
        head: colors ? ['cyan'] : [],
        border: colors ? ['gray'] : [],
      },
      wordWrap: true,
      wrapOnWordBoundary: false,
    });

    // Add rows
    for (const row of data) {
      const tableRow = columns.map((col) => {
        const value = this.getNestedValue(row, col.key);
        return col.format ? col.format(value) : this.formatValue(value, colors);
      });
      table.push(tableRow);
    }

    return table.toString();
  }

  /**
   * Auto-detect columns from data
   */
  private detectColumns(data: any[]): TableColumn[] {
    if (data.length === 0) return [];

    // Get all unique keys from all rows
    const keys = new Set<string>();
    for (const row of data) {
      if (typeof row === 'object' && row !== null) {
        Object.keys(row).forEach((key) => keys.add(key));
      }
    }

    // Create column definitions
    return Array.from(keys).map((key) => ({
      key,
      header: this.formatHeader(key),
      align: this.detectAlignment(data, key),
    }));
  }

  /**
   * Format header (convert camelCase to Title Case)
   */
  private formatHeader(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1') // Add space before capitals
      .replace(/^./, (str) => str.toUpperCase()) // Capitalize first letter
      .trim();
  }

  /**
   * Detect alignment based on data type
   */
  private detectAlignment(data: any[], key: string): 'left' | 'center' | 'right' {
    // Sample first few rows
    const samples = data.slice(0, 10);
    const values = samples.map((row) => this.getNestedValue(row, key));

    // If all numbers, right-align
    if (values.every((v) => typeof v === 'number')) {
      return 'right';
    }

    // If all booleans, center-align
    if (values.every((v) => typeof v === 'boolean')) {
      return 'center';
    }

    // Default to left-align
    return 'left';
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let value = obj;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Format value for display
   */
  private formatValue(value: any, colors: boolean): string {
    if (value === null) {
      return colors ? chalk.dim('null') : 'null';
    }

    if (value === undefined) {
      return colors ? chalk.dim('-') : '-';
    }

    if (typeof value === 'boolean') {
      return colors
        ? value
          ? chalk.green('✓')
          : chalk.red('✗')
        : value
        ? '✓'
        : '✗';
    }

    if (typeof value === 'number') {
      return colors ? chalk.cyan(String(value)) : String(value);
    }

    if (typeof value === 'string') {
      // Truncate long strings
      if (value.length > 50) {
        return value.slice(0, 47) + '...';
      }
      return value;
    }

    if (Array.isArray(value)) {
      return colors
        ? chalk.dim(`[${value.length} items]`)
        : `[${value.length} items]`;
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      return colors
        ? chalk.dim(`{${keys.length} props}`)
        : `{${keys.length} props}`;
    }

    return String(value);
  }

  /**
   * Format as simple table (no borders)
   */
  formatSimple(data: any[], options?: FormatOptions): string {
    const colors = options?.colors ?? true;
    const columns = this.detectColumns(data);

    // Calculate column widths
    const widths = columns.map((col) => {
      const headerWidth = col.header.length;
      const maxValueWidth = Math.max(
        ...data.map((row) => {
          const value = this.getNestedValue(row, col.key);
          return this.formatValue(value, false).length;
        })
      );
      return Math.max(headerWidth, maxValueWidth);
    });

    // Create header
    const header = columns
      .map((col, i) => {
        const text = col.header.padEnd(widths[i]);
        return colors ? chalk.bold.cyan(text) : text;
      })
      .join('  ');

    // Create separator
    const separator = columns
      .map((_, i) => '─'.repeat(widths[i]))
      .join('  ');

    // Create rows
    const rows = data.map((row) => {
      return columns
        .map((col, i) => {
          const value = this.getNestedValue(row, col.key);
          const formatted = col.format
            ? col.format(value)
            : this.formatValue(value, colors);

          // Align based on column alignment
          if (col.align === 'right') {
            return formatted.padStart(widths[i]);
          } else if (col.align === 'center') {
            const padding = widths[i] - formatted.length;
            const leftPad = Math.floor(padding / 2);
            const rightPad = padding - leftPad;
            return ' '.repeat(leftPad) + formatted + ' '.repeat(rightPad);
          } else {
            return formatted.padEnd(widths[i]);
          }
        })
        .join('  ');
    });

    return [header, separator, ...rows].join('\n');
  }

  /**
   * Format as CSV
   */
  formatCSV(data: any[]): string {
    if (data.length === 0) return '';

    const columns = this.detectColumns(data);

    // Header
    const header = columns.map((col) => this.escapeCSV(col.key)).join(',');

    // Rows
    const rows = data.map((row) => {
      return columns
        .map((col) => {
          const value = this.getNestedValue(row, col.key);
          return this.escapeCSV(String(value ?? ''));
        })
        .join(',');
    });

    return [header, ...rows].join('\n');
  }

  /**
   * Escape CSV value
   */
  private escapeCSV(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}

export const tableFormatter = new TableFormatter();
