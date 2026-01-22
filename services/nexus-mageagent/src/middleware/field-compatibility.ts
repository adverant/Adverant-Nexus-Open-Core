/**
 * Field Compatibility Middleware for MageAgent
 * Provides backward compatibility for different field naming conventions
 * while maintaining semantic clarity in the core API
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Maps common field names to their semantic equivalents
 * This allows flexibility in API usage while maintaining clear internal semantics
 */
export const fieldCompatibilityMiddleware = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    // For orchestration endpoints - support both 'prompt' and 'task'
    if (req.path.includes('/orchestrate')) {
      if (req.body.prompt !== undefined && req.body.task === undefined) {
        req.body.task = req.body.prompt;
        logger.debug('Field compatibility: Mapped "prompt" to "task"', {
          path: req.path,
          originalField: 'prompt',
          mappedField: 'task'
        });
      }

      // Also support 'query' as an alternative
      if (req.body.query !== undefined && req.body.task === undefined) {
        req.body.task = req.body.query;
        logger.debug('Field compatibility: Mapped "query" to "task"', {
          path: req.path,
          originalField: 'query',
          mappedField: 'task'
        });
      }

      // Support 'objective' as an alternative
      if (req.body.objective !== undefined && req.body.task === undefined) {
        req.body.task = req.body.objective;
        logger.debug('Field compatibility: Mapped "objective" to "task"', {
          path: req.path,
          originalField: 'objective',
          mappedField: 'task'
        });
      }
    }

    // For competition endpoints - support both 'prompt' and 'challenge'
    if (req.path.includes('/competition') || req.path.includes('/compete')) {
      if (req.body.prompt !== undefined && req.body.challenge === undefined) {
        req.body.challenge = req.body.prompt;
        logger.debug('Field compatibility: Mapped "prompt" to "challenge"', {
          path: req.path,
          originalField: 'prompt',
          mappedField: 'challenge'
        });
      }

      // Also support 'task' as an alternative for competition
      if (req.body.task !== undefined && req.body.challenge === undefined) {
        req.body.challenge = req.body.task;
        logger.debug('Field compatibility: Mapped "task" to "challenge"', {
          path: req.path,
          originalField: 'task',
          mappedField: 'challenge'
        });
      }

      // Support 'question' as an alternative
      if (req.body.question !== undefined && req.body.challenge === undefined) {
        req.body.challenge = req.body.question;
        logger.debug('Field compatibility: Mapped "question" to "challenge"', {
          path: req.path,
          originalField: 'question',
          mappedField: 'challenge'
        });
      }
    }

    // For collaboration endpoints - support multiple field names
    if (req.path.includes('/collaborate')) {
      if (req.body.prompt !== undefined && req.body.task === undefined) {
        req.body.task = req.body.prompt;
      }
      if (req.body.objective !== undefined && req.body.task === undefined) {
        req.body.task = req.body.objective;
      }
    }

    // For synthesis endpoints - support multiple field names
    if (req.path.includes('/synthesis')) {
      if (req.body.prompt !== undefined && req.body.task === undefined) {
        req.body.task = req.body.prompt;
      }
      if (req.body.content !== undefined && req.body.task === undefined) {
        req.body.task = req.body.content;
      }
    }

    // For generic task endpoints - normalize field names
    if (req.path.includes('/task')) {
      if (req.body.prompt !== undefined && req.body.task === undefined) {
        req.body.task = req.body.prompt;
      }
    }

    // Log field mapping statistics for monitoring
    if (req.body._fieldsMapped) {
      logger.info('Field compatibility mappings applied', {
        path: req.path,
        mappings: req.body._fieldsMapped
      });
    }

    next();
  } catch (error) {
    // Don't fail on middleware errors - just log and continue
    logger.warn('Field compatibility middleware error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      path: req.path
    });
    next();
  }
};

/**
 * Response field compatibility - ensures consistent response format
 * Maps internal field names to user-expected names if needed
 */
export const responseFieldCompatibilityMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const originalJson = res.json;

  res.json = function(data: any) {
    try {
      // If the client sent 'prompt', include it in the response for consistency
      if (req.body.prompt !== undefined && data.task !== undefined) {
        data.prompt = data.task;
      }

      // If the client sent 'prompt' for competition, echo it back
      if ((req.path.includes('/competition') || req.path.includes('/compete')) &&
          req.body.prompt !== undefined && data.challenge !== undefined) {
        data.prompt = data.challenge;
      }

      // Add field mapping metadata if in development
      if (process.env.NODE_ENV === 'development') {
        if (req.body.prompt !== undefined) {
          data._fieldMapping = {
            info: 'Field compatibility applied',
            original: 'prompt',
            mapped: req.path.includes('/competition') ? 'challenge' : 'task'
          };
        }
      }
    } catch (error) {
      logger.warn('Response field compatibility error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    return originalJson.call(this, data);
  };

  next();
};