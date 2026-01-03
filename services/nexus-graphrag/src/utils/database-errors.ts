/**
 * PostgreSQL Error Parser and Custom Error Classes
 *
 * Provides verbose, actionable error messages with suggestions
 * Extracts constraint details from PostgreSQL error objects
 *
 * Architecture: Strategy Pattern for error type extraction
 *               Factory Pattern for error class creation
 */

import { logger } from './logger';

/**
 * Base Database Error Class
 *
 * All database-related errors extend this class
 * Following Liskov Substitution Principle
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'DatabaseError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation Error
 *
 * Thrown when input validation fails before database operation
 * HTTP Status Code: 400 (Bad Request)
 */
export class ValidationError extends DatabaseError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * Constraint Violation Error
 *
 * Thrown when database constraint is violated (CHECK, UNIQUE, FK, etc.)
 * HTTP Status Code: 409 (Conflict)
 */
export class ConstraintViolationError extends DatabaseError {
  constructor(
    message: string,
    public readonly constraint: string,
    public readonly column?: string,
    public readonly value?: any,
    details?: Record<string, any>
  ) {
    super(message, 'CONSTRAINT_VIOLATION', details);
    this.name = 'ConstraintViolationError';
  }
}

/**
 * Entity Not Found Error
 *
 * Thrown when requested entity does not exist
 * HTTP Status Code: 404 (Not Found)
 */
export class EntityNotFoundError extends DatabaseError {
  constructor(entityId: string, entityType?: string) {
    super(
      `Entity not found: ${entityId}${entityType ? ` (type: ${entityType})` : ''}`,
      'ENTITY_NOT_FOUND',
      { entityId, entityType }
    );
    this.name = 'EntityNotFoundError';
  }
}

/**
 * Connection Error
 *
 * Thrown when database connection fails
 * HTTP Status Code: 503 (Service Unavailable)
 */
export class ConnectionError extends DatabaseError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'CONNECTION_ERROR', details);
    this.name = 'ConnectionError';
  }
}

/**
 * PostgreSQL Error Parser
 *
 * Strategy Pattern: Different parsing strategies for different error types
 *
 * Extracts detailed information from PostgreSQL error objects and converts
 * them into user-friendly, actionable error messages with suggestions
 */
export class PostgreSQLErrorParser {
  /**
   * Parse PostgreSQL error and create appropriate custom error
   *
   * @param error - Raw PostgreSQL error object
   * @param context - Additional context (e.g., request parameters)
   * @returns Appropriate DatabaseError subclass with detailed information
   */
  static parse(error: any, context?: Record<string, any>): DatabaseError {
    // Connection errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
      return new ConnectionError(
        `Database connection failed: ${error.message}`,
        { originalCode: error.code, host: error.hostname || error.host }
      );
    }

    // PostgreSQL-specific errors
    // Error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
    const pgCode = error.code;
    const constraint = error.constraint;
    const column = error.column;
    const detail = error.detail;
    const table = error.table;
    const hint = error.hint;

    logger.debug('Parsing PostgreSQL error', {
      pgCode, constraint, column, detail, table, hint, context
    });

    // CHECK constraint violation (23514) - Custom validation rules
    if (pgCode === '23514') {
      return this.parseCheckConstraintError(error, context);
    }

    // FOREIGN KEY constraint violation (23503)
    if (pgCode === '23503') {
      return this.parseForeignKeyError(error, context);
    }

    // UNIQUE constraint violation (23505)
    if (pgCode === '23505') {
      return this.parseUniqueViolationError(error, context);
    }

    // NOT NULL constraint violation (23502)
    if (pgCode === '23502') {
      return new ValidationError(
        `Required field missing: ${column}. This field cannot be null.`,
        { column, table, hint }
      );
    }

    // Invalid text representation (22P02)
    if (pgCode === '22P02') {
      return new ValidationError(
        `Invalid value format: ${error.message}`,
        { detail, hint }
      );
    }

    // Connection exceptions (08xxx)
    if (pgCode && pgCode.startsWith('08')) {
      return new ConnectionError(
        `Database connection error: ${error.message}`,
        { pgCode, detail, hint }
      );
    }

    // Generic database error with all available context
    return new DatabaseError(
      error.message || 'Database operation failed',
      pgCode || 'UNKNOWN_ERROR',
      {
        constraint,
        column,
        detail,
        table,
        hint,
        severity: error.severity,
        originalError: error.message
      }
    );
  }

  /**
   * Parse CHECK constraint violations
   *
   * Provides specific handling for known constraints with helpful suggestions
   */
  private static parseCheckConstraintError(error: any, context?: Record<string, any>): ConstraintViolationError {
    const constraint = error.constraint;
    const detail = error.detail;

    // Domain validation constraint
    if (constraint === 'check_valid_domain') {
      const validDomains = [
        'creative_writing', 'code', 'medical', 'legal', 'conversation',
        'general', 'research', 'business', 'education', 'technical'
      ];

      const attemptedDomain = context?.domain || 'unknown';
      const suggestion = this.suggestDomain(attemptedDomain, validDomains);

      return new ConstraintViolationError(
        `Invalid domain: "${attemptedDomain}". Must be one of: ${validDomains.join(', ')}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
        constraint,
        'domain',
        attemptedDomain,
        { validDomains, suggestion, hint: 'Use one of the predefined domain categories' }
      );
    }

    // Hierarchy level constraint
    if (constraint === 'check_hierarchy_level') {
      return new ConstraintViolationError(
        `Invalid hierarchy level: ${context?.hierarchyLevel}. Must be >= 0.`,
        constraint,
        'hierarchy_level',
        context?.hierarchyLevel,
        { detail, hint: 'Hierarchy level must be a non-negative integer' }
      );
    }

    // Confidence constraint
    if (constraint === 'check_confidence') {
      return new ConstraintViolationError(
        `Invalid confidence score: ${context?.confidence}. Must be between 0 and 1.`,
        constraint,
        'confidence',
        context?.confidence,
        { detail, hint: 'Confidence must be a decimal between 0.0 and 1.0' }
      );
    }

    // Generic CHECK constraint
    return new ConstraintViolationError(
      `Constraint violation: ${constraint}. ${detail || error.message}`,
      constraint,
      error.column,
      undefined,
      { detail, hint: error.hint }
    );
  }

  /**
   * Parse FOREIGN KEY constraint violations
   */
  private static parseForeignKeyError(error: any, _context?: Record<string, any>): ConstraintViolationError {
    const detail = error.detail || '';
    const constraint = error.constraint;

    // Extract foreign key details from error message
    const match = detail.match(/Key \((.*?)\)=\((.*?)\)/);
    const foreignKey = match ? match[1] : 'unknown';
    const value = match ? match[2] : 'unknown';

    // Specific handling for known foreign keys
    if (foreignKey === 'parent_id') {
      return new ConstraintViolationError(
        `Parent entity not found: "${value}". Cannot create child entity with non-existent parent.`,
        constraint || 'fk_parent_entity',
        foreignKey,
        value,
        {
          detail,
          hint: 'Ensure the parent entity exists before creating child entities',
          suggestion: 'Query existing entities with GET /api/entities to find valid parent IDs'
        }
      );
    }

    // Generic foreign key error
    return new ConstraintViolationError(
      `Foreign key constraint violated: ${foreignKey} with value "${value}" does not exist. ${detail}`,
      constraint || 'foreign_key',
      foreignKey,
      value,
      { detail, table: error.table, hint: error.hint }
    );
  }

  /**
   * Parse UNIQUE constraint violations
   */
  private static parseUniqueViolationError(error: any, _context?: Record<string, any>): ConstraintViolationError {
    const detail = error.detail || '';
    const constraint = error.constraint;

    // Extract duplicate key details
    const match = detail.match(/Key \((.*?)\)=\((.*?)\)/);
    const column = match ? match[1] : error.column || 'unknown';
    const value = match ? match[2] : 'unknown';

    return new ConstraintViolationError(
      `Duplicate entry: ${column} with value "${value}" already exists. ${detail}`,
      constraint || 'unique',
      column,
      value,
      {
        detail,
        hint: 'This value must be unique in the database',
        suggestion: 'Use a different value or update the existing record'
      }
    );
  }

  /**
   * Suggest closest valid domain using string similarity
   *
   * Uses simple substring matching and common alias mapping
   */
  private static suggestDomain(attempted: string, validDomains: string[]): string | null {
    if (!attempted) return null;

    const lower = attempted.toLowerCase().trim();

    // Exact substring match
    for (const domain of validDomains) {
      if (domain.includes(lower) || lower.includes(domain.split('_')[0])) {
        return domain;
      }
    }

    // Common alias mapping
    const aliases: Record<string, string> = {
      // Testing/general
      'test': 'general',
      'testing': 'general',
      't': 'general',
      'temp': 'general',
      'example': 'general',
      'demo': 'general',

      // Programming
      'coding': 'code',
      'programming': 'code',
      'dev': 'code',
      'software': 'code',
      'script': 'code',

      // Writing
      'writing': 'creative_writing',
      'novel': 'creative_writing',
      'story': 'creative_writing',
      'fiction': 'creative_writing',
      'book': 'creative_writing',

      // Medical
      'health': 'medical',
      'healthcare': 'medical',
      'medicine': 'medical',
      'clinical': 'medical',

      // Legal
      'law': 'legal',
      'lawyer': 'legal',
      'attorney': 'legal',
      'contract': 'legal',

      // Research
      'study': 'research',
      'academic': 'research',
      'science': 'research',
      'paper': 'research',

      // Business
      'corp': 'business',
      'corporate': 'business',
      'company': 'business',
      'enterprise': 'business',

      // Education
      'teach': 'education',
      'teaching': 'education',
      'school': 'education',
      'learning': 'education',

      // Technical
      'tech': 'technical',
      'technology': 'technical',
      'engineering': 'technical'
    };

    return aliases[lower] || null;
  }

  /**
   * Check if error is a transient failure that should be retried
   *
   * @param error - Database error
   * @returns true if error is likely transient
   */
  static isTransient(error: DatabaseError): boolean {
    // Connection errors are often transient
    if (error instanceof ConnectionError) {
      return true;
    }

    // Specific PostgreSQL codes for transient errors
    const transientCodes = [
      '40001', // serialization_failure
      '40P01', // deadlock_detected
      '53000', // insufficient_resources
      '53100', // disk_full
      '53200', // out_of_memory
      '53300', // too_many_connections
      '57P03', // cannot_connect_now
      '58000', // system_error
      '58030'  // io_error
    ];

    return transientCodes.includes(error.code);
  }
}
