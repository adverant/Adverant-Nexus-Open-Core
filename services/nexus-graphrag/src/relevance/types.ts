/**
 * Relevance Tracking Types
 *
 * Type definitions for Nexus Memory Lens feature
 * Supports temporal decay, access tracking, and relevance scoring
 */

import { EnhancedTenantContext } from '../middleware/tenant-context';

// ============================================================================
// CORE RELEVANCE TYPES
// ============================================================================

/**
 * Content node with complete relevance metrics
 */
export interface RelevanceNode {
  id: string;
  contentType: 'memory' | 'document' | 'episode' | 'chunk';
  content: string;
  metadata: Record<string, any>;
  tags: string[];

  // Relevance metrics
  lastAccessed: Date;
  accessCount: number;
  stability: number; // 0-1, increases with access frequency
  retrievability: number; // 0-1, decays over time without access
  userImportance?: number; // 0-1, user-assigned importance
  aiImportance?: number; // 0-1, AI-predicted importance
  hasGraphRelationships: boolean;

  // Cached relevance score
  relevanceScoreCached?: number;
  relevanceCacheExpiresAt?: Date;

  // Standard timestamps
  createdAt: Date;
  updatedAt: Date;

  // Tenant context
  userId?: string;
  sessionId?: string;
}

/**
 * Relevance score with metadata
 */
export interface RelevanceScore {
  nodeId: string;
  score: number; // Composite score 0-1
  breakdown: {
    vectorSimilarity?: number; // 0-1
    stability: number; // 0-1
    retrievability: number; // 0-1
    userImportance: number; // 0-1 (default 0.5)
    aiImportance: number; // 0-1 (default 0.5)
    graphBoost: number; // 0 or 0.05
  };
  weights: {
    vector: number; // Default 0.30
    stability: number; // Default 0.15
    retrievability: number; // Default 0.20
    userImportance: number; // Default 0.20
    aiImportance: number; // Default 0.10
    graph: number; // Default 0.05
  };
  usedFallback: boolean; // True if no vector similarity available
  computedAt: Date;
}

/**
 * Query options for relevance-based retrieval
 */
export interface RelevanceQueryOptions {
  // Query parameters
  query?: string; // Search query text
  vectorSimilarity?: number; // Pre-computed vector similarity threshold

  // Filtering
  contentTypes?: Array<'memory' | 'document' | 'episode' | 'chunk'>;
  tags?: string[];
  minRelevanceScore?: number; // Minimum composite score (0-1)
  minRetrievability?: number; // Minimum retrievability (0-1)
  minStability?: number; // Minimum stability (0-1)

  // Sorting & pagination
  sortBy?: 'relevance' | 'lastAccessed' | 'accessCount' | 'stability' | 'retrievability' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;

  // Cache control
  useCache?: boolean; // Use cached relevance scores (default true)

  // Context
  tenantContext: EnhancedTenantContext;
}

/**
 * Result of relevance query
 */
export interface RelevanceResult {
  nodes: Array<RelevanceNode & { relevanceScore: number }>;
  total: number;
  fallbackNodeCount: number; // Count of nodes using fallback scoring
  query: {
    filters: {
      contentTypes?: string[];
      tags?: string[];
      minRelevanceScore?: number;
      minRetrievability?: number;
    };
    sort: {
      by: string;
      order: 'asc' | 'desc';
    };
    pagination: {
      limit: number;
      offset: number;
    };
  };
  executionTimeMs: number;
}

// ============================================================================
// DECAY & ACCESS TRACKING TYPES
// ============================================================================

/**
 * Decay configuration parameters
 */
export interface DecayConfig {
  // Decay rate per hour (default 0.0001)
  decayRate: number;

  // Minimum retrievability before content is considered "faded" (default 0.1)
  minRetrievability: number;

  // Stability increase per access (default 0.1)
  stabilityIncrement: number;

  // Maximum stability (default 1.0)
  maxStability: number;

  // Cache duration in seconds (default 3600 = 1 hour)
  cacheDuration: number;
}

/**
 * Access event for logging
 */
export interface AccessEvent {
  contentId: string;
  userId: string;
  sessionId?: string;
  accessType: 'retrieve' | 'view' | 'edit' | 'share';
  contextType?: 'query' | 'related' | 'manual' | 'system';
  relevanceScore?: number; // Score at time of access
  metadata?: Record<string, any>;
  accessedAt?: Date; // Defaults to NOW()
}

/**
 * Access log entry from database
 */
export interface AccessLogEntry {
  id: string;
  contentId: string;
  userId: string;
  sessionId?: string;
  accessType: 'retrieve' | 'view' | 'edit' | 'share';
  contextType?: 'query' | 'related' | 'manual' | 'system';
  relevanceScore?: number;
  accessedAt: Date;
  metadata: Record<string, any>;
}

/**
 * Stability history record
 */
export interface StabilityHistoryEntry {
  id: string;
  contentId: string;
  stability: number;
  retrievability: number;
  accessCount: number;
  lastAccessed: Date;
  recordedAt: Date;
  metadata: Record<string, any>;
}

/**
 * Result of batch stability update
 */
export interface StabilityUpdate {
  updatedCount: number;
  avgRetrievability: number;
  minRetrievability: number;
  maxRetrievability: number;
  processingTimeMs: number;
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

/**
 * Request body for POST /api/relevance/retrieve
 */
export interface RelevanceRetrieveRequest {
  query?: string;
  contentTypes?: Array<'memory' | 'document' | 'episode' | 'chunk'>;
  tags?: string[];
  minRelevanceScore?: number;
  minRetrievability?: number;
  minStability?: number;
  sortBy?: 'relevance' | 'lastAccessed' | 'accessCount' | 'stability' | 'retrievability' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  useCache?: boolean;
}

/**
 * Response for POST /api/relevance/retrieve
 */
export interface RelevanceRetrieveResponse {
  success: boolean;
  result: RelevanceResult;
  message?: string;
}

/**
 * Request body for POST /api/relevance/access
 */
export interface RecordAccessRequest {
  nodeId: string;
  accessType: 'retrieve' | 'view' | 'edit' | 'share';
  contextType?: 'query' | 'related' | 'manual' | 'system';
  relevanceScore?: number;
  metadata?: Record<string, any>;
}

/**
 * Response for POST /api/relevance/access
 */
export interface RecordAccessResponse {
  success: boolean;
  message: string;
  updatedMetrics: {
    stability: number;
    retrievability: number;
    accessCount: number;
    lastAccessed: Date;
  };
}

/**
 * Request body for PUT /api/relevance/importance/:nodeId
 */
export interface SetImportanceRequest {
  importance: number; // 0-1
}

/**
 * Response for PUT /api/relevance/importance/:nodeId
 */
export interface SetImportanceResponse {
  success: boolean;
  message: string;
  nodeId: string;
  userImportance: number;
}

/**
 * Response for GET /api/relevance/score/:nodeId
 */
export interface GetScoreResponse {
  success: boolean;
  nodeId: string;
  score: RelevanceScore;
  node: RelevanceNode;
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Relevance-specific error codes
 */
export enum RelevanceErrorCode {
  NODE_NOT_FOUND = 'NODE_NOT_FOUND',
  INVALID_RELEVANCE_SCORE = 'INVALID_RELEVANCE_SCORE',
  INVALID_IMPORTANCE_VALUE = 'INVALID_IMPORTANCE_VALUE',
  INVALID_ACCESS_TYPE = 'INVALID_ACCESS_TYPE',
  INVALID_CONTENT_TYPE = 'INVALID_CONTENT_TYPE',
  CACHE_ERROR = 'CACHE_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  MISSING_TENANT_CONTEXT = 'MISSING_TENANT_CONTEXT',
}

/**
 * Relevance error
 */
export class RelevanceError extends Error {
  constructor(
    public code: RelevanceErrorCode,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'RelevanceError';
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/**
 * Database row from unified_content with relevance fields
 */
export interface UnifiedContentRow {
  id: string;
  content_type: string;
  content: string;
  metadata: Record<string, any>;
  tags: string[];
  importance: number;
  embedding_model: string;
  embedding_generated: boolean;
  source?: string;
  user_id?: string;
  session_id?: string;
  created_at: Date;
  updated_at: Date;
  parent_id?: string;
  hierarchy_level: number;

  // Relevance fields
  last_accessed: Date;
  access_count: number;
  stability: number;
  retrievability: number;
  user_importance?: number;
  ai_importance?: number;
  has_graph_relationships: boolean;
  relevance_score_cached?: number;
  relevance_cache_expires_at?: Date;
}

/**
 * Mapper function type for converting DB rows to RelevanceNode
 */
export type RelevanceNodeMapper = (row: UnifiedContentRow) => RelevanceNode;

/**
 * Default decay configuration
 */
export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  decayRate: 0.0001,
  minRetrievability: 0.1,
  stabilityIncrement: 0.1,
  maxStability: 1.0,
  cacheDuration: 3600, // 1 hour
};

/**
 * Default relevance weights (must sum to 1.0)
 */
export const DEFAULT_RELEVANCE_WEIGHTS = {
  vector: 0.30,
  stability: 0.15,
  retrievability: 0.20,
  userImportance: 0.20,
  aiImportance: 0.10,
  graph: 0.05,
};
