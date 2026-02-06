import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * Dynamic Model Manager
 * Loads model configurations from JSON file or environment variables
 * Allows runtime updates without code changes
 */

export interface ModelConfig {
  model: string;
  description?: string;
  dimensions?: number;
  supportsVision?: boolean;
  maxTokens?: number;
}

export interface ModelsConfiguration {
  voyageAI: {
    embeddings: Record<string, ModelConfig>;
    reranking: Record<string, ModelConfig>;
  };
  openRouter: {
    classification: Record<string, ModelConfig>;
    extraction: Record<string, ModelConfig>;
    summarization: Record<string, ModelConfig>;
  };
  modelSelection: {
    autoSelect: boolean;
    preferenceOrder: string[];
    costOptimization: boolean;
    qualityThreshold: number;
  };
  lastUpdated: string;
  version: string;
}

export class ModelManager {
  private static instance: ModelManager;
  private config: ModelsConfiguration;
  private configPath: string;
  private watchInterval: NodeJS.Timeout | null = null;

  private constructor() {
    // Try multiple config locations
    const possiblePaths = [
      path.join(__dirname, '../config/models.json'),
      path.join(process.cwd(), 'config/models.json'),
      '/app/config/models.json',
      process.env.MODELS_CONFIG_PATH
    ].filter(Boolean);

    for (const configPath of possiblePaths as string[]) {
      if (fs.existsSync(configPath)) {
        this.configPath = configPath;
        break;
      }
    }

    if (!this.configPath) {
      logger.warn('No models.json config found, using defaults');
      this.configPath = path.join(__dirname, '../config/models.json');
      this.config = this.getDefaultConfig();
    } else {
      this.loadConfig();
    }

    // Watch for config changes in development
    if (process.env.NODE_ENV === 'development') {
      this.startConfigWatch();
    }
  }

  static getInstance(): ModelManager {
    if (!ModelManager.instance) {
      ModelManager.instance = new ModelManager();
    }
    return ModelManager.instance;
  }

  /**
   * Load configuration from file
   */
  private loadConfig(): void {
    try {
      const configContent = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(configContent);

      // Override with environment variables if set
      this.applyEnvironmentOverrides();

      logger.info('Model configuration loaded', {
        path: this.configPath,
        version: this.config.version,
        lastUpdated: this.config.lastUpdated
      });
    } catch (error) {
      logger.error('Failed to load model configuration, using defaults', { error });
      this.config = this.getDefaultConfig();
    }
  }

  /**
   * Apply environment variable overrides
   */
  private applyEnvironmentOverrides(): void {
    // Override VoyageAI models
    if (process.env.VOYAGE_GENERAL_MODEL) {
      this.config.voyageAI.embeddings.general.model = process.env.VOYAGE_GENERAL_MODEL;
    }
    if (process.env.VOYAGE_CODE_MODEL) {
      this.config.voyageAI.embeddings.code.model = process.env.VOYAGE_CODE_MODEL;
    }
    if (process.env.VOYAGE_RERANK_MODEL) {
      this.config.voyageAI.reranking.default.model = process.env.VOYAGE_RERANK_MODEL;
    }

    // Override OpenRouter models
    if (process.env.OPENROUTER_CLASSIFICATION_MODEL) {
      this.config.openRouter.classification.primary.model = process.env.OPENROUTER_CLASSIFICATION_MODEL;
    }
    if (process.env.OPENROUTER_CODE_MODEL) {
      this.config.openRouter.classification.code.model = process.env.OPENROUTER_CODE_MODEL;
    }
    if (process.env.OPENROUTER_FAST_MODEL) {
      this.config.openRouter.classification.fast.model = process.env.OPENROUTER_FAST_MODEL;
    }
  }

  /**
   * Get default configuration
   */
  private getDefaultConfig(): ModelsConfiguration {
    return {
      voyageAI: {
        embeddings: {
          general: { model: 'voyage-3', dimensions: 1024 },
          code: { model: 'voyage-code-3', dimensions: 1024 },
          finance: { model: 'voyage-finance-2', dimensions: 1024 },
          law: { model: 'voyage-law-2', dimensions: 1024 }
        },
        reranking: {
          default: { model: 'rerank-2.5' }
        }
      },
      openRouter: {
        classification: {
          primary: {
            model: 'anthropic/claude-opus-4.6',
            supportsVision: true,
            maxTokens: 200000
          },
          code: {
            model: 'deepseek/deepseek-coder',
            supportsVision: false,
            maxTokens: 32000
          },
          fast: {
            model: 'anthropic/claude-opus-4.6',
            supportsVision: true,
            maxTokens: 200000
          },
          fallback: {
            model: 'openai/gpt-4-turbo',
            supportsVision: true,
            maxTokens: 128000
          }
        },
        extraction: {
          primary: { model: 'anthropic/claude-opus-4.6' },
          structured: { model: 'openai/gpt-4-turbo' }
        },
        summarization: {
          primary: { model: 'anthropic/claude-opus-4.6' },
          long: { model: 'anthropic/claude-opus-4.6', maxTokens: 200000 }
        }
      },
      modelSelection: {
        autoSelect: true,
        preferenceOrder: ['anthropic', 'openai', 'google', 'meta'],
        costOptimization: false,
        qualityThreshold: 0.8
      },
      lastUpdated: new Date().toISOString(),
      version: '1.0.0'
    };
  }

  /**
   * Start watching config file for changes
   */
  private startConfigWatch(): void {
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      return;
    }

    logger.info('Watching model configuration for changes', {
      path: this.configPath
    });

    // Check for changes every 30 seconds
    this.watchInterval = setInterval(() => {
      try {
        const stats = fs.statSync(this.configPath);
        const lastModified = stats.mtime.toISOString();

        if (lastModified > this.config.lastUpdated) {
          logger.info('Model configuration changed, reloading');
          this.loadConfig();
        }
      } catch (error) {
        logger.error('Error checking model configuration', { error });
      }
    }, 30000);
  }

  /**
   * Stop watching config file
   */
  stopConfigWatch(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
  }

  /**
   * Get VoyageAI embedding model for content type
   */
  getVoyageEmbeddingModel(contentType: string): ModelConfig {
    const model = this.config.voyageAI.embeddings[contentType] ||
                  this.config.voyageAI.embeddings.general;

    logger.debug('Selected Voyage embedding model', {
      contentType,
      model: model.model
    });

    return model;
  }

  /**
   * Get VoyageAI reranking model
   */
  getVoyageRerankModel(): ModelConfig {
    return this.config.voyageAI.reranking.default;
  }

  /**
   * Get OpenRouter classification model
   */
  getClassificationModel(type: 'primary' | 'code' | 'fast' | 'fallback' = 'primary'): ModelConfig {
    const model = this.config.openRouter.classification[type] ||
                  this.config.openRouter.classification.primary;

    logger.debug('Selected OpenRouter classification model', {
      type,
      model: model.model
    });

    return model;
  }

  /**
   * Get OpenRouter extraction model
   */
  getExtractionModel(type: 'primary' | 'structured' = 'primary'): ModelConfig {
    return this.config.openRouter.extraction[type] ||
           this.config.openRouter.extraction.primary;
  }

  /**
   * Get OpenRouter summarization model
   */
  getSummarizationModel(type: 'primary' | 'long' = 'primary'): ModelConfig {
    return this.config.openRouter.summarization[type] ||
           this.config.openRouter.summarization.primary;
  }

  /**
   * Get all available Voyage models
   */
  getAllVoyageModels(): Record<string, ModelConfig> {
    return {
      ...this.config.voyageAI.embeddings,
      rerank: this.config.voyageAI.reranking.default
    };
  }

  /**
   * Get all available OpenRouter models
   */
  getAllOpenRouterModels(): Record<string, ModelConfig> {
    return {
      ...this.config.openRouter.classification,
      ...this.config.openRouter.extraction,
      ...this.config.openRouter.summarization
    };
  }

  /**
   * Update model configuration at runtime
   */
  updateModel(path: string[], model: string): void {
    let current: any = this.config;

    for (let i = 0; i < path.length - 1; i++) {
      if (!current[path[i]]) {
        throw new Error(`Invalid path: ${path.join('.')}`);
      }
      current = current[path[i]];
    }

    const lastKey = path[path.length - 1];
    if (current[lastKey] && typeof current[lastKey] === 'object') {
      current[lastKey].model = model;
      this.config.lastUpdated = new Date().toISOString();

      logger.info('Model configuration updated', {
        path: path.join('.'),
        newModel: model
      });

      // Save to file if possible
      this.saveConfig();
    }
  }

  /**
   * Save configuration to file
   */
  private saveConfig(): void {
    if (!this.configPath) {
      return;
    }

    try {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );

      logger.info('Model configuration saved', {
        path: this.configPath
      });
    } catch (error) {
      logger.error('Failed to save model configuration', { error });
    }
  }

  /**
   * Reload configuration from file
   */
  reloadConfig(): void {
    this.loadConfig();
  }

  /**
   * Get current configuration
   */
  getConfig(): ModelsConfiguration {
    return JSON.parse(JSON.stringify(this.config));
  }
}