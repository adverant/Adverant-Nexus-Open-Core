/**
 * Core Logger Implementation
 * Unified logging solution for Nexus stack services
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { Logger, LoggerConfig, LogMetadata } from './types';

const { combine, timestamp, json, printf, colorize, errors } = winston.format;

/**
 * Create a Winston logger instance with standardized configuration
 */
export function createLogger(config: LoggerConfig): Logger {
  const {
    service,
    level = 'info',
    enableConsole = true,
    enableFile = false,
    filePath,
    enableDailyRotate = false,
    maxFiles = '14d',
    maxSize = '20m',
    format: logFormat,
    metadata = {},
    environment = process.env.NODE_ENV || 'development',
    version = process.env.SERVICE_VERSION || '1.0.0',
  } = config;

  // Determine format based on environment
  const useJsonFormat = logFormat === 'json' || (logFormat === undefined && environment === 'production');

  // Base metadata to include in all logs
  const baseMetadata = {
    service,
    environment,
    version,
    ...metadata,
  };

  // Create format
  const loggerFormat = useJsonFormat
    ? combine(
        errors({ stack: true }),
        timestamp(),
        json()
      )
    : combine(
        errors({ stack: true }),
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        printf(({timestamp, level, message, service, correlationId, ...meta}) => {
          const correlationPart = correlationId ? `[${correlationId}] ` : '';
          const metaPart = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}] [${service}] ${correlationPart}${message}${metaPart}`;
        })
      );

  // Create transports
  const transports: winston.transport[] = [];

  if (enableConsole) {
    transports.push(new winston.transports.Console());
  }

  if (enableFile) {
    const fileLogPath = filePath || `logs/${service}.log`;
    transports.push(new winston.transports.File({
      filename: fileLogPath,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
    }));
  }

  if (enableDailyRotate) {
    const rotateLogPath = filePath || `logs/${service}-%DATE%.log`;
    transports.push(new DailyRotateFile({
      filename: rotateLogPath,
      datePattern: 'YYYY-MM-DD',
      maxSize,
      maxFiles,
      zippedArchive: true,
    }));
  }

  // Create Winston logger
  const winstonLogger = winston.createLogger({
    level,
    format: loggerFormat,
    defaultMeta: baseMetadata,
    transports,
    exitOnError: false,
  });

  // Wrapper for type-safe logging
  const logger: Logger = {
    debug(message: string, metadata?: LogMetadata) {
      winstonLogger.debug(message, metadata);
    },

    info(message: string, metadata?: LogMetadata) {
      winstonLogger.info(message, metadata);
    },

    warn(message: string, metadata?: LogMetadata) {
      winstonLogger.warn(message, metadata);
    },

    error(message: string, metadata?: LogMetadata) {
      // If metadata contains an Error object, extract stack trace
      if (metadata?.error instanceof Error) {
        metadata = {
          ...metadata,
          error: metadata.error.message,
          stack: metadata.error.stack,
        };
      }
      winstonLogger.error(message, metadata);
    },

    child(metadata: LogMetadata): Logger {
      const childLogger = winstonLogger.child(metadata);
      return {
        debug(message: string, meta?: LogMetadata) {
          childLogger.debug(message, meta);
        },
        info(message: string, meta?: LogMetadata) {
          childLogger.info(message, meta);
        },
        warn(message: string, meta?: LogMetadata) {
          childLogger.warn(message, meta);
        },
        error(message: string, meta?: LogMetadata) {
          if (meta?.error instanceof Error) {
            meta = {
              ...meta,
              error: meta.error.message,
              stack: meta.error.stack,
            };
          }
          childLogger.error(message, meta);
        },
        child(childMetadata: LogMetadata): Logger {
          return logger.child({ ...metadata, ...childMetadata });
        },
        getWinstonLogger() {
          return childLogger;
        },
      };
    },

    getWinstonLogger() {
      return winstonLogger;
    },
  };

  return logger;
}

/**
 * Default logger for quick usage
 */
export const defaultLogger = createLogger({
  service: 'default',
  level: 'info',
});
