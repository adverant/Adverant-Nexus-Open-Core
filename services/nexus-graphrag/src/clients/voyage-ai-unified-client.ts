import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { VoyageModelDiscovery, VoyageModelInfo } from './voyage-model-discovery';
import { voyageCircuitBreaker, CircuitBreakerOpenError } from '../utils/circuit-breaker';
import { getVoyageMetrics } from '../metrics/voyage-metrics';

/**
 * Voyage AI Unified Client
 * Automatically routes to correct endpoints (/embeddings vs /multimodalembeddings)
 * and uses dynamically discovered models
 */

export interface EmbeddingOptions {
  inputType: 'document' | 'query';
  contentType?: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general';
  truncate?: boolean;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
  endpoint: string;
}

export interface RerankResult {
  index: number;
  score: number;
  document?: string;
}

export class VoyageAIUnifiedClient {
  private httpClient: AxiosInstance;
  private readonly baseUrl = 'https://api.voyageai.com/v1';
  private readonly apiKey: string;
  private modelDiscovery: VoyageModelDiscovery;
  private metrics = getVoyageMetrics();

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'Voyage AI API key is required. ' +
        'The unified client requires this key to access both embeddings and multimodal endpoints.'
      );
    }

    this.apiKey = apiKey;
    this.modelDiscovery = new VoyageModelDiscovery(apiKey);

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 60000, // Increased from 30000ms to handle large text embeddings (3969+ chars)
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
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

        logger.error('Voyage AI Unified Client error', { error: errorDetails });

        throw new Error(
          `Voyage AI API error: ${error.message}. ` +
          `Status: ${error.response?.status || 'N/A'}. ` +
          `Details: ${JSON.stringify(error.response?.data || 'No additional details')}. ` +
          `Endpoint: ${error.config?.url || 'unknown'}. ` +
          `This error occurred while attempting to generate embeddings.`
        );
      }
    );

    logger.info('Voyage AI Unified Client initialized with dynamic model discovery');
  }

  /**
   * Generate embedding with automatic model and endpoint selection
   * Protected by circuit breaker for resilience
   */
  async generateEmbedding(text: string, options: EmbeddingOptions): Promise<EmbeddingResult> {
    // Validate input
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(
        'Invalid text for embedding generation: ' +
        `Expected non-empty string, got ${typeof text} with length ${text?.length || 0}`
      );
    }

    // Execute with circuit breaker protection
    return await voyageCircuitBreaker.execute(async () => {
      // Dynamically select best model for content type
      const contentType = options.contentType || 'general';
      const model = await this.modelDiscovery.getBestModel(contentType);

      // PHASE 4.2: Track request metrics
      const metricsTracker = this.metrics.trackRequest('generateEmbedding', model.id, contentType);

      try {
        const startTime = Date.now();

        logger.debug('Generating embedding with dynamic model', {
          modelId: model.id,
          endpoint: model.endpoint,
          specialization: model.specialization,
          contentType,
          textLength: text.length
        });

        // Route to correct endpoint based on model
        const endpoint = `/${model.endpoint}`;
        const request: any = {
          input: text,
          model: model.id,
          input_type: options.inputType
        };

        if (options.truncate) {
          request.truncate = true;
        }

        // CRITICAL: Log actual HTTP request to verify API calls are being made
        logger.info('[VOYAGE-API-REQUEST] Sending embedding request to Voyage AI', {
          endpoint: `${this.baseUrl}${endpoint}`,
          model: model.id,
          textLength: text.length,
          inputType: options.inputType,
          contentType: options.contentType || 'general',
          timestamp: new Date().toISOString()
        });

        const response = await this.httpClient.post(endpoint, request);

        // CRITICAL: Log successful API response
        logger.info('[VOYAGE-API-RESPONSE] Received embedding from Voyage AI', {
          endpoint,
          model: model.id,
          status: response.status,
          embeddingDimensions: response.data?.data?.[0]?.embedding?.length || 0,
          latency: Date.now() - startTime,
          timestamp: new Date().toISOString()
        });

        const latency = Date.now() - startTime;

        if (!response.data?.data?.[0]?.embedding) {
          throw new Error(
            `Invalid response from Voyage AI ${endpoint}. ` +
            `Expected embedding data but received: ${JSON.stringify(response.data)}`
          );
        }

        const embedding = response.data.data[0].embedding;

        // Validate embedding is a proper number array
        if (!Array.isArray(embedding)) {
          throw new Error(
            `Invalid embedding format from Voyage AI ${endpoint}: ` +
            `Expected array of numbers but received ${typeof embedding}. ` +
            `This may indicate an API response format change.`
          );
        }

        if (embedding.length === 0) {
          throw new Error(
            `Empty embedding array returned from Voyage AI ${endpoint}. ` +
            `Model: ${model.id}. This should not happen and may indicate an API issue.`
          );
        }

        // Validate all elements are numbers
        const invalidElements = embedding.filter(e => typeof e !== 'number' || !isFinite(e));
        if (invalidElements.length > 0) {
          throw new Error(
            `Invalid embedding values from Voyage AI ${endpoint}: ` +
            `Found ${invalidElements.length} non-numeric or infinite values. ` +
            `This could corrupt vector database. Model: ${model.id}`
          );
        }

        // Validate dimensions match expected
        if (embedding.length !== model.dimensions) {
          logger.warn('Embedding dimension mismatch', {
            expected: model.dimensions,
            actual: embedding.length,
            model: model.id,
            note: 'This may indicate model version changes or incorrect discovery'
          });
        }

        logger.debug('Embedding generated successfully', {
          model: model.id,
          endpoint: model.endpoint,
          dimensions: embedding.length,
          latency
        });

        // PHASE 4.2: Record success metrics
        const requestSize = JSON.stringify(request).length;
        const responseSize = JSON.stringify(response.data).length;
        metricsTracker.success(requestSize, responseSize);

        return {
          embedding,
          model: model.id,
          dimensions: embedding.length,
          endpoint: model.endpoint
        };
      } catch (error: any) {
        // PHASE 4.2: Record failure metrics
        const errorType = error.constructor.name || 'UnknownError';
        metricsTracker.failure(errorType, error);

        // Enhance error with context for better debugging
        if (error instanceof CircuitBreakerOpenError) {
          // Re-throw circuit breaker errors as-is
          throw error;
        }

        const enhancedError = new Error(
          `Voyage AI embedding generation failed: ${error.message}. ` +
          `Text length: ${text.length}, ` +
          `Options: ${JSON.stringify(options)}`
        );
        enhancedError.stack = error.stack;

        logger.error('Failed to generate embedding', {
          error: error.message,
          textLength: text.length,
          options
        });

        throw enhancedError;
      }
    });
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddings(texts: string[], options: EmbeddingOptions): Promise<EmbeddingResult[]> {
    // Dynamically select best model
    const contentType = options.contentType || 'general';
    const model = await this.modelDiscovery.getBestModel(contentType);

    // PHASE 4.2: Track batch request metrics
    const batchTracker = this.metrics.trackBatchRequest(model.id, texts.length);

    try {
      const startTime = Date.now();

      logger.debug('Generating batch embeddings with dynamic model', {
        modelId: model.id,
        endpoint: model.endpoint,
        batchSize: texts.length
      });

      const batchSize = 100; // Voyage AI max batch size
      const results: EmbeddingResult[] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const endpoint = `/${model.endpoint}`;

        const request: any = {
          input: batch,
          model: model.id,
          input_type: options.inputType
        };

        if (options.truncate) {
          request.truncate = true;
        }

        const response = await this.httpClient.post(endpoint, request);

        if (!response.data?.data || !Array.isArray(response.data.data)) {
          throw new Error(
            `Invalid batch response from Voyage AI ${endpoint}. ` +
            `Expected array of embeddings but received: ${JSON.stringify(response.data)}`
          );
        }

        const batchResults: EmbeddingResult[] = response.data.data.map((d: any, index: number) => {
          const embedding = d.embedding;

          // Validate each embedding in batch
          if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new Error(
              `Invalid embedding in batch at index ${index}: ` +
              `Expected non-empty array but received ${typeof embedding}`
            );
          }

          const invalidElements = embedding.filter((e: any) => typeof e !== 'number' || !isFinite(e));
          if (invalidElements.length > 0) {
            throw new Error(
              `Invalid embedding values in batch at index ${index}: ` +
              `Found ${invalidElements.length} non-numeric or infinite values`
            );
          }

          return {
            embedding,
            model: model.id,
            dimensions: embedding.length,
            endpoint: model.endpoint
          };
        });

        results.push(...batchResults);

        // Rate limiting pause between batches
        if (i + batchSize < texts.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      const latency = Date.now() - startTime;

      logger.debug('Batch embeddings generated', {
        model: model.id,
        totalTexts: texts.length,
        batches: Math.ceil(texts.length / batchSize),
        latency
      });

      // PHASE 4.2: Track batch success
      batchTracker.complete(true);

      return results;
    } catch (error) {
      // PHASE 4.2: Track batch failure
      batchTracker.complete(false);

      logger.error('Failed to generate batch embeddings', { error, options, batchSize: texts.length });
      throw error;
    }
  }

  /**
   * Rerank documents using Voyage AI reranking
   */
  async rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[]> {
    if (!documents || documents.length === 0) {
      logger.warn('Rerank called with empty documents array');
      return [];
    }

    // Get all models to find best rerank model
    // Prefer rerank-2.5 (latest, best quality) with fallback to rerank-2
    const allModels = await this.modelDiscovery.getAllModels();
    const rerank25 = allModels.find(m => m.id === 'rerank-2.5');
    const rerank2 = allModels.find(m => m.id === 'rerank-2');
    const rerankModel = rerank25 || rerank2 || allModels.find(m => m.id.includes('rerank'));

    if (!rerankModel) {
      throw new Error(
        'No reranking model found in Voyage AI model discovery. ' +
        'Reranking functionality is not available. ' +
        'Expected models: rerank-2.5 (preferred), rerank-2 (fallback)'
      );
    }

    // PHASE 4.2: Track rerank request metrics
    const metricsTracker = this.metrics.trackRequest('rerank', rerankModel.id, 'rerank');

    try {
      const startTime = Date.now();

      const request = {
        query,
        documents,
        model: rerankModel.id,
        top_k: topK || Math.min(documents.length, 10)
      };

      logger.info('Reranking documents', {
        model: rerankModel.id,
        modelPriority: rerankModel.id === 'rerank-2.5' ? 'rerank-2.5 (best)' : rerankModel.id === 'rerank-2' ? 'rerank-2 (fallback)' : 'generic',
        queryLength: query.length,
        documentCount: documents.length,
        topK: request.top_k
      });

      const response = await this.httpClient.post('/rerank', request);

      const latency = Date.now() - startTime;

      // VoyageAI returns results in response.data.data array, not response.data.results
      if (!response.data?.data || !Array.isArray(response.data.data)) {
        logger.warn('No reranking results received, returning original order', {
          responseKeys: Object.keys(response.data || {}),
          hasData: !!response.data,
          dataType: typeof response.data
        });
        return documents.slice(0, topK || 10).map((doc, index) => ({
          index,
          score: 1.0 - (index * 0.1),
          document: doc
        }));
      }

      const results: RerankResult[] = response.data.data.map((r: any) => ({
        index: r.index,
        score: r.relevance_score || r.score,
        document: documents[r.index]
      }));

      logger.info('Documents reranked successfully', {
        model: rerankModel.id,
        resultsCount: results.length,
        latency,
        topScore: results[0]?.score || 0,
        avgScore: results.length > 0 ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0
      });

      // PHASE 4.2: Record success metrics
      const requestSize = JSON.stringify(request).length;
      const responseSize = JSON.stringify(response.data).length;
      metricsTracker.success(requestSize, responseSize);

      return results;
    } catch (error: any) {
      // PHASE 4.2: Record failure metrics
      const errorType = error.constructor?.name || 'UnknownError';
      metricsTracker.failure(errorType, error);

      logger.error('Failed to rerank documents', { error, query, documentCount: documents.length });

      // Fallback: return original order
      logger.warn('Returning documents in original order as fallback');
      return documents.slice(0, topK || 10).map((doc, index) => ({
        index,
        score: 1.0 - (index * 0.1),
        document: doc
      }));
    }
  }

  /**
   * Get available models from discovery
   */
  async getAvailableModels(): Promise<VoyageModelInfo[]> {
    return this.modelDiscovery.getAllModels();
  }

  /**
   * Get best model for a specific content type
   */
  async getBestModelForContentType(contentType: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general'): Promise<VoyageModelInfo> {
    return this.modelDiscovery.getBestModel(contentType);
  }

  /**
   * Detect content type from text for optimal model selection
   * Analyzes text characteristics to determine appropriate content type
   */
  detectContentType(content: string): 'text' | 'code' | 'markdown' | 'general' {
    if (!content || typeof content !== 'string') {
      logger.warn('Invalid content for type detection, defaulting to general', {
        contentType: typeof content,
        contentLength: content?.length || 0
      });
      return 'general';
    }

    const trimmedContent = content.trim();

    // Check for code patterns
    const codePatterns = [
      /^(function|const|let|var|class|interface|type|export|import)\s/m,
      /^(def|class|import|from|async|await)\s/m,
      /^(public|private|protected|static)\s/m,
      /\{[\s\S]*\}$/m,
      /^\s*(\/\/|\/\*|\*|#)/m,
      /=>\s*\{/,
      /<[A-Z][a-zA-Z]*[^>]*>/,  // JSX/TSX components
      /^\s*@[A-Za-z]+/m  // Decorators
    ];

    const isCode = codePatterns.some(pattern => pattern.test(trimmedContent));
    if (isCode) {
      logger.debug('Detected content type: code', {
        contentLength: content.length,
        sample: trimmedContent.substring(0, 50)
      });
      return 'code';
    }

    // Check for markdown patterns
    const markdownPatterns = [
      /^#{1,6}\s/m,  // Headers
      /^\*\*[^*]+\*\*/m,  // Bold
      /^\*[^*]+\*/m,  // Italic
      /^\[\w+\]\(https?:\/\//m,  // Links
      /^```/m,  // Code blocks
      /^[-*+]\s/m,  // Lists
      /^\d+\.\s/m,  // Numbered lists
      /^>\s/m  // Blockquotes
    ];

    const isMarkdown = markdownPatterns.some(pattern => pattern.test(trimmedContent));
    if (isMarkdown) {
      logger.debug('Detected content type: markdown', {
        contentLength: content.length
      });
      return 'markdown';
    }

    // Default to text for natural language content
    const hasNaturalLanguage = /[a-zA-Z]{3,}/.test(trimmedContent);
    if (hasNaturalLanguage) {
      logger.debug('Detected content type: text', {
        contentLength: content.length
      });
      return 'text';
    }

    // Fallback to general
    logger.debug('Detected content type: general (fallback)', {
      contentLength: content.length
    });
    return 'general';
  }

  /**
   * Get client status including model discovery cache
   */
  getStatus(): {
    discoveryCache: any;
    modelsAvailable: number;
  } {
    const cacheStatus = this.modelDiscovery.getCacheStatus();
    return {
      discoveryCache: cacheStatus,
      modelsAvailable: cacheStatus.modelCount || 0
    };
  }

  /**
   * Refresh model discovery
   */
  async refreshModels(): Promise<void> {
    logger.info('Refreshing Voyage AI model discovery');
    await this.modelDiscovery.refresh();
    logger.info('Voyage AI models refreshed');
  }

  /**
   * Test connection to Voyage AI with all discovered models
   */
  async testConnection(): Promise<{ [modelId: string]: boolean }> {
    try {
      const models = await this.modelDiscovery.getAllModels();
      const results: { [modelId: string]: boolean } = {};

      logger.info('Testing connection with all discovered models', {
        modelCount: models.length
      });

      // Test each model
      for (const model of models) {
        // PHASE 4.2: Track each model test as API key validation
        const metricsTracker = this.metrics.trackRequest('testConnection', model.id, 'validation');

        try {
          const endpoint = `/${model.endpoint}`;
          await this.httpClient.post(endpoint, {
            input: 'test',
            model: model.id,
            input_type: 'query'
          });

          results[model.id] = true;
          logger.debug(`Model ${model.id} test successful`);

          // PHASE 4.2: Record success
          metricsTracker.success();
          this.metrics.trackApiKeyValidation(true);
        } catch (error: any) {
          results[model.id] = false;
          logger.warn(`Model ${model.id} test failed`, { error });

          // PHASE 4.2: Record failure
          const errorType = error.constructor?.name || 'UnknownError';
          metricsTracker.failure(errorType, error);
          this.metrics.trackApiKeyValidation(false);
        }
      }

      const successCount = Object.values(results).filter(v => v).length;
      logger.info('Connection test completed', {
        total: models.length,
        successful: successCount,
        failed: models.length - successCount
      });

      return results;
    } catch (error) {
      logger.error('Connection test failed', { error });
      throw error;
    }
  }
}

// Export as VoyageAIClient for compatibility
export { VoyageAIUnifiedClient as VoyageAIClient };
