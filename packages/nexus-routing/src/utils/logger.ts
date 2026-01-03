/**
 * Unified Logger for Nexus Routing Package
 * Winston-based logging with structured output
 */

import winston from 'winston';

const logLevel = process.env.LOG_LEVEL || 'info';
const mcpMode = process.env.MCP_MODE === 'true';

// Create logger instance
export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'nexus-routing' },
  transports: [
    // Console transport - use stderr in MCP mode to avoid interfering with JSON-RPC on stdout
    new winston.transports.Console({
      stderrLevels: mcpMode ? ['error', 'warn', 'info', 'debug'] : ['error'],
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          // In MCP mode, only log errors to stderr
          if (mcpMode && level !== 'error') {
            return '';
          }

          const metaStr = Object.keys(meta).length > 0
            ? ` ${JSON.stringify(meta)}`
            : '';

          return `${timestamp} [${level}]: ${message}${metaStr}`;
        })
      )
    })
  ]
});

// Suppress all logs in strict MCP mode except errors
if (mcpMode && logLevel === 'error') {
  logger.info = () => logger;
  logger.debug = () => logger;
  logger.warn = () => logger;
}

export default logger;
