/**
 * Specific Error Classes
 * Domain-specific errors for common scenarios
 */

import { AppError, ErrorSeverity } from './base-error';

// Base error classes
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

// Service-specific errors
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
