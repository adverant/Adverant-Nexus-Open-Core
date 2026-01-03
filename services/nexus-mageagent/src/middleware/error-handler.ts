/**
 * Global Error Handling Middleware
 *
 * Implements Express error handling pattern with:
 * - Automatic error type detection and conversion
 * - Environment-aware error sanitization
 * - Structured logging with correlation IDs
 * - Error metrics collection hooks
 *
 * Design Patterns:
 * - Chain of Responsibility: Error handler middleware chain
 * - Strategy Pattern: Different error handling strategies
 * - Decorator Pattern: asyncHandler wrapper for routes
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError, ErrorFactory, isAppError, ErrorSeverity, TimeoutErrorDetails } from '../utils/errors';
import { ApiResponse } from '../utils/api-response';
import { logger } from '../utils/logger';

/**
 * Async handler wrapper
 * Eliminates need for try-catch in async route handlers
 *
 * Usage:
 * router.get('/endpoint', asyncHandler(async (req, res) => {
 *   // Just throw errors - they'll be caught automatically
 *   throw new ValidationError('Invalid input');
 * }));
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Service availability middleware
 * Checks if required service is initialized before executing route
 *
 * Usage:
 * router.post('/orchestrate',
 *   requireService('orchestrator'),
 *   asyncHandler(async (req, res) => {
 *     // orchestrator is guaranteed to be available here
 *   })
 * );
 */
export function requireService(serviceName: string, serviceGetter?: () => any) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // If serviceGetter provided, check if service exists
    if (serviceGetter) {
      const service = serviceGetter();
      if (!service) {
        return next(ErrorFactory.serviceUnavailable(serviceName));
      }
    }

    // Store service name in request for error context
    (req as any)._requiredService = serviceName;
    next();
  };
}

/**
 * Request correlation ID middleware
 * Adds or propagates correlation ID for distributed tracing
 */
export function correlationId(req: Request, res: Response, next: NextFunction) {
  const correlationId = req.headers['x-correlation-id'] as string ||
                       req.headers['x-request-id'] as string ||
                       `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Store in request for access in routes
  (req as any).correlationId = correlationId;

  // Add to response headers
  res.setHeader('X-Correlation-ID', correlationId);

  next();
}

/**
 * Request timing middleware
 * Tracks request processing time
 */
export function requestTiming(req: Request, _res: Response, next: NextFunction) {
  (req as any).startTime = Date.now();
  next();
}

/**
 * Error metrics collection interface
 * Implement this to collect error metrics
 */
export interface ErrorMetricsCollector {
  recordError(error: AppError, req: Request): void;
}

// Global error metrics collector (can be injected)
let errorMetricsCollector: ErrorMetricsCollector | null = null;

/**
 * Sets the error metrics collector
 */
export function setErrorMetricsCollector(collector: ErrorMetricsCollector) {
  errorMetricsCollector = collector;
}

/**
 * Global error handler middleware
 * Must be registered AFTER all routes
 *
 * Usage in server.ts:
 * app.use('/api', routes);
 * app.use(errorHandler); // Register last
 */
export function errorHandler(
  error: Error | AppError | unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If headers already sent, delegate to Express default error handler
  if (res.headersSent) {
    return next(error);
  }

  // Convert to AppError if not already
  const appError = isAppError(error)
    ? error as AppError
    : ErrorFactory.fromUnknown(error, {
        method: req.method,
        url: req.url,
        correlationId: (req as any).correlationId,
        requiredService: (req as any)._requiredService
      });

  // Add correlation ID if available
  if ((req as any).correlationId) {
    res.setHeader('X-Error-ID', appError.errorId);
  }

  // Log error if configured
  if (appError.shouldLog) {
    const logContext = {
      ...appError.toLogFormat(),
      request: {
        method: req.method,
        url: req.url,
        headers: {
          'user-agent': req.headers['user-agent'],
          'x-source': req.headers['x-source'],
          'x-correlation-id': (req as any).correlationId
        },
        body: req.body,
        params: req.params,
        query: req.query
      },
      processingTime: (req as any).startTime ? Date.now() - (req as any).startTime : undefined
    };

    // Log based on severity
    switch (appError.severity) {
      case ErrorSeverity.CRITICAL:
      case ErrorSeverity.HIGH:
        logger.error('Request failed with high severity error', logContext);
        break;
      case ErrorSeverity.MEDIUM:
        logger.warn('Request failed with medium severity error', logContext);
        break;
      case ErrorSeverity.LOW:
        logger.info('Request failed with low severity error', logContext);
        break;
    }
  }

  // Collect metrics if collector configured
  if (errorMetricsCollector) {
    try {
      errorMetricsCollector.recordError(appError, req);
    } catch (metricsError) {
      logger.error('Failed to record error metrics', { metricsError });
    }
  }

  // Send error response
  const isDevelopment = process.env.NODE_ENV === 'development';
  ApiResponse.error(res, appError, isDevelopment);
}

/**
 * 404 Not Found handler
 * Use this as the last route handler before error middleware
 *
 * Usage in server.ts:
 * app.use('/api', routes);
 * app.use(notFoundHandler); // Before errorHandler
 * app.use(errorHandler);
 */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  const error = ErrorFactory.notFound(
    'Endpoint',
    `${req.method} ${req.path}`
  );
  next(error);
}

/**
 * Request validation middleware factory
 * Validates required fields in request body
 *
 * Usage:
 * router.post('/endpoint',
 *   validateRequired(['task', 'options']),
 *   asyncHandler(async (req, res) => {
 *     // task and options are guaranteed to exist
 *   })
 * );
 */
export function validateRequired(fields: string[], acceptedFields?: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const missing = fields.filter(field => !req.body[field]);

    if (missing.length > 0) {
      return next(ErrorFactory.validationError(
        `Missing required fields: ${missing.join(', ')}`,
        acceptedFields || fields
      ));
    }

    next();
  };
}

/**
 * Error recovery middleware
 * Attempts to provide fallback response for certain error types
 *
 * Usage:
 * app.use(errorRecovery);
 * app.use(errorHandler); // Still need main error handler
 */
export function errorRecovery(
  error: Error | AppError | unknown,
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  // Only attempt recovery for specific error types
  if (isAppError(error)) {
    const appError = error as AppError;

    // For timeout errors with TaskManager available, suggest async mode
    if (appError.statusCode === 408 && appError.details) {
      const timeoutDetails = appError.details as TimeoutErrorDetails;
      if (timeoutDetails.asyncAvailable) {
        // Let main error handler deal with it, but enrich the response
        timeoutDetails.suggestion = 'Try using async mode by adding "async": true to your request';
      }
    }
  }

  // Pass to next error handler
  next(error);
}

/**
 * Error sanitization middleware
 * Removes sensitive information from errors before logging/responding
 */
export function sanitizeError(
  error: Error | AppError | unknown,
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (isAppError(error)) {
    const appError = error as AppError;

    // Remove sensitive fields from details
    if (appError.details?.context) {
      const { password, apiKey, token, secret, ...safeContext } = appError.details.context;
      appError.details.context = safeContext;
    }
  }

  next(error);
}

/**
 * Middleware composition helper
 * Combines multiple middleware functions
 */
export function compose(...middlewares: RequestHandler[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const execute = (index: number): void => {
      if (index >= middlewares.length) {
        return next();
      }

      const middleware = middlewares[index];
      middleware(req, res, (err?: any) => {
        if (err) {
          return next(err);
        }
        execute(index + 1);
      });
    };

    execute(0);
  };
}
