/**
 * GraphRAG Client for Nexus Routing Package
 * Wrapper around GraphRAG service HTTP API
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from '../utils/logger.js';
import { ServiceUnavailableError, ToolExecutionError } from '../utils/error-handler.js';
import { config } from '../config.js';

export class GraphRAGClient {
  private client: AxiosInstance;
  private healthy: boolean = true;
  private lastHealthCheck: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: config.graphrag.endpoints[0],
      timeout: config.graphrag.defaultTimeout,
      headers: {
        'Content-Type': 'application/json',
        ...(config.graphrag.apiKey && {
          'Authorization': `Bearer ${config.graphrag.apiKey}`
        })
      }
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        this.handleError(error);
        throw error;
      }
    );

    logger.debug('GraphRAG client initialized', {
      endpoint: config.graphrag.endpoints[0]
    });
  }

  /**
   * Handle HTTP errors with verbose logging
   */
  private handleError(error: AxiosError): void {
    const context = {
      endpoint: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
      data: error.response?.data
    };

    logger.error('GraphRAG client error', context);
  }

  /**
   * Health check with caching
   */
  async checkHealth(): Promise<boolean> {
    const now = Date.now();

    // Use cached health status if recent
    if (now - this.lastHealthCheck < 30000) {
      return this.healthy;
    }

    try {
      const response = await this.client.get('/health', { timeout: 5000 });
      this.healthy = response.status === 200 && response.data.status === 'healthy';
      this.lastHealthCheck = now;

      logger.debug('GraphRAG health check', {
        healthy: this.healthy,
        response: response.data
      });

      return this.healthy;
    } catch (error) {
      this.healthy = false;
      this.lastHealthCheck = now;

      logger.warn('GraphRAG health check failed', {
        error: (error as Error).message
      });

      return false;
    }
  }

  /**
   * Ensure service is healthy before request
   */
  private async ensureHealthy(toolName: string): Promise<void> {
    if (!await this.checkHealth()) {
      throw new ServiceUnavailableError('graphrag', {
        tool: toolName,
        endpoint: config.graphrag.endpoints[0]
      });
    }
  }

  /**
   * Generic POST request with error handling
   */
  private async post<T = any>(endpoint: string, data: any, toolName: string): Promise<T> {
    await this.ensureHealthy(toolName);

    try {
      const response = await this.client.post<T>(endpoint, data);
      return response.data;
    } catch (error) {
      throw new ToolExecutionError(toolName, 'graphrag', error as Error);
    }
  }

  /**
   * Generic GET request with error handling
   */
  private async get<T = any>(endpoint: string, toolName: string): Promise<T> {
    await this.ensureHealthy(toolName);

    try {
      const response = await this.client.get<T>(endpoint);
      return response.data;
    } catch (error) {
      throw new ToolExecutionError(toolName, 'graphrag', error as Error);
    }
  }

  /**
   * Generic PUT request with error handling
   */
  private async put<T = any>(endpoint: string, data: any, toolName: string): Promise<T> {
    await this.ensureHealthy(toolName);

    try {
      const response = await this.client.put<T>(endpoint, data);
      return response.data;
    } catch (error) {
      throw new ToolExecutionError(toolName, 'graphrag', error as Error);
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
    return this.post('/api/v2/memory', {
      content,
      tags,
      metadata,
      ...options
    }, 'nexus_store_memory');
  }

  async recallMemory(query: string, limit?: number, scoreThreshold?: number): Promise<any> {
    // Use unified enhanced retrieval endpoint
    return this.post('/api/retrieve/enhanced', {
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

  // ========================================
  // Document Operations
  // ========================================
  async storeDocument(content: string, title?: string, metadata?: any): Promise<any> {
    return this.post('/api/documents', {
      content,
      title,
      metadata
    }, 'nexus_store_document');
  }

  async getDocument(documentId: string, includeChunks?: boolean): Promise<any> {
    return this.get(
      `/api/documents/${documentId}?include_chunks=${includeChunks || false}`,
      'nexus_get_document'
    );
  }

  async listDocuments(limit?: number, offset?: number): Promise<any> {
    return this.post('/api/documents/list', { limit, offset }, 'nexus_list_documents');
  }

  // ========================================
  // URL Ingestion Operations
  // ========================================
  async ingestURL(url: string, discoveryOptions?: any, ingestionOptions?: any, skipConfirmation?: boolean): Promise<any> {
    return this.post('/api/documents/ingest-url', {
      url,
      discoveryOptions,
      ingestionOptions,
      skipConfirmation
    }, 'nexus_ingest_url');
  }

  async confirmURLIngestion(files: any[], ingestionOptions?: any): Promise<any> {
    return this.post('/api/documents/ingest-url/confirm', {
      files,
      ingestionOptions
    }, 'nexus_ingest_url_confirm');
  }

  async validateURL(url: string): Promise<any> {
    // Validation is done within ingest-url endpoint, this is a convenience method
    return this.post('/api/documents/ingest-url', {
      url,
      skipConfirmation: false
    }, 'nexus_validate_url');
  }

  async checkIngestionJob(jobId: string): Promise<any> {
    return this.get(`/api/documents/ingestion-jobs/${jobId}`, 'nexus_check_ingestion_job');
  }

  // ========================================
  // Episode Operations - Now uses unified /api/v2/memory with forceEpisodicStorage
  // ========================================
  async storeEpisode(content: string, type?: string, metadata?: any): Promise<any> {
    // Use unified endpoint with forceEpisodicStorage flag
    return this.post('/api/v2/memory', {
      content,
      episodeType: type,
      metadata,
      forceEpisodicStorage: true  // Force episodic storage for backward compatibility
    }, 'nexus_store_episode');
  }

  async recallEpisodes(query: string, options?: {
    limit?: number;
    includeDecay?: boolean;
    typeFilter?: string[];
  }): Promise<any> {
    // Map limit to max_results and set critical token budget parameters
    // to prevent MCP token limit errors (25K limit)
    const requestPayload: any = {
      query,
      max_results: options?.limit || 10,
      include_decay: options?.includeDecay ?? true,
      response_level: 'summary', // Use summary to minimize token usage
      max_tokens: 2000 // Conservative token budget for MCP compatibility
    };

    // Add type filter if provided
    if (options?.typeFilter && options.typeFilter.length > 0) {
      requestPayload.type_filter = options.typeFilter;
    }

    // Use unified enhanced retrieval endpoint instead of deleted /api/episodes/recall
    return this.post('/api/retrieve/enhanced', {
      query,
      limit: requestPayload.max_results,
      includeEpisodic: true,
      includeDocuments: false,
      maxTokens: requestPayload.max_tokens
    }, 'nexus_recall_episodes');
  }

  // ========================================
  // Retrieval Operations
  // ========================================
  async retrieve(query: string, strategy?: string, options?: {
    limit?: number;
    rerank?: boolean;
  }): Promise<any> {
    return this.post('/api/retrieve', {
      query,
      strategy,
      ...options
    }, 'nexus_retrieve');
  }

  async enhancedRetrieve(query: string, options?: {
    includeEpisodic?: boolean;
    includeDocuments?: boolean;
    maxTokens?: number;
  }): Promise<any> {
    return this.post('/api/retrieve/enhanced', {
      query,
      ...options
    }, 'nexus_enhanced_retrieve');
  }

  async search(query: string, options?: {
    limit?: number;
    filters?: any;
  }): Promise<any> {
    return this.post('/api/search', {
      query,
      ...options
    }, 'nexus_search');
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
    // Transform content to textContent if needed
    const requestBody = { ...entity };
    if (entity.content && !entity.textContent) {
      requestBody.textContent = entity.content;
      delete requestBody.content;
    }
    return this.post('/api/entities', requestBody, 'nexus_store_entity');
  }

  async queryEntities(query: {
    domain?: string;
    entityType?: string;
    searchText?: string;
    limit?: number;
  }): Promise<any> {
    return this.post('/api/entities/query', query, 'nexus_query_entities');
  }

  async crossDomainQuery(domains: string[], query: string, maxResults?: number): Promise<any> {
    return this.post('/api/entities/cross-domain', {
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
    return this.put(`/api/entities/${entityId}`, updates, 'nexus_update_entity');
  }

  async getEntity(entityId: string): Promise<any> {
    return this.get(`/api/entities/universal/${entityId}`, 'nexus_get_entity');
  }

  async getEntityHistory(entityId: string): Promise<any> {
    return this.get(`/api/entities/${entityId}/history`, 'nexus_get_entity_history');
  }

  async getEntityHierarchy(entityId: string): Promise<any> {
    return this.get(`/api/entities/${entityId}/hierarchy`, 'nexus_get_entity_hierarchy');
  }

  async getFacts(subject: string): Promise<any> {
    return this.get(`/api/facts?subject=${encodeURIComponent(subject)}`, 'nexus_get_facts');
  }

  async createEntityRelationship(sourceEntityId: string, targetEntityId: string, relationshipType: string, weight?: number): Promise<any> {
    return this.post('/api/entities/relationships', {
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
    return this.post('/api/entities/bulk', { entities }, 'nexus_bulk_create_entities');
  }

  // ========================================
  // Statistics & Health
  // ========================================
  async getStats(includeHealth?: boolean): Promise<any> {
    return this.get(
      `/api/stats?include_health=${includeHealth !== false}`,
      'nexus_get_stats'
    );
  }

  async clearData(type: string, confirm: boolean): Promise<any> {
    if (!confirm) {
      throw new Error('Confirmation required to clear data');
    }

    return this.post('/api/clear', { type, confirm }, 'nexus_clear_data');
  }
}

// Export singleton instance
export const graphragClient = new GraphRAGClient();
