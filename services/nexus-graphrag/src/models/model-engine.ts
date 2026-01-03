/**
 * Model Selection Engine
 * Provides intelligent model selection with user override capability
 * CRITICAL: Never uses free models - all models must be paid
 */

import { OpenRouterModelSelector, ModelSelectionCriteria, SelectedModel } from '../clients/openrouter-model-selector';
import { logger } from '../utils/logger';
import { config } from '../config';

export type TaskType =
  | 'classification'
  | 'generation'
  | 'code_analysis'
  | 'code_generation'
  | 'embedding'
  | 'reranking'
  | 'vision'
  | 'document_analysis'
  | 'creative_writing'
  | 'medical_research'
  | 'legal_analysis';

export type DomainType =
  | 'creative_writing'
  | 'code'
  | 'medical'
  | 'legal'
  | 'conversation'
  | 'general';

export interface ModelRequest {
  task: TaskType;
  domain?: DomainType;
  contextSize?: number;
  requiresVision?: boolean;
  userOverride?: string; // User-specified model (must be paid)
  maxCostPerMillion?: number;
  preferredProviders?: string[];
}

export interface ModelRecommendation {
  model: SelectedModel;
  alternative?: SelectedModel;
  reasoning: string;
}

export class ModelSelectionEngine {
  private openRouterSelector: OpenRouterModelSelector | null = null;
  private initialized = false;

  constructor() {
    if (config.openRouter.apiKey) {
      this.openRouterSelector = new OpenRouterModelSelector(config.openRouter.apiKey);
      this.initialized = true;
      logger.info('Model Selection Engine initialized with OpenRouter');
    } else {
      logger.warn('Model Selection Engine initialized without OpenRouter - limited functionality');
    }
  }

  /**
   * Get model recommendation for a given task and domain
   */
  async recommend(request: ModelRequest): Promise<ModelRecommendation> {
    if (!this.initialized || !this.openRouterSelector) {
      throw new Error(
        'Model Selection Engine not properly initialized. ' +
        'OPENROUTER_API_KEY is required for dynamic model selection.'
      );
    }

    try {
      logger.info('Recommending model', {
        task: request.task,
        domain: request.domain,
        userOverride: request.userOverride
      });

      // Map task and domain to selection criteria
      const criteria = this.buildCriteria(request);

      // Get primary model
      const primaryModel = await this.openRouterSelector.selectBestModel(criteria);

      // Get alternative model (for fallback)
      let alternative: SelectedModel | undefined;
      try {
        const alternativeCriteria = { ...criteria, userOverrideModel: undefined };
        const chain = await this.openRouterSelector.selectModelChain(alternativeCriteria, 2);
        alternative = chain[1]; // Second best model
      } catch (error) {
        logger.warn('Could not select alternative model', { error });
      }

      const reasoning = this.explainRecommendation(request, primaryModel, alternative);

      return {
        model: primaryModel,
        alternative,
        reasoning
      };
    } catch (error) {
      logger.error('Failed to recommend model', { error, request });
      throw new Error(
        `Model recommendation failed: ${error}. ` +
        `Task: ${request.task}, Domain: ${request.domain || 'general'}`
      );
    }
  }

  /**
   * Build selection criteria from request
   */
  private buildCriteria(request: ModelRequest): ModelSelectionCriteria {
    const criteria: ModelSelectionCriteria = {
      task: this.mapTaskToOpenRouterTask(request.task),
      minContextLength: request.contextSize,
      maxCostPerMillion: request.maxCostPerMillion,
      preferredProviders: request.preferredProviders,
      requiresVision: request.requiresVision,
      userOverrideModel: request.userOverride,
      filterFreeModels: config.openRouter.filterFreeModels, // CRITICAL: Always filter free models
    };

    // Domain-specific adjustments
    switch (request.domain) {
      case 'creative_writing':
        criteria.minContextLength = criteria.minContextLength || 128000;
        break;
      case 'code':
        criteria.task = 'code';
        criteria.minContextLength = criteria.minContextLength || 32000;
        break;
      case 'medical':
      case 'legal':
        criteria.minContextLength = criteria.minContextLength || 128000;
        criteria.task = 'general'; // Use general high-quality models
        break;
    }

    return criteria;
  }

  /**
   * Map our task types to OpenRouter task categories
   */
  private mapTaskToOpenRouterTask(task: TaskType): ModelSelectionCriteria['task'] {
    switch (task) {
      case 'classification':
      case 'document_analysis':
        return 'classification';
      case 'code_analysis':
      case 'code_generation':
        return 'code';
      case 'vision':
        return 'vision';
      case 'generation':
      case 'creative_writing':
      case 'medical_research':
      case 'legal_analysis':
        return 'general';
      default:
        return 'general';
    }
  }

  /**
   * Generate human-readable explanation for recommendation
   */
  private explainRecommendation(
    request: ModelRequest,
    primary: SelectedModel,
    alternative?: SelectedModel
  ): string {
    const parts: string[] = [];

    if (request.userOverride) {
      parts.push(`Using your selected model: ${primary.name}`);
    } else {
      parts.push(`Selected ${primary.name} for ${request.task}`);
      parts.push(`Reason: ${primary.reason}`);
    }

    if (request.domain) {
      parts.push(`Optimized for ${request.domain} domain`);
    }

    parts.push(`Context window: ${primary.contextLength.toLocaleString()} tokens`);

    if (alternative) {
      parts.push(`Fallback: ${alternative.name}`);
    }

    parts.push('✓ All free models filtered out - using paid models only');

    return parts.join('. ');
  }

  /**
   * Get model recommendation specifically for embedding tasks
   */
  async recommendEmbeddingModel(): Promise<{ provider: 'voyage' | 'openrouter'; model: string; reason: string }> {
    // Always prefer Voyage AI for embeddings if available
    if (config.voyageAI.apiKey) {
      return {
        provider: 'voyage',
        model: config.voyageAI.model,
        reason: 'Voyage AI provides specialized high-quality embeddings optimized for semantic search'
      };
    }

    // Fallback to OpenRouter embedding models (if available)
    if (this.initialized && this.openRouterSelector) {
      logger.warn('Voyage AI not available, falling back to OpenRouter for embeddings');
      const models = await this.openRouterSelector.fetchModels();
      const embeddingModels = models.filter(m =>
        m.id.includes('embed') &&
        parseFloat(m.pricing.prompt) > 0 // Must be paid
      );

      if (embeddingModels.length > 0) {
        return {
          provider: 'openrouter',
          model: embeddingModels[0].id,
          reason: 'Using OpenRouter embedding model (Voyage AI not configured)'
        };
      }
    }

    throw new Error(
      'No embedding providers available. ' +
      'Please configure VOYAGE_API_KEY or OPENROUTER_API_KEY with embedding model access.'
    );
  }

  /**
   * Check if a specific model is available and paid
   */
  async validateModel(modelId: string): Promise<{ valid: boolean; reason: string }> {
    if (!this.initialized || !this.openRouterSelector) {
      return {
        valid: false,
        reason: 'Model Selection Engine not initialized'
      };
    }

    try {
      const models = await this.openRouterSelector.fetchModels();
      const model = models.find(m => m.id === modelId);

      if (!model) {
        return {
          valid: false,
          reason: `Model '${modelId}' not found in OpenRouter catalog`
        };
      }

      // Check if it's a free model
      if (model.id.includes(':free') ||
          (parseFloat(model.pricing.prompt) === 0 && parseFloat(model.pricing.completion) === 0)) {
        return {
          valid: false,
          reason: `Model '${modelId}' is a free model. Free models are not allowed.`
        };
      }

      return {
        valid: true,
        reason: `Model '${modelId}' is valid and paid`
      };
    } catch (error) {
      logger.error('Failed to validate model', { error, modelId });
      return {
        valid: false,
        reason: `Validation failed: ${error}`
      };
    }
  }

  /**
   * Get list of all available paid models
   */
  async listAvailablePaidModels(): Promise<Array<{ id: string; name: string; contextLength: number }>> {
    if (!this.initialized || !this.openRouterSelector) {
      return [];
    }

    try {
      const models = await this.openRouterSelector.fetchModels();
      return models
        .filter(m => {
          // Filter out free models
          if (m.id.includes(':free')) return false;
          const promptCost = parseFloat(m.pricing.prompt);
          const completionCost = parseFloat(m.pricing.completion);
          return promptCost > 0 || completionCost > 0;
        })
        .map(m => ({
          id: m.id,
          name: m.name || m.id,
          contextLength: m.context_length
        }))
        .sort((a, b) => b.contextLength - a.contextLength); // Sort by context length desc
    } catch (error) {
      logger.error('Failed to list available models', { error });
      return [];
    }
  }

  /**
   * Check if engine is properly initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
let modelEngineInstance: ModelSelectionEngine | null = null;

export function getModelEngine(): ModelSelectionEngine {
  if (!modelEngineInstance) {
    modelEngineInstance = new ModelSelectionEngine();
  }
  return modelEngineInstance;
}
