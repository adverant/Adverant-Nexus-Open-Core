/**
 * Database Operations for Multi-Database Saga Pattern
 *
 * Extracts database operations into idempotent, testable functions.
 * Each operation is designed to be safely retried and includes proper
 * error handling with detailed context.
 *
 * CRITICAL: All operations MUST be idempotent to support saga retries.
 *
 * @see REMEDIATION_PLAN.md Task 2.1
 */

import { Pool, PoolClient } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Driver, Session } from 'neo4j-driver';
import { logger } from '../utils/logger';
import { Memory } from '../types';
import { EnhancedTenantContext } from '../middleware/tenant-context';
import { EmbeddingCache } from '../utils/cache';

/**
 * PostgreSQL Operation Result
 */
export interface PostgresOperationResult {
  id: string;
  rowCount: number;
  inserted: boolean;
  updated: boolean;
}

/**
 * Qdrant Operation Result
 */
export interface QdrantOperationResult {
  id: string;
  status: 'created' | 'updated';
  operation_id?: number;
}

/**
 * Neo4j Operation Result
 */
export interface Neo4jOperationResult {
  id: string;
  nodesCreated: number;
  relationshipsCreated: number;
}

/**
 * Database Operations Class
 *
 * Provides idempotent database operations for the saga pattern.
 */
export class DatabaseOperations {
  private embeddingCache: EmbeddingCache | null = null;

  constructor(
    private readonly postgresPool: Pool,
    private readonly qdrantClient: QdrantClient | null,
    private readonly neo4jDriver: Driver | null,
    private readonly voyageClient: any
  ) {}

  /**
   * Set embedding cache for content-hash based caching
   * This dramatically reduces latency by avoiding redundant Voyage API calls
   *
   * @param cache - EmbeddingCache instance
   */
  setEmbeddingCache(cache: EmbeddingCache): void {
    this.embeddingCache = cache;
    logger.info('[DB-OPS] EmbeddingCache configured for storage engine');
  }

  /**
   * Store memory in PostgreSQL with idempotency support
   *
   * Uses UPSERT (INSERT ... ON CONFLICT) to ensure idempotency.
   * If the same memory ID is written twice, it's updated, not duplicated.
   *
   * @param memory - Memory object to store
   * @param tenantContext - Tenant isolation context
   * @param idempotencyKey - Optional idempotency key for duplicate detection
   * @returns PostgresOperationResult
   */
  async storeInPostgres(
    memory: Memory,
    tenantContext: EnhancedTenantContext,
    idempotencyKey?: string
  ): Promise<PostgresOperationResult> {
    const client = await this.postgresPool.connect();

    try {
      // Set tenant context for Row Level Security
      await client.query(
        'SELECT graphrag.set_tenant_context($1, $2, $3)',
        [tenantContext.companyId, tenantContext.appId, tenantContext.userId]
      );

      logger.debug('[DB-OPS] Storing memory in PostgreSQL', {
        memoryId: memory.id,
        tenantContext: {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          userId: tenantContext.userId
        },
        idempotencyKey
      });

      // IDEMPOTENT UPSERT: Insert or update based on ID
      // If conflict on ID, update only if:
      // 1. The idempotency key matches (same request retry), OR
      // 2. The updated_at is newer (legitimate update)
      const result = await client.query(`
        INSERT INTO graphrag.unified_content (
          id, content_type, content, tags, metadata,
          embedding_model, company_id, app_id, user_id, session_id,
          created_at, updated_at, idempotency_key
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id)
        DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          content = EXCLUDED.content,
          tags = EXCLUDED.tags,
          metadata = EXCLUDED.metadata,
          idempotency_key = EXCLUDED.idempotency_key
        WHERE
          graphrag.unified_content.idempotency_key = $13
          OR graphrag.unified_content.updated_at < EXCLUDED.updated_at
        RETURNING id, (xmax = 0) AS inserted
      `, [
        memory.id,
        'memory',
        memory.content,
        memory.tags || [],
        JSON.stringify(memory.metadata || {}),
        'none', // Will be set after embedding generation
        tenantContext.companyId,
        tenantContext.appId,
        tenantContext.userId || memory.userId,
        tenantContext.sessionId,
        memory.timestamp,
        memory.timestamp,
        idempotencyKey || null
      ]);

      const inserted = result.rows[0]?.inserted ?? true;
      const updated = !inserted;

      logger.info('[DB-OPS] Memory stored in PostgreSQL', {
        memoryId: memory.id,
        inserted,
        updated,
        rowCount: result.rowCount
      });

      return {
        id: memory.id,
        rowCount: result.rowCount || 0,
        inserted,
        updated
      };

    } catch (error: any) {
      logger.error('[DB-OPS] Failed to store memory in PostgreSQL', {
        error: error.message,
        stack: error.stack,
        memoryId: memory.id,
        code: error.code,
        detail: error.detail
      });

      throw new Error(
        `PostgreSQL storage failed: ${error.message}. ` +
        `Memory ID: ${memory.id}. ` +
        `Code: ${error.code}. ` +
        `This may indicate a schema issue, connection failure, or constraint violation.`
      );
    } finally {
      client.release();
    }
  }

  /**
   * Store memory vector in Qdrant with idempotency support
   *
   * Qdrant's upsert operation is naturally idempotent - upserting
   * the same ID twice with the same vector is safe.
   *
   * @param memory - Memory object to store
   * @param embedding - Vector embedding (1024 dimensions for voyage-3)
   * @param tenantContext - Tenant isolation context
   * @returns QdrantOperationResult
   */
  async storeInQdrant(
    memory: Memory,
    embedding: number[],
    tenantContext: EnhancedTenantContext
  ): Promise<QdrantOperationResult> {
    if (!this.qdrantClient) {
      throw new Error(
        'Qdrant client not initialized. ' +
        'Vector storage is unavailable. Check Qdrant connection configuration.'
      );
    }

    // Validate embedding dimensions
    if (!Array.isArray(embedding) || embedding.length !== 1024) {
      throw new Error(
        `Invalid embedding dimensions: Expected 1024, got ${embedding?.length || 0}. ` +
        `Memory ID: ${memory.id}. ` +
        `This indicates an issue with the embedding generation service.`
      );
    }

    try {
      logger.debug('[DB-OPS] Storing memory vector in Qdrant', {
        memoryId: memory.id,
        embeddingDimensions: embedding.length,
        tenantContext: {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          userId: tenantContext.userId
        }
      });

      // IDEMPOTENT UPSERT: Qdrant's upsert is naturally idempotent
      const result = await this.qdrantClient.upsert('unified_content', {
        wait: true, // Wait for operation to complete
        points: [{
          id: memory.id,
          vector: embedding,
          payload: {
            content_type: 'memory',
            content: memory.content,
            tags: memory.tags || [],
            timestamp: memory.timestamp,
            metadata: memory.metadata || {},
            tokens: this.estimateTokens(memory.content),
            embedding_model: 'voyage-3',
            has_embedding: true,
            // Tenant context for filtering
            user_id: tenantContext.userId || memory.userId,
            company_id: tenantContext.companyId,
            app_id: tenantContext.appId,
            session_id: tenantContext.sessionId
          }
        }]
      });

      logger.info('[DB-OPS] Memory vector stored in Qdrant', {
        memoryId: memory.id,
        status: result.status,
        operation_id: result.operation_id
      });

      return {
        id: memory.id,
        status: 'created', // Qdrant doesn't distinguish insert/update
        operation_id: result.operation_id
      };

    } catch (error: any) {
      logger.error('[DB-OPS] Failed to store memory vector in Qdrant', {
        error: error.message,
        stack: error.stack,
        memoryId: memory.id,
        embeddingLength: embedding.length,
        status: error.status,
        data: error.data
      });

      throw new Error(
        `Qdrant storage failed: ${error.message}. ` +
        `Memory ID: ${memory.id}. ` +
        `Collection: unified_content. ` +
        `This may indicate a connection failure, schema mismatch, or collection not initialized.`
      );
    }
  }

  /**
   * Store memory node in Neo4j with idempotency support
   *
   * Uses MERGE to ensure idempotency - merging the same node
   * twice with the same properties is safe.
   *
   * @param memory - Memory object to store
   * @param tenantContext - Tenant isolation context
   * @returns Neo4jOperationResult
   */
  async storeInNeo4j(
    memory: Memory,
    tenantContext: EnhancedTenantContext
  ): Promise<Neo4jOperationResult> {
    if (!this.neo4jDriver) {
      throw new Error(
        'Neo4j driver not initialized. ' +
        'Graph storage is unavailable. Check Neo4j connection configuration.'
      );
    }

    const session: Session = this.neo4jDriver.session();

    try {
      logger.debug('[DB-OPS] Storing memory node in Neo4j', {
        memoryId: memory.id,
        tenantContext: {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          userId: tenantContext.userId
        }
      });

      // IDEMPOTENT MERGE: MERGE is idempotent by design
      // If node exists with same ID, properties are updated
      const result = await session.run(`
        MERGE (m:Memory {id: $id})
        ON CREATE SET
          m.content = $content,
          m.timestamp = datetime($timestamp),
          m.tags = $tags,
          m.company_id = $companyId,
          m.app_id = $appId,
          m.user_id = $userId,
          m.created_at = datetime($timestamp)
        ON MATCH SET
          m.content = $content,
          m.timestamp = datetime($timestamp),
          m.tags = $tags,
          m.updated_at = datetime()
        RETURN m,
               (CASE WHEN m.created_at = datetime($timestamp) THEN 1 ELSE 0 END) AS created
      `, {
        id: memory.id,
        content: memory.content,
        timestamp: memory.timestamp,
        tags: memory.tags || [],
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId || memory.userId
      });

      const nodesCreated = result.summary.counters.updates().nodesCreated || 0;
      const relationshipsCreated = result.summary.counters.updates().relationshipsCreated || 0;

      logger.info('[DB-OPS] Memory node stored in Neo4j', {
        memoryId: memory.id,
        nodesCreated,
        relationshipsCreated
      });

      return {
        id: memory.id,
        nodesCreated,
        relationshipsCreated
      };

    } catch (error: any) {
      logger.error('[DB-OPS] Failed to store memory node in Neo4j', {
        error: error.message,
        stack: error.stack,
        memoryId: memory.id,
        code: error.code
      });

      throw new Error(
        `Neo4j storage failed: ${error.message}. ` +
        `Memory ID: ${memory.id}. ` +
        `This may indicate a connection failure, Cypher syntax error, or constraint violation.`
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Generate embedding for memory content with caching
   *
   * Uses content-hash based caching to avoid redundant Voyage API calls.
   * Cache hit: ~1ms, Cache miss: ~150-300ms (Voyage API)
   *
   * @param content - Memory content to embed
   * @param contentType - Content type for model selection
   * @returns Embedding vector and model name
   */
  async generateEmbedding(
    content: string,
    contentType: string = 'text'
  ): Promise<{ embedding: number[]; model: string }> {
    if (!this.voyageClient) {
      throw new Error(
        'VoyageAI client not initialized. ' +
        'Embedding generation is unavailable. Check VOYAGE_API_KEY environment variable.'
      );
    }

    const startTime = Date.now();

    // PERFORMANCE: Use embedding cache if available
    // This is the KEY optimization - saves ~150-300ms per store operation
    if (this.embeddingCache) {
      try {
        const result = await this.embeddingCache.getOrGenerate(content, async () => {
          const embeddingResult = await this.voyageClient.generateEmbedding(content, {
            inputType: 'document',
            contentType
          });
          return {
            embedding: embeddingResult.embedding,
            model: embeddingResult.model || 'voyage-3'
          };
        });

        // Validate embedding
        if (!Array.isArray(result.embedding) || result.embedding.length !== 1024) {
          throw new Error(
            `Invalid embedding dimensions: Expected 1024, got ${result.embedding?.length || 0}`
          );
        }

        const latencyMs = Date.now() - startTime;
        logger.info('[DB-OPS] Embedding generated', {
          contentLength: content.length,
          dimensions: result.embedding.length,
          model: result.model,
          cached: result.cached,
          latencyMs,
          savings: result.cached ? '~150-300ms saved' : 'new embedding'
        });

        return { embedding: result.embedding, model: result.model };
      } catch (cacheError: any) {
        // Cache error - fall through to direct generation
        logger.warn('[DB-OPS] Embedding cache error, falling back to direct generation', {
          error: cacheError.message
        });
      }
    }

    // Fallback: Direct Voyage API call (no cache)
    try {
      logger.debug('[DB-OPS] Generating embedding (no cache)', {
        contentLength: content.length,
        contentType
      });

      const result = await this.voyageClient.generateEmbedding(content, {
        inputType: 'document',
        contentType
      });

      const embedding = result.embedding;
      const model = result.model || 'voyage-3';

      // Validate embedding
      if (!Array.isArray(embedding) || embedding.length !== 1024) {
        throw new Error(
          `Invalid embedding dimensions: Expected 1024, got ${embedding?.length || 0}`
        );
      }

      const latencyMs = Date.now() - startTime;
      logger.debug('[DB-OPS] Embedding generated successfully (uncached)', {
        dimensions: embedding.length,
        model,
        latencyMs
      });

      return { embedding, model };

    } catch (error: any) {
      logger.error('[DB-OPS] Failed to generate embedding', {
        error: error.message,
        stack: error.stack,
        contentLength: content.length
      });

      throw new Error(
        `Embedding generation failed: ${error.message}. ` +
        `Content length: ${content.length}. ` +
        `This may indicate VoyageAI API issues, rate limiting, or invalid API key.`
      );
    }
  }

  /**
   * Verify a point exists in Qdrant after upsert
   *
   * Used to confirm vector indexing completed before returning.
   * Addresses async indexing latency where vectors are stored
   * but not immediately searchable.
   *
   * @param memoryId - The memory ID (point ID) to check
   * @returns true if point exists and is retrievable, false otherwise
   */
  async verifyQdrantPointExists(memoryId: string): Promise<boolean> {
    if (!this.qdrantClient) {
      logger.warn('[DB-OPS] Cannot verify Qdrant point - client not initialized');
      return false;
    }

    try {
      const result = await this.qdrantClient.retrieve('unified_content', {
        ids: [memoryId],
        with_payload: false,
        with_vector: false,
      });

      const exists = result.length > 0;

      logger.debug('[DB-OPS] Qdrant point existence check', {
        memoryId,
        exists,
        retrievedCount: result.length
      });

      return exists;

    } catch (error: any) {
      logger.warn('[DB-OPS] Qdrant point existence check failed', {
        memoryId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Verify point exists with retry for async indexing
   *
   * Implements exponential backoff retry to handle Qdrant's
   * asynchronous indexing delay after upsert.
   *
   * @param memoryId - The memory ID (point ID) to verify
   * @param maxRetries - Maximum retry attempts (default: 3)
   * @param baseDelayMs - Base delay in milliseconds (default: 100)
   * @returns true if point verified, false if all retries exhausted
   */
  async verifyQdrantPointWithRetry(
    memoryId: string,
    maxRetries: number = 3,
    baseDelayMs: number = 100
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const exists = await this.verifyQdrantPointExists(memoryId);

      if (exists) {
        logger.debug('[DB-OPS] Qdrant point verified', { memoryId, attempt });
        return true;
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn('[DB-OPS] Vector not yet indexed, retrying', {
          memoryId,
          attempt,
          delay,
          maxRetries
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logger.error('[DB-OPS] Vector indexing verification failed after retries', {
      memoryId,
      attempts: maxRetries,
      suggestion: 'Memory stored in PostgreSQL but may not appear in semantic search immediately'
    });

    return false;
  }

  /**
   * Estimate token count for content
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
