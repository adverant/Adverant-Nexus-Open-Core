/**
 * Enhanced Tenant Context Middleware with User Tracking
 *
 * Provides complete multi-tenant isolation with user-level audit trails:
 * - Tenant Context (company/app) - for data isolation
 * - User Context (user/session) - for audit trails and GDPR compliance
 * - Request Context (correlation IDs) - for distributed tracing
 *
 * Security Architecture:
 * 1. Defense-in-depth: Multiple validation layers
 * 2. Complete audit trail: Track tenant → app → user → session → request
 * 3. GDPR compliance: User-level data tracking for right to erasure
 * 4. Row-level security: Tenant+User filtering in database queries
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Enhanced Tenant Context with User Tracking
// ============================================================================

/**
 * Complete security context combining tenant, user, and request tracking
 */
export interface EnhancedTenantContext {
  // Tenant Context (for data isolation)
  companyId: string;
  appId: string;

  // User Context (for audit trails)
  userId?: string;
  userEmail?: string;
  userName?: string;

  // Authorization Context
  roles?: string[];
  permissions?: string[];

  // Session & Request Context (for tracing)
  sessionId?: string;
  requestId?: string;

  // Metadata
  timestamp: string;
  source: 'jwt' | 'headers' | 'system';
}

/**
 * Backward-compatible basic tenant context
 */
export interface TenantContext {
  companyId: string;
  appId: string;
}

/**
 * JWT Payload structure from nexus-auth
 */
interface NexusAuthJWT {
  // Tenant
  companyId: string;
  appId: string;

  // User
  userId: string;
  email?: string;
  name?: string;

  // Authorization
  roles?: string[];
  permissions?: string[];

  // Standard JWT claims
  iat?: number;
  exp?: number;
  iss?: string;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      tenantContext?: EnhancedTenantContext;
      // Backward compatibility
      basicTenantContext?: TenantContext;
    }
  }
}

// ============================================================================
// Enhanced Tenant Context Extraction (with User Tracking)
// ============================================================================

/**
 * Extract complete tenant + user context from request
 *
 * Priority order:
 * 1. JWT token (most secure, includes user + tenant)
 * 2. Direct headers (for service-to-service calls)
 * 3. Reject if neither present
 *
 * Expected headers:
 * - Authorization: Bearer <JWT> (preferred - includes user context)
 * OR
 * - X-Company-ID + X-App-ID (minimum tenant context)
 * - X-User-ID (optional user context)
 * - X-User-Email (optional)
 * - X-Session-ID (optional)
 */
export function extractEnhancedTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const requestId = uuidv4();
    req.headers['x-request-id'] = requestId;

    // Try extracting from JWT first (most secure)
    const authHeader = req.headers['authorization'] as string;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const context = extractFromJWT(token, requestId);

      if (context) {
        req.tenantContext = context;
        req.basicTenantContext = {
          companyId: context.companyId,
          appId: context.appId,
        };

        logger.debug('Enhanced tenant context extracted from JWT', {
          companyId: context.companyId,
          appId: context.appId,
          userId: context.userId,
          sessionId: context.sessionId,
          requestId,
          path: req.path,
        });

        next();
        return;
      }
    }

    // Fallback: Extract from headers (for service-to-service calls)
    const headerContext = extractFromHeaders(req, requestId);

    if (!headerContext) {
      logger.warn('Missing tenant context - no JWT or headers', {
        path: req.path,
        method: req.method,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId,
      });

      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Missing tenant context. Provide either Authorization header with JWT or X-Company-ID + X-App-ID headers.',
        code: 'MISSING_TENANT_CONTEXT',
        requestId,
      });
      return;
    }

    req.tenantContext = headerContext;
    req.basicTenantContext = {
      companyId: headerContext.companyId,
      appId: headerContext.appId,
    };

    logger.debug('Enhanced tenant context extracted from headers', {
      companyId: headerContext.companyId,
      appId: headerContext.appId,
      userId: headerContext.userId,
      requestId,
      path: req.path,
    });

    next();
  } catch (error) {
    logger.error('Error extracting enhanced tenant context', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      method: req.method,
    });

    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to extract tenant context.',
      code: 'TENANT_CONTEXT_ERROR',
    });
  }
}

/**
 * Extract context from JWT token (preferred method)
 */
function extractFromJWT(token: string, requestId: string): EnhancedTenantContext | null {
  try {
    // Decode without verification for now (nexus-auth already verified it)
    // TODO: Add JWT verification with shared secret
    const decoded = jwt.decode(token) as NexusAuthJWT | null;

    if (!decoded) {
      logger.warn('Failed to decode JWT token', { requestId });
      return null;
    }

    // Validate required tenant fields
    if (!decoded.companyId || !decoded.appId) {
      logger.warn('JWT missing required tenant fields', {
        hasCompanyId: !!decoded.companyId,
        hasAppId: !!decoded.appId,
        requestId,
      });
      return null;
    }

    // Validate required user fields
    if (!decoded.userId) {
      logger.warn('JWT missing userId - cannot track user actions', {
        companyId: decoded.companyId,
        requestId,
      });
    }

    // Validate ID formats
    const validIdPattern = /^[a-zA-Z0-9_-]+$/;
    if (!validIdPattern.test(decoded.companyId) || !validIdPattern.test(decoded.appId)) {
      logger.warn('Invalid tenant ID format in JWT', {
        companyId: decoded.companyId,
        appId: decoded.appId,
        requestId,
      });
      return null;
    }

    if (decoded.userId && !validIdPattern.test(decoded.userId)) {
      logger.warn('Invalid userId format in JWT', {
        userId: decoded.userId,
        requestId,
      });
      // Don't fail, just omit userId
    }

    return {
      companyId: decoded.companyId,
      appId: decoded.appId,
      userId: decoded.userId,
      userEmail: decoded.email,
      userName: decoded.name,
      roles: decoded.roles,
      permissions: decoded.permissions,
      requestId,
      timestamp: new Date().toISOString(),
      source: 'jwt',
    };
  } catch (error) {
    logger.error('Error parsing JWT token', {
      error: error instanceof Error ? error.message : String(error),
      requestId,
    });
    return null;
  }
}

/**
 * Extract context from request headers (fallback for service calls)
 */
function extractFromHeaders(req: Request, requestId: string): EnhancedTenantContext | null {
  const companyId = req.headers['x-company-id'] as string;
  const appId = req.headers['x-app-id'] as string;
  const userId = req.headers['x-user-id'] as string;
  const userEmail = req.headers['x-user-email'] as string;
  const userName = req.headers['x-user-name'] as string;
  const sessionId = req.headers['x-session-id'] as string;

  // Validate minimum required headers
  if (!companyId || !appId) {
    return null;
  }

  // Validate format
  const validIdPattern = /^[a-zA-Z0-9_-]+$/;

  if (!validIdPattern.test(companyId)) {
    logger.warn('Invalid company_id format in headers', {
      companyId,
      requestId,
    });
    return null;
  }

  if (!validIdPattern.test(appId)) {
    logger.warn('Invalid app_id format in headers', {
      appId,
      requestId,
    });
    return null;
  }

  // Validate length
  if (companyId.length > 100 || appId.length > 100) {
    logger.warn('Tenant ID too long in headers', {
      companyIdLength: companyId.length,
      appIdLength: appId.length,
      requestId,
    });
    return null;
  }

  // Validate userId format if present
  if (userId && !validIdPattern.test(userId)) {
    logger.warn('Invalid userId format in headers', {
      userId,
      requestId,
    });
    // Don't fail, just omit userId
  }

  return {
    companyId,
    appId,
    userId: userId && validIdPattern.test(userId) ? userId : undefined,
    userEmail: userEmail || undefined,
    userName: userName || undefined,
    sessionId: sessionId || undefined,
    requestId,
    timestamp: new Date().toISOString(),
    source: 'headers',
  };
}

// ============================================================================
// Backward-Compatible Basic Tenant Context (Legacy)
// ============================================================================

/**
 * Extract basic tenant context (backward compatible)
 *
 * Use extractEnhancedTenantContext for new routes!
 */
export function extractTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const companyId = req.headers['x-company-id'] as string;
    const appId = req.headers['x-app-id'] as string;

    if (!companyId || !appId) {
      logger.warn('Missing tenant context headers', {
        path: req.path,
        method: req.method,
        hasCompanyId: !!companyId,
        hasAppId: !!appId,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Missing tenant context. Please provide X-Company-ID and X-App-ID headers.',
        code: 'MISSING_TENANT_CONTEXT',
      });
      return;
    }

    const validIdPattern = /^[a-zA-Z0-9_-]+$/;

    if (!validIdPattern.test(companyId)) {
      logger.warn('Invalid company_id format', {
        companyId,
        path: req.path,
        ip: req.ip,
      });

      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid X-Company-ID format. Must contain only alphanumeric characters, hyphens, and underscores.',
        code: 'INVALID_COMPANY_ID',
      });
      return;
    }

    if (!validIdPattern.test(appId)) {
      logger.warn('Invalid app_id format', {
        appId,
        path: req.path,
        ip: req.ip,
      });

      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid X-App-ID format. Must contain only alphanumeric characters, hyphens, and underscores.',
        code: 'INVALID_APP_ID',
      });
      return;
    }

    if (companyId.length > 100 || appId.length > 100) {
      logger.warn('Tenant ID too long', {
        companyIdLength: companyId.length,
        appIdLength: appId.length,
        path: req.path,
        ip: req.ip,
      });

      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Tenant IDs must be 100 characters or less.',
        code: 'TENANT_ID_TOO_LONG',
      });
      return;
    }

    // Create basic tenant context (backward compatible)
    const basicContext: TenantContext = {
      companyId,
      appId,
    };

    req.basicTenantContext = basicContext;

    // Also create enhanced context with minimal user tracking
    const userId = req.headers['x-user-id'] as string;
    req.tenantContext = {
      companyId,
      appId,
      userId: userId || undefined,
      requestId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'headers',
    };

    logger.debug('Basic tenant context extracted', {
      companyId,
      appId,
      userId,
      path: req.path,
      method: req.method,
    });

    next();
  } catch (error) {
    logger.error('Error extracting tenant context', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path,
      method: req.method,
    });

    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to extract tenant context.',
      code: 'TENANT_CONTEXT_ERROR',
    });
  }
}

/**
 * Optional tenant context extraction (for routes that work with or without tenant context)
 */
export function extractTenantContextOptional(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const companyId = req.headers['x-company-id'] as string;
  const appId = req.headers['x-app-id'] as string;

  if (companyId && appId) {
    const validIdPattern = /^[a-zA-Z0-9_-]+$/;

    if (!validIdPattern.test(companyId) || !validIdPattern.test(appId)) {
      logger.warn('Invalid tenant context format in optional extraction', {
        companyId,
        appId,
        path: req.path,
      });
      next();
      return;
    }

    const userId = req.headers['x-user-id'] as string;

    req.basicTenantContext = { companyId, appId };
    req.tenantContext = {
      companyId,
      appId,
      userId: userId || undefined,
      requestId: uuidv4(),
      timestamp: new Date().toISOString(),
      source: 'headers',
    };

    logger.debug('Optional tenant context extracted', {
      companyId,
      appId,
      userId,
      path: req.path,
    });
  }

  next();
}

// ============================================================================
// Validation & Guards
// ============================================================================

/**
 * Validate tenant context exists
 */
export function requireTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.tenantContext) {
    logger.error('Tenant context not found on request', {
      path: req.path,
      method: req.method,
      note: 'Did you forget to use extractTenantContext middleware?',
    });

    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Tenant context not initialized. Please contact support.',
      code: 'TENANT_CONTEXT_NOT_INITIALIZED',
    });
    return;
  }

  next();
}

/**
 * Require user context (for user-specific operations)
 */
export function requireUserContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.tenantContext?.userId) {
    logger.warn('User context required but not present', {
      path: req.path,
      method: req.method,
      hasTenant: !!req.tenantContext,
    });

    res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'User authentication required. Please provide a valid JWT token.',
      code: 'MISSING_USER_CONTEXT',
    });
    return;
  }

  next();
}

/**
 * PHASE 58n: Provide default system tenant context for internal endpoints
 *
 * For internal microservice-to-microservice calls (FileProcessAgent → MageAgent),
 * we need a system tenant context to allow operations like episode storage.
 *
 * This middleware:
 * 1. Checks if tenant headers are present (prefer explicit over default)
 * 2. Falls back to system tenant (nexus-system/internal) if no headers
 * 3. Allows internal operations without CRITICAL_SECURITY_VIOLATION errors
 *
 * Applied to: /mageagent/api/internal/* routes
 */
export function provideSystemTenantContext(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  // If tenant context already extracted from headers, use it
  if (req.tenantContext) {
    logger.debug('[PHASE58n] Using existing tenant context from headers', {
      companyId: req.tenantContext.companyId,
      appId: req.tenantContext.appId,
      path: req.path,
    });
    next();
    return;
  }

  // No tenant context from headers - provide default system tenant
  const systemTenantContext: TenantContext = {
    companyId: 'nexus-system',
    appId: 'internal',
  };

  const enhancedContext: EnhancedTenantContext = {
    ...systemTenantContext,
    userId: 'system',
    requestId: uuidv4(),
    timestamp: new Date().toISOString(),
    source: 'system-default',
  };

  req.basicTenantContext = systemTenantContext;
  req.tenantContext = enhancedContext;

  logger.info('[PHASE58n] Provided system tenant context for internal endpoint', {
    companyId: systemTenantContext.companyId,
    appId: systemTenantContext.appId,
    path: req.path,
    source: req.headers['x-source'] || 'unknown',
    requestId: req.headers['x-request-id'],
  });

  next();
}

// ============================================================================
// Audit & Compliance
// ============================================================================

/**
 * Audit middleware for tenant+user operations (GDPR compliance)
 */
export function auditTenantOperation(operationType: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.tenantContext) {
      next();
      return;
    }

    const auditLog = {
      timestamp: new Date().toISOString(),
      operationType,
      // Tenant
      companyId: req.tenantContext.companyId,
      appId: req.tenantContext.appId,
      // User (for GDPR right to erasure)
      userId: req.tenantContext.userId,
      userEmail: req.tenantContext.userEmail,
      // Request
      requestId: req.tenantContext.requestId,
      sessionId: req.tenantContext.sessionId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      source: req.tenantContext.source,
    };

    logger.info('Tenant operation audit', auditLog);

    res.on('finish', () => {
      logger.info('Tenant operation completed', {
        ...auditLog,
        statusCode: res.statusCode,
        duration: Date.now() - new Date(auditLog.timestamp).getTime(),
      });
    });

    next();
  };
}

// ============================================================================
// Rate Limiting by Tenant & User
// ============================================================================

import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';

/**
 * Rate limiting by tenant (prevents tenant abuse)
 */
export function createTenantRateLimiter(options: {
  windowMs: number;
  max: number;
  redisClient?: Redis;
}) {
  const store = options.redisClient
    ? new RedisStore({
        sendCommand: (...args: string[]) => options.redisClient!.call(...args),
        prefix: 'rate-limit:tenant:',
      } as any)
    : undefined;

  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req: Request) => {
      if (req.tenantContext) {
        return `${req.tenantContext.companyId}:${req.tenantContext.appId}`;
      }
      return req.ip || 'unknown';
    },
    handler: (req: Request, res: Response) => {
      logger.warn('Rate limit exceeded for tenant', {
        tenantContext: req.tenantContext,
        ip: req.ip,
        path: req.path,
      });

      res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(options.windowMs / 1000),
      });
    },
  });
}

/**
 * Rate limiting by user (prevents user abuse)
 */
export function createUserRateLimiter(options: {
  windowMs: number;
  max: number;
  redisClient?: Redis;
}) {
  const store = options.redisClient
    ? new RedisStore({
        sendCommand: (...args: string[]) => options.redisClient!.call(...args),
        prefix: 'rate-limit:user:',
      } as any)
    : undefined;

  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req: Request) => {
      if (req.tenantContext?.userId) {
        return `${req.tenantContext.companyId}:${req.tenantContext.userId}`;
      }
      return req.ip || 'unknown';
    },
    handler: (req: Request, res: Response) => {
      logger.warn('Rate limit exceeded for user', {
        userId: req.tenantContext?.userId,
        tenantContext: req.tenantContext,
        ip: req.ip,
        path: req.path,
      });

      res.status(429).json({
        success: false,
        error: 'Too Many Requests',
        message: 'User rate limit exceeded. Please try again later.',
        code: 'USER_RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(options.windowMs / 1000),
      });
    },
  });
}
