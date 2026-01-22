/**
 * Error Factory
 * Convenient methods to create common errors and convert unknown errors to AppErrors
 */

import { AppError } from './base-error';
import {
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
  ServiceUnavailableError,
  TimeoutError,
  DatabaseError,
  ExternalAPIError,
  OperationError,
  LLMServiceError,
  CircuitBreakerOpenError,
  RetryBudgetExceededError,
  TaskNotFoundError,
  WorkerWatchdogTimeoutError,
  StateDesynchronizationError,
} from './errors';

export class ErrorFactory {
  static validation(message: string, context?: Record<string, any>): ValidationError {
    return new ValidationError(message, context);
  }

  static authentication(message: string, context?: Record<string, any>): AuthenticationError {
    return new AuthenticationError(message, context);
  }

  static authorization(message: string, context?: Record<string, any>): AuthorizationError {
    return new AuthorizationError(message, context);
  }

  static notFound(message: string, context?: Record<string, any>): NotFoundError {
    return new NotFoundError(message, context);
  }

  static conflict(message: string, context?: Record<string, any>): ConflictError {
    return new ConflictError(message, context);
  }

  static rateLimit(message: string, retryAfter: number, context?: Record<string, any>): RateLimitError {
    return new RateLimitError(message, retryAfter, context);
  }

  static internalServer(message: string, context?: Record<string, any>): InternalServerError {
    return new InternalServerError(message, context);
  }

  static serviceUnavailable(message: string, context?: Record<string, any>, suggestion?: string): ServiceUnavailableError {
    return new ServiceUnavailableError(message, context, suggestion);
  }

  static timeout(message: string, context?: Record<string, any>): TimeoutError {
    return new TimeoutError(message, context);
  }

  static database(message: string, operation: string, database: string, originalError?: Error): DatabaseError {
    return new DatabaseError(message, operation, database, originalError);
  }

  static externalAPI(service: string, operation: string, originalError?: Error): ExternalAPIError {
    return new ExternalAPIError(service, operation, originalError);
  }

  static operation(message: string, context?: Record<string, any>): OperationError {
    return new OperationError(message, context);
  }

  static llmService(provider: string, operation: string, originalError: Error, context?: Record<string, any>): LLMServiceError {
    return new LLMServiceError(provider, operation, originalError, context);
  }

  static circuitBreakerOpen(message: string, details: { state: string; stats: any; retryAfter: number }): CircuitBreakerOpenError {
    return new CircuitBreakerOpenError(message, details);
  }

  static retryBudgetExceeded(taskId: string, attempts: number, duration: number): RetryBudgetExceededError {
    return new RetryBudgetExceededError(taskId, attempts, duration);
  }

  static taskNotFound(taskId: string): TaskNotFoundError {
    return new TaskNotFoundError(taskId);
  }

  static workerWatchdogTimeout(taskId: string, taskType: string, timeout: number): WorkerWatchdogTimeoutError {
    return new WorkerWatchdogTimeoutError(taskId, taskType, timeout);
  }

  static stateDesynchronization(taskId: string, details: string): StateDesynchronizationError {
    return new StateDesynchronizationError(taskId, details);
  }

  /**
   * Create error from HTTP status code
   */
  static fromStatusCode(statusCode: number, message?: string, context?: Record<string, any>): AppError {
    switch (statusCode) {
      case 400:
        return new ValidationError(message || 'Bad request', context);
      case 401:
        return new AuthenticationError(message || 'Authentication required', context);
      case 403:
        return new AuthorizationError(message || 'Insufficient permissions', context);
      case 404:
        return new NotFoundError(message || 'Resource not found', context);
      case 409:
        return new ConflictError(message || 'Conflict', context);
      case 429:
        return new RateLimitError(message || 'Rate limit exceeded', 60000, context);
      case 503:
        return new ServiceUnavailableError(message || 'Service unavailable', context);
      case 504:
        return new TimeoutError(message || 'Request timeout', context);
      default:
        return new InternalServerError(message || 'Internal server error', context);
    }
  }
}

/**
 * Utility functions
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isOperationalError(error: unknown): boolean {
  return isAppError(error) && error.isOperational;
}

/**
 * Error factory for converting unknown errors
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    // Try to infer error type from message
    const message = error.message.toLowerCase();

    if (message.includes('timeout')) {
      return new TimeoutError(error.message, { originalError: error.name });
    }
    if (message.includes('not found')) {
      return new NotFoundError(error.message, { originalError: error.name });
    }
    if (message.includes('unauthorized') || message.includes('authentication')) {
      return new AuthenticationError(error.message, { originalError: error.name });
    }
    if (message.includes('forbidden') || message.includes('permission')) {
      return new AuthorizationError(error.message, { originalError: error.name });
    }
    if (message.includes('conflict') || message.includes('already exists')) {
      return new ConflictError(error.message, { originalError: error.name });
    }
    if (message.includes('validation') || message.includes('invalid')) {
      return new ValidationError(error.message, { originalError: error.name });
    }

    return new InternalServerError(error.message, { originalError: error.name });
  }

  return new InternalServerError('An unexpected error occurred', { error: String(error) });
}
