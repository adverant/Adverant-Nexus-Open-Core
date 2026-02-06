/**
 * Context Service for MageAgent
 * Synthesizes context from multiple memory sources for agent enrichment
 * Core component of the Cognitive Memory Loop
 *
 * 🔒 PHASE 47: Multi-tenant context propagation
 */

import { graphRAGClient, createGraphRAGClient } from '../clients/graphrag-client';
import type { TenantContext } from '../middleware/tenant-context.js';
import { OpenRouterClient } from '../clients/openrouter-client';
import { config } from '../config';
import { episodeService } from './episode-service';
import { logger } from '../utils/logger';

export interface EnrichedContext {
  query: string;
  episodes: any[];
  documents: any[];
  memories: any[];
  entities: string[];
  relationships: any[];
  facts: string[];
  summary: string;
  relevanceScore: number;
  temporalContext?: {
    pattern: string;
    timeRange: { start: Date; end: Date };
    frequency: number;
  };
  recommendations?: string[];
}

export interface ContextOptions {
  episodeLimit?: number;
  documentLimit?: number;
  memoryLimit?: number;
  graphDepth?: number;
  includeDecay?: boolean;
  sessionId?: string;
  agentId?: string;
  threadId?: string;
  timeWindow?: number; // hours
  minRelevance?: number;
  includeRelationships?: boolean;
  includeFacts?: boolean;
  includeEpisodes?: boolean;
  includeDocuments?: boolean;
  includeMemories?: boolean;
  includeGraph?: boolean;
  limit?: number;
  // 🔒 PHASE 47: Add tenant context for multi-tenant isolation
  tenantContext?: TenantContext;
}

export class ContextService {
  private static instance: ContextService;
  private openRouterClient: OpenRouterClient;
  private contextCache: Map<string, { context: EnrichedContext; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    this.openRouterClient = new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl,
      { filterFreeModels: true }
    );
  }

  /**
   * Helper method to simplify OpenRouter API calls
   */
  private async complete(options: {
    prompt: string;
    model: string;
    maxTokens: number;
    temperature: number;
  }): Promise<{ content: string }> {
    const response = await this.openRouterClient.createCompletion({
      model: options.model,
      messages: [{ role: 'user', content: options.prompt }],
      max_tokens: options.maxTokens,
      temperature: options.temperature
    });
    return { content: response.choices[0].message.content };
  }

  public static getInstance(): ContextService {
    if (!ContextService.instance) {
      ContextService.instance = new ContextService();
    }
    return ContextService.instance;
  }

  /**
   * CRITICAL FIX: Paged context synthesis for extreme complexity tasks
   * Prevents memory overflow by using paged memory retrieval
   * Use this for tasks like 50k word generation, complex medical diagnosis, large code analysis
   *
   * @param query - Search query
   * @param options - Context options with optional maxTokens and chunkSize
   * @returns Enriched context with token budget enforcement
   */
  async synthesizeContextPaged(
    query: string,
    options: ContextOptions & { maxTokens?: number; chunkSize?: number } = {}
  ): Promise<EnrichedContext> {
    try {
      // Check cache first
      const cacheKey = this.getCacheKey(query, options);
      const cached = this.contextCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        logger.debug('Using cached paged context', { query, cacheKey });
        return cached.context;
      }

      // Parallel retrieval with paged memory processing
      const [episodes, documents, memories, graphData] = await Promise.all([
        this.retrieveEpisodes(query, options),
        this.retrieveDocuments(query, options),
        this.retrieveMemoriesPaged(query, options), // CRITICAL: Use paged retrieval
        this.queryKnowledgeGraph(query, options)
      ]);

      // Process and rank results
      const rankedEpisodes = this.rankByRelevance(episodes, query);
      const summarizedDocuments = this.summarizeDocuments(documents);
      const filteredMemories = this.filterMemories(memories, options.minRelevance);

      // Extract entities and relationships
      const entities = this.extractEntities(graphData);
      const relationships = this.extractRelationships(graphData);
      const facts = this.extractFacts([...episodes, ...documents, ...memories]);

      // Generate context summary
      const summary = await this.generateContextSummary({
        episodes: rankedEpisodes,
        documents: summarizedDocuments,
        memories: filteredMemories,
        entities,
        relationships,
        facts
      });

      // Analyze temporal patterns if episodes exist
      const temporalContext = rankedEpisodes.length > 0
        ? this.analyzeTemporalContext(rankedEpisodes)
        : undefined;

      // Generate recommendations based on context
      const recommendations = await this.generateRecommendations({
        query,
        episodes: rankedEpisodes,
        documents: summarizedDocuments,
        entities,
        facts
      });

      // Calculate overall relevance score
      const relevanceScore = await this.calculateRelevanceScore({
        episodes: rankedEpisodes,
        documents: summarizedDocuments,
        memories: filteredMemories
      });

      const context: EnrichedContext = {
        query,
        episodes: rankedEpisodes.slice(0, options.episodeLimit || 10),
        documents: summarizedDocuments.slice(0, options.documentLimit || 5),
        memories: filteredMemories.slice(0, options.memoryLimit || 10),
        entities,
        relationships,
        facts: facts.slice(0, 20), // Limit facts
        summary,
        relevanceScore,
        temporalContext,
        recommendations
      };

      // Cache the context
      this.contextCache.set(cacheKey, {
        context,
        timestamp: Date.now()
      });

      logger.info('Paged context synthesized', {
        query,
        episodeCount: context.episodes.length,
        documentCount: context.documents.length,
        memoryCount: context.memories.length,
        entityCount: context.entities.length,
        relevanceScore: context.relevanceScore,
        maxTokens: options.maxTokens,
        chunkSize: options.chunkSize
      });

      return context;
    } catch (error) {
      logger.error('Failed to synthesize paged context', { error, query });
      // Return minimal context on error
      return this.getMinimalContext(query);
    }
  }

  /**
   * Synthesize comprehensive context for a query
   */
  async synthesizeContext(
    query: string,
    options: ContextOptions = {}
  ): Promise<EnrichedContext> {
    try {
      // Check cache first
      const cacheKey = this.getCacheKey(query, options);
      const cached = this.contextCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        logger.debug('Using cached context', { query, cacheKey });
        return cached.context;
      }

      // Parallel retrieval from all sources
      const [episodes, documents, memories, graphData] = await Promise.all([
        this.retrieveEpisodes(query, options),
        this.retrieveDocuments(query, options),
        this.retrieveMemories(query, options),
        this.queryKnowledgeGraph(query, options)
      ]);

      // Process and rank results
      const rankedEpisodes = this.rankByRelevance(episodes, query);
      const summarizedDocuments = this.summarizeDocuments(documents);
      const filteredMemories = this.filterMemories(memories, options.minRelevance);

      // Extract entities and relationships
      const entities = this.extractEntities(graphData);
      const relationships = this.extractRelationships(graphData);
      const facts = this.extractFacts([...episodes, ...documents, ...memories]);

      // Generate context summary
      const summary = await this.generateContextSummary({
        episodes: rankedEpisodes,
        documents: summarizedDocuments,
        memories: filteredMemories,
        entities,
        relationships,
        facts
      });

      // Analyze temporal patterns if episodes exist
      const temporalContext = rankedEpisodes.length > 0
        ? this.analyzeTemporalContext(rankedEpisodes)
        : undefined;

      // Generate recommendations based on context
      const recommendations = await this.generateRecommendations({
        query,
        episodes: rankedEpisodes,
        documents: summarizedDocuments,
        entities,
        facts
      });

      // Calculate overall relevance score
      const relevanceScore = await this.calculateRelevanceScore({
        episodes: rankedEpisodes,
        documents: summarizedDocuments,
        memories: filteredMemories
      });

      const context: EnrichedContext = {
        query,
        episodes: rankedEpisodes.slice(0, options.episodeLimit || 10),
        documents: summarizedDocuments.slice(0, options.documentLimit || 5),
        memories: filteredMemories.slice(0, options.memoryLimit || 10),
        entities,
        relationships,
        facts: facts.slice(0, 20), // Limit facts
        summary,
        relevanceScore,
        temporalContext,
        recommendations
      };

      // Cache the context
      this.contextCache.set(cacheKey, {
        context,
        timestamp: Date.now()
      });

      logger.info('Context synthesized', {
        query,
        episodeCount: context.episodes.length,
        documentCount: context.documents.length,
        memoryCount: context.memories.length,
        entityCount: context.entities.length,
        relevanceScore: context.relevanceScore
      });

      return context;
    } catch (error) {
      logger.error('Failed to synthesize context', { error, query });
      // Return minimal context on error
      return this.getMinimalContext(query);
    }
  }

  /**
   * Create context for agent prompt enrichment
   */
  async createAgentContext(
    prompt: string,
    agentConfig: any,
    sessionId?: string
  ): Promise<string> {
    try {
      const context = await this.synthesizeContext(prompt, {
        sessionId,
        agentId: agentConfig.id,
        episodeLimit: 5,
        documentLimit: 3,
        memoryLimit: 5,
        includeDecay: true,
        timeWindow: 24 // Last 24 hours
      });

      // Format context for injection into agent prompt
      let contextStr = '';

      if (context.summary) {
        contextStr += `## Context Summary\n${context.summary}\n\n`;
      }

      if (context.episodes.length > 0) {
        contextStr += `## Recent Relevant Interactions\n`;
        context.episodes.forEach((ep, idx) => {
          contextStr += `${idx + 1}. ${ep.content.substring(0, 200)}...\n`;
        });
        contextStr += '\n';
      }

      if (context.documents.length > 0) {
        contextStr += `## Relevant Knowledge\n`;
        context.documents.forEach((doc, idx) => {
          contextStr += `${idx + 1}. ${doc.summary || doc.content.substring(0, 200)}...\n`;
        });
        contextStr += '\n';
      }

      if (context.facts.length > 0) {
        contextStr += `## Key Facts\n`;
        context.facts.slice(0, 5).forEach((fact, idx) => {
          contextStr += `${idx + 1}. ${fact}\n`;
        });
        contextStr += '\n';
      }

      if (context.recommendations && context.recommendations.length > 0) {
        contextStr += `## Recommendations\n`;
        context.recommendations.forEach((rec, idx) => {
          contextStr += `${idx + 1}. ${rec}\n`;
        });
        contextStr += '\n';
      }

      return contextStr;
    } catch (error) {
      logger.error('Failed to create agent context', { error, prompt });
      return ''; // Return empty context on error
    }
  }

  /**
   * Retrieve relevant episodes
   * 🔒 PHASE 48: Updated to use episodeService with tenant context
   */
  private async retrieveEpisodes(query: string, options: ContextOptions): Promise<any[]> {
    try {
      // PHASE 48: Use episodeService.recallEpisodes with tenant context
      const episodeContext = await episodeService.recallEpisodes(
        query,
        {
          limit: options.episodeLimit || 10,
          sessionId: options.sessionId,
          agentId: options.agentId,
          includeDecay: options.includeDecay !== false
        },
        options.tenantContext
      );

      return episodeContext.episodes;
    } catch (error) {
      logger.error('Failed to retrieve episodes', { error });
      return [];
    }
  }

  /**
   * Retrieve relevant documents
   * 🔒 PHASE 47: Added tenant context propagation for multi-tenant isolation
   */
  private async retrieveDocuments(query: string, options: ContextOptions): Promise<any[]> {
    try {
      // 🔒 PHASE 47: Use tenant-aware client if context is available
      const client = options.tenantContext
        ? createGraphRAGClient(options.tenantContext)
        : graphRAGClient;

      const documents = await client.retrieveDocuments({
        query,
        limit: options.documentLimit || 5,
        strategy: 'semantic_chunks'
      });

      return documents;
    } catch (error) {
      logger.error('Failed to retrieve documents', { error });
      return [];
    }
  }

  /**
   * Retrieve relevant memories
   * 🔒 PHASE 47: Added tenant context propagation for multi-tenant isolation
   */
  private async retrieveMemories(query: string, options: ContextOptions): Promise<any[]> {
    try {
      // 🔒 PHASE 47: Use tenant-aware client if context is available
      const client = options.tenantContext
        ? createGraphRAGClient(options.tenantContext)
        : graphRAGClient;

      const memories = await client.recallMemory({
        query,
        limit: options.memoryLimit || 10,
        score_threshold: options.minRelevance || 0.3
      });

      return memories;
    } catch (error) {
      logger.error('Failed to retrieve memories', { error });
      return [];
    }
  }

  /**
   * CRITICAL FIX: Paged memory retrieval for extreme complexity tasks
   * Prevents memory overflow by processing memories in chunks
   * Essential for 50k word generation scenarios
   *
   * Strategy: Process 2-3 memories at a time with hard token limit
   * Enforces strict token budget to prevent LLM context window exhaustion
   * 🔒 PHASE 47: Added tenant context propagation for multi-tenant isolation
   */
  private async retrieveMemoriesPaged(
    query: string,
    options: ContextOptions & { maxTokens?: number; chunkSize?: number }
  ): Promise<any[]> {
    try {
      const chunkSize = options.chunkSize || 2; // Process 2 memories at a time
      const maxTokens = options.maxTokens || 4000; // Hard limit: 4000 tokens total
      const memoryLimit = options.memoryLimit || 10;

      // 🔒 PHASE 47: Use tenant-aware client if context is available
      const client = options.tenantContext
        ? createGraphRAGClient(options.tenantContext)
        : graphRAGClient;

      // Retrieve all matching memories (initial fetch)
      const allMemories = await client.recallMemory({
        query,
        limit: memoryLimit,
        score_threshold: options.minRelevance || 0.3
      });

      if (allMemories.length === 0) {
        return [];
      }

      // Process memories in chunks to prevent overflow
      const processedMemories: any[] = [];
      let currentTokenCount = 0;

      for (let i = 0; i < allMemories.length; i += chunkSize) {
        const chunk = allMemories.slice(i, i + chunkSize);

        // Estimate token count for chunk (rough heuristic: 1 token ≈ 4 chars)
        const chunkTokenEstimate = chunk.reduce((sum: number, mem: any) => {
          const contentLength = (mem.content || '').length;
          return sum + Math.ceil(contentLength / 4);
        }, 0);

        // Check if adding this chunk exceeds token budget
        if (currentTokenCount + chunkTokenEstimate > maxTokens) {
          logger.warn('Memory token budget exceeded - truncating results', {
            currentTokenCount,
            attemptedChunkTokens: chunkTokenEstimate,
            maxTokens,
            memoriesProcessed: processedMemories.length,
            memoriesSkipped: allMemories.length - i
          });
          break; // Stop processing - budget exhausted
        }

        // Summarize chunk if content is too large
        const summarizedChunk = chunk.map((mem: any) => {
          const content = mem.content || '';
          const estimatedTokens = Math.ceil(content.length / 4);

          // If individual memory exceeds 2000 tokens, truncate it
          if (estimatedTokens > 2000) {
            logger.debug('Truncating large memory', {
              memoryId: mem.id,
              originalTokens: estimatedTokens,
              truncatedTo: 2000
            });

            return {
              ...mem,
              content: content.substring(0, 8000) + '... [TRUNCATED]', // 2000 tokens ≈ 8000 chars
              truncated: true,
              originalLength: content.length
            };
          }

          return mem;
        });

        processedMemories.push(...summarizedChunk);
        currentTokenCount += chunkTokenEstimate;

        // Log progress for debugging extreme complexity scenarios
        if (i % 10 === 0 && i > 0) {
          logger.debug('Memory paging progress', {
            memoriesProcessed: processedMemories.length,
            currentTokenCount,
            remainingBudget: maxTokens - currentTokenCount,
            percentComplete: ((i / allMemories.length) * 100).toFixed(1)
          });
        }
      }

      logger.info('Paged memory retrieval complete', {
        totalMemoriesFetched: allMemories.length,
        memoriesReturned: processedMemories.length,
        totalTokensUsed: currentTokenCount,
        tokenBudget: maxTokens,
        utilizationPercent: ((currentTokenCount / maxTokens) * 100).toFixed(1)
      });

      return processedMemories;

    } catch (error) {
      logger.error('Failed to retrieve paged memories', { error, query });
      return [];
    }
  }

  /**
   * Query knowledge graph for entities and relationships
   * 🔒 PHASE 47: Added tenant context propagation for multi-tenant isolation
   */
  private async queryKnowledgeGraph(query: string, options: ContextOptions): Promise<any> {
    try {
      // Extract key terms from query for graph search
      const keywords = this.extractKeywords(query);

      // 🔒 PHASE 47: Use tenant-aware client if context is available
      const client = options.tenantContext
        ? createGraphRAGClient(options.tenantContext)
        : graphRAGClient;

      // Query Neo4j for related entities
      /* const graphQuery = `
        MATCH (e:Entity)
        WHERE ANY(keyword IN $keywords WHERE e.name CONTAINS keyword)
        OPTIONAL MATCH (e)-[r]-(related:Entity)
        RETURN e, r, related
        LIMIT ${options.graphDepth || 20}
      `; */

      // In production, this would query Neo4j directly
      // For now, simulate with GraphRAG search
      const graphData = await client.search({
        query: keywords.join(' '),
        limit: options.graphDepth || 20,
        filters: { type: 'entity' }
      });

      return graphData;
    } catch (error) {
      logger.error('Failed to query knowledge graph', { error });
      return { entities: [], relationships: [] };
    }
  }

  /**
   * Rank results by relevance to query
   */
  private rankByRelevance(items: any[], query: string): any[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/);

    return items
      .map(item => {
        const content = (item.content || '').toLowerCase();
        let score = 0;

        // Check for exact query match
        if (content.includes(queryLower)) score += 10;

        // Check for individual word matches
        queryWords.forEach(word => {
          if (content.includes(word)) score += 1;
        });

        // Boost recent items (if timestamp exists)
        if (item.metadata?.timestamp) {
          const age = Date.now() - new Date(item.metadata.timestamp).getTime();
          const dayAge = age / (1000 * 60 * 60 * 24);
          score += Math.max(0, 5 - dayAge); // Boost items from last 5 days
        }

        // Boost by importance if available
        if (item.metadata?.importance) {
          score += item.metadata.importance * 5;
        }

        return { ...item, relevanceScore: score };
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Summarize documents for context
   */
  private summarizeDocuments(documents: any[]): any[] {
    return documents.map(doc => ({
      ...doc,
      summary: doc.content.length > 500
        ? doc.content.substring(0, 500) + '...'
        : doc.content
    }));
  }

  /**
   * Filter memories by relevance threshold
   */
  private filterMemories(memories: any[], minRelevance?: number): any[] {
    const threshold = minRelevance || 0.3;
    return memories.filter(mem =>
      !mem.score || mem.score >= threshold
    );
  }

  /**
   * Extract entities from graph data
   */
  private extractEntities(graphData: any): string[] {
    const entities = new Set<string>();

    if (Array.isArray(graphData)) {
      graphData.forEach(item => {
        if (item.entity) entities.add(item.entity);
        if (item.entities) {
          item.entities.forEach((e: string) => entities.add(e));
        }
      });
    } else if (graphData?.entities) {
      graphData.entities.forEach((e: any) => {
        entities.add(typeof e === 'string' ? e : e.name || e.id);
      });
    }

    return Array.from(entities);
  }

  /**
   * Extract relationships from graph data
   */
  private extractRelationships(graphData: any): any[] {
    const relationships: any[] = [];

    if (Array.isArray(graphData)) {
      graphData.forEach(item => {
        if (item.relationships) {
          relationships.push(...item.relationships);
        }
      });
    } else if (graphData?.relationships) {
      relationships.push(...graphData.relationships);
    }

    return relationships;
  }

  /**
   * Extract facts from all context sources
   */
  private extractFacts(items: any[]): string[] {
    const facts = new Set<string>();

    items.forEach(item => {
      if (item.facts) {
        item.facts.forEach((f: string) => facts.add(f));
      }
      if (item.metadata?.facts) {
        item.metadata.facts.forEach((f: string) => facts.add(f));
      }
    });

    return Array.from(facts);
  }

  /**
   * Generate context summary
   */
  private async generateContextSummary(data: any): Promise<string> {
    const { episodes, documents, memories, entities, facts } = data;

    // Create structured summary
    const parts: string[] = [];

    if (episodes.length > 0) {
      parts.push(`Found ${episodes.length} relevant conversation episodes`);
    }

    if (documents.length > 0) {
      parts.push(`${documents.length} knowledge documents`);
    }

    if (memories.length > 0) {
      parts.push(`${memories.length} related memories`);
    }

    if (entities.length > 0) {
      const topEntities = entities.slice(0, 5).join(', ');
      parts.push(`Key entities: ${topEntities}`);
    }

    if (facts.length > 0) {
      parts.push(`${facts.length} relevant facts identified`);
    }

    return parts.join('. ') + '.';
  }

  /**
   * Analyze temporal patterns in episodes
   */
  private analyzeTemporalContext(episodes: any[]): any {
    if (episodes.length < 2) return null;

    const timestamps = episodes
      .filter(ep => ep.metadata?.timestamp)
      .map(ep => new Date(ep.metadata.timestamp).getTime())
      .sort((a, b) => a - b);

    if (timestamps.length < 2) return null;

    const timeRange = {
      start: new Date(timestamps[0]),
      end: new Date(timestamps[timestamps.length - 1])
    };

    // Calculate frequency (episodes per hour)
    const duration = timestamps[timestamps.length - 1] - timestamps[0];
    const hours = duration / (1000 * 60 * 60);
    const frequency = hours > 0 ? episodes.length / hours : episodes.length;

    // Determine pattern
    let pattern = 'sparse';
    if (frequency > 10) pattern = 'intensive';
    else if (frequency > 5) pattern = 'active';
    else if (frequency > 1) pattern = 'moderate';

    return { pattern, timeRange, frequency };
  }

  /**
   * Generate recommendations based on context
   */
  private async generateRecommendations(data: any): Promise<string[]> {
    const recommendations: string[] = [];
    const { query, episodes, documents, entities, facts } = data;

    // Recommend based on patterns
    if (episodes.length > 10) {
      recommendations.push('Consider summarizing previous conversation for efficiency');
    }

    if (documents.length === 0 && query.length > 20) {
      recommendations.push('No relevant documents found - consider storing more knowledge');
    }

    if (entities.length > 20) {
      recommendations.push('Many entities involved - consider focusing on key relationships');
    }

    if (facts.length > 15) {
      recommendations.push('Multiple facts available - prioritize most relevant ones');
    }

    // Check for contradictions in facts
    const contradictions = this.findContradictions(facts);
    if (contradictions.length > 0) {
      recommendations.push('Potential contradictions found - verify facts');
    }

    return recommendations;
  }

  /**
   * Calculate overall relevance score with ADAPTIVE weighting
   * CRITICAL: Uses LLM to determine optimal weight distribution based on query type
   * NO HARDCODED weights - fully emergent allocation
   */
  private async calculateRelevanceScore(data: any): Promise<number> {
    const { episodes, documents, memories } = data;

    // Use LLM to determine weight distribution
    const weights = await this.determineAdaptiveWeights(data.query, { episodes, documents, memories });

    let score = 0;
    let totalWeight = 0;

    // Episodes contribution (adaptive weight)
    if (episodes.length > 0) {
      const avgEpisodeScore = episodes.reduce((sum: number, ep: any) =>
        sum + (ep.relevanceScore || 0), 0) / episodes.length;
      score += avgEpisodeScore * weights.episodes;
      totalWeight += weights.episodes;
    }

    // Documents contribution (adaptive weight)
    if (documents.length > 0) {
      const avgDocScore = documents.reduce((sum: number, doc: any) =>
        sum + (doc.relevanceScore || 0.5), 0) / documents.length;
      score += avgDocScore * weights.documents;
      totalWeight += weights.documents;
    }

    // Memories contribution (adaptive weight)
    if (memories.length > 0) {
      const avgMemScore = memories.reduce((sum: number, mem: any) =>
        sum + (mem.score || 0.5), 0) / memories.length;
      score += avgMemScore * weights.memories;
      totalWeight += weights.memories;
    }

    // Normalize if not all components present
    return totalWeight > 0 ? score / totalWeight : 0;
  }

  /**
   * ZERO-HARDCODING: LLM-powered adaptive weight determination
   * Analyzes query to determine optimal allocation across memory sources
   */
  private async determineAdaptiveWeights(
    query: string,
    sources: { episodes: any[]; documents: any[]; memories: any[] }
  ): Promise<{ episodes: number; documents: number; memories: number }> {
    try {
      const prompt = `Analyze this query and determine optimal weight distribution across memory sources.

Query: "${query}"

Available sources:
- Episodes: ${sources.episodes.length} conversation episodes
- Documents: ${sources.documents.length} knowledge documents
- Memories: ${sources.memories.length} factual memories

Respond with JSON only:
{
  "episodes": 0.4,
  "documents": 0.35,
  "memories": 0.25,
  "reasoning": "brief explanation"
}

Weights must sum to 1.0. Consider:
- Conversational queries → higher episode weight
- Factual queries → higher document/memory weight
- Technical queries → higher document weight
- Temporal queries → higher episode weight

JSON:`;

      const response = await this.complete({
        prompt,
        model: 'anthropic/claude-opus-4.6',
        maxTokens: 200,
        temperature: 0.2
      });

      const parsed = JSON.parse(response.content);

      logger.debug('Adaptive weights determined', {
        query: query.substring(0, 50),
        weights: parsed,
        reasoning: parsed.reasoning
      });

      return {
        episodes: parsed.episodes || 0.33,
        documents: parsed.documents || 0.33,
        memories: parsed.memories || 0.34
      };
    } catch (error) {
      logger.warn('Adaptive weight determination failed, using balanced fallback', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Balanced fallback only if LLM fails
      return { episodes: 0.33, documents: 0.33, memories: 0.34 };
    }
  }

  /**
   * Extract keywords from query
   */
  private extractKeywords(query: string): string[] {
    // Remove common words and extract key terms
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'was', 'were']);

    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 5); // Limit to 5 keywords
  }

  /**
   * Find potential contradictions in facts
   */
  private findContradictions(facts: string[]): string[] {
    const contradictions: string[] = [];

    // Simple contradiction detection - in production use more sophisticated NLP
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        if (this.areContradictory(facts[i], facts[j])) {
          contradictions.push(`"${facts[i]}" contradicts "${facts[j]}"`);
        }
      }
    }

    return contradictions;
  }

  /**
   * Check if two facts are contradictory (simplified)
   */
  private areContradictory(fact1: string, fact2: string): boolean {
    // Very simple check - in production use proper NLP
    const negations = ['not', 'no', 'never', 'none', "don't", "doesn't", "didn't"];

    // Check if facts discuss same subject but with negation
    const words1 = fact1.toLowerCase().split(/\s+/);
    const words2 = fact2.toLowerCase().split(/\s+/);

    const hasNegation1 = words1.some(w => negations.includes(w));
    const hasNegation2 = words2.some(w => negations.includes(w));

    // If one has negation and other doesn't, and they share significant words
    if (hasNegation1 !== hasNegation2) {
      const commonWords = words1.filter(w => words2.includes(w) && w.length > 3);
      return commonWords.length > 2;
    }

    return false;
  }

  /**
   * Get minimal context (fallback for errors)
   */
  private getMinimalContext(query: string): EnrichedContext {
    return {
      query,
      episodes: [],
      documents: [],
      memories: [],
      entities: [],
      relationships: [],
      facts: [],
      summary: 'Context retrieval failed - operating without historical context',
      relevanceScore: 0,
      recommendations: ['Context unavailable - results may be less accurate']
    };
  }

  /**
   * Generate cache key for context
   */
  private getCacheKey(query: string, options: ContextOptions): string {
    return `${query}_${JSON.stringify(options)}`.substring(0, 100);
  }

  /**
   * Clear context cache
   */
  clearCache(): void {
    this.contextCache.clear();
    logger.info('Context cache cleared');
  }
}

export const contextService = ContextService.getInstance();