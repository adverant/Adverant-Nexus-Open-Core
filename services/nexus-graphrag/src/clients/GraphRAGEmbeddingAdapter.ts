/**
 * GraphRAG Embedding Adapter
 *
 * Service-specific adapter wrapping the shared VoyageAI client
 * for GraphRAG's embedding needs.
 *
 * Features:
 * - Auto content-type detection (code/markdown/text)
 * - Multimodal support enabled
 * - No caching (relies on vector database for persistence)
 * - Circuit breaker protection via shared client
 * - Dynamic model selection
 */

import { VoyageAIUnifiedClient, EmbeddingResult, EmbeddingOptions, RerankResult } from '../../../../packages/voyage-ai-client/dist';
import { logger } from '../utils/logger';

export interface GraphRAGEmbeddingOptions {
  /** Override automatic content type detection */
  contentType?: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general';

  /** Force specific input type (defaults to 'document') */
  inputType?: 'document' | 'query';

  /** Allow truncation if content exceeds token limit */
  truncate?: boolean;

  /** Enable multimodal embedding (for images, etc.) */
  multimodal?: boolean;
}

/**
 * GraphRAG-specific embedding adapter
 * Wraps shared VoyageAI client with GraphRAG optimizations
 */
export class GraphRAGEmbeddingAdapter {
  private client: VoyageAIUnifiedClient;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error(
        'VoyageAI API key is required for GraphRAG embedding adapter. ' +
        'Set VOYAGE_API_KEY environment variable.'
      );
    }

    this.client = new VoyageAIUnifiedClient(apiKey);

    logger.info('GraphRAG Embedding Adapter initialized', {
      features: ['auto-detection', 'multimodal', 'dynamic-models', 'circuit-breaker']
    });
  }

  /**
   * Embed content with automatic content type detection
   *
   * This is the primary method for GraphRAG document embedding.
   * Automatically detects whether content is code, markdown, or text.
   *
   * @param content - Content to embed (text, code, markdown, etc.)
   * @param options - Optional embedding configuration
   * @returns Embedding result with vector
   */
  async embedContent(content: string, options?: GraphRAGEmbeddingOptions): Promise<EmbeddingResult> {
    try {
      const startTime = Date.now();

      // Auto-detect content type unless explicitly provided
      const contentType = options?.contentType || this.client.detectContentType(content);

      logger.debug('Embedding content for GraphRAG', {
        contentLength: content.length,
        contentType,
        inputType: options?.inputType || 'document',
        multimodal: options?.multimodal || false
      });

      // Map content type to valid embedding option type
      const mapContentType = (type: string): 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general' => {
        if (type === 'markdown' || type === 'structured') {
          return 'text';
        }
        return type as 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general';
      };

      // Build embedding options
      const embeddingOptions: EmbeddingOptions = {
        inputType: options?.inputType || 'document',
        contentType: options?.multimodal ? 'multimodal' : mapContentType(contentType),
        truncate: options?.truncate
      };

      // Generate embedding via shared client
      const result = await this.client.generateEmbedding(content, embeddingOptions);

      const latency = Date.now() - startTime;

      logger.debug('Content embedded successfully', {
        model: result.model,
        dimensions: result.dimensions,
        endpoint: result.endpoint,
        latency
      });

      return result;
    } catch (error: any) {
      logger.error('Failed to embed content for GraphRAG', {
        error: error.message,
        contentLength: content.length,
        options
      });
      throw error;
    }
  }

  /**
   * Embed multiple content items in batch
   *
   * More efficient than calling embedContent() multiple times.
   * Automatically handles batching and rate limiting.
   *
   * @param contents - Array of content to embed
   * @param options - Optional embedding configuration
   * @returns Array of embedding results
   */
  async embedBatch(contents: string[], options?: GraphRAGEmbeddingOptions): Promise<EmbeddingResult[]> {
    try {
      if (!contents || contents.length === 0) {
        logger.warn('embedBatch called with empty array');
        return [];
      }

      const startTime = Date.now();

      logger.info('Batch embedding for GraphRAG', {
        batchSize: contents.length,
        inputType: options?.inputType || 'document'
      });

      // Detect content type from first item (assume uniform batch)
      const contentType = options?.contentType || this.client.detectContentType(contents[0]);

      // Map content type to valid embedding option type
      const mapContentType = (type: string): 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general' => {
        if (type === 'markdown' || type === 'structured') {
          return 'text';
        }
        return type as 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general';
      };

      const embeddingOptions: EmbeddingOptions = {
        inputType: options?.inputType || 'document',
        contentType: options?.multimodal ? 'multimodal' : mapContentType(contentType),
        truncate: options?.truncate
      };

      // Generate embeddings via shared client
      const results = await this.client.generateEmbeddings(contents, embeddingOptions);

      const latency = Date.now() - startTime;

      logger.info('Batch embedding completed', {
        batchSize: contents.length,
        model: results[0]?.model,
        dimensions: results[0]?.dimensions,
        latency
      });

      return results;
    } catch (error: any) {
      logger.error('Failed to embed batch for GraphRAG', {
        error: error.message,
        batchSize: contents.length,
        options
      });
      throw error;
    }
  }

  /**
   * Embed a search query
   *
   * Uses 'query' input type for optimal query embeddings.
   * Use this for search/retrieval operations.
   *
   * @param query - Search query text
   * @param options - Optional embedding configuration
   * @returns Embedding result
   */
  async embedQuery(query: string, options?: Omit<GraphRAGEmbeddingOptions, 'inputType'>): Promise<EmbeddingResult> {
    return this.embedContent(query, {
      ...options,
      inputType: 'query' // Force query type
    });
  }

  /**
   * Rerank documents by relevance to query
   *
   * Uses VoyageAI's reranking model for improved search results.
   * Call this after initial vector similarity search.
   *
   * @param query - Search query
   * @param documents - Documents to rerank
   * @param topK - Number of top results (default: 10)
   * @returns Reranked results with scores
   */
  async rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[]> {
    try {
      logger.debug('Reranking documents for GraphRAG', {
        queryLength: query.length,
        documentCount: documents.length,
        topK: topK || 10
      });

      return await this.client.rerank(query, documents, topK);
    } catch (error: any) {
      logger.error('Failed to rerank documents', {
        error: error.message,
        query,
        documentCount: documents.length
      });
      throw error;
    }
  }

  /**
   * Get available VoyageAI models
   *
   * Useful for debugging or displaying model information.
   *
   * @returns List of available models
   */
  async getAvailableModels() {
    return this.client.getAvailableModels();
  }

  /**
   * Test connection to VoyageAI
   *
   * Verifies API key and service availability.
   *
   * @returns Connection test results per model
   */
  async testConnection() {
    return this.client.testConnection();
  }

  /**
   * Get client status including model discovery cache
   *
   * @returns Client status information
   */
  getStatus() {
    return this.client.getStatus();
  }

  /**
   * Legacy API compatibility: generateEmbedding
   * Maps to embedContent for backward compatibility
   */
  async generateEmbedding(text: string, options: { inputType: 'document' | 'query'; contentType?: string; truncate?: boolean }) {
    return this.embedContent(text, options as GraphRAGEmbeddingOptions);
  }

  /**
   * Legacy API compatibility: generateEmbeddings
   * Maps to embedBatch for backward compatibility
   */
  async generateEmbeddings(texts: string[], options: { inputType: 'document' | 'query'; contentType?: string; truncate?: boolean }) {
    return this.embedBatch(texts, options as GraphRAGEmbeddingOptions);
  }

  /**
   * Legacy API compatibility: detectContentType
   * Delegates to shared client
   */
  detectContentType(content: string): 'text' | 'code' | 'markdown' | 'general' {
    return this.client.detectContentType(content);
  }

  /**
   * Legacy API compatibility: getBestModelForContentType
   * Delegates to shared client
   */
  async getBestModelForContentType(contentType: 'text' | 'code' | 'finance' | 'law' | 'multimodal' | 'general') {
    return this.client.getBestModelForContentType(contentType);
  }

  /**
   * Legacy API compatibility: refreshModels
   * Delegates to shared client
   */
  async refreshModels() {
    return this.client.refreshModels();
  }
}
