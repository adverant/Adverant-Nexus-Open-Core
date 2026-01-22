/**
 * Unified Memory Router
 *
 * The SINGLE entry point for all memory storage in Nexus.
 * Intelligently routes to:
 * - UnifiedStorageEngine (PostgreSQL + Qdrant + Redis) - ALWAYS
 * - GraphitiService (Neo4j entity extraction) - when triage decides it's needed
 *
 * This solves the architectural disconnect where /api/memory/store bypassed
 * entity extraction entirely.
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { UnifiedStorageEngine } from './unified-storage-engine';
import { GraphitiService } from '../episodic/graphiti-service';
import { MemoryTriage, TriageDecision, getMemoryTriage } from './memory-triage';
import { EnhancedTenantContext } from '../middleware/tenant-context';
import { logger } from '../utils/logger';
import { MemoryStorageRequest } from '../types';
import { StoreEpisodeRequest, ExtractedEntity, ExtractedFact } from '../episodic/types';
import {
  enqueueEnrichment,
  getEnrichmentStatus,
  MemoryEnrichmentJob
} from '../workers/memory-enrichment-queue';

/**
 * Request for unified memory storage
 * This is the ONLY interface external services should use for storing memories
 */
export interface UnifiedStoreRequest {
  content: string;
  userId: string;
  companyId: string;
  sessionId?: string;
  appId?: string;
  metadata?: Record<string, any>;
  tags?: string[];

  // Optional: Force specific storage paths (bypass triage)
  forceEntityExtraction?: boolean;
  forceEpisodicStorage?: boolean;

  // Optional: Pre-identified entities (will still be validated against stopwords)
  preIdentifiedEntities?: string[];

  // Optional: Episode type for GraphitiService
  episodeType?: 'user_query' | 'system_response' | 'document_interaction' | 'entity_mention' | 'summary';

  // Optional: Importance score (0-1)
  importance?: number;
}

/**
 * Result from unified memory storage
 * Contains comprehensive information about what was stored and where
 */
export interface UnifiedStoreResult {
  /** Primary memory ID (PostgreSQL) */
  memoryId: string;

  /** Episode ID if stored in Neo4j */
  episodeId?: string;

  /** Entities extracted from content (if entity extraction was performed) */
  entities?: Array<{
    name: string;
    type: string;
    confidence: number;
    method?: string;
  }>;

  /** Facts/relationships extracted (if episodic storage was performed) */
  facts?: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
  }>;

  /** Which storage backends received the data */
  storagePaths: {
    postgres: boolean;
    qdrant: boolean;
    neo4j: boolean;
    redis: boolean;
  };

  /** Triage decision that determined storage paths */
  triageDecision: TriageDecision;

  /** Was this a duplicate that was deduplicated? */
  duplicate?: boolean;

  /** Content hash for deduplication */
  contentHash?: string;

  /** Total latency in ms */
  latencyMs: number;
}

/**
 * Result from async-first memory storage
 * Returns immediately with UUID, enrichment happens in background
 */
export interface AsyncStoreResult {
  /** Memory ID (UUID) - available immediately */
  memoryId: string;

  /** Storage status */
  status: 'accepted' | 'failed';

  /** Enrichment status */
  enrichment: {
    status: 'pending' | 'skipped';
    jobId?: string;
    reason?: string;
  };

  /** Which storage backends received the data */
  storagePaths: {
    postgres: boolean;
    qdrant: boolean;
    redis: boolean;
  };

  /** Heuristic triage decision (no LLM) */
  triageDecision: string;

  /** Content hash for deduplication */
  contentHash: string;

  /** Total latency in ms (target: <200ms) */
  latencyMs: number;
}

export class UnifiedMemoryRouter {
  private triage: MemoryTriage;
  private storageEngine: UnifiedStorageEngine;
  private graphitiService: GraphitiService;
  private storeCount = 0;
  private asyncStoreCount = 0;
  private entityExtractionCount = 0;

  constructor(
    storageEngine: UnifiedStorageEngine,
    graphitiService: GraphitiService,
    openRouterApiKey?: string
  ) {
    this.storageEngine = storageEngine;
    this.graphitiService = graphitiService;
    this.triage = getMemoryTriage(openRouterApiKey);

    logger.info('UnifiedMemoryRouter initialized', {
      hasStorageEngine: !!storageEngine,
      hasGraphitiService: !!graphitiService
    });
  }

  /**
   * Store memory through the unified pipeline
   *
   * This is THE method all memory storage should go through.
   * It ensures:
   * 1. All memories are stored in PostgreSQL + Qdrant (vector search)
   * 2. Entity extraction happens when content contains extractable entities
   * 3. Episodic storage (Neo4j) captures relationships and temporal context
   */
  async storeMemory(
    request: UnifiedStoreRequest,
    tenantContext: EnhancedTenantContext
  ): Promise<UnifiedStoreResult> {
    const startTime = Date.now();
    this.storeCount++;

    const result: UnifiedStoreResult = {
      memoryId: '',
      storagePaths: {
        postgres: false,
        qdrant: false,
        neo4j: false,
        redis: false
      },
      triageDecision: {
        needsEntityExtraction: false,
        needsEpisodicStorage: false,
        contentType: 'conversational',
        confidence: 0,
        reason: 'pending'
      },
      latencyMs: 0
    };

    try {
      // Validate required fields
      if (!request.content || typeof request.content !== 'string') {
        throw new Error('Content is required and must be a string');
      }

      if (!request.userId || !request.companyId) {
        throw new Error('userId and companyId are required');
      }

      // Step 1: Triage - determine what storage paths are needed
      const triageDecision = await this.triage.analyze(request.content, {
        forceEntityExtraction: request.forceEntityExtraction,
        forceEpisodicStorage: request.forceEpisodicStorage,
        metadata: request.metadata
      });

      result.triageDecision = triageDecision;

      logger.info('Memory triage completed', {
        contentLength: request.content.length,
        decision: triageDecision,
        triageLatency: Date.now() - startTime
      });

      // Step 2: Prepare requests for parallel storage
      const memoryRequest: MemoryStorageRequest = {
        content: request.content,
        tags: request.tags || [],
        metadata: {
          ...request.metadata,
          userId: request.userId,
          companyId: request.companyId,
          sessionId: request.sessionId,
          appId: request.appId,
          triageDecision: triageDecision.reason,
          contentType: triageDecision.contentType,
          importance: request.importance ?? 0.5
        }
      };

      const idempotencyKey = this.generateIdempotencyKey(request);
      const needsEntityExtraction = triageDecision.needsEntityExtraction || triageDecision.needsEpisodicStorage;

      // Step 3: PARALLEL storage - PostgreSQL+Qdrant and Neo4j simultaneously
      // This reduces latency by ~40-50% compared to sequential storage
      const storagePromises: Promise<any>[] = [
        // Primary storage: PostgreSQL + Qdrant + Redis
        this.storageEngine.storeMemory(memoryRequest, tenantContext, idempotencyKey)
      ];

      // Prepare entity extraction request if needed
      const episodeRequest: StoreEpisodeRequest | null = needsEntityExtraction ? {
        content: request.content,
        type: request.episodeType || 'user_query',
        importance: request.importance ?? 0.5,
        entities: request.preIdentifiedEntities,
        metadata: {
          ...request.metadata,
          userId: request.userId,
          companyId: request.companyId,
          sessionId: request.sessionId
        }
      } : null;

      // Add entity extraction to parallel execution if needed
      if (episodeRequest) {
        this.entityExtractionCount++;
        storagePromises.push(
          this.graphitiService.storeEpisode(episodeRequest, tenantContext)
            .catch((err: any) => {
              // Log but don't fail - allow primary storage to succeed
              logger.error('Entity extraction failed in parallel execution', {
                error: err.message,
                stack: err.stack
              });
              return null; // Return null to indicate failure
            })
        );
      }

      // Execute all storage operations in parallel
      const [memoryResult, episodeResult] = await Promise.all(storagePromises);

      // Process primary storage result
      result.memoryId = memoryResult.id || uuidv4();
      result.storagePaths.postgres = memoryResult.success;
      result.storagePaths.qdrant = memoryResult.success;
      result.storagePaths.redis = memoryResult.success;

      logger.debug('Primary storage completed', {
        memoryId: result.memoryId,
        success: memoryResult.success
      });

      // Process entity extraction result if it was executed
      if (episodeResult) {
        result.episodeId = episodeResult.episode_id;
        result.duplicate = episodeResult.duplicate;
        result.contentHash = episodeResult.content_hash;
        result.storagePaths.neo4j = true;

        // Map entities to result format
        if (episodeResult.entities_extracted && episodeResult.entities_extracted.length > 0) {
          result.entities = episodeResult.entities_extracted.map((e: ExtractedEntity) => ({
            name: e.name,
            type: e.type,
            confidence: e.confidence,
            method: (e as any).classificationMethod || 'unknown'
          }));
        }

        // Map facts to result format
        if (episodeResult.facts_extracted && episodeResult.facts_extracted.length > 0) {
          result.facts = episodeResult.facts_extracted.map((f: ExtractedFact) => ({
            subject: f.subject,
            predicate: f.predicate,
            object: f.object,
            confidence: f.confidence
          }));
        }

        logger.info('Entity extraction completed in parallel', {
          memoryId: result.memoryId,
          episodeId: result.episodeId,
          entitiesExtracted: result.entities?.length || 0,
          factsExtracted: result.facts?.length || 0,
          duplicate: result.duplicate
        });
      } else if (needsEntityExtraction) {
        // Entity extraction was needed but failed
        result.storagePaths.neo4j = false;
        logger.warn('Entity extraction was needed but failed', {
          memoryId: result.memoryId
        });
      }

      result.latencyMs = Date.now() - startTime;

      logger.info('Unified memory storage completed', {
        memoryId: result.memoryId,
        episodeId: result.episodeId,
        storagePaths: result.storagePaths,
        entitiesExtracted: result.entities?.length || 0,
        factsExtracted: result.facts?.length || 0,
        latencyMs: result.latencyMs
      });

      return result;

    } catch (err: any) {
      result.latencyMs = Date.now() - startTime;
      logger.error('Unified memory storage failed', {
        error: err.message,
        stack: err.stack,
        memoryId: result.memoryId,
        storagePaths: result.storagePaths,
        latencyMs: result.latencyMs
      });
      throw err;
    }
  }

  /**
   * ASYNC-FIRST Memory Storage (Target: <200ms response)
   *
   * This is the FAST PATH for memory storage:
   * 1. Generate UUID immediately (1ms)
   * 2. Heuristic triage only - NO LLM (5ms)
   * 3. Get/generate embedding (cached: 1ms / new: 150ms)
   * 4. Store to PostgreSQL + Qdrant (20ms)
   * 5. Enqueue background enrichment (5ms)
   * 6. Return immediately with 'accepted' status
   *
   * Background enrichment handles:
   * - LLM entity extraction (Claude Haiku)
   * - Fact extraction
   * - Neo4j storage
   * - Summary generation
   */
  async storeMemoryAsync(
    request: UnifiedStoreRequest,
    tenantContext: EnhancedTenantContext
  ): Promise<AsyncStoreResult> {
    const startTime = Date.now();
    this.asyncStoreCount++;

    // 1. Generate memory ID immediately
    const memoryId = uuidv4();

    // 2. Generate content hash for deduplication
    const contentHash = createHash('sha256')
      .update(request.content)
      .digest('hex')
      .substring(0, 32);

    const result: AsyncStoreResult = {
      memoryId,
      status: 'accepted',
      enrichment: {
        status: 'pending'
      },
      storagePaths: {
        postgres: false,
        qdrant: false,
        redis: false
      },
      triageDecision: 'pending',
      contentHash,
      latencyMs: 0
    };

    try {
      // Validate required fields
      if (!request.content || typeof request.content !== 'string') {
        throw new Error('Content is required and must be a string');
      }

      if (!request.userId || !request.companyId) {
        throw new Error('userId and companyId are required');
      }

      // 3. Heuristic triage ONLY (no LLM) - ~5ms
      const triageDecision = this.triage.heuristicTriageOnly
        ? this.triage.heuristicTriageOnly(request.content)
        : await this.triage.analyze(request.content, {
            forceEntityExtraction: request.forceEntityExtraction,
            forceEpisodicStorage: request.forceEpisodicStorage,
            metadata: request.metadata
          });

      result.triageDecision = triageDecision.reason;

      // 4. Store to PostgreSQL + Qdrant (fast path)
      const memoryRequest: MemoryStorageRequest = {
        content: request.content,
        tags: request.tags || [],
        metadata: {
          ...request.metadata,
          userId: request.userId,
          companyId: request.companyId,
          sessionId: request.sessionId,
          appId: request.appId,
          triageDecision: triageDecision.reason,
          contentType: triageDecision.contentType,
          importance: request.importance ?? 0.5,
          enrichmentStatus: 'pending'
        }
      };

      const idempotencyKey = contentHash;

      const storageResult = await this.storageEngine.storeMemory(
        memoryRequest,
        tenantContext,
        idempotencyKey
      );

      result.storagePaths.postgres = storageResult.success;
      result.storagePaths.qdrant = storageResult.success;
      result.storagePaths.redis = storageResult.success;

      // Update memoryId if storage returned a different one
      if (storageResult.id) {
        result.memoryId = storageResult.id;
      }

      // 5. Enqueue background enrichment (if triage indicates it's needed)
      const needsEnrichment = triageDecision.needsEntityExtraction || triageDecision.needsEpisodicStorage;

      if (needsEnrichment && storageResult.success) {
        try {
          // Note: Embedding will be regenerated by worker if needed (cache will help)
          const enrichmentJob: MemoryEnrichmentJob = {
            memoryId: result.memoryId,
            content: request.content,
            embedding: [], // Worker will generate from cache or API
            embeddingModel: 'voyage-3',
            tenantContext: {
              companyId: request.companyId,
              appId: request.appId || tenantContext.appId || 'default',
              userId: request.userId
            },
            triageDecision: triageDecision.reason,
            storedAt: new Date().toISOString(),
            metadata: request.metadata
          };

          const jobId = await enqueueEnrichment(enrichmentJob);
          result.enrichment = {
            status: 'pending',
            jobId
          };

          this.entityExtractionCount++;

          logger.debug('[ASYNC-STORE] Enrichment job enqueued', {
            memoryId: result.memoryId,
            jobId,
            enqueuedInMs: Date.now() - startTime
          });
        } catch (enqueueErr: any) {
          // Log but don't fail - memory is already stored
          logger.warn('[ASYNC-STORE] Failed to enqueue enrichment', {
            memoryId: result.memoryId,
            error: enqueueErr.message
          });
          result.enrichment = {
            status: 'skipped',
            reason: enqueueErr.message
          };
        }
      } else {
        result.enrichment = {
          status: 'skipped',
          reason: needsEnrichment ? 'storage_failed' : 'not_needed'
        };
      }

      result.latencyMs = Date.now() - startTime;

      logger.info('[ASYNC-STORE] Memory stored', {
        memoryId: result.memoryId,
        storagePaths: result.storagePaths,
        enrichmentStatus: result.enrichment.status,
        latencyMs: result.latencyMs
      });

      return result;

    } catch (err: any) {
      result.status = 'failed';
      result.latencyMs = Date.now() - startTime;

      logger.error('[ASYNC-STORE] Storage failed', {
        memoryId: result.memoryId,
        error: err.message,
        latencyMs: result.latencyMs
      });

      throw err;
    }
  }

  /**
   * Get enrichment status for a memory
   */
  async getEnrichmentStatus(memoryId: string) {
    return getEnrichmentStatus(memoryId);
  }

  /**
   * Generate idempotency key for deduplication
   */
  private generateIdempotencyKey(request: UnifiedStoreRequest): string {
    const hash = createHash('sha256');
    hash.update(request.content);
    hash.update(request.userId);
    hash.update(request.companyId);
    hash.update(request.sessionId || '');
    return hash.digest('hex').substring(0, 32);
  }

  /**
   * Get router statistics
   */
  getStats(): {
    totalStores: number;
    asyncStores: number;
    entityExtractions: number;
    triageStats: { total: number; llm: number; heuristic: number };
  } {
    return {
      totalStores: this.storeCount,
      asyncStores: this.asyncStoreCount,
      entityExtractions: this.entityExtractionCount,
      triageStats: this.triage.getStats()
    };
  }
}

// Singleton instance management
let routerInstance: UnifiedMemoryRouter | null = null;

export function initializeUnifiedMemoryRouter(
  storageEngine: UnifiedStorageEngine,
  graphitiService: GraphitiService,
  openRouterApiKey?: string
): UnifiedMemoryRouter {
  routerInstance = new UnifiedMemoryRouter(storageEngine, graphitiService, openRouterApiKey);
  return routerInstance;
}

export function getUnifiedMemoryRouter(): UnifiedMemoryRouter {
  if (!routerInstance) {
    throw new Error(
      'UnifiedMemoryRouter not initialized. Call initializeUnifiedMemoryRouter first.'
    );
  }
  return routerInstance;
}

export function resetUnifiedMemoryRouter(): void {
  routerInstance = null;
}
