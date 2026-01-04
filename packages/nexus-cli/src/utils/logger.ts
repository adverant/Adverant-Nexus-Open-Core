/**
 * Production-Grade Logger for Nexus CLI
 *
 * Provides structured logging with multiple levels, color support,
 * and configurable verbosity.
 */

import chalk from 'chalk';
import { Logger } from '../types/output.js';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  level?: LogLevel;
  verbose?: boolean;
  quiet?: boolean;
  colors?: boolean;
  timestamp?: boolean;
  logFile?: string;
}

/**
 * Production-grade logger implementation
 */
export class NexusLogger implements Logger {
  private level: LogLevel = 'info';
  private verbose: boolean = false;
  private quiet: boolean = false;
  private colors: boolean = true;
  private timestamp: boolean = false;
  private logFile?: string;
  private fileStream?: fs.WriteStream;

  private readonly levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(options: LoggerOptions = {}) {
    if (options.level) {
      this.level = options.level;
    }
    if (options.verbose !== undefined) {
      this.verbose = options.verbose;
    }
    if (options.quiet !== undefined) {
      this.quiet = options.quiet;
    }
    if (options.colors !== undefined) {
      this.colors = options.colors;
    }
    if (options.timestamp !== undefined) {
      this.timestamp = options.timestamp;
    }
    if (options.logFile) {
      this.logFile = options.logFile;
      this.initializeFileStream();
    }

    // Adjust level based on verbose/quiet
    if (this.verbose) {
      this.level = 'debug';
    }
    if (this.quiet) {
      this.level = 'error';
    }
  }

  private initializeFileStream(): void {
    if (!this.logFile) return;

    try {
      const logDir = path.dirname(this.logFile);
      fs.ensureDirSync(logDir);
      this.fileStream = fs.createWriteStream(this.logFile, { flags: 'a' });
    } catch (error) {
      console.error('Failed to initialize log file:', error);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.level];
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
    let formatted = message;

    // Add arguments if any
    if (args.length > 0) {
      const argsStr = args
        .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
        .join(' ');
      formatted = `${formatted} ${argsStr}`;
    }

    // Add timestamp if enabled
    if (this.timestamp) {
      formatted = `[${this.formatTimestamp()}] ${formatted}`;
    }

    return formatted;
  }

  private writeToFile(level: LogLevel, message: string): void {
    if (!this.fileStream) return;

    const timestamp = this.formatTimestamp();
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

    try {
      this.fileStream.write(logLine);
    } catch (error) {
      // Silent fail for file writes
    }
  }

  private log(level: LogLevel, color: string, message: string, ...args: any[]): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, message, ...args);

    // Write to file first
    this.writeToFile(level, formatted);

    // Don't write to console in quiet mode unless it's an error
    if (this.quiet && level !== 'error') return;

    // Format for console
    let output: string;
    if (this.colors) {
      // @ts-ignore - dynamic chalk color access
      const colorFn = chalk[color];
      const levelBadge = colorFn.bold(`[${level.toUpperCase()}]`);
      output = `${levelBadge} ${formatted}`;
    } else {
      output = `[${level.toUpperCase()}] ${formatted}`;
    }

    // Write to appropriate stream
    if (level === 'error') {
      console.error(output);
    } else {
      console.log(output);
    }
  }

  debug(message: string, ...args: any[]): void {
    this.log('debug', 'gray', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log('info', 'blue', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log('warn', 'yellow', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.log('error', 'red', message, ...args);
  }

  success(message: string, ...args: any[]): void {
    if (!this.shouldLog('info')) return;

    const formatted = this.formatMessage('info', message, ...args);
    this.writeToFile('info', formatted);

    if (this.quiet) return;

    let output: string;
    if (this.colors) {
      output = `${chalk.green.bold('[SUCCESS]')} ${formatted}`;
    } else {
      output = `[SUCCESS] ${formatted}`;
    }

    console.log(output);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
    if (verbose) {
      this.level = 'debug';
    }
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
    if (quiet) {
      this.level = 'error';
    }
  }

  /**
   * Close the file stream if open
   */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = undefined;
    }
  }
}

/**
 * Create a default logger instance
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return new NexusLogger(options);
}

/**
 * Default logger instance for use throughout the CLI
 */
export const logger = createLogger();

/**
 * Create a logger with file output enabled
 */
export function createFileLogger(logFile?: string): Logger {
  const defaultLogFile = logFile || path.join(os.homedir(), '.nexus', 'logs', 'nexus.log');
  return createLogger({ logFile: defaultLogFile });
}
