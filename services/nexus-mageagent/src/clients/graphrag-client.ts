/**
 * GraphRAG Client - REFACTORED WITH MULTI-TENANT SECURITY
 *
 * 🔒 CRITICAL SECURITY FIX: Tenant Context Propagation
 *
 * This refactored version ensures tenant isolation by:
 * 1. Accepting tenant context in constructor
 * 2. Injecting tenant headers in ALL requests to GraphRAG
 * 3. Validating tenant context before operations
 * 4. Removing global singleton (incompatible with multi-tenancy)
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { logger } from '../utils/logger';
import { config } from '../config';
import { sanitizeQuery, sanitizeErrorMessage } from '../utils/security';
import { createCircuitBreaker, ServiceCircuitBreaker } from '../utils/circuit-breaker';
import { ResilienceManager } from '../utils/resilience-manager';
import {
  validateEpisodeContent,
  isEpisodeValidationError,
} from '../validation/episode-validation';

// ============================================================================
// 🔒 SECURITY FIX: Tenant Context Interface with User Tracking
// ============================================================================

/**
 * Enhanced tenant context with user-level tracking
 * Supports both basic tenant isolation and full user audit trails
 */
export interface TenantContext {
  // Tenant (required for data isolation)
  companyId: string;
  appId: string;

  // User (optional, for audit trails and GDPR compliance)
  userId?: string;
  userEmail?: string;
  userName?: string;

  // Session & Request (optional, for distributed tracing)
  sessionId?: string;
  requestId?: string;

  // Metadata
  timestamp?: string;
  source?: 'jwt' | 'headers' | 'system';
}

export interface MemoryRequest {
  content: string;
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface RecallRequest {
  query: string;
  limit?: number;
  tags?: string[];
  include_decay?: boolean;
  type_filter?: string[];
  score_threshold?: number;
}

export class GraphRAGClient {
  private httpClient: AxiosInstance;
  private endpoint: string;
  private circuitBreaker: ServiceCircuitBreaker;
  private resilienceManager: ResilienceManager;
  private httpAgent!: HttpAgent;
  private httpsAgent!: HttpsAgent;
  private gcThresholdMB = 2048;
  private lastGCTime = Date.now();
  private minGCInterval = 30000;

  // 🔒 SECURITY FIX: Store tenant context for header injection
  private tenantContext: TenantContext | null = null;

  constructor(endpoint?: string, tenantContext?: TenantContext) {
    this.endpoint = endpoint || config.graphRAG.endpoint;

    // 🔒 SECURITY FIX: Accept and store tenant context
    if (tenantContext) {
      this.validateTenantContext(tenantContext);
      this.tenantContext = tenantContext;
      logger.info('GraphRAGClient initialized with tenant context', {
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
      });
    } else {
      logger.warn('GraphRAGClient initialized WITHOUT tenant context - multi-tenant isolation may be compromised');
    }

    this.httpClient = this.createHttpClient();

    // Initialize circuit breaker for GraphRAG requests
    this.circuitBreaker = createCircuitBreaker('GraphRAG', async (fn: Function) => {
      return await fn();
    }, {
      timeout: 30000,
      errorThresholdPercentage: 30,
      resetTimeout: 60000,
      volumeThreshold: 5
    });

    // Initialize resilience manager with custom settings
    this.resilienceManager = new ResilienceManager({
      maxRetries: 3,
      initialRetryDelay: 500,
      maxRetryDelay: 5000,
      cacheTTL: 30000,
      deduplicationWindow: 2000,
      circuitBreakerThreshold: 3,
      circuitBreakerTimeout: 30000
    });
  }

  // ============================================================================
  // 🔒 SECURITY FIX: Tenant Context Validation
  // ============================================================================

  private validateTenantContext(context: TenantContext): void {
    if (!context.companyId || typeof context.companyId !== 'string') {
      throw new Error('SECURITY VIOLATION: Invalid or missing company_id in tenant context');
    }

    if (!context.appId || typeof context.appId !== 'string') {
      throw new Error('SECURITY VIOLATION: Invalid or missing app_id in tenant context');
    }

    // Validate format (alphanumeric, hyphens, underscores only)
    const validIdPattern = /^[a-zA-Z0-9_-]+$/;
    if (!validIdPattern.test(context.companyId)) {
      throw new Error('SECURITY VIOLATION: company_id contains invalid characters');
    }

    if (!validIdPattern.test(context.appId)) {
      throw new Error('SECURITY VIOLATION: app_id contains invalid characters');
    }
  }

  // ============================================================================
  // 🔒 SECURITY FIX: Tenant Header Injection
  // ============================================================================

  /**
   * Get tenant + user context headers for GraphRAG requests
   * These headers ensure multi-tenant isolation AND user-level audit trails
   */
  private getTenantHeaders(): Record<string, string> {
    if (!this.tenantContext) {
      logger.warn('SECURITY WARNING: GraphRAG request without tenant context - data isolation may fail', {
        stackTrace: new Error().stack,
      });
      return {};
    }

    const headers: Record<string, string> = {
      // Tenant context (REQUIRED for multi-tenant isolation)
      'X-Company-ID': this.tenantContext.companyId,
      'X-App-ID': this.tenantContext.appId,
    };

    // User context (OPTIONAL for audit trails and GDPR compliance)
    if (this.tenantContext.userId) {
      headers['X-User-ID'] = this.tenantContext.userId;
    }

    if (this.tenantContext.userEmail) {
      headers['X-User-Email'] = this.tenantContext.userEmail;
    }

    if (this.tenantContext.userName) {
      headers['X-User-Name'] = this.tenantContext.userName;
    }

    // Session & Request context (for distributed tracing)
    if (this.tenantContext.sessionId) {
      headers['X-Session-ID'] = this.tenantContext.sessionId;
    }

    if (this.tenantContext.requestId) {
      headers['X-Request-ID'] = this.tenantContext.requestId;
    }

    // Log context propagation (debug level to avoid log spam)
    logger.debug('Propagating tenant + user context to GraphRAG', {
      companyId: this.tenantContext.companyId,
      appId: this.tenantContext.appId,
      userId: this.tenantContext.userId,
      hasUserEmail: !!this.tenantContext.userEmail,
      hasSessionId: !!this.tenantContext.sessionId,
      requestId: this.tenantContext.requestId,
    });

    return headers;
  }

  /**
   * Validate that tenant context exists before sensitive operations
   */
  private assertTenantContext(operation: string): void {
    if (!this.tenantContext) {
      const error = new Error(
        `CRITICAL SECURITY VIOLATION: Attempted ${operation} without tenant context. ` +
        'This could lead to cross-tenant data leakage. Operation aborted.'
      );

      logger.error('SECURITY VIOLATION: Operation attempted without tenant context', {
        operation,
        stackTrace: error.stack,
        timestamp: new Date().toISOString(),
      });

      throw error;
    }
  }

  private createHttpClient(): AxiosInstance {
    // Create HTTP/HTTPS agents with proper connection pooling
    this.httpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 30000,
      scheduling: 'fifo'
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 30000,
      scheduling: 'fifo'
    });

    const client = axios.create({
      baseURL: this.endpoint,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      },
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent
    });

    // Add retry logic
    axiosRetry(client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response?.status ? error.response.status >= 500 : false);
      }
    });

    // 🔒 SECURITY FIX: Add request interceptor to inject tenant headers
    client.interceptors.request.use(
      (config) => {
        // Inject tenant headers into EVERY request
        const tenantHeaders = this.getTenantHeaders();

        config.headers = {
          ...config.headers,
          ...tenantHeaders,
        } as any;

        logger.debug(`GraphRAG Request: ${config.method?.toUpperCase()} ${config.url}`, {
          hasTenantContext: !!this.tenantContext,
          companyId: this.tenantContext?.companyId,
          appId: this.tenantContext?.appId,
        });

        return config;
      },
      (error) => {
        logger.error('GraphRAG Request Error:', error);
        return Promise.reject(error);
      }
    );

    client.interceptors.response.use(
      (response) => {
        logger.debug(`GraphRAG Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('GraphRAG Response Error:', { error: errorMessage });
        return Promise.reject(error);
      }
    );

    return client;
  }

  /**
   * Deterministic garbage collection based on memory threshold
   */
  private tryGarbageCollection(): void {
    if (!global.gc) return;

    const now = Date.now();
    const heapUsedMB = process.memoryUsage().heapUsed / 1024 / 1024;

    if (heapUsedMB > this.gcThresholdMB && (now - this.lastGCTime) > this.minGCInterval) {
      const before = process.memoryUsage().heapUsed;
      global.gc();
      const after = process.memoryUsage().heapUsed;
      const freedMB = (before - after) / 1024 / 1024;

      logger.debug('Garbage collection triggered', {
        heapBeforeMB: (before / 1024 / 1024).toFixed(2),
        heapAfterMB: (after / 1024 / 1024).toFixed(2),
        freedMB: freedMB.toFixed(2),
        threshold: this.gcThresholdMB
      });

      this.lastGCTime = now;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.httpClient.get('/health');
      return response.data.status === 'healthy';
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('GraphRAG health check failed:', { error: errorMessage });
      return false;
    }
  }

  // ============================================================================
  // Memory Operations (with tenant context validation)
  // ============================================================================

  async storeMemory(request: MemoryRequest): Promise<any> {
    // 🔒 SECURITY: Validate tenant context before storing data
    this.assertTenantContext('storeMemory');

    const cacheKey = ResilienceManager.generateKey('store_memory', request);

    return this.resilienceManager.execute(
      cacheKey,
      async () => {
        return this.circuitBreaker.fire(async () => {
          let response = null;

          try {
            // Use unified /api/v2/memory endpoint
            response = await this.httpClient.post('/api/v2/memory', {
              content: request.content,
              metadata: {
                ...request.metadata,
                tags: request.tags || [],
                source: 'mageagent',
                timestamp: new Date().toISOString(),
              }
            });
            return response.data;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Failed to store memory:', { error: errorMessage });
            throw new Error(sanitizeErrorMessage(err, false));
          } finally {
            response = null;
            this.tryGarbageCollection();
          }
        });
      },
      { cacheTTL: 5000 }
    );
  }

  async recallMemory(request: RecallRequest): Promise<any> {
    // 🔒 SECURITY: Validate tenant context before recalling data
    this.assertTenantContext('recallMemory');

    const cacheKey = ResilienceManager.generateKey('recall_memory', request);

    return this.resilienceManager.execute(
      cacheKey,
      async () => {
        return this.circuitBreaker.fire(async () => {
          let response = null;

          try {
            const sanitizedQuery = sanitizeQuery(request.query);

            if (!sanitizedQuery) {
              logger.warn('Empty query after sanitization', { originalQuery: request.query });
              return [];
            }

            // Use unified /api/retrieve/enhanced endpoint
            response = await this.httpClient.post('/graphrag/api/retrieve/enhanced', {
              query: sanitizedQuery,
              limit: Math.min(request.limit || 5, 100),
              includeEpisodic: true,
              includeDocuments: true
            });
            return response.data.unified_memories || response.data.memories || [];
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Failed to recall memory:', { error: errorMessage });

            if (err instanceof Error && err.message.includes('500')) {
              logger.warn('GraphRAG service error, returning empty results');
              return [];
            }

            throw new Error(sanitizeErrorMessage(err, false));
          } finally {
            response = null;
            this.tryGarbageCollection();
          }
        });
      },
      { cacheTTL: 60000 }
    );
  }

  async listMemories(_options?: { limit?: number; offset?: number }): Promise<any> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('listMemories');

    // DEPRECATED: listMemories endpoint removed - use recallMemory with broad query
    logger.warn('listMemories is deprecated. Use recallMemory or enhanced retrieve instead.');
    return [];
  }

  // ============================================================================
  // Document Operations (with tenant context validation)
  // ============================================================================

  async storeDocument(content: string, metadata: any): Promise<any> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('storeDocument');

    try {
      const validTypes = ['code', 'markdown', 'text', 'structured', 'multimodal'];
      let documentType = metadata?.type || 'text';

      const typeMapping: Record<string, string> = {
        'document': 'text',
        'agent_response': 'structured',
        'synthesis': 'structured',
        'analysis': 'structured',
        'memory': 'text',
        'episode': 'structured'
      };

      if (!validTypes.includes(documentType)) {
        documentType = typeMapping[documentType] || 'text';
      }

      const response = await this.httpClient.post('/graphrag/api/documents', {
        content: content || '',
        type: documentType,
        title: metadata?.title || 'Untitled',
        metadata: {
          ...metadata,
          source: 'mageagent',
          originalType: metadata?.type,
          timestamp: new Date().toISOString()
        }
      });
      return response.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to store document:', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  async searchDocuments(query: string, options?: any): Promise<any> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('searchDocuments');

    try {
      const sanitizedQuery = sanitizeQuery(query);

      if (!sanitizedQuery) {
        logger.warn('Empty query after sanitization', { originalQuery: query });
        return [];
      }

      const response = await this.httpClient.post('/graphrag/api/search', {
        query: sanitizedQuery,
        filters: options?.filters,
        limit: Math.min(options?.limit || 10, 100)
      });
      return response.data.results || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to search documents:', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  // ============================================================================
  // Episode Operations (with tenant context validation)
  // ============================================================================

  async storeEpisode(episode: any): Promise<any> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('storeEpisode');

    try {
      // Validation layer 3: Pre-flight validation
      if (episode && typeof episode === 'object' && 'content' in episode && 'type' in episode) {
        try {
          validateEpisodeContent({
            content: episode.content,
            type: episode.type,
            metadata: episode.metadata,
          });
        } catch (validationError) {
          if (isEpisodeValidationError(validationError)) {
            logger.warn('Pre-flight validation failed before GraphRAG API call', {
              error: validationError.message,
              code: validationError.code,
              preventedNetworkCall: true,
            });
            throw validationError;
          }
        }
      }

      // Use unified /api/v2/memory endpoint with forceEpisodicStorage
      const response = await this.httpClient.post('/api/v2/memory', {
        content: episode.content,
        episodeType: episode.type,
        metadata: episode.metadata,
        forceEpisodicStorage: true
      });
      return response.data;
    } catch (error) {
      if (isEpisodeValidationError(error)) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to store episode (network/API error):', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  async recallEpisodes(request: any): Promise<any[]> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('recallEpisodes');

    try {
      // Use unified /api/retrieve/enhanced endpoint
      const response = await this.httpClient.post('/graphrag/api/retrieve/enhanced', {
        query: request.query,
        limit: request.limit || 10,
        includeEpisodic: true,
        includeDocuments: false
      });
      return response.data.episodic_context || response.data || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to recall episodes:', { error: errorMessage });
      return [];
    }
  }

  // ============================================================================
  // Entity Operations (with tenant context validation)
  // ============================================================================

  async storeEntity(entity: any): Promise<any> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('storeEntity');

    try {
      const response = await this.httpClient.post('/graphrag/api/entities', {
        domain: entity.domain || 'general',
        entityType: entity.entityType || entity.type || 'entity',
        textContent: entity.textContent || entity.content || '',
        metadata: entity.metadata || {},
        tags: entity.tags || [],
        parentId: entity.parentId,
        storyTime: entity.storyTime
      });
      return response.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to store entity:', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  async queryEntities(query: any): Promise<any[]> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('queryEntities');

    try {
      const response = await this.httpClient.post('/graphrag/api/entities/query', {
        domain: query.domain,
        entityType: query.entityType,
        searchText: query.searchText || query.query,
        limit: query.limit || 20
      });
      return response.data?.entities || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to query entities:', { error: errorMessage });
      return [];
    }
  }

  async createEntityRelationship(relationship: any): Promise<any> {
    // 🔒 SECURITY: Validate tenant context
    this.assertTenantContext('createEntityRelationship');

    try {
      const response = await this.httpClient.post('/graphrag/api/entities/relationships', {
        sourceEntityId: relationship.sourceEntityId || relationship.source,
        targetEntityId: relationship.targetEntityId || relationship.target,
        relationshipType: relationship.relationshipType || relationship.type || 'RELATED_TO',
        weight: relationship.weight !== undefined ? relationship.weight : 1.0,
        metadata: relationship.metadata || {}
      });
      return response.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create entity relationship:', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  // ============================================================================
  // Additional Operations
  // ============================================================================

  async retrieveDocuments(request: any): Promise<any[]> {
    this.assertTenantContext('retrieveDocuments');

    try {
      const searchRequest = {
        query: request.query || request.text || '',
        type: 'document',
        limit: request.limit || 10,
        threshold: request.threshold || 0.5
      };

      const response = await this.httpClient.post('/graphrag/api/search', searchRequest);
      return response.data?.results || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to retrieve documents:', { error: errorMessage });
      return [];
    }
  }

  async getFullDocument(documentId: string): Promise<any> {
    this.assertTenantContext('getFullDocument');

    try {
      const response = await this.httpClient.get(`/api/documents/${documentId}`);
      return response.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get document:', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  async searchMemories(request: any): Promise<any[]> {
    this.assertTenantContext('searchMemories');

    try {
      // Use unified /api/retrieve/enhanced endpoint
      const response = await this.httpClient.post('/graphrag/api/retrieve/enhanced', {
        query: request.query,
        limit: request.limit || 10,
        includeEpisodic: true,
        includeDocuments: true
      });
      return response.data.unified_memories || response.data || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to search memories:', { error: errorMessage });
      return [];
    }
  }

  async search(request: any): Promise<any[]> {
    this.assertTenantContext('search');

    try {
      if (!request || typeof request !== 'object') {
        logger.warn('Invalid search request format', { request });
        return [];
      }

      let query = request.query;
      if (typeof query !== 'string') {
        if (query && typeof query === 'object') {
          query = query.message || query.error || JSON.stringify(query);
        } else {
          query = String(query || '');
        }
      }

      query = query
        .replace(/Error:.*\n/g, '')
        .replace(/\s+at\s+.*\n/g, '')
        .replace(/[{}\\/]/g, '')
        .trim();

      if (!query || query.length < 2) {
        logger.warn('Query too short or empty after sanitization', {
          originalQuery: request.query,
          sanitized: query
        });
        return [];
      }

      const cleanRequest = {
        query,
        limit: Math.min(request.limit || 10, 100),
        offset: request.offset || 0,
        ...(request.filters && typeof request.filters === 'object' ? { filters: request.filters } : {})
      };

      const response = await this.httpClient.post('/graphrag/api/search', cleanRequest);
      return response.data?.results || response.data?.documents || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to search:', {
        error: errorMessage,
        request: request?.query
      });
      return [];
    }
  }

  async getWebSocketStats(): Promise<any> {
    try {
      const response = await this.httpClient.get('/graphrag/api/websocket/stats');
      return response.data || {
        activeConnections: 0,
        totalMessages: 0,
        uptime: 0,
        status: 'available'
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get WebSocket stats from GraphRAG:', { error: errorMessage });
      return {
        activeConnections: 0,
        totalMessages: 0,
        uptime: process.uptime(),
        status: 'unavailable',
        message: 'WebSocket stats unavailable from GraphRAG service'
      };
    }
  }

  async getModels(): Promise<any> {
    try {
      const response = await this.httpClient.get('/graphrag/api/models');
      return response.data.models || [];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get models:', { error: errorMessage });
      throw new Error(sanitizeErrorMessage(error, false));
    }
  }

  async cleanup(): Promise<void> {
    try {
      logger.info('Cleaning up GraphRAGClient...');

      this.httpAgent.destroy();
      this.httpsAgent.destroy();

      logger.info('GraphRAGClient cleanup complete', {
        httpAgentsDestroyed: true,
        tenantContext: this.tenantContext ? 'present' : 'absent'
      });
    } catch (error) {
      logger.error('Error during GraphRAGClient cleanup', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}

// ============================================================================
// 🔒 SECURITY FIX: Replace Singleton with Factory Function
// ============================================================================

/**
 * Factory function to create GraphRAGClient with tenant context
 *
 * IMPORTANT: Use this factory function instead of global singleton
 * to ensure proper multi-tenant isolation.
 *
 * @param tenantContext - Required tenant context for multi-tenant operations
 * @param endpoint - Optional custom GraphRAG endpoint
 * @returns GraphRAGClient instance with tenant context
 */
export function createGraphRAGClient(
  tenantContext: TenantContext,
  endpoint?: string
): GraphRAGClient {
  return new GraphRAGClient(endpoint, tenantContext);
}

// ⚠️  Legacy singleton for services without tenant context
// Note: Use createGraphRAGClient() for multi-tenant operations
export const graphRAGClient = new GraphRAGClient();
