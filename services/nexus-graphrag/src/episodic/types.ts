/**
 * Graphiti Integration Types
 * Defines interfaces for episodic memory system integration
 */

import { DocumentMetadata } from '../types';
import { EnhancedTenantContext } from '../middleware/tenant-context';

/**
 * Represents a single episodic memory unit
 */
export interface Episode {
  id: string;
  content: string;
  /** LLM-generated concise summary of the episode content (1-2 sentences) */
  summary?: string;
  timestamp: Date;
  type: 'user_query' | 'system_response' | 'document_interaction' | 'entity_mention' | 'summary';
  importance: number; // 0-1 score indicating episode importance
  decay_rate: number; // How quickly this episode loses relevance
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  source?: EpisodeSource;
  metadata: Record<string, any>;
  embedding?: number[] | null; // Vector embedding for similarity search
}

/**
 * Entity extracted from episodes
 */
export interface ExtractedEntity {
  id: string;
  name: string;
  type: 'person' | 'organization' | 'location' | 'concept' | 'technology' | 'file' | 'function' | 'temporal' | 'other';
  confidence: number;
  first_seen: Date;
  last_seen: Date;
  mention_count: number;
  salience: number; // Overall importance of this entity
  aliases?: string[];
  attributes?: Record<string, any>;
  /** Set to true when entity was merged with existing via EntityResolution */
  merged?: boolean;
  /** For temporal entities: type of temporal expression */
  temporalType?: 'date' | 'duration' | 'relative' | 'recurring';
  /** For temporal entities: normalized ISO 8601 value */
  normalizedValue?: string;
}

/**
 * Fact extracted from episodes
 */
export interface ExtractedFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  /** Human-readable content representation of the fact (e.g., "Redis is a caching solution") */
  content: string;
  confidence: number;
  source_episode_id: string;
  extracted_at: Date;
  validity_period?: {
    start: Date;
    end?: Date;
  };
}

/**
 * Source information for an episode
 */
export interface EpisodeSource {
  type: 'conversation' | 'document' | 'api_call' | 'user_feedback';
  session_id?: string;
  user_id?: string;
  document_ids?: string[];
  interaction_id?: string;
}

/**
 * Temporal edge between episodes
 */
export interface EpisodicEdge {
  id: string;
  source_episode_id: string;
  target_episode_id: string;
  type: 'temporal' | 'causal' | 'reference' | 'contradiction' | 'elaboration';
  weight: number;
  created_at: Date;
  metadata?: Record<string, any>;
}

/**
 * Configuration for Graphiti integration
 */
export interface GraphitiConfig {
  enabled: boolean;
  neo4j: {
    uri: string;
    username: string;
    password: string;
    database?: string;
  };
  embedding: {
    model: string;
    dimensions: number;
    api_key?: string;
  };
  memory: {
    max_episodes: number;
    decay_interval_hours: number;
    importance_threshold: number;
    auto_consolidation: boolean;
  };
  entity_resolution: {
    similarity_threshold: number;
    merge_strategy: 'conservative' | 'aggressive' | 'manual';
  };
  /** Optional Qdrant configuration for vector similarity search */
  qdrant?: {
    url: string;
    apiKey?: string;
    /** Collection name for episodic memories (default: 'memories') */
    collectionName?: string;
  };
}

// Type alias for neo4j driver config
export type Config = GraphitiConfig;

/**
 * Request/Response interfaces for episodic operations
 */
export interface StoreEpisodeRequest {
  content: string;
  type: Episode['type'];
  source?: EpisodeSource;
  importance?: number;
  entities?: string[]; // Optional pre-identified entities
  metadata?: Record<string, any>;
}

export interface StoreEpisodeResponse {
  episode_id: string;
  entities_extracted: ExtractedEntity[];
  facts_extracted: ExtractedFact[];
  edges_created: EpisodicEdge[];
  entities?: any[]; // Alias for entities_extracted
  facts?: any[]; // Alias for facts_extracted
  importance?: number;
  /** True if this was a duplicate episode that was not stored */
  duplicate?: boolean;
  /** Content hash used for deduplication */
  content_hash?: string;
}

/**
 * Response level for episode recall - controls token budget and data detail
 * - summary: Minimal episode data (id, timestamp, short summary < 200 chars, scores)
 * - medium: Metadata + truncated content (< 500 chars per episode)
 * - full: Complete episode with all content, entities, and relationships
 */
export type EpisodeResponseLevel = 'summary' | 'medium' | 'full';

/**
 * Token-efficient episode summary for 'summary' response level
 * Designed to fit ~10 episodes in < 4000 tokens
 */
export interface EpisodeSummary {
  id: string;
  summary: string;  // Auto-generated from content (first 200 chars with ellipsis)
  timestamp: Date;
  type: Episode['type'];
  relevance_score: number;
  decay_factor: number;
  importance: number;
  entity_count: number;  // Count only, not full entities
  has_facts: boolean;    // Boolean flag instead of full facts array
}

/**
 * Medium-detail episode for 'medium' response level
 * Includes more context than summary but still token-efficient
 */
export interface EpisodeMedium extends EpisodeSummary {
  content_preview: string;  // First 500 characters
  top_entities: string[];   // Just entity names, not full objects
  metadata_keys: string[];  // Metadata keys only, not values
}

/**
 * Configurable weights for hybrid relevance scoring
 * All weights should sum to 1.0 for normalized scores
 */
export interface HybridScoringWeights {
  /** Weight for vector/semantic similarity (0-1). Default: 0.4 */
  vector_similarity: number;
  /** Weight for entity overlap relevance (0-1). Default: 0.25 */
  entity_relevance: number;
  /** Weight for temporal recency (0-1). Default: 0.2 */
  recency_factor: number;
  /** Weight for importance/salience score (0-1). Default: 0.15 */
  importance: number;
}

/**
 * Default scoring weights for hybrid relevance calculation
 */
export const DEFAULT_SCORING_WEIGHTS: HybridScoringWeights = {
  vector_similarity: 0.4,
  entity_relevance: 0.25,
  recency_factor: 0.2,
  importance: 0.15
};

export interface RecallEpisodesRequest {
  query: string;
  time_range?: {
    start: Date;
    end: Date;
  };
  entity_filter?: string[];
  type_filter?: Episode['type'][];
  max_results?: number;
  include_decay?: boolean;
  /**
   * Response level controls token budget and detail level
   * Default: 'summary' (< 4000 tokens for 10 episodes)
   * Use 'full' only when complete episode data is required
   */
  response_level?: EpisodeResponseLevel;
  /**
   * Maximum tokens for entire response (safety limit)
   * Default: 4000 tokens (~3000 words)
   * Applies to all response levels
   */
  max_tokens?: number;
  /**
   * Custom weights for hybrid scoring algorithm
   * If not provided, uses DEFAULT_SCORING_WEIGHTS
   */
  scoring_weights?: Partial<HybridScoringWeights>;
}

/**
 * Detailed breakdown of hybrid scoring components for an episode
 */
export interface HybridScoreBreakdown {
  /** Vector/semantic similarity score (0-1) */
  vector_similarity: number;
  /** Entity overlap relevance score (0-1) */
  entity_relevance: number;
  /** Temporal recency factor (0-1, 1.0 = today, decays over time) */
  recency_factor: number;
  /** Importance/salience score (0-1) */
  importance: number;
  /** Final weighted hybrid score */
  final_score: number;
  /** Weights used for this calculation */
  weights_applied: HybridScoringWeights;
}

/**
 * Episode with full hybrid scoring information
 */
export interface ScoredEpisode extends Episode {
  relevance_score: number;
  decay_factor: number;
  connected_episodes?: Episode[];
  /** Detailed breakdown of how the score was calculated */
  score_breakdown?: HybridScoreBreakdown;
}

export interface RecallEpisodesResponse {
  /**
   * Episodes array type varies by response_level:
   * - summary: EpisodeSummary[]
   * - medium: EpisodeMedium[]
   * - full: Full Episode objects with scores
   */
  episodes: ScoredEpisode[] | EpisodeSummary[] | EpisodeMedium[];
  entities: ExtractedEntity[] | Array<{ name: string; type: string; mention_count?: number }>;  // Filtered by response level
  facts?: ExtractedFact[] | Array<{ subject: string; predicate: string; object: string; confidence: number }> | string[];  // Filtered by response level
  temporal_context?: {
    before: EpisodeSummary[];  // Always summaries to control tokens
    after: EpisodeSummary[];
  };
  totalCount: number;  // Total matching episodes in database
  returnedCount: number;  // Actual episodes returned (may be < max_results due to token limit)
  estimatedTokens: number;  // Estimated token count for this response
  responseLevel: EpisodeResponseLevel;  // Actual level returned
  tokenLimitReached: boolean;  // True if token limit caused truncation
  /** Entities extracted from the query (used for entity overlap scoring) */
  query_entities?: string[];
  /** Weights used for hybrid scoring in this response */
  scoring_weights_used?: HybridScoringWeights;
}

/**
 * Interface for the Graphiti service
 */
export interface IGraphitiService {
  // Episode management
  storeEpisode(request: StoreEpisodeRequest, tenantContext: EnhancedTenantContext): Promise<StoreEpisodeResponse>;
  recallEpisodes(request: RecallEpisodesRequest, tenantContext: EnhancedTenantContext): Promise<RecallEpisodesResponse>;
  getEpisodeById(episodeId: string, tenantContext: EnhancedTenantContext): Promise<Episode | null>;
  updateEpisodeImportance(episodeId: string, importance: number, tenantContext: EnhancedTenantContext): Promise<void>;

  // Entity management
  getEntity(entityId: string, tenantContext: EnhancedTenantContext): Promise<ExtractedEntity | null>;
  mergeEntities(entityIds: string[], tenantContext: EnhancedTenantContext): Promise<ExtractedEntity>;
  getEntityHistory(entityId: string, tenantContext: EnhancedTenantContext): Promise<Episode[]>;

  // Fact management
  getFacts(subjectOrObject: string, tenantContext: EnhancedTenantContext): Promise<ExtractedFact[]>;
  validateFact(factId: string, isValid: boolean, tenantContext: EnhancedTenantContext): Promise<void>;

  // Graph operations
  getTemporalPath(startEpisodeId: string, endEpisodeId: string, tenantContext: EnhancedTenantContext): Promise<Episode[]>;
  getCausalChain(episodeId: string, tenantContext: EnhancedTenantContext, depth?: number): Promise<Episode[]>;
  consolidateMemories(before: Date, tenantContext: EnhancedTenantContext): Promise<number>;

  // Analytics
  getMemoryStats(tenantContext: EnhancedTenantContext): Promise<{
    total_episodes: number;
    total_entities: number;
    total_facts: number;
    avg_importance: number;
    memory_health: number;
  }>;
}

/**
 * Unified memory interface combining document and episodic memory
 */
export interface UnifiedMemory {
  id: string;
  type: 'document' | 'episodic' | 'hybrid';
  content: string;
  timestamp: Date;
  source: 'graphrag' | 'graphiti' | 'both';
  document_metadata?: DocumentMetadata;
  episode_metadata?: Episode;
  relevance_score: number;
  temporal_relevance?: number;
  causal_relevance?: number;
}

/**
 * Enhanced retrieval request with episodic memory
 */
export interface EnhancedRetrievalRequest {
  query: string;
  include_episodic: boolean;
  include_documents: boolean;
  time_context?: Date;
  session_context?: string;
  user_context?: string;
  max_tokens: number;
}

/**
 * Enhanced retrieval response
 */
export interface EnhancedRetrievalResponse {
  unified_memories: UnifiedMemory[];
  episodic_context?: Episode[];
  document_context?: any[]; // From existing system
  entities_mentioned: ExtractedEntity[];
  relevant_facts: ExtractedFact[];
  suggested_followups?: string[];
}