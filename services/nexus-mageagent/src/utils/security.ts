import { URL } from 'url';
import path from 'path';
import { logger } from './logger';

// Query sanitization for preventing injection attacks
export function sanitizeQuery(query: string): string {
  if (!query || typeof query !== 'string') {
    return '';
  }

  // Remove any potential command injection characters
  const dangerousChars = /[;&|`$(){}[\]<>\\]/g;
  let sanitized = query.replace(dangerousChars, '');

  // Limit query length to prevent DoS
  const MAX_QUERY_LENGTH = 1000;
  if (sanitized.length > MAX_QUERY_LENGTH) {
    sanitized = sanitized.substring(0, MAX_QUERY_LENGTH);
  }

  // Remove any SQL-like commands
  const sqlCommands = /\b(drop|exec|execute|insert|update|delete|create|alter|truncate|grant|revoke)\b/gi;
  sanitized = sanitized.replace(sqlCommands, '');

  // Remove any NoSQL operators
  const noSqlOperators = /\$\w+/g;
  sanitized = sanitized.replace(noSqlOperators, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  logger.debug('Query sanitized', {
    original: query.substring(0, 100),
    sanitized: sanitized.substring(0, 100)
  });

  return sanitized;
}

// Parameter binding for Neo4j queries
export function parameterizeCypherQuery(query: string, params: Record<string, any>): { query: string; params: Record<string, any> } {
  // Ensure all parameters are properly typed
  const sanitizedParams: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Escape special characters in strings
      sanitizedParams[key] = value.replace(/[\\'"`]/g, '\\$&');
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitizedParams[key] = value;
    } else if (value === null || value === undefined) {
      sanitizedParams[key] = null;
    } else if (Array.isArray(value)) {
      // Sanitize array elements
      sanitizedParams[key] = value.map(item =>
        typeof item === 'string' ? item.replace(/[\\'"`]/g, '\\$&') : item
      );
    } else {
      // Skip complex objects
      logger.warn('Skipping complex parameter type', { key, type: typeof value });
    }
  }

  return { query, params: sanitizedParams };
}

// Redis key sanitization
export function sanitizeRedisKey(key: string): string {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid Redis key');
  }

  // Remove any characters that could be used for command injection
  const sanitized = key
    .replace(/[*?[\]{}()\\]/g, '') // Remove wildcards and special chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .substring(0, 512); // Limit key length

  // Ensure the key is not empty after sanitization
  if (!sanitized) {
    throw new Error('Redis key is empty after sanitization');
  }

  return sanitized;
}

// File upload validation
export interface FileValidationOptions {
  maxSize?: number;
  allowedExtensions?: string[];
  allowedMimeTypes?: string[];
}

export function validateFileUpload(
  filename: string,
  fileSize: number,
  mimeType: string,
  options: FileValidationOptions = {}
): { valid: boolean; error?: string } {
  const {
    maxSize = 10 * 1024 * 1024, // 10MB default
    allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.txt', '.json'],
    allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'application/pdf',
      'text/plain',
      'application/json'
    ]
  } = options;

  // Check file size
  if (fileSize > maxSize) {
    return {
      valid: false,
      error: `File size exceeds maximum allowed size of ${maxSize} bytes`
    };
  }

  // Check file extension
  const ext = path.extname(filename).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `File extension '${ext}' is not allowed. Allowed extensions: ${allowedExtensions.join(', ')}`
    };
  }

  // Check MIME type
  if (!allowedMimeTypes.includes(mimeType)) {
    return {
      valid: false,
      error: `MIME type '${mimeType}' is not allowed. Allowed types: ${allowedMimeTypes.join(', ')}`
    };
  }

  // Check for path traversal attempts
  const normalizedPath = path.normalize(filename);
  if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
    return {
      valid: false,
      error: 'Invalid filename - path traversal detected'
    };
  }

  return { valid: true };
}

// URL validation for SSRF prevention
export function validateUrl(url: string, allowedHosts?: string[]): { valid: boolean; error?: string } {
  try {
    const parsedUrl = new URL(url);

    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        valid: false,
        error: `Invalid protocol: ${parsedUrl.protocol}. Only HTTP and HTTPS are allowed.`
      };
    }

    // Check against localhost and private IPs
    const hostname = parsedUrl.hostname.toLowerCase();
    const privatePatterns = [
      /^localhost$/,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /^fe80:/i
    ];

    if (privatePatterns.some(pattern => pattern.test(hostname))) {
      return {
        valid: false,
        error: 'Access to private/internal addresses is not allowed'
      };
    }

    // Check against allowed hosts if provided
    if (allowedHosts && allowedHosts.length > 0) {
      const isAllowed = allowedHosts.some(allowed =>
        hostname === allowed || hostname.endsWith(`.${allowed}`)
      );

      if (!isAllowed) {
        return {
          valid: false,
          error: `Host '${hostname}' is not in the allowed list`
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: 'Invalid URL format'
    };
  }
}

// Error message sanitization
export function sanitizeErrorMessage(error: any, isDevelopment: boolean = false): string {
  // In production, return generic messages
  if (!isDevelopment) {
    if (error instanceof Error) {
      // Map specific error types to generic messages
      if (error.message.includes('ECONNREFUSED')) {
        return 'Service temporarily unavailable';
      }
      if (error.message.includes('timeout')) {
        return 'Request timeout';
      }
      if (error.message.includes('authentication') || error.message.includes('unauthorized')) {
        return 'Authentication failed';
      }
      if (error.message.includes('validation')) {
        return 'Invalid request data';
      }
    }
    return 'An error occurred processing your request';
  }

  // In development, return sanitized error details
  if (error instanceof Error) {
    // Remove sensitive information from error messages
    let message = error.message;

    // Remove file paths
    message = message.replace(/\/[\w/\-._]+/g, '[path]');

    // Remove potential secrets (anything that looks like a key/token)
    message = message.replace(/[a-zA-Z0-9]{32,}/g, '[redacted]');

    // Remove IP addresses
    message = message.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[ip]');

    // Remove port numbers
    message = message.replace(/:\d{2,5}/g, ':[port]');

    return message;
  }

  return String(error);
}

// SQL injection pattern detection (for additional validation)
export function containsSqlInjectionPattern(input: string): boolean {
  const patterns = [
    // SQL keywords with potential injection
    /(\b)(union\s+select|select\s+from|insert\s+into|update\s+set|delete\s+from|drop\s+table|create\s+table)(\b)/i,
    // Comment sequences
    /(--|#|\/\*|\*\/)/,
    // Suspicious quote patterns
    /(['"];)/,
    // Hex encoding attempts
    /0x[0-9a-fA-F]+/,
    // Time-based injection patterns
    /(sleep|benchmark|waitfor\s+delay)/i
  ];

  return patterns.some(pattern => pattern.test(input));
}

// XSS prevention for output encoding
export function escapeHtml(input: string): string {
  const escapeMap: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;'
  };

  return input.replace(/[&<>"'/]/g, char => escapeMap[char] || char);
}

// Rate limiting key generator with security
export function generateRateLimitKey(identifier: string, action: string): string {
  // Sanitize inputs
  const safeIdentifier = sanitizeRedisKey(identifier);
  const safeAction = sanitizeRedisKey(action);

  // Generate a consistent key
  return `ratelimit:${safeAction}:${safeIdentifier}`;
}