import { Request, Response, NextFunction } from 'express';
import { body, param, validationResult } from 'express-validator';
import Joi from 'joi';
import { logger } from '../utils/logger';
import {
  EPISODE_VALIDATION_RULES,
} from '../validation/episode-validation';

// SQL injection prevention patterns
const SQL_INJECTION_PATTERNS = [
  /(\b)(union|select|insert|update|delete|drop|create|alter|exec|execute)(\b).*?(\b)(from|into|where|set)(\b)/i,
  /(--|#|\/\*|\*\/)/,
  /[';].*?(union|select|insert|update|delete|drop)/i,
  /\b(and|or)\b.*?[=<>]/i,
  /\b(having|group by|order by)\b.*?['"]/i
];

// XSS prevention patterns
const XSS_PATTERNS = [
  /<script[^>]*>[\s\S]*?<\/script>/gi,
  /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi,
  /<img[^>]+src[\s]*=[\s]*["']javascript:/gi
];

// Sanitize input to prevent SQL injection
export function sanitizeSqlInput(input: string): string {
  if (typeof input !== 'string') return input;

  const sanitized = input.trim();

  // Check for SQL injection patterns
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      logger.warn('Potential SQL injection detected', {
        input: sanitized.substring(0, 100),
        pattern: pattern.toString()
      });
      throw new Error('Invalid input detected');
    }
  }

  return sanitized;
}

// Sanitize input to prevent XSS
export function sanitizeXssInput(input: string): string {
  if (typeof input !== 'string') return input;

  let sanitized = input.trim();

  // Remove XSS patterns
  for (const pattern of XSS_PATTERNS) {
    if (pattern.test(sanitized)) {
      logger.warn('Potential XSS attempt detected', {
        input: sanitized.substring(0, 100),
        pattern: pattern.toString()
      });
      sanitized = sanitized.replace(pattern, '');
    }
  }

  // HTML encode special characters
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

  return sanitized;
}

// Validation schemas with field compatibility
export const validationSchemas = {
  orchestrate: Joi.object({
    // ✨ ENHANCED: Add length validation using episode validation rules
    // Accept multiple field names for the main task - WITH BUSINESS RULE VALIDATION
    task: Joi.alternatives().try(
      Joi.string()
        .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
        .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH)
        .messages({
          'string.min': `Message must be at least ${EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH} characters`,
          'string.max': `Message cannot exceed ${EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH} characters`,
        }),
      Joi.object({
        objective: Joi.string().required(),
        context: Joi.object(),
        query: Joi.string()
      })
    ),
    // Also accept these alternative field names (they'll be mapped by middleware)
    prompt: Joi.alternatives().try(
      Joi.string()
        .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
        .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
      Joi.object()
    ),
    query: Joi.string()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    objective: Joi.string()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    options: Joi.object({
      type: Joi.string().valid('analysis', 'competition', 'collaboration', 'synthesis'),
      constraints: Joi.object()
    })
  }).or('task', 'prompt', 'query', 'objective'),  // At least one of these must be present

  competition: Joi.object({
    // ✨ ENHANCED: Add length validation for competition challenges
    challenge: Joi.string()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    prompt: Joi.string()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    task: Joi.string()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    question: Joi.string()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    competitorCount: Joi.number().integer().min(2).default(3),
    models: Joi.array().items(Joi.string()),
    timeLimit: Joi.number().integer().min(1000).max(3600000),
    timeout: Joi.number().integer().min(1000).max(3600000),
    async: Joi.boolean().default(false),  // CRITICAL: Allow async mode for long-running competitions
    constraints: Joi.object()
  }).or('challenge', 'prompt', 'task', 'question'),  // At least one of these must be present

  memorySearch: Joi.object({
    query: Joi.string()
      .required()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH),
    limit: Joi.number().integer().min(1).max(100).default(10)
  }),

  // ✨ NEW: Episode storage schema (for direct episode API endpoints)
  storeEpisode: Joi.object({
    content: Joi.string()
      .required()
      .min(EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH)
      .max(EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH)
      .messages({
        'string.min': `Episode content must be at least ${EPISODE_VALIDATION_RULES.MIN_CONTENT_LENGTH} characters`,
        'string.max': `Episode content cannot exceed ${EPISODE_VALIDATION_RULES.MAX_CONTENT_LENGTH} characters`,
        'any.required': 'Episode content is required',
      }),
    type: Joi.string()
      .valid(
        'user_query',
        'agent_response',
        'orchestration',
        'competition',
        'synthesis',
        'feedback',
        'system_response',
        'event',
        'observation',
        'insight'
      )
      .required()
      .messages({
        'any.only': 'Invalid episode type',
        'any.required': 'Episode type is required',
      }),
    metadata: Joi.object().optional(),
  }),
};

// Express validators with field compatibility
export const validators = {
  orchestrate: [
    // Custom validator that checks for any of the accepted fields
    body().custom((value) => {
      if (value.task || value.prompt || value.query || value.objective) {
        return true;
      }
      throw new Error('One of task, prompt, query, or objective is required');
    }),
    body('options').optional().isObject().withMessage('Options must be an object')
  ],

  competition: [
    body('challenge').notEmpty().isString()
      .withMessage('Challenge is required'),
    body('competitorCount').optional().isInt({ min: 2 })
      .withMessage('Competitor count must be at least 2')
  ],

  agentId: [
    param('agentId').matches(/^[a-zA-Z0-9-]+$/).withMessage('Invalid agent ID format')
  ],

  taskId: [
    param('taskId').matches(/^[a-zA-Z0-9-]+$/).withMessage('Invalid task ID format')
  ]
};

// Validation error handler
export function handleValidationErrors(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    logger.warn('Validation failed', {
      path: req.path,
      errors: errors.array()
    });

    res.status(400).json({
      error: 'Validation failed',
      details: errors.array()
    });
    return;
  }

  next();
}

// Endpoints that contain legitimate technical content and should skip SQL injection detection
const CONTENT_STORAGE_ENDPOINTS = [
  '/patterns',
  '/api/patterns',
  '/documents',
  '/api/documents',
  '/memories',
  '/api/memories',
  '/episodes',
  '/api/episodes',
  '/orchestrate',
  '/api/orchestrate',
  '/collaborate',
  '/api/collaborate',
  '/competition',
  '/api/competition',
  '/analyze',
  '/api/analyze',
  '/synthesize',
  '/api/synthesize',
  // Vision and file processing endpoints with base64-encoded data
  '/vision/extract-text',
  '/api/internal/vision/extract-text',
  '/vision/analyze-layout',
  '/api/internal/vision/analyze-layout',
  '/vision/extract-table',
  '/api/internal/vision/extract-table',
  '/file-process',
  '/api/internal/file-process',
  '/internal/file-process'
];

/**
 * Determines if an endpoint should skip SQL injection detection
 * Content storage endpoints legitimately contain technical terminology
 */
function shouldSkipSqlInjectionCheck(path: string): boolean {
  return CONTENT_STORAGE_ENDPOINTS.some(endpoint =>
    path === endpoint || path.startsWith(`${endpoint}/`)
  );
}

// Sanitize all inputs middleware
export function sanitizeInputs(req: Request, res: Response, next: NextFunction): void {
  try {
    const skipSqlCheck = shouldSkipSqlInjectionCheck(req.path);

    logger.info('SQL injection check decision', {
      path: req.path,
      skipSqlCheck,
      method: req.method
    });

    if (skipSqlCheck) {
      logger.info('Skipping SQL injection check for content storage endpoint', {
        path: req.path
      });
    }

    // Sanitize body
    if (req.body) {
      req.body = sanitizeObject(req.body, skipSqlCheck);
    }

    // Sanitize query parameters
    if (req.query) {
      req.query = sanitizeObject(req.query as any, skipSqlCheck);
    }

    // Sanitize route params
    if (req.params) {
      req.params = sanitizeObject(req.params, skipSqlCheck);
    }

    next();
  } catch (error) {
    logger.error('Input sanitization failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      path: req.path
    });
    res.status(400).json({ error: 'Invalid input' });
  }
}

function sanitizeObject(obj: any, skipSqlCheck: boolean = false): any {
  if (typeof obj === 'string') {
    // Apply XSS sanitization always
    // Only apply SQL injection check if not skipped
    if (skipSqlCheck) {
      return sanitizeXssInput(obj);
    } else {
      return sanitizeXssInput(sanitizeSqlInput(obj));
    }
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, skipSqlCheck));
  }

  if (obj !== null && typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value, skipSqlCheck);
    }
    return sanitized;
  }

  return obj;
}

// Joi validation middleware
export function validateSchema(schema: Joi.Schema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      logger.warn('Schema validation failed', {
        path: req.path,
        errors: error.details
      });

      res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message
        }))
      });
      return;
    }

    req.body = value;
    next();
  };
}