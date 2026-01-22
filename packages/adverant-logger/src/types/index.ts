/**
 * Type definitions for @adverant/logger
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFormat = 'json' | 'pretty';

export interface LoggerConfig {
  /** Service name (required) */
  service: string;

  /** Log level (default: 'info') */
  level?: LogLevel;

  /** Enable console transport (default: true) */
  enableConsole?: boolean;

  /** Enable file transport (default: false) */
  enableFile?: boolean;

  /** Log file path (default: 'logs/{service}.log') */
  filePath?: string;

  /** Enable daily rotate file transport (default: false) */
  enableDailyRotate?: boolean;

  /** Max files for rotation (default: '14d') */
  maxFiles?: string;

  /** Max file size for rotation (default: '20m') */
  maxSize?: string;

  /** Log format (default: 'json' in production, 'pretty' in development) */
  format?: LogFormat;

  /** Additional metadata to include in all logs */
  metadata?: Record<string, any>;

  /** Environment (default: process.env.NODE_ENV) */
  environment?: string;

  /** Service version (default: process.env.SERVICE_VERSION) */
  version?: string;
}

export interface LogMetadata {
  [key: string]: any;
}

export interface Logger {
  /** Log debug message */
  debug(message: string, metadata?: LogMetadata): void;

  /** Log info message */
  info(message: string, metadata?: LogMetadata): void;

  /** Log warning message */
  warn(message: string, metadata?: LogMetadata): void;

  /** Log error message */
  error(message: string, metadata?: LogMetadata): void;

  /** Create child logger with additional context */
  child(metadata: LogMetadata): Logger;

  /** Get Winston logger instance (for advanced use) */
  getWinstonLogger(): any;
}

export interface CorrelationIdConfig {
  /** Header name for correlation ID (default: 'x-correlation-id') */
  headerName?: string;

  /** Generate correlation ID if not provided (default: true) */
  generateIfMissing?: boolean;

  /** Include in response headers (default: true) */
  includeInResponse?: boolean;
}
