/**
 * Request Validation Middleware for FileProcessAgent
 *
 * Implements comprehensive input validation using express-validator.
 * Catches parameter errors early before they cause silent failures.
 *
 * Design Pattern: Middleware Chain + Fail-Fast Validation
 * SOLID Principles:
 *   - Single Responsibility: Each validator handles one field
 *   - Open/Closed: Easy to add new validators
 */

import { Request, Response, NextFunction } from 'express';
import { body, param, query, validationResult, ValidationChain } from 'express-validator';
import { logger } from '../utils/logger';
import { ErrorCode } from '../errors/ValidationError';

/**
 * Middleware to check validation results and return structured errors
 */
export const validateRequest = (req: Request, res: Response, next: NextFunction): void | Response => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const firstError = errors.array()[0];

    logger.warn('Request validation failed', {
      field: firstError.type === 'field' ? (firstError as any).path : 'unknown',
      value: firstError.type === 'field' ? (firstError as any).value : undefined,
      message: firstError.msg,
      errors: errors.array(),
    });

    return res.status(400).json({
      success: false,
      error: ErrorCode.VALIDATION_FAILED,
      message: 'Request validation failed',
      details: errors.array().map((err) => ({
        field: err.type === 'field' ? (err as any).path : 'unknown',
        message: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      })),
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

/**
 * Validation rules for POST /api/process (file upload)
 */
export const validateFileUpload: ValidationChain[] = [
  // userId validation (optional but must be valid if provided)
  body('userId')
    .optional()
    .isString()
    .withMessage('userId must be a string')
    .trim()
    .notEmpty()
    .withMessage('userId cannot be empty')
    .isLength({ min: 1, max: 255 })
    .withMessage('userId must be between 1 and 255 characters')
    .matches(/^[a-zA-Z0-9._-]+$/)
    .withMessage('userId can only contain letters, numbers, dots, underscores, and hyphens'),

  // filename validation (optional in body, comes from multer req.file.originalname)
  body('filename')
    .optional()
    .isString()
    .withMessage('filename must be a string')
    .trim()
    .notEmpty()
    .withMessage('filename cannot be empty')
    .isLength({ min: 1, max: 255 })
    .withMessage('filename must be between 1 and 255 characters'),

  // metadata validation (optional JSON string)
  body('metadata')
    .optional()
    .custom((value) => {
      if (typeof value !== 'string') {
        throw new Error('metadata must be a JSON string');
      }
      try {
        JSON.parse(value);
        return true;
      } catch (error) {
        throw new Error('metadata must be valid JSON');
      }
    }),
];

/**
 * Validation rules for POST /api/process/url (URL-based upload)
 */
export const validateUrlUpload: ValidationChain[] = [
  // fileUrl validation (required)
  body('fileUrl')
    .exists()
    .withMessage('fileUrl is required')
    .isString()
    .withMessage('fileUrl must be a string')
    .trim()
    .notEmpty()
    .withMessage('fileUrl cannot be empty')
    .isURL({ protocols: ['http', 'https'], require_protocol: true })
    .withMessage('fileUrl must be a valid HTTP/HTTPS URL')
    .isLength({ max: 2048 })
    .withMessage('fileUrl must not exceed 2048 characters'),

  // filename validation (required)
  body('filename')
    .exists()
    .withMessage('filename is required')
    .isString()
    .withMessage('filename must be a string')
    .trim()
    .notEmpty()
    .withMessage('filename cannot be empty')
    .isLength({ min: 1, max: 255 })
    .withMessage('filename must be between 1 and 255 characters'),

  // mimeType validation (optional but must be valid if provided)
  body('mimeType')
    .optional()
    .isString()
    .withMessage('mimeType must be a string')
    .matches(/^[a-z]+\/[a-z0-9.+-]+$/)
    .withMessage('mimeType must be a valid MIME type (e.g., application/pdf, image/png)'),

  // userId validation (optional but must be valid if provided)
  body('userId')
    .optional()
    .isString()
    .withMessage('userId must be a string')
    .trim()
    .notEmpty()
    .withMessage('userId cannot be empty')
    .isLength({ min: 1, max: 255 })
    .withMessage('userId must be between 1 and 255 characters')
    .matches(/^[a-zA-Z0-9._-]+$/)
    .withMessage('userId can only contain letters, numbers, dots, underscores, and hyphens'),

  // metadata validation (optional object)
  body('metadata')
    .optional()
    .isObject()
    .withMessage('metadata must be an object'),
];

/**
 * Validation rules for GET /api/jobs/:jobId (job status)
 */
export const validateJobStatus: ValidationChain[] = [
  param('jobId')
    .exists()
    .withMessage('jobId is required')
    .isUUID()
    .withMessage('jobId must be a valid UUID'),
];

/**
 * Validation rules for GET /api/queue/stats (queue statistics)
 */
export const validateQueueStats: ValidationChain[] = [
  // Optional pagination parameters
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be an integer between 1 and 100')
    .toInt(),

  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('offset must be a non-negative integer')
    .toInt(),
];

/**
 * Custom validator: Check if file was uploaded
 */
export const validateFilePresence = (req: Request, res: Response, next: NextFunction): void | Response => {
  if (!req.file) {
    logger.warn('File upload missing');
    return res.status(400).json({
      success: false,
      error: ErrorCode.VALIDATION_FAILED,
      message: 'No file uploaded',
      details: {
        field: 'file',
        message: 'Please provide a file in the "file" field',
      },
      timestamp: new Date().toISOString(),
    });
  }

  next();
};

/**
 * Custom validator: Sanitize filename to prevent path traversal
 */
export const sanitizeFilename = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.file && req.file.originalname) {
    // Remove path components (../, ./, etc.)
    const sanitized = req.file.originalname
      .replace(/\.\./g, '')  // Remove ../
      .replace(/^\.\//, '')  // Remove leading ./
      .replace(/\//g, '_')   // Replace / with _
      .replace(/\\/g, '_')   // Replace \ with _
      .replace(/\0/g, '');   // Remove null bytes

    // Update filename
    req.file.originalname = sanitized;

    logger.debug('Filename sanitized', {
      original: req.file.originalname,
      sanitized,
    });
  }

  next();
};
