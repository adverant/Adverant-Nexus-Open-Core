import winston from 'winston';
import { config } from '../config';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: config.logLevel || 'info',
  format: logFormat,
  defaultMeta: { service: 'graphrag' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...metadata }) => {
          // Safely stringify message if it's an object/array
          let formattedMessage: string;

          if (typeof message === 'string') {
            formattedMessage = message;
          } else if (message instanceof Error) {
            // Preserve error stack traces
            formattedMessage = message.stack || message.message;
          } else if (typeof message === 'object') {
            // Stringify objects/arrays for readable output
            formattedMessage = JSON.stringify(message);
          } else {
            // Handle primitives (number, boolean, etc.)
            formattedMessage = String(message);
          }

          // Format metadata for display
          const meta = Object.keys(metadata).length > 0
            ? ` ${JSON.stringify(metadata)}`
            : '';

          return `${level}: ${formattedMessage}${meta}`;
        })
      )
    })
  ]
});

// Production file logging
if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.File({
    filename: '/var/log/graphrag/error.log',
    level: 'error',
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }));
  
  logger.add(new winston.transports.File({
    filename: '/var/log/graphrag/combined.log',
    maxsize: 5242880, // 5MB
    maxFiles: 5
  }));
}
