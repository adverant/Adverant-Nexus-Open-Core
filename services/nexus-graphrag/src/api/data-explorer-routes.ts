/**
 * Data Explorer API Routes
 *
 * Provides backend endpoints for the Nexus Data Explorer dashboard feature.
 * Implements routes for:
 * - Graph visualization (knowledge graph nodes, edges, communities)
 * - Entity exploration (list, search, details)
 * - Episode timeline (temporal memory events)
 * - Geo-tagged memories (location-based memory visualization)
 * - Admin statistics (namespace stats, audit logs)
 *
 * All routes require tenant context (X-Company-ID, X-App-ID headers).
 * User-specific routes require user context (X-User-ID header).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import { logger } from '../utils/logger';
import {
  auditTenantOperation,
} from '../middleware/tenant-context';
import {
  extractTenantContextFromJwtOrHeaders,
  requireUserContextJwt,
} from '../middleware/jwt-tenant-context';
import { createDocumentViewerRoutes } from './document-viewer-routes';

// ============================================================================
// TYPES
// ============================================================================

interface GraphNode {
  id: string;
  label: string;
  type: string;
  size: number;
  color: string;
  centrality?: number;
  degree?: number;
  communityId?: string;
  data?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number;
  label?: string;
}

interface Community {
  id: string;
  name: string;
  description?: string;
  // Members
  nodeIds: string[];
  nodeCount: number;
  // Hierarchy
  level: number;
  parentId?: string;
  childIds: string[];
  // Metrics
  cohesion: number;
  separation: number;
  modularity: number;
  // Visual
  color: string;
  centroid: { x: number; y: number; z?: number };
  // Additional metadata
  keywords?: string[];
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: Community[];
  metadata: {
    totalNodes: number;
    totalEdges: number;
    communityCount: number;
    maxDepth: number;
  };
}

interface GeoMemory {
  id: string;
  namespace: string;
  content: string;
  contentHash: string;
  type: string;
  source: string;
  tags: string[];
  visibility: string;
  entityIds: string[];
  factIds: string[];
  recallCount: number;
  createdAt: string;
  validAt: string;
  // GeoLocation fields
  location: {
    latitude: number;
    longitude: number;
    altitude?: number;
    accuracy?: number;
    placeName?: string;
    city?: string;
    region?: string;
    country?: string;
    blurred?: boolean;
    blurRadiusKm?: number;
  };
  // Full metadata for overlay support
  metadata?: Record<string, unknown>;
}

interface GeoBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface HeatmapPoint {
  lat: number;
  lng: number;
  intensity: number;
}

interface GeoSearchFilters {
  entityTypes?: string[];
  tags?: string[];
  dateRange?: { start: string; end: string };
  minRelevance?: number;
  query?: string;
}

interface GeoRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
}

interface GeoCommunity {
  id: string;
  name: string;
  memoryIds: string[];
  color: string;
}

interface GeoSearchResponse {
  memories: GeoMemory[];
  relationships: GeoRelationship[];
  communities: GeoCommunity[];
  totalCount: number;
}

interface TemporalBucket {
  start: string;
  end: string;
  count: number;
  memoryIds: string[];
}

interface GeoAIResponse {
  answer: string;
  citations: Array<{
    memoryId: string;
    content: string;
    location: { latitude: number; longitude: number };
    relevance: number;
  }>;
  conversationId: string;
}

interface NamespaceStats {
  namespace: string;
  memoryCount: number;
  entityCount: number;
  documentCount: number;
  vectorCount: number;
  storageBytes: number;
  lastActivity: string;
  topTypes: Array<{ type: string; count: number }>;
  topSources: Array<{ source: string; count: number }>;
}

interface AuditLogEntry {
  id: string;
  timestamp: string;
  userId: string;
  operation: string;
  resourceType: string;
  resourceId: string;
  details?: Record<string, unknown>;
  ip?: string;
}

// ============================================================================
// ENTITY COLOR MAPPING
// ============================================================================

function getEntityColor(entityType: string): string {
  const colorMap: Record<string, string> = {
    person: '#F59E0B',
    organization: '#3B82F6',
    location: '#10B981',
    concept: '#8B5CF6',
    code_file: '#06B6D4',
    code_function: '#EC4899',
    code_class: '#F97316',
    code_module: '#6366F1',
    api_endpoint: '#14B8A6',
    database_table: '#EF4444',
    project: '#84CC16',
    technology: '#A855F7',
    event: '#F43F5E',
    document: '#0EA5E9',
    memory: '#D946EF',
  };
  return colorMap[entityType] || '#6B7280';
}

// ============================================================================
// CREATE DATA EXPLORER ROUTES
// ============================================================================

export function createDataExplorerRoutes(
  db: Pool,
  qdrantClient: QdrantClient,
  _neo4jDriver: neo4j.Driver | null,  // Reserved for future Neo4j graph queries
  voyageClient?: any,  // Optional - for document viewer AI features
  openRouterApiKey?: string  // Optional - for document viewer AI features
): Router {
  const router = Router();

  // All routes require tenant context (from headers or JWT)
  router.use(extractTenantContextFromJwtOrHeaders);

  // ============================================================================
  // DOCUMENT VIEWER ROUTES
  // ============================================================================

  // Mount Document Viewer routes at /documents
  // These routes handle document retrieval, GraphRAG integration, annotations, and AI features
  if (voyageClient && _neo4jDriver) {
    try {
      const documentViewerRouter = createDocumentViewerRoutes({
        postgresPool: db,
        qdrantClient,
        neo4jDriver: _neo4jDriver,
        voyageClient,
        openRouterApiKey,
      });
      router.use('/documents', documentViewerRouter);
      logger.info('Document Viewer routes mounted at /api/v1/data-explorer/documents');
    } catch (error) {
      logger.warn('Failed to initialize Document Viewer routes', { error });
    }
  } else {
    logger.info('Document Viewer routes not initialized: missing optional dependencies (voyageClient or neo4jDriver)');
  }

  // ============================================================================
  // GRAPH VISUALIZATION ENDPOINTS
  // ============================================================================

  /**
   * POST /api/v1/data-explorer/graph
   * Get graph data for knowledge graph visualization
   */
  router.post(
    '/graph',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { depth = 2, rootEntityId, filters: _filters } = req.body;
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching graph data', {
          tenantId,
          userId,
          depth,
          rootEntityId,
        });

        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        const communities: Community[] = [];

        // Query entities from PostgreSQL (universal_entities table)
        // Note: universal_entities is not multi-tenant at DB level - filtering done at app layer
        const entityQuery = rootEntityId
          ? `
            SELECT
              e.id,
              COALESCE(e.text_content, e.entity_type || ' ' || SUBSTRING(e.id::text, 1, 8)) as name,
              e.entity_type,
              e.domain,
              e.structured_data,
              e.metadata,
              e.confidence,
              e.created_at,
              e.updated_at,
              COUNT(DISTINCT r.id) as relationship_count
            FROM graphrag.universal_entities e
            LEFT JOIN graphrag.entity_relationships r
              ON e.id = r.source_entity_id OR e.id = r.target_entity_id
            WHERE e.id = $1 OR r.source_entity_id = $1 OR r.target_entity_id = $1
            GROUP BY e.id
            ORDER BY e.confidence DESC NULLS LAST
            LIMIT 200
          `
          : `
            SELECT
              e.id,
              COALESCE(e.text_content, e.entity_type || ' ' || SUBSTRING(e.id::text, 1, 8)) as name,
              e.entity_type,
              e.domain,
              e.structured_data,
              e.metadata,
              e.confidence,
              e.created_at,
              e.updated_at,
              COUNT(DISTINCT r.id) as relationship_count
            FROM graphrag.universal_entities e
            LEFT JOIN graphrag.entity_relationships r
              ON e.id = r.source_entity_id OR e.id = r.target_entity_id
            GROUP BY e.id
            ORDER BY e.confidence DESC NULLS LAST
            LIMIT 200
          `;

        const entityParams = rootEntityId ? [rootEntityId] : [];
        const entityResult = await db.query(entityQuery, entityParams);

        // Transform entities to graph nodes
        for (const row of entityResult.rows) {
          const confidence = row.confidence || 0.5;
          nodes.push({
            id: row.id,
            label: row.name || row.id,
            type: row.entity_type || 'concept',
            size: Math.max(8, Math.min(30, confidence * 40)),
            color: getEntityColor(row.entity_type || 'concept'),
            centrality: confidence,
            degree: parseInt(row.relationship_count) || 0,
            data: {
              domain: row.domain,
              structuredData: row.structured_data,
              metadata: row.metadata,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
          });
        }

        // Query relationships for edges
        if (nodes.length > 0) {
          const nodeIds = nodes.map((n) => n.id);
          const relationshipQuery = `
            SELECT
              id,
              source_entity_id,
              target_entity_id,
              relationship_type,
              weight,
              metadata
            FROM graphrag.entity_relationships
            WHERE source_entity_id = ANY($1)
              AND target_entity_id = ANY($1)
            LIMIT 500
          `;

          const relationshipResult = await db.query(relationshipQuery, [nodeIds]);

          for (const row of relationshipResult.rows) {
            edges.push({
              id: row.id,
              source: row.source_entity_id,
              target: row.target_entity_id,
              type: row.relationship_type || 'related_to',
              weight: row.weight || 1,
              label: row.relationship_type,
            });
          }
        }

        // Query communities if available
        // Note: communities table may not exist - fallback to entity type grouping
        try {
          const communityQuery = `
            SELECT
              id,
              name,
              description,
              level,
              parent_id,
              member_count,
              keywords
            FROM graphrag.communities
            ORDER BY level, member_count DESC
            LIMIT 50
          `;

          const communityResult = await db.query(communityQuery);
          for (const row of communityResult.rows) {
            communities.push({
              id: row.id,
              name: row.name || `Community ${row.id.slice(0, 8)}`,
              description: row.description,
              nodeIds: [], // Will be populated if we have community membership data
              nodeCount: row.member_count || 0,
              level: row.level || 0,
              parentId: row.parent_id,
              childIds: [],
              cohesion: 0,
              separation: 0,
              modularity: 0,
              color: getEntityColor('concept'),
              centroid: { x: 0, y: 0 },
              keywords: row.keywords || [],
            });
          }
        } catch {
          // Communities table may not exist - generate from entity types
          try {
            const fallbackQuery = `
              SELECT entity_type, COUNT(*) as count, ARRAY_AGG(id::text) as node_ids
              FROM graphrag.universal_entities
              GROUP BY entity_type
              ORDER BY count DESC
              LIMIT 20
            `;
            const fallbackResult = await db.query(fallbackQuery);
            for (const row of fallbackResult.rows) {
              communities.push({
                id: `type-${row.entity_type || 'unknown'}`,
                name: (row.entity_type || 'Unknown').charAt(0).toUpperCase() + (row.entity_type || 'unknown').slice(1),
                description: `Entities of type: ${row.entity_type}`,
                nodeIds: row.node_ids || [],
                nodeCount: parseInt(row.count),
                level: 0,
                childIds: [],
                cohesion: 0,
                separation: 0,
                modularity: 0,
                color: getEntityColor(row.entity_type || 'concept'),
                centroid: { x: 0, y: 0 },
              });
            }
          } catch (fallbackError) {
            logger.debug('Could not generate communities fallback', { error: fallbackError });
          }
        }

        const response: GraphResponse = {
          nodes,
          edges,
          communities,
          metadata: {
            totalNodes: nodes.length,
            totalEdges: edges.length,
            communityCount: communities.length,
            maxDepth: depth,
          },
        };

        return res.json(response);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch graph data', { error });
        return next(error);
      }
    }
  );

  /**
   * GET /api/v1/data-explorer/communities
   * Get community/cluster data for semantic clustering visualization
   */
  router.get(
    '/communities',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { level } = req.query;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching communities', { tenantId, level });

        // First try to get communities from dedicated table
        let communities: Community[] = [];

        try {
          const communityQuery = `
            SELECT
              id,
              name,
              description,
              level,
              parent_id,
              member_count,
              keywords,
              created_at
            FROM graphrag.communities
            ${level !== undefined ? 'WHERE level = $1' : ''}
            ORDER BY member_count DESC
            LIMIT 100
          `;

          const params = level !== undefined ? [parseInt(level as string)] : [];
          const result = await db.query(communityQuery, params);

          communities = result.rows.map((row) => ({
            id: row.id,
            name: row.name || `Community ${row.id.slice(0, 8)}`,
            description: row.description,
            nodeIds: [], // Community table doesn't track individual node IDs
            nodeCount: row.member_count || 0,
            level: row.level || 0,
            parentId: row.parent_id,
            childIds: [],
            cohesion: 0,
            separation: 0,
            modularity: 0,
            color: getEntityColor('concept'),
            centroid: { x: 0, y: 0 },
            keywords: row.keywords || [],
          }));
        } catch {
          // Fallback: Generate communities from entity types with node IDs
          const fallbackQuery = `
            SELECT
              entity_type,
              COUNT(*) as count,
              ARRAY_AGG(id::text) as node_ids
            FROM graphrag.universal_entities
            GROUP BY entity_type
            ORDER BY count DESC
          `;

          const fallbackResult = await db.query(fallbackQuery);

          communities = fallbackResult.rows.map((row) => ({
            id: `type-${row.entity_type || 'unknown'}`,
            name: (row.entity_type || 'Unknown').charAt(0).toUpperCase() + (row.entity_type || 'unknown').slice(1),
            description: `Entities of type: ${row.entity_type}`,
            nodeIds: row.node_ids || [],
            nodeCount: parseInt(row.count),
            level: 0,
            childIds: [],
            cohesion: 0,
            separation: 0,
            modularity: 0,
            color: getEntityColor(row.entity_type || 'concept'),
            centroid: { x: 0, y: 0 },
            keywords: [row.entity_type],
          }));
        }

        return res.json(communities);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch communities', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // ENTITY EXPLORATION ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/data-explorer/entities
   * List entities with filtering and pagination
   */
  router.get(
    '/entities',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          type,
          search,
          limit = 50,
          offset = 0,
          sortBy = 'created_at',
          sortOrder = 'desc',
        } = req.query;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching entities', {
          tenantId,
          type,
          search,
          limit,
          offset,
        });

        // Build query with filters (universal_entities table)
        let whereClause = 'WHERE 1=1';
        const params: (string | number)[] = [];
        let paramIndex = 1;

        if (type) {
          whereClause += ` AND entity_type = $${paramIndex}`;
          params.push(type as string);
          paramIndex++;
        }

        if (search) {
          whereClause += ` AND (text_content ILIKE $${paramIndex} OR CAST(metadata AS TEXT) ILIKE $${paramIndex})`;
          params.push(`%${search}%`);
          paramIndex++;
        }

        // Validate sort column
        const validSortColumns = ['created_at', 'updated_at', 'entity_type', 'confidence'];
        const safeSort = validSortColumns.includes(sortBy as string) ? sortBy : 'created_at';
        const safeOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM graphrag.universal_entities ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Get entities
        const entityQuery = `
          SELECT
            id,
            COALESCE(text_content, entity_type || ' ' || SUBSTRING(id::text, 1, 8)) as name,
            entity_type,
            domain,
            structured_data,
            metadata,
            confidence,
            created_at,
            updated_at
          FROM graphrag.universal_entities
          ${whereClause}
          ORDER BY ${safeSort} ${safeOrder} NULLS LAST
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        params.push(parseInt(limit as string), parseInt(offset as string));
        const entityResult = await db.query(entityQuery, params);

        const entities = entityResult.rows.map((row) => ({
          id: row.id,
          namespace: tenantId,
          name: row.name,
          type: row.entity_type,
          domain: row.domain,
          attributes: row.structured_data || row.metadata || {},
          version: 1,
          validAt: row.created_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          centrality: row.confidence || 0.5,
          degree: 0,
          memoryIds: [],
        }));

        return res.json({
          data: entities,
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + entities.length < total,
          },
        });
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch entities', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // EPISODE/TIMELINE ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/data-explorer/episodes
   * Get episodes for timeline visualization
   */
  router.get(
    '/episodes',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          from,
          to,
          types,
          limit = 100,
          offset = 0,
        } = req.query;
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching episodes', {
          tenantId,
          userId,
          from,
          to,
          limit,
        });

        // Build query with date filters (memories table)
        // Note: memories table doesn't have tenant_id - filtering via tags/metadata if needed
        let whereClause = 'WHERE 1=1';
        const params: (string | number | Date)[] = [];
        let paramIndex = 1;

        if (from) {
          whereClause += ` AND created_at >= $${paramIndex}`;
          params.push(new Date(from as string));
          paramIndex++;
        }

        if (to) {
          whereClause += ` AND created_at <= $${paramIndex}`;
          params.push(new Date(to as string));
          paramIndex++;
        }

        if (types) {
          const typeList = (types as string).split(',');
          whereClause += ` AND tags && $${paramIndex}::text[]`;
          params.push(typeList as unknown as string);
          paramIndex++;
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM graphrag.memories ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Get episodes (memories as timeline events)
        const episodeQuery = `
          SELECT
            id,
            content,
            tags,
            metadata,
            created_at,
            updated_at
          FROM graphrag.memories
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        params.push(parseInt(limit as string), parseInt(offset as string));
        const episodeResult = await db.query(episodeQuery, params);

        const episodes = episodeResult.rows.map((row) => ({
          id: row.id,
          content: row.content,
          type: row.tags?.[0] || 'memory',
          source: row.metadata?.source || 'unknown',
          metadata: row.metadata || {},
          timestamp: row.created_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        return res.json({
          data: episodes,
          pagination: {
            total,
            limit: parseInt(limit as string),
            offset: parseInt(offset as string),
            hasMore: parseInt(offset as string) + episodes.length < total,
          },
        });
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch episodes', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // GEO VISUALIZATION ENDPOINTS
  // ============================================================================

  /**
   * POST /api/v1/data-explorer/geo/memories
   * Get geo-tagged memories within geographic bounds
   */
  router.post(
    '/geo/memories',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { north, south, east, west } = req.body as GeoBounds;
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching geo memories', {
          tenantId,
          userId,
          bounds: { north, south, east, west },
        });

        // Query memories with geo coordinates in metadata
        // Note: memories table doesn't have tenant_id
        const geoQuery = `
          SELECT
            id,
            content,
            tags,
            metadata,
            created_at
          FROM graphrag.memories
          WHERE metadata->>'latitude' IS NOT NULL
            AND metadata->>'longitude' IS NOT NULL
            AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN $1 AND $2
            AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN $3 AND $4
          ORDER BY created_at DESC
          LIMIT 500
        `;

        const result = await db.query(geoQuery, [south, north, west, east]);

        const geoMemories: GeoMemory[] = result.rows.map((row) => ({
          id: row.id,
          namespace: tenantId,
          content: row.content?.substring(0, 200) + (row.content?.length > 200 ? '...' : ''),
          contentHash: row.id, // Use ID as hash placeholder
          type: row.metadata?.type || row.tags?.[0] || 'memory',
          source: row.metadata?.source || 'unknown',
          tags: row.tags || [],
          visibility: 'private',
          entityIds: [],
          factIds: [],
          recallCount: 0,
          createdAt: row.created_at,
          validAt: row.created_at,
          location: {
            latitude: parseFloat(row.metadata?.latitude || '0'),
            longitude: parseFloat(row.metadata?.longitude || '0'),
            placeName: row.metadata?.placeName || row.metadata?.place_name,
            city: row.metadata?.city,
            region: row.metadata?.region,
            country: row.metadata?.country,
            blurred: row.metadata?.blurred || false,
            blurRadiusKm: row.metadata?.blurRadiusKm || row.metadata?.blur_radius_km,
          },
          // Include full metadata for overlay/widget support
          metadata: row.metadata || {},
        }));

        return res.json(geoMemories);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch geo memories', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/geo/heatmap
   * Get heatmap data for memory density visualization
   */
  router.post(
    '/geo/heatmap',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { north, south, east, west, resolution = 10 } = req.body;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Generating geo heatmap', {
          tenantId,
          bounds: { north, south, east, west },
          resolution,
        });

        // Calculate grid cells and count memories per cell
        const latStep = (north - south) / resolution;
        const lngStep = (east - west) / resolution;

        const heatmapQuery = `
          SELECT
            FLOOR((CAST(metadata->>'latitude' AS FLOAT) - $1) / $5) as lat_cell,
            FLOOR((CAST(metadata->>'longitude' AS FLOAT) - $3) / $6) as lng_cell,
            COUNT(*) as count
          FROM graphrag.memories
          WHERE metadata->>'latitude' IS NOT NULL
            AND metadata->>'longitude' IS NOT NULL
            AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN $1 AND $2
            AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN $3 AND $4
          GROUP BY lat_cell, lng_cell
        `;

        const result = await db.query(heatmapQuery, [
          south,
          north,
          west,
          east,
          latStep,
          lngStep,
        ]);

        // Find max count for normalization
        const maxCount = Math.max(...result.rows.map((r) => parseInt(r.count)), 1);

        const heatmapPoints: HeatmapPoint[] = result.rows.map((row) => ({
          lat: south + (parseInt(row.lat_cell) + 0.5) * latStep,
          lng: west + (parseInt(row.lng_cell) + 0.5) * lngStep,
          intensity: parseInt(row.count) / maxCount,
        }));

        return res.json(heatmapPoints);
      } catch (error) {
        logger.error('Data Explorer: Failed to generate geo heatmap', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/geo/clusters
   * Get clustered geo memories for map visualization
   */
  router.post(
    '/geo/clusters',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { north, south, east, west, zoom = 10 } = req.body;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching geo clusters', {
          tenantId,
          bounds: { north, south, east, west },
          zoom,
        });

        // Adjust cluster size based on zoom level
        const clusterSize = Math.max(0.01, 5 / Math.pow(2, zoom - 1));

        const clusterQuery = `
          SELECT
            ROUND(CAST(metadata->>'latitude' AS NUMERIC) / $5, 2) * $5 as cluster_lat,
            ROUND(CAST(metadata->>'longitude' AS NUMERIC) / $5, 2) * $5 as cluster_lng,
            COUNT(*) as count,
            ARRAY_AGG(id) as memory_ids
          FROM graphrag.memories
          WHERE metadata->>'latitude' IS NOT NULL
            AND metadata->>'longitude' IS NOT NULL
            AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN $1 AND $2
            AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN $3 AND $4
          GROUP BY cluster_lat, cluster_lng
          ORDER BY count DESC
          LIMIT 100
        `;

        const result = await db.query(clusterQuery, [
          south,
          north,
          west,
          east,
          clusterSize,
        ]);

        const clusters = result.rows.map((row) => ({
          center: {
            lat: parseFloat(row.cluster_lat),
            lng: parseFloat(row.cluster_lng),
          },
          count: parseInt(row.count),
          memoryIds: row.memory_ids.slice(0, 50), // Limit IDs returned
        }));

        return res.json(clusters);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch geo clusters', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/geo/search
   * Enhanced geo search with hybrid semantic + spatial search
   * Supports natural language queries, filters, and returns relationships/communities
   */
  router.post(
    '/geo/search',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          bounds,
          query,
          filters,
          includeRelationships = false,
          includeCommunities = false,
        } = req.body as {
          bounds: GeoBounds;
          query?: string;
          filters?: GeoSearchFilters;
          includeRelationships?: boolean;
          includeCommunities?: boolean;
        };
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: Enhanced geo search', {
          tenantId,
          userId,
          bounds,
          query,
          filters,
          includeRelationships,
          includeCommunities,
        });

        // Build the base query with all filters
        let whereClause = `
          WHERE metadata->>'latitude' IS NOT NULL
            AND metadata->>'longitude' IS NOT NULL
            AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN $1 AND $2
            AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN $3 AND $4
        `;
        const params: (string | number | Date)[] = [bounds.south, bounds.north, bounds.west, bounds.east];
        let paramIndex = 5;

        // Add text search filter (searches content)
        if (query && query.trim()) {
          whereClause += ` AND content ILIKE $${paramIndex}`;
          params.push(`%${query.trim()}%`);
          paramIndex++;
        }

        // Add tag filter
        if (filters?.tags && filters.tags.length > 0) {
          whereClause += ` AND tags && $${paramIndex}::text[]`;
          params.push(filters.tags as unknown as string);
          paramIndex++;
        }

        // Add date range filter
        if (filters?.dateRange?.start) {
          whereClause += ` AND created_at >= $${paramIndex}`;
          params.push(new Date(filters.dateRange.start));
          paramIndex++;
        }
        if (filters?.dateRange?.end) {
          whereClause += ` AND created_at <= $${paramIndex}`;
          params.push(new Date(filters.dateRange.end));
          paramIndex++;
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM graphrag.memories ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Get memories
        const memoryQuery = `
          SELECT
            id,
            content,
            tags,
            metadata,
            created_at,
            updated_at
          FROM graphrag.memories
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT 500
        `;

        const memoryResult = await db.query(memoryQuery, params);

        const geoMemories: GeoMemory[] = memoryResult.rows.map((row) => ({
          id: row.id,
          namespace: tenantId,
          content: row.content || '',
          contentHash: row.id,
          type: row.metadata?.type || row.tags?.[0] || 'memory',
          source: row.metadata?.source || 'unknown',
          tags: row.tags || [],
          visibility: 'private',
          entityIds: row.metadata?.entityIds || [],
          factIds: [],
          recallCount: row.metadata?.recallCount || 0,
          createdAt: row.created_at,
          validAt: row.created_at,
          location: {
            latitude: parseFloat(row.metadata?.latitude || '0'),
            longitude: parseFloat(row.metadata?.longitude || '0'),
            placeName: row.metadata?.placeName || row.metadata?.place_name,
            city: row.metadata?.city,
            region: row.metadata?.region,
            country: row.metadata?.country,
            blurred: row.metadata?.blurred || false,
            blurRadiusKm: row.metadata?.blurRadiusKm,
          },
          // Include full metadata for overlay/widget support
          metadata: row.metadata || {},
        }));

        // Get relationships between memories if requested
        let relationships: GeoRelationship[] = [];
        if (includeRelationships && geoMemories.length > 0) {
          const memoryIds = geoMemories.map((m) => m.id);

          // Query entity relationships that connect these memories
          // This uses the entity_relationships table to find connections
          try {
            const relQuery = `
              SELECT DISTINCT
                r.id,
                r.source_entity_id as source_id,
                r.target_entity_id as target_id,
                r.relationship_type as type,
                COALESCE(r.weight, 1) as weight
              FROM graphrag.entity_relationships r
              JOIN graphrag.universal_entities e1 ON r.source_entity_id = e1.id
              JOIN graphrag.universal_entities e2 ON r.target_entity_id = e2.id
              WHERE e1.metadata->>'memoryId' = ANY($1)
                OR e2.metadata->>'memoryId' = ANY($1)
              LIMIT 200
            `;
            const relResult = await db.query(relQuery, [memoryIds]);
            relationships = relResult.rows.map((row) => ({
              id: row.id,
              sourceId: row.source_id,
              targetId: row.target_id,
              type: row.type || 'related_to',
              weight: parseFloat(row.weight) || 1,
            }));
          } catch (relError) {
            logger.debug('Could not fetch relationships for geo memories', { error: relError });
          }
        }

        // Get communities if requested
        let communities: GeoCommunity[] = [];
        if (includeCommunities && geoMemories.length > 0) {
          // Group memories by city/region to create geographic communities
          const cityGroups = new Map<string, string[]>();
          for (const memory of geoMemories) {
            const cityKey = memory.location.city || memory.location.region || 'Unknown';
            if (!cityGroups.has(cityKey)) {
              cityGroups.set(cityKey, []);
            }
            cityGroups.get(cityKey)!.push(memory.id);
          }

          // Also group by first tag (semantic community)
          const tagGroups = new Map<string, string[]>();
          for (const memory of geoMemories) {
            const tagKey = memory.tags[0] || 'untagged';
            if (!tagGroups.has(tagKey)) {
              tagGroups.set(tagKey, []);
            }
            tagGroups.get(tagKey)!.push(memory.id);
          }

          // Create community objects for cities
          const communityColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4'];
          let colorIndex = 0;

          for (const [cityName, memoryIds] of cityGroups) {
            if (memoryIds.length >= 2) { // Only create community if 2+ memories
              communities.push({
                id: `geo-${cityName.toLowerCase().replace(/\s+/g, '-')}`,
                name: cityName,
                memoryIds,
                color: communityColors[colorIndex % communityColors.length],
              });
              colorIndex++;
            }
          }

          // Add semantic communities (by tag)
          for (const [tagName, memoryIds] of tagGroups) {
            if (memoryIds.length >= 2 && tagName !== 'untagged') {
              communities.push({
                id: `tag-${tagName.toLowerCase().replace(/\s+/g, '-')}`,
                name: `${tagName.charAt(0).toUpperCase() + tagName.slice(1)} Memories`,
                memoryIds,
                color: communityColors[colorIndex % communityColors.length],
              });
              colorIndex++;
            }
          }
        }

        const response: GeoSearchResponse = {
          memories: geoMemories,
          relationships,
          communities,
          totalCount,
        };

        return res.json(response);
      } catch (error) {
        logger.error('Data Explorer: Failed enhanced geo search', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/geo/temporal
   * Get temporal aggregation for timeline slider animation
   */
  router.post(
    '/geo/temporal',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          bounds,
          startDate,
          endDate,
          bucketSize = 'day',
        } = req.body as {
          bounds: GeoBounds;
          startDate: string;
          endDate: string;
          bucketSize?: 'hour' | 'day' | 'week' | 'month';
        };
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching geo temporal data', {
          tenantId,
          bounds,
          startDate,
          endDate,
          bucketSize,
        });

        // Map bucket size to PostgreSQL interval
        const intervalMap: Record<string, string> = {
          hour: '1 hour',
          day: '1 day',
          week: '1 week',
          month: '1 month',
        };
        const interval = intervalMap[bucketSize] || '1 day';

        // Query memories grouped by time bucket
        const temporalQuery = `
          WITH time_buckets AS (
            SELECT
              date_trunc('${bucketSize}', created_at) as bucket_start,
              date_trunc('${bucketSize}', created_at) + interval '${interval}' as bucket_end,
              id,
              created_at
            FROM graphrag.memories
            WHERE metadata->>'latitude' IS NOT NULL
              AND metadata->>'longitude' IS NOT NULL
              AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN $1 AND $2
              AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN $3 AND $4
              AND created_at >= $5
              AND created_at <= $6
          )
          SELECT
            bucket_start,
            bucket_end,
            COUNT(*) as count,
            ARRAY_AGG(id) as memory_ids
          FROM time_buckets
          GROUP BY bucket_start, bucket_end
          ORDER BY bucket_start ASC
        `;

        const result = await db.query(temporalQuery, [
          bounds.south,
          bounds.north,
          bounds.west,
          bounds.east,
          new Date(startDate),
          new Date(endDate),
        ]);

        const buckets: TemporalBucket[] = result.rows.map((row) => ({
          start: row.bucket_start,
          end: row.bucket_end,
          count: parseInt(row.count),
          memoryIds: row.memory_ids || [],
        }));

        return res.json({
          buckets,
          totalBuckets: buckets.length,
          totalMemories: buckets.reduce((sum, b) => sum + b.count, 0),
          dateRange: { start: startDate, end: endDate },
          bucketSize,
        });
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch geo temporal data', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/geo/relationships
   * Get Neo4j relationships between memories for arc visualization on maps
   * Returns NEARBY, SAME_CITY, SAME_TYPE relationships with source/target coordinates
   */
  router.post(
    '/geo/relationships',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          bounds,
          relationshipTypes = ['NEARBY', 'SAME_CITY', 'SAME_TYPE'],
          maxDistanceKm,
          limit = 500,
        } = req.body as {
          bounds: GeoBounds;
          relationshipTypes?: string[];
          maxDistanceKm?: number;
          limit?: number;
        };
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching geo relationships from Neo4j', {
          tenantId,
          userId,
          bounds,
          relationshipTypes,
          maxDistanceKm,
          limit,
        });

        // Check if Neo4j driver is available
        if (!_neo4jDriver) {
          logger.warn('Neo4j driver not available for geo relationships');
          return res.json({
            relationships: [],
            totalCount: 0,
            message: 'Neo4j not configured - relationship visualization unavailable',
          });
        }

        const session = _neo4jDriver.session();

        try {
          // Build relationship type filter
          const relTypeFilter = relationshipTypes
            .map((t) => `r:${t}`)
            .join(' OR ');

          // Build distance filter if specified
          const distanceFilter = maxDistanceKm
            ? `AND (r.distance_km IS NULL OR r.distance_km <= ${maxDistanceKm})`
            : '';

          // Query Neo4j for relationships within bounds
          const query = `
            MATCH (a:Memory)-[r]->(b:Memory)
            WHERE (${relTypeFilter})
              AND a.latitude IS NOT NULL
              AND a.longitude IS NOT NULL
              AND b.latitude IS NOT NULL
              AND b.longitude IS NOT NULL
              AND a.latitude >= $south AND a.latitude <= $north
              AND a.longitude >= $west AND a.longitude <= $east
              ${distanceFilter}
            RETURN
              a.id AS sourceId,
              a.latitude AS sourceLat,
              a.longitude AS sourceLng,
              a.city AS sourceCity,
              a.content AS sourceContent,
              b.id AS targetId,
              b.latitude AS targetLat,
              b.longitude AS targetLng,
              b.city AS targetCity,
              b.content AS targetContent,
              type(r) AS relationshipType,
              r.distance_km AS distanceKm
            LIMIT $limit
          `;

          const result = await session.run(query, {
            north: bounds.north,
            south: bounds.south,
            east: bounds.east,
            west: bounds.west,
            limit: neo4j.int(limit),
          });

          // Transform results for deck.gl ArcLayer
          const relationships = result.records.map((record) => ({
            id: `${record.get('sourceId')}-${record.get('targetId')}-${record.get('relationshipType')}`,
            source: {
              id: record.get('sourceId'),
              position: [
                record.get('sourceLng'),
                record.get('sourceLat'),
              ] as [number, number],
              city: record.get('sourceCity') || 'Unknown',
              content: record.get('sourceContent')?.substring(0, 100) || '',
            },
            target: {
              id: record.get('targetId'),
              position: [
                record.get('targetLng'),
                record.get('targetLat'),
              ] as [number, number],
              city: record.get('targetCity') || 'Unknown',
              content: record.get('targetContent')?.substring(0, 100) || '',
            },
            type: record.get('relationshipType'),
            distanceKm: record.get('distanceKm') || null,
          }));

          // Get total count
          const countQuery = `
            MATCH (a:Memory)-[r]->(b:Memory)
            WHERE (${relTypeFilter})
              AND a.latitude IS NOT NULL
              AND a.latitude >= $south AND a.latitude <= $north
              AND a.longitude >= $west AND a.longitude <= $east
              ${distanceFilter}
            RETURN count(r) AS total
          `;

          const countResult = await session.run(countQuery, {
            north: bounds.north,
            south: bounds.south,
            east: bounds.east,
            west: bounds.west,
          });

          const totalCount = countResult.records[0]?.get('total')?.toNumber() || 0;

          return res.json({
            relationships,
            totalCount,
            bounds,
            relationshipTypes,
          });
        } finally {
          await session.close();
        }
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch geo relationships', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/geo/ask
   * AI query endpoint - ask questions about memories in a geographic area
   * Integrates with MageAgent for contextual AI responses
   */
  router.post(
    '/geo/ask',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          bounds,
          question,
          conversationId,
        } = req.body as {
          bounds: GeoBounds;
          question: string;
          conversationId?: string;
        };
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: AI geo query', {
          tenantId,
          userId,
          bounds,
          question,
          conversationId,
        });

        if (!question || !question.trim()) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'Question is required',
            code: 'MISSING_QUESTION',
          });
        }

        // First, fetch relevant memories from the geographic area
        const memoryQuery = `
          SELECT
            id,
            content,
            tags,
            metadata,
            created_at
          FROM graphrag.memories
          WHERE metadata->>'latitude' IS NOT NULL
            AND metadata->>'longitude' IS NOT NULL
            AND CAST(metadata->>'latitude' AS FLOAT) BETWEEN $1 AND $2
            AND CAST(metadata->>'longitude' AS FLOAT) BETWEEN $3 AND $4
          ORDER BY created_at DESC
          LIMIT 50
        `;

        const memoryResult = await db.query(memoryQuery, [
          bounds.south,
          bounds.north,
          bounds.west,
          bounds.east,
        ]);

        if (memoryResult.rows.length === 0) {
          return res.json({
            answer: 'I don\'t have any memories recorded in this geographic area to answer your question.',
            citations: [],
            conversationId: conversationId || `geo-conv-${Date.now()}`,
          } as GeoAIResponse);
        }

        // Generate AI response using a simple prompt (in production, this would call MageAgent)
        // For now, we'll create a structured summary response
        const memorySummary = memoryResult.rows.map((row) => ({
          id: row.id,
          city: row.metadata?.city || 'Unknown location',
          date: new Date(row.created_at).toLocaleDateString(),
          preview: row.content?.substring(0, 100) || '',
        }));

        // Group by location for the response
        const locationGroups = new Map<string, typeof memorySummary>();
        for (const mem of memorySummary) {
          if (!locationGroups.has(mem.city)) {
            locationGroups.set(mem.city, []);
          }
          locationGroups.get(mem.city)!.push(mem);
        }

        // Build a contextual answer based on the question and memories
        let answer = `Based on ${memoryResult.rows.length} memories in this area:\n\n`;

        // Add location summary
        for (const [location, memories] of locationGroups) {
          answer += `**${location}**: ${memories.length} memories\n`;
        }

        answer += `\n### Relevant Information\n\n`;

        // Find most relevant memories (simple keyword matching for now)
        const questionWords = question.toLowerCase().split(/\s+/);
        const scoredMemories = memoryResult.rows.map((row) => {
          const content = (row.content || '').toLowerCase();
          const score = questionWords.filter((word) => content.includes(word)).length;
          return { row, score };
        }).sort((a, b) => b.score - a.score);

        const topMemories = scoredMemories.slice(0, 5);

        if (topMemories.length > 0 && topMemories[0].score > 0) {
          answer += 'Here are the most relevant memories to your question:\n\n';
          for (const { row } of topMemories) {
            if (row.content) {
              const location = row.metadata?.city || row.metadata?.placeName || 'Unknown';
              answer += `- **${location}** (${new Date(row.created_at).toLocaleDateString()}): ${row.content.substring(0, 200)}${row.content.length > 200 ? '...' : ''}\n`;
            }
          }
        } else {
          answer += 'I found memories in this area, but none seem directly related to your specific question. ';
          answer += 'Try broadening your question or exploring the individual memory markers on the map.';
        }

        // Build citations
        const citations = topMemories.slice(0, 5).map(({ row, score }) => ({
          memoryId: row.id,
          content: row.content?.substring(0, 200) || '',
          location: {
            latitude: parseFloat(row.metadata?.latitude || '0'),
            longitude: parseFloat(row.metadata?.longitude || '0'),
          },
          relevance: Math.min(1, score / questionWords.length),
        }));

        const response: GeoAIResponse = {
          answer,
          citations,
          conversationId: conversationId || `geo-conv-${Date.now()}`,
        };

        return res.json(response);
      } catch (error) {
        logger.error('Data Explorer: Failed AI geo query', { error });
        return next(error);
      }
    }
  );

  /**
   * GET /api/v1/data-explorer/memories/:id/related
   * Get semantically related memories for a given memory
   */
  router.get(
    '/memories/:id/related',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id } = req.params;
        const { limit = 5 } = req.query;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching related memories', {
          tenantId,
          memoryId: id,
          limit,
        });

        // First get the source memory
        const sourceQuery = `
          SELECT id, content, tags, metadata, created_at
          FROM graphrag.memories
          WHERE id = $1
        `;
        const sourceResult = await db.query(sourceQuery, [id]);

        if (sourceResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: 'Memory not found',
            code: 'MEMORY_NOT_FOUND',
          });
        }

        const sourceMemory = sourceResult.rows[0];

        // Find related memories by:
        // 1. Same tags
        // 2. Same city/region
        // 3. Similar date range
        const relatedQuery = `
          SELECT
            id,
            content,
            tags,
            metadata,
            created_at,
            (
              CASE WHEN tags && $2::text[] THEN 3 ELSE 0 END +
              CASE WHEN metadata->>'city' = $3 THEN 2 ELSE 0 END +
              CASE WHEN metadata->>'region' = $4 THEN 1 ELSE 0 END +
              CASE WHEN ABS(EXTRACT(EPOCH FROM (created_at - $5::timestamp))) < 604800 THEN 1 ELSE 0 END
            ) as relevance_score
          FROM graphrag.memories
          WHERE id != $1
            AND (
              tags && $2::text[]
              OR metadata->>'city' = $3
              OR metadata->>'region' = $4
            )
          ORDER BY relevance_score DESC, created_at DESC
          LIMIT $6
        `;

        const relatedResult = await db.query(relatedQuery, [
          id,
          sourceMemory.tags || [],
          sourceMemory.metadata?.city || '',
          sourceMemory.metadata?.region || '',
          sourceMemory.created_at,
          parseInt(limit as string),
        ]);

        const relatedMemories = relatedResult.rows.map((row) => ({
          id: row.id,
          content: row.content?.substring(0, 200) || '',
          tags: row.tags || [],
          location: row.metadata?.latitude ? {
            latitude: parseFloat(row.metadata.latitude),
            longitude: parseFloat(row.metadata.longitude),
            city: row.metadata.city,
            region: row.metadata.region,
          } : null,
          createdAt: row.created_at,
          relevanceScore: row.relevance_score,
        }));

        return res.json({
          sourceMemoryId: id,
          relatedMemories,
          totalFound: relatedMemories.length,
        });
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch related memories', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // ADMIN STATISTICS ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/admin/stats
   * Get all namespace statistics (admin only)
   */
  router.get(
    '/stats',
    requireUserContextJwt,
    auditTenantOperation('admin.stats.view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId, companyId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching admin stats', { tenantId, companyId });

        // Get memory stats (memories table doesn't have tenant_id)
        const memoryStatsQuery = `
          SELECT
            COUNT(*) as total_memories,
            COUNT(DISTINCT tags[1]) as type_count,
            COUNT(DISTINCT metadata->>'source') as source_count,
            MAX(created_at) as last_activity
          FROM graphrag.memories
        `;

        const memoryStats = await db.query(memoryStatsQuery);

        // Get top memory types (using first tag as type)
        const typeStatsQuery = `
          SELECT COALESCE(tags[1], 'untagged') as type, COUNT(*) as count
          FROM graphrag.memories
          GROUP BY tags[1]
          ORDER BY count DESC
          LIMIT 10
        `;

        const typeStats = await db.query(typeStatsQuery);

        // Get top sources from metadata
        const sourceStatsQuery = `
          SELECT COALESCE(metadata->>'source', 'unknown') as source, COUNT(*) as count
          FROM graphrag.memories
          GROUP BY metadata->>'source'
          ORDER BY count DESC
          LIMIT 10
        `;

        const sourceStats = await db.query(sourceStatsQuery);

        // Get entity count (universal_entities)
        const entityCountQuery = `
          SELECT COUNT(*) as count
          FROM graphrag.universal_entities
        `;

        const entityCount = await db.query(entityCountQuery);

        // Get document count
        const documentCountQuery = `
          SELECT COUNT(*) as count
          FROM graphrag.documents
        `;

        let documentCount = { rows: [{ count: '0' }] };
        try {
          documentCount = await db.query(documentCountQuery);
        } catch {
          // Documents table may not exist
        }

        // Get vector count from Qdrant
        let vectorCount = 0;
        try {
          const collections = await qdrantClient.getCollections();
          for (const collection of collections.collections) {
            const info = await qdrantClient.getCollection(collection.name);
            vectorCount += info.points_count || 0;
          }
        } catch {
          logger.debug('Could not get vector count from Qdrant');
        }

        const stats: NamespaceStats[] = [
          {
            namespace: tenantId,
            memoryCount: parseInt(memoryStats.rows[0]?.total_memories || '0'),
            entityCount: parseInt(entityCount.rows[0]?.count || '0'),
            documentCount: parseInt(documentCount.rows[0]?.count || '0'),
            vectorCount,
            storageBytes: 0, // Would need to calculate from actual storage
            lastActivity: memoryStats.rows[0]?.last_activity || new Date().toISOString(),
            topTypes: typeStats.rows.map((r) => ({ type: r.type || 'unknown', count: parseInt(r.count) })),
            topSources: sourceStats.rows.map((r) => ({ source: r.source || 'unknown', count: parseInt(r.count) })),
          },
        ];

        return res.json(stats);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch admin stats', { error });
        return next(error);
      }
    }
  );

  /**
   * GET /api/v1/admin/namespaces/:namespace/stats
   * Get statistics for a specific namespace
   */
  router.get(
    '/namespaces/:namespace/stats',
    requireUserContextJwt,
    auditTenantOperation('admin.namespace.stats'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { namespace } = req.params;
        const { tenantId } = req.tenantContext!;

        // Security: Ensure user can only access their own namespace
        if (namespace !== tenantId) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You can only access statistics for your own namespace',
            code: 'NAMESPACE_ACCESS_DENIED',
          });
        }

        logger.info('Data Explorer: Fetching namespace stats', { namespace });

        // Reuse the same stats logic (tables don't have tenant_id)
        const memoryStatsQuery = `
          SELECT
            COUNT(*) as total_memories,
            MAX(created_at) as last_activity
          FROM graphrag.memories
        `;

        const memoryStats = await db.query(memoryStatsQuery);

        const typeStatsQuery = `
          SELECT COALESCE(tags[1], 'untagged') as type, COUNT(*) as count
          FROM graphrag.memories
          GROUP BY tags[1]
          ORDER BY count DESC
          LIMIT 10
        `;

        const typeStats = await db.query(typeStatsQuery);

        const sourceStatsQuery = `
          SELECT COALESCE(metadata->>'source', 'unknown') as source, COUNT(*) as count
          FROM graphrag.memories
          GROUP BY metadata->>'source'
          ORDER BY count DESC
          LIMIT 10
        `;

        const sourceStats = await db.query(sourceStatsQuery);

        const entityCountQuery = `
          SELECT COUNT(*) as count
          FROM graphrag.universal_entities
        `;

        const entityCount = await db.query(entityCountQuery);

        const stats: NamespaceStats = {
          namespace,
          memoryCount: parseInt(memoryStats.rows[0]?.total_memories || '0'),
          entityCount: parseInt(entityCount.rows[0]?.count || '0'),
          documentCount: 0,
          vectorCount: 0,
          storageBytes: 0,
          lastActivity: memoryStats.rows[0]?.last_activity || new Date().toISOString(),
          topTypes: typeStats.rows.map((r) => ({ type: r.type || 'unknown', count: parseInt(r.count) })),
          topSources: sourceStats.rows.map((r) => ({ source: r.source || 'unknown', count: parseInt(r.count) })),
        };

        return res.json(stats);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch namespace stats', { error });
        return next(error);
      }
    }
  );

  /**
   * GET /api/v1/admin/audit
   * Get audit log entries
   */
  router.get(
    '/audit',
    requireUserContextJwt,
    auditTenantOperation('admin.audit.view'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          namespace,
          from,
          to,
          limit = 100,
        } = req.query;
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer: Fetching audit log', {
          tenantId,
          userId,
          namespace,
          from,
          to,
        });

        // Build query for audit logs
        let whereClause = 'WHERE 1=1';
        const params: (string | Date | number)[] = [];
        let paramIndex = 1;

        if (from) {
          whereClause += ` AND created_at >= $${paramIndex}`;
          params.push(new Date(from as string));
          paramIndex++;
        }

        if (to) {
          whereClause += ` AND created_at <= $${paramIndex}`;
          params.push(new Date(to as string));
          paramIndex++;
        }

        // Try to get from dedicated audit table first
        let auditEntries: AuditLogEntry[] = [];

        try {
          const auditQuery = `
            SELECT
              id,
              created_at as timestamp,
              user_id,
              operation,
              resource_type,
              resource_id,
              details,
              ip_address
            FROM graphrag.audit_logs
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT $${paramIndex}
          `;

          params.push(parseInt(limit as string));
          const auditResult = await db.query(auditQuery, params);

          auditEntries = auditResult.rows.map((row) => ({
            id: row.id,
            timestamp: row.timestamp,
            userId: row.user_id,
            operation: row.operation,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            details: row.details,
            ip: row.ip_address,
          }));
        } catch {
          // Audit table may not exist, return empty array
          logger.debug('Audit logs table not available');
        }

        return res.json(auditEntries);
      } catch (error) {
        logger.error('Data Explorer: Failed to fetch audit log', { error });
        return next(error);
      }
    }
  );

  /**
   * GET /api/v1/admin/namespaces
   * List all namespaces (admin only)
   */
  router.get(
    '/admin/namespaces',
    requireUserContextJwt,
    auditTenantOperation('admin.namespaces.list'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer: Listing namespaces', { tenantId });

        // For security, only return the user's own namespace
        // In a multi-tenant admin scenario, this would query all namespaces
        const namespaces = [tenantId];

        return res.json(namespaces);
      } catch (error) {
        logger.error('Data Explorer: Failed to list namespaces', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // GRAPHRAG FRONTEND COMPATIBILITY ROUTES
  // These match the paths called by the frontend API client with useGraphrag: true
  // Frontend calls: /graphrag/api/entities/query, /graphrag/api/graph/export, etc.
  // ============================================================================

  /**
   * POST /entities/query
   * Frontend compatibility route for entity listing
   * Frontend sends POST with body params instead of GET with query params
   */
  router.post(
    '/entities/query',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          type,
          search,
          limit = 50,
          offset = 0,
          sortBy = 'created_at',
          sortOrder = 'desc',
        } = req.body;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer (frontend compat): Fetching entities via POST', {
          tenantId,
          type,
          search,
          limit,
          offset,
        });

        // Build query with filters (universal_entities table)
        let whereClause = 'WHERE 1=1';
        const params: (string | number)[] = [];
        let paramIndex = 1;

        if (type) {
          whereClause += ` AND entity_type = $${paramIndex}`;
          params.push(type as string);
          paramIndex++;
        }

        if (search) {
          whereClause += ` AND (text_content ILIKE $${paramIndex} OR CAST(metadata AS TEXT) ILIKE $${paramIndex})`;
          params.push(`%${search}%`);
          paramIndex++;
        }

        // Validate sort column
        const validSortColumns = ['created_at', 'updated_at', 'entity_type', 'confidence'];
        const safeSort = validSortColumns.includes(sortBy as string) ? sortBy : 'created_at';
        const safeOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM graphrag.universal_entities ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Get entities
        const entityQuery = `
          SELECT
            id,
            COALESCE(text_content, entity_type || ' ' || SUBSTRING(id::text, 1, 8)) as name,
            entity_type,
            domain,
            structured_data,
            metadata,
            confidence,
            created_at,
            updated_at
          FROM graphrag.universal_entities
          ${whereClause}
          ORDER BY ${safeSort} ${safeOrder} NULLS LAST
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        params.push(parseInt(String(limit)), parseInt(String(offset)));
        const entityResult = await db.query(entityQuery, params);

        const entities = entityResult.rows.map((row) => ({
          id: row.id,
          namespace: tenantId,
          name: row.name,
          type: row.entity_type,
          domain: row.domain,
          attributes: row.structured_data || row.metadata || {},
          version: 1,
          validAt: row.created_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          centrality: row.confidence || 0.5,
          degree: 0,
          memoryIds: [],
        }));

        return res.json({
          data: entities,
          pagination: {
            total,
            limit: parseInt(String(limit)),
            offset: parseInt(String(offset)),
            hasMore: parseInt(String(offset)) + entities.length < total,
          },
        });
      } catch (error) {
        logger.error('Data Explorer (frontend compat): Failed to fetch entities', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /graph/export
   * Frontend compatibility route for graph visualization
   * Same as POST /graph but at /graph/export path
   */
  router.post(
    '/graph/export',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { depth = 2, rootEntityId, filters: _filters } = req.body;
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer (frontend compat): Fetching graph data via /graph/export', {
          tenantId,
          userId,
          depth,
          rootEntityId,
        });

        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        const communities: Community[] = [];

        // Query entities from PostgreSQL (universal_entities table)
        const entityQuery = rootEntityId
          ? `
            SELECT
              e.id,
              COALESCE(e.text_content, e.entity_type || ' ' || SUBSTRING(e.id::text, 1, 8)) as name,
              e.entity_type,
              e.domain,
              e.structured_data,
              e.metadata,
              e.confidence,
              e.created_at,
              e.updated_at,
              COUNT(DISTINCT r.id) as relationship_count
            FROM graphrag.universal_entities e
            LEFT JOIN graphrag.entity_relationships r
              ON e.id = r.source_entity_id OR e.id = r.target_entity_id
            WHERE e.id = $1 OR r.source_entity_id = $1 OR r.target_entity_id = $1
            GROUP BY e.id
            ORDER BY e.confidence DESC NULLS LAST
            LIMIT 200
          `
          : `
            SELECT
              e.id,
              COALESCE(e.text_content, e.entity_type || ' ' || SUBSTRING(e.id::text, 1, 8)) as name,
              e.entity_type,
              e.domain,
              e.structured_data,
              e.metadata,
              e.confidence,
              e.created_at,
              e.updated_at,
              COUNT(DISTINCT r.id) as relationship_count
            FROM graphrag.universal_entities e
            LEFT JOIN graphrag.entity_relationships r
              ON e.id = r.source_entity_id OR e.id = r.target_entity_id
            GROUP BY e.id
            ORDER BY e.confidence DESC NULLS LAST
            LIMIT 200
          `;

        const entityParams = rootEntityId ? [rootEntityId] : [];
        const entityResult = await db.query(entityQuery, entityParams);

        // Transform entities to graph nodes
        for (const row of entityResult.rows) {
          const confidence = row.confidence || 0.5;
          nodes.push({
            id: row.id,
            label: row.name || row.id,
            type: row.entity_type || 'concept',
            size: Math.max(8, Math.min(30, confidence * 40)),
            color: getEntityColor(row.entity_type || 'concept'),
            centrality: confidence,
            degree: parseInt(row.relationship_count) || 0,
            data: {
              domain: row.domain,
              structuredData: row.structured_data,
              metadata: row.metadata,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
          });
        }

        // Query relationships for edges
        if (nodes.length > 0) {
          const nodeIds = nodes.map((n) => n.id);
          const relationshipQuery = `
            SELECT
              id,
              source_entity_id,
              target_entity_id,
              relationship_type,
              weight,
              metadata
            FROM graphrag.entity_relationships
            WHERE source_entity_id = ANY($1)
              AND target_entity_id = ANY($1)
            LIMIT 500
          `;

          const relationshipResult = await db.query(relationshipQuery, [nodeIds]);

          for (const row of relationshipResult.rows) {
            edges.push({
              id: row.id,
              source: row.source_entity_id,
              target: row.target_entity_id,
              type: row.relationship_type || 'related_to',
              weight: row.weight || 1,
              label: row.relationship_type,
            });
          }
        }

        // Query communities if available
        try {
          const communityQuery = `
            SELECT
              id,
              name,
              description,
              level,
              parent_id,
              member_count,
              keywords
            FROM graphrag.communities
            ORDER BY level, member_count DESC
            LIMIT 50
          `;

          const communityResult = await db.query(communityQuery);
          for (const row of communityResult.rows) {
            communities.push({
              id: row.id,
              name: row.name || `Community ${row.id.slice(0, 8)}`,
              description: row.description,
              nodeIds: [], // Community table doesn't track individual node IDs
              nodeCount: row.member_count || 0,
              level: row.level || 0,
              parentId: row.parent_id,
              childIds: [],
              cohesion: 0,
              separation: 0,
              modularity: 0,
              color: getEntityColor('concept'),
              centroid: { x: 0, y: 0 },
              keywords: row.keywords || [],
            });
          }
        } catch {
          // Communities table may not exist - generate from entity types with node IDs
          try {
            const fallbackQuery = `
              SELECT entity_type, COUNT(*) as count, ARRAY_AGG(id::text) as node_ids
              FROM graphrag.universal_entities
              GROUP BY entity_type
              ORDER BY count DESC
              LIMIT 20
            `;
            const fallbackResult = await db.query(fallbackQuery);
            for (const row of fallbackResult.rows) {
              communities.push({
                id: `type-${row.entity_type || 'unknown'}`,
                name: (row.entity_type || 'Unknown').charAt(0).toUpperCase() + (row.entity_type || 'unknown').slice(1),
                description: `Entities of type: ${row.entity_type}`,
                nodeIds: row.node_ids || [],
                nodeCount: parseInt(row.count),
                level: 0,
                childIds: [],
                cohesion: 0,
                separation: 0,
                modularity: 0,
                color: getEntityColor(row.entity_type || 'concept'),
                centroid: { x: 0, y: 0 },
              });
            }
          } catch (fallbackError) {
            logger.debug('Could not generate communities fallback', { error: fallbackError });
          }
        }

        const response: GraphResponse = {
          nodes,
          edges,
          communities,
          metadata: {
            totalNodes: nodes.length,
            totalEdges: edges.length,
            communityCount: communities.length,
            maxDepth: depth,
          },
        };

        return res.json(response);
      } catch (error) {
        logger.error('Data Explorer (frontend compat): Failed to fetch graph data', { error });
        return next(error);
      }
    }
  );

  /**
   * GET /graph/communities
   * Frontend compatibility route for communities
   * Same as GET /communities but at /graph/communities path
   */
  router.get(
    '/graph/communities',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { level } = req.query;
        const { tenantId } = req.tenantContext!;

        logger.info('Data Explorer (frontend compat): Fetching communities via /graph/communities', { tenantId, level });

        // First try to get communities from dedicated table
        let communities: Community[] = [];

        try {
          const communityQuery = `
            SELECT
              id,
              name,
              description,
              level,
              parent_id,
              member_count,
              keywords,
              created_at
            FROM graphrag.communities
            ${level !== undefined ? 'WHERE level = $1' : ''}
            ORDER BY member_count DESC
            LIMIT 100
          `;

          const params = level !== undefined ? [parseInt(level as string)] : [];
          const result = await db.query(communityQuery, params);

          communities = result.rows.map((row) => ({
            id: row.id,
            name: row.name || `Community ${row.id.slice(0, 8)}`,
            description: row.description,
            nodeIds: [], // Community table doesn't track individual node IDs
            nodeCount: row.member_count || 0,
            level: row.level || 0,
            parentId: row.parent_id,
            childIds: [],
            cohesion: 0,
            separation: 0,
            modularity: 0,
            color: getEntityColor('concept'),
            centroid: { x: 0, y: 0 },
            keywords: row.keywords || [],
          }));
        } catch {
          // Fallback: Generate communities from entity types with node IDs
          const fallbackQuery = `
            SELECT
              entity_type,
              COUNT(*) as count,
              ARRAY_AGG(id::text) as node_ids
            FROM graphrag.universal_entities
            GROUP BY entity_type
            ORDER BY count DESC
          `;

          const fallbackResult = await db.query(fallbackQuery);

          communities = fallbackResult.rows.map((row) => ({
            id: `type-${row.entity_type || 'unknown'}`,
            name: (row.entity_type || 'Unknown').charAt(0).toUpperCase() + (row.entity_type || 'unknown').slice(1),
            description: `Entities of type: ${row.entity_type}`,
            nodeIds: row.node_ids || [],
            nodeCount: parseInt(row.count),
            level: 0,
            childIds: [],
            cohesion: 0,
            separation: 0,
            modularity: 0,
            color: getEntityColor(row.entity_type || 'concept'),
            centroid: { x: 0, y: 0 },
            keywords: [row.entity_type],
          }));
        }

        return res.json(communities);
      } catch (error) {
        logger.error('Data Explorer (frontend compat): Failed to fetch communities', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /episodes/recall
   * Frontend compatibility route for episodes/timeline
   * Frontend sends POST with body params instead of GET with query params
   */
  router.post(
    '/episodes/recall',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          from,
          to,
          types,
          limit = 100,
          offset = 0,
        } = req.body;
        const { tenantId, userId } = req.tenantContext!;

        logger.info('Data Explorer (frontend compat): Fetching episodes via /episodes/recall', {
          tenantId,
          userId,
          from,
          to,
          limit,
        });

        // Build query with date filters (memories table)
        let whereClause = 'WHERE 1=1';
        const params: (string | number | Date)[] = [];
        let paramIndex = 1;

        if (from) {
          whereClause += ` AND created_at >= $${paramIndex}`;
          params.push(new Date(from as string));
          paramIndex++;
        }

        if (to) {
          whereClause += ` AND created_at <= $${paramIndex}`;
          params.push(new Date(to as string));
          paramIndex++;
        }

        if (types && Array.isArray(types) && types.length > 0) {
          whereClause += ` AND tags && $${paramIndex}::text[]`;
          params.push(types as unknown as string);
          paramIndex++;
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM graphrag.memories ${whereClause}`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);

        // Get episodes (memories as timeline events)
        const episodeQuery = `
          SELECT
            id,
            content,
            tags,
            metadata,
            created_at,
            updated_at
          FROM graphrag.memories
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        params.push(parseInt(String(limit)), parseInt(String(offset)));
        const episodeResult = await db.query(episodeQuery, params);

        const episodes = episodeResult.rows.map((row) => ({
          id: row.id,
          content: row.content,
          type: row.tags?.[0] || 'memory',
          source: row.metadata?.source || 'unknown',
          metadata: row.metadata || {},
          timestamp: row.created_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        return res.json({
          data: episodes,
          pagination: {
            total,
            limit: parseInt(String(limit)),
            offset: parseInt(String(offset)),
            hasMore: parseInt(String(offset)) + episodes.length < total,
          },
        });
      } catch (error) {
        logger.error('Data Explorer (frontend compat): Failed to fetch episodes', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // AI MEMORY ASSISTANT ENDPOINTS
  // ============================================================================

  /**
   * GET /api/v1/data-explorer/ai/health
   * Health check for AI service availability
   */
  router.get(
    '/ai/health',
    requireUserContextJwt,
    async (_req: Request, res: Response, _next: NextFunction) => {
      try {
        // Check if OpenRouter is configured
        if (!openRouterApiKey) {
          return res.json({
            status: 'degraded',
            message: 'AI service not configured - OpenRouter API key missing',
          });
        }

        // Simple health check - verify we can make requests
        return res.json({
          status: 'ok',
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('AI health check failed', { error });
        return res.json({
          status: 'down',
          message: 'AI service health check failed',
        });
      }
    }
  );

  /**
   * GET /api/v1/data-explorer/ai/models
   * List available AI models for chat
   */
  router.get(
    '/ai/models',
    requireUserContextJwt,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        // Return curated list of recommended models
        // These are the models we recommend for memory chat
        const models = [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Claude Sonnet 4',
            provider: 'Anthropic',
            available: !!openRouterApiKey,
          },
          {
            id: 'anthropic/claude-opus-4.5',
            name: 'Claude Opus 4.5',
            provider: 'Anthropic',
            available: !!openRouterApiKey,
          },
          {
            id: 'anthropic/claude-3.5-haiku',
            name: 'Claude 3.5 Haiku',
            provider: 'Anthropic',
            available: !!openRouterApiKey,
          },
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            provider: 'OpenAI',
            available: !!openRouterApiKey,
          },
          {
            id: 'openai/gpt-4o-mini',
            name: 'GPT-4o Mini',
            provider: 'OpenAI',
            available: !!openRouterApiKey,
          },
          {
            id: 'google/gemini-2.0-flash-thinking-exp',
            name: 'Gemini 2.0 Flash Thinking',
            provider: 'Google',
            available: !!openRouterApiKey,
          },
        ];

        return res.json({ models });
      } catch (error) {
        logger.error('Failed to fetch AI models', { error });
        return next(error);
      }
    }
  );

  /**
   * POST /api/v1/data-explorer/ai/chat
   * Chat with AI using memory context
   * Supports SSE streaming
   */
  router.post(
    '/ai/chat',
    requireUserContextJwt,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const {
          model = 'anthropic/claude-sonnet-4',
          messages,
          context,
          sessionId,
          stream = true,
        } = req.body as {
          model?: string;
          messages: Array<{ role: string; content: string }>;
          context?: string;
          sessionId?: string;
          stream?: boolean;
        };

        const { tenantId, userId } = req.tenantContext!;

        logger.info('AI Memory Chat request', {
          tenantId,
          userId,
          model,
          messageCount: messages?.length,
          sessionId,
          stream,
        });

        if (!openRouterApiKey) {
          return res.status(503).json({
            success: false,
            error: 'AI service unavailable',
            message: 'OpenRouter API key not configured',
          });
        }

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'Messages array is required',
          });
        }

        // Build system prompt with memory context
        const systemPrompt = `You are a helpful AI assistant for Nexus Memory Explorer. You help users explore and understand their stored memories, entities, and knowledge graph data.

${context ? `## Current Context\n${context}\n` : ''}

## Instructions
- Answer questions about the user's memories and stored data
- Provide citations when referencing specific memories
- Suggest relevant follow-up questions or actions
- Be concise but thorough in your responses
- If you don't have relevant information, say so clearly

## Response Format
When citing memories, use this format: [Memory: {id}]
When suggesting actions, wrap them like: [Action: {type}|{label}|{params}]`;

        // Set up SSE if streaming
        if (stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();

          try {
            // Use fetch for streaming with OpenRouter
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${openRouterApiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dashboard.adverant.ai',
                'X-Title': 'Nexus Memory Chat',
              },
              body: JSON.stringify({
                model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  ...messages,
                ],
                stream: true,
                temperature: 0.7,
                max_tokens: 4096,
              }),
            });

            if (!response.ok) {
              const errorText = await response.text();
              logger.error('OpenRouter API error', { status: response.status, error: errorText });
              res.write(`data: ${JSON.stringify({ error: 'AI service error', details: errorText })}\n\n`);
              res.write('data: [DONE]\n\n');
              return res.end();
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const citations: Array<{ memoryId: string; relevance: number; excerpt: string }> = [];
            const actions: Array<{ type: string; label: string; params: Record<string, unknown> }> = [];

            if (reader) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') {
                      // Send citations and actions before ending
                      if (citations.length > 0) {
                        res.write(`data: ${JSON.stringify({ citations })}\n\n`);
                      }
                      if (actions.length > 0) {
                        res.write(`data: ${JSON.stringify({ actions })}\n\n`);
                      }
                      res.write('data: [DONE]\n\n');
                      return res.end();
                    }

                    try {
                      const parsed = JSON.parse(data);
                      const content = parsed.choices?.[0]?.delta?.content;
                      if (content) {
                        res.write(`data: ${JSON.stringify({ content })}\n\n`);

                        // Parse any citations or actions from the content
                        const citationMatches = content.matchAll(/\[Memory: ([^\]]+)\]/g);
                        for (const match of citationMatches) {
                          if (!citations.find(c => c.memoryId === match[1])) {
                            citations.push({
                              memoryId: match[1],
                              relevance: 0.9,
                              excerpt: 'Referenced in response',
                            });
                          }
                        }

                        const actionMatches = content.matchAll(/\[Action: ([^|]+)\|([^|]+)\|([^\]]*)\]/g);
                        for (const match of actionMatches) {
                          actions.push({
                            type: match[1],
                            label: match[2],
                            params: match[3] ? JSON.parse(match[3]) : {},
                          });
                        }
                      }
                    } catch {
                      // Ignore parse errors for incomplete chunks
                    }
                  }
                }
              }
            }

            // Ensure we end the stream
            res.write('data: [DONE]\n\n');
            return res.end();
          } catch (streamError) {
            logger.error('Streaming error', { error: streamError });
            res.write(`data: ${JSON.stringify({ error: 'Streaming error' })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
          }
        } else {
          // Non-streaming response
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterApiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://dashboard.adverant.ai',
              'X-Title': 'Nexus Memory Chat',
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                ...messages,
              ],
              stream: false,
              temperature: 0.7,
              max_tokens: 4096,
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            logger.error('OpenRouter API error', { status: response.status, error: errorText });
            return res.status(response.status).json({
              success: false,
              error: 'AI service error',
              message: errorText,
            });
          }

          const data = await response.json();
          const content = data.choices?.[0]?.message?.content || '';

          // Parse citations and actions
          const citations: Array<{ memoryId: string; relevance: number; excerpt: string }> = [];
          const actions: Array<{ type: string; label: string; params: Record<string, unknown> }> = [];

          const citationMatches = content.matchAll(/\[Memory: ([^\]]+)\]/g);
          for (const match of citationMatches) {
            citations.push({
              memoryId: match[1],
              relevance: 0.9,
              excerpt: 'Referenced in response',
            });
          }

          const actionMatches = content.matchAll(/\[Action: ([^|]+)\|([^|]+)\|([^\]]*)\]/g);
          for (const match of actionMatches) {
            try {
              actions.push({
                type: match[1],
                label: match[2],
                params: match[3] ? JSON.parse(match[3]) : {},
              });
            } catch {
              // Ignore invalid action params
            }
          }

          return res.json({
            content,
            citations,
            actions,
            sessionId: sessionId || `chat-${Date.now()}`,
            model,
          });
        }
      } catch (error) {
        logger.error('AI chat failed', { error });
        return next(error);
      }
    }
  );

  // ============================================================================
  // DOCUMENT VIEWER ROUTES (UNIVERSAL DOCUMENT VIEWER FEATURE)
  // ============================================================================

  // Mount document viewer routes under /documents
  // These routes provide the backend for the Universal Document Viewer feature
  if (voyageClient && openRouterApiKey && _neo4jDriver) {
    const documentViewerRoutes = createDocumentViewerRoutes({
      postgresPool: db,
      qdrantClient,
      neo4jDriver: _neo4jDriver,
      voyageClient,
      openRouterApiKey,
      redisCache: undefined, // TODO: pass Redis cache if available
    });

    router.use('/documents', documentViewerRoutes);
    logger.info('Document Viewer routes initialized at /api/v1/data-explorer/documents');
  } else {
    logger.warn(
      'Document Viewer routes not initialized - missing dependencies',
      {
        hasVoyageClient: !!voyageClient,
        hasOpenRouterKey: !!openRouterApiKey,
        hasNeo4jDriver: !!_neo4jDriver,
      }
    );
  }

  logger.info('Data Explorer routes initialized at /api/v1/data-explorer, /api/v1/admin, and /graphrag/api');

  return router;
}

export default createDataExplorerRoutes;
