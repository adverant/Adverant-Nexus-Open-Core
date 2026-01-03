/**
 * Context Injector - Phase 3 Implementation
 *
 * Provides intelligent context injection before tool execution with
 * <50ms overhead target, semantic search, and proactive suggestions.
 *
 * @module context-injector
 */

import { GraphRAGClientV2 } from '../clients/graphrag-client-v2.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface InjectionRequest {
  toolName: string;
  toolArgs: any;
  sessionId?: string;
  timeout?: number; // Default: 50ms
}

export interface InjectionResult {
  contextId: string;
  injected: boolean;
  context?: RelevantContext;
  suggestions?: string[];
  latency: number;
  timedOut: boolean;
}

export interface RelevantContext {
  memories: any[];
  documents: any[];
  episodes: any[];
  patterns: any[];
  relevanceScore: number;
}

export interface SuggestionRequest {
  contextId: string;
  timeout?: number;
}

// ============================================================================
// CONTEXT INJECTOR CLASS
// ============================================================================

export class ContextInjector {
  private graphragClient: GraphRAGClientV2;
  private defaultTimeout: number = 50; // 50ms target
  private cache: Map<string, { context: RelevantContext; timestamp: number }>;
  private cacheTTL: number = 300000; // 5 minutes

  constructor(graphragClient: GraphRAGClientV2) {
    this.graphragClient = graphragClient;
    this.cache = new Map();

    // Clean cache periodically
    setInterval(() => this.cleanCache(), 60000); // Every minute

    logger.info('ContextInjector initialized with 50ms timeout target');
  }

  // ============================================================================
  // PHASE 3: CONTEXT INJECTION
  // ============================================================================

  /**
   * Inject context before tool execution
   * Returns contextId immediately for tracking, fetches context async
   */
  async injectContext(request: InjectionRequest): Promise<InjectionResult> {
    const startTime = Date.now();
    const contextId = this.generateContextId(request);
    const timeout = request.timeout || this.defaultTimeout;

    try {
      // Check cache first (ultra-fast path)
      const cached = this.getFromCache(contextId);
      if (cached) {
        const latency = Date.now() - startTime;
        logger.info(`Context injected from cache: ${contextId} (${latency}ms)`);

        return {
          contextId,
          injected: true,
          context: cached,
          latency,
          timedOut: false
        };
      }

      // Build query from tool context
      const query = this.buildContextQuery(request);

      // Fetch context with timeout (async-first design)
      const contextPromise = this.fetchRelevantContext(query, contextId);
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeout)
      );

      const result = await Promise.race([contextPromise, timeoutPromise]);

      const latency = Date.now() - startTime;

      if (result === null) {
        // Timed out - return without context, continue in background
        logger.warn(`Context injection timed out for ${request.toolName} (${latency}ms)`);

        // Continue fetching in background for future use
        contextPromise.then(ctx => {
          if (ctx) this.addToCache(contextId, ctx);
        }).catch(err => logger.error('Background context fetch failed:', err));

        return {
          contextId,
          injected: false,
          latency,
          timedOut: true
        };
      }

      // Success - got context within timeout
      this.addToCache(contextId, result);

      logger.info(`Context injected successfully: ${contextId} (${latency}ms, ${result.memories.length} memories, ${result.documents.length} docs)`);

      return {
        contextId,
        injected: true,
        context: result,
        latency,
        timedOut: false
      };
    } catch (error) {
      logger.error(`Context injection failed for ${request.toolName}:`, error);

      return {
        contextId,
        injected: false,
        latency: Date.now() - startTime,
        timedOut: false
      };
    }
  }

  /**
   * Get proactive suggestions for injected context
   */
  async getSuggestions(request: SuggestionRequest): Promise<string[]> {
    const startTime = Date.now();

    try {
      // Check if context exists in cache
      const cached = Array.from(this.cache.values()).find(
        entry => this.generateContextId({ toolName: '', toolArgs: {} }) === request.contextId
      );

      if (!cached) {
        logger.warn(`No cached context found for ${request.contextId}`);
        return [];
      }

      // Generate suggestions from context
      const suggestions = this.generateSuggestions(cached.context);

      const latency = Date.now() - startTime;
      logger.info(`Generated ${suggestions.length} suggestions (${latency}ms)`);

      return suggestions;
    } catch (error) {
      logger.error('Failed to generate suggestions:', error);
      return [];
    }
  }

  /**
   * Manually clear context cache
   */
  clearCache(): void {
    this.cache.clear();
    logger.info('Context cache cleared');
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Fetch relevant context from GraphRAG
   */
  private async fetchRelevantContext(
    query: string,
    contextId: string
  ): Promise<RelevantContext> {
    try {
      // Use enhanced retrieve for unified context
      const result = await this.graphragClient.enhancedRetrieve(query, {
        maxTokens: 1500,
        includeDocuments: true,
        includeEpisodic: true
      });

      // Extract patterns from memories
      const patterns = result.memories?.filter((m: any) =>
        m.tags?.includes('pattern') || m.tags?.includes('best-practice')
      ) || [];

      return {
        memories: result.memories || [],
        documents: result.documents || [],
        episodes: result.episodes || [],
        patterns,
        relevanceScore: this.calculateRelevanceScore(result)
      };
    } catch (error) {
      logger.error('Failed to fetch relevant context:', error);
      throw error;
    }
  }

  /**
   * Build context query from tool information
   */
  private buildContextQuery(request: InjectionRequest): string {
    const { toolName, toolArgs } = request;

    // Extract meaningful parts from tool arguments
    const argParts: string[] = [];

    // Handle common tool patterns
    if (toolName === 'Edit' && toolArgs.file_path) {
      argParts.push(`editing ${toolArgs.file_path}`);
    } else if (toolName === 'Bash' && toolArgs.command) {
      const cmd = toolArgs.command.split(' ')[0];
      argParts.push(`running ${cmd}`);
    } else if (toolName === 'nexus_validate_code' && toolArgs.language) {
      argParts.push(`${toolArgs.language} validation`);
    } else {
      // Generic: extract string values < 50 chars
      Object.entries(toolArgs).forEach(([key, value]) => {
        if (typeof value === 'string' && value.length < 50 && value.length > 3) {
          argParts.push(value);
        }
      });
    }

    return `${toolName} ${argParts.join(' ')}`.trim();
  }

  /**
   * Generate suggestions from retrieved context
   */
  private generateSuggestions(context: RelevantContext): string[] {
    const suggestions: string[] = [];

    // Suggestions from patterns
    context.patterns.slice(0, 3).forEach(pattern => {
      if (pattern.content) {
        suggestions.push(`Pattern: ${pattern.content.substring(0, 150)}`);
      }
    });

    // Suggestions from recent similar operations
    context.episodes.slice(0, 2).forEach(episode => {
      if (episode.content) {
        suggestions.push(`Similar operation: ${episode.content.substring(0, 150)}`);
      }
    });

    // Suggestions from high-relevance memories
    context.memories
      .filter((m: any) => m.score > 0.7)
      .slice(0, 2)
      .forEach(memory => {
        suggestions.push(`Relevant: ${memory.content.substring(0, 150)}`);
      });

    return suggestions;
  }

  /**
   * Calculate overall relevance score
   */
  private calculateRelevanceScore(result: any): number {
    if (!result) return 0;

    const memoryScore = result.memories?.length > 0
      ? result.memories.reduce((sum: number, m: any) => sum + (m.score || 0), 0) / result.memories.length
      : 0;

    const hasDocuments = result.documents?.length > 0 ? 0.2 : 0;
    const hasEpisodes = result.episodes?.length > 0 ? 0.2 : 0;

    return Math.min(memoryScore + hasDocuments + hasEpisodes, 1.0);
  }

  /**
   * Generate context ID
   */
  private generateContextId(request: InjectionRequest): string {
    const hash = this.simpleHash(`${request.toolName}:${JSON.stringify(request.toolArgs)}`);
    return `ctx_${hash}_${Date.now()}`;
  }

  /**
   * Simple hash function for cache keys
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get context from cache
   */
  private getFromCache(contextId: string): RelevantContext | null {
    const entry = this.cache.get(contextId);
    if (!entry) return null;

    // Check if expired
    if (Date.now() - entry.timestamp > this.cacheTTL) {
      this.cache.delete(contextId);
      return null;
    }

    return entry.context;
  }

  /**
   * Add context to cache
   */
  private addToCache(contextId: string, context: RelevantContext): void {
    this.cache.set(contextId, {
      context,
      timestamp: Date.now()
    });

    // Limit cache size
    if (this.cache.size > 100) {
      const oldestKey = Array.from(this.cache.keys())[0];
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Clean expired cache entries
   */
  private cleanCache(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if (now - entry.timestamp > this.cacheTTL) {
        toDelete.push(key);
      }
    });

    toDelete.forEach(key => this.cache.delete(key));

    if (toDelete.length > 0) {
      logger.info(`Cleaned ${toDelete.length} expired cache entries`);
    }
  }

  /**
   * Get performance stats
   */
  getStats(): {
    cacheSize: number;
    cacheHitRate: number;
  } {
    return {
      cacheSize: this.cache.size,
      cacheHitRate: 0 // TODO: Track hit rate
    };
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new ContextInjector instance
 */
export function createContextInjector(graphragClient: GraphRAGClientV2): ContextInjector {
  return new ContextInjector(graphragClient);
}

// ============================================================================
// PRE-TOOL-USE HOOK HELPER
// ============================================================================

/**
 * Pre-tool-use hook function for Claude Code integration
 */
export async function preToolUseHook(
  injector: ContextInjector,
  toolName: string,
  toolArgs: any,
  sessionId?: string
): Promise<InjectionResult> {
  return injector.injectContext({
    toolName,
    toolArgs,
    sessionId,
    timeout: 50 // 50ms target
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export default ContextInjector;
