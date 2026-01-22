/**
 * Error Handler for Nexus Routing Package
 * Comprehensive error handling with verbose, informative messages
 */

import { logger } from './logger.js';

/**
 * Custom error types for different failure scenarios
 */
export class NexusRoutingError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'NexusRoutingError';
  }
}

export class ServiceUnavailableError extends NexusRoutingError {
  constructor(service: string, details?: any) {
    super(
      `Service '${service}' is currently unavailable. Please ensure the service is running and accessible.`,
      'SERVICE_UNAVAILABLE',
      { service, ...details }
    );
    this.name = 'ServiceUnavailableError';
  }
}

export class RoutingError extends NexusRoutingError {
  constructor(toolName: string, reason: string) {
    super(
      `Failed to route tool '${toolName}': ${reason}. Verify tool name and ensure routing configuration is correct.`,
      'ROUTING_ERROR',
      { toolName, reason }
    );
    this.name = 'RoutingError';
  }
}

export class ToolExecutionError extends NexusRoutingError {
  constructor(toolName: string, service: string, originalError: Error) {
    super(
      `Tool '${toolName}' failed on service '${service}': ${originalError.message}`,
      'TOOL_EXECUTION_ERROR',
      {
        toolName,
        service,
        originalError: originalError.message,
        stack: originalError.stack
      }
    );
    this.name = 'ToolExecutionError';
  }
}

/**
 * Format error for response (MCP or HTTP)
 */
export function formatError(error: Error | NexusRoutingError): any {
  const isCustomError = error instanceof NexusRoutingError;

  const errorResponse = {
    error: true,
    message: error.message,
    type: error.name,
    code: isCustomError ? error.code : 'UNKNOWN_ERROR',
    details: isCustomError ? error.details : undefined,
    timestamp: new Date().toISOString()
  };

  // Log error with full context
  logger.error('Nexus Routing Error', errorResponse);

  return errorResponse;
}

/**
 * Handle errors with graceful degradation
 * Returns user-friendly error message while logging full details
 */
export function handleError(error: Error, context: string): string {
  const errorMessage = error instanceof NexusRoutingError
    ? error.message
    : `An unexpected error occurred in ${context}: ${error.message}`;

  logger.error(`Error in ${context}`, {
    message: error.message,
    stack: error.stack,
    context
  });

  return errorMessage;
}

/**
 * Wrap async function with error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context: string
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw new NexusRoutingError(
        handleError(error as Error, context),
        'WRAPPED_ERROR',
        { context, originalError: (error as Error).message }
      );
    }
  }) as T;
}
