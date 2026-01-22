import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

/**
 * OpenRouter Dynamic Model Selector
 * Automatically discovers and selects the best available models from OpenRouter
 * based on task requirements, quality metrics, and availability
 */

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  top_provider?: {
    context_length: number;
    max_completion_tokens?: number;
    is_moderated: boolean;
  };
  per_request_limits?: {
    prompt_tokens?: string;
    completion_tokens?: string;
  };
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string | null;
  };
}

export interface ModelSelectionCriteria {
  task?: 'classification' | 'vision' | 'code' | 'general' | 'fast';
  taskType?: 'classification' | 'vision' | 'code' | 'general' | 'fast';
  minContextLength?: number;
  maxCostPerMillion?: number;
  preferredProviders?: string[];
  requiresVision?: boolean;
  userOverrideModel?: string; // User-specified model override (must be paid)
  filterFreeModels?: boolean; // Default: true - filter out all free models
}

export interface SelectedModel {
  id: string;
  name: string;
  contextLength: number;
  score: number;
  reason: string;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

export interface ModelCache {
  models: OpenRouterModel[];
  timestamp: number;
  expiresAt: number;
}

export class OpenRouterModelSelector {
  private httpClient: AxiosInstance;
  private readonly baseUrl = 'https://openrouter.ai/api/v1';
  private readonly apiKey: string;
  private modelCache: ModelCache | null = null;
  private readonly cacheTTL = 3600000; // 1 hour in milliseconds

  // Quality-ranked model patterns (used for scoring, not hardcoding)
  private readonly modelQualityPatterns = {
    classification: [
      { pattern: /claude-3\.5-sonnet/i, score: 100, reason: 'Best reasoning and classification accuracy' },
      { pattern: /claude-3-opus/i, score: 95, reason: 'Excellent classification with deep analysis' },
      { pattern: /gpt-4o/i, score: 90, reason: 'Strong general classification' },
      { pattern: /gemini-2\.0-flash-thinking/i, score: 88, reason: 'Fast with reasoning capabilities' },
      { pattern: /claude-3-sonnet/i, score: 85, reason: 'Good balance of speed and accuracy' },
      { pattern: /deepseek-chat/i, score: 80, reason: 'Cost-effective with good reasoning' },
      { pattern: /claude-sonnet-4-5/i, score: 98, reason: 'Latest Claude Sonnet 4.5 - excellent quality' },
    ],
    vision: [
      { pattern: /claude-3\.5-sonnet/i, score: 100, reason: 'Best vision understanding' },
      { pattern: /gpt-4o/i, score: 95, reason: 'Excellent vision capabilities' },
      { pattern: /claude-3-opus/i, score: 90, reason: 'Strong vision analysis' },
      { pattern: /gemini-.*-vision/i, score: 85, reason: 'Native vision support' },
    ],
    code: [
      { pattern: /deepseek-coder/i, score: 100, reason: 'Specialized for code understanding' },
      { pattern: /claude-3\.5-sonnet/i, score: 95, reason: 'Excellent code analysis' },
      { pattern: /gpt-4o/i, score: 90, reason: 'Strong code understanding' },
      { pattern: /codestral/i, score: 85, reason: 'Code-specialized model' },
    ],
    fast: [
      { pattern: /claude-sonnet-4-5/i, score: 100, reason: 'Claude Sonnet 4.5 - fast and high quality' },
      { pattern: /gemini-.*-flash/i, score: 95, reason: 'Fast Gemini variant' },
      { pattern: /gpt-4o-mini/i, score: 90, reason: 'Fast GPT-4 variant' },
      { pattern: /llama-3\.1-8b/i, score: 85, reason: 'Lightweight and fast' },
    ],
    general: [
      { pattern: /claude-3\.5-sonnet/i, score: 100, reason: 'Best general-purpose model' },
      { pattern: /gpt-4o/i, score: 95, reason: 'Strong general capabilities' },
      { pattern: /claude-3-opus/i, score: 90, reason: 'Deep analysis capabilities' },
      { pattern: /gemini-2\.0/i, score: 85, reason: 'Latest Gemini with strong performance' },
    ],
  };

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('OpenRouter API key is required for dynamic model selection');
    }

    this.apiKey = apiKey;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://graphrag.local',
        'X-Title': 'GraphRAG Dynamic Model Selector'
      }
    });

    this.httpClient.interceptors.response.use(
      response => response,
      error => {
        const errorDetails = {
          message: error.message,
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          url: error.config?.url,
          method: error.config?.method
        };

        logger.error('OpenRouter API error during model selection', { error: errorDetails });

        throw new Error(
          `OpenRouter API error: ${error.message}. ` +
          `Status: ${error.response?.status || 'N/A'}. ` +
          `Details: ${JSON.stringify(error.response?.data || 'No additional details')}. ` +
          `This error occurred while attempting to discover available models for dynamic selection.`
        );
      }
    );

    logger.info('OpenRouter Dynamic Model Selector initialized');
  }

  /**
   * Fetch all available models from OpenRouter API
   */
  async fetchModels(forceRefresh = false): Promise<OpenRouterModel[]> {
    try {
      // Check cache
      if (!forceRefresh && this.modelCache && Date.now() < this.modelCache.expiresAt) {
        logger.debug('Using cached OpenRouter models', {
          modelCount: this.modelCache.models.length,
          cacheAge: Math.floor((Date.now() - this.modelCache.timestamp) / 1000),
          expiresIn: Math.floor((this.modelCache.expiresAt - Date.now()) / 1000)
        });
        return this.modelCache.models;
      }

      const startTime = Date.now();
      logger.info('Fetching available models from OpenRouter API');

      const response = await this.httpClient.get('/models');

      if (!response.data?.data || !Array.isArray(response.data.data)) {
        throw new Error(
          'Invalid response format from OpenRouter models API. ' +
          'Expected { data: Model[] } but received: ' +
          JSON.stringify(response.data)
        );
      }

      const models = response.data.data as OpenRouterModel[];
      const latency = Date.now() - startTime;

      // Update cache
      this.modelCache = {
        models,
        timestamp: Date.now(),
        expiresAt: Date.now() + this.cacheTTL
      };

      logger.info('Successfully fetched OpenRouter models', {
        modelCount: models.length,
        latency,
        cacheExpiry: new Date(this.modelCache.expiresAt).toISOString()
      });

      return models;
    } catch (error) {
      logger.error('Failed to fetch models from OpenRouter', { error });

      // If we have stale cache, use it as fallback
      if (this.modelCache) {
        logger.warn('Using stale model cache as fallback', {
          cacheAge: Math.floor((Date.now() - this.modelCache.timestamp) / 1000)
        });
        return this.modelCache.models;
      }

      throw new Error(
        `Failed to fetch available models from OpenRouter: ${error}. ` +
        `No cached models available for fallback. ` +
        `This is a critical error as the system cannot proceed without model discovery.`
      );
    }
  }

  /**
   * Check if a model is a free model that should be filtered out
   */
  private isFreeModel(model: OpenRouterModel): boolean {
    // Check if model ID contains ':free' suffix
    if (model.id.includes(':free')) {
      return true;
    }

    // Check if pricing is exactly zero for both prompt and completion
    const promptCost = parseFloat(model.pricing.prompt);
    const completionCost = parseFloat(model.pricing.completion);

    if (promptCost === 0 && completionCost === 0) {
      return true;
    }

    // Additional checks for known free model patterns
    const freePatterns = [
      /free$/i,
      /\bfree\b/i,
      /-free-/i,
    ];

    return freePatterns.some(pattern => pattern.test(model.id));
  }

  /**
   * Select the best model based on criteria with multi-factor scoring
   */
  async selectBestModel(criteria: ModelSelectionCriteria): Promise<SelectedModel> {
    try {
      // Handle user override model first
      if (criteria.userOverrideModel) {
        const models = await this.fetchModels();
        const overrideModel = models.find(m => m.id === criteria.userOverrideModel);

        if (!overrideModel) {
          logger.warn('User override model not found, falling back to automatic selection', {
            requestedModel: criteria.userOverrideModel
          });
        } else if (this.isFreeModel(overrideModel)) {
          throw new Error(
            `User override model '${criteria.userOverrideModel}' is a free model. ` +
            `Free models are not allowed. Please select a paid model.`
          );
        } else {
          logger.info('Using user override model', {
            modelId: overrideModel.id,
            modelName: overrideModel.name
          });
          return {
            id: overrideModel.id,
            name: overrideModel.name || overrideModel.id,
            contextLength: overrideModel.context_length,
            score: 100,
            reason: 'User-selected model override',
            pricing: overrideModel.pricing
          };
        }
      }

      const models = await this.fetchModels();

      if (models.length === 0) {
        throw new Error(
          'No models available from OpenRouter. ' +
          'Cannot proceed with model selection. ' +
          'Verify OpenRouter API key and service availability.'
        );
      }

      logger.debug('Selecting best model', {
        criteria,
        availableModels: models.length
      });

      // Filter out free models by default (unless explicitly disabled)
      const filterFreeModels = criteria.filterFreeModels !== false; // Default: true
      let candidates = models.filter(model => {
        // CRITICAL: Filter out all free models unless explicitly disabled
        if (filterFreeModels && this.isFreeModel(model)) {
          return false;
        }

        // Context length requirement
        if (criteria.minContextLength && model.context_length < criteria.minContextLength) {
          return false;
        }

        // Vision requirement
        if (criteria.requiresVision) {
          const hasVision = model.architecture?.modality?.includes('image') ||
                           model.architecture?.modality?.includes('multimodal') ||
                           model.id.includes('vision') ||
                           model.id.includes('gpt-4o') ||
                           model.id.includes('claude-3');
          if (!hasVision) return false;
        }

        // Cost requirement (if specified)
        if (criteria.maxCostPerMillion) {
          const promptCost = parseFloat(model.pricing.prompt) * 1000000;
          if (promptCost > criteria.maxCostPerMillion) {
            return false;
          }
        }

        return true;
      });

      if (candidates.length === 0) {
        throw new Error(
          `No models match the selection criteria: ${JSON.stringify(criteria)}. ` +
          `Available models: ${models.length}. ` +
          `Consider relaxing constraints or verifying criteria validity.`
        );
      }

      // Score each candidate
      const scoredModels = candidates.map(model => {
        const score = this.scoreModel(model, criteria);
        return {
          model,
          score: score.totalScore,
          reason: score.reason
        };
      });

      // Sort by score (descending)
      scoredModels.sort((a, b) => b.score - a.score);

      const best = scoredModels[0];
      const selected: SelectedModel = {
        id: best.model.id,
        name: best.model.name || best.model.id,
        contextLength: best.model.context_length,
        score: best.score,
        reason: best.reason,
        pricing: best.model.pricing
      };

      logger.info('Selected best model', {
        ...selected,
        criteria,
        alternativesConsidered: Math.min(scoredModels.length - 1, 5)
      });

      return selected;
    } catch (error) {
      logger.error('Failed to select best model', { error, criteria });
      throw error;
    }
  }

  /**
   * Select multiple models for fallback chains
   */
  async selectModelChain(criteria: ModelSelectionCriteria, count = 3): Promise<SelectedModel[]> {
    try {
      const models = await this.fetchModels();

      if (models.length === 0) {
        throw new Error('No models available from OpenRouter for chain selection');
      }

      logger.debug('Selecting model chain', {
        criteria,
        requestedCount: count,
        availableModels: models.length
      });

      // Filter out free models by default
      const filterFreeModels = criteria.filterFreeModels !== false; // Default: true

      // Filter and score all candidates
      const candidates = models.filter(model => {
        // CRITICAL: Filter out all free models unless explicitly disabled
        if (filterFreeModels && this.isFreeModel(model)) {
          return false;
        }

        if (criteria.minContextLength && model.context_length < criteria.minContextLength) {
          return false;
        }
        if (criteria.requiresVision) {
          const hasVision = model.architecture?.modality?.includes('image') ||
                           model.architecture?.modality?.includes('multimodal') ||
                           model.id.includes('vision') ||
                           model.id.includes('gpt-4o') ||
                           model.id.includes('claude-3');
          if (!hasVision) return false;
        }
        return true;
      });

      if (candidates.length === 0) {
        throw new Error(`No models match criteria for chain selection: ${JSON.stringify(criteria)}`);
      }

      const scoredModels = candidates.map(model => {
        const score = this.scoreModel(model, criteria);
        return {
          id: model.id,
          name: model.name || model.id,
          contextLength: model.context_length,
          score: score.totalScore,
          reason: score.reason,
          pricing: model.pricing
        };
      });

      // Sort by score and take top N
      scoredModels.sort((a, b) => b.score - a.score);
      const chain = scoredModels.slice(0, Math.min(count, scoredModels.length));

      logger.info('Selected model chain', {
        criteria,
        chainLength: chain.length,
        models: chain.map(m => ({ id: m.id, score: m.score }))
      });

      return chain;
    } catch (error) {
      logger.error('Failed to select model chain', { error, criteria });
      throw error;
    }
  }

  /**
   * Multi-factor scoring algorithm for model quality
   */
  private scoreModel(model: OpenRouterModel, criteria: ModelSelectionCriteria): { totalScore: number; reason: string } {
    let totalScore = 0;
    const reasons: string[] = [];

    // Normalize taskType to task for backward compatibility
    const task = criteria.task || criteria.taskType || 'general';

    // Pattern matching score (primary)
    const patterns = this.modelQualityPatterns[task] || this.modelQualityPatterns.general;
    let patternScore = 0;
    let patternReason = '';

    for (const { pattern, score, reason } of patterns) {
      if (pattern.test(model.id) || pattern.test(model.name || '')) {
        patternScore = score;
        patternReason = reason;
        break;
      }
    }

    if (patternScore > 0) {
      totalScore += patternScore;
      reasons.push(patternReason);
    } else {
      // No pattern match - assign baseline score
      totalScore += 50;
      reasons.push('Generic model without specific optimization');
    }

    // Context length score (bonus for larger contexts)
    if (model.context_length >= 128000) {
      totalScore += 10;
      reasons.push('Large context window (128k+)');
    } else if (model.context_length >= 32000) {
      totalScore += 5;
      reasons.push('Medium context window (32k+)');
    }

    // Cost efficiency score (lower cost = bonus)
    const promptCostPerMillion = parseFloat(model.pricing.prompt) * 1000000;
    if (promptCostPerMillion < 1.0) {
      totalScore += 10;
      reasons.push('Cost-efficient');
    } else if (promptCostPerMillion < 5.0) {
      totalScore += 5;
      reasons.push('Moderate cost');
    }

    // Provider preference (if specified)
    if (criteria.preferredProviders && criteria.preferredProviders.length > 0) {
      const hasPreferredProvider = criteria.preferredProviders.some(provider =>
        model.id.toLowerCase().includes(provider.toLowerCase())
      );
      if (hasPreferredProvider) {
        totalScore += 5;
        reasons.push('Preferred provider');
      }
    }

    return {
      totalScore,
      reason: reasons.join('; ')
    };
  }

  /**
   * Get cache status
   */
  getCacheStatus(): { isCached: boolean; age?: number; expiresIn?: number; modelCount?: number } {
    if (!this.modelCache) {
      return { isCached: false };
    }

    return {
      isCached: true,
      age: Math.floor((Date.now() - this.modelCache.timestamp) / 1000),
      expiresIn: Math.floor((this.modelCache.expiresAt - Date.now()) / 1000),
      modelCount: this.modelCache.models.length
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.modelCache = null;
    logger.info('Model cache cleared');
  }
}
