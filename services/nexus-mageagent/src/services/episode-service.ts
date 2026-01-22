/**
 * Episode Service for MageAgent
 * Creates and manages episodic memories from agent interactions
 * Part of the Cognitive Memory Loop architecture
 */

import { v4 as uuidv4 } from 'uuid';
import { graphRAGClient, createGraphRAGClient, TenantContext, GraphRAGClient } from '../clients/graphrag-client';
import { logger } from '../utils/logger';
import {
  validateEpisodeContent,
  validateUserMessage,
  isEpisodeValidationError,
  type EpisodeType,
} from '../validation/episode-validation';

export interface AgentEpisode {
  id: string;
  content: string;
  type: 'agent_response' | 'orchestration' | 'competition' | 'synthesis' | 'user_query' | 'feedback';
  metadata: {
    agentId: string;
    agentName: string;
    model: string;
    taskId: string;
    taskType?: string;
    sessionId: string;
    timestamp: Date;
    importance: number;
    tokens?: number;
    latency?: number;
    temperature?: number;
    parentEpisodeId?: string;
    threadId?: string;
    entities?: string[];
    facts?: string[];
    sentiment?: number;
    confidence?: number;
  };
  relationships?: {
    references?: string[];
    contradicts?: string[];
    supports?: string[];
    extends?: string[];
  };
}

export interface EpisodeContext {
  episodes: AgentEpisode[];
  entities: Set<string>;
  facts: string[];
  summary?: string;
  temporalPattern?: string;
}

export class EpisodeService {
  private static instance: EpisodeService;
  private episodeCache: Map<string, AgentEpisode> = new Map();
  private threadCache: Map<string, string[]> = new Map();

  private constructor() {}

  /**
   * PHASE 35: Get appropriate GraphRAG client for tenant context
   * Uses factory function when tenantContext is provided, singleton otherwise
   */
  private getClient(tenantContext?: TenantContext): GraphRAGClient {
    if (tenantContext) {
      return createGraphRAGClient(tenantContext);
    }
    return graphRAGClient;
  }

  public static getInstance(): EpisodeService {
    if (!EpisodeService.instance) {
      EpisodeService.instance = new EpisodeService();
    }
    return EpisodeService.instance;
  }

  /**
   * Create an episode from an agent response
   * PHASE 35: Added tenantContext parameter for multi-tenant isolation
   */
  async createFromAgentResponse(
    agent: any,
    response: any,
    task: any,
    sessionId: string,
    tenantContext?: TenantContext
  ): Promise<AgentEpisode> {
    try {
      // Calculate importance based on various factors
      const importance = this.calculateImportance(response, task);

      // Extract content with type safety
      const textContent = this.extractTextContent(response);

      // Extract entities and facts with validated text
      const entities = await this.extractEntities(textContent);
      const facts = await this.extractFacts(textContent);

      const episode: AgentEpisode = {
        id: uuidv4(),
        content: textContent,
        type: 'agent_response',
        metadata: {
          agentId: agent.id || agent.agentId,
          agentName: agent.name,
          model: agent.model,
          taskId: task.id || task.taskId,
          taskType: task.type,
          sessionId,
          timestamp: new Date(),
          importance,
          tokens: response.usage?.totalTokens || response.tokens,
          latency: response.latency,
          temperature: agent.temperature,
          parentEpisodeId: task.parentEpisodeId,
          threadId: task.threadId || sessionId,
          entities,
          facts,
          sentiment: await this.analyzeSentiment(textContent),
          confidence: response.confidence || 0.8
        }
      };

      // Store in GraphRAG (PHASE 35: pass tenantContext)
      const storedEpisode = await this.storeEpisode(episode, tenantContext);

      // Update thread
      if (episode.metadata.threadId) {
        await this.updateThread(episode.metadata.threadId, storedEpisode.id);
      }

      // Cache for quick access
      this.episodeCache.set(storedEpisode.id, storedEpisode);

      logger.info('Episode created from agent response', {
        episodeId: storedEpisode.id,
        agentId: agent.id,
        taskId: task.id
      });

      return storedEpisode;
    } catch (error) {
      logger.error('Failed to create episode from agent response', { error });
      throw error;
    }
  }

  /**
   * Create an episode from user input
   *
   * PUBLIC API: This is the entry point for user messages
   * Validates input BEFORE creating episode object
   * PHASE 35: Added tenantContext parameter for multi-tenant isolation
   */
  async createFromUserInput(
    content: string,
    sessionId: string,
    metadata?: any,
    tenantContext?: TenantContext
  ): Promise<AgentEpisode> {
    try {
      // ✨ EARLY VALIDATION: Fail fast before creating episode object
      // This provides better error messages to users
      validateUserMessage(content, sessionId);

      const episode: AgentEpisode = {
        id: uuidv4(),
        content,
        type: 'user_query',
        metadata: {
          agentId: 'user',
          agentName: 'User',
          model: 'human',
          taskId: uuidv4(),
          sessionId,
          timestamp: new Date(),
          importance: 0.8, // User queries are important by default
          threadId: metadata?.threadId || sessionId,
          entities: await this.extractEntities(content),
          facts: await this.extractFacts(content),
          ...metadata
        }
      };

      // PHASE 35: Pass tenantContext to storeEpisode
      const storedEpisode = await this.storeEpisode(episode, tenantContext);
      this.episodeCache.set(storedEpisode.id, storedEpisode);

      return storedEpisode;
    } catch (error) {
      // Log validation failures with user-friendly messages
      if (isEpisodeValidationError(error)) {
        logger.warn('User input validation failed', {
          error: error.message,
          code: error.code,
          sessionId,
          contentLength: content?.length || 0,
        });
        throw error; // Propagate with original error details
      }

      // Log unexpected errors
      logger.error('Failed to create episode from user input', {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
      throw error;
    }
  }

  /**
   * Store episode in GraphRAG
   *
   * VALIDATION LAYER 2: Service-level validation
   * Validates business rules BEFORE calling GraphRAG API
   * PHASE 35: Added tenantContext parameter for multi-tenant isolation
   */
  private async storeEpisode(episode: AgentEpisode, tenantContext?: TenantContext): Promise<AgentEpisode> {
    try {
      // ✨ DEFENSE-IN-DEPTH VALIDATION LAYER 2
      // Validate episode content before sending to GraphRAG
      const validationInput = {
        content: episode.content,
        type: episode.type as EpisodeType,
        metadata: episode.metadata,
      };

      // This will throw EpisodeValidationError if validation fails
      validateEpisodeContent(validationInput);

      // PHASE 35: Use tenant-aware client when context is provided
      const client = this.getClient(tenantContext);

      // Validation passed - proceed with storage
      const result = await client.storeEpisode({
        content: episode.content,
        type: episode.type,
        metadata: {
          ...episode.metadata,
          episodeId: episode.id,
          timestamp: episode.metadata.timestamp.toISOString()
        }
      });

      // Try to store as memory for cross-reference (non-critical)
      try {
        await client.storeMemory({
          content: episode.content,
          tags: [
            'episode',
            episode.type,
            `agent:${episode.metadata.agentId}`,
            `session:${episode.metadata.sessionId}`
          ],
          metadata: {
            episodeId: episode.id,
            ...episode.metadata
          }
        });
      } catch (memoryError) {
        // Log but don't fail - episode was already stored successfully
        logger.warn('Failed to cross-reference episode as memory', {
          error: memoryError instanceof Error ? memoryError.message : String(memoryError),
          episodeId: episode.id
        });
      }

      return { ...episode, id: result.episodeId || episode.id };
    } catch (error) {
      // Enhanced error handling with validation-specific messages
      if (isEpisodeValidationError(error)) {
        logger.warn('Episode validation failed', {
          error: error.message,
          code: error.code,
          field: error.field,
          context: error.context,
          episodeId: episode.id,
        });
        // Re-throw with user-friendly message
        throw error;
      }

      logger.error('Failed to store episode in GraphRAG', { error, episodeId: episode.id });

      // Safely serialize error for frontend consumption
      const errorMessage = error instanceof Error
        ? error.message
        : typeof error === 'string'
        ? error
        : JSON.stringify(error, Object.getOwnPropertyNames(error));

      throw new Error(`Failed to store episode: ${errorMessage}`);
    }
  }

  /**
   * Recall relevant episodes for context
   * PHASE 48: Added tenantContext parameter for multi-tenant isolation
   */
  async recallEpisodes(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
      agentId?: string;
      typeFilter?: string[];
      includeDecay?: boolean;
      timeRange?: { start: Date; end: Date };
    } = {},
    tenantContext?: TenantContext
  ): Promise<EpisodeContext> {
    try {
      // Build filter query
      let filterQuery = query;
      if (options.sessionId) {
        filterQuery += ` session:${options.sessionId}`;
      }
      if (options.agentId) {
        filterQuery += ` agent:${options.agentId}`;
      }

      // PHASE 48: Use tenant-aware client when context is provided
      const client = this.getClient(tenantContext);

      // Recall from GraphRAG
      const episodes = await client.recallEpisodes({
        query: filterQuery,
        limit: options.limit || 10,
        include_decay: options.includeDecay !== false,
        type_filter: options.typeFilter
      });

      // Process episodes into context (handle empty or malformed responses)
      const processedEpisodes = Array.isArray(episodes) ? episodes : [];
      const context: EpisodeContext = {
        episodes: processedEpisodes
          .filter(ep => ep && typeof ep === 'object')
          .map((ep: any) => ({
            id: ep.id || ep.episodeId || 'unknown',
            content: ep.content || '',
            type: ep.type || 'unknown',
            metadata: ep.metadata || {}
          })),
        entities: new Set(),
        facts: [],
        summary: undefined
      };

      // Aggregate entities and facts
      for (const episode of context.episodes) {
        if (episode.metadata.entities) {
          episode.metadata.entities.forEach(e => context.entities.add(e));
        }
        if (episode.metadata.facts) {
          context.facts.push(...episode.metadata.facts);
        }
      }

      // Generate summary if episodes found
      if (context.episodes.length > 0) {
        context.summary = await this.generateContextSummary(context.episodes);
        context.temporalPattern = this.identifyTemporalPattern(context.episodes);
      }

      return context;
    } catch (error) {
      logger.error('Failed to recall episodes', { error, query });
      return { episodes: [], entities: new Set(), facts: [] };
    }
  }

  /**
   * Get episode thread (conversation history)
   * PHASE 48: Added tenantContext parameter for multi-tenant isolation
   */
  async getThread(threadId: string, tenantContext?: TenantContext): Promise<AgentEpisode[]> {
    try {
      // Check cache first
      const cachedThread = this.threadCache.get(threadId);
      if (cachedThread) {
        return cachedThread.map(id => this.episodeCache.get(id)).filter(Boolean) as AgentEpisode[];
      }

      // PHASE 48: Use tenant-aware client when context is provided
      const client = this.getClient(tenantContext);

      // Recall from GraphRAG
      const episodes = await client.recallEpisodes({
        query: `thread:${threadId}`,
        limit: 100,
        include_decay: false
      });

      // Sort by timestamp
      const sortedEpisodes = episodes
        .map((ep: any) => ({
          id: ep.id,
          content: ep.content,
          type: ep.type,
          metadata: ep.metadata
        }))
        .sort((a: AgentEpisode, b: AgentEpisode) =>
          new Date(a.metadata.timestamp).getTime() - new Date(b.metadata.timestamp).getTime()
        );

      // Cache thread
      this.threadCache.set(threadId, sortedEpisodes.map((ep: any) => ep.id));
      sortedEpisodes.forEach((ep: any) => this.episodeCache.set(ep.id, ep));

      return sortedEpisodes;
    } catch (error) {
      logger.error('Failed to get thread', { error, threadId });
      return [];
    }
  }

  /**
   * Update thread with new episode
   */
  private async updateThread(threadId: string, episodeId: string): Promise<void> {
    const thread = this.threadCache.get(threadId) || [];
    thread.push(episodeId);
    this.threadCache.set(threadId, thread);
  }

  /**
   * Calculate importance score for an episode
   */
  /**
   * Safely extract text content from response object
   */
  private extractTextContent(response: any): string {
    // Handle various response formats
    if (typeof response === 'string') {
      return response;
    }

    if (response?.text && typeof response.text === 'string') {
      return response.text;
    }

    if (response?.content && typeof response.content === 'string') {
      return response.content;
    }

    if (response?.result && typeof response.result === 'string') {
      return response.result;
    }

    // Fallback to JSON stringification for complex objects
    try {
      return JSON.stringify(response, null, 2);
    } catch (error) {
      logger.error('Failed to stringify response', { error });
      return '[Unable to extract text content]';
    }
  }

  private calculateImportance(response: any, task: any): number {
    let importance = 0.5; // Base importance

    // Increase for longer responses (more content)
    if (response.tokens > 500) importance += 0.1;
    if (response.tokens > 1000) importance += 0.1;

    // Increase for high confidence responses
    if (response.confidence > 0.9) importance += 0.1;

    // Increase for specific task types
    if (task.type === 'synthesis') importance += 0.2;
    if (task.type === 'analysis') importance += 0.15;

    // Increase for responses with many entities/facts
    if (response.entities?.length > 5) importance += 0.1;
    if (response.facts?.length > 3) importance += 0.1;

    // Cap at 1.0
    return Math.min(importance, 1.0);
  }

  /**
   * Extract entities from text (simplified - in production, use NER)
   */
  private async extractEntities(text: string): Promise<string[]> {
    // Defensive type checking
    if (!text || typeof text !== 'string') return [];

    // Simple entity extraction - in production, use proper NER
    const entities: string[] = [];

    try {
      // Extract capitalized words (potential proper nouns)
      const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    entities.push(...properNouns);

    // Extract technical terms (words with specific patterns)
    const technicalTerms = text.match(/\b[A-Za-z]+(?:[A-Z][a-z]+)+\b/g) || [];
    entities.push(...technicalTerms);

      // Deduplicate
      return [...new Set(entities)].slice(0, 20); // Limit to 20 entities
    } catch (error) {
      logger.warn('Failed to extract entities', { error, textLength: text?.length });
      return [];
    }
  }

  /**
   * Extract facts from text (simplified - in production, use fact extraction model)
   */
  private async extractFacts(text: string): Promise<string[]> {
    // Defensive type checking
    if (!text || typeof text !== 'string') return [];

    const facts: string[] = [];

    // Extract sentences that contain "is", "are", "was", "were" (potential facts)
    const sentences = text.split(/[.!?]+/);
    for (const sentence of sentences) {
      if (sentence.match(/\b(is|are|was|were|will|can|has|have)\b/i)) {
        facts.push(sentence.trim());
      }
    }

    return facts.slice(0, 10); // Limit to 10 facts
  }

  /**
   * Analyze sentiment of text (simplified)
   */
  private async analyzeSentiment(text: string): Promise<number> {
    // Defensive type checking
    if (!text || typeof text !== 'string') return 0;

    // Simple sentiment analysis - in production, use proper sentiment model
    const positiveWords = ['good', 'great', 'excellent', 'perfect', 'success', 'happy', 'positive'];
    const negativeWords = ['bad', 'poor', 'fail', 'error', 'wrong', 'negative', 'problem'];

    let score = 0;
    const lowerText = text.toLowerCase();

    for (const word of positiveWords) {
      if (lowerText.includes(word)) score += 0.1;
    }

    for (const word of negativeWords) {
      if (lowerText.includes(word)) score -= 0.1;
    }

    // Normalize to -1 to 1
    return Math.max(-1, Math.min(1, score));
  }

  /**
   * Generate summary of episode context
   */
  private async generateContextSummary(episodes: AgentEpisode[]): Promise<string> {
    if (episodes.length === 0) return '';

    // Simple summary - in production, use LLM for better summarization
    const topics = new Set<string>();
    const agents = new Set<string>();
    let totalTokens = 0;

    for (const episode of episodes) {
      if (episode.metadata.agentName) agents.add(episode.metadata.agentName);
      if (episode.metadata.entities) {
        episode.metadata.entities.forEach(e => topics.add(e));
      }
      totalTokens += episode.metadata.tokens || 0;
    }

    return `Context from ${episodes.length} episodes involving ${agents.size} agents. ` +
           `Topics: ${Array.from(topics).slice(0, 5).join(', ')}. ` +
           `Total tokens: ${totalTokens}`;
  }

  /**
   * Identify temporal patterns in episodes
   */
  private identifyTemporalPattern(episodes: AgentEpisode[]): string {
    if (episodes.length < 2) return 'single_event';

    // Calculate time differences
    const timeDiffs: number[] = [];
    for (let i = 1; i < episodes.length; i++) {
      const diff = new Date(episodes[i].metadata.timestamp).getTime() -
                   new Date(episodes[i-1].metadata.timestamp).getTime();
      timeDiffs.push(diff);
    }

    // Identify pattern
    const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;

    if (avgDiff < 1000) return 'rapid_fire'; // Less than 1 second
    if (avgDiff < 60000) return 'conversation'; // Less than 1 minute
    if (avgDiff < 3600000) return 'session'; // Less than 1 hour
    if (avgDiff < 86400000) return 'daily'; // Less than 1 day

    return 'sparse';
  }

  /**
   * Link episodes with relationships
   */
  async linkEpisodes(
    sourceId: string,
    targetId: string,
    relationship: 'references' | 'contradicts' | 'supports' | 'extends'
  ): Promise<void> {
    try {
      // In production, store this in Neo4j as a relationship
      const source = this.episodeCache.get(sourceId);
      if (source) {
        if (!source.relationships) {
          source.relationships = {};
        }
        if (!source.relationships[relationship]) {
          source.relationships[relationship] = [];
        }
        source.relationships[relationship].push(targetId);
      }

      logger.info('Episodes linked', { sourceId, targetId, relationship });
    } catch (error) {
      logger.error('Failed to link episodes', { error, sourceId, targetId });
    }
  }

  /**
   * Clear cache (for memory management)
   */
  clearCache(): void {
    // Keep only recent episodes (last 100)
    if (this.episodeCache.size > 100) {
      const entries = Array.from(this.episodeCache.entries());
      const toKeep = entries.slice(-100);
      this.episodeCache.clear();
      toKeep.forEach(([key, value]) => this.episodeCache.set(key, value));
    }

    // Clear old threads
    if (this.threadCache.size > 20) {
      const entries = Array.from(this.threadCache.entries());
      const toKeep = entries.slice(-20);
      this.threadCache.clear();
      toKeep.forEach(([key, value]) => this.threadCache.set(key, value));
    }
  }
}

export const episodeService = EpisodeService.getInstance();

// PHASE 35: Re-export TenantContext for callers
export type { TenantContext } from '../clients/graphrag-client';