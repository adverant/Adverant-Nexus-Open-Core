/**
 * Relevance Engine for Nexus Memory Lens
 *
 * Main orchestrator that combines:
 * - Score calculation (fused scoring)
 * - Decay functions (Ebbinghaus forgetting curve)
 * - Ripple recall (graph-propagated boosts)
 * - Relevance caching (Redis)
 */

import { Driver } from 'neo4j-driver';
import Redis from 'ioredis';
import winston from 'winston';
import { EnhancedTenantContext } from '../middleware/tenant-context';
import { Episode } from '../episodic/types';
import {
  calculateFusedScore,
  calculateAdaptiveFusedScore,
  detectQueryIntent,
  calculateTemporalScore,
  calculateFrequencyScore,
  ScoreComponents,
  FusedScoreResult,
  DEFAULT_WEIGHTS
} from './scoring/score-calculator';
import {
  calculateEbbinghaus,
  calculateStabilityBoost,
  RetrievabilityResult
} from './scoring/decay-functions';
import { RippleRecall, DEFAULT_RIPPLE_CONFIG } from './graph/ripple-recall';
import { RelevanceCache, createRelevanceCache } from './cache/relevance-cache';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'relevance-engine' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

/**
 * Relevance engine configuration
 */
export interface RelevanceEngineConfig {
  /** Neo4j driver for graph operations */
  neo4jDriver: Driver;
  /** Redis client for caching */
  redis: Redis;
  /** Enable adaptive query weights */
  enableAdaptiveWeights?: boolean;
  /** Enable graph-propagated decay */
  enableRippleRecall?: boolean;
  /** Enable caching */
  enableCache?: boolean;
}

/**
 * Retrieval options
 */
export interface RetrievalOptions {
  /** Query text */
  query: string;
  /** Maximum results to return */
  maxResults?: number;
  /** Whether to use adaptive weights */
  useAdaptiveWeights?: boolean;
  /** Custom scoring weights */
  customWeights?: any;
  /** Filter by episode type */
  typeFilter?: Array<Episode['type']>;
  /** Time range filter */
  timeRange?: {
    start: Date;
    end: Date;
  };
}

/**
 * Retrieval result with relevance scores
 */
export interface RelevanceRetrievalResult {
  /** Retrieved episodes with scores */
  episodes: Array<Episode & {
    relevanceScore: FusedScoreResult;
    retrievability: RetrievabilityResult;
    usedFallback: boolean;
  }>;
  /** Total count before limiting */
  totalCount: number;
  /** Whether cache was used */
  fromCache: boolean;
  /** Query intent detected */
  queryIntent?: any;
}

/**
 * Access event for recording
 */
export interface AccessEvent {
  /** Node that was accessed */
  nodeId: string;
  /** Type of access */
  accessType: 'view' | 'search_result' | 'related' | 'manual';
  /** Timestamp */
  timestamp?: Date;
}

/**
 * Relevance Engine
 */
export class RelevanceEngine {
  private neo4jDriver: Driver;
  private redis: Redis;
  private rippleRecall: RippleRecall;
  private cache: RelevanceCache;
  private enableAdaptiveWeights: boolean;
  private enableRippleRecall: boolean;
  private enableCache: boolean;

  constructor(config: RelevanceEngineConfig) {
    this.neo4jDriver = config.neo4jDriver;
    this.redis = config.redis;
    this.enableAdaptiveWeights = config.enableAdaptiveWeights !== false;
    this.enableRippleRecall = config.enableRippleRecall !== false;
    this.enableCache = config.enableCache !== false;

    // Initialize ripple recall
    this.rippleRecall = new RippleRecall(this.neo4jDriver, DEFAULT_RIPPLE_CONFIG);

    // Initialize cache
    this.cache = createRelevanceCache(this.redis, {
      defaultTTL: 300, // 5 minutes
      keyPrefix: 'relevance'
    });

    logger.info('RelevanceEngine initialized', {
      enableAdaptiveWeights: this.enableAdaptiveWeights,
      enableRippleRecall: this.enableRippleRecall,
      enableCache: this.enableCache
    });
  }

  /**
   * Retrieve episodes with relevance scoring
   *
   * Main retrieval method that:
   * 1. Checks cache
   * 2. Calculates relevance scores
   * 3. Applies decay (Ebbinghaus or graph-based)
   * 4. Returns ranked results
   *
   * @param options - Retrieval options
   * @param tenantContext - Tenant context
   * @returns Ranked episodes with scores
   */
  async retrieve(
    options: RetrievalOptions,
    tenantContext: EnhancedTenantContext
  ): Promise<RelevanceRetrievalResult> {
    const startTime = Date.now();

    try {
      // Check cache first
      if (this.enableCache) {
        const cached = await this.cache.get(options.query, tenantContext);
        if (cached) {
          logger.debug('Cache hit for query', {
            query: options.query.substring(0, 50),
            cachedResultCount: cached.scores.size
          });
          // TODO: Convert cached scores back to episodes
          // For now, fall through to computation
        }
      }

      // Detect query intent for adaptive weights
      const queryIntent = this.enableAdaptiveWeights
        ? detectQueryIntent(options.query)
        : undefined;

      // Fetch candidate episodes from Neo4j
      // This would normally be done by GraphitiService.recallEpisodes
      // For now, we'll work with episodes passed in

      const episodes: Episode[] = []; // Placeholder
      const scoredEpisodes: RelevanceRetrievalResult['episodes'] = [];

      for (const episode of episodes) {
        // Calculate score components
        const components = await this.calculateScoreComponents(episode, options);

        // Calculate fused score
        let fusedScore: FusedScoreResult;
        if (this.enableAdaptiveWeights && queryIntent) {
          fusedScore = calculateAdaptiveFusedScore(components, queryIntent);
        } else {
          fusedScore = calculateFusedScore(components, options.customWeights || DEFAULT_WEIGHTS);
        }

        // Calculate retrievability with decay
        const retrievability = await this.calculateRetrievability(episode, tenantContext);

        // Check if fallback was used
        const hasGraphRelationships = this.enableRippleRecall
          ? await this.rippleRecall.hasGraphRelationships(episode.id, tenantContext)
          : false;

        scoredEpisodes.push({
          ...episode,
          relevanceScore: fusedScore,
          retrievability,
          usedFallback: !hasGraphRelationships
        });
      }

      // Sort by fused score
      scoredEpisodes.sort((a, b) => b.relevanceScore.fusedScore - a.relevanceScore.fusedScore);

      // Limit results
      const maxResults = options.maxResults || 10;
      const limitedEpisodes = scoredEpisodes.slice(0, maxResults);

      // Cache results
      if (this.enableCache) {
        const scoresMap = new Map(
          limitedEpisodes.map(e => [e.id, e.relevanceScore])
        );
        await this.cache.set(options.query, scoresMap, tenantContext);
      }

      const result: RelevanceRetrievalResult = {
        episodes: limitedEpisodes,
        totalCount: scoredEpisodes.length,
        fromCache: false,
        queryIntent
      };

      logger.info('Retrieval completed', {
        query: options.query.substring(0, 50),
        totalCount: result.totalCount,
        returnedCount: result.episodes.length,
        durationMs: Date.now() - startTime
      });

      return result;
    } catch (error) {
      logger.error('Retrieval failed', {
        error: (error as Error).message,
        query: options.query.substring(0, 50)
      });
      throw error;
    }
  }

  /**
   * Record access event and trigger ripple boost
   *
   * When a user accesses a node:
   * 1. Update stability
   * 2. Trigger ripple propagation
   * 3. Invalidate cache
   *
   * @param event - Access event
   * @param tenantContext - Tenant context
   */
  async recordAccess(
    event: AccessEvent,
    tenantContext: EnhancedTenantContext
  ): Promise<void> {
    try {
      const { nodeId, accessType, timestamp = new Date() } = event;

      logger.info('Recording access', {
        nodeId,
        accessType,
        tenantId: tenantContext.tenantId
      });

      // Update stability in Neo4j
      await this.updateNodeStability(nodeId, tenantContext);

      // Trigger ripple propagation if enabled
      if (this.enableRippleRecall) {
        await this.rippleRecall.propagateBoost(nodeId, tenantContext);
      }

      // Invalidate cache
      if (this.enableCache) {
        await this.cache.invalidateNode(nodeId, tenantContext);
      }

      logger.debug('Access recorded successfully', { nodeId });
    } catch (error) {
      logger.error('Failed to record access', {
        error: (error as Error).message,
        nodeId: event.nodeId
      });
      // Don't throw - access recording is not critical
    }
  }

  /**
   * Batch update stability for all episodes
   *
   * Background job that:
   * 1. Calculates decay for all nodes
   * 2. Updates stability scores
   * 3. Records history
   *
   * @param tenantContext - Tenant context
   * @returns Number of nodes updated
   */
  async batchUpdateStability(tenantContext: EnhancedTenantContext): Promise<number> {
    const session = this.neo4jDriver.session();
    const now = new Date();
    let updatedCount = 0;

    try {
      logger.info('Starting batch stability update', {
        tenantId: tenantContext.tenantId
      });

      // Fetch all episodes in batches
      const batchSize = 1000;
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const result = await session.run(`
          MATCH (e:Episode)
          WHERE e.company_id = $companyId
            AND e.app_id = $appId
          RETURN e.id as id,
                 e.stability as stability,
                 e.last_accessed as lastAccessed,
                 e.importance as importance
          ORDER BY e.timestamp DESC
          SKIP $offset
          LIMIT $batchSize
        `, {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          offset,
          batchSize
        });

        if (result.records.length === 0) {
          hasMore = false;
          break;
        }

        // Calculate new stability for each episode
        for (const record of result.records) {
          const id = record.get('id');
          const currentStability = record.get('stability') || 0.5;
          const lastAccessed = record.get('lastAccessed')
            ? new Date(record.get('lastAccessed').toString())
            : new Date(0);
          const importance = record.get('importance') || 0.5;

          // Calculate hours since access
          const hoursSinceAccess = (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60);

          // Calculate new retrievability
          const retrievability = calculateEbbinghaus({
            stability: currentStability,
            hoursSinceAccess,
            importance
          });

          // Update stability in database
          await session.run(`
            MATCH (e:Episode {id: $id})
            SET e.stability = $newStability,
                e.retrievability = $retrievability,
                e.last_decay_update = datetime($now)
          `, {
            id,
            newStability: retrievability.stability,
            retrievability: retrievability.retrievability,
            now: now.toISOString()
          });

          updatedCount++;
        }

        offset += batchSize;
        logger.debug('Batch processed', { offset, updatedCount });
      }

      logger.info('Batch stability update completed', {
        tenantId: tenantContext.tenantId,
        updatedCount
      });

      return updatedCount;
    } catch (error) {
      logger.error('Batch stability update failed', {
        error: (error as Error).message,
        tenantId: tenantContext.tenantId
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Set user importance for a node
   *
   * @param nodeId - Node ID
   * @param importance - Importance score (0-1)
   * @param tenantContext - Tenant context
   */
  async setUserImportance(
    nodeId: string,
    importance: number,
    tenantContext: EnhancedTenantContext
  ): Promise<void> {
    const session = this.neo4jDriver.session();

    try {
      // Clamp importance
      const clampedImportance = Math.max(0, Math.min(1, importance));

      await session.run(`
        MATCH (e:Episode {id: $nodeId})
        WHERE e.company_id = $companyId
          AND e.app_id = $appId
          AND (e.user_id = $userId OR e.user_id = 'system')
        SET e.importance = $importance,
            e.user_importance_set = datetime($now)
      `, {
        nodeId,
        importance: clampedImportance,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
        userId: tenantContext.userId,
        now: new Date().toISOString()
      });

      logger.info('User importance set', {
        nodeId,
        importance: clampedImportance,
        tenantId: tenantContext.tenantId
      });

      // Invalidate cache
      if (this.enableCache) {
        await this.cache.invalidateNode(nodeId, tenantContext);
      }
    } finally {
      await session.close();
    }
  }

  /**
   * Calculate score components for an episode
   *
   * @private
   */
  private async calculateScoreComponents(
    episode: Episode,
    options: RetrievalOptions
  ): Promise<ScoreComponents> {
    // Semantic score (would come from vector similarity in production)
    const semantic = 0.8; // Placeholder

    // Temporal score based on age
    const ageHours = (Date.now() - episode.timestamp.getTime()) / (1000 * 60 * 60);
    const temporal = calculateTemporalScore(ageHours);

    // Frequency score (would come from access count in production)
    const frequency = calculateFrequencyScore(10); // Placeholder

    // Importance score
    const importance = episode.importance || 0.5;

    return {
      semantic,
      temporal,
      frequency,
      importance
    };
  }

  /**
   * Calculate retrievability with decay
   *
   * @private
   */
  private async calculateRetrievability(
    episode: Episode,
    tenantContext: EnhancedTenantContext
  ): Promise<RetrievabilityResult> {
    const session = this.neo4jDriver.session();

    try {
      // Fetch stability and last access from Neo4j
      const result = await session.run(`
        MATCH (e:Episode {id: $id})
        WHERE e.company_id = $companyId
          AND e.app_id = $appId
        RETURN e.stability as stability,
               e.last_accessed as lastAccessed,
               e.importance as importance
      `, {
        id: episode.id,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        // Episode not found, use defaults
        return calculateEbbinghaus({
          stability: 0.5,
          hoursSinceAccess: 0,
          importance: episode.importance
        });
      }

      const record = result.records[0];
      const stability = record.get('stability') || 0.5;
      const lastAccessed = record.get('lastAccessed')
        ? new Date(record.get('lastAccessed').toString())
        : episode.timestamp;
      const importance = record.get('importance') || episode.importance;

      const hoursSinceAccess = (Date.now() - lastAccessed.getTime()) / (1000 * 60 * 60);

      return calculateEbbinghaus({
        stability,
        hoursSinceAccess,
        importance
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Update node stability after access
   *
   * @private
   */
  private async updateNodeStability(
    nodeId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<void> {
    const session = this.neo4jDriver.session();

    try {
      // Get current state
      const result = await session.run(`
        MATCH (e:Episode {id: $nodeId})
        WHERE e.company_id = $companyId
          AND e.app_id = $appId
        RETURN e.stability as stability,
               e.retrievability as retrievability
      `, {
        nodeId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      if (result.records.length === 0) {
        return;
      }

      const record = result.records[0];
      const currentStability = record.get('stability') || 0.5;
      const retrievability = record.get('retrievability') || 0.5;

      // Calculate new stability with boost
      const newStability = calculateStabilityBoost(currentStability, retrievability);

      // Update in database
      await session.run(`
        MATCH (e:Episode {id: $nodeId})
        SET e.stability = $newStability,
            e.last_accessed = datetime($now),
            e.access_count = COALESCE(e.access_count, 0) + 1
      `, {
        nodeId,
        newStability,
        now: new Date().toISOString()
      });

      logger.debug('Node stability updated', {
        nodeId,
        oldStability: currentStability,
        newStability
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }
}
