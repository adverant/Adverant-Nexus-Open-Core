/**
 * API Response Builder
 *
 * Provides consistent, type-safe response formatting for all API endpoints.
 * Implements Builder pattern for flexible response construction.
 *
 * Design Patterns:
 * - Builder Pattern: Fluent interface for response construction
 * - Strategy Pattern: Different formatting strategies for success/error responses
 */

import { Response } from 'express';
import { AppError, isAppError } from './errors';

/**
 * Standard success response structure
 */
export interface SuccessResponse<T = any> {
  success: true;
  data?: T;
  metadata?: ResponseMetadata;
  [key: string]: any; // Allow additional fields for backward compatibility
}

/**
 * Response metadata
 */
export interface ResponseMetadata {
  timestamp?: string;
  processingTime?: number;
  requestId?: string;
  version?: string;
  [key: string]: any; // Allow additional metadata fields
}

/**
 * API Response Builder Class
 * Provides fluent interface for constructing API responses
 */
export class ApiResponse {
  /**
   * Sends a success response (200 OK)
   */
  static success<T = any>(
    res: Response,
    data?: T,
    metadata?: ResponseMetadata
  ): Response {
    return res.status(200).json({
      success: true,
      ...(data !== undefined && { data }),
      ...(metadata && { metadata: {
        timestamp: new Date().toISOString(),
        ...metadata
      }})
    } as SuccessResponse<T>);
  }

  /**
   * Sends a created response (201 Created)
   */
  static created<T = any>(
    res: Response,
    data?: T,
    location?: string,
    metadata?: ResponseMetadata
  ): Response {
    if (location) {
      res.setHeader('Location', location);
    }

    return res.status(201).json({
      success: true,
      ...(data !== undefined && { data }),
      ...(metadata && { metadata: {
        timestamp: new Date().toISOString(),
        ...metadata
      }})
    } as SuccessResponse<T>);
  }

  /**
   * Sends an accepted response (202 Accepted)
   * Used for async operations
   */
  static accepted(
    res: Response,
    taskId: string,
    pollUrl: string,
    message?: string,
    metadata?: ResponseMetadata
  ): Response {
    return res.status(202).json({
      success: true,
      taskId,
      status: 'pending',
      message: message || 'Task created successfully',
      pollUrl,
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata
      }
    });
  }

  /**
   * Sends a no content response (204 No Content)
   */
  static noContent(res: Response): Response {
    return res.status(204).send();
  }

  /**
   * Sends an error response
   * Automatically determines format based on error type and environment
   */
  static error(
    res: Response,
    error: Error | AppError | unknown,
    isDevelopment: boolean = process.env.NODE_ENV === 'development'
  ): Response {
    // Convert to AppError if not already
    if (isAppError(error)) {
      const appError = error as AppError;
      return res.status(appError.statusCode).json(appError.toJSON(isDevelopment));
    }

    // Generic error handling
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    const statusCode = 500;

    const response: Record<string, any> = {
      error: 'INTERNAL_SERVER_ERROR',
      message,
      timestamp: new Date().toISOString()
    };

    if (isDevelopment && error instanceof Error) {
      response.stack = error.stack;
    }

    return res.status(statusCode).json(response);
  }

  /**
   * Sends a bad request error (400)
   * Convenience method for validation errors
   */
  static badRequest(
    res: Response,
    message: string,
    details?: {
      acceptedFields?: string[];
      invalidFields?: string[];
      example?: any;
    }
  ): Response {
    return res.status(400).json({
      error: 'BAD_REQUEST',
      message,
      timestamp: new Date().toISOString(),
      ...details
    });
  }

  /**
   * Sends a not found error (404)
   */
  static notFound(
    res: Response,
    message: string,
    resourceType?: string,
    resourceId?: string
  ): Response {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message,
      ...(resourceType && { resourceType }),
      ...(resourceId && { resourceId }),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Sends a service unavailable error (503)
   */
  static serviceUnavailable(
    res: Response,
    message: string,
    service?: string,
    suggestion?: string
  ): Response {
    return res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message,
      ...(service && { service }),
      ...(suggestion && { suggestion }),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Sends a custom response with flexible structure
   * Use for responses that don't fit standard patterns
   */
  static custom(
    res: Response,
    statusCode: number,
    body: Record<string, any>
  ): Response {
    return res.status(statusCode).json({
      timestamp: new Date().toISOString(),
      ...body
    });
  }

  /**
   * Sends a paginated response
   */
  static paginated<T = any>(
    res: Response,
    data: T[],
    pagination: {
      page: number;
      perPage: number;
      total: number;
      totalPages: number;
    },
    metadata?: ResponseMetadata
  ): Response {
    return res.status(200).json({
      success: true,
      data,
      pagination,
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata
      }
    });
  }

  /**
   * Sends a response with real-time streaming information
   */
  static streaming(
    res: Response,
    taskId: string,
    streamingInfo: {
      enabled: boolean;
      subscribe?: {
        namespace?: string;
        room?: string;
        events?: string[];
      };
    },
    metadata?: ResponseMetadata
  ): Response {
    return res.status(200).json({
      success: true,
      taskId,
      status: 'streaming',
      message: 'Task is being processed with real-time streaming',
      streaming: streamingInfo,
      metadata: {
        timestamp: new Date().toISOString(),
        ...metadata
      }
    });
  }
}

/**
 * Legacy compatibility functions
 * These maintain backward compatibility with existing route-utils.ts
 * but internally use the new ApiResponse class
 */

/**
 * @deprecated Use ApiResponse.error() instead
 */
export function handleRouteError(
  res: Response,
  error: unknown,
  message: string,
  details?: any
): Response {
  // If error is AppError, use it directly
  if (isAppError(error)) {
    return ApiResponse.error(res, error);
  }

  // Otherwise, wrap in context
  const errorMessage = error instanceof Error ? error.message : String(error);
  return res.status(500).json({
    error: message,
    message: errorMessage,
    ...(details && { details }),
    timestamp: new Date().toISOString()
  });
}

/**
 * @deprecated Use ApiResponse.badRequest() instead
 */
export function handleBadRequest(res: Response, message: string): Response {
  return ApiResponse.badRequest(res, message);
}

/**
 * @deprecated Use ApiResponse.notFound() instead
 */
export function handleNotFound(res: Response, message: string): Response {
  return ApiResponse.notFound(res, message);
}

/**
 * @deprecated Use ApiResponse.serviceUnavailable() instead
 */
export function handleServiceUnavailable(res: Response, message: string): Response {
  return ApiResponse.serviceUnavailable(res, message);
}
