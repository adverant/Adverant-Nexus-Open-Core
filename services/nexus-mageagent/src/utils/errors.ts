/**
 * MageAgent Error Types
 *
 * Self-contained error hierarchy for MageAgent service
 * Inlined from @adverant/errors to avoid monorepo dependency issues in Docker
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Base Error Infrastructure
// ============================================================================

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

// ============================================================================
// Standard HTTP Error Classes
// ============================================================================

export class ValidationError extends AppError {
  code = 'VALIDATION_ERROR';
  statusCode = 400;
  severity = ErrorSeverity.LOW;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Check your input parameters and try again');
  }
}

export class AuthenticationError extends AppError {
  code = 'AUTHENTICATION_ERROR';
  statusCode = 401;
  severity = ErrorSeverity.MEDIUM;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Verify your credentials and try again');
  }
}

export class AuthorizationError extends AppError {
  code = 'AUTHORIZATION_ERROR';
  statusCode = 403;
  severity = ErrorSeverity.MEDIUM;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Contact your administrator for access');
  }
}

export class NotFoundError extends AppError {
  code = 'NOT_FOUND';
  statusCode = 404;
  severity = ErrorSeverity.LOW;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Verify the resource ID and try again');
  }
}

export class ConflictError extends AppError {
  code = 'CONFLICT';
  statusCode = 409;
  severity = ErrorSeverity.MEDIUM;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Resource already exists or is in use');
  }
}

export class RateLimitError extends AppError {
  code = 'RATE_LIMIT_EXCEEDED';
  statusCode = 429;
  severity = ErrorSeverity.MEDIUM;
  retryAfter: number;

  constructor(message: string, retryAfter: number, context?: Record<string, any>) {
    super(message, context, `Wait ${retryAfter}ms before retrying`);
    this.retryAfter = retryAfter;
  }
}

export class InternalServerError extends AppError {
  code = 'INTERNAL_SERVER_ERROR';
  statusCode = 500;
  severity = ErrorSeverity.HIGH;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'An unexpected error occurred. Please try again later');
  }
}

export class ServiceUnavailableError extends AppError {
  code = 'SERVICE_UNAVAILABLE';
  statusCode = 503;
  severity = ErrorSeverity.HIGH;

  constructor(message: string, context?: Record<string, any>, suggestion?: string) {
    super(message, context, suggestion || 'Service is temporarily unavailable');
  }
}

export class TimeoutError extends AppError {
  code = 'TIMEOUT';
  statusCode = 504;
  severity = ErrorSeverity.MEDIUM;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Operation timed out. Please try again');
  }
}

// ============================================================================
// Domain-Specific Error Classes
// ============================================================================

export class DatabaseError extends InternalServerError {
  code = 'DATABASE_ERROR';

  constructor(message: string, operation: string, database: string, originalError?: Error) {
    super(message, {
      operation,
      database,
      originalError: originalError?.message
    });
  }
}

export class ExternalAPIError extends ServiceUnavailableError {
  code = 'EXTERNAL_API_ERROR';

  constructor(service: string, operation: string, originalError?: Error) {
    super(
      `External API error: ${service}`,
      { service, operation, originalError: originalError?.message },
      `Check ${service} service status`
    );
  }
}

export class OperationError extends AppError {
  code = 'OPERATION_ERROR';
  statusCode = 409;
  severity = ErrorSeverity.MEDIUM;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Operation cannot be completed in current state');
  }
}

// ============================================================================
// Service-Specific Error Classes
// ============================================================================

export class LLMServiceError extends ServiceUnavailableError {
  severity = ErrorSeverity.HIGH;

  constructor(
    provider: string,
    operation: string,
    originalError: Error,
    context?: Record<string, any>
  ) {
    super(
      `LLM service error: ${provider} - ${operation}`,
      {
        ...context,
        provider,
        operation,
        originalError: originalError.message
      },
      `Check ${provider} API status and credentials`
    );
    this.code = 'LLM_SERVICE_ERROR';
  }
}

export class CircuitBreakerOpenError extends ServiceUnavailableError {
  severity = ErrorSeverity.MEDIUM;
  retryAfter: number;

  constructor(
    message: string,
    details: { state: string; stats: any; retryAfter: number }
  ) {
    super(
      message,
      details,
      `Wait ${details.retryAfter}ms before retrying`
    );
    this.code = 'CIRCUIT_BREAKER_OPEN';
    this.retryAfter = details.retryAfter;
    this.troubleshooting = {
      'Check service health': 'Verify downstream service is available',
      'Review error rate': 'Check if failures are transient or persistent',
      'Manual intervention': 'May need to restart dependent service'
    };
  }
}

export class RetryBudgetExceededError extends OperationError {
  severity = ErrorSeverity.HIGH;

  constructor(taskId: string, attempts: number, duration: number) {
    super('Retry budget exceeded', { taskId, attempts, duration });
    this.code = 'RETRY_BUDGET_EXCEEDED';
    this.suggestion = 'Task has been sent to dead letter queue for manual review';
    this.troubleshooting = {
      'Check DLQ': 'Review dead letter queue for this task',
      'Root cause': 'Investigate why operation is consistently failing',
      'Manual retry': 'May require manual intervention to fix underlying issue'
    };
  }
}

export class TaskNotFoundError extends NotFoundError {
  constructor(taskId: string) {
    super(`Task ${taskId} not found`, { taskId });
    this.code = 'TASK_NOT_FOUND';
    this.suggestion = 'Task may have expired or been cancelled';
  }
}

export class WorkerWatchdogTimeoutError extends TimeoutError {
  severity = ErrorSeverity.HIGH;

  constructor(taskId: string, taskType: string, timeout: number) {
    super('Worker watchdog timeout', { taskId, taskType, timeout });
    this.code = 'WORKER_WATCHDOG_TIMEOUT';
    this.suggestion = 'Task exceeded maximum execution time';
    this.troubleshooting = {
      'Check task logs': 'Review logs for stuck operations',
      'Increase timeout': 'Task may require longer execution time',
      'Optimize operation': 'Consider breaking task into smaller pieces'
    };
  }
}

export class StateDesynchronizationError extends InternalServerError {
  severity = ErrorSeverity.CRITICAL;

  constructor(taskId: string, details: string) {
    super('Task state desynchronization detected', { taskId, details });
    this.code = 'STATE_DESYNC';
    this.suggestion = 'State inconsistency between queue and repository';
    this.troubleshooting = {
      'Check repository': 'Verify Redis repository connectivity',
      'Reconcile state': 'State reconciliation process should auto-fix',
      'Manual fix': 'May require manual state correction'
    };
  }
}

// ============================================================================
// MageAgent-Specific Error Classes
// ============================================================================

export interface BaseErrorDetails {
  context?: Record<string, any>;
  suggestion?: string;
  troubleshooting?: Record<string, string>;
  cause?: Error;
  timestamp?: string;
  correlationId?: string;
}

export interface ValidationErrorDetails extends BaseErrorDetails {
  acceptedFields?: string[];
  invalidFields?: string[];
  example?: any;
  acceptedFormats?: string[];
  provided?: any;
  acceptedValues?: string[];
}

export interface ServiceUnavailableDetails extends BaseErrorDetails {
  service?: string;
  healthCheckUrl?: string;
  retryAfter?: number;
}

export interface TimeoutErrorDetails extends BaseErrorDetails {
  timeout?: number;
  asyncAvailable?: boolean;
  estimatedDuration?: string;
}

export interface NotFoundErrorDetails extends BaseErrorDetails {
  resourceType?: string;
  resourceId?: string;
  alternatives?: string[];
}

export interface InsufficientResourcesDetails extends BaseErrorDetails {
  resourceType?: 'memory' | 'cpu' | 'disk' | 'connections';
  currentUsage?: number;
  maxAvailable?: number;
}

export interface OperationErrorDetails extends BaseErrorDetails {
  operation?: string;
  classification?: any;
  availableOperations?: string[];
  taskId?: string;
}

export type ErrorDetails =
  | ValidationErrorDetails
  | ServiceUnavailableDetails
  | TimeoutErrorDetails
  | NotFoundErrorDetails
  | InsufficientResourcesDetails
  | OperationErrorDetails
  | BaseErrorDetails;

/**
 * Storage service error (503 Service Unavailable)
 * Used when GraphRAG or database service fails
 */
export class StorageServiceError extends ServiceUnavailableError {
  constructor(message: string, details?: ServiceUnavailableDetails) {
    super(
      message,
      {
        ...details,
        service: details?.service || 'GraphRAG'
      },
      details?.suggestion || 'Check GraphRAG service health'
    );
    this.code = 'STORAGE_SERVICE_ERROR';
  }
}

/**
 * Insufficient resources error (507 Insufficient Storage)
 * Used when system resources are exhausted
 */
export class InsufficientResourcesError extends AppError {
  code = 'INSUFFICIENT_RESOURCES';
  statusCode = 507;
  severity = ErrorSeverity.HIGH;

  constructor(message: string, details?: InsufficientResourcesDetails) {
    super(message, details, details?.suggestion);
    if (details?.troubleshooting) {
      this.troubleshooting = details.troubleshooting;
    }
  }
}

/**
 * External service error for LLM providers (OpenRouter, etc.)
 */
export class ExternalServiceError extends ServiceUnavailableError {
  constructor(service: string, operation: string, originalError?: Error) {
    super(
      `${service} error during ${operation}`,
      { service, operation, originalError: originalError?.message },
      `Check ${service} service status and credentials`
    );
    this.code = 'EXTERNAL_SERVICE_ERROR';
  }
}

/**
 * Configuration error for missing or invalid config
 */
export class ConfigurationError extends AppError {
  code = 'CONFIGURATION_ERROR';
  statusCode = 500;
  severity = ErrorSeverity.HIGH;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context, 'Check service configuration and environment variables');
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an error is an AppError instance
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Check if an error is operational (expected) vs programming error
 */
export function isOperationalError(error: unknown): boolean {
  return isAppError(error) && error.isOperational;
}

/**
 * Convert any error to an AppError
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
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

// ============================================================================
// Error Factory
// ============================================================================

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

  /**
   * Converts any error to an AppError
   * Analyzes error message to determine appropriate error type
   */
  static fromUnknown(error: unknown, context?: Record<string, any>): AppError {
    const appError = toAppError(error);

    // Add context if provided
    if (context) {
      appError.context = { ...appError.context, ...context };
    }

    return appError;
  }

  /**
   * Creates a validation error with field information
   */
  static validationError(message: string, acceptedFields?: string[], invalidFields?: string[]): ValidationError {
    return new ValidationError(message, {
      acceptedFields,
      invalidFields
    });
  }
}
