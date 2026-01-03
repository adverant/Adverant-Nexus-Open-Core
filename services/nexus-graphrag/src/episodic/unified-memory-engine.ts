/**
 * Unified Memory Engine
 * Combines document-based GraphRAG with episodic Graphiti memory
 */

import winston from 'winston';
import { IGraphitiService, EnhancedRetrievalRequest, EnhancedRetrievalResponse, UnifiedMemory, Episode, StoreEpisodeRequest } from './types';
import { UnifiedStorageEngine } from '../storage/unified-storage-engine';
import { EnhancedTenantContext } from '../middleware/tenant-context';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'unified-memory' },
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
 * Create a default tenant context for system operations
 */
function createDefaultTenantContext(sessionId?: string): EnhancedTenantContext {
  return {
    companyId: 'system',
    appId: 'graphrag',
    tenantId: 'system:graphrag',
    userId: 'unified-memory',
    requestId: `umem-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    source: 'system',
    sessionId
  };
}

/**
 * Configuration for unified memory engine
 */
export interface UnifiedMemoryConfig {
  episodic_weight: number; // 0-1, how much to weight episodic vs document memory
  temporal_decay: boolean; // Whether to apply temporal decay to episodic memories
  max_context_tokens: number;
  auto_store_interactions: boolean; // Automatically store all interactions as episodes
  consolidation_interval_hours: number;
}

/**
 * Unified Memory Engine Implementation
 */
export class UnifiedMemoryEngine {
  private graphitiService: IGraphitiService;
  private unifiedStorage: UnifiedStorageEngine;
  private config: UnifiedMemoryConfig;
  private sessionContext: Map<string, Episode[]> = new Map();

  constructor(
    graphitiService: IGraphitiService,
    unifiedStorage: UnifiedStorageEngine,
    config: UnifiedMemoryConfig
  ) {
    this.graphitiService = graphitiService;
    this.unifiedStorage = unifiedStorage;
    this.config = config;

    logger.info('Unified Memory Engine initialized', {
      episodic_weight: config.episodic_weight,
      auto_store: config.auto_store_interactions
    });

    // Start consolidation interval if configured
    if (config.consolidation_interval_hours > 0) {
      this.startConsolidationSchedule();
    }
  }

  /**
   * Enhanced retrieval combining episodic and document memory
   */
  async retrieve(request: EnhancedRetrievalRequest, tenantContext: EnhancedTenantContext): Promise<EnhancedRetrievalResponse> {
    const startTime = Date.now();

    try {
      // Parallel retrieval from both systems
      // IMPORTANT: Pass tenantContext to episodic retrieval for proper tenant isolation
      const [episodicResult, documentResult] = await Promise.all([
        request.include_episodic
          ? this.retrieveEpisodic(request, tenantContext)
          : Promise.resolve(null),
        request.include_documents
          ? this.retrieveDocuments(request, tenantContext)
          : Promise.resolve(null)
      ]);

      // Combine and rank results
      const unifiedMemories = await this.combineMemories(
        episodicResult,
        documentResult,
        request
      );

      // Calculate token distribution for auxiliary fields
      const maxTokens = request.max_tokens;
      const unifiedTokens = this.estimateTokensForArray(unifiedMemories, m => m.content);
      const remainingTokens = Math.max(0, maxTokens - unifiedTokens);

      // Allocate remaining tokens: 35% episodic, 35% document, 30% other
      const episodicTokenBudget = Math.floor(remainingTokens * 0.35);
      const documentTokenBudget = Math.floor(remainingTokens * 0.35);
      const otherTokenBudget = Math.floor(remainingTokens * 0.30);

      // Extract entities and facts from episodic context
      const entities = episodicResult?.entities || [];
      const facts = [];

      // Get relevant facts if episodic memories found entities
      if (entities.length > 0) {
        const entityNames = entities.map(e => e.name);
        for (const name of entityNames.slice(0, 5)) { // Limit to top 5 entities
          const entityFacts = await this.graphitiService.getFacts(name, tenantContext);
          facts.push(...entityFacts);
        }
      }

      // Generate follow-up suggestions based on context
      const suggestedFollowups = this.generateFollowupSuggestions(
        unifiedMemories,
        entities
      );

      // Store the interaction if auto-store is enabled
      if (this.config.auto_store_interactions && request.session_context) {
        await this.storeInteraction(request, unifiedMemories);
      }

      // Apply token limiting to all response fields
      // IMPORTANT: Remove embeddings to prevent massive response sizes
      const cleanedUnifiedMemories = this.removeEmbeddings(unifiedMemories);

      // Type-narrow episodes to expected array type
      const episodes = episodicResult?.episodes || [];
      const episodicEpisodes = Array.isArray(episodes) && episodes.length > 0 && 'relevance_score' in episodes[0]
        ? episodes as Array<Episode & { relevance_score: number; decay_factor: number; connected_episodes?: Episode[] }>
        : [];

      const response: EnhancedRetrievalResponse = {
        unified_memories: cleanedUnifiedMemories,
        // Limit episodic context by tokens (with embeddings removed)
        episodic_context: this.removeEmbeddings(
          this.limitFieldByTokens(
            episodicEpisodes,
            episodicTokenBudget,
            (episode) => this.estimateTokens(JSON.stringify(this.removeEmbeddings(episode)))
          )
        ),
        // Limit document context by tokens (with embeddings removed)
        document_context: this.removeEmbeddings(
          this.limitFieldByTokens(
            documentResult || [],
            documentTokenBudget,
            (doc) => this.estimateTokens(JSON.stringify(this.removeEmbeddings(doc)))
          )
        ),
        // Limit entities and facts by count (they're usually small)
        entities_mentioned: entities.slice(0, 10),
        relevant_facts: this.limitFieldByTokens(
          facts,
          Math.floor(otherTokenBudget * 0.6),
          (fact) => this.estimateTokens(JSON.stringify(fact))
        ),
        suggested_followups: suggestedFollowups // Already limited to 5
      };

      const duration = Date.now() - startTime;
      logger.info('Enhanced retrieval completed', {
        query: request.query ? request.query.substring(0, 100) : 'N/A',
        unified_count: unifiedMemories?.length || 0,
        episodic_count: response.episodic_context?.length || 0,
        document_count: response.document_context?.length || 0,
        total_tokens_estimate: unifiedTokens + episodicTokenBudget + documentTokenBudget,
        duration
      });

      return response;

    } catch (error) {
      logger.error('Enhanced retrieval failed', { error, request });
      throw error;
    }
  }

  /**
   * Store a user interaction as an episode
   */
  async storeInteraction(
    request: EnhancedRetrievalRequest,
    memories: UnifiedMemory[]
  ): Promise<void> {
    try {
      // Extract document IDs from memories
      const documentIds = memories
        .filter(m => m.document_metadata?.id)
        .map(m => m.document_metadata!.id!)
        .filter((id): id is string => id !== undefined);

      // Create episode for the user query
      const queryEpisode: StoreEpisodeRequest = {
        content: request.query,
        type: 'user_query',
        source: {
          type: 'conversation',
          session_id: request.session_context,
          user_id: request.user_context,
          document_ids: documentIds
        },
        metadata: {
          time_context: request.time_context,
          max_tokens: request.max_tokens
        }
      };

      const defaultTenantContext = createDefaultTenantContext(request.session_context);

      const result = await this.graphitiService.storeEpisode(queryEpisode, defaultTenantContext);

      // Update session context
      if (request.session_context) {
        const sessionEpisodes = this.sessionContext.get(request.session_context) || [];
        const episode = await this.graphitiService.getEpisodeById(result.episode_id, defaultTenantContext);
        if (episode) {
          sessionEpisodes.push(episode);
          this.sessionContext.set(request.session_context, sessionEpisodes);
        }
      }

      logger.debug('Interaction stored as episode', {
        episode_id: result.episode_id,
        session: request.session_context
      });

    } catch (error) {
      logger.error('Failed to store interaction', { error });
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Store a response as an episode
   */
  async storeResponse(
    query: string,
    response: string,
    sessionContext?: string,
    documentIds?: string[]
  ): Promise<void> {
    try {
      const responseEpisode: StoreEpisodeRequest = {
        content: response,
        type: 'system_response',
        source: {
          type: 'conversation',
          session_id: sessionContext,
          document_ids: documentIds
        },
        metadata: {
          query,
          timestamp: new Date()
        }
      };

      const defaultTenantContext = createDefaultTenantContext(sessionContext);

      await this.graphitiService.storeEpisode(responseEpisode, defaultTenantContext);

      logger.debug('Response stored as episode', {
        session: sessionContext
      });

    } catch (error) {
      logger.error('Failed to store response', { error });
    }
  }

  /**
   * Retrieve from episodic memory
   * @param request - Enhanced retrieval request
   * @param tenantContext - Tenant context for multi-tenant isolation (REQUIRED for proper data access)
   */
  private async retrieveEpisodic(request: EnhancedRetrievalRequest, tenantContext: EnhancedTenantContext) {
    const episodicRequest = {
      query: request.query,
      time_range: request.time_context ? {
        start: new Date(request.time_context.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days before
        end: new Date(request.time_context.getTime() + 1 * 24 * 60 * 60 * 1000) // 1 day after
      } : undefined,
      max_results: 20,
      include_decay: this.config.temporal_decay
    };

    // Add session context if available
    if (request.session_context) {
      const sessionEpisodes = this.sessionContext.get(request.session_context);
      if (sessionEpisodes && sessionEpisodes.length > 0) {
        // Include recent session episodes in the search
        episodicRequest.time_range = {
          start: sessionEpisodes[0].timestamp,
          end: new Date()
        };
      }
    }

    // Use the passed tenantContext instead of creating a default one
    // This ensures proper tenant isolation and matches the tenant context used for document retrieval
    logger.debug('Retrieving episodic memories with tenant context', {
      companyId: tenantContext.companyId,
      appId: tenantContext.appId,
      userId: tenantContext.userId
    });

    return await this.graphitiService.recallEpisodes(episodicRequest, tenantContext);
  }

  /**
   * Retrieve from document memory
   */
  private async retrieveDocuments(request: EnhancedRetrievalRequest, tenantContext: EnhancedTenantContext) {
    // Use unifiedSearch to get both memories and documents
    const searchResult = await this.unifiedStorage.unifiedSearch({
      query: request.query,
      contentTypes: request.include_documents ? ['all'] : ['memory'],
      limit: 20
    }, tenantContext);

    return searchResult.items.map(item => ({
      id: item.id,
      content: item.content,
      metadata: item.metadata,
      relevance_score: item.relevance
    }));
  }

  /**
   * Combine episodic and document memories into unified results
   */
  private async combineMemories(
    episodicResult: any,
    documentResult: any,
    request: EnhancedRetrievalRequest
  ): Promise<UnifiedMemory[]> {
    const unified: UnifiedMemory[] = [];
    let currentTokens = 0;
    const maxTokens = request.max_tokens;

    // Weight for combining scores
    const episodicWeight = this.config.episodic_weight;
    const documentWeight = 1 - episodicWeight;

    // Process episodic memories
    if (episodicResult && episodicResult.episodes) {
      for (const episode of episodicResult.episodes) {
        // Defensive: skip episodes without content
        if (!episode || !episode.content) {
          logger.debug('Skipping episode without content', { episodeId: episode?.id });
          continue;
        }

        const tokens = this.estimateTokens(episode.content);
        if (currentTokens + tokens > maxTokens) break;

        unified.push({
          id: episode.id,
          type: 'episodic',
          content: episode.content,
          timestamp: episode.timestamp,
          source: 'graphiti',
          episode_metadata: episode,
          relevance_score: episode.relevance_score * episodicWeight,
          temporal_relevance: episode.decay_factor,
          causal_relevance: this.calculateCausalRelevance(episode, episodicResult.episodes)
        });

        currentTokens += tokens;
      }
    }

    // Process document memories
    if (documentResult && Array.isArray(documentResult)) {
      for (const doc of documentResult) {
        // Defensive: skip documents without content
        if (!doc || !doc.content) {
          logger.debug('Skipping document without content', { docId: doc?.id });
          continue;
        }

        const tokens = this.estimateTokens(doc.content);
        if (currentTokens + tokens > maxTokens) break;

        unified.push({
          id: doc.id,
          type: 'document',
          content: doc.content,
          timestamp: new Date(doc.metadata?.created_at || Date.now()),
          source: 'graphrag',
          document_metadata: doc.metadata,
          relevance_score: doc.relevance_score * documentWeight
        });

        currentTokens += tokens;
      }
    }

    // Sort by combined relevance score
    unified.sort((a, b) => {
      const scoreA = this.calculateCombinedScore(a);
      const scoreB = this.calculateCombinedScore(b);
      return scoreB - scoreA;
    });

    // Interleave episodic and document memories for balance
    return this.interleaveMemories(unified, maxTokens);
  }

  /**
   * Calculate combined score for ranking
   */
  private calculateCombinedScore(memory: UnifiedMemory): number {
    let score = memory.relevance_score;

    // Boost for temporal relevance
    if (memory.temporal_relevance) {
      score += memory.temporal_relevance * 0.2;
    }

    // Boost for causal relevance
    if (memory.causal_relevance) {
      score += memory.causal_relevance * 0.3;
    }

    // Slight boost for recent memories
    const ageHours = (Date.now() - memory.timestamp.getTime()) / (1000 * 60 * 60);
    const recencyBoost = Math.exp(-ageHours / 168); // Decay over a week
    score += recencyBoost * 0.1;

    return Math.min(score, 1.0);
  }

  /**
   * Calculate causal relevance based on episode connections
   */
  private calculateCausalRelevance(episode: Episode, allEpisodes: Episode[]): number {
    // Check if this episode is causally connected to others in the result set
    const connectedCount = allEpisodes.filter(e =>
      e.id !== episode.id && (
        e.metadata?.interaction_id === episode.metadata?.interaction_id ||
        e.metadata?.session_id === episode.metadata?.session_id
      )
    ).length;

    return Math.min(connectedCount * 0.2, 1.0);
  }

  /**
   * Interleave memories for balanced context
   */
  private interleaveMemories(memories: UnifiedMemory[], maxTokens: number): UnifiedMemory[] {
    const episodic = memories.filter(m => m.type === 'episodic');
    const document = memories.filter(m => m.type === 'document');
    const hybrid = memories.filter(m => m.type === 'hybrid');

    const result: UnifiedMemory[] = [];
    let currentTokens = 0;
    let episodicIndex = 0;
    let documentIndex = 0;
    let hybridIndex = 0;

    // Interleave memories, prioritizing hybrid
    while (currentTokens < maxTokens) {
      // Add hybrid memory if available
      if (hybridIndex < hybrid.length) {
        const memory = hybrid[hybridIndex++];
        const tokens = this.estimateTokens(memory.content);
        if (currentTokens + tokens <= maxTokens) {
          result.push(memory);
          currentTokens += tokens;
        }
      }

      // Alternate between episodic and document
      if (episodicIndex < episodic.length && currentTokens < maxTokens) {
        const memory = episodic[episodicIndex++];
        const tokens = this.estimateTokens(memory.content);
        if (currentTokens + tokens <= maxTokens) {
          result.push(memory);
          currentTokens += tokens;
        }
      }

      if (documentIndex < document.length && currentTokens < maxTokens) {
        const memory = document[documentIndex++];
        const tokens = this.estimateTokens(memory.content);
        if (currentTokens + tokens <= maxTokens) {
          result.push(memory);
          currentTokens += tokens;
        }
      }

      // Break if no more memories can be added
      if (episodicIndex >= episodic.length &&
          documentIndex >= document.length &&
          hybridIndex >= hybrid.length) {
        break;
      }
    }

    return result;
  }

  /**
   * Generate follow-up suggestions based on context
   */
  private generateFollowupSuggestions(
    memories: UnifiedMemory[],
    entities: any[]
  ): string[] {
    const suggestions: string[] = [];

    // Suggest exploring mentioned entities
    const topEntities = entities
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 3);

    for (const entity of topEntities) {
      suggestions.push(`Tell me more about ${entity.name}`);
    }

    // Suggest temporal exploration if episodic memories present
    const episodicMemories = memories.filter(m => m.type === 'episodic');
    if (episodicMemories.length > 0) {
      suggestions.push('What happened before this?');
      suggestions.push('What were the consequences?');
    }

    // Suggest document exploration if documents present
    const documentMemories = memories.filter(m => m.type === 'document');
    if (documentMemories.length > 0) {
      suggestions.push('Show me related documents');
      suggestions.push('Summarize the key points');
    }

    return suggestions.slice(0, 5);
  }

  /**
   * Estimate token count for content
   * Defensive: handles null/undefined content gracefully
   */
  private estimateTokens(content: string | undefined | null): number {
    // Defensive programming: handle null/undefined content
    if (!content || typeof content !== 'string') {
      logger.warn('estimateTokens called with invalid content', {
        contentType: typeof content,
        isNull: content === null,
        isUndefined: content === undefined
      });
      return 0;
    }

    // Simple estimation: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Estimate tokens for an array of items
   */
  private estimateTokensForArray<T>(items: T[], contentExtractor: (item: T) => string): number {
    let totalTokens = 0;
    for (const item of items) {
      totalTokens += this.estimateTokens(contentExtractor(item));
    }
    return totalTokens;
  }

  /**
   * Limit array of items by token budget
   */
  private limitFieldByTokens<T>(
    items: T[],
    tokenBudget: number,
    tokenEstimator: (item: T) => number
  ): T[] {
    const limited: T[] = [];
    let usedTokens = 0;

    for (const item of items) {
      const itemTokens = tokenEstimator(item);
      if (usedTokens + itemTokens > tokenBudget) {
        // Stop adding items if we exceed budget
        break;
      }
      limited.push(item);
      usedTokens += itemTokens;
    }

    return limited;
  }

  /**
   * Remove embeddings from object to reduce size
   */
  private removeEmbeddings(obj: any): any {
    if (!obj) return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => this.removeEmbeddings(item));
    }

    if (typeof obj === 'object') {
      const cleaned = { ...obj };

      // Remove embedding fields
      delete cleaned.embedding;
      delete cleaned.embeddings;
      delete cleaned.vector;

      // Recursively clean nested objects
      for (const key in cleaned) {
        if (typeof cleaned[key] === 'object') {
          cleaned[key] = this.removeEmbeddings(cleaned[key]);
        }
      }

      return cleaned;
    }

    return obj;
  }

  /**
   * Start periodic memory consolidation
   */
  private startConsolidationSchedule(): void {
    const intervalMs = this.config.consolidation_interval_hours * 60 * 60 * 1000;

    setInterval(async () => {
      try {
        const before = new Date();
        before.setDate(before.getDate() - 30); // Consolidate memories older than 30 days

        const defaultTenantContext = createDefaultTenantContext();

        const consolidatedCount = await this.graphitiService.consolidateMemories(before, defaultTenantContext);

        logger.info('Memory consolidation completed', {
          consolidatedCount,
          beforeDate: before
        });

      } catch (error) {
        logger.error('Memory consolidation failed', { error });
      }
    }, intervalMs);

    logger.info('Memory consolidation schedule started', {
      intervalHours: this.config.consolidation_interval_hours
    });
  }

  /**
   * Get session context
   */
  getSessionContext(sessionId: string): Episode[] {
    return this.sessionContext.get(sessionId) || [];
  }

  /**
   * Clear session context
   */
  clearSessionContext(sessionId: string): void {
    this.sessionContext.delete(sessionId);
    logger.debug('Session context cleared', { sessionId });
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{
    episodic: any;
    documents: number;
    sessions: number;
    combined_health: number;
  }> {
    const defaultTenantContext = createDefaultTenantContext();
    const episodicStats = await this.graphitiService.getMemoryStats(defaultTenantContext);

    // Get document count from storage
    const documentCount = 100; // Placeholder - implement actual count

    return {
      episodic: episodicStats,
      documents: documentCount,
      sessions: this.sessionContext.size,
      combined_health: (episodicStats.memory_health + 0.8) / 2 // Weighted average
    };
  }
}