/**
 * Memory Enrichment Worker
 *
 * Background worker that processes memory enrichment jobs.
 * Extracts entities, facts, and generates summaries asynchronously.
 *
 * Performance targets:
 * - Process within 5 seconds of enqueue
 * - Entity extraction: 200-500ms (Haiku)
 * - Fact extraction: 200-500ms (Haiku)
 * - Summary generation: 200-300ms (Haiku)
 * - Neo4j storage: <100ms (batched)
 */

import { Worker, Job, Processor } from 'bullmq';
import Redis from 'ioredis';
import { Driver, Session } from 'neo4j-driver';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { GraphitiService } from '../episodic/graphiti-service';
import {
  MemoryEnrichmentJob,
  EnrichmentResult,
  TenantContext
} from './memory-enrichment-queue';

/**
 * Worker configuration
 */
export interface WorkerConfig {
  redisConnection: Redis;
  neo4jDriver: Driver;
  graphitiService: GraphitiService;
  queueName?: string;
  concurrency?: number;
  limiter?: {
    max: number;
    duration: number;
  };
}

/**
 * Memory Enrichment Worker class
 *
 * Processes enrichment jobs with:
 * - Configurable concurrency (default: 5)
 * - Rate limiting (default: 10 jobs/sec)
 * - Automatic retries with exponential backoff
 * - Progress reporting
 */
export class MemoryEnrichmentWorker {
  private worker: Worker<MemoryEnrichmentJob, EnrichmentResult>;
  private redis: Redis;
  private neo4jDriver: Driver;
  private graphitiService: GraphitiService;

  constructor(config: WorkerConfig) {
    this.redis = config.redisConnection;
    this.neo4jDriver = config.neo4jDriver;
    this.graphitiService = config.graphitiService;

    const queueName = config.queueName || 'memory-enrichment';

    this.worker = new Worker<MemoryEnrichmentJob, EnrichmentResult>(
      queueName,
      this.createProcessor(),
      {
        connection: this.redis,
        concurrency: config.concurrency ?? 5,
        limiter: config.limiter ?? {
          max: 10, // 10 jobs
          duration: 1000 // per second
        },
        // Lock duration - how long a job can be processed before being considered stalled
        lockDuration: 60000, // 60 seconds
        // How often to check for stalled jobs
        stalledInterval: 30000
      }
    );

    this.setupEventHandlers();

    logger.info('[ENRICHMENT-WORKER] Worker initialized', {
      queueName,
      concurrency: config.concurrency ?? 5
    });
  }

  /**
   * Create the job processor
   */
  private createProcessor(): Processor<MemoryEnrichmentJob, EnrichmentResult> {
    return async (job: Job<MemoryEnrichmentJob>): Promise<EnrichmentResult> => {
      const startTime = Date.now();
      const { memoryId, content, tenantContext, storedAt } = job.data;

      logger.info('[ENRICHMENT-WORKER] Processing job', {
        jobId: job.id,
        memoryId,
        contentLength: content.length,
        tenantContext,
        storedAt
      });

      try {
        // Update progress: Starting
        await job.updateProgress(10);

        // Step 1: Extract entities (LLM - Haiku)
        const entities = await this.extractEntities(content, tenantContext);
        await job.updateProgress(30);

        // Step 2: Store entities to Neo4j (batched)
        if (entities.length > 0) {
          await this.storeEntitiesToNeo4j(memoryId, entities, tenantContext);
        }
        await job.updateProgress(50);

        // Step 3: Extract facts/relationships
        const facts = await this.extractFacts(content, entities, tenantContext);
        await job.updateProgress(70);

        // Step 4: Store facts to Neo4j (batched)
        if (facts.length > 0) {
          await this.storeFactsToNeo4j(memoryId, facts, tenantContext);
        }
        await job.updateProgress(85);

        // Step 5: Generate summary (Haiku - fast)
        const summary = await this.generateSummary(content);
        await job.updateProgress(95);

        // Step 6: Update memory record with enrichment data
        await this.updateMemoryWithEnrichment(memoryId, {
          entities,
          facts,
          summary,
          tenantContext
        });
        await job.updateProgress(100);

        const processingTimeMs = Date.now() - startTime;

        const result: EnrichmentResult = {
          memoryId,
          entities,
          facts,
          summary,
          enrichedAt: new Date().toISOString(),
          processingTimeMs
        };

        // Emit event for real-time listeners
        await this.emitEnrichmentComplete(memoryId, result, tenantContext);

        logger.info('[ENRICHMENT-WORKER] Job completed', {
          jobId: job.id,
          memoryId,
          entityCount: entities.length,
          factCount: facts.length,
          processingTimeMs
        });

        return result;
      } catch (error: any) {
        logger.error('[ENRICHMENT-WORKER] Job failed', {
          jobId: job.id,
          memoryId,
          error: error.message,
          stack: error.stack
        });
        throw error;
      }
    };
  }

  /**
   * Extract entities using LLM (Claude Haiku)
   */
  private async extractEntities(
    content: string,
    _tenantContext: TenantContext
  ): Promise<EnrichmentResult['entities']> {
    try {
      // Use GraphitiService's entity extraction (already optimized with Haiku)
      const extracted = await this.graphitiService.extractEntitiesLLM(content);

      return extracted.map(e => ({
        name: e.name,
        type: e.type,
        confidence: e.confidence
      }));
    } catch (error: any) {
      logger.warn('[ENRICHMENT-WORKER] Entity extraction failed', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Extract facts/relationships
   */
  private async extractFacts(
    content: string,
    entities: EnrichmentResult['entities'],
    _tenantContext: TenantContext
  ): Promise<EnrichmentResult['facts']> {
    if (entities.length < 2) {
      // Need at least 2 entities to form relationships
      return [];
    }

    try {
      // Use GraphitiService's fact extraction
      const extracted = await this.graphitiService.extractFacts(content, entities.map(e => e.name));

      return extracted.map(f => ({
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        confidence: f.confidence || 0.8
      }));
    } catch (error: any) {
      logger.warn('[ENRICHMENT-WORKER] Fact extraction failed', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Generate episode summary using Haiku
   */
  private async generateSummary(content: string): Promise<string | undefined> {
    try {
      return await this.graphitiService.generateEpisodeSummary(content, 'general');
    } catch (error: any) {
      logger.warn('[ENRICHMENT-WORKER] Summary generation failed', {
        error: error.message
      });
      return undefined;
    }
  }

  /**
   * Store entities to Neo4j using batched UNWIND
   */
  private async storeEntitiesToNeo4j(
    episodeId: string,
    entities: EnrichmentResult['entities'],
    tenantContext: TenantContext
  ): Promise<void> {
    const session: Session = this.neo4jDriver.session();

    try {
      // Batched UNWIND query - stores all entities in single transaction
      await session.run(
        `
        UNWIND $entities AS entity
        MERGE (e:Entity {
          name: entity.name,
          company_id: $companyId,
          app_id: $appId
        })
        ON CREATE SET
          e.id = entity.id,
          e.type = entity.type,
          e.confidence = entity.confidence,
          e.first_seen = datetime(),
          e.mention_count = 1
        ON MATCH SET
          e.last_seen = datetime(),
          e.mention_count = e.mention_count + 1,
          e.confidence = CASE
            WHEN entity.confidence > e.confidence THEN entity.confidence
            ELSE e.confidence
          END
        WITH e, entity
        MATCH (ep:Episode {id: $episodeId})
        MERGE (ep)-[:MENTIONS {confidence: entity.confidence}]->(e)
        `,
        {
          entities: entities.map(e => ({
            id: uuidv4(),
            name: e.name,
            type: e.type,
            confidence: e.confidence
          })),
          episodeId,
          companyId: tenantContext.companyId,
          appId: tenantContext.appId
        }
      );

      logger.debug('[ENRICHMENT-WORKER] Entities stored to Neo4j', {
        episodeId,
        count: entities.length
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Store facts to Neo4j using batched UNWIND
   */
  private async storeFactsToNeo4j(
    episodeId: string,
    facts: EnrichmentResult['facts'],
    tenantContext: TenantContext
  ): Promise<void> {
    const session: Session = this.neo4jDriver.session();

    try {
      // Batched UNWIND query for facts
      await session.run(
        `
        UNWIND $facts AS fact
        MATCH (s:Entity {name: fact.subject, company_id: $companyId, app_id: $appId})
        MATCH (o:Entity {name: fact.object, company_id: $companyId, app_id: $appId})
        MERGE (s)-[r:RELATES_TO {predicate: fact.predicate}]->(o)
        ON CREATE SET
          r.id = fact.id,
          r.confidence = fact.confidence,
          r.created_at = datetime(),
          r.episode_id = $episodeId
        ON MATCH SET
          r.confidence = CASE
            WHEN fact.confidence > r.confidence THEN fact.confidence
            ELSE r.confidence
          END,
          r.last_seen = datetime()
        `,
        {
          facts: facts.map(f => ({
            id: uuidv4(),
            subject: f.subject,
            object: f.object,
            predicate: f.predicate,
            confidence: f.confidence
          })),
          episodeId,
          companyId: tenantContext.companyId,
          appId: tenantContext.appId
        }
      );

      logger.debug('[ENRICHMENT-WORKER] Facts stored to Neo4j', {
        episodeId,
        count: facts.length
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Update memory record with enrichment data
   */
  private async updateMemoryWithEnrichment(
    memoryId: string,
    enrichment: {
      entities: EnrichmentResult['entities'];
      facts: EnrichmentResult['facts'];
      summary?: string;
      tenantContext: TenantContext;
    }
  ): Promise<void> {
    // Update Qdrant payload with enrichment status
    try {
      // This would update the Qdrant point with enrichment metadata
      // For now, we emit an event that can be handled by the main service
      await this.redis.publish(
        'memory:enrichment:update',
        JSON.stringify({
          memoryId,
          entityCount: enrichment.entities.length,
          factCount: enrichment.facts.length,
          hasSummary: !!enrichment.summary,
          status: 'enriched',
          enrichedAt: new Date().toISOString()
        })
      );
    } catch (error: any) {
      logger.warn('[ENRICHMENT-WORKER] Failed to update memory enrichment status', {
        memoryId,
        error: error.message
      });
    }
  }

  /**
   * Emit enrichment complete event for real-time listeners
   */
  private async emitEnrichmentComplete(
    memoryId: string,
    result: EnrichmentResult,
    tenantContext: TenantContext
  ): Promise<void> {
    try {
      await this.redis.publish(
        'memory:enriched',
        JSON.stringify({
          memoryId,
          tenantContext,
          entityCount: result.entities.length,
          factCount: result.facts.length,
          processingTimeMs: result.processingTimeMs,
          enrichedAt: result.enrichedAt
        })
      );
    } catch (error: any) {
      logger.warn('[ENRICHMENT-WORKER] Failed to emit enrichment event', {
        memoryId,
        error: error.message
      });
    }
  }

  /**
   * Setup event handlers for monitoring
   */
  private setupEventHandlers(): void {
    this.worker.on('completed', (job) => {
      logger.debug('[ENRICHMENT-WORKER] Job completed event', {
        jobId: job.id,
        memoryId: job.data.memoryId
      });
    });

    this.worker.on('failed', (job, error) => {
      logger.error('[ENRICHMENT-WORKER] Job failed event', {
        jobId: job?.id,
        memoryId: job?.data.memoryId,
        error: error.message
      });
    });

    this.worker.on('stalled', (jobId) => {
      logger.warn('[ENRICHMENT-WORKER] Job stalled event', { jobId });
    });

    this.worker.on('error', (error) => {
      logger.error('[ENRICHMENT-WORKER] Worker error', { error: error.message });
    });
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.worker.isRunning();
  }

  /**
   * Pause the worker
   */
  async pause(): Promise<void> {
    await this.worker.pause();
    logger.info('[ENRICHMENT-WORKER] Worker paused');
  }

  /**
   * Resume the worker
   */
  async resume(): Promise<void> {
    this.worker.resume();
    logger.info('[ENRICHMENT-WORKER] Worker resumed');
  }

  /**
   * Gracefully close the worker
   */
  async close(): Promise<void> {
    await this.worker.close();
    logger.info('[ENRICHMENT-WORKER] Worker closed');
  }
}

// Singleton instance
let workerInstance: MemoryEnrichmentWorker | null = null;

/**
 * Initialize and start the enrichment worker
 */
export function startEnrichmentWorker(config: WorkerConfig): MemoryEnrichmentWorker {
  if (workerInstance) {
    logger.debug('[ENRICHMENT-WORKER] Returning existing worker instance');
    return workerInstance;
  }

  workerInstance = new MemoryEnrichmentWorker(config);
  return workerInstance;
}

/**
 * Get the current worker instance
 */
export function getEnrichmentWorker(): MemoryEnrichmentWorker | null {
  return workerInstance;
}

/**
 * Stop the enrichment worker
 */
export async function stopEnrichmentWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}
