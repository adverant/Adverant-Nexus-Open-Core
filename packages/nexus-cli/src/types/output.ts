/**
 * Output Type Definitions
 *
 * Types for output formatting, rendering, and display
 */

export type OutputFormat = 'text' | 'json' | 'yaml' | 'table' | 'stream-json';

export interface OutputFormatter {
  format: OutputFormat;
  formatResult(result: any, options?: FormatOptions): string;
  supports(format: OutputFormat): boolean;
}

export interface FormatOptions {
  pretty?: boolean;
  colors?: boolean;
  maxWidth?: number;
  indent?: number;
  headers?: boolean;
}

export interface TableColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  format?: (value: any) => string;
}

export interface StreamEvent {
  type: 'progress' | 'data' | 'result' | 'error' | 'complete';
  timestamp: string;
  data: any;
  metadata?: StreamMetadata;
}

export interface StreamMetadata {
  progress?: number; // 0-100
  step?: string;
  current?: number;
  total?: number;
  eta?: number;
  rate?: number;
}

export interface ProgressOptions {
  total?: number;
  current?: number;
  message?: string;
  spinner?: boolean;
  showPercentage?: boolean;
  showETA?: boolean;
}

export interface OutputRenderer {
  render(content: string, options?: RenderOptions): void;
  renderProgress(options: ProgressOptions): ProgressController;
  renderTable(data: any[], columns: TableColumn[]): void;
  renderList(items: any[], options?: ListOptions): void;
  renderBox(content: string, options?: BoxOptions): void;
  clear(): void;
  success(message: string): void;
  error(message: string): void;
  warning(message: string): void;
  info(message: string): void;
  renderHeader(text: string): void;
  renderSeparator(): void;
  renderBlankLine(): void;
}

export interface RenderOptions {
  newline?: boolean;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

export interface ListOptions {
  ordered?: boolean;
  indent?: number;
  bullet?: string;
}

export interface BoxOptions {
  title?: string;
  padding?: number;
  margin?: number;
  borderStyle?: 'single' | 'double' | 'round' | 'bold';
  borderColor?: string;
  align?: 'left' | 'center' | 'right';
}

export interface ProgressController {
  update(progress: number | ProgressOptions): void;
  succeed(message?: string): void;
  fail(message?: string): void;
  warn(message?: string): void;
  info(message?: string): void;
  stop(): void;
}

export interface LogLevel {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: any;
  timestamp: Date;
}

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  success(message: string, ...args: any[]): void;
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void;
  setVerbose(verbose: boolean): void;
  setQuiet(quiet: boolean): void;
}
