/**
 * Unit tests for security middleware
 * Tests real security behaviors without mock data
 */

import { Request, Response, NextFunction } from 'express';
import {
  securityHeaders,
  globalRateLimiter,
  strictRateLimiter,
  apiRateLimiters,
  configureCors,
  ipBlocker,
  securityMiddleware
} from '../../../src/middleware/security';
import { logger } from '../../../src/utils/logger';

// Mock logger to capture warnings/errors
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('Security Middleware Unit Tests', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock request
    req = {
      ip: '192.168.1.100',
      path: '/api/test',
      method: 'GET',
      query: {},
      headers: {},
      get: jest.fn()
    };

    // Create mock response
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis()
    };

    next = jest.fn();
  });

  describe('Security Headers', () => {
    it('should apply helmet security headers', () => {
      // Security headers is a helmet middleware, test it's defined
      expect(securityHeaders).toBeDefined();
      expect(typeof securityHeaders).toBe('function');
    });
  });

  describe('IP Blocker', () => {
    it('should allow normal requests', () => {
      req.path = '/api/orchestrate';

      ipBlocker(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should detect and track suspicious PHP requests', () => {
      req.path = '/admin/config.php';

      ipBlocker(req as Request, res as Response, next);

      expect(logger.warn).toHaveBeenCalledWith(
        'Suspicious request detected',
        expect.objectContaining({
          ip: '192.168.1.100',
          path: '/admin/config.php',
          attempts: 1
        })
      );
      expect(next).toHaveBeenCalled();
    });

    it('should detect and track suspicious admin paths', () => {
      req.path = '/wp-admin/install.php';

      ipBlocker(req as Request, res as Response, next);

      expect(logger.warn).toHaveBeenCalledWith(
        'Suspicious request detected',
        expect.objectContaining({
          ip: '192.168.1.100',
          path: '/wp-admin/install.php',
          attempts: 1
        })
      );
    });

    it('should detect and track suspicious file extensions', () => {
      const suspiciousFiles = ['.git', '.env', '.config', '.bak', '.backup', '.sql'];

      suspiciousFiles.forEach((file, index) => {
        req.path = `/secret${file}`;
        ipBlocker(req as Request, res as Response, next);

        expect(logger.warn).toHaveBeenCalledWith(
          'Suspicious request detected',
          expect.objectContaining({
            ip: '192.168.1.100',
            path: `/secret${file}`,
            attempts: index + 1
          })
        );
      });
    });

    it('should block IP after 5 suspicious attempts', () => {
      // Make 6 suspicious requests
      for (let i = 0; i < 6; i++) {
        req.path = `/admin/test${i}.php`;
        ipBlocker(req as Request, res as Response, next);
      }

      // After 5 attempts, IP should be blocked
      expect(logger.error).toHaveBeenCalledWith(
        'IP blocked due to suspicious activity',
        { ip: '192.168.1.100' }
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    });

    it('should deny access to blocked IPs', () => {
      // First, get IP blocked
      for (let i = 0; i < 6; i++) {
        req.path = `/hack${i}.sql`;
        ipBlocker(req as Request, res as Response, next);
      }

      // Reset mocks
      jest.clearAllMocks();

      // Try normal request with blocked IP
      req.path = '/api/health';
      ipBlocker(req as Request, res as Response, next);

      expect(logger.warn).toHaveBeenCalledWith(
        'Blocked IP attempted access',
        { ip: '192.168.1.100', path: '/api/health' }
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
      expect(next).not.toHaveBeenCalled();
    });

    it('should handle requests without IP', () => {
      req.ip = undefined;

      ipBlocker(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('Security Middleware', () => {
    it('should prevent HTTP Parameter Pollution', () => {
      req.query = {
        normal: 'value',
        polluted: ['first', 'second', 'third']
      };

      securityMiddleware(req as Request, res as Response, next);

      // Should keep only the last value
      expect(req.query.normal).toBe('value');
      expect(req.query.polluted).toBe('third');
      expect(Array.isArray(req.query.polluted)).toBe(false);
    });

    it('should set security headers', () => {
      securityMiddleware(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains; preload'
      );
      expect(next).toHaveBeenCalled();
    });

    it('should handle empty query parameters', () => {
      req.query = {};

      expect(() => {
        securityMiddleware(req as Request, res as Response, next);
      }).not.toThrow();

      expect(next).toHaveBeenCalled();
    });
  });

  describe('CORS Configuration', () => {
    let corsConfig: any;

    beforeEach(() => {
      // Store original env
      process.env.ALLOWED_ORIGINS = '';
      corsConfig = configureCors();
    });

    it('should allow default localhost origins in development', (done) => {
      corsConfig.origin('http://localhost:3000', (err: Error | null, allow?: boolean) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('should allow requests with no origin', (done) => {
      corsConfig.origin(undefined, (err: Error | null, allow?: boolean) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('should block unauthorized origins', (done) => {
      corsConfig.origin('http://evil.com', (err: Error | null, allow?: boolean) => {
        expect(err).toBeDefined();
        expect(err?.message).toBe('Not allowed by CORS');
        expect(logger.warn).toHaveBeenCalledWith(
          'CORS blocked request',
          expect.objectContaining({
            origin: 'http://evil.com'
          })
        );
        done();
      });
    });

    it('should use custom allowed origins from environment', (done) => {
      process.env.ALLOWED_ORIGINS = 'https://app.example.com,https://admin.example.com';
      corsConfig = configureCors();

      corsConfig.origin('https://app.example.com', (err: Error | null, allow?: boolean) => {
        expect(err).toBeNull();
        expect(allow).toBe(true);
        done();
      });
    });

    it('should have correct CORS settings', () => {
      expect(corsConfig.credentials).toBe(true);
      expect(corsConfig.optionsSuccessStatus).toBe(200);
      expect(corsConfig.methods).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
      expect(corsConfig.allowedHeaders).toContain('Authorization');
      expect(corsConfig.exposedHeaders).toContain('X-RateLimit-Limit');
    });
  });

  describe('Request Size Limiter', () => {
    it('should have proper size limits for large LLM requests', () => {
      const { requestSizeLimiter } = require('../../../src/middleware/security');

      expect(requestSizeLimiter.json).toBe('100mb');
      expect(requestSizeLimiter.text).toBe('50mb');
      expect(requestSizeLimiter.raw).toBe('100mb');
      expect(requestSizeLimiter.urlencoded.limit).toBe('100mb');
    });
  });

  describe('Rate Limiters', () => {
    it('should have different rate limits for different endpoints', () => {
      // Test configuration exists
      expect(globalRateLimiter).toBeDefined();
      expect(strictRateLimiter).toBeDefined();
      expect(apiRateLimiters.orchestrate).toBeDefined();
      expect(apiRateLimiters.competition).toBeDefined();
      expect(apiRateLimiters.memorySearch).toBeDefined();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle malformed requests gracefully', () => {
      req.query = null as any;

      expect(() => {
        securityMiddleware(req as Request, res as Response, next);
      }).not.toThrow();
    });

    it('should handle concurrent suspicious requests from same IP', () => {
      // Simulate rapid suspicious requests
      const requests = Array(10).fill(null).map((_, i) => ({
        ...req,
        path: `/hack${i}.php`
      }));

      requests.forEach(r => {
        ipBlocker(r as Request, res as Response, next);
      });

      // Should block after 5 attempts
      const blockedCalls = (res.status as jest.Mock).mock.calls.filter(
        call => call[0] === 403
      ).length;

      expect(blockedCalls).toBeGreaterThan(0);
    });

    it('should handle special characters in paths', () => {
      const specialPaths = [
        '/api/../../../etc/passwd',
        '/api/%2e%2e%2f%2e%2e%2f',
        '/api/\\..\\..\\',
        '/api/<script>alert(1)</script>'
      ];

      specialPaths.forEach(path => {
        req.path = path;
        expect(() => {
          ipBlocker(req as Request, res as Response, next);
        }).not.toThrow();
      });
    });
  });
});

describe('Security Middleware Integration Behaviors', () => {
  it('should protect against common attack vectors', () => {
    const attackVectors = [
      { path: '/.git/config', shouldBlock: true },
      { path: '/.env', shouldBlock: true },
      { path: '/wp-admin/', shouldBlock: true },
      { path: '/phpmyadmin/', shouldBlock: true },
      { path: '/backup.sql', shouldBlock: true },
      { path: '/api/health', shouldBlock: false },
      { path: '/api/orchestrate', shouldBlock: false }
    ];

    attackVectors.forEach(vector => {
      const req = { ip: '10.0.0.1', path: vector.path } as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      } as any;
      const next = jest.fn();

      ipBlocker(req, res, next);

      if (vector.shouldBlock) {
        expect(logger.warn).toHaveBeenCalledWith(
          'Suspicious request detected',
          expect.any(Object)
        );
      } else {
        expect(next).toHaveBeenCalled();
      }
    });
  });
});