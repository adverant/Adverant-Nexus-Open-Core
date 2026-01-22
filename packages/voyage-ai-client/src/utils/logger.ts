/**
 * Shared logger for VoyageAI client
 * Can be configured by consuming services
 */

import winston from 'winston';

export let logger: winston.Logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'voyage-ai-client' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Allow consuming services to configure the logger
 */
export function configureLogger(customLogger: winston.Logger): void {
  logger = customLogger;
}

/**
 * Create a child logger with additional metadata
 */
export function createChildLogger(metadata: Record<string, any>): winston.Logger {
  return logger.child(metadata);
}
