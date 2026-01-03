import winston from 'winston';

const format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    return JSON.stringify({
      timestamp,
      level,
      message,
      ...meta
    });
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format,
  defaultMeta: { service: 'mageagent' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    // Add file transport for production
    ...(process.env.NODE_ENV === 'production' ? [
      new winston.transports.File({ 
        filename: 'error.log', 
        level: 'error' 
      }),
      new winston.transports.File({ 
        filename: 'combined.log' 
      })
    ] : [])
  ]
});

// Create child logger for specific components
export function createLogger(component: string) {
  return logger.child({ component });
}
