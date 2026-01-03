/**
 * GraphRAG Client V2 - Enhanced with Connection Pool, Circuit Breaker, Service Discovery
 * Production-ready wrapper around GraphRAG service HTTP API
 */

import { logger } from '../utils/logger.js';
import { ServiceUnavailableError, ToolExecutionError } from '../utils/error-handler.js';
import { config, TOOL_TIMEOUTS } from '../config.js';
import { SmartConnectionPool } from '../utils/connection-pool.js';
import { circuitBreakerManager } from '../utils/circuit-breaker.js';
import { serviceDiscovery } from '../utils/service-discovery.js';
import { validateDocumentInput } from '../validators/document-validator.js';

export class GraphRAGClientV2 {
  private pool: SmartConnectionPool | null = null;
  private initialized: boolean = false;

  constructor() {
    logger.debug('GraphRAG client V2 initialized (lazy loading enabled)');
  }

  /**
   * Lazy initialization - discover endpoint and create connection pool
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.pool) {
      return;
    }

    try {
      // Discover working endpoint
      const endpoint = await serviceDiscovery.discover({
        name: 'graphrag',
        candidates: config.graphrag.endpoints,
        healthPath: config.graphrag.healthPath,
        timeout: config.graphrag.healthTimeout
      });

      if (!endpoint.healthy) {
        logger.warn('GraphRAG endpoint discovered but unhealthy', {
          url: endpoint.url
        });
      }

      // Create connection pool with discovered endpoint
      this.pool = new SmartConnectionPool(endpoint.url, config.connectionPool);
      this.initialized = true;

      logger.info('GraphRAG client initialized', {
        endpoint: endpoint.url,
        latency: `${endpoint.latency}ms`
      });
    } catch (error) {
      logger.error('Failed to initialize GraphRAG client', {
        error: (error as Error).message
      });
      throw new ServiceUnavailableError('graphrag', {
        message: 'Failed to discover GraphRAG endpoint',
        candidates: config.graphrag.endpoints
      });
    }
  }

  /**
   * Execute request with circuit breaker protection
   */
  private async executeWithProtection<T>(
    toolName: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    const breaker = circuitBreakerManager.getBreaker(
      'graphrag',
      config.circuitBreaker
    );

    try {
      return await breaker.execute(fn);
    } catch (error) {
      throw new ToolExecutionError(toolName, 'graphrag', error as Error);
    }
  }

  /**
   * Generic POST request with timeout
   */
  private async post<T = any>(
    endpoint: string,
    data: any,
    toolName: string
  ): Promise<T> {
    return this.executeWithProtection(toolName, async () => {
      if (!this.pool) throw new Error('Connection pool not initialized');

      const timeout = TOOL_TIMEOUTS[toolName] || config.graphrag.defaultTimeout;
      const response = await this.pool.post(endpoint, data, {}, timeout);

      return response.data;
    });
  }

  /**
   * Generic GET request with timeout
   */
  private async get<T = any>(endpoint: string, toolName: string): Promise<T> {
    return this.executeWithProtection(toolName, async () => {
      if (!this.pool) throw new Error('Connection pool not initialized');

      const timeout = TOOL_TIMEOUTS[toolName] || config.graphrag.defaultTimeout;
      const response = await this.pool.get(endpoint, {}, timeout);

      return response.data;
    });
  }

  /**
   * Generic PUT request with timeout
   */
  private async put<T = any>(
    endpoint: string,
    data: any,
    toolName: string
  ): Promise<T> {
    return this.executeWithProtection(toolName, async () => {
      if (!this.pool) throw new Error('Connection pool not initialized');

      const timeout = TOOL_TIMEOUTS[toolName] || config.graphrag.defaultTimeout;
      const response = await this.pool.put(endpoint, data, {}, timeout);

      return response.data;
    });
  }

  /**
   * Check health (without circuit breaker)
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      if (!this.pool) return false;

      const response = await this.pool.get('/health', {}, 5000);
      return response.status === 200 && response.data.status === 'healthy';
    } catch (error) {
      logger.debug('GraphRAG health check failed', {
        error: (error as Error).message
      });
      return false;
    }
  }

  // ========================================
  // Memory Operations - Use unified /api/v2/memory endpoint
  // ========================================
  async storeMemory(content: string, tags?: string[], metadata?: any, options?: {
    forceEntityExtraction?: boolean;
    forceEpisodicStorage?: boolean;
    preIdentifiedEntities?: string[];
    episodeType?: 'user_query' | 'system_response' | 'document_interaction' | 'entity_mention' | 'summary';
    importance?: number;
  }): Promise<any> {
    return this.post('/graphrag/api/v2/memory', {
      content,
      tags,
      metadata,
      ...options
    }, 'nexus_store_memory');
  }

  async recallMemory(query: string, limit?: number, scoreThreshold?: number): Promise<any> {
    // Use unified enhanced retrieval endpoint
    return this.post('/graphrag/api/retrieve/enhanced', {
      query,
      limit: limit || 10,
      score_threshold: scoreThreshold,
      includeEpisodic: true,
      includeDocuments: true
    }, 'nexus_recall_memory');
  }

  async listMemories(_limit?: number, _offset?: number): Promise<any> {
    // DEPRECATED: List endpoint removed - use retrieve/enhanced with broad query
    console.warn('listMemories is deprecated. Use recallMemory or enhancedRetrieve instead.');
    return { memories: [], deprecated: true, message: 'Use recallMemory or enhancedRetrieve instead' };
  }

  async storePattern(pattern: string, context: string, confidence?: number, tags?: string[]): Promise<any> {
    return this.post('/graphrag/api/patterns/store', {
      pattern,
      context,
      confidence,
      tags
    }, 'nexus_store_pattern');
  }

  // ========================================
  // Document Operations
  // ========================================
  async storeDocument(content: string, title?: string, metadata?: any): Promise<any> {
    // Validate and sanitize inputs before sending to GraphRAG
    // Fixes HTTP 500 errors caused by:
    // - Version as string ("2.0") → converts to integer (2)
    // - Invalid domain types ('medical', 'legal') → maps to valid types
    const validated = validateDocumentInput({
      content,
      title,
      metadata
    });

    return this.post('/graphrag/api/documents', validated, 'nexus_store_document');
  }

  async getDocument(documentId: string, includeChunks?: boolean): Promise<any> {
    return this.get(
      `/graphrag/api/documents/${documentId}?include_chunks=${includeChunks || false}`,
      'nexus_get_document'
    );
  }

  async listDocuments(limit?: number, offset?: number): Promise<any> {
    return this.post('/graphrag/api/documents/list', { limit, offset }, 'nexus_list_documents');
  }

  /**
   * Store document from file (auto-parsing support)
   * Supports: PDF, DOCX, XLSX, MD, RTF, EPUB, TXT
   *
   * @param filePathOrBuffer - File path or Buffer
   * @param fileName - File name (required if providing Buffer)
   * @param options - Additional options (domain, mimeType)
   * @returns Document storage response
   */
  async storeDocumentFromFile(
    filePathOrBuffer: string | Buffer,
    fileName?: string,
    options?: {
      domain?: string;
      mimeType?: string;
      customMetadata?: any;
    }
  ): Promise<any> {
    // Dynamic import to avoid loading parser if not needed
    const { validateFileDocument } = await import('../validators/file-document-validator.js');

    // Validate and parse file
    const validation = await validateFileDocument(
      filePathOrBuffer,
      fileName,
      options?.mimeType,
      options?.domain
    );

    if (!validation.valid) {
      throw new Error(`File validation failed: ${validation.errors?.join(', ')}`);
    }

    // Log warnings
    if (validation.warnings && validation.warnings.length > 0) {
      logger.warn('File document warnings', {
        warnings: validation.warnings
      });
    }

    // Merge custom metadata
    const finalMetadata = {
      ...validation.metadata,
      ...(options?.customMetadata || {})
    };

    // Use size-based timeout
    const originalTimeout = TOOL_TIMEOUTS['nexus_store_document'];

    try {
      // Temporarily override timeout for this request
      TOOL_TIMEOUTS['nexus_store_document'] = validation.recommendedTimeout;

      logger.info('Storing parsed document with extended timeout', {
        title: validation.title,
        wordCount: validation.metadata.wordCount,
        timeout: `${validation.recommendedTimeout}ms`
      });

      return await this.storeDocument(
        validation.content,
        validation.title,
        finalMetadata
      );
    } finally {
      // Restore original timeout
      TOOL_TIMEOUTS['nexus_store_document'] = originalTimeout;
    }
  }

  // ========================================
  // URL Ingestion Operations
  // ========================================
  async ingestURL(url: string, discoveryOptions?: any, ingestionOptions?: any, skipConfirmation?: boolean): Promise<any> {
    return this.post('/graphrag/api/documents/ingest-url', {
      url,
      discoveryOptions,
      ingestionOptions,
      skipConfirmation
    }, 'nexus_ingest_url');
  }

  async confirmURLIngestion(files: any[], ingestionOptions?: any): Promise<any> {
    return this.post('/graphrag/api/documents/ingest-url/confirm', {
      files,
      ingestionOptions
    }, 'nexus_ingest_url_confirm');
  }

  async validateURL(url: string): Promise<any> {
    return this.post('/graphrag/api/documents/validate-url', { url }, 'nexus_validate_url');
  }

  async checkIngestionJob(jobId: string): Promise<any> {
    return this.get(`/graphrag/api/documents/ingestion-jobs/${jobId}`, 'nexus_check_ingestion_job');
  }

  // ========================================
  // Episode Operations - Now uses unified /api/v2/memory with forceEpisodicStorage
  // ========================================
  async storeEpisode(content: string, type?: string, metadata?: any): Promise<any> {
    // Use unified endpoint with forceEpisodicStorage flag
    const response = await this.post('/graphrag/api/v2/memory', {
      content,
      episodeType: type,
      metadata,
      forceEpisodicStorage: true  // Force episodic storage for backward compatibility
    }, 'nexus_store_episode');

    // Transform response: API returns data.episodeId, ensure backward compatibility
    return {
      ...response,
      episodeId: response.data?.episodeId || response.episode_id || response.episodeId
    };
  }

  async recallEpisodes(query: string, options?: {
    limit?: number;
    includeDecay?: boolean;
    typeFilter?: string[];
  }): Promise<any> {
    // Use unified enhanced retrieval endpoint instead of deleted /api/episodes/recall
    return this.post('/graphrag/api/retrieve/enhanced', {
      query,
      limit: options?.limit || 10,
      includeEpisodic: true,
      includeDocuments: false,
      maxTokens: 2000 // Conservative token budget for MCP compatibility
    }, 'nexus_recall_episodes');
  }

  // ========================================
  // Retrieval Operations
  // ========================================
  async retrieve(query: string, strategy?: string, options?: {
    limit?: number;
    rerank?: boolean;
  }): Promise<any> {
    const response = await this.post('/graphrag/api/retrieve', {
      query,
      strategy,
      ...options
    }, 'nexus_retrieve');

    // Ensure response has 'results' field even if API returns different structure
    if (!response.results && response.chunks) {
      return { results: response.chunks, ...response };
    }
    if (!response.results && Array.isArray(response)) {
      return { results: response };
    }
    return response.results ? response : { results: response };
  }

  async enhancedRetrieve(query: string, options?: {
    includeEpisodic?: boolean;
    includeDocuments?: boolean;
    maxTokens?: number;
  }): Promise<any> {
    try {
      const response = await this.post('/graphrag/api/retrieve/enhanced', {
        query,
        include_documents: options?.includeDocuments !== false,
        include_episodic: options?.includeEpisodic !== false,
        max_tokens: options?.maxTokens || 2000
      }, 'nexus_enhanced_retrieve');

      // Ensure response has 'results' field for consistency
      if (!response.results && (response.memories || response.documents || response.episodes)) {
        return {
          results: [...(response.memories || []), ...(response.documents || []), ...(response.episodes || [])],
          ...response
        };
      }
      return response.results ? response : { results: response };
    } catch (error) {
      // Graceful fallback to standard hybrid retrieve on HTTP 500 or other errors
      logger.warn('Enhanced retrieve failed, falling back to hybrid retrieve', {
        error: (error as Error).message,
        query
      });

      return await this.retrieve(query, 'hybrid', {
        limit: options?.maxTokens ? Math.floor(options.maxTokens / 200) : 10,
        rerank: true
      });
    }
  }

  async search(query: string, options?: {
    limit?: number;
    filters?: any;
  }): Promise<any> {
    // Use unified search endpoint which returns consistent structure
    const response = await this.post('/graphrag/api/unified/search', {
      query,
      limit: options?.limit || 20,
      ...options
    }, 'nexus_search');

    // Transform response: unified search returns {results, metadata}
    // Client expects {memories} field
    return {
      memories: response.results || response.items || [],
      ...response.metadata,
      total: (response.metadata?.totalMemories || 0) + (response.metadata?.totalDocuments || 0)
    };
  }

  // ========================================
  // Universal Entity System
  // ========================================
  async storeEntity(entity: {
    domain: string;
    entityType: string;
    content?: string;
    textContent?: string;
    hierarchyLevel?: number;
    parentId?: string;
    storyTime?: string;
    metadata?: any;
    tags?: string[];
  }): Promise<any> {
    const requestBody = { ...entity };
    if (entity.content && !entity.textContent) {
      requestBody.textContent = entity.content;
      delete requestBody.content;
    }
    const response = await this.post('/graphrag/api/entities', requestBody, 'nexus_store_entity');

    // Transform response: API returns entity_id (snake_case), client expects entityId (camelCase)
    return {
      ...response,
      entityId: response.entity_id || response.entityId
    };
  }

  async queryEntities(query: {
    domain?: string;
    entityType?: string;
    searchText?: string;
    limit?: number;
  }): Promise<any> {
    return this.post('/graphrag/api/entities/query', query, 'nexus_query_entities');
  }

  async crossDomainQuery(domains: string[], query: string, maxResults?: number): Promise<any> {
    return this.post('/graphrag/api/entities/cross-domain', {
      domains,
      query,
      maxResults
    }, 'nexus_cross_domain_query');
  }

  async updateEntity(entityId: string, updates: {
    textContent?: string;
    metadata?: any;
    tags?: string[];
  }): Promise<any> {
    return this.put(`/graphrag/api/entities/${entityId}`, updates, 'nexus_update_entity');
  }

  async getEntity(entityId: string): Promise<any> {
    return this.get(`/graphrag/api/entities/${entityId}`, 'nexus_get_entity');
  }

  async getEntityHistory(entityId: string): Promise<any> {
    return this.get(`/graphrag/api/entities/${entityId}/history`, 'nexus_get_entity_history');
  }

  async getEntityHierarchy(entityId: string): Promise<any> {
    return this.get(`/graphrag/api/entities/${entityId}/hierarchy`, 'nexus_get_entity_hierarchy');
  }

  async getFacts(subject: string): Promise<any> {
    // Route to entities/query - facts are stored as entities with type='fact'
    const response = await this.post('/graphrag/api/entities/query', {
      searchText: subject,
      entityType: 'fact',
      limit: 50
    }, 'nexus_get_facts');

    // Transform to expected facts format
    return {
      success: true,
      subject,
      facts: response.entities || response.results || [],
      count: (response.entities || response.results || []).length
    };
  }

  async createEntityRelationship(sourceEntityId: string, targetEntityId: string, relationshipType: string, weight?: number): Promise<any> {
    return this.post('/graphrag/api/entities/relationships', {
      source_entity_id: sourceEntityId,
      target_entity_id: targetEntityId,
      relationship_type: relationshipType,
      weight
    }, 'nexus_create_entity_relationship');
  }

  async bulkCreateEntities(entities: Array<{
    domain: string;
    entityType: string;
    textContent: string;
    tags?: string[];
  }>): Promise<any> {
    return this.post('/graphrag/api/entities/bulk', { entities }, 'nexus_bulk_create_entities');
  }

  // ========================================
  // Statistics & Health
  // ========================================
  async getStats(includeHealth?: boolean): Promise<any> {
    // GraphRAG doesn't have dedicated stats endpoint - aggregate from available endpoints
    const stats: any = {
      success: true,
      timestamp: new Date().toISOString()
    };

    try {
      // Get memory count
      const memories = await this.listMemories(1, 0);
      stats.memories = { count: memories.total || 0 };

      // Get document count
      const documents = await this.listDocuments(1, 0);
      stats.documents = { count: documents.total || 0 };

      // Get health if requested
      if (includeHealth) {
        const health = await this.checkHealth();
        stats.health = { healthy: health, status: health ? 'ok' : 'degraded' };
      }

      return stats;
    } catch (error) {
      // Return partial stats on error
      return {
        success: true,
        ...stats,
        error: 'Could not fetch complete statistics',
        partial: true
      };
    }
  }

  async clearData(type: string, confirm: boolean): Promise<any> {
    if (!confirm) {
      throw new Error('Confirmation required to clear data');
    }

    return this.post('/graphrag/api/clear', { type, confirm }, 'nexus_clear_data');
  }

  // ========================================
  // Diagnostics
  // ========================================
  getConnectionStats() {
    return this.pool?.getStats() || null;
  }

  getCircuitBreakerStats() {
    return circuitBreakerManager.getBreaker('graphrag').getStats();
  }
}

// Export singleton instance
export const graphragClientV2 = new GraphRAGClientV2();
