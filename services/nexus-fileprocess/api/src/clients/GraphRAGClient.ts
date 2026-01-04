/**
 * GraphRAG Client for FileProcessAgent
 *
 * Battle-tested client adapted from MageAgent's GraphRAGClient with:
 * - Circuit breaker pattern for resilience
 * - Connection pooling (50 max sockets, 10 free sockets)
 * - Exponential backoff retry logic
 * - Comprehensive error handling
 *
 * Used for storing Document DNA semantic embeddings and querying related documents.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import http from 'http';
import https from 'https';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface GraphRAGMemoryPayload {
  content: string;
  tags?: string[];
  metadata?: {
    importance?: number;
    context?: string;
    session_id?: string;
    user_id?: string;
    [key: string]: any;
  };
}

export interface GraphRAGDocumentPayload {
  content: string;
  title?: string;
  metadata?: {
    source?: string;
    tags?: string[];
    type?: 'code' | 'markdown' | 'text' | 'structured' | 'multimodal';
    [key: string]: any;
  };
}

export interface GraphRAGEpisodePayload {
  content: string;
  type?: 'user_query' | 'system_response' | 'event' | 'observation' | 'insight';
  metadata?: {
    importance?: number;
    session_id?: string;
    user_id?: string;
    [key: string]: any;
  };
}

export interface GraphRAGQueryPayload {
  query: string;
  limit?: number;
  score_threshold?: number;
}

export interface GraphRAGMemoryResponse {
  success: boolean;
  data?: {
    memory_id: string;
    memoryId?: string;
    [key: string]: any;
  };
  error?: string;
}

export interface GraphRAGRecallResponse {
  success: boolean;
  data?: {
    memories?: Array<{
      id: string;
      content: string;
      score: number;
      metadata?: any;
    }>;
    unified_memories?: Array<{
      id: string;
      content: string;
      score: number;
      metadata?: any;
    }>;
  };
  error?: string;
}

/**
 * Simple circuit breaker implementation
 * Prevents cascading failures when GraphRAG service is down
 */
class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  constructor(
    private readonly threshold: number = 5,
    private readonly timeout: number = 60000 // 1 minute
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
        logger.info('Circuit breaker entering HALF_OPEN state');
      } else {
        throw new Error('Circuit breaker is OPEN - service unavailable');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      logger.info('Circuit breaker reset to CLOSED state');
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      logger.error(`Circuit breaker opened after ${this.failures} failures`);
    }
  }

  getState(): string {
    return this.state;
  }
}

/**
 * GraphRAG Client with resilience patterns
 */
export class GraphRAGClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private readonly baseURL: string;

  constructor() {
    this.baseURL = config.graphragUrl;
    this.circuitBreaker = new CircuitBreaker(5, 60000);

    // HTTP/HTTPS agent with connection pooling
    const httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 60000
    });

    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 60000
    });

    // Create axios instance with connection pooling
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      httpAgent,
      httpsAgent,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Configure exponential backoff retry
    axiosRetry(this.client, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error: AxiosError) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response?.status ? error.response.status >= 500 : false);
      },
      onRetry: (retryCount, error, requestConfig) => {
        logger.warn(`GraphRAG request retry ${retryCount}`, {
          url: requestConfig.url,
          method: requestConfig.method,
          error: error.message
        });
      }
    });

    logger.info('GraphRAGClient initialized', { baseURL: this.baseURL });
  }

  /**
   * Store a memory in GraphRAG
   */
  async storeMemory(payload: GraphRAGMemoryPayload): Promise<GraphRAGMemoryResponse> {
    return this.circuitBreaker.execute(async () => {
      try {
        logger.debug('Storing memory in GraphRAG', {
          contentLength: payload.content.length,
          tags: payload.tags
        });

        // Use unified /api/v2/memory endpoint
        const response = await this.client.post<GraphRAGMemoryResponse>(
          '/api/v2/memory',
          {
            content: payload.content,
            tags: payload.tags,
            metadata: payload.metadata
          }
        );

        if (!response.data.success) {
          throw new Error(response.data.error || 'Failed to store memory');
        }

        logger.info('Memory stored successfully', {
          memoryId: response.data.data?.memory_id || response.data.data?.memoryId
        });

        return response.data;
      } catch (error) {
        const message = this.formatError(error, 'store memory');
        logger.error(message, { payload });
        throw new Error(message);
      }
    });
  }

  /**
   * Store a document in GraphRAG with intelligent chunking
   */
  async storeDocument(payload: GraphRAGDocumentPayload): Promise<GraphRAGMemoryResponse> {
    return this.circuitBreaker.execute(async () => {
      try {
        logger.debug('Storing document in GraphRAG', {
          contentLength: payload.content.length,
          title: payload.title
        });

        const response = await this.client.post<GraphRAGMemoryResponse>(
          '/graphrag/api/documents',
          payload
        );

        if (!response.data.success) {
          throw new Error(response.data.error || 'Failed to store document');
        }

        logger.info('Document stored successfully', {
          documentId: response.data.data?.memory_id || response.data.data?.memoryId
        });

        return response.data;
      } catch (error) {
        const message = this.formatError(error, 'store document');
        logger.error(message, { payload });
        throw new Error(message);
      }
    });
  }

  /**
   * Store an episodic memory in GraphRAG
   */
  async storeEpisode(payload: GraphRAGEpisodePayload): Promise<GraphRAGMemoryResponse> {
    return this.circuitBreaker.execute(async () => {
      try {
        logger.debug('Storing episode in GraphRAG', {
          contentLength: payload.content.length,
          type: payload.type
        });

        // Use unified /api/v2/memory endpoint with forceEpisodicStorage
        const response = await this.client.post<GraphRAGMemoryResponse>(
          '/api/v2/memory',
          {
            content: payload.content,
            episodeType: payload.type,
            metadata: payload.metadata,
            forceEpisodicStorage: true
          }
        );

        if (!response.data.success) {
          throw new Error(response.data.error || 'Failed to store episode');
        }

        logger.info('Episode stored successfully', {
          episodeId: response.data.data?.memory_id || response.data.data?.memoryId
        });

        return response.data;
      } catch (error) {
        const message = this.formatError(error, 'store episode');
        logger.error(message, { payload });
        throw new Error(message);
      }
    });
  }

  /**
   * Recall memories from GraphRAG using semantic search
   */
  async recallMemories(payload: GraphRAGQueryPayload): Promise<GraphRAGRecallResponse> {
    return this.circuitBreaker.execute(async () => {
      try {
        logger.debug('Recalling memories from GraphRAG', {
          query: payload.query,
          limit: payload.limit
        });

        // Use unified /graphrag/api/retrieve/enhanced endpoint
        const response = await this.client.post<GraphRAGRecallResponse>(
          '/graphrag/api/retrieve/enhanced',
          {
            query: payload.query,
            limit: payload.limit || 10,
            includeEpisodic: true,
            includeDocuments: true
          }
        );

        if (!response.data.success) {
          throw new Error(response.data.error || 'Failed to recall memories');
        }

        logger.info('Memories recalled successfully', {
          count: response.data.data?.memories?.length || response.data.data?.unified_memories?.length || 0
        });

        return response.data;
      } catch (error) {
        const message = this.formatError(error, 'recall memories');
        logger.error(message, { payload });
        throw new Error(message);
      }
    });
  }

  /**
   * Search documents in GraphRAG
   */
  async searchDocuments(payload: GraphRAGQueryPayload): Promise<GraphRAGRecallResponse> {
    return this.circuitBreaker.execute(async () => {
      try {
        logger.debug('Searching documents in GraphRAG', {
          query: payload.query,
          limit: payload.limit
        });

        const response = await this.client.post<GraphRAGRecallResponse>(
          '/graphrag/api/documents/search',
          payload
        );

        if (!response.data.success) {
          throw new Error(response.data.error || 'Failed to search documents');
        }

        logger.info('Documents searched successfully', {
          count: response.data.data?.memories?.length || 0
        });

        return response.data;
      } catch (error) {
        const message = this.formatError(error, 'search documents');
        logger.error(message, { payload });
        throw new Error(message);
      }
    });
  }

  /**
   * Health check for GraphRAG service
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health', { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      logger.warn('GraphRAG health check failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /**
   * Get circuit breaker state for monitoring
   */
  getCircuitBreakerState(): string {
    return this.circuitBreaker.getState();
  }

  /**
   * Format error messages with context
   */
  private formatError(error: unknown, operation: string): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data;
      const message = data?.error || data?.message || error.message;

      return `GraphRAG ${operation} failed (HTTP ${status || 'unknown'}): ${message}`;
    }

    if (error instanceof Error) {
      return `GraphRAG ${operation} failed: ${error.message}`;
    }

    return `GraphRAG ${operation} failed: ${String(error)}`;
  }
}

// Singleton instance
let graphRAGClientInstance: GraphRAGClient | null = null;

/**
 * Get or create the singleton GraphRAG client instance
 */
export function getGraphRAGClient(): GraphRAGClient {
  if (!graphRAGClientInstance) {
    graphRAGClientInstance = new GraphRAGClient();
  }
  return graphRAGClientInstance;
}
