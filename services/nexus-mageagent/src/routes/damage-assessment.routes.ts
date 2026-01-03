/**
 * Damage Assessment Routes
 *
 * REST API endpoints for multi-model vision-based damage assessment.
 * Integrates MageAgent's consensus engine with vision models for
 * accurate property damage detection and cost estimation.
 */

import { Router, Request, Response } from 'express';
import { damageAssessmentService } from '../services/damage-assessment.service';
import { logger } from '../utils/logger';
import {
  ApiResponse
} from '../utils/api-response';
import {
  ValidationError,
  ErrorFactory
} from '../utils/errors';
import {
  asyncHandler,
  correlationId,
  requestTiming
} from '../middleware/error-handler';
import { sanitizeInputs } from '../middleware/validation';
import { apiRateLimiters } from '../middleware/security';

const router = Router();

// Apply global middleware
router.use(correlationId);
router.use(requestTiming);
router.use(sanitizeInputs);

/**
 * POST /damage-assessment/analyze
 *
 * Analyze a single image for property damage using multi-model consensus
 *
 * Request Body:
 * {
 *   imageUrl: string (required) - Base64 data URL or HTTP URL
 *   propertyContext?: {
 *     propertyId?: string
 *     propertyType?: 'residential' | 'commercial' | 'industrial'
 *     location?: string
 *     inspectionType?: 'move-in' | 'move-out' | 'routine' | 'incident'
 *     previousDamages?: Array<{type, location, repaired}>
 *   }
 * }
 *
 * Response: DamageAssessmentResult with consensus from 3-5 vision models
 */
router.post('/analyze',
  apiRateLimiters.orchestrate, // Use orchestrate rate limiter (10 req/min) - intensive operation
  asyncHandler(async (req: Request, res: Response) => {
    const { imageUrl, propertyContext } = req.body;

    // Validation
    if (!imageUrl) {
      throw new ValidationError('Image URL is required', {
        acceptedFields: ['imageUrl', 'propertyContext'],
        example: {
          imageUrl: 'data:image/jpeg;base64,...',
          propertyContext: {
            propertyId: 'prop-123',
            propertyType: 'residential',
            inspectionType: 'move-in'
          }
        }
      });
    }

    // Validate image URL format
    if (!imageUrl.startsWith('data:image/') && !imageUrl.startsWith('http')) {
      throw new ValidationError('Invalid image URL format', {
        acceptedFormats: ['data:image/[type];base64,...', 'http://...', 'https://...'],
        provided: imageUrl.substring(0, 50) + '...'
      });
    }

    logger.info('[DamageAssessment API] Analyze request', {
      propertyId: propertyContext?.propertyId,
      inspectionType: propertyContext?.inspectionType,
      imageFormat: imageUrl.startsWith('data:') ? 'base64' : 'url'
    });

    try {
      // Run multi-model damage assessment
      const result = await damageAssessmentService.assessDamage(imageUrl, propertyContext);

      return ApiResponse.success(res, {
        requestId: result.requestId,
        damages: result.consensus.damages,
        consensusStrength: result.consensus.consensusStrength,
        confidenceScore: result.consensus.confidenceScore,
        costEstimate: result.consensus.costEstimate,
        summary: result.consensus.summary,
        uncertainties: result.consensus.uncertainties,
        processingTimeMs: result.processingTimeMs,
        timestamp: result.timestamp
      }, {
        models: result.consensus.modelResults.map(m => ({
          name: m.model,
          damages: m.damages.length,
          confidence: m.confidence,
          processingTime: m.processingTime
        })),
        note: 'Consensus from multiple vision models for high accuracy'
      });
    } catch (error) {
      logger.error('[DamageAssessment API] Analysis failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        propertyId: propertyContext?.propertyId
      });

      throw ErrorFactory.internalError(
        'Damage assessment failed',
        { error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  })
);

/**
 * POST /damage-assessment/analyze-batch
 *
 * Analyze multiple images in batch (max 20 images per request)
 *
 * Request Body:
 * {
 *   imageUrls: string[] (required) - Array of image URLs (max 20)
 *   propertyContext?: PropertyContext
 * }
 *
 * Response: Array of DamageAssessmentResult
 */
router.post('/analyze-batch',
  apiRateLimiters.orchestrate,
  asyncHandler(async (req: Request, res: Response) => {
    const { imageUrls, propertyContext } = req.body;

    // Validation
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      throw new ValidationError('Image URLs array is required', {
        acceptedFields: ['imageUrls', 'propertyContext'],
        example: {
          imageUrls: ['data:image/jpeg;base64,...', 'data:image/jpeg;base64,...'],
          propertyContext: { propertyId: 'prop-123' }
        }
      });
    }

    // Limit batch size to prevent abuse
    if (imageUrls.length > 20) {
      throw new ValidationError('Maximum 20 images per batch', {
        provided: imageUrls.length,
        maxAllowed: 20
      });
    }

    logger.info('[DamageAssessment API] Batch analyze request', {
      imageCount: imageUrls.length,
      propertyId: propertyContext?.propertyId
    });

    try {
      // Run batch assessment
      const results = await damageAssessmentService.assessDamageBatch(imageUrls, propertyContext);

      return ApiResponse.success(res, {
        totalImages: results.length,
        totalDamages: results.reduce((sum, r) => sum + r.consensus.damages.length, 0),
        results: results.map(r => ({
          requestId: r.requestId,
          damages: r.consensus.damages,
          consensusStrength: r.consensus.consensusStrength,
          confidenceScore: r.consensus.confidenceScore,
          costEstimate: r.consensus.costEstimate,
          summary: r.consensus.summary,
          processingTimeMs: r.processingTimeMs
        })),
        aggregatedCostEstimate: {
          min: results.reduce((sum, r) => sum + (r.consensus.costEstimate?.totalEstimate.min || 0), 0),
          max: results.reduce((sum, r) => sum + (r.consensus.costEstimate?.totalEstimate.max || 0), 0),
          currency: 'USD'
        }
      }, {
        note: 'Batch processing completed',
        averageProcessingTime: Math.round(
          results.reduce((sum, r) => sum + r.processingTimeMs, 0) / results.length
        )
      });
    } catch (error) {
      logger.error('[DamageAssessment API] Batch analysis failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        imageCount: imageUrls.length
      });

      throw ErrorFactory.internalError(
        'Batch damage assessment failed',
        { error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  })
);

/**
 * GET /damage-assessment/models
 *
 * Get list of available vision models for damage assessment
 *
 * Response: Array of {id, name} for each vision model
 */
router.get('/models',
  asyncHandler(async (_req: Request, res: Response) => {
    const models = damageAssessmentService.getAvailableModels();

    return ApiResponse.success(res, {
      models,
      count: models.length,
      note: 'These models are used in consensus for damage assessment'
    });
  })
);

/**
 * GET /damage-assessment/health
 *
 * Health check for damage assessment service
 *
 * Response: Service status and model availability
 */
router.get('/health',
  asyncHandler(async (_req: Request, res: Response) => {
    const models = damageAssessmentService.getAvailableModels();

    return ApiResponse.success(res, {
      status: 'healthy',
      service: 'damage-assessment',
      modelsAvailable: models.length,
      models: models.map(m => m.name),
      features: [
        'Multi-model vision consensus',
        'Damage type classification (4 categories)',
        'Severity assessment (4 levels)',
        'Cost estimation',
        'Batch processing (up to 20 images)',
        'GraphRAG memory storage'
      ]
    });
  })
);

export default router;
