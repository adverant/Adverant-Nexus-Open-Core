/**
 * Hybrid Search Engine
 *
 * Combines multiple search strategies for optimal accuracy and performance:
 * 1. Vector Similarity Search (Qdrant) - Semantic matching (60% weight)
 * 2. Metadata Search (PostgreSQL) - Title, source, tags (30% weight)
 * 3. Full-Text Search (PostgreSQL) - Exact/phrase matching (10% weight)
 *
 * Fixes: "manus.ai" search failure by using vector similarity + metadata matching
 * instead of relying solely on PostgreSQL full-text search which breaks on punctuation.
 */

import crypto from 'crypto';
import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import Redis from 'ioredis';
import { VoyageAIClient } from '../clients/voyage-ai-unified-client';
import { logger } from '../utils/logger';
import { toPostgresArray } from '../utils/postgres-helpers';

export interface SearchOptions {
  filters?: {
    type?: 'all' | 'memory' | 'document' | 'episode' | 'entity';
    tags?: string[];
    dateRange?: {
      start: string;
      end: string;
    };
    metadata?: Record<string, any>;
  };
  limit?: number;
  offset?: number;
  includeMetadata?: boolean;
  scoreThreshold?: number;
}

export interface SearchResultItem {
  id: string;
  content: string;
  title?: string;
  source?: string;
  tags?: string[];
  type: string;
  contentType: 'memory' | 'document' | 'episode' | 'entity';
  score: number;
  sources: string[];  // Which search methods found this result
  metadata?: any;
  created_at?: string;
  relevance?: {
    vector: number;
    metadata: number;
    fts: number;
    combined: number;
  };
}

export interface SearchResult {
  results: SearchResultItem[];
  total: number;
  byType: {
    documents: SearchResultItem[];
    memories: SearchResultItem[];
    episodes: SearchResultItem[];
    entities: SearchResultItem[];
  };
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  performance: {
    totalTime: number;
    vectorSearchTime: number;
    metadataSearchTime: number;
    ftsSearchTime: number;
    cached: boolean;
  };
}

interface MultiSearchResults {
  vector: any[];
  metadata: any[];
  fts: any[];
}

/**
 * Query pattern types for dynamic weight adjustment
 */
export type QueryPattern =
  | 'title_search'      // Searching for specific document titles
  | 'code_search'       // Searching for code snippets or functions
  | 'semantic'          // Conceptual/semantic search
  | 'exact_phrase'      // Exact phrase matching
  | 'hybrid';           // Balanced search (default)

export interface SearchWeights {
  vector: number;
  metadata: number;
  fts: number;
}

/**
 * Detect query pattern for dynamic weight optimization
 * @param query - The search query string
 * @returns The detected query pattern and optimized weights
 */
function detectQueryPattern(query: string): { pattern: QueryPattern; weights: SearchWeights } {
  // Query analyzed in lowercase for pattern matching

  // Title search: "document titled X", "file named Y", "document called Z"
  if (/\b(titled|named|called|title|file\s+named)\b/i.test(query)) {
    return {
      pattern: 'title_search',
      weights: { vector: 0.1, metadata: 0.8, fts: 0.1 }
    };
  }

  // Exact phrase search: Query in quotes "exact phrase"
  if (/^"[^"]+"$/.test(query) || /^'[^']+'$/.test(query)) {
    return {
      pattern: 'exact_phrase',
      weights: { vector: 0.2, metadata: 0.3, fts: 0.5 }
    };
  }

  // Code search: Contains code patterns, function/class names
  if (/\b(function|class|method|interface|type|const|let|var|def|async|await|import|export)\b/i.test(query)) {
    return {
      pattern: 'code_search',
      weights: { vector: 0.5, metadata: 0.2, fts: 0.3 }
    };
  }

  // Semantic search: "related to", "similar to", "like", "about", "concept"
  if (/\b(related|similar|like|about|concept|understand|explain|describe)\b/i.test(query)) {
    return {
      pattern: 'semantic',
      weights: { vector: 0.85, metadata: 0.1, fts: 0.05 }
    };
  }

  // Default: Balanced hybrid search
  return {
    pattern: 'hybrid',
    weights: { vector: 0.6, metadata: 0.3, fts: 0.1 }
  };
}

export class HybridSearchEngine {
  private voyageClient: VoyageAIClient;
  private qdrantClient: QdrantClient;
  private postgresPool: Pool;
  private redisCache: Redis;

  constructor(config: {
    voyageClient: VoyageAIClient;
    qdrantClient: QdrantClient;
    postgresPool: Pool;
    redisCache: Redis;
  }) {
    this.voyageClient = config.voyageClient;
    this.qdrantClient = config.qdrantClient;
    this.postgresPool = config.postgresPool;
    this.redisCache = config.redisCache;

    logger.info('Hybrid Search Engine initialized');
  }

  /**
   * Main search method - orchestrates hybrid search across all strategies
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const startTime = Date.now();

    // Validate input
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('Search query must be a non-empty string');
    }

    // Apply defaults
    const searchOptions: Required<SearchOptions> = {
      filters: options.filters || { type: 'all' },
      limit: options.limit || 20,
      offset: options.offset || 0,
      includeMetadata: options.includeMetadata !== false,
      scoreThreshold: options.scoreThreshold || 0.3
    };

    // Check cache first
    const cached = await this.getCachedSearch(query, searchOptions);
    if (cached) {
      logger.info('Search cache hit', { query, latency: Date.now() - startTime });
      return cached;
    }

    logger.info('Executing hybrid search', { query, options: searchOptions });

    try {
      // Generate embedding (can run in parallel with metadata search)
      const embeddingStart = Date.now();
      const [embedding, metadataResults] = await Promise.all([
        this.generateQueryEmbedding(query),
        this.searchMetadata(query, searchOptions)
      ]);
      const metadataSearchTime = Date.now() - embeddingStart;

      // Execute vector and full-text searches in parallel
      const vectorStart = Date.now();
      const [vectorResults, ftsResults] = await Promise.all([
        this.vectorSearch(embedding, searchOptions),
        this.fullTextSearch(query, searchOptions)
      ]);
      const vectorSearchTime = Date.now() - vectorStart;
      const ftsSearchTime = Date.now() - vectorStart; // Approximate (ran in parallel)

      // Detect query pattern for dynamic weight optimization
      const { pattern, weights } = detectQueryPattern(query);

      logger.info('Query pattern detected', {
        query,
        pattern,
        weights,
        message: `Using ${pattern} strategy with weights: vector=${weights.vector}, metadata=${weights.metadata}, fts=${weights.fts}`
      });

      // Merge and rank results with dynamic weights
      const mergedResults = await this.mergeResults(
        {
          vector: vectorResults,
          metadata: metadataResults,
          fts: ftsResults
        },
        searchOptions,
        query,
        weights
      );

      // Apply pagination
      const paginatedResults = mergedResults.slice(
        searchOptions.offset,
        searchOptions.offset + searchOptions.limit
      );

      // Group by content type
      const byType = this.groupByType(paginatedResults);

      const result: SearchResult = {
        results: paginatedResults,
        total: mergedResults.length,
        byType,
        pagination: {
          limit: searchOptions.limit,
          offset: searchOptions.offset,
          hasMore: searchOptions.offset + searchOptions.limit < mergedResults.length
        },
        performance: {
          totalTime: Date.now() - startTime,
          vectorSearchTime,
          metadataSearchTime,
          ftsSearchTime,
          cached: false
        }
      };

      // Cache the result
      await this.cacheSearch(query, searchOptions, result);

      logger.info('Hybrid search completed', {
        query,
        totalResults: result.total,
        documents: result.byType.documents.length,
        memories: result.byType.memories.length,
        episodes: result.byType.episodes.length,
        entities: result.byType.entities.length,
        latency: result.performance.totalTime
      });

      return result;

    } catch (error: any) {
      logger.error('Hybrid search failed', {
        query,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Hybrid search failed: ${error.message}`);
    }
  }

  /**
   * Generate query embedding with caching
   */
  private async generateQueryEmbedding(query: string): Promise<number[]> {
    // Check embedding cache
    const embeddingCacheKey = `embedding:${crypto
      .createHash('md5')
      .update(query)
      .digest('hex')}`;

    const cached = await this.redisCache.get(embeddingCacheKey);
    if (cached) {
      logger.debug('Embedding cache hit', { query });
      return JSON.parse(cached);
    }

    // Generate new embedding
    const result = await this.voyageClient.generateEmbedding(query, {
      inputType: 'query',
      contentType: 'text'
    });

    const embedding = result.embedding;

    // Cache embedding for 1 hour
    await this.redisCache.setex(embeddingCacheKey, 3600, JSON.stringify(embedding));

    return embedding;
  }

  /**
   * Vector similarity search in Qdrant
   */
  private async vectorSearch(
    embedding: number[],
    options: Required<SearchOptions>
  ): Promise<any[]> {
    try {
      const contentTypes = this.getContentTypes(options.filters.type);

      const searchParams: any = {
        vector: embedding,
        limit: 100, // Get more results for merging
        score_threshold: options.scoreThreshold,
        with_payload: true
      };

      // Add content type filter
      if (contentTypes.length > 0 && contentTypes.length < 4) {
        searchParams.filter = {
          should: contentTypes.map(type => ({
            key: 'content_type',
            match: { value: type }
          }))
        };
      }

      const results = await this.qdrantClient.search('unified_content', searchParams);

      logger.debug('Vector search completed', {
        resultsCount: results.length,
        avgScore: results.length > 0
          ? results.reduce((sum, r) => sum + r.score, 0) / results.length
          : 0
      });

      return results;

    } catch (error: any) {
      logger.error('Vector search failed', { error: error.message });
      // Return empty results instead of failing entire search
      return [];
    }
  }

  /**
   * Metadata search (title, source, tags) using PostgreSQL trigram similarity
   */
  private async searchMetadata(
    query: string,
    options: Required<SearchOptions>
  ): Promise<any[]> {
    try {
      const params: any[] = [query];
      let paramIndex = 2;

      let sql = `
        SELECT
          id,
          title,
          source,
          tags,
          type,
          format,
          created_at,
          updated_at,
          metadata,
          GREATEST(
            similarity(COALESCE(title, ''), $1),
            similarity(COALESCE(source, ''), $1),
            similarity(COALESCE(tags::text, ''), $1)
          ) as metadata_score,
          CASE
            WHEN LOWER(title) LIKE LOWER($1) THEN 1.0
            WHEN LOWER(source) LIKE LOWER($1) THEN 0.9
            WHEN LOWER(tags::text) LIKE LOWER($1) THEN 0.8
            ELSE 0.0
          END as exact_match_score
        FROM graphrag.documents
        WHERE (
          title % $1
          OR source % $1
          OR tags::text % $1
          OR LOWER(title) LIKE LOWER('%' || $1 || '%')
          OR LOWER(source) LIKE LOWER('%' || $1 || '%')
        )
      `;

      // Add type filter
      if (options.filters.type && options.filters.type !== 'all') {
        if (options.filters.type === 'document') {
          sql += ` AND type IS NOT NULL`;
        }
      }

      // Add tag filter
      if (options.filters.tags && options.filters.tags.length > 0) {
        sql += ` AND tags && $${paramIndex}`;
        params.push(toPostgresArray(options.filters.tags)); // Convert JS array for PostgreSQL array overlap operator
        paramIndex++;
      }

      // Add date range filter
      if (options.filters.dateRange) {
        if (options.filters.dateRange.start) {
          sql += ` AND created_at >= $${paramIndex}`;
          params.push(options.filters.dateRange.start);
          paramIndex++;
        }
        if (options.filters.dateRange.end) {
          sql += ` AND created_at <= $${paramIndex}`;
          params.push(options.filters.dateRange.end);
          paramIndex++;
        }
      }

      sql += `
        ORDER BY
          exact_match_score DESC,
          metadata_score DESC
        LIMIT 50
      `;

      const result = await this.postgresPool.query(sql, params);

      logger.debug('Metadata search completed', {
        resultsCount: result.rows.length,
        avgScore: result.rows.length > 0
          ? result.rows.reduce((sum, r) => sum + r.metadata_score, 0) / result.rows.length
          : 0
      });

      return result.rows;

    } catch (error: any) {
      logger.error('Metadata search failed', { error: error.message });
      // Return empty results instead of failing entire search
      return [];
    }
  }

  /**
   * Full-text search using PostgreSQL search index
   */
  private async fullTextSearch(
    query: string,
    options: Required<SearchOptions>
  ): Promise<any[]> {
    try {
      let sql = `
        SELECT
          d.*,
          ts_rank(s.search_vector, plainto_tsquery('english', $1)) as fts_rank,
          ts_headline(
            'english',
            LEFT(d.title, 200),
            plainto_tsquery('english', $1),
            'MaxWords=10, MinWords=5'
          ) as headline
        FROM graphrag.documents d
        JOIN graphrag.search_index s ON d.id = s.document_id
        WHERE s.search_vector @@ plainto_tsquery('english', $1)
      `;

      const params: any[] = [query];

      // Add filters if needed
      if (options.filters.type && options.filters.type !== 'all') {
        // FTS only searches documents
      }

      sql += `
        ORDER BY fts_rank DESC
        LIMIT 50
      `;

      const result = await this.postgresPool.query(sql, params);

      logger.debug('Full-text search completed', {
        resultsCount: result.rows.length,
        avgRank: result.rows.length > 0
          ? result.rows.reduce((sum, r) => sum + r.fts_rank, 0) / result.rows.length
          : 0
      });

      return result.rows;

    } catch (error: any) {
      logger.warn('Full-text search failed (non-critical)', { error: error.message });
      // FTS is optional - return empty results
      return [];
    }
  }

  /**
   * Merge results from all search strategies with dynamic weighted scoring
   * @param results - Results from vector, metadata, and FTS searches
   * @param options - Search options
   * @param query - Original search query (for logging)
   * @param weights - Dynamic weights based on query pattern
   */
  private async mergeResults(
    results: MultiSearchResults,
    _options: Required<SearchOptions>,
    query: string,
    weights: SearchWeights
  ): Promise<SearchResultItem[]> {
    const merged = new Map<string, SearchResultItem>();

    // Use dynamic weights based on query pattern
    const VECTOR_WEIGHT = weights.vector;
    const METADATA_WEIGHT = weights.metadata;
    const FTS_WEIGHT = weights.fts;

    // Add vector results
    for (const result of results.vector) {
      const id = result.id as string;
      const payload = result.payload || {};

      merged.set(id, {
        id,
        content: payload.content || '',
        title: payload.title,
        source: payload.source,
        tags: payload.tags || [],
        type: payload.type || 'unknown',
        contentType: payload.content_type || 'document',
        score: result.score * VECTOR_WEIGHT,
        sources: ['vector'],
        metadata: payload.metadata || {},
        created_at: payload.timestamp || payload.created_at,
        relevance: {
          vector: result.score,
          metadata: 0,
          fts: 0,
          combined: result.score * VECTOR_WEIGHT
        }
      });
    }

    // Add metadata results
    for (const result of results.metadata) {
      const existing = merged.get(result.id);
      const metadataScore = Math.max(
        result.metadata_score || 0,
        result.exact_match_score || 0
      );

      if (existing) {
        // Boost existing result
        existing.score += metadataScore * METADATA_WEIGHT;
        existing.sources.push('metadata');
        existing.relevance!.metadata = metadataScore;
        existing.relevance!.combined = existing.score;

        // Update metadata if more complete
        if (result.title && !existing.title) existing.title = result.title;
        if (result.source && !existing.source) existing.source = result.source;
        if (result.tags && result.tags.length > 0) existing.tags = result.tags;
      } else {
        // Add as new result
        merged.set(result.id, {
          id: result.id,
          content: result.title || result.source || '',
          title: result.title,
          source: result.source,
          tags: result.tags || [],
          type: result.type || 'unknown',
          contentType: 'document',
          score: metadataScore * METADATA_WEIGHT,
          sources: ['metadata'],
          metadata: result.metadata || {},
          created_at: result.created_at,
          relevance: {
            vector: 0,
            metadata: metadataScore,
            fts: 0,
            combined: metadataScore * METADATA_WEIGHT
          }
        });
      }
    }

    // Add full-text search results
    for (const result of results.fts) {
      const existing = merged.get(result.id);

      if (existing) {
        // Boost existing result
        existing.score += result.fts_rank * FTS_WEIGHT;
        existing.sources.push('fts');
        existing.relevance!.fts = result.fts_rank;
        existing.relevance!.combined = existing.score;
      } else {
        // Add as new result
        merged.set(result.id, {
          id: result.id,
          content: result.title || '',
          title: result.title,
          source: result.source,
          tags: result.tags || [],
          type: result.type || 'unknown',
          contentType: 'document',
          score: result.fts_rank * FTS_WEIGHT,
          sources: ['fts'],
          metadata: result.metadata || {},
          created_at: result.created_at,
          relevance: {
            vector: 0,
            metadata: 0,
            fts: result.fts_rank,
            combined: result.fts_rank * FTS_WEIGHT
          }
        });
      }
    }

    // Convert to array and sort by combined score
    const sortedResults = Array.from(merged.values())
      .sort((a, b) => b.score - a.score);

    logger.debug('Results merged with dynamic weights', {
      query,
      weights: { vector: VECTOR_WEIGHT, metadata: METADATA_WEIGHT, fts: FTS_WEIGHT },
      vectorOnly: results.vector.length,
      metadataOnly: results.metadata.length,
      ftsOnly: results.fts.length,
      combined: sortedResults.length,
      topScore: sortedResults[0]?.score || 0,
      topScoreBreakdown: sortedResults[0]?.relevance
    });

    return sortedResults;
  }

  /**
   * Group results by content type
   */
  private groupByType(results: SearchResultItem[]): SearchResult['byType'] {
    return {
      documents: results.filter(r => r.contentType === 'document'),
      memories: results.filter(r => r.contentType === 'memory'),
      episodes: results.filter(r => r.contentType === 'episode'),
      entities: results.filter(r => r.contentType === 'entity')
    };
  }

  /**
   * Get content types to search based on filter
   */
  private getContentTypes(type: string | undefined): string[] {
    if (!type || type === 'all') {
      return ['memory', 'document', 'episode', 'entity'];
    }
    return [type];
  }

  /**
   * Get cached search results
   */
  private async getCachedSearch(
    query: string,
    options: Required<SearchOptions>
  ): Promise<SearchResult | null> {
    try {
      const cacheKey = this.generateCacheKey(query, options);
      const cached = await this.redisCache.get(cacheKey);

      if (cached) {
        const result = JSON.parse(cached);
        result.performance.cached = true;
        return result;
      }

      return null;
    } catch (error: any) {
      logger.warn('Cache retrieval failed', { error: error.message });
      return null;
    }
  }

  /**
   * Cache search results
   */
  private async cacheSearch(
    query: string,
    options: Required<SearchOptions>,
    result: SearchResult
  ): Promise<void> {
    try {
      const cacheKey = this.generateCacheKey(query, options);
      // Cache for 5 minutes
      await this.redisCache.setex(cacheKey, 300, JSON.stringify(result));
    } catch (error: any) {
      logger.warn('Cache storage failed (non-critical)', { error: error.message });
    }
  }

  /**
   * Generate cache key for search
   */
  private generateCacheKey(query: string, options: Required<SearchOptions>): string {
    const key = JSON.stringify({ query, options });
    return `search:${crypto.createHash('md5').update(key).digest('hex')}`;
  }
}
