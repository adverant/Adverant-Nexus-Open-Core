import { OpenRouterClient, OpenRouterModel } from '../clients/openrouter-client';
import { logger } from './logger';
import { AgentRole } from '../agents/base-agent';

export interface ModelCapabilities {
  coding: boolean;
  analysis: boolean;
  creative: boolean;
  factual: boolean;
  multimodal: boolean;
  vision: boolean; // NEW: Vision capability for OCR/image understanding
  functionCalling: boolean;
  contextLength: number;
  costPerMillion: number;
  speed: 'fast' | 'medium' | 'slow';
  quality: 'high' | 'medium' | 'low';
}

export interface ModelSelectionCriteria {
  role?: AgentRole; // Made optional for direct task-based selection
  taskComplexity?: 'simple' | 'medium' | 'complex' | 'extreme';
  taskType?: 'ocr' | 'vision' | 'code' | 'analysis' | 'creative'; // NEW: Task-based selection
  requiredCapabilities?: Partial<ModelCapabilities>;
  preferHighAccuracy?: boolean; // NEW: For OCR tasks
  excludeFreeModels?: boolean; // NEW: Exclude unreliable free models
  capabilities?: string[]; // NEW: Array of required capabilities ['vision', 'multimodal']
  maxCost?: number;
  minContextLength?: number;
  preferredProviders?: string[];
  avoidModels?: string[];
}

export class ModelSelector {
  private modelCache: Map<string, OpenRouterModel> = new Map();
  private modelCapabilities: Map<string, ModelCapabilities> = new Map();
  private workingModels: Set<string> = new Set();
  private failedModels: Set<string> = new Set();
  private lastRefresh: number = 0;
  private readonly CACHE_TTL = 300000; // 5 minutes
  private readonly FALLBACK_CHAINS: Record<string, string[]> = {
    // Primary model -> fallback options in order of preference
    'anthropic/claude-opus-4.1': [
      'anthropic/claude-opus-4.6',
      'anthropic/claude-3-opus-20240229',
      'anthropic/claude-opus-4.6',
      'openai/gpt-4-turbo',
      'google/gemini-pro-1.5'
    ],
    'openai/gpt-5-codex': [
      'openai/gpt-4-turbo',
      'openai/gpt-4',
      'anthropic/claude-opus-4.6',
      'deepseek/deepseek-coder',
      'google/gemini-pro-1.5'
    ],
    'google/gemini-2.5-flash-preview-09-2025': [
      'google/gemini-pro-1.5',
      'google/gemini-pro',
      'anthropic/claude-3-haiku',
      'openai/gpt-3.5-turbo'
    ]
  };

  constructor(private openRouterClient: OpenRouterClient) {
    this.initializeModelCapabilities();
  }

  private initializeModelCapabilities(): void {
    // Initialize known model capabilities
    // This would ideally be loaded from a configuration file
    const capabilities: Array<[string, Partial<ModelCapabilities>]> = [
      // Anthropic models - Claude 3+ have vision
      ['anthropic/claude-3', { coding: true, analysis: true, creative: true, vision: true, multimodal: true, quality: 'high', speed: 'medium' }],
      ['anthropic/claude-opus', { coding: true, analysis: true, creative: true, vision: true, multimodal: true, quality: 'high', speed: 'slow' }],
      ['anthropic/claude-opus-4.6', { coding: true, analysis: true, creative: true, vision: true, multimodal: true, quality: 'high', speed: 'medium' }],
      ['anthropic/claude', { coding: true, analysis: true, creative: true, quality: 'high', speed: 'medium' }],

      // OpenAI vision models
      ['openai/gpt-4-turbo', { coding: true, analysis: true, vision: true, multimodal: true, functionCalling: true, quality: 'high', speed: 'medium' }],
      ['openai/gpt-4o', { coding: true, analysis: true, vision: true, multimodal: true, functionCalling: true, quality: 'high', speed: 'fast' }],
      ['openai/gpt-4-vision', { analysis: true, vision: true, multimodal: true, quality: 'high', speed: 'medium' }],
      ['openai/gpt-4', { coding: true, analysis: true, functionCalling: true, quality: 'high', speed: 'medium' }],
      ['openai/gpt-3.5', { coding: true, analysis: true, functionCalling: true, quality: 'medium', speed: 'fast' }],

      // Google Gemini - all have vision
      ['google/gemini-pro-1.5', { analysis: true, factual: true, vision: true, multimodal: true, quality: 'high', speed: 'fast' }],
      ['google/gemini-flash', { analysis: true, factual: true, vision: true, multimodal: true, quality: 'medium', speed: 'fast' }],
      ['google/gemini', { analysis: true, factual: true, vision: true, multimodal: true, quality: 'high', speed: 'fast' }],

      // Other models (no vision)
      ['deepseek/deepseek-coder', { coding: true, quality: 'high', speed: 'fast' }],
      ['meta/llama', { analysis: true, creative: true, quality: 'medium', speed: 'fast' }],
      ['mistral', { coding: true, analysis: true, quality: 'medium', speed: 'fast' }]
    ];

    capabilities.forEach(([pattern, caps]) => {
      this.modelCapabilities.set(pattern, {
        coding: false,
        analysis: false,
        creative: false,
        factual: false,
        multimodal: false,
        vision: false, // Default: no vision
        functionCalling: false,
        contextLength: 8000,
        costPerMillion: 1.0,
        speed: 'medium',
        quality: 'medium',
        ...caps
      } as ModelCapabilities);
    });
  }

  async selectModel(criteria: ModelSelectionCriteria): Promise<string> {
    try {
      // Refresh model list if cache expired
      await this.refreshModelCacheIfNeeded();

      // Get all available models
      const availableModels = Array.from(this.modelCache.values());

      if (availableModels.length === 0) {
        throw new Error(
          'CRITICAL: No models available from OpenRouter\n' +
          'This indicates a complete API failure or invalid API key\n' +
          'Cannot proceed with orchestration'
        );
      }

      // Filter and score models based on criteria
      const scoredModels = availableModels
        .filter(model => this.meetsCriteria(model, criteria))
        .map(model => ({
          model,
          score: this.scoreModel(model, criteria)
        }))
        .sort((a, b) => b.score - a.score);

      if (scoredModels.length === 0) {
        logger.warn('No models meet criteria, relaxing requirements', { criteria });
        // Fallback: just get any working model
        return this.getAnyWorkingModel(criteria.role);
      }

      // Try models in order until we find one that works
      for (const { model } of scoredModels.slice(0, 5)) {
        if (!this.failedModels.has(model.id)) {
          logger.info('Selected model for task', {
            modelId: model.id,
            role: criteria.role,
            score: scoredModels[0].score,
            alternatives: scoredModels.slice(1, 3).map(s => s.model.id)
          });

          return model.id;
        }
      }

      // All preferred models have failed, try fallback chain
      return this.selectFromFallbackChain(scoredModels[0]?.model.id, criteria.role);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Model selection failed', { error: errorMessage, criteria });

      // Last resort: return a hardcoded fallback
      const lastResort = this.getLastResortModel(criteria.role);
      logger.warn('Using last resort model', { model: lastResort, role: criteria.role });
      return lastResort;
    }
  }

  /**
   * Select N diverse models for competitive multi-agent orchestration
   *
   * Unlike selectModel() which picks the BEST model, this method picks N DIFFERENT models
   * to ensure diverse perspectives in multi-agent competition (DocMage style).
   *
   * Strategy:
   * 1. Get pool of models meeting criteria
   * 2. Diversify by provider (anthropic, openai, google, meta, etc.)
   * 3. Diversify by model family within providers
   * 4. Balance cost vs quality across selections
   *
   * @param count - Number of diverse models to select
   * @param criteria - Base criteria all models must meet
   * @returns Array of diverse model IDs
   */
  async selectDiverseModels(
    count: number,
    criteria: ModelSelectionCriteria
  ): Promise<string[]> {
    try {
      await this.refreshModelCacheIfNeeded();

      const availableModels = Array.from(this.modelCache.values());

      if (availableModels.length === 0) {
        throw new Error('No models available from OpenRouter');
      }

      // Filter models that meet criteria
      const eligibleModels = availableModels
        .filter(model => this.meetsCriteria(model, criteria))
        .filter(model => !this.failedModels.has(model.id))
        .map(model => ({
          model,
          score: this.scoreModel(model, criteria),
          provider: model.id.split('/')[0],
          family: this.getModelFamily(model.id)
        }))
        .sort((a, b) => b.score - a.score);

      if (eligibleModels.length === 0) {
        logger.warn('No models meet criteria for diverse selection, using fallbacks');
        return this.getFallbackDiverseModels(count, criteria.role);
      }

      // Strategy: Maximize provider and family diversity
      const selected: string[] = [];
      const usedProviders = new Set<string>();
      const usedFamilies = new Set<string>();

      // LAYER 2: JIT Validation - Test models before assigning to agents
      // This prevents selecting broken models that pass static criteria but fail at runtime
      const validatedModels: typeof eligibleModels = [];

      logger.info('Running JIT validation on candidate models', { candidates: eligibleModels.length });

      // Validate models in parallel (max 10 at a time)
      const validationBatchSize = 10;
      for (let i = 0; i < eligibleModels.length; i += validationBatchSize) {
        const batch = eligibleModels.slice(i, i + validationBatchSize);
        const validationResults = await Promise.allSettled(
          batch.map(async ({ model, ...rest }) => {
            const isHealthy = await this.testModelHealth(model.id);
            return { model, ...rest, isHealthy };
          })
        );

        // Collect models that passed validation
        for (const result of validationResults) {
          if (result.status === 'fulfilled' && result.value.isHealthy) {
            validatedModels.push(result.value);
          }
        }

        // Stop early if we have enough validated models
        if (validatedModels.length >= count * 2) break; // 2x buffer for diversity selection
      }

      logger.info('JIT validation completed', {
        validated: validatedModels.length,
        requested: count,
        filtered: eligibleModels.length - validatedModels.length
      });

      // If no models passed validation, fall back to fallback diverse models
      if (validatedModels.length === 0) {
        logger.warn('No models passed JIT validation, using fallbacks');
        return this.getFallbackDiverseModels(count, criteria.role);
      }

      // First pass: One model per provider (maximum diversity)
      for (const { model, provider, family } of validatedModels) {
        if (selected.length >= count) break;

        if (!usedProviders.has(provider)) {
          selected.push(model.id);
          usedProviders.add(provider);
          usedFamilies.add(family);
        }
      }

      // Second pass: Different families from same providers
      if (selected.length < count) {
        for (const { model, family } of validatedModels) {
          if (selected.length >= count) break;

          if (!selected.includes(model.id) && !usedFamilies.has(family)) {
            selected.push(model.id);
            usedFamilies.add(family);
          }
        }
      }

      // Third pass: Fill remaining slots with highest-scoring unused models
      if (selected.length < count) {
        for (const { model } of validatedModels) {
          if (selected.length >= count) break;

          if (!selected.includes(model.id)) {
            selected.push(model.id);
          }
        }
      }

      logger.info('Selected diverse models for competition', {
        count: selected.length,
        requested: count,
        providers: [...new Set(selected.map(m => m.split('/')[0]))],
        models: selected
      });

      return selected;
    } catch (error) {
      logger.error('Diverse model selection failed', { error, count, criteria });
      return this.getFallbackDiverseModels(count, criteria.role);
    }
  }

  /**
   * Extract model family (e.g., "gpt-4", "claude-3", "gemini-pro")
   */
  private getModelFamily(modelId: string): string {
    const parts = modelId.split('/');
    if (parts.length < 2) return modelId;

    const modelName = parts[1];
    // Extract family from model name (e.g., "claude-opus-4-6-20260206" -> "claude-3")
    const familyMatch = modelName.match(/^([a-z]+-\d+)/i);
    return familyMatch ? familyMatch[1] : modelName.split('-')[0];
  }

  /**
   * Get fallback diverse models when selection fails
   */
  private getFallbackDiverseModels(count: number, role: AgentRole): string[] {
    const fallbackSets: Record<string, string[]> = {
      [AgentRole.RESEARCH]: [
        'anthropic/claude-opus-4.6',
        'openai/gpt-4.1',
        'google/gemini-pro-1.5',
        'meta-llama/llama-3.1-70b-instruct',
        'mistralai/mistral-large',
        'anthropic/claude-opus-4.6',
        'openai/gpt-4-turbo',
        'cohere/command-r-plus'
      ],
      [AgentRole.CODING]: [
        'openai/gpt-4.1',
        'anthropic/claude-opus-4.6',
        'deepseek/deepseek-coder',
        'meta-llama/llama-3.1-70b-instruct',
        'google/gemini-pro-1.5',
        'mistralai/codestral'
      ],
      [AgentRole.SPECIALIST]: [
        'anthropic/claude-opus-4.6',
        'openai/gpt-4.1',
        'google/gemini-pro-1.5',
        'anthropic/claude-opus-4.6',
        'openai/gpt-4-turbo',
        'meta-llama/llama-3.1-70b-instruct',
        'mistralai/mistral-large',
        'cohere/command-r-plus',
        'perplexity/llama-3.1-sonar-large',
        'x-ai/grok-beta'
      ],
      [AgentRole.REVIEW]: [
        'openai/gpt-4.1',
        'anthropic/claude-opus-4.6',
        'google/gemini-pro-1.5',
        'anthropic/claude-opus-4.6',
        'mistralai/mistral-large'
      ],
      [AgentRole.SYNTHESIS]: [
        'anthropic/claude-opus-4.6',
        'openai/gpt-4.1',
        'anthropic/claude-opus-4.6',
        'google/gemini-pro-1.5',
        'mistralai/mistral-large'
      ]
    };

    const fallbacks = fallbackSets[role] || fallbackSets[AgentRole.RESEARCH];
    return fallbacks.slice(0, Math.max(count, fallbacks.length));
  }

  private async refreshModelCacheIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh > this.CACHE_TTL || this.modelCache.size === 0) {
      try {
        const models = await this.openRouterClient.listAvailableModels();

        this.modelCache.clear();
        models.forEach(model => {
          this.modelCache.set(model.id, model);
        });

        this.lastRefresh = now;
        logger.info('Model cache refreshed', {
          modelCount: models.length,
          providers: [...new Set(models.map(m => m.id.split('/')[0]))]
        });
      } catch (error) {
        logger.error('Failed to refresh model cache', { error });
        if (this.modelCache.size === 0) {
          throw new Error('Cannot refresh model cache and no cached models available');
        }
      }
    }
  }

  private meetsCriteria(model: OpenRouterModel, criteria: ModelSelectionCriteria): boolean {
    // Check if free models should be excluded (default for vision tasks)
    if (criteria.excludeFreeModels) {
      if (model.id.includes(':free') || model.pricing.prompt === 0) {
        return false;
      }
    } else {
      // NEVER use free models by default - they're unreliable
      if (model.id.includes(':free') || model.pricing.prompt === 0) {
        return false;
      }
    }

    // NEW: Check for vision capability if required
    if (criteria.taskType === 'ocr' || criteria.taskType === 'vision' ||
        criteria.capabilities?.includes('vision')) {
      const hasVision = this.hasVisionCapability(model);
      if (!hasVision) {
        return false;
      }
    }

    // Check context length
    if (criteria.minContextLength && model.context_length < criteria.minContextLength) {
      return false;
    }

    // Check cost
    if (criteria.maxCost) {
      const estimatedCost = (model.pricing.prompt + model.pricing.completion) / 2000000;
      if (estimatedCost > criteria.maxCost) {
        return false;
      }
    }

    // Check provider preference
    if (criteria.preferredProviders && criteria.preferredProviders.length > 0) {
      const provider = model.id.split('/')[0];
      if (!criteria.preferredProviders.includes(provider)) {
        return false; // Soft fail - will be deprioritized in scoring instead
      }
    }

    // Check avoided models
    if (criteria.avoidModels && criteria.avoidModels.includes(model.id)) {
      return false;
    }

    // Check if model has been failing
    if (this.failedModels.has(model.id)) {
      return false;
    }

    return true;
  }

  /**
   * Check if a model has vision capability based on OpenRouter metadata and known patterns
   */
  private hasVisionCapability(model: OpenRouterModel): boolean {
    const modelLower = model.id.toLowerCase();

    // Check OpenRouter's architecture metadata
    if (model.architecture?.modality?.includes('multimodal') ||
        model.architecture?.modality?.includes('vision')) {
      return true;
    }

    // Check known vision-capable model patterns
    const visionPatterns = [
      'vision',
      'gpt-4-turbo',
      'gpt-4o',
      'claude-3',        // All Claude 3 models have vision
      'claude-opus',
      'claude-opus',
      'gemini'           // All Gemini models have vision
    ];

    return visionPatterns.some(pattern => modelLower.includes(pattern));
  }

  private scoreModel(model: OpenRouterModel, criteria: ModelSelectionCriteria): number {
    let score = 100;
    const modelLower = model.id.toLowerCase();

    // NEW: Score based on task type (prioritize over role for task-based selection)
    if (criteria.taskType) {
      switch (criteria.taskType) {
        case 'ocr':
        case 'vision':
          // Prefer models known for strong vision capabilities
          if (modelLower.includes('claude-3-opus') || modelLower.includes('claude-opus-4')) score += 60; // Best OCR accuracy
          if (modelLower.includes('gpt-4o')) score += 55; // Fast and accurate
          if (modelLower.includes('gpt-4-turbo')) score += 50;
          if (modelLower.includes('claude-opus-4-6-20260206') || modelLower.includes('claude-opus')) score += 45;
          if (modelLower.includes('gemini-pro-1.5')) score += 40;
          if (modelLower.includes('gemini-flash')) score += 30; // Fast but lower quality

          // Bonus for high accuracy preference
          if (criteria.preferHighAccuracy) {
            if (modelLower.includes('opus')) score += 30; // Opus is best for accuracy
            if (modelLower.includes('gpt-4o')) score += 20;
          } else {
            // Prefer faster models when accuracy isn't critical
            if (modelLower.includes('flash')) score += 20;
            if (modelLower.includes('gpt-4o')) score += 25; // Balance of speed/accuracy
          }
          break;

        case 'code':
          if (modelLower.includes('code') || modelLower.includes('codex')) score += 50;
          if (modelLower.includes('deepseek')) score += 30;
          if (modelLower.includes('gpt-4')) score += 25;
          break;
      }
    }

    // Score based on role suitability (if role is provided)
    if (criteria.role) {
      switch (criteria.role) {
        case AgentRole.CODING:
          if (modelLower.includes('code') || modelLower.includes('codex')) score += 50;
          if (modelLower.includes('deepseek')) score += 30;
          if (modelLower.includes('gpt-4')) score += 25;
          break;
        case AgentRole.RESEARCH:
          if (modelLower.includes('claude')) score += 40;
          if (modelLower.includes('gpt-4')) score += 35;
          if (modelLower.includes('gemini')) score += 30;
          break;
        case AgentRole.REVIEW:
          if (modelLower.includes('claude')) score += 35;
          if (modelLower.includes('gpt-4')) score += 30;
          break;
        case AgentRole.SYNTHESIS:
          if (modelLower.includes('claude')) score += 45;
          if (modelLower.includes('gemini')) score += 35;
          break;
        case AgentRole.SPECIALIST:
          if (modelLower.includes('gpt-4')) score += 40;
          if (modelLower.includes('claude')) score += 35;
          break;
      }
    }

    // Score based on known working status
    if (this.workingModels.has(model.id)) {
      score += 100; // Strongly prefer known working models
    }

    // Score based on provider preference
    if (criteria.preferredProviders) {
      const provider = model.id.split('/')[0];
      const preferenceIndex = criteria.preferredProviders.indexOf(provider);
      if (preferenceIndex >= 0) {
        score += (10 - preferenceIndex) * 10;
      }
    }

    // Score based on cost (lower is better)
    const costPerMillion = (model.pricing.prompt + model.pricing.completion) / 2;
    if (costPerMillion < 1) score += 30;
    else if (costPerMillion < 5) score += 20;
    else if (costPerMillion < 10) score += 10;

    // Score based on context length
    if (model.context_length >= 128000) score += 25;
    else if (model.context_length >= 32000) score += 15;
    else if (model.context_length >= 16000) score += 10;

    // Penalize preview/beta models slightly
    if (modelLower.includes('preview') || modelLower.includes('beta')) {
      score -= 10;
    }

    // Heavily penalize free models - unreliable for production
    if (model.id.includes(':free') || model.pricing.prompt === 0) {
      score -= 1000; // Essentially disqualify
    }

    return score;
  }

  private selectFromFallbackChain(primaryModel: string, role: AgentRole): string {
    if (!primaryModel) {
      return this.getAnyWorkingModel(role);
    }

    // Check if we have a fallback chain for this model
    const fallbackChain = this.FALLBACK_CHAINS[primaryModel] || [];

    for (const fallbackId of fallbackChain) {
      // Check if fallback model is available
      if (this.modelCache.has(fallbackId) && !this.failedModels.has(fallbackId)) {
        logger.info('Using fallback model', {
          original: primaryModel,
          fallback: fallbackId,
          role
        });
        return fallbackId;
      }

      // Check for partial matches (e.g., version changes)
      const basePattern = fallbackId.split('-')[0];
      for (const [modelId] of this.modelCache) {
        if (modelId.startsWith(basePattern) && !this.failedModels.has(modelId)) {
          logger.info('Using similar fallback model', {
            original: primaryModel,
            pattern: basePattern,
            selected: modelId,
            role
          });
          return modelId;
        }
      }
    }

    return this.getAnyWorkingModel(role);
  }

  private getAnyWorkingModel(role: AgentRole): string {
    // Priority order by role
    const priorityPatterns: Record<AgentRole, string[]> = {
      [AgentRole.CODING]: ['codex', 'code', 'gpt-4', 'claude', 'deepseek'],
      [AgentRole.RESEARCH]: ['claude', 'gpt-4', 'gemini', 'llama'],
      [AgentRole.REVIEW]: ['claude', 'gpt-4', 'gemini'],
      [AgentRole.SYNTHESIS]: ['claude', 'gemini', 'gpt-4'],
      [AgentRole.SPECIALIST]: ['gpt-4', 'claude', 'gemini']
    };

    const patterns = priorityPatterns[role] || ['gpt', 'claude', 'gemini'];

    // Try to find any model matching priority patterns
    for (const pattern of patterns) {
      for (const [modelId] of this.modelCache) {
        if (modelId.toLowerCase().includes(pattern) && !this.failedModels.has(modelId)) {
          logger.warn('Selected any available model', { modelId, role, pattern });
          return modelId;
        }
      }
    }

    // Last resort: return first available model
    for (const [modelId] of this.modelCache) {
      if (!this.failedModels.has(modelId)) {
        logger.warn('Using first available model as last resort', { modelId, role });
        return modelId;
      }
    }

    throw new Error(
      `FATAL: No working models available for role ${role}\n` +
      `Tried ${this.modelCache.size} models, ${this.failedModels.size} have failed\n` +
      'System cannot proceed without at least one working model'
    );
  }

  private getLastResortModel(role: AgentRole): string {
    // Absolute fallback models that should usually work
    const lastResortModels: Record<AgentRole, string> = {
      [AgentRole.CODING]: 'openai/gpt-3.5-turbo',
      [AgentRole.RESEARCH]: 'openai/gpt-3.5-turbo',
      [AgentRole.REVIEW]: 'openai/gpt-3.5-turbo',
      [AgentRole.SYNTHESIS]: 'openai/gpt-3.5-turbo',
      [AgentRole.SPECIALIST]: 'openai/gpt-3.5-turbo'
    };

    return lastResortModels[role];
  }

  /**
   * PROACTIVE MODEL HEALTH CHECK: Test if model actually works BEFORE using it
   *
   * Tests for:
   * - Multi-turn conversation support (CRITICAL for agents)
   * - System message support
   * - Response format correctness
   * - API availability
   *
   * Returns: true if model passes all checks, false if blacklisted
   */
  async testModelHealth(modelId: string): Promise<boolean> {
    // Skip if already validated as working
    if (this.workingModels.has(modelId)) {
      return true;
    }

    // Skip if already known to be broken
    if (this.failedModels.has(modelId)) {
      logger.debug('Skipping health check for known failed model', { modelId });
      return false;
    }

    try {
      logger.info('Running health check on model', { modelId });

      // Test 1: Simple single-turn completion
      const simpleResponse = await this.openRouterClient.createCompletion({
        model: modelId,
        messages: [{ role: 'user', content: 'Say "OK" if you understand' }],
        max_tokens: 10,
        temperature: 0
      });

      const simpleContent = simpleResponse?.choices?.[0]?.message?.content;
      if (!simpleContent || simpleContent.trim().length === 0) {
        logger.warn('Model failed simple completion test (empty/whitespace response)', {
          modelId,
          hasContent: !!simpleContent,
          contentLength: simpleContent?.length || 0
        });
        this.markModelAsFailed(modelId, new Error('Invalid or whitespace-only response'));
        return false;
      }

      // Test 2: Multi-turn conversation (CRITICAL for agents)
      const multiTurnResponse = await this.openRouterClient.createCompletion({
        model: modelId,
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'Correct. Now say "PASS"' }
        ],
        max_tokens: 10,
        temperature: 0
      });

      const multiTurnContent = multiTurnResponse?.choices?.[0]?.message?.content;
      if (!multiTurnContent || multiTurnContent.trim().length === 0) {
        logger.warn('Model failed multi-turn test (empty/whitespace response)', {
          modelId,
          hasContent: !!multiTurnContent,
          contentLength: multiTurnContent?.length || 0
        });
        this.markModelAsFailed(modelId, new Error('Multi-turn returns whitespace-only response'));
        return false;
      }

      // Model passed all tests
      this.markModelAsWorking(modelId);
      logger.info('Model passed health check', { modelId });
      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('Model failed health check', { modelId, error: errorMessage });

      // Parse error to determine if it's permanent or transient
      if (this.isPermanentFailure(errorMessage)) {
        this.markModelAsFailed(modelId, error as Error);
        return false;
      }

      // Transient failure - don't blacklist, but mark as unavailable for now
      logger.debug('Model health check had transient failure, will retry later', { modelId });
      return false;
    }
  }

  /**
   * Determine if error indicates permanent model incompatibility vs transient API issue
   */
  private isPermanentFailure(errorMessage: string): boolean {
    const permanentPatterns = [
      'multi-turn',
      'not supported',
      'invalid model',
      'model not found',
      'does not exist',
      'deprecated',
      'unavailable',
      'whitespace-only',
      'empty response',
      'access denied',
      '400', // Bad request usually means incompatibility
      'capability not supported'
    ];

    const lowerError = errorMessage.toLowerCase();
    return permanentPatterns.some(pattern => lowerError.includes(pattern));
  }

  /**
   * Run health checks on top N models at startup
   * This eagerly validates models to avoid failures during orchestration
   */
  async validateTopModels(count: number = 15): Promise<void> {
    try {
      logger.info('Starting proactive model validation', { targetCount: count });

      await this.refreshModelCacheIfNeeded();
      const allModels = Array.from(this.modelCache.values());

      // Prioritize popular, well-known models
      const priorityProviders = ['anthropic', 'openai', 'google', 'meta-llama', 'deepseek', 'mistralai'];
      const sortedModels = allModels.sort((a, b) => {
        const aProvider = a.id.split('/')[0];
        const bProvider = b.id.split('/')[0];
        const aPriority = priorityProviders.indexOf(aProvider);
        const bPriority = priorityProviders.indexOf(bProvider);

        if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
        if (aPriority !== -1) return -1;
        if (bPriority !== -1) return 1;
        return 0;
      });

      // Test top models in parallel (batches of 5 to avoid rate limits)
      const modelsToTest = sortedModels.slice(0, count);
      const batchSize = 5;

      for (let i = 0; i < modelsToTest.length; i += batchSize) {
        const batch = modelsToTest.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(model => this.testModelHealth(model.id))
        );

        // Small delay between batches to respect rate limits
        if (i + batchSize < modelsToTest.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      logger.info('Model validation completed', {
        validated: count,
        working: this.workingModels.size,
        failed: this.failedModels.size
      });

    } catch (error) {
      logger.error('Model validation failed', { error });
      // Don't throw - let orchestration proceed with unchecked models
    }
  }

  markModelAsWorking(modelId: string): void {
    this.workingModels.add(modelId);
    this.failedModels.delete(modelId);
    logger.debug('Model marked as working', { modelId, workingCount: this.workingModels.size });
  }

  markModelAsFailed(modelId: string, error: Error): void {
    this.failedModels.add(modelId);
    this.workingModels.delete(modelId);

    logger.warn('Model marked as failed', {
      modelId,
      error: error.message,
      failedCount: this.failedModels.size,
      availableCount: this.modelCache.size - this.failedModels.size
    });

    // If too many models have failed, clear the failed set to retry
    if (this.failedModels.size > this.modelCache.size * 0.5) {
      logger.warn('Too many failed models, resetting failure tracking');
      this.failedModels.clear();
      this.lastRefresh = 0; // Force cache refresh
    }
  }

  async validateModel(modelId: string): Promise<boolean> {
    await this.refreshModelCacheIfNeeded();

    if (!this.modelCache.has(modelId)) {
      logger.warn('Model not found in available models', {
        modelId,
        availableCount: this.modelCache.size,
        suggestion: this.findSimilarModel(modelId)
      });
      return false;
    }

    return !this.failedModels.has(modelId);
  }

  private findSimilarModel(modelId: string): string | undefined {
    const basePattern = modelId.split('/')[0] + '/' + modelId.split('/')[1]?.split('-')[0];

    for (const [availableId] of this.modelCache) {
      if (availableId.startsWith(basePattern)) {
        return availableId;
      }
    }

    return undefined;
  }

  getModelStats(): any {
    return {
      totalModels: this.modelCache.size,
      workingModels: this.workingModels.size,
      failedModels: this.failedModels.size,
      availableModels: this.modelCache.size - this.failedModels.size,
      cacheAge: Date.now() - this.lastRefresh,
      providers: [...new Set(Array.from(this.modelCache.keys()).map(id => id.split('/')[0]))]
    };
  }
}