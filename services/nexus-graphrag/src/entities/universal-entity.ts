/**
 * Universal Entity System Types
 * Domain-agnostic entity types that work across all domains
 * NO TOKEN LIMITS - unlimited content storage
 */

// =============================================================================
// DOMAIN AND ENTITY TYPE DEFINITIONS
// =============================================================================

export type UniversalDomain =
  | 'creative_writing'
  | 'code'
  | 'medical'
  | 'legal'
  | 'conversation'
  | 'research'
  | 'business'
  | 'education'
  | 'technical'
  | 'general';

// Domain-specific entity types
export type CreativeWritingEntityType =
  | 'series'
  | 'book'
  | 'chapter'
  | 'scene'
  | 'beat'
  | 'character'
  | 'location'
  | 'artifact'
  | 'event';

export type CodeEntityType =
  | 'repository'
  | 'module'
  | 'package'
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'variable'
  | 'constant'
  | 'type'
  | 'test'
  | 'documentation';

export type MedicalEntityType =
  | 'paper'
  | 'study'
  | 'clinical_trial'
  | 'patient_record'
  | 'diagnosis'
  | 'treatment'
  | 'medication'
  | 'procedure'
  | 'finding';

export type LegalEntityType =
  | 'case'
  | 'statute'
  | 'regulation'
  | 'precedent'
  | 'contract'
  | 'filing'
  | 'argument'
  | 'evidence';

export type ConversationEntityType =
  | 'thread'
  | 'interaction'
  | 'message'
  | 'context';

export type UniversalEntityType =
  | CreativeWritingEntityType
  | CodeEntityType
  | MedicalEntityType
  | LegalEntityType
  | ConversationEntityType
  | string; // Allow custom types

// =============================================================================
// BI-TEMPORAL TIME TRACKING
// =============================================================================

export interface BiTemporalTime {
  // For creative writing: story timeline
  // For code: version/commit timeline
  // For medical: patient timeline
  timestamp?: Date | string;
  sequence?: number; // Sequential order when timestamp not available
  chapter?: string; // For creative writing
  version?: string; // For code
  label?: string; // Human-readable label
}

// =============================================================================
// UNIVERSAL ENTITY INTERFACE
// =============================================================================

export interface UniversalEntity {
  id: string;

  // Domain classification
  domain: UniversalDomain;
  entityType: UniversalEntityType;

  // Hierarchical organization
  hierarchyLevel: number; // 0 = root, 1 = child, etc.
  parentId?: string;
  hierarchyPath?: string; // Materialized path for fast queries

  // Bi-temporal tracking
  storyTimeValidFrom?: BiTemporalTime;
  storyTimeValidUntil?: BiTemporalTime;
  ingestionTimeValidFrom: Date;
  ingestionTimeValidUntil?: Date; // null = current version

  // Multimodal content (NO SIZE LIMITS)
  textContent?: string;
  codeContent?: string;
  structuredData?: Record<string, any>;
  imageUrl?: string;
  fileUrl?: string;

  // Entity state
  currentState: Record<string, any>;
  confidence: number; // 0-1
  metadata: Record<string, any>;
  tags: string[];

  // Audit
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

// =============================================================================
// ENTITY RELATIONSHIPS
// =============================================================================

export type RelationshipType =
  | 'CONTAINS' // Parent contains child
  | 'REFERENCES' // Entity references another
  | 'SIMILAR_TO' // Semantic similarity
  | 'INSPIRED_BY' // Creative inspiration
  | 'DERIVED_FROM' // Code/content derived from
  | 'DEPENDS_ON' // Dependency relationship
  | 'PRECEDES' // Temporal ordering
  | 'FOLLOWS' // Temporal ordering
  | 'IMPLEMENTS' // Code implementation
  | 'EXTENDS' // Code extension
  | 'RELATED_TO' // Generic relation
  | string; // Allow custom types

export type RelationshipDirectionality = 'directed' | 'bidirectional' | 'undirected';

export interface EntityRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: RelationshipType;
  weight: number; // 0-1
  directionality: RelationshipDirectionality;
  metadata: Record<string, any>;
  reasoning?: string;
  createdAt: Date;
  createdBy?: string;
}

// =============================================================================
// ENTITY CREATION AND UPDATE REQUESTS
// =============================================================================

export interface CreateUniversalEntityRequest {
  domain: UniversalDomain;
  entityType: UniversalEntityType;
  hierarchyLevel?: number;
  parentId?: string;

  // Bi-temporal (optional)
  storyTimeValidFrom?: BiTemporalTime;
  storyTimeValidUntil?: BiTemporalTime;

  // Content (at least one required)
  textContent?: string;
  codeContent?: string;
  structuredData?: Record<string, any>;
  imageUrl?: string;
  fileUrl?: string;

  // Metadata
  currentState?: Record<string, any>;
  confidence?: number;
  metadata?: Record<string, any>;
  tags?: string[];
  createdBy?: string;
}

export interface UpdateUniversalEntityRequest {
  id: string;

  // Optional updates
  textContent?: string;
  codeContent?: string;
  structuredData?: Record<string, any>;
  imageUrl?: string;
  fileUrl?: string;

  currentState?: Record<string, any>;
  confidence?: number;
  metadata?: Record<string, any>;
  tags?: string[];

  // Bi-temporal update (creates new version)
  createNewVersion?: boolean;
  storyTimeValidUntil?: BiTemporalTime;
}

export interface CreateEntityRelationshipRequest {
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: RelationshipType;
  weight?: number;
  directionality?: RelationshipDirectionality;
  metadata?: Record<string, any>;
  reasoning?: string;
  createdBy?: string;
}

// =============================================================================
// QUERY AND RETRIEVAL
// =============================================================================

export interface UniversalEntityQuery {
  // Filtering
  domain?: UniversalDomain | UniversalDomain[];
  entityType?: UniversalEntityType | UniversalEntityType[];
  tags?: string[];
  parentId?: string;
  hierarchyLevel?: number;

  // Temporal filtering
  atStoryTime?: BiTemporalTime;
  atIngestionTime?: Date;
  includeHistoricalVersions?: boolean;

  // Search
  searchText?: string;
  searchFields?: ('textContent' | 'codeContent' | 'tags' | 'metadata')[];

  // Hierarchical queries
  includeChildren?: boolean;
  includeDescendants?: boolean; // All nested children
  includeAncestors?: boolean;
  maxDepth?: number;

  // Relationships
  includeRelationships?: boolean;
  relationshipTypes?: RelationshipType[];

  // Pagination and ordering
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at' | 'hierarchy_level' | 'confidence';
  orderDirection?: 'asc' | 'desc';
}

export interface UniversalEntityQueryResult {
  entities: UniversalEntity[];
  relationships?: EntityRelationship[];
  total: number;
  hasMore: boolean;
  totalCount?: number;
  hierarchy?: any;
}

export interface HierarchyQueryResult extends UniversalEntityQueryResult {
  hierarchyTree?: HierarchyNode;
}

export interface HierarchyNode {
  entity: UniversalEntity;
  children: HierarchyNode[];
  relationships: EntityRelationship[];
}

// =============================================================================
// CROSS-DOMAIN QUERIES
// =============================================================================

export interface CrossDomainQuery {
  // Find entities across multiple domains
  domains: UniversalDomain[];
  query: string; // Natural language or semantic query
  minSimilarity?: number; // 0-1
  maxResults?: number;

  // Optional filters
  entityTypes?: UniversalEntityType[];
  tags?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
}

export interface CrossDomainQueryResult {
  results: Array<{
    entity: UniversalEntity;
    similarity: number;
    reasoning: string;
    crossReferences: UniversalEntity[]; // Related entities from other domains
  }>;
  total: number;
  patterns?: any;
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

export interface BulkCreateEntitiesRequest {
  entities: CreateUniversalEntityRequest[];
  relationships?: CreateEntityRelationshipRequest[];
}

export interface BulkCreateEntitiesResult {
  success: boolean;
  created: Array<{
    tempId?: string; // Temporary ID from request
    entity: UniversalEntity;
  }>;
  failed: Array<{
    tempId?: string;
    error: string;
  }>;
  relationshipsCreated: number;
  created_count?: number;
  failed_count?: number;
  entities?: any[];
  errors?: any[];
}

// =============================================================================
// DOMAIN-SPECIFIC HELPERS
// =============================================================================

// Helper for creative writing entities
export interface CreativeWritingEntity extends Omit<UniversalEntity, 'domain' | 'entityType'> {
  domain: 'creative_writing';
  entityType: CreativeWritingEntityType;
}

// Helper for code entities
export interface CodeEntity extends Omit<UniversalEntity, 'domain' | 'entityType'> {
  domain: 'code';
  entityType: CodeEntityType;
}

// Helper for medical entities
export interface MedicalEntity extends Omit<UniversalEntity, 'domain' | 'entityType'> {
  domain: 'medical';
  entityType: MedicalEntityType;
}

// Helper for legal entities
export interface LegalEntity extends Omit<UniversalEntity, 'domain' | 'entityType'> {
  domain: 'legal';
  entityType: LegalEntityType;
}

// Helper for conversation entities
export interface ConversationEntity extends Omit<UniversalEntity, 'domain' | 'entityType'> {
  domain: 'conversation';
  entityType: ConversationEntityType;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

export function isCurrentVersion(entity: UniversalEntity): boolean {
  return entity.ingestionTimeValidUntil === undefined || entity.ingestionTimeValidUntil === null;
}

export function isValidAtStoryTime(entity: UniversalEntity, time: BiTemporalTime): boolean {
  // If no story time bounds, entity is always valid
  if (!entity.storyTimeValidFrom && !entity.storyTimeValidUntil) {
    return true;
  }

  // Simple timestamp comparison (can be extended for complex timeline logic)
  if (entity.storyTimeValidFrom && time.timestamp) {
    const validFrom = new Date(entity.storyTimeValidFrom.timestamp || 0);
    const checkTime = new Date(time.timestamp);
    if (checkTime < validFrom) return false;
  }

  if (entity.storyTimeValidUntil && time.timestamp) {
    const validUntil = new Date(entity.storyTimeValidUntil.timestamp || Infinity);
    const checkTime = new Date(time.timestamp);
    if (checkTime > validUntil) return false;
  }

  return true;
}

export function buildHierarchyPath(parentPath: string | undefined, entityId: string): string {
  if (!parentPath) {
    return `/${entityId}`;
  }
  return `${parentPath}/${entityId}`;
}

export function parseHierarchyPath(path: string): string[] {
  return path.split('/').filter(p => p.length > 0);
}
