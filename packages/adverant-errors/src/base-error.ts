/**
 * Base Error Class
 * All custom errors extend this class
 */

import { v4 as uuidv4 } from 'uuid';

export interface ErrorContext {
  [key: string]: any;
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export abstract class AppError extends Error {
  abstract code: string;
  abstract statusCode: number;
  abstract severity: ErrorSeverity;

  context?: Record<string, any>;
  errorId: string;
  timestamp: Date;
  isOperational: boolean;
  suggestion?: string;
  troubleshooting?: Record<string, string>;

  constructor(
    message: string,
    context?: Record<string, any>,
    suggestion?: string
  ) {
    super(message);
    this.errorId = uuidv4();
    this.timestamp = new Date();
    this.isOperational = true;
    this.context = context;
    this.suggestion = suggestion;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      errorId: this.errorId,
      timestamp: this.timestamp.toISOString(),
      statusCode: this.statusCode,
      severity: this.severity,
      suggestion: this.suggestion,
      troubleshooting: this.troubleshooting,
      context: process.env.NODE_ENV === 'production' ? undefined : this.context
    };
  }
}
