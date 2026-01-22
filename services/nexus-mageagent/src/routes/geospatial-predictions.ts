/**
 * Geospatial Prediction Routes - Dynamic Operation-Based API
 *
 * Provides LLM-based geospatial predictions via OpenRouter.
 * Uses dynamic operation routing with optional WebSocket streaming.
 *
 * Pattern: POST /predictions { operation, params, options }
 */

import { Router, Request, Response, NextFunction } from 'express';
import { GeospatialPredictionService } from '../services/geospatial-prediction';
import { getTaskManager } from '../core/task-manager';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import type {
  PredictionType,
  GeospatialPredictionRequest,
  PredictionJobResponse,
  PredictionStatusResponse
} from '../types/geospatial-predictions';

const router = Router();

// Initialize service (singleton)
let predictionService: GeospatialPredictionService | null = null;

const getPredictionService = (): GeospatialPredictionService => {
  if (!predictionService) {
    predictionService = new GeospatialPredictionService();
    logger.info('GeospatialPredictionService initialized');
  }
  return predictionService;
};

// ============================================================================
// PREDICTION ROUTES - DYNAMIC OPERATION HANDLING
// ============================================================================

/**
 * POST /predictions
 * Execute geospatial prediction operations
 *
 * Body: { operation, params, options }
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { operation, params = {}, options = {} } = req.body;

    // Validate operation parameter - FULLY DYNAMIC: accepts ANY string
    if (!operation || typeof operation !== 'string' || operation.trim() === '') {
      return res.status(400).json({
        error: 'Missing or invalid required parameter: operation',
        description: 'Operation must be a non-empty string describing the desired geospatial prediction',
        examples: [
          {
            operation: 'land_use_classification',
            params: {
              location: { latitude: 37.7749, longitude: -122.4194, name: 'San Francisco' },
              imagery: { ndvi: 0.45, landCover: 'urban', elevation: 52 }
            },
            options: { preferAccuracy: true, stream: false }
          },
          {
            operation: 'solar_potential_analysis',
            params: {
              location: { latitude: 34.0522, longitude: -118.2437, name: 'Los Angeles' },
              features: { roofArea: 1000, orientation: 'south' }
            }
          },
          {
            operation: 'earthquake_risk_assessment',
            params: {
              location: { latitude: 37.8, longitude: -122.4, name: 'Bay Area' },
              features: { faultProximity: 5, soilType: 'clay' }
            }
          }
        ],
        note: 'Service accepts ANY operation name - no predefined list. Describe your prediction need in snake_case or natural language.'
      });
    }

    // Check if streaming is requested
    const shouldStream = options.stream === true;
    const jobId = uuidv4();

    logger.info('[GeospatialPrediction] Request received', {
      operation,
      jobId,
      streaming: shouldStream,
      location: params.location?.name
    });

    if (shouldStream) {
      // Async execution with WebSocket streaming
      const taskManager = getTaskManager();

      // Create prediction request
      const predictionRequest: GeospatialPredictionRequest = {
        operation: operation as PredictionType,
        params,
        options,
        jobId
      };

      // Submit as async task
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask(
        'geospatial_prediction',
        { predictionRequest },
        {
          timeout: options.timeout || 60000,
          priority: 1,
          tenantContext: req.tenantContext
        }
      );

      logger.info('[GeospatialPrediction] Async task created', {
        jobId,
        taskId,
        operation
      });

      // Return immediately with streaming info
      const response: PredictionJobResponse = {
        success: true,
        jobId: taskId,
        status: 'pending',
        message: 'Prediction task submitted with real-time streaming',
        streaming: {
          enabled: true,
          subscribe: {
            room: `task:${taskId}`,
            events: ['task_stream', 'task_created', 'task_progress', 'task_completed', 'task_failed']
          }
        }
      };

      return res.json(response);

    } else {
      // Synchronous execution
      const service = getPredictionService();

      const predictionRequest: GeospatialPredictionRequest = {
        operation: operation as PredictionType,
        params,
        options,
        jobId
      };

      const result = await service.predict(predictionRequest);

      logger.info('[GeospatialPrediction] Synchronous prediction complete', {
        operation,
        jobId,
        confidence: result.confidence,
        modelUsed: result.modelUsed
      });

      const response: PredictionJobResponse = {
        success: true,
        jobId,
        status: 'completed',
        message: 'Prediction completed successfully',
        result: result as any
      };

      return res.json(response);
    }

  } catch (error) {
    logger.error('[GeospatialPrediction] Prediction failed', {
      operation: req.body.operation,
      error: error instanceof Error ? error.message : String(error)
    });
    return next(error);
  }
});

/**
 * GET /predictions/:jobId
 * Get prediction job status and result
 */
router.get('/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;

    logger.debug('[GeospatialPrediction] Status check requested', { jobId });

    const taskManager = getTaskManager();
    const task = await taskManager.getTaskStatus(jobId);

    if (!task) {
      return res.status(404).json({
        error: 'Prediction job not found',
        jobId
      });
    }

    const response: PredictionStatusResponse = {
      jobId: task.id,
      status: task.status === 'timeout' ? 'failed' : task.status as 'pending' | 'running' | 'completed' | 'failed',
      progress: task.progress,
      result: task.result,
      error: task.error,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString(),
      completedAt: task.completedAt?.toISOString()
    };

    return res.json(response);

  } catch (error) {
    logger.error('[GeospatialPrediction] Status check failed', {
      jobId: req.params.jobId,
      error: error instanceof Error ? error.message : String(error)
    });
    return next(error);
  }
});

/**
 * GET /predictions
 * Service information and usage examples
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'Geospatial Prediction Service',
    version: '2.0.0',
    description: 'FULLY DYNAMIC LLM-based geospatial predictions via OpenRouter - accepts ANY operation name without code changes',
    endpoint: 'POST /predictions',

    dynamicCapability: {
      enabled: true,
      description: 'Service accepts ANY operation string - no predefined list or hardcoded operations',
      usage: 'Describe your geospatial prediction need in snake_case, kebab-case, or natural language',
      examples: [
        'land_use_classification',
        'solar_potential_analysis',
        'earthquake_risk_assessment',
        'air_quality_prediction',
        'tsunami_vulnerability',
        'permafrost_thaw_analysis',
        'coral_reef_health',
        'ANY_GEOSPATIAL_OPERATION_YOU_NEED'
      ]
    },

    requestFormat: {
      operation: 'string (required) - ANY geospatial operation name',
      params: {
        location: '{ latitude, longitude, name? } - Geographic coordinates',
        imagery: '{ ndvi?, landCover?, elevation?, temperature?, precipitation? } - Satellite/sensor data',
        timeRange: '{ start, end } - ISO 8601 date strings for temporal predictions',
        features: 'Record<string, any> - Any additional operation-specific data',
        customPrompt: 'string (optional) - Override with custom prompt'
      },
      options: {
        preferAccuracy: 'boolean (default: false) - Use high-accuracy models (slower)',
        stream: 'boolean (default: false) - Enable WebSocket streaming',
        timeout: 'number (default: 60000) - Timeout in milliseconds'
      }
    },

    exampleRequests: [
      {
        title: 'Land Use Classification',
        request: {
          operation: 'land_use_classification',
          params: {
            location: { latitude: 37.7749, longitude: -122.4194, name: 'San Francisco' },
            imagery: { ndvi: 0.45, landCover: 'urban', elevation: 52 }
          }
        }
      },
      {
        title: 'Solar Potential Analysis (NEW - No code changes needed)',
        request: {
          operation: 'solar_potential_analysis',
          params: {
            location: { latitude: 34.0522, longitude: -118.2437, name: 'Los Angeles' },
            features: { roofArea: 1000, orientation: 'south', shading: 'minimal', avgSunlightHours: 8 }
          },
          options: { preferAccuracy: true }
        }
      },
      {
        title: 'Earthquake Risk (NEW - No code changes needed)',
        request: {
          operation: 'earthquake_risk_assessment',
          params: {
            location: { latitude: 37.8, longitude: -122.4, name: 'Bay Area' },
            features: { faultProximity: 5, soilType: 'clay', buildingAge: 50 }
          }
        }
      },
      {
        title: 'Custom Prompt',
        request: {
          operation: 'custom_analysis',
          params: {
            customPrompt: 'Analyze the impact of sea level rise on coastal infrastructure',
            location: { latitude: 25.7617, longitude: -80.1918, name: 'Miami Beach' },
            features: { currentSeaLevel: 0, projectedRise: 3.5, infrastructureValue: 1000000000 }
          }
        }
      },
      {
        title: 'Wildfire Risk with Streaming',
        request: {
          operation: 'wildfire_risk_assessment',
          params: {
            location: { latitude: 37.8, longitude: -122.4, name: 'Oakland Hills' },
            imagery: { ndvi: 0.65, landCover: 'forest', elevation: 450 },
            timeRange: { start: '2025-06-01', end: '2025-09-30' }
          },
          options: { stream: true }
        }
      }
    ],

    models: {
      highAccuracy: {
        enabled: 'When options.preferAccuracy = true',
        models: ['Claude Opus 4', 'Claude 3.7 Sonnet', 'GPT-4o'],
        useCase: 'Complex spatial reasoning, high-stakes decisions'
      },
      balanced: {
        enabled: 'Default (options.preferAccuracy = false)',
        models: ['Claude 3.5 Sonnet', 'GPT-4o', 'Gemini 2.0 Flash'],
        useCase: 'Standard predictions, good balance of speed and accuracy'
      }
    },

    responseFormat: {
      prediction: 'any - Structured prediction result (format varies by operation)',
      confidence: 'number (0-1) - Confidence score',
      reasoning: 'string - Explanation of prediction',
      modelUsed: 'string - Model that generated the prediction',
      processingTime: 'number - Time in milliseconds',
      metadata: {
        operation: 'string - Operation name',
        location: 'string - Location name',
        timestamp: 'string - ISO 8601 timestamp'
      }
    },

    streaming: {
      enabled: 'Set options.stream = true',
      protocol: 'WebSocket via Socket.IO',
      events: ['task_created', 'task_progress', 'task_completed', 'task_failed'],
      subscribe: 'Subscribe to room: task:{jobId}'
    },

    notes: [
      '✅ FULLY DYNAMIC: No hardcoded operations - service accepts ANY geospatial prediction',
      '✅ Zero code changes needed for new operations',
      '✅ LLM intelligence automatically adapts to ANY operation request',
      '✅ Fallback model chains ensure reliability',
      '✅ WebSocket streaming available for real-time progress',
      '⚠️  Custom prompts override automatic prompt generation'
    ]
  });
});

export default router;
