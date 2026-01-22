/**
 * @adverant/errors
 * Unified error hierarchy for Nexus stack services
 */

export { AppError, ErrorContext, ErrorSeverity } from './base-error';
export {
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
export { ErrorFactory, isAppError, isOperationalError, toAppError } from './factory';
