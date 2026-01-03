/**
 * Request Logging Middleware
 * Logs incoming requests and responses with timing information
 */

import { Request, Response, NextFunction } from 'express';
import { Logger } from '../types';
import { RequestWithLogger } from './correlation-id';

export interface RequestLoggingOptions {
  /** Log request body (default: false for security) */
  logRequestBody?: boolean;

  /** Log response body (default: false for performance) */
  logResponseBody?: boolean;

  /** Skip logging for specific paths (e.g., health checks) */
  skipPaths?: string[];

  /** Log level for successful requests (default: 'info') */
  successLevel?: 'debug' | 'info';

  /** Log level for client errors 4xx (default: 'warn') */
  clientErrorLevel?: 'warn' | 'error';

  /** Log level for server errors 5xx (default: 'error') */
  serverErrorLevel?: 'error';
}

/**
 * Create request logging middleware
 */
export function createRequestLoggingMiddleware(
  logger: Logger,
  options: RequestLoggingOptions = {}
) {
  const {
    logRequestBody = false,
    logResponseBody = false,
    skipPaths = ['/health', '/metrics', '/ping'],
    successLevel = 'info',
    clientErrorLevel = 'warn',
    serverErrorLevel = 'error',
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip logging for specified paths
    if (skipPaths.includes(req.path)) {
      return next();
    }

    const extendedReq = req as RequestWithLogger;
    const requestLogger = extendedReq.logger || logger;

    const startTime = Date.now();

    // Log incoming request
    const requestMetadata: any = {
      method: req.method,
      path: req.path,
      query: req.query,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    };

    if (logRequestBody && req.body) {
      requestMetadata.body = sanitizeBody(req.body);
    }

    requestLogger.info('Incoming request', requestMetadata);

    // Capture response
    const originalSend = res.send;
    let responseBody: any;

    res.send = function(body: any): Response {
      responseBody = body;
      return originalSend.call(this, body);
    };

    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const statusCode = res.statusCode;

      const responseMetadata: any = {
        method: req.method,
        path: req.path,
        statusCode,
        duration,
      };

      if (logResponseBody && responseBody) {
        responseMetadata.body = sanitizeBody(responseBody);
      }

      // Determine log level based on status code
      if (statusCode >= 500) {
        requestLogger[serverErrorLevel]('Request completed with server error', responseMetadata);
      } else if (statusCode >= 400) {
        requestLogger[clientErrorLevel]('Request completed with client error', responseMetadata);
      } else {
        requestLogger[successLevel]('Request completed successfully', responseMetadata);
      }
    });

    next();
  };
}

/**
 * Get client IP address
 */
function getClientIp(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    return ips.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  return req.socket.remoteAddress || 'unknown';
}

/**
 * Sanitize request/response body to remove sensitive data
 */
function sanitizeBody(body: any): any {
  if (typeof body !== 'object') {
    return body;
  }

  const sensitiveFields = [
    'password',
    'token',
    'apiKey',
    'secret',
    'authorization',
    'creditCard',
    'ssn',
  ];

  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
}
