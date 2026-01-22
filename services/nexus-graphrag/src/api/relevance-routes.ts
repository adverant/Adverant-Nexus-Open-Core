/**
 * Relevance Tracking API Routes
 *
 * Nexus Memory Lens Feature - API Endpoints
 *
 * Provides endpoints for:
 * - Relevance-based retrieval with decay scoring
 * - Access event logging
 * - User importance management
 * - Score calculation and caching
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import {
  extractTenantContext,
  requireUserContext,
} from '../middleware/tenant-context';
import {
  RelevanceNode,
  RelevanceScore,
  RelevanceResult,
  RelevanceQueryOptions,
  AccessEvent,
  RelevanceRetrieveRequest,
  RelevanceRetrieveResponse,
  RecordAccessRequest,
  RecordAccessResponse,
  SetImportanceRequest,
  SetImportanceResponse,
  GetScoreResponse,
  RelevanceError,
  RelevanceErrorCode,
  UnifiedContentRow,
  DEFAULT_RELEVANCE_WEIGHTS,
} from '../relevance/types';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Map database row to RelevanceNode
 */
function mapRowToRelevanceNode(row: UnifiedContentRow): RelevanceNode {
  return {
    id: row.id,
    contentType: row.content_type as 'memory' | 'document' | 'episode' | 'chunk',
    content: row.content,
    metadata: row.metadata || {},
    tags: row.tags || [],
    lastAccessed: new Date(row.last_accessed),
    accessCount: row.access_count,
    stability: parseFloat(row.stability.toString()),
    retrievability: parseFloat(row.retrievability.toString()),
    userImportance: row.user_importance ? parseFloat(row.user_importance.toString()) : undefined,
    aiImportance: row.ai_importance ? parseFloat(row.ai_importance.toString()) : undefined,
    hasGraphRelationships: row.has_graph_relationships,
    relevanceScoreCached: row.relevance_score_cached ? parseFloat(row.relevance_score_cached.toString()) : undefined,
    relevanceCacheExpiresAt: row.relevance_cache_expires_at ? new Date(row.relevance_cache_expires_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    userId: row.user_id,
    sessionId: row.session_id,
  };
}

/**
 * Validate relevance score (0-1)
 */
function validateRelevanceScore(score: number): void {
  if (typeof score !== 'number' || score < 0 || score > 1 || isNaN(score)) {
    throw new RelevanceError(
      RelevanceErrorCode.INVALID_RELEVANCE_SCORE,
      'Relevance score must be a number between 0 and 1',
      { providedScore: score }
    );
  }
}

/**
 * Validate importance value (0-1)
 */
function validateImportance(importance: number): void {
  if (typeof importance !== 'number' || importance < 0 || importance > 1 || isNaN(importance)) {
    throw new RelevanceError(
      RelevanceErrorCode.INVALID_IMPORTANCE_VALUE,
      'Importance must be a number between 0 and 1',
      { providedImportance: importance }
    );
  }
}

// ============================================================================
// CREATE RELEVANCE ROUTES
// ============================================================================

export function createRelevanceRoutes(db: Pool): Router {
  const router = Router();

  // All routes require tenant context
  router.use(extractTenantContext);

  // ============================================================================
  // POST /api/relevance/retrieve
  // Query content with relevance scoring
  // ============================================================================

  router.post(
    '/retrieve',
    requireUserContext,
    async (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();

      try {
        const {
          query,
          contentTypes,
          tags,
          minRelevanceScore = 0.0,
          minRetrievability = 0.0,
          minStability = 0.0,
          sortBy = 'relevance',
          sortOrder = 'desc',
          limit = 50,
          offset = 0,
          useCache = true,
        } = req.body as RelevanceRetrieveRequest;

        const { tenantContext } = req;

        if (!tenantContext) {
          throw new RelevanceError(
            RelevanceErrorCode.MISSING_TENANT_CONTEXT,
            'Tenant context is required'
          );
        }

        // Build WHERE clause
        const whereClauses: string[] = [
          'user_id = $1', // Tenant isolation
        ];
        const queryParams: any[] = [tenantContext.userId];
        let paramIndex = 2;

        // Content type filter
        if (contentTypes && contentTypes.length > 0) {
          whereClauses.push(`content_type = ANY($${paramIndex})`);
          queryParams.push(contentTypes);
          paramIndex++;
        }

        // Tags filter
        if (tags && tags.length > 0) {
          whereClauses.push(`tags && $${paramIndex}`);
          queryParams.push(tags);
          paramIndex++;
        }

        // Retrievability filter
        if (minRetrievability > 0) {
          whereClauses.push(`retrievability >= $${paramIndex}`);
          queryParams.push(minRetrievability);
          paramIndex++;
        }

        // Stability filter
        if (minStability > 0) {
          whereClauses.push(`stability >= $${paramIndex}`);
          queryParams.push(minStability);
          paramIndex++;
        }

        // Build ORDER BY clause
        const sortColumnMap: Record<string, string> = {
          relevance: 'relevance_score_cached',
          lastAccessed: 'last_accessed',
          accessCount: 'access_count',
          stability: 'stability',
          retrievability: 'retrievability',
          createdAt: 'created_at',
        };

        const sortColumn = sortColumnMap[sortBy] || 'relevance_score_cached';
        const sortDirection = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Query with relevance calculation
        const queryText = `
          SELECT
            id,
            content_type,
            content,
            metadata,
            tags,
            importance,
            embedding_model,
            embedding_generated,
            source,
            user_id,
            session_id,
            created_at,
            updated_at,
            parent_id,
            hierarchy_level,
            last_accessed,
            access_count,
            stability,
            retrievability,
            user_importance,
            ai_importance,
            has_graph_relationships,
            relevance_score_cached,
            relevance_cache_expires_at,
            COALESCE(
              CASE
                WHEN $${paramIndex} = true
                  AND relevance_score_cached IS NOT NULL
                  AND relevance_cache_expires_at > NOW()
                THEN relevance_score_cached
                ELSE graphrag.calculate_relevance_score(id, NULL, false)
              END,
              0.0
            ) as relevance_score
          FROM graphrag.unified_content
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY ${sortColumn} ${sortDirection}, created_at DESC
          LIMIT $${paramIndex + 1}
          OFFSET $${paramIndex + 2}
        `;

        queryParams.push(useCache, limit, offset);

        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total
          FROM graphrag.unified_content
          WHERE ${whereClauses.join(' AND ')}
        `;

        const [dataResult, countResult] = await Promise.all([
          db.query(queryText, queryParams),
          db.query(countQuery, queryParams.slice(0, paramIndex - 1)),
        ]);

        // Map rows to RelevanceNodes with scores
        const nodes = dataResult.rows.map((row: any) => {
          const node = mapRowToRelevanceNode(row);
          return {
            ...node,
            relevanceScore: parseFloat(row.relevance_score),
          };
        });

        // Filter by minimum relevance score (post-calculation)
        const filteredNodes = nodes.filter(
          (node) => node.relevanceScore >= minRelevanceScore
        );

        // Count fallback nodes (those without cached scores)
        const fallbackNodeCount = nodes.filter(
          (node) =>
            !node.relevanceScoreCached ||
            !node.relevanceCacheExpiresAt ||
            node.relevanceCacheExpiresAt < new Date()
        ).length;

        const executionTimeMs = Date.now() - startTime;

        const result: RelevanceResult = {
          nodes: filteredNodes,
          total: parseInt(countResult.rows[0].total),
          fallbackNodeCount,
          query: {
            filters: {
              contentTypes,
              tags,
              minRelevanceScore,
              minRetrievability,
            },
            sort: {
              by: sortBy,
              order: sortOrder,
            },
            pagination: {
              limit,
              offset,
            },
          },
          executionTimeMs,
        };

        logger.info('Relevance retrieve completed', {
          userId: tenantContext.userId,
          totalResults: result.total,
          returnedResults: filteredNodes.length,
          fallbackNodeCount,
          executionTimeMs,
        });

        const response: RelevanceRetrieveResponse = {
          success: true,
          result,
        };

        return res.json(response);
      } catch (error) {
        logger.error('Error in relevance retrieve', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return next(error);
      }
    }
  );

  // ============================================================================
  // POST /api/relevance/access
  // Record access event and update metrics
  // ============================================================================

  router.post(
    '/access',
    requireUserContext,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          nodeId,
          accessType,
          contextType,
          relevanceScore,
          metadata = {},
        } = req.body as RecordAccessRequest;

        const { tenantContext } = req;

        if (!tenantContext) {
          throw new RelevanceError(
            RelevanceErrorCode.MISSING_TENANT_CONTEXT,
            'Tenant context is required'
          );
        }

        // Validate access type
        const validAccessTypes = ['retrieve', 'view', 'edit', 'share'];
        if (!validAccessTypes.includes(accessType)) {
          throw new RelevanceError(
            RelevanceErrorCode.INVALID_ACCESS_TYPE,
            `Invalid access type. Must be one of: ${validAccessTypes.join(', ')}`,
            { providedAccessType: accessType }
          );
        }

        // Validate relevance score if provided
        if (relevanceScore !== undefined) {
          validateRelevanceScore(relevanceScore);
        }

        // Verify node exists and belongs to user
        const nodeCheck = await db.query(
          'SELECT id FROM graphrag.unified_content WHERE id = $1 AND user_id = $2',
          [nodeId, tenantContext.userId]
        );

        if (nodeCheck.rows.length === 0) {
          throw new RelevanceError(
            RelevanceErrorCode.NODE_NOT_FOUND,
            'Node not found or access denied',
            { nodeId }
          );
        }

        // Record access using PostgreSQL function
        await db.query(
          'SELECT graphrag.record_content_access($1, $2, $3, $4, $5, $6)',
          [
            nodeId,
            tenantContext.userId,
            tenantContext.sessionId || null,
            accessType,
            contextType || 'manual',
            relevanceScore || null,
          ]
        );

        // Get updated metrics
        const metricsResult = await db.query(
          `SELECT stability, retrievability, access_count, last_accessed
           FROM graphrag.unified_content
           WHERE id = $1`,
          [nodeId]
        );

        const metrics = metricsResult.rows[0];

        logger.info('Access event recorded', {
          nodeId,
          userId: tenantContext.userId,
          accessType,
          newStability: parseFloat(metrics.stability),
          accessCount: metrics.access_count,
        });

        const response: RecordAccessResponse = {
          success: true,
          message: 'Access recorded successfully',
          updatedMetrics: {
            stability: parseFloat(metrics.stability),
            retrievability: parseFloat(metrics.retrievability),
            accessCount: metrics.access_count,
            lastAccessed: new Date(metrics.last_accessed),
          },
        };

        return res.json(response);
      } catch (error) {
        logger.error('Error recording access', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return next(error);
      }
    }
  );

  // ============================================================================
  // PUT /api/relevance/importance/:nodeId
  // Set user importance for a node
  // ============================================================================

  router.put(
    '/importance/:nodeId',
    requireUserContext,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { nodeId } = req.params;
        const { importance } = req.body as SetImportanceRequest;
        const { tenantContext } = req;

        if (!tenantContext) {
          throw new RelevanceError(
            RelevanceErrorCode.MISSING_TENANT_CONTEXT,
            'Tenant context is required'
          );
        }

        // Validate importance
        validateImportance(importance);

        // Verify node exists and belongs to user
        const nodeCheck = await db.query(
          'SELECT id FROM graphrag.unified_content WHERE id = $1 AND user_id = $2',
          [nodeId, tenantContext.userId]
        );

        if (nodeCheck.rows.length === 0) {
          throw new RelevanceError(
            RelevanceErrorCode.NODE_NOT_FOUND,
            'Node not found or access denied',
            { nodeId }
          );
        }

        // Update user importance and invalidate cache
        await db.query(
          `UPDATE graphrag.unified_content
           SET user_importance = $1,
               relevance_score_cached = NULL,
               relevance_cache_expires_at = NULL
           WHERE id = $2`,
          [importance, nodeId]
        );

        logger.info('User importance updated', {
          nodeId,
          userId: tenantContext.userId,
          importance,
        });

        const response: SetImportanceResponse = {
          success: true,
          message: 'User importance updated successfully',
          nodeId,
          userImportance: importance,
        };

        return res.json(response);
      } catch (error) {
        logger.error('Error setting user importance', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return next(error);
      }
    }
  );

  // ============================================================================
  // GET /api/relevance/score/:nodeId
  // Get detailed relevance score for a node
  // ============================================================================

  router.get(
    '/score/:nodeId',
    requireUserContext,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { nodeId } = req.params;
        const { tenantContext } = req;

        if (!tenantContext) {
          throw new RelevanceError(
            RelevanceErrorCode.MISSING_TENANT_CONTEXT,
            'Tenant context is required'
          );
        }

        // Get node with calculated score
        const result = await db.query(
          `SELECT
             id,
             content_type,
             content,
             metadata,
             tags,
             importance,
             embedding_model,
             embedding_generated,
             source,
             user_id,
             session_id,
             created_at,
             updated_at,
             parent_id,
             hierarchy_level,
             last_accessed,
             access_count,
             stability,
             retrievability,
             user_importance,
             ai_importance,
             has_graph_relationships,
             relevance_score_cached,
             relevance_cache_expires_at,
             graphrag.calculate_relevance_score(id, NULL, false) as relevance_score
           FROM graphrag.unified_content
           WHERE id = $1 AND user_id = $2`,
          [nodeId, tenantContext.userId]
        );

        if (result.rows.length === 0) {
          throw new RelevanceError(
            RelevanceErrorCode.NODE_NOT_FOUND,
            'Node not found or access denied',
            { nodeId }
          );
        }

        const row = result.rows[0];
        const node = mapRowToRelevanceNode(row);
        const finalScore = parseFloat(row.relevance_score);

        // Calculate breakdown
        const vectorSimilarity = undefined; // Not available without query
        const stability = node.stability;
        const retrievability = node.retrievability;
        const userImportance = node.userImportance || 0.5;
        const aiImportance = node.aiImportance || 0.5;
        const graphBoost = node.hasGraphRelationships ? 0.05 : 0.0;

        const weights = { ...DEFAULT_RELEVANCE_WEIGHTS };
        const usedFallback = !vectorSimilarity;

        // If no vector similarity, redistribute weight
        if (usedFallback) {
          weights.stability = 0.15 + 0.15;
          weights.retrievability = 0.20 + 0.15;
          weights.vector = 0.0;
        }

        const score: RelevanceScore = {
          nodeId,
          score: finalScore,
          breakdown: {
            vectorSimilarity,
            stability,
            retrievability,
            userImportance,
            aiImportance,
            graphBoost,
          },
          weights,
          usedFallback,
          computedAt: new Date(),
        };

        logger.debug('Relevance score retrieved', {
          nodeId,
          score: finalScore,
          usedFallback,
        });

        const response: GetScoreResponse = {
          success: true,
          nodeId,
          score,
          node,
        };

        return res.json(response);
      } catch (error) {
        logger.error('Error getting relevance score', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return next(error);
      }
    }
  );

  logger.info('Relevance routes initialized at /api/relevance');

  return router;
}

export default createRelevanceRoutes;
