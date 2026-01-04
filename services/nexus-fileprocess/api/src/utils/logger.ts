/**
 * Simple logger utility for FileProcessAgent API
 * Follows the same pattern as other Nexus Stack services
 */

import { config } from '../config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel: number = LOG_LEVELS[config.logLevel as LogLevel] || LOG_LEVELS.info;

function formatMessage(level: LogLevel, message: string, data?: any): string {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] [FileProcessAgent] ${message}${dataStr}`;
}

export const logger = {
  debug(message: string, data?: any): void {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.log(formatMessage('debug', message, data));
    }
  },

  info(message: string, data?: any): void {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(formatMessage('info', message, data));
    }
  },

  warn(message: string, data?: any): void {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(formatMessage('warn', message, data));
    }
  },

  error(message: string, data?: any): void {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(formatMessage('error', message, data));
    }
  }
};
