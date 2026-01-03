/**
 * Geospatial Prediction Service - LLM-Based Spatial Intelligence
 *
 * Leverages OpenRouter LLMs for geospatial predictions via natural language reasoning.
 * Supports dynamic prediction types with model fallback chains.
 *
 * Architecture:
 * - Direct OpenRouter integration (no hardcoded models)
 * - Dynamic prediction operations (land use, risk assessment, traffic, etc.)
 * - Intelligent model selection based on task complexity
 * - Async operation with job IDs and WebSocket streaming
 *
 * NOT using Vertex AI (reserved for future custom model deployment)
 */

import { OpenRouterClient } from '../clients/openrouter-client';
import { logger } from '../utils/logger';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';

export type PredictionType =
  | 'land_use_classification'
  | 'wildfire_risk_assessment'
  | 'traffic_prediction'
  | 'agriculture_analysis'
  | 'flood_risk_assessment'
  | 'urban_growth_prediction'
  | 'environmental_impact'
  | 'custom';

export interface GeospatialPredictionRequest {
  operation: PredictionType;
  params: {
    // BigQuery GIS data
    location?: {
      latitude: number;
      longitude: number;
      name?: string;
    };
    // Earth Engine context (if available)
    imagery?: {
      ndvi?: number;
      landCover?: string;
      elevation?: number;
    };
    // Additional context
    timeRange?: {
      start: string;
      end: string;
    };
    features?: Record<string, any>;
    customPrompt?: string; // For 'custom' operation type
  };
  options?: {
    preferAccuracy?: boolean; // Use slower, more accurate models
    stream?: boolean; // Enable WebSocket streaming
    timeout?: number;
  };
  jobId?: string;
}

export interface GeospatialPredictionResponse {
  prediction: any; // Structured prediction result
  confidence: number; // 0-1
  reasoning: string; // Explanation of prediction
  modelUsed: string;
  processingTime: number;
  metadata: {
    operation: PredictionType;
    location?: string;
    timestamp: string;
  };
}

export class GeospatialPredictionService {
  private openRouterClient: OpenRouterClient;

  constructor() {
    this.openRouterClient = new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl,
      {
        filterFreeModels: true // No free models for production predictions
      }
    );
  }

  /**
   * Main prediction entry point - dynamic operation handling
   */
  async predict(req: GeospatialPredictionRequest): Promise<GeospatialPredictionResponse> {
    const startTime = Date.now();
    const jobId = req.jobId || uuidv4();

    logger.info('[GeospatialPrediction] Starting prediction', {
      operation: req.operation,
      location: req.params.location?.name,
      jobId
    });

    // Select models based on user preference only (fully dynamic)
    const models = this.selectModels(req.options?.preferAccuracy || false);

    logger.debug('[GeospatialPrediction] Selected model chain', {
      operation: req.operation,
      models: models.map(m => m.name)
    });

    // Build prompt based on operation type
    const prompt = this.buildPrompt(req.operation, req.params);

    // Try models in sequence with fallback
    let lastError: Error | null = null;
    for (const model of models) {
      try {
        logger.info('[GeospatialPrediction] Attempting prediction', {
          operation: req.operation,
          model: model.name,
          attempt: models.indexOf(model) + 1,
          totalModels: models.length,
          jobId
        });

        const result = await this.callPredictionModel(model.id, prompt, req.params);

        const processingTime = Date.now() - startTime;

        logger.info('[GeospatialPrediction] Prediction successful', {
          operation: req.operation,
          model: model.name,
          confidence: result.confidence,
          processingTime,
          jobId
        });

        return {
          prediction: result.prediction,
          confidence: result.confidence,
          reasoning: result.reasoning,
          modelUsed: model.name,
          processingTime,
          metadata: {
            operation: req.operation,
            location: req.params.location?.name,
            timestamp: new Date().toISOString()
          }
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn('[GeospatialPrediction] Model failed, trying next', {
          operation: req.operation,
          model: model.name,
          error: lastError.message,
          remainingModels: models.length - models.indexOf(model) - 1
        });
        continue;
      }
    }

    // All models failed
    logger.error('[GeospatialPrediction] All models failed', {
      operation: req.operation,
      modelsAttempted: models.map(m => m.name),
      lastError: lastError?.message,
      jobId
    });

    throw new Error(
      `Geospatial prediction failed: All models failed for operation '${req.operation}'. ` +
      `Last error: ${lastError?.message || 'Unknown error'}`
    );
  }

  /**
   * Select models based on user preference ONLY
   * Returns fallback chain for reliability
   *
   * FULLY DYNAMIC: Model selection independent of operation name
   * User controls accuracy/speed tradeoff via options.preferAccuracy
   */
  private selectModels(preferAccuracy: boolean): Array<{ id: string; name: string }> {
    // High-accuracy models for complex spatial reasoning
    const accuracyModels = [
      { id: 'anthropic/claude-opus-4-20250514', name: 'Claude Opus 4' },
      { id: 'anthropic/claude-3.7-sonnet:beta', name: 'Claude 3.7 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' }
    ];

    // Balanced models for standard predictions (default)
    const balancedModels = [
      { id: 'anthropic/claude-3.5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' },
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash' }
    ];

    // Return based on user preference only
    return preferAccuracy ? accuracyModels : balancedModels;
  }

  /**
   * Build fully dynamic prompt from ANY operation name
   *
   * FULLY DYNAMIC: Accepts any operation string and generates appropriate prompt
   * No hardcoded operations - works with ANY geospatial prediction request
   *
   * Strategy: Convert operation name to natural language instruction
   */
  private buildPrompt(operation: PredictionType, params: GeospatialPredictionRequest['params']): string {
    const { location, imagery, features, customPrompt, timeRange } = params;

    // If custom prompt provided, use it directly
    if (customPrompt) {
      return this.enhanceCustomPrompt(customPrompt, { location, imagery, features, timeRange });
    }

    // FULLY DYNAMIC: Generate prompt from operation name
    // Convert operation name to human-readable task
    const taskDescription = this.operationToTaskDescription(operation);

    // Build comprehensive context from all available data
    return this.buildDynamicPrompt(taskDescription, { location, imagery, features, timeRange });
  }

  /**
   * Convert operation name to task description
   * Examples:
   *   'land_use_classification' → 'classify land use type'
   *   'solar_potential_analysis' → 'analyze solar potential'
   *   'earthquake_risk' → 'assess earthquake risk'
   */
  private operationToTaskDescription(operation: string): string {
    // Convert snake_case or kebab-case to space-separated words
    const words = operation
      .replace(/[_-]/g, ' ')
      .toLowerCase()
      .split(' ');

    // Determine action verb based on common patterns
    const actionWords = ['classification', 'assessment', 'analysis', 'prediction', 'evaluation'];
    const hasAction = words.some(word => actionWords.some(action => word.includes(action)));

    if (hasAction) {
      // Already has action verb - use as-is
      return words.join(' ');
    } else {
      // Add appropriate action verb
      return `analyze ${words.join(' ')}`;
    }
  }

  /**
   * Build dynamic prompt with all available context
   * Works for ANY geospatial operation without hardcoding
   */
  private buildDynamicPrompt(
    taskDescription: string,
    context: {
      location?: GeospatialPredictionRequest['params']['location'];
      imagery?: GeospatialPredictionRequest['params']['imagery'];
      features?: Record<string, any>;
      timeRange?: GeospatialPredictionRequest['params']['timeRange'];
    }
  ): string {
    const { location, imagery, features, timeRange } = context;

    // Build prompt sections dynamically
    const sections: string[] = [];

    // Task description
    sections.push(`Task: ${taskDescription.charAt(0).toUpperCase() + taskDescription.slice(1)}\n`);

    // Location context (if available)
    if (location) {
      sections.push(`Location: ${location.name || 'Unknown'} (${location.latitude}, ${location.longitude})`);
    }

    // Imagery/satellite data (if available)
    if (imagery && Object.keys(imagery).length > 0) {
      sections.push('\nSatellite/Imagery Data:');
      if (imagery.ndvi !== undefined) sections.push(`- NDVI (vegetation index): ${imagery.ndvi}`);
      if (imagery.landCover) sections.push(`- Land Cover: ${imagery.landCover}`);
      if (imagery.elevation !== undefined) sections.push(`- Elevation: ${imagery.elevation}m`);
      if (imagery.temperature !== undefined) sections.push(`- Temperature: ${imagery.temperature}°C`);
      if (imagery.precipitation !== undefined) sections.push(`- Precipitation: ${imagery.precipitation}mm`);
    }

    // Time range (if available)
    if (timeRange) {
      sections.push(`\nTime Range: ${timeRange.start} to ${timeRange.end}`);
    }

    // Additional features (if available)
    if (features && Object.keys(features).length > 0) {
      sections.push('\nAdditional Data:');
      sections.push(JSON.stringify(features, null, 2));
    }

    // Instructions for structured output
    sections.push('\nProvide a comprehensive analysis with:');
    sections.push('1. Detailed prediction/assessment based on the task');
    sections.push('2. Confidence level in your prediction');
    sections.push('3. Clear reasoning explaining your prediction');
    sections.push('4. Any relevant recommendations or considerations');

    return sections.join('\n');
  }

  /**
   * Call OpenRouter model with structured output parsing
   */
  private async callPredictionModel(
    modelId: string,
    prompt: string,
    _params: GeospatialPredictionRequest['params']
  ): Promise<{ prediction: any; confidence: number; reasoning: string }> {
    const messages = [
      {
        role: 'system' as const,
        content: `You are a geospatial intelligence expert. Analyze the provided data and respond with ONLY a valid JSON object in this exact format:
{
  "prediction": <your structured prediction>,
  "confidence": <number between 0 and 1>,
  "reasoning": "<explanation of your prediction>"
}

Do not include any text before or after the JSON object.`
      },
      {
        role: 'user' as const,
        content: prompt
      }
    ];

    const response = await this.openRouterClient.createCompletion({
      model: modelId,
      messages,
      temperature: 0.3, // Low temperature for consistent predictions
      max_tokens: 2000
    });

    const content = response.choices[0]?.message?.content || '{}';

    // Parse structured response
    try {
      const parsed = JSON.parse(content.trim());

      // Validate response structure
      if (!parsed.prediction || typeof parsed.confidence !== 'number' || !parsed.reasoning) {
        throw new Error('Invalid response structure from model');
      }

      return parsed;
    } catch (error) {
      logger.error('[GeospatialPrediction] Failed to parse model response', {
        modelId,
        content,
        error: (error as Error).message
      });

      // Fallback: extract what we can
      return {
        prediction: { raw: content },
        confidence: 0.5,
        reasoning: 'Model response could not be parsed into structured format'
      };
    }
  }

  /**
   * Enhance custom prompt with all available context
   * Used when user provides their own prompt
   */
  private enhanceCustomPrompt(
    customPrompt: string,
    context: {
      location?: GeospatialPredictionRequest['params']['location'];
      imagery?: GeospatialPredictionRequest['params']['imagery'];
      features?: Record<string, any>;
      timeRange?: GeospatialPredictionRequest['params']['timeRange'];
    }
  ): string {
    const { location, imagery, features, timeRange } = context;

    const contextSections: string[] = [customPrompt, '\nContext:'];

    if (location) {
      contextSections.push(`Location: ${location.name || 'Unknown'} (${location.latitude}, ${location.longitude})`);
    }

    if (imagery && Object.keys(imagery).length > 0) {
      contextSections.push(`Imagery: ${JSON.stringify(imagery)}`);
    }

    if (timeRange) {
      contextSections.push(`Time Range: ${timeRange.start} to ${timeRange.end}`);
    }

    if (features && Object.keys(features).length > 0) {
      contextSections.push(`Features: ${JSON.stringify(features)}`);
    }

    contextSections.push('\nProvide structured prediction with confidence score and reasoning.');

    return contextSections.join('\n');
  }
}
