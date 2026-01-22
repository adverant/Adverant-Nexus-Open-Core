/**
 * Capability Matcher
 *
 * Matches user queries to service capabilities using:
 * 1. Pattern matching (fast, regex-based)
 * 2. Semantic similarity (vector embeddings via Qdrant)
 * 3. Scoring and ranking
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  CapabilityEntity,
  ServiceEntity,
  CapabilityMatch,
  ServiceScore,
  ServiceQueryRequest,
  ServiceQueryResponse,
  DEFAULT_SCORING_WEIGHTS,
  ScoringWeights,
} from './types.js';
import { ServiceCatalogRepository } from './service-catalog-repository.js';
import { PerformanceScorer } from './performance-scorer.js';

/**
 * Capability Matcher Service
 */
export class CapabilityMatcher {
  private repository: ServiceCatalogRepository;
  private qdrant: QdrantClient | null = null;
  private scorer: PerformanceScorer;
  private collectionName = 'service_capabilities';
  private embeddingDimension = 1536; // Voyage AI dimension

  // Cache for pattern matching
  private patternCache: Map<string, RegExp[]> = new Map();

  constructor(
    repository: ServiceCatalogRepository,
    scorer: PerformanceScorer,
    qdrantUrl?: string
  ) {
    this.repository = repository;
    this.scorer = scorer;

    if (qdrantUrl) {
      this.qdrant = new QdrantClient({ url: qdrantUrl });
    }
  }

  /**
   * Match a query to capabilities
   */
  async matchCapabilities(request: ServiceQueryRequest): Promise<ServiceQueryResponse> {
    const { query, limit = 5, excludeServices = [], requiredCapabilities } = request;

    // 1. Try pattern matching first (fast path)
    const patternMatches = await this.matchByPatterns(query, excludeServices);

    // 2. If pattern matches are weak, use semantic search
    let semanticMatches: CapabilityMatch[] = [];
    if (patternMatches.length < limit || patternMatches[0]?.confidence < 0.7) {
      semanticMatches = await this.matchBySemantic(query, limit, excludeServices);
    }

    // 3. Merge and deduplicate results
    const allMatches = this.mergeMatches(patternMatches, semanticMatches);

    // 4. Filter by required capabilities if specified
    let filteredMatches = allMatches;
    if (requiredCapabilities?.length) {
      filteredMatches = allMatches.filter(m =>
        requiredCapabilities.some(rc =>
          m.capabilityName.toLowerCase().includes(rc.toLowerCase())
        )
      );
    }

    // 5. Score and rank
    const scoredMatches = await this.scoreMatches(filteredMatches);
    scoredMatches.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

    // 6. Take top results
    const topMatches = scoredMatches.slice(0, limit);

    return {
      query,
      matchedCapabilities: topMatches,
      recommendedService: topMatches[0]?.serviceName || null,
      alternativeServices: [...new Set(topMatches.slice(1).map(m => m.serviceName))],
      reasoning: this.buildReasoning(query, topMatches),
    };
  }

  /**
   * Match by query patterns (regex-based, fast)
   */
  private async matchByPatterns(
    query: string,
    excludeServices: string[]
  ): Promise<CapabilityMatch[]> {
    const queryLower = query.toLowerCase();
    const matches: CapabilityMatch[] = [];

    // Get all capabilities
    const capabilities = await this.repository.listAllCapabilities();

    for (const capability of capabilities) {
      // Skip excluded services
      const service = await this.repository.getService(capability.parentId);
      if (!service || excludeServices.includes(service.structuredData.name)) {
        continue;
      }

      // Check query patterns
      const patterns = this.getOrBuildPatterns(capability);
      let maxConfidence = 0;

      for (const pattern of patterns) {
        if (pattern.test(queryLower)) {
          maxConfidence = Math.max(maxConfidence, 0.85);
        }
      }

      // Check for exact keyword matches
      const keywords = capability.structuredData.queryPatterns;
      for (const keyword of keywords) {
        if (queryLower.includes(keyword.toLowerCase())) {
          maxConfidence = Math.max(maxConfidence, 0.75);
        }
      }

      // Check for partial keyword matches
      for (const keyword of keywords) {
        const keywordWords = keyword.toLowerCase().split(/\s+/);
        for (const word of keywordWords) {
          if (word.length > 3 && queryLower.includes(word)) {
            maxConfidence = Math.max(maxConfidence, 0.5);
          }
        }
      }

      if (maxConfidence > 0) {
        matches.push({
          serviceId: service.id,
          serviceName: service.structuredData.name,
          capabilityId: capability.id,
          capabilityName: capability.structuredData.name,
          confidence: maxConfidence,
          score: { compositeScore: 0 } as ServiceScore, // Will be calculated later
          endpoint: capability.structuredData.endpoint,
          method: capability.structuredData.method,
          estimatedDuration: capability.structuredData.estimatedDuration,
        });
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Match by semantic similarity (vector search)
   */
  private async matchBySemantic(
    query: string,
    limit: number,
    excludeServices: string[]
  ): Promise<CapabilityMatch[]> {
    if (!this.qdrant) {
      // Fallback to text search if Qdrant not available
      return this.matchByTextSearch(query, limit, excludeServices);
    }

    try {
      // Get query embedding from Voyage AI
      const queryEmbedding = await this.getEmbedding(query);

      // Search Qdrant
      const results = await this.qdrant.search(this.collectionName, {
        vector: queryEmbedding,
        limit: limit * 2, // Get more to filter
        with_payload: true,
      });

      const matches: CapabilityMatch[] = [];

      for (const result of results) {
        const payload = result.payload as Record<string, unknown>;
        const serviceName = payload.serviceName as string;

        // Skip excluded services
        if (excludeServices.includes(serviceName)) {
          continue;
        }

        matches.push({
          serviceId: payload.serviceId as string,
          serviceName,
          capabilityId: payload.capabilityId as string,
          capabilityName: payload.capabilityName as string,
          confidence: result.score,
          score: { compositeScore: 0 } as ServiceScore,
          endpoint: payload.endpoint as string,
          method: payload.method as string,
          estimatedDuration: payload.estimatedDuration as CapabilityMatch['estimatedDuration'],
        });
      }

      return matches;
    } catch (error) {
      console.error('Semantic search failed, falling back to text search:', error);
      return this.matchByTextSearch(query, limit, excludeServices);
    }
  }

  /**
   * Fallback text search using PostgreSQL full-text search
   */
  private async matchByTextSearch(
    query: string,
    limit: number,
    excludeServices: string[]
  ): Promise<CapabilityMatch[]> {
    // Use the repository's pool for text search
    // This is a simplified version - in production, use proper full-text search
    const capabilities = await this.repository.listAllCapabilities();
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    const scoredCapabilities: Array<{ capability: CapabilityEntity; score: number }> = [];

    for (const capability of capabilities) {
      const text = capability.textContent.toLowerCase();
      let score = 0;

      for (const word of queryWords) {
        if (text.includes(word)) {
          score += 1;
        }
      }

      if (score > 0) {
        scoredCapabilities.push({
          capability,
          score: score / queryWords.length,
        });
      }
    }

    scoredCapabilities.sort((a, b) => b.score - a.score);

    const matches: CapabilityMatch[] = [];

    for (const { capability, score } of scoredCapabilities.slice(0, limit * 2)) {
      const service = await this.repository.getService(capability.parentId);
      if (!service || excludeServices.includes(service.structuredData.name)) {
        continue;
      }

      matches.push({
        serviceId: service.id,
        serviceName: service.structuredData.name,
        capabilityId: capability.id,
        capabilityName: capability.structuredData.name,
        confidence: Math.min(score, 0.8), // Cap at 0.8 for text search
        score: { compositeScore: 0 } as ServiceScore,
        endpoint: capability.structuredData.endpoint,
        method: capability.structuredData.method,
        estimatedDuration: capability.structuredData.estimatedDuration,
      });
    }

    return matches;
  }

  /**
   * Get embedding for a query (Voyage AI)
   */
  private async getEmbedding(text: string): Promise<number[]> {
    const voyageApiKey = process.env.VOYAGE_API_KEY;
    if (!voyageApiKey) {
      throw new Error('VOYAGE_API_KEY not configured');
    }

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${voyageApiKey}`,
      },
      body: JSON.stringify({
        model: 'voyage-3-large',
        input: [text],
      }),
    });

    if (!response.ok) {
      throw new Error(`Voyage API error: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  /**
   * Build or retrieve regex patterns for a capability
   */
  private getOrBuildPatterns(capability: CapabilityEntity): RegExp[] {
    const cacheKey = capability.id;
    if (this.patternCache.has(cacheKey)) {
      return this.patternCache.get(cacheKey)!;
    }

    const patterns: RegExp[] = [];

    for (const pattern of capability.structuredData.queryPatterns) {
      try {
        // Escape special regex characters and create pattern
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patterns.push(new RegExp(escaped, 'i'));

        // Also create a word-boundary pattern
        patterns.push(new RegExp(`\\b${escaped}\\b`, 'i'));
      } catch {
        // Skip invalid patterns
      }
    }

    this.patternCache.set(cacheKey, patterns);
    return patterns;
  }

  /**
   * Merge pattern and semantic matches, removing duplicates
   */
  private mergeMatches(
    patternMatches: CapabilityMatch[],
    semanticMatches: CapabilityMatch[]
  ): CapabilityMatch[] {
    const seen = new Set<string>();
    const merged: CapabilityMatch[] = [];

    // Pattern matches take priority
    for (const match of patternMatches) {
      const key = `${match.serviceId}:${match.capabilityId}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(match);
      }
    }

    // Add semantic matches not already seen
    for (const match of semanticMatches) {
      const key = `${match.serviceId}:${match.capabilityId}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(match);
      }
    }

    return merged;
  }

  /**
   * Score matches using performance data
   */
  private async scoreMatches(matches: CapabilityMatch[]): Promise<CapabilityMatch[]> {
    const scored: CapabilityMatch[] = [];

    for (const match of matches) {
      const score = await this.scorer.calculateScore(match.serviceId);

      // Combine confidence with performance score
      const adjustedScore: ServiceScore = {
        ...score,
        compositeScore: match.confidence * 0.4 + score.compositeScore * 0.6,
      };

      scored.push({
        ...match,
        score: adjustedScore,
      });
    }

    return scored;
  }

  /**
   * Build human-readable reasoning for the match
   */
  private buildReasoning(query: string, matches: CapabilityMatch[]): string {
    if (matches.length === 0) {
      return `No matching services found for query: "${query}"`;
    }

    const topMatch = matches[0];
    const reasons: string[] = [];

    reasons.push(`Best match: ${topMatch.serviceName} - ${topMatch.capabilityName}`);
    reasons.push(`Confidence: ${(topMatch.confidence * 100).toFixed(1)}%`);
    reasons.push(`Performance score: ${(topMatch.score.compositeScore * 100).toFixed(1)}%`);

    if (matches.length > 1) {
      reasons.push(`Alternatives: ${matches.slice(1).map(m => m.serviceName).join(', ')}`);
    }

    return reasons.join('. ');
  }

  /**
   * Index a capability in Qdrant for semantic search
   */
  async indexCapability(
    capability: CapabilityEntity,
    service: ServiceEntity
  ): Promise<void> {
    if (!this.qdrant) return;

    try {
      // Ensure collection exists
      await this.ensureCollection();

      // Get embedding for capability text
      const embedding = await this.getEmbedding(capability.textContent);

      // Upsert to Qdrant
      await this.qdrant.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: capability.id,
            vector: embedding,
            payload: {
              serviceId: service.id,
              serviceName: service.structuredData.name,
              capabilityId: capability.id,
              capabilityName: capability.structuredData.name,
              endpoint: capability.structuredData.endpoint,
              method: capability.structuredData.method,
              estimatedDuration: capability.structuredData.estimatedDuration,
              queryPatterns: capability.structuredData.queryPatterns,
            },
          },
        ],
      });
    } catch (error) {
      console.error('Failed to index capability:', error);
    }
  }

  /**
   * Ensure Qdrant collection exists
   */
  private async ensureCollection(): Promise<void> {
    if (!this.qdrant) return;

    try {
      await this.qdrant.getCollection(this.collectionName);
    } catch {
      // Collection doesn't exist, create it
      await this.qdrant.createCollection(this.collectionName, {
        vectors: {
          size: this.embeddingDimension,
          distance: 'Cosine',
        },
      });
    }
  }
}

// Export factory
export function createCapabilityMatcher(
  repository: ServiceCatalogRepository,
  scorer: PerformanceScorer,
  qdrantUrl?: string
): CapabilityMatcher {
  return new CapabilityMatcher(repository, scorer, qdrantUrl);
}
