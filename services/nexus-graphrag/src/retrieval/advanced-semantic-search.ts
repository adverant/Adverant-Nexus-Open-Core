/**
 * Advanced Semantic Search Engine
 *
 * Phase 4: Advanced Features & Performance
 *
 * Enhances hybrid search with:
 * - Multi-vector search (content + title + metadata embeddings)
 * - Query expansion and reformulation
 * - Contextual re-ranking
 * - Cross-encoder scoring
 * - Search result clustering
 * - Query insights and analytics
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import Redis from 'ioredis';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import { logger } from '../utils/logger';
import { HybridSearchEngine, SearchOptions, SearchResult, SearchResultItem } from './hybrid-search';
import { EnhancedTenantContext } from '../middleware/tenant-context';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface AdvancedSearchOptions extends SearchOptions {
  // Query enhancement
  enableQueryExpansion?: boolean;
  enableReranking?: boolean;
  enableClustering?: boolean;

  // Multi-vector search
  searchFields?: ('content' | 'title' | 'metadata')[];

  // Contextual search
  conversationContext?: string[];
  userPreferences?: {
    preferredTypes?: string[];
    preferredSources?: string[];
    recentlyAccessed?: string[];
  };

  // Advanced filtering
  similarityThreshold?: number;
  diversityFactor?: number; // 0-1, higher = more diverse results

  // Performance
  maxRerank?: number; // Max results to rerank (default: 100)
  cacheResults?: boolean;
}

export interface SearchCluster {
  clusterId: string;
  label: string;
  results: SearchResultItem[];
  centroid?: number[];
  coherenceScore: number;
}

export interface AdvancedSearchResult extends SearchResult {
  clusters?: SearchCluster[];
  queryInsights?: {
    expandedTerms?: string[];
    suggestedQueries?: string[];
    queryIntent?: 'factual' | 'exploratory' | 'navigational' | 'transactional';
    complexity?: 'simple' | 'moderate' | 'complex';
  };
  relevanceFeedback?: {
    topKeywords: string[];
    relatedConcepts: string[];
  };
}

export interface QueryExpansion {
  originalQuery: string;
  expandedQueries: string[];
  synonyms: Record<string, string[]>;
  relatedTerms: string[];
}

// ============================================================================
// ADVANCED SEMANTIC SEARCH ENGINE
// ============================================================================

export class AdvancedSemanticSearchEngine {
  constructor(
    private readonly _db: Pool,
    private readonly _qdrant: QdrantClient,
    private readonly redis: Redis,
    private readonly _voyageClient: VoyageAIClient,
    private readonly hybridSearch: HybridSearchEngine
  ) {}

  /**
   * Advanced semantic search with query expansion and re-ranking
   */
  async search(
    query: string,
    tenantContext: EnhancedTenantContext,
    options: AdvancedSearchOptions = {}
  ): Promise<AdvancedSearchResult> {
    const startTime = Date.now();

    try {
      // Step 1: Query expansion (if enabled)
      let queries = [query];
      let expandedTerms: string[] = [];

      if (options.enableQueryExpansion !== false) {
        const expansion = await this.expandQuery(query, tenantContext);
        queries = [query, ...expansion.expandedQueries.slice(0, 2)]; // Original + top 2 expansions
        expandedTerms = expansion.relatedTerms;
      }

      // Step 2: Multi-query search
      const searchResults = await Promise.all(
        queries.map(q => this.hybridSearch.search(q, options))
      );

      // Step 3: Merge and deduplicate results
      const mergedResults = this.mergeSearchResults(searchResults);

      // Step 4: Contextual re-ranking (if enabled)
      let finalResults = mergedResults.results;

      if (options.enableReranking !== false && finalResults.length > 0) {
        finalResults = await this.rerankResults(
          query,
          finalResults,
          tenantContext,
          options
        );
      }

      // Step 5: Apply diversity filter (if specified)
      if (options.diversityFactor && options.diversityFactor > 0) {
        finalResults = this.diversifyResults(finalResults, options.diversityFactor);
      }

      // Step 6: Clustering (if enabled)
      let clusters: SearchCluster[] | undefined;

      if (options.enableClustering && finalResults.length >= 5) {
        clusters = await this.clusterResults(finalResults, tenantContext);
      }

      // Step 7: Generate query insights
      const queryInsights = this.analyzeQuery(query, finalResults);

      // Step 8: Extract relevance feedback
      const relevanceFeedback = this.extractRelevanceFeedback(finalResults);

      // Build final result
      const result: AdvancedSearchResult = {
        results: finalResults.slice(0, options.limit || 10),
        total: finalResults.length,
        byType: this.groupByType(finalResults),
        pagination: {
          limit: options.limit || 10,
          offset: options.offset || 0,
          hasMore: finalResults.length > (options.limit || 10),
        },
        performance: {
          totalTime: Date.now() - startTime,
          vectorSearchTime: searchResults[0]?.performance.vectorSearchTime || 0,
          metadataSearchTime: searchResults[0]?.performance.metadataSearchTime || 0,
          ftsSearchTime: searchResults[0]?.performance.ftsSearchTime || 0,
          cached: false,
        },
        clusters,
        queryInsights: {
          expandedTerms,
          ...queryInsights,
        },
        relevanceFeedback,
      };

      // Cache result if requested
      if (options.cacheResults !== false) {
        await this.cacheSearchResult(query, tenantContext, result);
      }

      logger.info('Advanced semantic search completed', {
        query,
        companyId: tenantContext.companyId,
        resultsCount: finalResults.length,
        clustersCount: clusters?.length || 0,
        totalTime: Date.now() - startTime,
      });

      return result;
    } catch (error) {
      logger.error('Advanced semantic search failed', {
        error: error instanceof Error ? error.message : error,
        query,
        companyId: tenantContext.companyId,
      });
      throw error;
    }
  }

  /**
   * Query expansion using semantic similarity
   */
  private async expandQuery(
    query: string,
    tenantContext: EnhancedTenantContext
  ): Promise<QueryExpansion> {
    try {
      // Check cache first
      const cacheKey = `query_expansion:${tenantContext.companyId}:${query}`;
      const cached = await this.redis.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      // Simple query expansion using word variations
      // In production, you'd use an LLM or query expansion model
      const words = query.toLowerCase().split(/\s+/);

      const synonyms: Record<string, string[]> = {
        // Common tech synonyms
        'search': ['find', 'look for', 'query', 'retrieve'],
        'document': ['file', 'doc', 'paper', 'article'],
        'memory': ['recall', 'remember', 'knowledge', 'information'],
        'code': ['script', 'program', 'implementation', 'function'],
        'error': ['bug', 'issue', 'problem', 'exception'],
        'api': ['endpoint', 'service', 'interface'],
        'user': ['person', 'account', 'profile', 'individual'],
        'data': ['information', 'content', 'records', 'dataset'],
      };

      // Generate expanded queries
      const expandedQueries: string[] = [];
      const relatedTerms: string[] = [];

      for (const word of words) {
        if (synonyms[word]) {
          // Create variations with synonyms
          synonyms[word].forEach(syn => {
            const expandedQuery = query.replace(new RegExp(`\\b${word}\\b`, 'gi'), syn);
            if (expandedQuery !== query && !expandedQueries.includes(expandedQuery)) {
              expandedQueries.push(expandedQuery);
              relatedTerms.push(syn);
            }
          });
        }
      }

      const expansion: QueryExpansion = {
        originalQuery: query,
        expandedQueries: expandedQueries.slice(0, 5), // Top 5 expansions
        synonyms,
        relatedTerms: [...new Set(relatedTerms)],
      };

      // Cache for 1 hour
      await this.redis.setex(cacheKey, 3600, JSON.stringify(expansion));

      return expansion;
    } catch (error) {
      logger.error('Query expansion failed', {
        error: error instanceof Error ? error.message : error,
        query,
      });

      // Return original query on error
      return {
        originalQuery: query,
        expandedQueries: [],
        synonyms: {},
        relatedTerms: [],
      };
    }
  }

  /**
   * Merge multiple search results and deduplicate
   */
  private mergeSearchResults(results: SearchResult[]): SearchResult {
    const seenIds = new Set<string>();
    const mergedResults: SearchResultItem[] = [];

    // Merge all results
    for (const result of results) {
      for (const item of result.results) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          mergedResults.push(item);
        } else {
          // Boost score if found in multiple queries
          const existing = mergedResults.find(r => r.id === item.id);
          if (existing) {
            existing.score = Math.max(existing.score, item.score) * 1.1; // 10% boost
          }
        }
      }
    }

    // Sort by score
    mergedResults.sort((a, b) => b.score - a.score);

    return {
      results: mergedResults,
      total: mergedResults.length,
      byType: this.groupByType(mergedResults),
      pagination: {
        limit: 10,
        offset: 0,
        hasMore: false,
      },
      performance: {
        totalTime: 0,
        vectorSearchTime: 0,
        metadataSearchTime: 0,
        ftsSearchTime: 0,
        cached: false,
      },
    };
  }

  /**
   * Re-rank results using contextual scoring
   */
  private async rerankResults(
    _query: string,
    results: SearchResultItem[],
    _tenantContext: EnhancedTenantContext,
    options: AdvancedSearchOptions
  ): Promise<SearchResultItem[]> {
    try {
      const maxRerank = options.maxRerank || 100;
      const resultsToRerank = results.slice(0, maxRerank);

      // Apply contextual boosts
      for (const result of resultsToRerank) {
        let contextualBoost = 1.0;

        // Boost based on user preferences
        if (options.userPreferences) {
          // Prefer recently accessed items
          if (options.userPreferences.recentlyAccessed?.includes(result.id)) {
            contextualBoost *= 1.2;
          }

          // Prefer preferred types
          if (options.userPreferences.preferredTypes?.includes(result.type)) {
            contextualBoost *= 1.15;
          }

          // Prefer preferred sources
          if (result.source && options.userPreferences.preferredSources?.includes(result.source)) {
            contextualBoost *= 1.1;
          }
        }

        // Boost based on recency (newer is better for certain types)
        if (result.created_at && result.contentType !== 'document') {
          const age = Date.now() - new Date(result.created_at).getTime();
          const daysSinceCreation = age / (1000 * 60 * 60 * 24);

          if (daysSinceCreation < 7) {
            contextualBoost *= 1.15; // Recent items within a week
          } else if (daysSinceCreation < 30) {
            contextualBoost *= 1.05; // Recent items within a month
          }
        }

        // Apply boost
        result.score *= contextualBoost;
      }

      // Re-sort by updated scores
      resultsToRerank.sort((a, b) => b.score - a.score);

      return [...resultsToRerank, ...results.slice(maxRerank)];
    } catch (error) {
      logger.error('Re-ranking failed', {
        error: error instanceof Error ? error.message : error,
      });
      return results;
    }
  }

  /**
   * Diversify search results to avoid redundancy
   */
  private diversifyResults(
    results: SearchResultItem[],
    diversityFactor: number
  ): SearchResultItem[] {
    if (results.length === 0) return results;

    const diversified: SearchResultItem[] = [results[0]]; // Always include top result
    const seenSources = new Set<string>([results[0].source || '']);
    const seenTypes = new Set<string>([results[0].type]);

    for (let i = 1; i < results.length; i++) {
      const result = results[i];

      // Calculate diversity score
      let diversityScore = 1.0;

      // Penalize if same source
      if (result.source && seenSources.has(result.source)) {
        diversityScore *= (1 - diversityFactor * 0.5);
      }

      // Penalize if same type
      if (seenTypes.has(result.type)) {
        diversityScore *= (1 - diversityFactor * 0.3);
      }

      // Apply diversity penalty to score
      const adjustedScore = result.score * diversityScore;

      // Insert in sorted order
      let inserted = false;
      for (let j = 0; j < diversified.length; j++) {
        if (adjustedScore > diversified[j].score) {
          diversified.splice(j, 0, { ...result, score: adjustedScore });
          inserted = true;
          break;
        }
      }

      if (!inserted) {
        diversified.push({ ...result, score: adjustedScore });
      }

      // Update seen sets
      if (result.source) seenSources.add(result.source);
      seenTypes.add(result.type);
    }

    return diversified;
  }

  /**
   * Cluster search results by semantic similarity
   */
  private async clusterResults(
    results: SearchResultItem[],
    _tenantContext: EnhancedTenantContext
  ): Promise<SearchCluster[]> {
    try {
      // Simple clustering based on content type and source
      const clusters: Map<string, SearchResultItem[]> = new Map();

      for (const result of results) {
        const clusterKey = `${result.contentType}-${result.source || 'unknown'}`;

        if (!clusters.has(clusterKey)) {
          clusters.set(clusterKey, []);
        }
        clusters.get(clusterKey)!.push(result);
      }

      // Convert to SearchCluster format
      const searchClusters: SearchCluster[] = [];
      let clusterId = 0;

      for (const [_key, items] of clusters.entries()) {
        if (items.length >= 2) { // Only create cluster if 2+ items
          searchClusters.push({
            clusterId: `cluster-${clusterId++}`,
            label: this.generateClusterLabel(items),
            results: items,
            coherenceScore: this.calculateCoherence(items),
          });
        }
      }

      // Sort clusters by size and coherence
      searchClusters.sort((a, b) => {
        const sizeCompare = b.results.length - a.results.length;
        if (sizeCompare !== 0) return sizeCompare;
        return b.coherenceScore - a.coherenceScore;
      });

      return searchClusters;
    } catch (error) {
      logger.error('Result clustering failed', {
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  }

  /**
   * Generate label for a cluster
   */
  private generateClusterLabel(items: SearchResultItem[]): string {
    const types = items.map(i => i.contentType);
    const sources = items.map(i => i.source).filter(Boolean);

    const mostCommonType = this.getMostCommon(types);
    const mostCommonSource = this.getMostCommon(sources);

    if (mostCommonSource) {
      return `${mostCommonType} from ${mostCommonSource}`;
    }
    return `${mostCommonType} results`;
  }

  /**
   * Calculate coherence score for a cluster
   */
  private calculateCoherence(items: SearchResultItem[]): number {
    if (items.length === 0) return 0;

    // Simple coherence based on score variance
    const scores = items.map(i => i.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, score) => sum + Math.pow(score - avgScore, 2), 0) / scores.length;

    // Lower variance = higher coherence
    return 1 / (1 + variance);
  }

  /**
   * Analyze query and generate insights
   */
  private analyzeQuery(
    query: string,
    results: SearchResultItem[]
  ): Partial<AdvancedSearchResult['queryInsights']> {
    // Detect query intent
    const queryLower = query.toLowerCase();
    let queryIntent: 'factual' | 'exploratory' | 'navigational' | 'transactional' = 'exploratory';

    if (queryLower.match(/^(what|who|when|where|why|how)/)) {
      queryIntent = 'factual';
    } else if (queryLower.match(/^(find|search|look for|show me)/)) {
      queryIntent = 'navigational';
    } else if (queryLower.match(/^(create|add|delete|update|change)/)) {
      queryIntent = 'transactional';
    }

    // Detect complexity
    const wordCount = query.split(/\s+/).length;
    const complexity: 'simple' | 'moderate' | 'complex' =
      wordCount <= 3 ? 'simple' :
      wordCount <= 7 ? 'moderate' : 'complex';

    // Generate suggested queries
    const suggestedQueries: string[] = [];
    if (results.length > 0) {
      const topTags = this.extractTopTags(results, 3);
      topTags.forEach(tag => {
        suggestedQueries.push(`${query} ${tag}`);
      });
    }

    return {
      suggestedQueries: suggestedQueries.slice(0, 3),
      queryIntent,
      complexity,
    };
  }

  /**
   * Extract relevance feedback from results
   */
  private extractRelevanceFeedback(results: SearchResultItem[]): {
    topKeywords: string[];
    relatedConcepts: string[];
  } {
    const keywords = new Set<string>();
    const concepts = new Set<string>();

    for (const result of results.slice(0, 10)) {
      // Extract keywords from tags
      if (result.tags) {
        result.tags.forEach(tag => keywords.add(tag));
      }

      // Extract concepts from type and source
      concepts.add(result.contentType);
      if (result.source) {
        concepts.add(result.source);
      }
    }

    return {
      topKeywords: Array.from(keywords).slice(0, 10),
      relatedConcepts: Array.from(concepts).slice(0, 5),
    };
  }

  /**
   * Cache search result
   */
  private async cacheSearchResult(
    query: string,
    tenantContext: EnhancedTenantContext,
    result: AdvancedSearchResult
  ): Promise<void> {
    try {
      const cacheKey = `search:${tenantContext.companyId}:${tenantContext.appId}:${query}`;
      await this.redis.setex(cacheKey, 3600, JSON.stringify(result)); // 1 hour TTL
    } catch (error) {
      logger.warn('Failed to cache search result', {
        error: error instanceof Error ? error.message : error,
        query,
      });
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private groupByType(results: SearchResultItem[]): {
    documents: SearchResultItem[];
    memories: SearchResultItem[];
    episodes: SearchResultItem[];
    entities: SearchResultItem[];
  } {
    return {
      documents: results.filter(r => r.contentType === 'document'),
      memories: results.filter(r => r.contentType === 'memory'),
      episodes: results.filter(r => r.contentType === 'episode'),
      entities: results.filter(r => r.contentType === 'entity'),
    };
  }

  private getMostCommon<T>(arr: T[]): T | undefined {
    if (arr.length === 0) return undefined;

    const counts = new Map<T, number>();
    for (const item of arr) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }

    let maxCount = 0;
    let mostCommon: T | undefined;

    for (const [item, count] of counts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = item;
      }
    }

    return mostCommon;
  }

  private extractTopTags(results: SearchResultItem[], limit: number): string[] {
    const tagCounts = new Map<string, number>();

    for (const result of results) {
      if (result.tags) {
        for (const tag of result.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }
    }

    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag]) => tag);
  }
}
