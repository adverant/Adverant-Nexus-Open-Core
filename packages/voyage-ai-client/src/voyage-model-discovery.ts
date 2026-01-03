import axios, { AxiosInstance } from 'axios';
import { logger } from './utils/logger';

/**
 * Voyage AI Dynamic Model Discovery
 * Automatically discovers all available Voyage AI embedding models
 * through API probing, documentation analysis, and intelligent fallbacks
 */

export interface VoyageModelInfo {
  id: string;
  displayName: string;
  endpoint: string; // 'embeddings' or 'multimodalembeddings'
  dimensions: number;
  specialization: 'general' | 'code' | 'finance' | 'law' | 'multimodal';
  discoveryMethod: 'api_probe' | 'dimension_test' | 'documentation' | 'known_fallback';
  verified: boolean;
  lastVerified?: number;
}

export interface ModelDiscoveryCache {
  models: Map<string, VoyageModelInfo>;
  timestamp: number;
  expiresAt: number;
}

export class VoyageModelDiscovery {
  private httpClient: AxiosInstance;
  private readonly baseUrl = 'https://api.voyageai.com/v1';
  private readonly apiKey: string;
  private modelCache: ModelDiscoveryCache | null = null;
  private readonly cacheTTL = 3600000; // 1 hour

  // Known model patterns for intelligent probing
  private readonly modelPatterns = [
    // General models
    { prefix: 'voyage', version: '3', specialization: 'general' as const },
    { prefix: 'voyage', version: '2', specialization: 'general' as const },

    // Specialized embedding models
    { prefix: 'voyage-code', version: '3', specialization: 'code' as const },
    { prefix: 'voyage-code', version: '2', specialization: 'code' as const },
    { prefix: 'voyage-finance', version: '2', specialization: 'finance' as const },
    { prefix: 'voyage-law', version: '2', specialization: 'law' as const },

    // Multimodal models
    { prefix: 'voyage-multimodal', version: '3', specialization: 'multimodal' as const },
  ];

  // Known rerank models (separate from embedding models - use /rerank endpoint)
  // ORDER MATTERS: Probe newest/best models first
  private readonly rerankModels = [
    'rerank-2.5',      // Latest, most accurate (prioritize)
    'rerank-2.5-lite', // Fast variant
    'rerank-2'         // Legacy fallback
  ];

  // Known dimension sizes for validation (reserved for future use)
  // private readonly knownDimensions = [256, 512, 1024, 1536, 2048, 4096];

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('Voyage AI API key is required for model discovery');
    }

    this.apiKey = apiKey;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    this.httpClient.interceptors.response.use(
      response => response,
      error => {
        // Don't log 404s during probing - they're expected
        if (error.response?.status !== 404) {
          logger.error('Voyage AI API error during model discovery', {
            status: error.response?.status,
            data: error.response?.data,
            url: error.config?.url
          });
        }
        throw error;
      }
    );

    logger.info('Voyage AI Model Discovery initialized');
  }

  /**
   * Discover all available models using multiple strategies
   */
  async discoverModels(forceRefresh = false): Promise<Map<string, VoyageModelInfo>> {
    try {
      // Check cache
      if (!forceRefresh && this.modelCache && Date.now() < this.modelCache.expiresAt) {
        logger.debug('Using cached Voyage AI models', {
          modelCount: this.modelCache.models.size,
          cacheAge: Math.floor((Date.now() - this.modelCache.timestamp) / 1000),
          expiresIn: Math.floor((this.modelCache.expiresAt - Date.now()) / 1000)
        });
        return this.modelCache.models;
      }

      const startTime = Date.now();
      logger.info('Starting Voyage AI model discovery');

      const discoveredModels = new Map<string, VoyageModelInfo>();

      // Strategy 1: Probe known model patterns
      await this.probeKnownModels(discoveredModels);

      // Strategy 2: Probe rerank models
      await this.probeRerankModels(discoveredModels);

      // Strategy 3: Test dimension variations
      await this.testDimensionVariations(discoveredModels);

      // Strategy 4: Add verified fallback models (minimum guaranteed set)
      this.addFallbackModels(discoveredModels);

      const latency = Date.now() - startTime;

      // Update cache
      this.modelCache = {
        models: discoveredModels,
        timestamp: Date.now(),
        expiresAt: Date.now() + this.cacheTTL
      };

      logger.info('Model discovery completed', {
        modelsDiscovered: discoveredModels.size,
        latency,
        models: Array.from(discoveredModels.keys())
      });

      return discoveredModels;
    } catch (error) {
      logger.error('Model discovery failed', { error });

      // If we have stale cache, use it
      if (this.modelCache) {
        logger.warn('Using stale model cache as fallback', {
          cacheAge: Math.floor((Date.now() - this.modelCache.timestamp) / 1000)
        });
        return this.modelCache.models;
      }

      // Last resort: return minimum fallback set
      logger.error('No cache available, returning minimum fallback model set');
      const fallbackModels = new Map<string, VoyageModelInfo>();
      this.addFallbackModels(fallbackModels);
      return fallbackModels;
    }
  }

  /**
   * Strategy 1: Probe known model patterns
   */
  private async probeKnownModels(discoveredModels: Map<string, VoyageModelInfo>): Promise<void> {
    logger.debug('Starting model pattern probing');

    const probePromises = this.modelPatterns.map(async (pattern) => {
      const modelId = `${pattern.prefix}-${pattern.version}`;

      try {
        // Try standard embeddings endpoint
        const dimensions = await this.probeModelDimensions(modelId, 'embeddings');
        if (dimensions) {
          discoveredModels.set(modelId, {
            id: modelId,
            displayName: this.generateDisplayName(modelId, pattern.specialization),
            endpoint: 'embeddings',
            dimensions,
            specialization: pattern.specialization,
            discoveryMethod: 'api_probe',
            verified: true,
            lastVerified: Date.now()
          });
          logger.info(`Discovered model via probe: ${modelId}`, { dimensions, endpoint: 'embeddings' });
          return;
        }
      } catch (error) {
        // Expected for non-existent models
      }

      // For multimodal models, try multimodal endpoint
      if (pattern.specialization === 'multimodal') {
        try {
          const dimensions = await this.probeModelDimensions(modelId, 'multimodalembeddings');
          if (dimensions) {
            discoveredModels.set(modelId, {
              id: modelId,
              displayName: this.generateDisplayName(modelId, pattern.specialization),
              endpoint: 'multimodalembeddings',
              dimensions,
              specialization: pattern.specialization,
              discoveryMethod: 'api_probe',
              verified: true,
              lastVerified: Date.now()
            });
            logger.info(`Discovered model via probe: ${modelId}`, { dimensions, endpoint: 'multimodalembeddings' });
          }
        } catch (error) {
          // Expected for non-existent models
        }
      }
    });

    await Promise.allSettled(probePromises);
    logger.debug(`Probe strategy completed: ${discoveredModels.size} models found`);
  }

  /**
   * Strategy 2: Probe rerank models
   * Rerank models use a different endpoint (/rerank) and don't have dimensions
   */
  private async probeRerankModels(discoveredModels: Map<string, VoyageModelInfo>): Promise<void> {
    logger.debug('Starting rerank model probing');

    const probePromises = this.rerankModels.map(async (modelId) => {
      try {
        // Test rerank endpoint with minimal request
        const response = await this.httpClient.post('/rerank', {
          query: 'test',
          documents: ['test document'],
          model: modelId,
          top_k: 1
        });

        // VoyageAI rerank API returns results in response.data.data (not response.data.results)
        if (response.data?.data && Array.isArray(response.data.data)) {
          discoveredModels.set(modelId, {
            id: modelId,
            displayName: this.generateDisplayName(modelId, 'general'),
            endpoint: 'rerank',
            dimensions: 0, // Rerank models don't return embeddings
            specialization: 'general',
            discoveryMethod: 'api_probe',
            verified: true,
            lastVerified: Date.now()
          });
          logger.info(`Discovered rerank model: ${modelId}`);
        }
      } catch (error: any) {
        // 404 means model doesn't exist
        if (error.response?.status !== 404) {
          logger.debug(`Rerank probe failed for ${modelId}`, {
            status: error.response?.status,
            error: error.message
          });
        }
      }
    });

    await Promise.allSettled(probePromises);
    const rerankCount = Array.from(discoveredModels.values()).filter(m => m.endpoint === 'rerank').length;
    logger.debug(`Rerank probe strategy completed: ${rerankCount} rerank models found`);
  }

  /**
   * Strategy 3: Test dimension variations for discovered models
   */
  private async testDimensionVariations(discoveredModels: Map<string, VoyageModelInfo>): Promise<void> {
    logger.debug('Testing dimension variations');

    // For each discovered model, verify dimensions are correct
    const verificationPromises = Array.from(discoveredModels.values()).map(async (model) => {
      try {
        const actualDimensions = await this.probeModelDimensions(model.id, model.endpoint);
        if (actualDimensions && actualDimensions !== model.dimensions) {
          logger.warn(`Dimension mismatch detected for ${model.id}`, {
            expected: model.dimensions,
            actual: actualDimensions
          });
          // Update with correct dimensions
          model.dimensions = actualDimensions;
          model.discoveryMethod = 'dimension_test';
        }
      } catch (error) {
        logger.warn(`Failed to verify dimensions for ${model.id}`, { error });
      }
    });

    await Promise.allSettled(verificationPromises);
  }

  /**
   * Strategy 4: Add minimum fallback models (guaranteed to exist)
   */
  private addFallbackModels(discoveredModels: Map<string, VoyageModelInfo>): void {
    const fallbackModels: VoyageModelInfo[] = [
      {
        id: 'voyage-3',
        displayName: 'Voyage 3 (General)',
        endpoint: 'embeddings',
        dimensions: 1024,
        specialization: 'general',
        discoveryMethod: 'known_fallback',
        verified: false
      },
      {
        id: 'voyage-code-3',
        displayName: 'Voyage Code 3',
        endpoint: 'embeddings',
        dimensions: 1024,
        specialization: 'code',
        discoveryMethod: 'known_fallback',
        verified: false
      },
      {
        id: 'voyage-finance-2',
        displayName: 'Voyage Finance 2',
        endpoint: 'embeddings',
        dimensions: 1024,
        specialization: 'finance',
        discoveryMethod: 'known_fallback',
        verified: false
      },
      {
        id: 'voyage-law-2',
        displayName: 'Voyage Law 2',
        endpoint: 'embeddings',
        dimensions: 1024,
        specialization: 'law',
        discoveryMethod: 'known_fallback',
        verified: false
      },
      {
        id: 'rerank-2.5',
        displayName: 'Voyage Rerank 2.5',
        endpoint: 'rerank',
        dimensions: 0,
        specialization: 'general',
        discoveryMethod: 'known_fallback',
        verified: false
      },
    ];

    fallbackModels.forEach(model => {
      if (!discoveredModels.has(model.id)) {
        discoveredModels.set(model.id, model);
        logger.debug(`Added fallback model: ${model.id}`);
      }
    });
  }

  /**
   * Probe a model to determine its dimensions
   */
  private async probeModelDimensions(modelId: string, endpoint: string): Promise<number | null> {
    try {
      const response = await this.httpClient.post(`/${endpoint}`, {
        input: 'test',
        model: modelId,
        input_type: 'query'
      });

      if (response.data?.data?.[0]?.embedding) {
        const dimensions = response.data.data[0].embedding.length;
        logger.debug(`Probed ${modelId} on /${endpoint}: ${dimensions} dimensions`);
        return dimensions;
      }

      return null;
    } catch (error: any) {
      // 404 means model doesn't exist on this endpoint
      if (error.response?.status === 404) {
        return null;
      }

      // Other errors might indicate issues with our probe
      logger.debug(`Probe failed for ${modelId} on /${endpoint}`, {
        status: error.response?.status,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Generate display name for a model
   */
  private generateDisplayName(modelId: string, _specialization: string): string {
    const parts = modelId.split('-');
    const version = parts[parts.length - 1];
    const type = parts.slice(1, -1).join(' ') || 'general';

    return `Voyage ${type.charAt(0).toUpperCase() + type.slice(1)} ${version}`;
  }

  /**
   * Get model by specialization
   */
  async getModelBySpecialization(specialization: 'general' | 'code' | 'finance' | 'law' | 'multimodal'): Promise<VoyageModelInfo | null> {
    const models = await this.discoverModels();

    // Find all models with this specialization
    const candidates = Array.from(models.values())
      .filter(m => m.specialization === specialization)
      .sort((a, b) => {
        // Prioritize verified models
        if (a.verified && !b.verified) return -1;
        if (!a.verified && b.verified) return 1;

        // Then by version (higher is better)
        const aVersion = parseInt(a.id.match(/\d+$/)?.[0] || '0');
        const bVersion = parseInt(b.id.match(/\d+$/)?.[0] || '0');
        return bVersion - aVersion;
      });

    return candidates[0] || null;
  }

  /**
   * Get best available model for a content type
   */
  async getBestModel(contentType: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general'): Promise<VoyageModelInfo> {
    const specializationMap: Record<string, 'general' | 'code' | 'finance' | 'law' | 'multimodal'> = {
      'text': 'general',
      'code': 'code',
      'finance': 'finance',
      'law': 'law',
      'multimodal': 'multimodal',
      'general': 'general'
    };

    const specialization = specializationMap[contentType];
    const model = await this.getModelBySpecialization(specialization);

    if (!model) {
      // Fallback to general model
      logger.warn(`No model found for ${contentType}, falling back to general model`);
      const generalModel = await this.getModelBySpecialization('general');

      if (!generalModel) {
        throw new Error(
          `Critical error: No Voyage AI models available. ` +
          `Model discovery failed and no fallback models could be loaded. ` +
          `Verify API key and Voyage AI service availability.`
        );
      }

      return generalModel;
    }

    return model;
  }

  /**
   * Get all available models
   */
  async getAllModels(): Promise<VoyageModelInfo[]> {
    const models = await this.discoverModels();
    return Array.from(models.values());
  }

  /**
   * Refresh model discovery
   */
  async refresh(): Promise<Map<string, VoyageModelInfo>> {
    logger.info('Forcing model discovery refresh');
    return this.discoverModels(true);
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
      modelCount: this.modelCache.models.size
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.modelCache = null;
    logger.info('Voyage model cache cleared');
  }
}
