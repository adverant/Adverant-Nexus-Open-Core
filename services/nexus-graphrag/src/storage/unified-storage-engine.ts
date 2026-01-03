import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { toPostgresArray } from '../utils/postgres-helpers';
import { EnhancedTenantContext } from '../middleware/tenant-context';
import {
  Memory,
  MemoryStorageRequest,
  MemoryRecallResult,
  MemoryListResult,
  MemoryStorageResult,
  UnifiedStorageConfig,
  UnifiedSearchRequest,
  UnifiedSearchResult,
  DocumentMetadata,
  Chunk
} from '../types';
import { SagaCoordinator, SagaStep, createSaga } from './saga-coordinator';
import { DatabaseOperations } from './database-operations';
import { RollbackHandlers } from './rollback-handlers';
import { EmbeddingCache } from '../utils/cache';

export class UnifiedStorageEngine {
  private voyageClient: any;
  private qdrantClient: any;
  private neo4jDriver: any;
  private postgresPool: any;
  private redisCache: any;
  private dbOperations: DatabaseOperations;
  private rollbackHandlers: RollbackHandlers;
  private embeddingCache: EmbeddingCache | null = null;

  constructor(config: UnifiedStorageConfig) {
    this.voyageClient = config.voyageClient;
    this.qdrantClient = config.qdrantClient;
    this.neo4jDriver = config.neo4jDriver;
    this.postgresPool = config.postgresPool;
    this.redisCache = config.redisCache;

    // Initialize saga pattern components
    this.dbOperations = new DatabaseOperations(
      this.postgresPool,
      this.qdrantClient,
      this.neo4jDriver,
      this.voyageClient
    );

    this.rollbackHandlers = new RollbackHandlers(
      this.postgresPool,
      this.qdrantClient,
      this.neo4jDriver
    );

    // PERFORMANCE: Initialize embedding cache if Redis is available
    // This is the KEY optimization to achieve <200ms store latency
    // Cache hit: ~1ms vs Cache miss: ~150-300ms (Voyage API)
    if (this.redisCache) {
      try {
        this.embeddingCache = new EmbeddingCache(this.redisCache, 86400); // 24h TTL
        this.dbOperations.setEmbeddingCache(this.embeddingCache);
        logger.info('[STORAGE-ENGINE] EmbeddingCache initialized for fast storage', {
          ttlSeconds: 86400,
          target: 'Reduce store latency from 1800ms to <200ms'
        });
      } catch (cacheError: any) {
        logger.warn('[STORAGE-ENGINE] Failed to initialize EmbeddingCache, using direct Voyage calls', {
          error: cacheError.message
        });
      }
    } else {
      logger.warn('[STORAGE-ENGINE] Redis not available, EmbeddingCache disabled - store latency will be ~300ms higher');
    }
  }

  // ========== MEMORY OPERATIONS ==========

  async storeMemory(
    request: MemoryStorageRequest,
    tenantContext: EnhancedTenantContext,
    idempotencyKey?: string
  ): Promise<MemoryStorageResult> {
    const memoryId = uuidv4();
    const timestamp = new Date().toISOString();

    try {
      // Ensure content is always a string
      const contentString = typeof request.content === 'string' ? request.content : JSON.stringify(request.content);

      // IMPORTANCE-BASED RANKING (NOT FILTERING)
      // Store ALL content - use importance for ranking, not for filtering
      // Default importance: 0.5 (medium). Higher values will rank better in search results.
      const importance = request.metadata?.importance ?? 0.5;

      logger.debug('Storing memory with importance-based ranking', {
        memoryId,
        importance,
        contentLength: contentString.length,
        contentPreview: contentString.substring(0, 100),
        idempotencyKey
      });

      // Create memory object with string content
      // Importance is preserved in metadata for ranking during retrieval
      const memory: Memory = {
        id: memoryId,
        content: contentString,
        tags: request.tags || [],
        timestamp,
        metadata: {
          ...request.metadata,
          source: 'unified-graphrag',
          contentLength: contentString.length,
          importance, // Used for ranking, not filtering
          storedAt: timestamp
        }
      };

      // Determine if this is a small memory or needs chunking
      const tokens = this.estimateTokens(contentString);

      if (tokens <= 500) {
        // Store as single memory chunk using Saga pattern
        await this.storeSmallMemory(memory, tenantContext, idempotencyKey);
      } else {
        // Store as micro-document with minimal chunking
        await this.storeMemoryAsDocument(memory, tenantContext, idempotencyKey);
      }

      // Store in Redis for fast access
      await this.cacheMemory(memory);

      // Note: Memories are indexed in unified_content table,
      // no need for separate search_index entry

      logger.info('Memory stored successfully', { memoryId, tokens, idempotencyKey });

      return {
        success: true,
        id: memoryId,
        message: 'Memory stored successfully'
      };

    } catch (error) {
      logger.error('Failed to store memory', { error, memoryId, idempotencyKey });
      throw error;
    }
  }

  async recallMemories(query: string, tenantContext: EnhancedTenantContext, options: any = {}): Promise<MemoryRecallResult[]> {
    const { limit = 5, includeMetadata = true } = options;

    // Validate input parameters
    if (!query || typeof query !== 'string') {
      throw new Error(`Invalid query parameter: Expected non-empty string, received ${typeof query}`);
    }

    if (limit < 1 || limit > 100) {
      throw new Error(`Invalid limit parameter: Must be between 1 and 100, received ${limit}`);
    }

    // Detect page number queries (e.g., "page 231", "show me page 5", "page number 42")
    const pageNumberMatch = query.match(/(?:show\s+(?:me\s+)?)?page\s*(?:number\s*)?(\d+)/i);
    const requestedPageNumber = pageNumberMatch ? parseInt(pageNumberMatch[1], 10) : null;

    if (requestedPageNumber !== null) {
      logger.info('Page number query detected', {
        query: query.substring(0, 100),
        requestedPageNumber
      });
    }

    // Verify embedding client availability
    if (!this.voyageClient || !this.voyageClient.generateEmbedding) {
      throw new Error(
        'VoyageAI client not initialized or generateEmbedding method unavailable. ' +
        'Check VOYAGE_API_KEY environment variable and client initialization.'
      );
    }

    // Generate query embedding
    let queryEmbedding: number[] = [];
    let useTextSearch = false;
    try {
      // Use 'query' type for search queries - VoyageAI optimizes differently for queries vs documents
      const embeddingResult = await this.voyageClient.generateEmbedding(query, {
        inputType: 'query'  // Correct type for search operations
      });
      queryEmbedding = embeddingResult.embedding;  // Extract embedding array from result object
    } catch (embeddingError: any) {
      // Graceful degradation: Fall back to text search when embeddings unavailable
      logger.warn('Failed to generate query embedding, falling back to text search', {
        error: embeddingError.message,
        query: query.substring(0, 100),
        fallbackMode: 'text-only'
      });
      useTextSearch = true;
    }

    // Search in Qdrant vector database
    let searchResults: any[];
    try {
      if (useTextSearch) {
        // Text-based search fallback when embeddings unavailable
        // Searches BOTH memories AND document chunks
        logger.info('Performing text-based search (embeddings unavailable)');
        searchResults = await this.qdrantClient.scroll('unified_content', {
          limit: limit,
          with_payload: true,
          filter: {
            must: [
              {
                key: 'content',
                match: { text: query.toLowerCase() }
              }
            ],
            should: [
              // Match user's memories
              {
                must: [
                  { key: 'content_type', match: { value: 'memory' } },
                  { key: 'company_id', match: { value: tenantContext.companyId } },
                  { key: 'app_id', match: { value: tenantContext.appId } },
                  { key: 'user_id', match: { value: tenantContext.userId } }
                ]
              },
              // Match system memories
              {
                must: [
                  { key: 'content_type', match: { value: 'memory' } },
                  { key: 'company_id', match: { value: tenantContext.companyId } },
                  { key: 'app_id', match: { value: tenantContext.appId } },
                  { key: 'user_id', match: { value: 'system' } }
                ]
              },
              // Match document chunks (system-level)
              {
                must: [
                  { key: 'content_type', match: { value: 'document_chunk' } }
                ]
              }
            ]
          }
        }).then((result: any) => result.points || []);

        // Add mock scores for text search results
        searchResults = searchResults.map((point: any) => ({
          ...point,
          score: 0.5 // Default score for text matches
        }));
      } else if (requestedPageNumber !== null) {
        // PAGE-SPECIFIC SEARCH: Strict filtering by page number (no semantic fallback)
        // Only searches document chunks with the exact page number
        logger.info('Executing page-specific search', { requestedPageNumber });

        searchResults = await this.qdrantClient.search('unified_content', {
          vector: queryEmbedding,
          limit: limit,
          with_payload: true,
          score_threshold: 0.0,  // No threshold - we want all content from this page
          filter: {
            must: [
              { key: 'content_type', match: { value: 'document_chunk' } },
              { key: 'page_number', match: { value: requestedPageNumber } }
            ]
          }
        });

        // If no results found for this page, return empty with informative message
        if (!searchResults || searchResults.length === 0) {
          logger.info('No content found for requested page', { requestedPageNumber });
          return [{
            id: `no-results-page-${requestedPageNumber}`,
            content: `No content found for page ${requestedPageNumber}. The page may not exist in any ingested documents, or the document may need to be re-ingested with page number support.`,
            relevanceScore: 0,
            metadata: {
              timestamp: new Date().toISOString(),
              tags: [],
              pageNumber: requestedPageNumber,
              noResults: true
            }
          }];
        }
      } else {
        // Vector-based semantic search (preferred)
        // Searches BOTH episodic memories AND document chunks for unified recall
        searchResults = await this.qdrantClient.search('unified_content', {
          vector: queryEmbedding,  // Search uses 'vector' (singular) - now contains just the embedding array
          limit: limit * 2,  // Fetch more to account for filtering
          with_payload: true,
          score_threshold: 0.15,  // LOWERED from 0.3 for better recall with asymmetric embeddings
          filter: {
            // Content must match tenant context OR be a document chunk
            should: [
              // Match user's memories
              {
                must: [
                  { key: 'content_type', match: { value: 'memory' } },
                  { key: 'company_id', match: { value: tenantContext.companyId } },
                  { key: 'app_id', match: { value: tenantContext.appId } },
                  { key: 'user_id', match: { value: tenantContext.userId } }
                ]
              },
              // Match system memories
              {
                must: [
                  { key: 'content_type', match: { value: 'memory' } },
                  { key: 'company_id', match: { value: tenantContext.companyId } },
                  { key: 'app_id', match: { value: tenantContext.appId } },
                  { key: 'user_id', match: { value: 'system' } }
                ]
              },
              // Match document chunks (system-level, shared across all users)
              {
                must: [
                  { key: 'content_type', match: { value: 'document_chunk' } }
                ]
              }
            ]
          }
        });

        // DIAGNOSTIC: Log empty results for debugging
        if (!searchResults || searchResults.length === 0) {
          logger.warn('Memory recall returned empty results from Qdrant vector search', {
            query: query.substring(0, 100),
            tenantContext: {
              companyId: tenantContext.companyId,
              appId: tenantContext.appId,
              userId: tenantContext.userId
            },
            embeddingDimensions: queryEmbedding?.length,
            scoreThreshold: 0.15,
            suggestion: 'Check Qdrant collection unified_content for matching tenant data'
          });
        }
      }
    } catch (qdrantError: any) {
      console.error('QDRANT SEARCH ERROR:', JSON.stringify({
        message: qdrantError.message,
        status: qdrantError.status,
        data: qdrantError.data,
        searchMode: useTextSearch ? 'text' : 'vector',
        embedding_length: queryEmbedding?.length
      }, null, 2));

      throw new Error(
        `Qdrant ${useTextSearch ? 'text' : 'vector'} search failed: ${qdrantError.message}. ` +
        `Collection: 'unified_content', Filter: content_type='memory'. ` +
        (useTextSearch ? '' : `Embedding dimensions: ${queryEmbedding?.length}. `) +
        `Verify Qdrant service is running and collection exists with proper schema.`
      );
    }

    // FALLBACK: If vector search returns empty, try PostgreSQL text search
    // Searches BOTH memories AND document chunks
    if ((!searchResults || searchResults.length === 0) && !useTextSearch) {
      logger.info('Vector search empty, falling back to PostgreSQL text search', {
        query: query.substring(0, 100),
        tenantContext: { companyId: tenantContext.companyId, appId: tenantContext.appId }
      });

      const client = await this.postgresPool.connect();
      try {
        // Search memories (user-scoped) and document chunks (system-level)
        const pgResult = await client.query(`
          SELECT id, content, tags, metadata, content_type, created_at as timestamp
          FROM graphrag.unified_content
          WHERE (
            -- User's memories
            (content_type = 'memory' AND company_id = $1 AND app_id = $2 AND (user_id = $3 OR user_id = 'system'))
            OR
            -- Document chunks (system-level, shared)
            (content_type = 'document_chunk')
          )
          AND (content ILIKE $4 OR content ILIKE $5)
          ORDER BY created_at DESC
          LIMIT $6
        `, [
          tenantContext.companyId,
          tenantContext.appId,
          tenantContext.userId,
          `%${query}%`,
          `%${query.split(' ').slice(0, 3).join('%')}%`,  // Match first 3 words with wildcards
          limit
        ]);

        if (pgResult.rows.length > 0) {
          searchResults = pgResult.rows.map(row => ({
            id: row.id,
            payload: {
              content: row.content,
              content_type: row.content_type,
              tags: row.tags,
              metadata: row.metadata,
              timestamp: row.timestamp
            },
            score: 0.5  // Default score for text matches
          }));
          logger.info(`PostgreSQL fallback found ${searchResults.length} results`, {
            query: query.substring(0, 50),
            memoryCount: searchResults.filter(r => r.payload.content_type === 'memory').length,
            documentChunkCount: searchResults.filter(r => r.payload.content_type === 'document_chunk').length
          });
        }
      } catch (pgError: any) {
        logger.warn('PostgreSQL fallback search failed', {
          error: pgError.message,
          query: query.substring(0, 50)
        });
        // Don't throw - just return empty results if both searches fail
      } finally {
        client.release();
      }
    }

    if (searchResults.length === 0) {
      logger.warn(`No memories found matching query: "${query}". Score threshold: 0.15`);
      return [];
    }

    // Optional: Apply VoyageAI reranking for improved relevance when we have enough results
    // Reranking is most effective when there are multiple candidates to reorder
    const enableReranking = options.rerank !== false && searchResults.length >= 3;

    if (enableReranking && this.voyageClient.rerank) {
      try {
        const startTime = Date.now();
        const documents = searchResults.map(r => r.payload?.content || '').filter(c => c.length > 0);

        if (documents.length >= 3) {
          const rerankedResults = await this.voyageClient.rerank(query, documents, limit);

          // Reorder searchResults based on reranking
          const reorderedResults = rerankedResults.map(rr => {
            const original = searchResults[rr.index];
            return {
              ...original,
              score: rr.score,  // Use rerank score as primary score
              originalVectorScore: original.score  // Preserve original for debugging
            };
          });

          searchResults = reorderedResults;

          logger.info('Memory recall reranking completed', {
            query: query.substring(0, 50),
            originalCount: documents.length,
            rerankLatencyMs: Date.now() - startTime
          });
        }
      } catch (rerankError: any) {
        // Graceful degradation: continue with vector scores if reranking fails
        logger.warn('Memory reranking failed, using vector scores', {
          error: rerankError.message
        });
      }
    }

    // Transform results and apply importance-based ranking boost
    // Handles BOTH memories AND document chunks with unified result format
    const memories: MemoryRecallResult[] = searchResults.map(result => {
      if (!result.payload || !result.payload.content) {
        throw new Error(
          `Invalid payload structure in Qdrant result. ` +
          `Expected payload.content, received: ${JSON.stringify(result.payload).substring(0, 200)}`
        );
      }

      // Apply importance boost to relevance score
      // Importance range: 0.0-1.0, boost multiplier: 1.0-1.5
      const importance = result.payload.metadata?.importance ?? 0.5;
      const importanceBoost = 1.0 + (importance * 0.5); // 1.0-1.5x boost
      const boostedScore = result.score * importanceBoost;

      // Determine content type (memory or document_chunk)
      const contentType = result.payload.content_type || 'memory';
      const isDocumentChunk = contentType === 'document_chunk';

      return {
        id: result.id as string,
        content: result.payload.content,
        relevanceScore: Math.min(boostedScore, 1.0), // Cap at 1.0
        metadata: {
          timestamp: result.payload.timestamp || new Date().toISOString(),
          tags: result.payload.tags || [],
          importance,
          vectorScore: result.originalVectorScore || result.score, // Original vector similarity score
          rerankScore: result.originalVectorScore ? result.score : undefined, // Rerank score if applied
          boost: importanceBoost,
          reranked: !!result.originalVectorScore, // Flag indicating reranking was applied
          // Content type identification
          contentType,
          // Document chunk specific fields (for navigation and context viewing)
          ...(isDocumentChunk ? {
            documentId: result.payload.document_id,
            chunkId: result.payload.chunk_id,
            pageNumber: result.payload.page_number,
            position: result.payload.position,  // { start, end } for text highlighting
            chunkType: result.payload.type,     // paragraph, heading, code_block, etc.
            tokens: result.payload.tokens,
            // Link to view full document context
            documentLink: result.payload.document_id
              ? `/api/documents/${result.payload.document_id}/context?chunkId=${result.payload.chunk_id}`
              : undefined,
            // Direct link to view specific page in document (for PDFs and multi-page docs)
            pageLink: result.payload.document_id && result.payload.page_number
              ? `/api/documents/${result.payload.document_id}/page/${result.payload.page_number}`
              : undefined,
            // Artifact references for permanent file storage
            artifactId: result.payload.artifact_id,
            artifactUrl: result.payload.artifact_url,
            storageBackend: result.payload.storage_backend,
            // PDF viewer URL with page anchor for direct viewing
            pdfViewerUrl: this.generatePdfViewerUrl(result.payload.artifact_url, result.payload.page_number)
          } : {}),
          ...(includeMetadata ? result.payload.metadata || {} : {})
        }
      };
    });

    // Re-sort by boosted relevance score
    memories.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // Count result types for logging
    const memoryCount = memories.filter(m => m.metadata.contentType === 'memory').length;
    const documentChunkCount = memories.filter(m => m.metadata.contentType === 'document_chunk').length;

    logger.info(`Successfully recalled ${memories.length} results for query: "${query}"`, {
      topScore: memories[0]?.relevanceScore,
      memoryCount,
      documentChunkCount,
      avgImportance: memories.reduce((sum, m) => sum + (m.metadata.importance || 0.5), 0) / memories.length
    });
    return memories;
  }

  async getMemoryById(id: string, tenantContext: EnhancedTenantContext): Promise<Memory | null> {
    // Validate input
    if (!id || typeof id !== 'string') {
      throw new Error(`Invalid memory ID: Expected non-empty string, received ${typeof id}`);
    }

    const client = await this.postgresPool.connect();
    try {
      // Set tenant context for RLS
      await client.query(
        'SELECT graphrag.set_tenant_context($1, $2, $3)',
        [tenantContext.companyId, tenantContext.appId, tenantContext.userId]
      );

      // Retrieve single memory by ID
      // SECURITY: Filter by company_id, app_id, AND user_id for multi-tenant isolation
      logger.info('[SECURITY DEBUG] getMemoryById query parameters:', {
        id,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId
      });

      const result = await client.query(`
        SELECT
          id,
          content,
          user_id,
          tags,
          metadata,
          created_at,
          updated_at
        FROM graphrag.unified_content
        WHERE id = $1
        AND content_type = 'memory'
        AND company_id = $2
        AND app_id = $3
        AND (user_id = $4 OR user_id = 'system')
      `, [id, tenantContext.companyId, tenantContext.appId, tenantContext.userId]);

      logger.info('[SECURITY DEBUG] getMemoryById query result:', {
        rowCount: result.rows.length,
        found: result.rows.length > 0
      });

      if (result.rows.length === 0) {
        logger.debug(`Memory not found: ${id}`);
        return null;
      }

      const row = result.rows[0];

      if (!row.id || !row.content) {
        throw new Error(
          `Invalid memory data in unified_content table. ` +
          `Row must have 'id' and 'content' fields. ` +
          `Received: ${JSON.stringify(row).substring(0, 200)}`
        );
      }

      const memory: Memory = {
        id: row.id,
        content: row.content,
        userId: row.user_id,
        tags: Array.isArray(row.tags) ? row.tags : [],
        timestamp: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date().toISOString(),
        metadata: row.metadata || {}
      };

      logger.info(`Successfully retrieved memory: ${id}`);
      return memory;

    } catch (error: any) {
      logger.error('Failed to retrieve memory by ID', { error, id });
      throw new Error(
        `Failed to retrieve memory from PostgreSQL: ${error.message}. ` +
        `Memory ID: ${id}. ` +
        `Ensure PostgreSQL connection is valid and unified_content table has proper schema.`
      );
    } finally {
      client.release();
    }
  }

  async listMemories(tenantContext: EnhancedTenantContext, options: { limit?: number; offset?: number } = {}): Promise<MemoryListResult> {
    const { limit = 100, offset = 0 } = options;

    // Validate parameters
    if (limit < 1 || limit > 1000) {
      throw new Error(`Invalid limit parameter: Must be between 1 and 1000, received ${limit}`);
    }

    if (offset < 0) {
      throw new Error(`Invalid offset parameter: Must be non-negative, received ${offset}`);
    }

    const client = await this.postgresPool.connect();
    try {
      // Set tenant context for RLS
      await client.query(
        'SELECT graphrag.set_tenant_context($1, $2, $3)',
        [tenantContext.companyId, tenantContext.appId, tenantContext.userId]
      );

      // Verify table exists (check both public and graphrag schemas)
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE (table_schema = 'public' OR table_schema = 'graphrag')
          AND table_name = 'unified_content'
        )
      `);

      if (!tableCheck.rows[0].exists) {
        throw new Error(
          'Table "unified_content" does not exist in PostgreSQL database. ' +
          'Run database migrations or initialization script to create required schema.'
        );
      }

      // Get memories from unified content table (use graphrag schema)
      // Filter by user_id for user-level isolation
      const result = await client.query(`
        SELECT
          id,
          content,
          user_id,
          tags,
          metadata,
          created_at,
          updated_at
        FROM graphrag.unified_content
        WHERE content_type = 'memory'
        AND user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `, [tenantContext.userId, limit, offset]);

      // Get total count with user filtering
      const countResult = await client.query(`
        SELECT COUNT(*) as total FROM graphrag.unified_content
        WHERE content_type = 'memory'
        AND user_id = $1
      `, [tenantContext.userId]);

      const memories: Memory[] = result.rows.map((row: any) => {
        if (!row.id || !row.content) {
          throw new Error(
            `Invalid row data in unified_content table. ` +
            `Row must have 'id' and 'content' fields. ` +
            `Received: ${JSON.stringify(row).substring(0, 200)}`
          );
        }

        return {
          id: row.id,
          content: row.content,
          userId: row.user_id,
          tags: Array.isArray(row.tags) ? row.tags : [],
          timestamp: row.created_at instanceof Date
            ? row.created_at.toISOString()
            : new Date().toISOString(),
          metadata: row.metadata || {}
        };
      });

      const total = parseInt(countResult.rows[0].total) || 0;

      logger.info(`Successfully listed ${memories.length} memories (offset: ${offset}, total: ${total})`);

      return {
        items: memories,
        total
      };

    } catch (error: any) {
      // Enhance error with context
      throw new Error(
        `Failed to list memories from PostgreSQL: ${error.message}. ` +
        `Query parameters: limit=${limit}, offset=${offset}. ` +
        `Ensure PostgreSQL connection is valid and unified_content table has proper schema.`
      );
    } finally {
      client.release();
    }
  }

  // ========== UNIFIED SEARCH ==========

  async unifiedSearch(request: UnifiedSearchRequest, tenantContext: EnhancedTenantContext): Promise<UnifiedSearchResult> {
    const { query, contentTypes = ['all'], limit = 20, options: _options = {} } = request;

    // Validate input parameters
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error(`Invalid query parameter: Expected non-empty string, received "${query}"`);
    }

    if (limit < 1 || limit > 100) {
      throw new Error(`Invalid limit parameter: Must be between 1 and 100, received ${limit}`);
    }

    const validTypes = ['all', 'memory', 'document', 'chunk'];
    for (const type of contentTypes) {
      if (!validTypes.includes(type)) {
        throw new Error(
          `Invalid content type: "${type}". ` +
          `Valid types are: ${validTypes.join(', ')}`
        );
      }
    }

    // Verify required services
    if (!this.voyageClient || !this.voyageClient.generateEmbedding) {
      throw new Error(
        'VoyageAI client not initialized. ' +
        'Unified search requires embedding generation capability. ' +
        'Check VOYAGE_API_KEY environment variable.'
      );
    }

    if (!this.qdrantClient) {
      throw new Error(
        'Qdrant client not initialized. ' +
        'Verify Qdrant service is running and connection parameters are correct.'
      );
    }

    // Generate query embedding
    let queryEmbedding: number[];
    try {
      // Use 'query' type for search queries - VoyageAI optimizes differently for queries vs documents
      const embeddingResult = await this.voyageClient.generateEmbedding(query, {
        inputType: 'query'  // Correct type for search operations
      });
      queryEmbedding = embeddingResult.embedding;  // Extract embedding array from result object
    } catch (embeddingError: any) {
      throw new Error(
        `Failed to generate search embedding: ${embeddingError.message}. ` +
        `Query: "${query.substring(0, 100)}...". ` +
        `VoyageAI service may be unavailable or rate limited.`
      );
    }

    // Build filter based on content types and tenant context
    const filter = this.buildContentTypeFilter(contentTypes, tenantContext);

    // Execute vector search
    let searchResults: any[];
    try {
      searchResults = await this.qdrantClient.search('unified_content', {
        vector: queryEmbedding,  // Search uses 'vector' (singular)
        limit: limit,
        with_payload: true,
        score_threshold: 0.3,  // Lowered from 0.7 for better recall
        filter
      });
    } catch (qdrantError: any) {
      throw new Error(
        `Qdrant unified search failed: ${qdrantError.message}. ` +
        `Collection: 'unified_content', Content types: ${contentTypes.join(', ')}. ` +
        `Verify collection exists and has proper vector dimensions (${queryEmbedding.length}).`
      );
    }

    // Apply reranking if available
    if (searchResults.length > 0 && this.voyageClient.rerank) {
      try {
        const documents = searchResults.map(r => {
          if (!r.payload || !r.payload.content) {
            throw new Error(
              `Invalid Qdrant result payload: Missing content field. ` +
              `ID: ${r.id}, Payload: ${JSON.stringify(r.payload).substring(0, 100)}`
            );
          }
          return r.payload.content;
        });

        const reranked = await this.voyageClient.rerank(query, documents, limit);
        searchResults = reranked.map((r: any) => searchResults[r.index]);
      } catch (rerankError: any) {
        throw new Error(
          `Reranking failed: ${rerankError.message}. ` +
          `This may indicate an issue with the VoyageAI rerank model. ` +
          `Query: "${query.substring(0, 50)}...", Documents: ${searchResults.length}`
        );
      }
    }

    // Format and validate results
    const items = searchResults.map(result => {
      if (!result.payload) {
        throw new Error(
          `Invalid search result: Missing payload. ` +
          `Result ID: ${result.id}, Score: ${result.score}`
        );
      }

      const contentType = result.payload.content_type || 'document';
      // Normalize document_chunk to chunk for consistency
      const normalizedType = contentType === 'document_chunk' ? 'chunk' : contentType;
      if (!['memory', 'document', 'chunk'].includes(normalizedType)) {
        throw new Error(
          `Invalid content_type in search result: "${contentType}". ` +
          `Expected one of: memory, document, chunk, document_chunk. ` +
          `Result ID: ${result.id}`
        );
      }

      return {
        id: result.id as string,
        type: normalizedType as 'memory' | 'document' | 'chunk',
        content: result.payload.content || '',
        relevance: result.score,
        metadata: result.payload
      };
    });

    // Calculate statistics
    const memoriesCount = items.filter(i => i.type === 'memory').length;
    const documentsCount = items.filter(i => i.type === 'document' || i.type === 'chunk').length;

    logger.info(
      `Unified search completed: Query="${query.substring(0, 50)}...", ` +
      `Results=${items.length}, Memories=${memoriesCount}, Documents=${documentsCount}`
    );

    return {
      items,
      memoriesCount,
      documentsCount,
      contentTypes: [...new Set(items.map(i => i.type))]
    };
  }

  // ========== PRIVATE HELPER METHODS ==========

  private async storeSmallMemory(
    memory: Memory,
    tenantContext: EnhancedTenantContext,
    idempotencyKey?: string
  ): Promise<void> {
    // Create saga coordinator
    const saga = createSaga(logger, `store-memory-${memory.id}`);

    // Track results for compensating transactions
    let postgresResult: any = null;
    let embeddingResult: { embedding: number[]; model: string } | null = null;
    let qdrantResult: any = null;
    let neo4jResult: any = null;

    // Detect content type for proper model selection
    const contentType = this.voyageClient?.detectContentType ?
      this.voyageClient.detectContentType(memory.content) :
      'text';

    // Define saga steps with compensating transactions
    const steps: SagaStep[] = [
      // STEP 1: Generate Embedding (MANDATORY - Fail Fast if Unavailable)
      {
        name: 'generate-embedding',
        execute: async () => {
          // CRITICAL: Voyage client is REQUIRED for production GraphRAG functionality
          // Silent failures prevented observability and caused zero API activity
          if (!this.voyageClient) {
            const error = new Error(
              'CRITICAL: Voyage AI client is not initialized. ' +
              'GraphRAG cannot function without embedding generation. ' +
              'This indicates a system configuration error. ' +
              'Check: (1) VOYAGE_API_KEY environment variable, ' +
              '(2) VoyageAIClient initialization in api.ts, ' +
              '(3) UnifiedStorageEngine constructor received valid client.'
            );
            logger.error('[VOYAGE-CLIENT-MISSING] Voyage AI client unavailable - CANNOT GENERATE EMBEDDINGS', {
              memoryId: memory.id,
              error: error.message,
              severity: 'CRITICAL',
              impact: 'Memory storage will fail - embeddings are mandatory',
              timestamp: new Date().toISOString()
            });
            throw error; // FAIL FAST - Do not silently degrade
          }

          // PHASE 1.2: Remove Silent Fallback - Embeddings are MANDATORY
          // No try-catch around embedding generation - let errors propagate
          // This ensures data integrity by preventing storage of incomplete records
          embeddingResult = await this.dbOperations.generateEmbedding(
            memory.content,
            contentType
          );
          logger.info('[SAGA] Embedding generated successfully', {
            memoryId: memory.id,
            model: embeddingResult.model,
            dimensions: embeddingResult.embedding.length,
            timestamp: new Date().toISOString()
          });
          return embeddingResult;
        },
        compensate: async () => {
          // No compensation needed - embedding generation has no side effects
          logger.debug('[SAGA] No compensation needed for embedding generation');
        },
        isIdempotent: true,
        timeout: 30000,
        retries: { maxAttempts: 2, backoffMs: 1000 }
      },

      // STEP 2: Store in PostgreSQL (PRIMARY DATA STORE)
      {
        name: 'store-postgres',
        execute: async () => {
          postgresResult = await this.dbOperations.storeInPostgres(
            memory,
            tenantContext,
            idempotencyKey
          );
          logger.info('[SAGA] Memory stored in PostgreSQL', {
            memoryId: memory.id,
            inserted: postgresResult.inserted,
            updated: postgresResult.updated
          });
          return postgresResult;
        },
        compensate: async () => {
          logger.info('[SAGA] Compensating PostgreSQL storage', { memoryId: memory.id });
          await this.rollbackHandlers.rollbackPostgres(memory.id, tenantContext);
        },
        isIdempotent: true,
        timeout: 30000,
        retries: { maxAttempts: 3, backoffMs: 1000 }
      },

      // STEP 3: Store in Qdrant (VECTOR STORE) - Only if embedding exists
      {
        name: 'store-qdrant',
        execute: async () => {
          if (!embeddingResult || !this.qdrantClient) {
            logger.info('[SAGA] Skipping Qdrant storage (no embedding or client unavailable)', {
              memoryId: memory.id,
              hasEmbedding: !!embeddingResult,
              hasClient: !!this.qdrantClient
            });
            return null;
          }

          qdrantResult = await this.dbOperations.storeInQdrant(
            memory,
            embeddingResult.embedding,
            tenantContext
          );
          logger.info('[SAGA] Memory vector stored in Qdrant', {
            memoryId: memory.id,
            status: qdrantResult.status
          });

          // ASYNC VERIFICATION: Fire-and-forget to avoid blocking response
          // Qdrant storage is already complete; verification is just for logging/monitoring
          // This reduces latency by ~100-400ms per request
          setImmediate(() => {
            this.dbOperations.verifyQdrantPointWithRetry(memory.id, 2, 50).then(verified => {
              if (!verified) {
                logger.warn('[SAGA] Qdrant async verification failed - may have indexing delay', {
                  memoryId: memory.id,
                  suggestion: 'Memory will be searchable after Qdrant completes indexing'
                });
              }
            }).catch(err => {
              logger.debug('[SAGA] Qdrant verification error (non-blocking)', {
                memoryId: memory.id,
                error: err.message
              });
            });
          });

          return qdrantResult;
        },
        compensate: async () => {
          if (qdrantResult) {
            logger.info('[SAGA] Compensating Qdrant storage', { memoryId: memory.id });
            await this.rollbackHandlers.rollbackQdrant(memory.id);
          }
        },
        isIdempotent: true,
        timeout: 30000,
        retries: { maxAttempts: 3, backoffMs: 1000 }
      },

      // STEP 4: Store in Neo4j (GRAPH STORE) - Only if driver available
      {
        name: 'store-neo4j',
        execute: async () => {
          if (!this.neo4jDriver) {
            logger.info('[SAGA] Skipping Neo4j storage (driver not available)', {
              memoryId: memory.id
            });
            return null;
          }

          neo4jResult = await this.dbOperations.storeInNeo4j(memory, tenantContext);
          logger.info('[SAGA] Memory node stored in Neo4j', {
            memoryId: memory.id,
            nodesCreated: neo4jResult.nodesCreated
          });

          // Link to related memories
          if (this.neo4jDriver) {
            const session = this.neo4jDriver.session();
            try {
              await this.linkRelatedMemories(session, memory, tenantContext);
            } finally {
              await session.close();
            }
          }

          return neo4jResult;
        },
        compensate: async () => {
          if (neo4jResult) {
            logger.info('[SAGA] Compensating Neo4j storage', { memoryId: memory.id });
            await this.rollbackHandlers.rollbackNeo4j(memory.id, tenantContext);
          }
        },
        isIdempotent: true,
        timeout: 30000,
        retries: { maxAttempts: 3, backoffMs: 1000 }
      }
    ];

    // Execute saga with automatic rollback on failure
    const result = await saga.execute(steps);

    if (!result.success) {
      // Saga failed and rolled back
      const error = result.error || new Error('Saga execution failed');
      logger.error('[SAGA] Memory storage saga failed', {
        memoryId: memory.id,
        error: error.message,
        context: result.context
      });
      throw error;
    }

    // Success - log final state
    logger.info('[SAGA] Memory storage saga completed successfully', {
      memoryId: memory.id,
      totalDuration: Date.now() - result.context.startTime,
      stepsCompleted: result.context.completedSteps.length,
      databases: {
        postgres: !!postgresResult,
        qdrant: !!qdrantResult,
        neo4j: !!neo4jResult
      }
    });
  }

  private async storeMemoryAsDocument(
    memory: Memory,
    tenantContext: EnhancedTenantContext,
    idempotencyKey?: string
  ): Promise<void> {
    // For larger memories, store as a mini-document with basic chunking
    // Ensure content is a string
    const contentString = typeof memory.content === 'string' ? memory.content : JSON.stringify(memory.content);
    const metadata: DocumentMetadata = {
      title: `Memory: ${contentString.substring(0, 50)}...`,
      type: 'text',
      format: 'text',
      size: contentString.length,
      hash: this.computeHash(contentString),
      created_at: memory.timestamp,
      updated_at: memory.timestamp,
      version: 1,
      tags: memory.tags,
      source: 'memory-storage',
      custom: memory.metadata || {}
    };

    // Use simplified chunking for memories
    const chunks = await this.createMemoryChunks(contentString, memory.id);

    // Store each chunk with tenant context
    for (const chunk of chunks) {
      await this.storeChunk(chunk, tenantContext);
    }

    // DEFENSIVE: Ensure version is a valid integer
    let safeVersion = metadata.version;
    if (!Number.isInteger(safeVersion) || safeVersion < 1) {
      logger.warn('Invalid version in memory storage, coercing to 1', {
        providedVersion: safeVersion,
        memoryId: memory.id
      });
      safeVersion = 1;
    }

    // Store document metadata
    const client = await this.postgresPool.connect();
    try {
      await client.query(`
        INSERT INTO graphrag.documents (
          id, title, type, format, size, hash,
          created_at, updated_at, version, tags, source, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (hash) DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          version = EXCLUDED.version,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata
      `, [
        memory.id,
        metadata.title,
        metadata.type,
        metadata.format,
        metadata.size,
        metadata.hash,
        metadata.created_at,
        metadata.updated_at,
        safeVersion, // Use validated version
        toPostgresArray(metadata.tags), // Convert JS array to PostgreSQL array format
        metadata.source,
        JSON.stringify(metadata.custom)
      ]);
    } finally {
      client.release();
    }
  }

  private async createMemoryChunks(content: string, memoryId: string): Promise<Chunk[]> {
    const maxChunkSize = 1000; // Characters, not tokens
    const chunks: Chunk[] = [];
    
    // Simple chunking for memories
    let position = 0;
    while (position < content.length) {
      const chunkContent = content.substring(position, position + maxChunkSize);
      const chunk: Chunk = {
        id: uuidv4(),
        document_id: memoryId,
        content: chunkContent,
        type: 'memory',
        position: {
          start: position,
          end: position + chunkContent.length
        },
        metadata: {
          importance_score: 0.8,
          semantic_density: 0.7,
          contains_key_info: true
        },
        tokens: this.estimateTokens(chunkContent)
      };
      
      chunks.push(chunk);
      position += maxChunkSize - 100; // 100 character overlap
    }
    
    return chunks;
  }

  private async storeChunk(chunk: Chunk, tenantContext: EnhancedTenantContext): Promise<void> {
    // Detect content type for consistency
    const contentType = this.voyageClient.detectContentType(chunk.content);

    // Generate embedding with proper model
    const embeddingResult = await this.voyageClient.generateEmbedding(chunk.content, {
      inputType: 'document',
      contentType: contentType
    });
    const embedding = embeddingResult.embedding;  // Extract embedding array from result object

    // Validate embedding dimensions
    if (!embedding || embedding.length !== 1024) {
      throw new Error(
        `Invalid chunk embedding: Expected 1024 dimensions, got ${embedding?.length || 0}. ` +
        `Chunk ID: ${chunk.id}`
      );
    }

    // Store in unified content collection
    await this.qdrantClient.upsert('unified_content', {
      wait: true,
      points: [{
        id: chunk.id,
        vector: embedding,  // Qdrant expects 'vector' (singular)
        payload: {
          ...chunk,
          content_type: 'memory',
          embedding: undefined,  // Remove embedding from payload to save space
          // Tenant context for filtering
          user_id: tenantContext.userId,
          company_id: tenantContext.companyId,
          app_id: tenantContext.appId,
          session_id: tenantContext.sessionId
        }
      }]
    });
  }

  private async cacheMemory(memory: Memory): Promise<void> {
    // Cache in Redis for fast access
    const key = `memory:${memory.id}`;
    const ttl = 86400; // 24 hours
    
    await this.redisCache.setex(
      key, 
      ttl, 
      JSON.stringify(memory)
    );
    
    // Also add to recent memories list
    await this.redisCache.lpush('recent_memories', memory.id);
    await this.redisCache.ltrim('recent_memories', 0, 999); // Keep last 1000
  }

  // FUTURE: Placeholder methods for potential search index integration
  // Uncomment and use when implementing full-text search functionality
  /*
  private async updateMemorySearchIndex(memory: Memory): Promise<void> {
    const client = await this.postgresPool.connect();

    try {
      // Create full-text search entry
      await client.query(`
        INSERT INTO search_index (
          document_id,
          content_type,
          content,
          metadata
        ) VALUES ($1, $2, $3, $4)
      `, [
        memory.id,
        'memory',
        memory.content,
        JSON.stringify(memory.metadata)
      ]);
    } finally {
      client.release();
    }
  }

  private async getMemoryCount(): Promise<number> {
    try {
      const client = await this.postgresPool.connect();
      try {
        const result = await client.query(`
          SELECT COUNT(*) as count
          FROM graphrag.unified_content
          WHERE content_type = 'memory'
        `);
        return parseInt(result.rows[0].count);
      } finally {
        client.release();
      }
    } catch (error) {
      return 0;
    }
  }
  */

  private async linkRelatedMemories(session: any, memory: Memory, tenantContext: EnhancedTenantContext): Promise<void> {
    // Find similar memories and create relationships
    const similarMemories = await this.recallMemories(memory.content, tenantContext, { limit: 3 });

    for (const similar of similarMemories) {
      if (similar.id !== memory.id && similar.relevanceScore > 0.7) {
        await session.run(`
          MATCH (m1:Memory {id: $id1})
          MATCH (m2:Memory {id: $id2})
          MERGE (m1)-[:SIMILAR_TO {score: $score}]->(m2)
        `, {
          id1: memory.id,
          id2: similar.id,
          score: similar.relevanceScore
        });
      }
    }
  }

  private buildContentTypeFilter(contentTypes: string[], tenantContext: EnhancedTenantContext): any {
    const mustConditions = [
      {
        key: 'company_id',
        match: { value: tenantContext.companyId }
      },
      {
        key: 'app_id',
        match: { value: tenantContext.appId }
      }
    ];

    const shouldConditions = [
      {
        key: 'user_id',
        match: { value: tenantContext.userId }
      },
      {
        key: 'user_id',
        match: { value: 'system' }
      }
    ];

    // Build content type filter
    // When 'all' is specified, include all valid content types to ensure Qdrant filter works correctly
    // This fixes a bug where omitting content_type filter caused empty search results
    const validContentTypes = ['memory', 'document', 'chunk'];

    if (contentTypes.includes('all')) {
      // For 'all', add content type conditions as 'should' to match any content type
      const typeConditions = validContentTypes.map(type => ({
        key: 'content_type',
        match: { value: type }
      }));

      return {
        must: mustConditions,
        should: [...typeConditions, ...shouldConditions]
      };
    }

    // For specific content types
    const typeConditions = contentTypes.map(type => ({
      key: 'content_type',
      match: { value: type }
    }));

    if (typeConditions.length === 1) {
      mustConditions.push(typeConditions[0]);
      return {
        must: mustConditions,
        should: shouldConditions
      };
    } else {
      return {
        must: mustConditions,
        should: [...typeConditions, ...shouldConditions]
      };
    }
  }

  /**
   * Generate a PDF viewer URL for direct page viewing
   * Uses server-side page extraction endpoint for precise page delivery
   *
   * Supports:
   * - Single page: /pages/22
   * - Page ranges: /pages/2-6
   * - Multiple pages: /pages/50,55,60
   * - Combined: /pages/2-6,50,55
   */
  private generatePdfViewerUrl(artifactUrl?: string | null, pageNumber?: number | null): string | undefined {
    if (!artifactUrl) return undefined;

    // Fix legacy artifact URLs that are missing /fileprocess prefix
    // Convert /api/files/xxx to /fileprocess/api/files/xxx
    let normalizedUrl = artifactUrl;
    if (artifactUrl.startsWith('/api/files/') && !artifactUrl.startsWith('/fileprocess/')) {
      normalizedUrl = `/fileprocess${artifactUrl}`;
    }

    // Google Drive PDF viewer with page parameter (external storage)
    // Handles both /file/d/ID/view and /open?id=ID formats
    if (normalizedUrl.includes('drive.google.com')) {
      // Extract file ID from various Google Drive URL formats
      const fileIdMatch = normalizedUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
                          normalizedUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (fileIdMatch) {
        const fileId = fileIdMatch[1];
        // Google Drive PDF viewer with page parameter
        const viewerUrl = `https://drive.google.com/file/d/${fileId}/view`;
        return pageNumber ? `${viewerUrl}#page=${pageNumber}` : viewerUrl;
      }
    }

    // For internal storage (PostgreSQL buffer or MinIO), use page extraction endpoint
    // This returns just the requested page(s) as a new PDF
    if (normalizedUrl.includes('/fileprocess/api/files/')) {
      // Extract artifact ID from URL
      const artifactIdMatch = normalizedUrl.match(/\/fileprocess\/api\/files\/([a-f0-9-]+)/);
      if (artifactIdMatch && pageNumber) {
        const artifactId = artifactIdMatch[1];
        // Use server-side page extraction endpoint
        return `/fileprocess/api/files/${artifactId}/pages/${pageNumber}`;
      }
    }

    // Fallback: append page anchor for external URLs
    return pageNumber ? `${normalizedUrl}#page=${pageNumber}` : normalizedUrl;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private getModelForContent(contentType: string): string {
    // Import config for model mapping
    const config = require('../config-enhanced').configEnhanced;

    switch (contentType) {
      case 'code':
        return config.voyageAI.models.code;
      case 'multimodal':
        return config.voyageAI.models.multimodal;
      default:
        return config.voyageAI.models.text;
    }
  }
}
