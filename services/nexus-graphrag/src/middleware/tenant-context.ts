/**
 * GraphRAG Tenant + User Context Validation Middleware
 *
 * Phase 2 Implementation: User-Level Security & GDPR Compliance
 *
 * Security Architecture (Defense in Depth):
 * Layer 1: Middleware validates all requests at entry point (THIS FILE)
 * Layer 2: Database Row-Level Security enforces queries (PostgreSQL RLS)
 * Layer 3: Vector/Graph filtering ensures consistency (Qdrant/Neo4j)
 * Layer 4: GDPR endpoints enable data rights (export/delete)
 *
 * CRITICAL: This middleware is MANDATORY on ALL GraphRAG protected routes.
 * Without this, user-level isolation is NOT enforced and GDPR compliance fails.
 *
 * Alignment: Mirrors nexus-mageagent/src/middleware/tenant-context.ts structure
 * to ensure consistent security context across the entire Nexus stack.
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

// ============================================================================
// ENHANCED TENANT CONTEXT (PHASE 2: USER-LEVEL TRACKING)
// ============================================================================

/**
 * Complete security context for GraphRAG operations
 *
 * Includes:
 * - Tenant isolation (companyId + appId)
 * - User tracking (userId + userEmail + userName)
 * - Authorization (roles + permissions)
 * - Distributed tracing (sessionId + requestId)
 */
export interface EnhancedTenantContext {
  // === TENANT CONTEXT (REQUIRED) ===
  companyId: string; // Which company owns this data
  appId: string; // Which app within the company
  tenantId: string; // Computed: companyId:appId (for backward compatibility)

  // === USER CONTEXT (REQUIRED for user operations) ===
  userId: string; // Which user performed the action
  userEmail?: string; // User's email address
  userName?: string; // User's display name

  // === AUTHORIZATION CONTEXT (OPTIONAL) ===
  roles?: string[]; // User's roles (admin, editor, viewer)
  permissions?: string[]; // User's specific permissions

  // === SESSION & REQUEST TRACKING (OPTIONAL) ===
  sessionId?: string; // User's session identifier
  requestId: string; // Unique request correlation ID (for tracing)

  // === METADATA ===
  timestamp: string; // When context was extracted
  source: 'headers' | 'system'; // Where context came from
}

/**
 * Extend Express Request type to include validated tenant context and rate limit info
 */
declare global {
  namespace Express {
    interface Request {
      tenantContext?: EnhancedTenantContext;
      rateLimit?: {
        limit: number;
        current: number;
        remaining: number;
        reset: Date;
        resetTime?: Date;
      };
    }
  }
}

// ============================================================================
// MIDDLEWARE: EXTRACT & VALIDATE TENANT + USER CONTEXT
// ============================================================================

/**
 * Extract and validate tenant + user context from HTTP headers
 *
 * Required Headers:
 * - X-Company-ID: Tenant company identifier (REQUIRED)
 * - X-App-ID: Tenant application identifier (REQUIRED)
 * - X-User-ID: User identifier (REQUIRED for user operations)
 *
 * Optional Headers:
 * - X-User-Email: User's email address
 * - X-User-Name: User's display name
 * - X-Session-ID: User's session identifier
 * - X-Request-ID: Request correlation ID (generated if not provided)
 *
 * Security Validations:
 * 1. Validates required headers are present
 * 2. Validates ID format (alphanumeric + underscore/dash only)
 * 3. Prevents injection attacks via regex sanitization
 * 4. Logs security violations for audit
 * 5. Returns 401 Unauthorized if validation fails
 *
 * Usage:
 * ```typescript
 * router.post('/api/memory',
 *   extractTenantContext,  // Validates tenant + user
 *   requireUserContext,    // Ensures real user (not system)
 *   async (req, res) => {
 *     const context = req.tenantContext!;
 *     // Guaranteed to have valid context here
 *   }
 * );
 * ```
 */
export function extractTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Extract tenant headers
  const companyId = req.headers['x-company-id'] as string;
  const appId = req.headers['x-app-id'] as string;
  const userId = req.headers['x-user-id'] as string;

  // CRITICAL: Reject requests without tenant context
  if (!companyId || !appId) {
    logger.error('SECURITY VIOLATION: GraphRAG request without tenant context', {
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      hasCompanyId: !!companyId,
      hasAppId: !!appId,
      hasUserId: !!userId,
      timestamp: new Date().toISOString(),
    });

    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Missing required tenant context headers. GraphRAG requires tenant isolation.',
      required: ['X-Company-ID', 'X-App-ID'],
      code: 'MISSING_TENANT_CONTEXT',
      requestId: uuidv4(),
    });
  }

  // Validate ID format to prevent injection attacks
  const validIdPattern = /^[a-zA-Z0-9_-]+$/;

  if (!validIdPattern.test(companyId)) {
    logger.error('SECURITY VIOLATION: Invalid company ID format in GraphRAG request', {
      companyId,
      path: req.path,
      ip: req.ip,
    });

    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message:
        'Invalid company ID format. Only alphanumeric characters, underscores, and dashes are allowed.',
      code: 'INVALID_COMPANY_ID_FORMAT',
    });
  }

  if (!validIdPattern.test(appId)) {
    logger.error('SECURITY VIOLATION: Invalid app ID format in GraphRAG request', {
      appId,
      path: req.path,
      ip: req.ip,
    });

    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message:
        'Invalid app ID format. Only alphanumeric characters, underscores, and dashes are allowed.',
      code: 'INVALID_APP_ID_FORMAT',
    });
  }

  if (userId && !validIdPattern.test(userId)) {
    logger.error('SECURITY VIOLATION: Invalid user ID format in GraphRAG request', {
      userId,
      path: req.path,
      ip: req.ip,
    });

    return res.status(400).json({
      success: false,
      error: 'Bad Request',
      message:
        'Invalid user ID format. Only alphanumeric characters, underscores, and dashes are allowed.',
      code: 'INVALID_USER_ID_FORMAT',
    });
  }

  // Generate request ID if not provided (for distributed tracing)
  const requestId =
    (req.headers['x-request-id'] as string) || uuidv4();

  // Build complete tenant context
  req.tenantContext = {
    // Tenant (REQUIRED)
    companyId,
    appId,
    tenantId: `${companyId}:${appId}`,

    // User (OPTIONAL - some operations allow system user)
    userId: userId || 'system',
    userEmail: req.headers['x-user-email'] as string,
    userName: req.headers['x-user-name'] as string,

    // Authorization (OPTIONAL)
    roles: req.headers['x-user-roles']
      ? (req.headers['x-user-roles'] as string).split(',')
      : undefined,
    permissions: req.headers['x-user-permissions']
      ? (req.headers['x-user-permissions'] as string).split(',')
      : undefined,

    // Session & Request tracking
    sessionId: req.headers['x-session-id'] as string,
    requestId,

    // Metadata
    timestamp: new Date().toISOString(),
    source: 'headers',
  };

  // Success audit log
  logger.debug('GraphRAG tenant context extracted and validated', {
    companyId: req.tenantContext.companyId,
    appId: req.tenantContext.appId,
    userId: req.tenantContext.userId,
    requestId: req.tenantContext.requestId,
    path: req.path,
    method: req.method,
  });

  return next();
}

// ============================================================================
// MIDDLEWARE: REQUIRE USER CONTEXT (GUARD)
// ============================================================================

/**
 * Require user context for user-specific operations
 *
 * Apply this middleware AFTER extractTenantContext for routes that MUST
 * have a real user (not 'system').
 *
 * Examples:
 * - Storing user's personal memories
 * - Creating user's private documents
 * - GDPR data export/deletion
 *
 * Usage:
 * ```typescript
 * router.delete('/api/user/data',
 *   extractTenantContext,
 *   requireUserContext,  // ← Ensures real user
 *   async (req, res) => {
 *     // userId is guaranteed to be set and not 'system'
 *   }
 * );
 * ```
 */
export function requireUserContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Ensure extractTenantContext ran first
  if (!req.tenantContext) {
    logger.error('SECURITY VIOLATION: requireUserContext called without tenant context', {
      path: req.path,
      method: req.method,
    });

    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message:
        'Middleware ordering error: extractTenantContext must be applied before requireUserContext',
      code: 'MIDDLEWARE_ORDERING_ERROR',
    });
  }

  // Ensure userId is present and not 'system'
  if (!req.tenantContext.userId || req.tenantContext.userId === 'system') {
    logger.error('SECURITY VIOLATION: User context required but not provided', {
      path: req.path,
      method: req.method,
      companyId: req.tenantContext.companyId,
      appId: req.tenantContext.appId,
      ip: req.ip,
    });

    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message:
        'This operation requires user authentication. Please provide X-User-ID header.',
      required: ['X-User-ID'],
      code: 'USER_CONTEXT_REQUIRED',
    });
  }

  return next();
}

// ============================================================================
// MIDDLEWARE: AUDIT TENANT OPERATIONS
// ============================================================================

/**
 * Audit tenant + user operations for GDPR compliance
 *
 * Logs:
 * - Who performed the operation (tenant + user)
 * - What operation was performed
 * - When it was performed
 * - Where it came from (IP, user agent)
 * - How long it took
 * - What the result was (status code)
 *
 * Usage:
 * ```typescript
 * router.delete('/api/memory/:id',
 *   extractTenantContext,
 *   requireUserContext,
 *   auditTenantOperation('memory.delete'),
 *   async (req, res) => { ... }
 * );
 * ```
 */
export function auditTenantOperation(operationType: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.tenantContext) {
      logger.warn('Audit middleware called without tenant context', {
        path: req.path,
        operationType,
      });
      next();
      return;
    }

    const auditLog = {
      // Operation
      timestamp: new Date().toISOString(),
      operationType,

      // Tenant
      companyId: req.tenantContext.companyId,
      appId: req.tenantContext.appId,

      // User
      userId: req.tenantContext.userId,
      userEmail: req.tenantContext.userEmail,
      userName: req.tenantContext.userName,

      // Request
      requestId: req.tenantContext.requestId,
      sessionId: req.tenantContext.sessionId,
      method: req.method,
      path: req.path,

      // Client
      ip: req.ip,
      userAgent: req.headers['user-agent'],

      // Context
      source: req.tenantContext.source,
    };

    // Log operation start
    logger.info('GraphRAG tenant operation audit', auditLog);

    // Log operation completion when response finishes
    res.on('finish', () => {
      const duration =
        Date.now() - new Date(auditLog.timestamp).getTime();

      logger.info('GraphRAG tenant operation completed', {
        ...auditLog,
        statusCode: res.statusCode,
        duration,
        success: res.statusCode >= 200 && res.statusCode < 300,
      });
    });

    next();
  };
}

// ============================================================================
// UTILITY: CREATE SYSTEM CONTEXT
// ============================================================================

/**
 * Create system-level tenant context for internal operations
 *
 * Use this for background jobs or system-initiated operations that
 * don't have a real user but need tenant isolation.
 *
 * Usage:
 * ```typescript
 * const context = createSystemContext('acme-corp', 'crm-app');
 * await storageEngine.storeMemory(memory, context);
 * ```
 */
export function createSystemContext(
  companyId: string,
  appId: string
): EnhancedTenantContext {
  return {
    companyId,
    appId,
    tenantId: `${companyId}:${appId}`,
    userId: 'system',
    requestId: uuidv4(),
    timestamp: new Date().toISOString(),
    source: 'system',
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  extractTenantContext,
  requireUserContext,
  auditTenantOperation,
  createSystemContext,
};
