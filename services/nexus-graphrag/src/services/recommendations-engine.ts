/**
 * Smart Recommendations Engine
 *
 * Phase 4: Advanced Features & Performance
 *
 * Provides intelligent content recommendations based on:
 * - User behavior and preferences
 * - Content similarity
 * - Collaborative filtering
 * - Trending content
 * - Related entities and concepts
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { EnhancedTenantContext } from '../middleware/tenant-context';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface RecommendationRequest {
  tenantContext: EnhancedTenantContext;
  basedOn?: {
    contentId?: string;
    query?: string;
    recentActivity?: string[];
  };
  filters?: {
    type?: 'memory' | 'document' | 'episode' | 'entity';
    tags?: string[];
    maxAge?: number; // days
  };
  limit?: number;
}

export interface Recommendation {
  id: string;
  content: string;
  title?: string;
  type: string;
  score: number;
  reason: string; // Why this was recommended
  metadata?: any;
}

export interface RecommendationResult {
  recommendations: Recommendation[];
  reasons: string[];
}

// ============================================================================
// RECOMMENDATIONS ENGINE
// ============================================================================

export class RecommendationsEngine {
  constructor(
    private readonly db: Pool,
    private readonly qdrant: QdrantClient,
    private readonly _redis: Redis
  ) {}

  /**
   * Get personalized recommendations
   */
  async getRecommendations(
    request: RecommendationRequest
  ): Promise<RecommendationResult> {
    const limit = request.limit || 10;
    const recommendations: Recommendation[] = [];
    const reasons = new Set<string>();

    try {
      // Strategy 1: Content-based (if contentId provided)
      if (request.basedOn?.contentId) {
        const similar = await this.getSimilarContent(
          request.basedOn.contentId,
          request.tenantContext,
          Math.ceil(limit * 0.4)
        );
        recommendations.push(...similar);
        reasons.add('Similar to content you viewed');
      }

      // Strategy 2: Trending content
      const trending = await this.getTrendingContent(
        request.tenantContext,
        Math.ceil(limit * 0.3)
      );
      recommendations.push(...trending);
      reasons.add('Trending in your workspace');

      // Strategy 3: Recent activity based
      if (request.basedOn?.recentActivity && request.basedOn.recentActivity.length > 0) {
        const activityBased = await this.getActivityBasedRecommendations(
          request.basedOn.recentActivity,
          request.tenantContext,
          Math.ceil(limit * 0.3)
        );
        recommendations.push(...activityBased);
        reasons.add('Based on your recent activity');
      }

      // Deduplicate and sort by score
      const deduplicated = this.deduplicateRecommendations(recommendations);
      const sorted = deduplicated.sort((a, b) => b.score - a.score);

      return {
        recommendations: sorted.slice(0, limit),
        reasons: Array.from(reasons),
      };
    } catch (error) {
      logger.error('Failed to get recommendations', {
        error: error instanceof Error ? error.message : error,
        companyId: request.tenantContext.companyId,
      });
      throw error;
    }
  }

  /**
   * Get similar content based on vector similarity
   */
  private async getSimilarContent(
    contentId: string,
    tenantContext: EnhancedTenantContext,
    limit: number
  ): Promise<Recommendation[]> {
    try {
      // Get content vector from Qdrant
      const content = await this.db.query(
        `SELECT content, embedding FROM graphrag.unified_content WHERE id = $1`,
        [contentId]
      );

      if (content.rows.length === 0) {
        return [];
      }

      // Search for similar vectors in Qdrant
      const searchResult = await this.qdrant.search('unified_content', {
        vector: content.rows[0].embedding,
        filter: {
          must: [
            { key: 'company_id', match: { value: tenantContext.companyId } },
            { key: 'app_id', match: { value: tenantContext.appId } },
          ],
        },
        limit: limit + 1, // +1 to exclude original
        with_payload: true,
      });

      // Map to recommendations (exclude original)
      return searchResult
        .filter(result => result.id !== contentId)
        .map(result => ({
          id: result.id as string,
          content: result.payload?.content as string || '',
          title: result.payload?.title as string,
          type: result.payload?.content_type as string || 'unknown',
          score: result.score,
          reason: 'Similar content',
          metadata: result.payload,
        }));
    } catch (error) {
      logger.error('Failed to get similar content', {
        error: error instanceof Error ? error.message : error,
        contentId,
      });
      return [];
    }
  }

  /**
   * Get trending content (most accessed recently)
   */
  private async getTrendingContent(
    tenantContext: EnhancedTenantContext,
    limit: number
  ): Promise<Recommendation[]> {
    try {
      const result = await this.db.query(
        `SELECT
          uc.id,
          uc.content,
          uc.title,
          uc.content_type as type,
          COUNT(DISTINCT um.user_id) as unique_users,
          COUNT(*) as total_accesses
        FROM graphrag.unified_content uc
        LEFT JOIN graphrag.usage_metrics um
          ON um.metadata->>'content_id' = uc.id::text
          AND um.timestamp > CURRENT_TIMESTAMP - INTERVAL '7 days'
        WHERE uc.company_id = $1
          AND uc.app_id = $2
        GROUP BY uc.id, uc.content, uc.title, uc.content_type
        HAVING COUNT(*) > 0
        ORDER BY unique_users DESC, total_accesses DESC
        LIMIT $3`,
        [tenantContext.companyId, tenantContext.appId, limit]
      );

      return result.rows.map(row => ({
        id: row.id,
        content: row.content,
        title: row.title,
        type: row.type,
        score: parseFloat(row.unique_users) / 10, // Normalize
        reason: `Trending (${row.unique_users} users)`,
      }));
    } catch (error) {
      logger.error('Failed to get trending content', {
        error: error instanceof Error ? error.message : error,
        companyId: tenantContext.companyId,
      });
      return [];
    }
  }

  /**
   * Get recommendations based on recent activity
   */
  private async getActivityBasedRecommendations(
    recentContentIds: string[],
    tenantContext: EnhancedTenantContext,
    limit: number
  ): Promise<Recommendation[]> {
    try {
      // Get tags from recently accessed content
      const result = await this.db.query(
        `SELECT DISTINCT unnest(tags) as tag, COUNT(*) as frequency
        FROM graphrag.unified_content
        WHERE id = ANY($1)
          AND company_id = $2
          AND app_id = $3
        GROUP BY tag
        ORDER BY frequency DESC
        LIMIT 10`,
        [recentContentIds, tenantContext.companyId, tenantContext.appId]
      );

      if (result.rows.length === 0) {
        return [];
      }

      const topTags = result.rows.map(row => row.tag);

      // Find content with similar tags
      const recommendations = await this.db.query(
        `SELECT id, content, title, content_type as type, tags
        FROM graphrag.unified_content
        WHERE company_id = $1
          AND app_id = $2
          AND id != ALL($3)
          AND tags && $4
        ORDER BY array_length(tags, 1) DESC
        LIMIT $5`,
        [
          tenantContext.companyId,
          tenantContext.appId,
          recentContentIds,
          topTags,
          limit,
        ]
      );

      return recommendations.rows.map(row => ({
        id: row.id,
        content: row.content,
        title: row.title,
        type: row.type,
        score: 0.7, // Fixed score for activity-based
        reason: `Matches your interests: ${topTags.slice(0, 3).join(', ')}`,
      }));
    } catch (error) {
      logger.error('Failed to get activity-based recommendations', {
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  }

  /**
   * Deduplicate recommendations
   */
  private deduplicateRecommendations(
    recommendations: Recommendation[]
  ): Recommendation[] {
    const seen = new Set<string>();
    const deduplicated: Recommendation[] = [];

    for (const rec of recommendations) {
      if (!seen.has(rec.id)) {
        seen.add(rec.id);
        deduplicated.push(rec);
      }
    }

    return deduplicated;
  }

  /**
   * Get related entities for content
   */
  async getRelatedEntities(
    contentId: string,
    tenantContext: EnhancedTenantContext,
    limit: number = 5
  ): Promise<Array<{ name: string; type: string; score: number }>> {
    try {
      const result = await this.db.query(
        `SELECT entity_name, entity_type, COUNT(*) as mentions
        FROM graphrag.extracted_entities
        WHERE content_id = $1
          AND company_id = $2
        GROUP BY entity_name, entity_type
        ORDER BY mentions DESC
        LIMIT $3`,
        [contentId, tenantContext.companyId, limit]
      );

      return result.rows.map(row => ({
        name: row.entity_name,
        type: row.entity_type,
        score: parseFloat(row.mentions),
      }));
    } catch (error) {
      logger.error('Failed to get related entities', {
        error: error instanceof Error ? error.message : error,
        contentId,
      });
      return [];
    }
  }
}
