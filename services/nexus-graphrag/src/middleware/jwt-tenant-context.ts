/**
 * JWT-Based Tenant Context Extraction Middleware
 *
 * This middleware extracts tenant context from JWT tokens when header-based
 * context is not provided. This supports dashboard/frontend clients that
 * only send Authorization headers (not X-Company-ID, X-App-ID headers).
 *
 * Priority:
 * 1. If X-Company-ID and X-App-ID headers are present, use those (existing behavior)
 * 2. Otherwise, extract user info from JWT and derive tenant context
 *
 * JWT Structure Expected:
 * {
 *   "sub": "user-uuid",           // User ID
 *   "email": "user@example.com",  // User email
 *   "name": "User Name",          // User display name
 *   "tier": "dedicated_vps",      // Subscription tier
 *   "jti": "unique-token-id",     // Token ID
 *   "iat": 1234567890,            // Issued at
 *   "exp": 1234567890             // Expiration
 * }
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { EnhancedTenantContext } from './tenant-context';

// Re-export for convenience
export { EnhancedTenantContext };

/**
 * Decode JWT payload without verification (verification done by API gateway)
 * The API gateway (Istio/nexus-auth) already validates the JWT signature.
 * This middleware just extracts the payload for context.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    // Base64url decode the payload (middle part)
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded);
  } catch (error) {
    logger.debug('Failed to decode JWT payload', { error });
    return null;
  }
}

/**
 * Extract tenant context from JWT or headers
 *
 * This middleware is designed for Data Explorer routes that need to support
 * both header-based context (for API clients) and JWT-based context (for dashboard).
 *
 * Usage:
 * ```typescript
 * router.get('/entities',
 *   extractTenantContextFromJwtOrHeaders,
 *   async (req, res) => {
 *     const { tenantId, userId } = req.tenantContext!;
 *   }
 * );
 * ```
 */
export function extractTenantContextFromJwtOrHeaders(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Check if headers are already present (existing behavior)
  const companyId = req.headers['x-company-id'] as string;
  const appId = req.headers['x-app-id'] as string;

  if (companyId && appId) {
    // Use existing header-based extraction
    const userId = req.headers['x-user-id'] as string;
    const requestId = (req.headers['x-request-id'] as string) || uuidv4();

    // Validate ID format
    const validIdPattern = /^[a-zA-Z0-9_-]+$/;

    if (!validIdPattern.test(companyId) || !validIdPattern.test(appId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid ID format in headers',
        code: 'INVALID_ID_FORMAT',
      });
    }

    if (userId && !validIdPattern.test(userId)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Invalid user ID format',
        code: 'INVALID_USER_ID_FORMAT',
      });
    }

    req.tenantContext = {
      companyId,
      appId,
      tenantId: `${companyId}:${appId}`,
      userId: userId || 'system',
      userEmail: req.headers['x-user-email'] as string,
      userName: req.headers['x-user-name'] as string,
      roles: req.headers['x-user-roles']
        ? (req.headers['x-user-roles'] as string).split(',')
        : undefined,
      permissions: req.headers['x-user-permissions']
        ? (req.headers['x-user-permissions'] as string).split(',')
        : undefined,
      sessionId: req.headers['x-session-id'] as string,
      requestId,
      timestamp: new Date().toISOString(),
      source: 'headers',
    };

    logger.debug('Tenant context extracted from headers', {
      companyId: req.tenantContext.companyId,
      userId: req.tenantContext.userId,
      path: req.path,
    });

    return next();
  }

  // Try to extract from JWT
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('No tenant context headers and no JWT token', {
      path: req.path,
      method: req.method,
    });

    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication required. Provide either tenant headers (X-Company-ID, X-App-ID) or Authorization Bearer token.',
      code: 'AUTHENTICATION_REQUIRED',
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer '
  const payload = decodeJwtPayload(token);

  if (!payload) {
    logger.error('Failed to decode JWT token', {
      path: req.path,
      method: req.method,
    });

    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid JWT token format',
      code: 'INVALID_TOKEN',
    });
  }

  // Extract user info from JWT
  const userId = payload.sub as string;
  const userEmail = payload.email as string;
  const userName = payload.name as string;
  const tier = payload.tier as string;

  if (!userId) {
    logger.error('JWT token missing required "sub" claim', {
      path: req.path,
    });

    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'JWT token missing required user identifier',
      code: 'MISSING_USER_ID',
    });
  }

  // For dashboard users, derive tenant context from user ID
  // Company ID: Use "adverant" as the platform company
  // App ID: Use "dashboard" or tier-based app
  const derivedCompanyId = 'adverant';
  const derivedAppId = tier ? `dashboard-${tier}` : 'dashboard';
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();

  req.tenantContext = {
    companyId: derivedCompanyId,
    appId: derivedAppId,
    tenantId: `${derivedCompanyId}:${derivedAppId}`,
    userId,
    userEmail,
    userName,
    roles: tier ? [tier] : undefined,
    sessionId: payload.jti as string,
    requestId,
    timestamp: new Date().toISOString(),
    source: 'headers', // Mark as headers for compatibility
  };

  logger.debug('Tenant context extracted from JWT', {
    userId: req.tenantContext.userId,
    userEmail: req.tenantContext.userEmail,
    tier,
    companyId: req.tenantContext.companyId,
    appId: req.tenantContext.appId,
    path: req.path,
  });

  return next();
}

/**
 * Require user context for user-specific operations (JWT version)
 *
 * This is a lighter version that just checks userId is present,
 * without requiring X-User-ID header specifically.
 */
export function requireUserContextJwt(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.tenantContext) {
    logger.error('requireUserContextJwt called without tenant context', {
      path: req.path,
      method: req.method,
    });

    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Middleware ordering error: extractTenantContextFromJwtOrHeaders must be applied first',
      code: 'MIDDLEWARE_ORDERING_ERROR',
    });
  }

  if (!req.tenantContext.userId || req.tenantContext.userId === 'system') {
    logger.warn('User context required but not provided', {
      path: req.path,
      method: req.method,
    });

    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'User authentication required for this operation',
      code: 'USER_CONTEXT_REQUIRED',
    });
  }

  return next();
}

export default {
  extractTenantContextFromJwtOrHeaders,
  requireUserContextJwt,
};
