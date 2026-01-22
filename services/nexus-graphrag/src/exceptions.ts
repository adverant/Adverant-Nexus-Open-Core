/**
 * Custom Exception Classes for GraphRAG Service
 * Implements production-grade error handling with detailed context
 */

/**
 * Base exception class with enhanced context
 */
export abstract class GraphRAGException extends Error {
  public readonly timestamp: Date;
  public readonly correlationId?: string;

  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    correlationId?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date();
    this.correlationId = correlationId;

    // Maintain proper stack trace for debugging
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert exception to JSON response format
   */
  toJSON() {
    return {
      error: this.code,
      message: this.message,
      timestamp: this.timestamp.toISOString(),
      correlationId: this.correlationId
    };
  }
}

/**
 * Exception thrown when a requested resource cannot be found
 */
export class ResourceNotFoundException extends GraphRAGException {
  constructor(
    public readonly resourceType: string,
    public readonly resourceId: string,
    public readonly tenantId?: string,
    correlationId?: string
  ) {
    super(
      `${resourceType} with id ${resourceId} not found${tenantId ? ` for tenant ${tenantId}` : ''}`,
      'RESOURCE_NOT_FOUND',
      404,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      resourceType: this.resourceType,
      resourceId: this.resourceId,
      tenantId: this.tenantId
    };
  }
}

/**
 * Exception thrown when tenant authorization fails
 */
export class TenantAuthorizationException extends GraphRAGException {
  constructor(
    public readonly tenantId: string,
    public readonly resourceId: string,
    public readonly resourceType: string,
    public readonly action: string = 'access',
    correlationId?: string
  ) {
    super(
      `Tenant ${tenantId} is not authorized to ${action} ${resourceType} ${resourceId}`,
      'TENANT_AUTHORIZATION_FAILED',
      403,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      tenantId: this.tenantId,
      resourceId: this.resourceId,
      resourceType: this.resourceType,
      action: this.action
    };
  }
}

/**
 * Exception thrown when request validation fails
 */
export class ValidationException extends GraphRAGException {
  constructor(
    message: string,
    public readonly validationErrors: Record<string, string | string[]>,
    correlationId?: string
  ) {
    super(
      message,
      'VALIDATION_FAILED',
      400,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      validationErrors: this.validationErrors
    };
  }
}

/**
 * Exception thrown when content exceeds size limits
 */
export class ContentTooLargeException extends GraphRAGException {
  constructor(
    public readonly actualSize: number,
    public readonly maxSize: number,
    public readonly unit: string = 'bytes',
    correlationId?: string
  ) {
    super(
      `Content size ${actualSize} ${unit} exceeds maximum allowed size of ${maxSize} ${unit}`,
      'CONTENT_TOO_LARGE',
      413,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      actualSize: this.actualSize,
      maxSize: this.maxSize,
      unit: this.unit
    };
  }
}

/**
 * Exception thrown when rate limit is exceeded
 */
export class RateLimitExceededException extends GraphRAGException {
  constructor(
    public readonly limit: number,
    public readonly window: string,
    public readonly retryAfter?: number,
    correlationId?: string
  ) {
    super(
      `Rate limit of ${limit} requests per ${window} exceeded`,
      'RATE_LIMIT_EXCEEDED',
      429,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      limit: this.limit,
      window: this.window,
      retryAfter: this.retryAfter
    };
  }
}

/**
 * Exception thrown when a database operation fails
 */
export class DatabaseException extends GraphRAGException {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly database: string,
    public readonly originalError?: Error,
    correlationId?: string
  ) {
    super(
      `Database operation failed: ${message}`,
      'DATABASE_ERROR',
      503,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      operation: this.operation,
      database: this.database,
      originalError: this.originalError?.message
    };
  }
}

/**
 * Exception thrown when an external service call fails
 */
export class ServiceUnavailableException extends GraphRAGException {
  constructor(
    public readonly service: string,
    public readonly reason: string,
    public readonly retryAfter?: number,
    correlationId?: string
  ) {
    super(
      `Service ${service} is unavailable: ${reason}`,
      'SERVICE_UNAVAILABLE',
      503,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      service: this.service,
      reason: this.reason,
      retryAfter: this.retryAfter
    };
  }
}

/**
 * Exception thrown when concurrent modification is detected
 */
export class ConcurrentModificationException extends GraphRAGException {
  constructor(
    public readonly resourceType: string,
    public readonly resourceId: string,
    public readonly expectedVersion: string,
    public readonly actualVersion: string,
    correlationId?: string
  ) {
    super(
      `Concurrent modification detected for ${resourceType} ${resourceId}. Expected version: ${expectedVersion}, Actual: ${actualVersion}`,
      'CONCURRENT_MODIFICATION',
      409,
      correlationId
    );
  }

  toJSON() {
    return {
      ...super.toJSON(),
      resourceType: this.resourceType,
      resourceId: this.resourceId,
      expectedVersion: this.expectedVersion,
      actualVersion: this.actualVersion
    };
  }
}

/**
 * Exception thrown when tenant context is missing or invalid
 */
export class TenantContextException extends GraphRAGException {
  constructor(
    message: string = 'Tenant context is required but was not provided',
    correlationId?: string
  ) {
    super(
      message,
      'TENANT_CONTEXT_MISSING',
      401,
      correlationId
    );
  }
}

/**
 * Type guard to check if an error is a GraphRAG exception
 */
export function isGraphRAGException(error: any): error is GraphRAGException {
  return error instanceof GraphRAGException;
}

/**
 * Helper to extract correlation ID from request headers
 */
export function getCorrelationId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const correlationHeader = headers['x-correlation-id'] || headers['x-request-id'];
  return Array.isArray(correlationHeader) ? correlationHeader[0] : correlationHeader;
}