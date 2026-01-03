/**
 * Types for GraphRAG System Diagnostics
 */

/**
 * Overall system health status
 */
export enum SystemHealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy'
}

/**
 * Database connection status
 */
export interface DatabaseStatus {
  connected: boolean;
  latency: number; // milliseconds
  error?: string;
}

/**
 * Document storage verification
 *
 * NOTE: Chunks are stored in Qdrant and Neo4j, NOT in PostgreSQL.
 * PostgreSQL only stores full documents, summaries, and metadata.
 */
export interface DocumentStorageReport {
  postgresql: {
    documents: number;
    // documentChunks: REMOVED - chunks are stored in Qdrant, not PostgreSQL
    documentSummaries: number;
    documentOutlines: number;
    searchIndex: number;
  };
  qdrant: {
    chunksCollection: {
      exists: boolean;
      pointCount: number; // This is where chunks are actually stored
      vectorsIndexed: number;
      status: string;
    };
    documentsCollection: {
      exists: boolean;
      pointCount: number;
      vectorsIndexed: number;
      status: string;
    };
  };
  neo4j: {
    documentNodes: number;
    chunkNodes: number; // Chunk nodes for graph relationships
    relationships: {
      CONTAINS: number;
      FOLLOWS: number;
      SIMILAR_TO: number;
      PARENT_OF: number;
    };
  };
}

/**
 * Memory storage verification
 */
export interface MemoryStorageReport {
  postgresql: {
    unifiedContent: number;
    memories: number;
  };
  qdrant: {
    unifiedContentCollection: {
      exists: boolean;
      pointCount: number;
      vectorsIndexed: number;
      status: string;
    };
  };
  neo4j: {
    memoryNodes: number;
    episodeNodes: number;
  };
}

/**
 * Entity storage verification
 */
export interface EntityStorageReport {
  postgresql: {
    universalEntities: number;
    entitiesByDomain: Record<string, number>;
    entitiesByType: Record<string, number>;
  };
  neo4j: {
    entityNodes: number;
    entityRelationships: number;
  };
}

/**
 * Relationship verification
 */
export interface RelationshipReport {
  neo4j: {
    totalRelationships: number;
    byType: Record<string, number>;
    orphanedNodes: number;
  };
}

/**
 * Vector index health
 */
export interface VectorIndexHealth {
  collection: string;
  pointCount: number;
  indexedVectorCount: number;
  indexingRatio: number;
  segmentCount: number;
  status: 'green' | 'yellow' | 'red';
  needsOptimization: boolean;
}

/**
 * Ingestion metrics
 */
export interface IngestionMetrics {
  totalJobsCreated: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsInProgress: number;
  totalFilesProcessed: number;
  totalFilesSucceeded: number;
  totalFilesFailed: number;
  averageProcessingTime: number;
}

/**
 * Complete system verification report
 */
export interface SystemVerificationReport {
  timestamp: string;
  overallStatus: SystemHealthStatus;

  databases: {
    postgresql: DatabaseStatus;
    redis: DatabaseStatus;
    neo4j: DatabaseStatus;
    qdrant: DatabaseStatus;
  };

  storage: {
    documents: DocumentStorageReport;
    memories: MemoryStorageReport;
    entities: EntityStorageReport;
  };

  relationships: RelationshipReport;

  vectorIndexes: VectorIndexHealth[];

  ingestion: IngestionMetrics;

  issues: SystemIssue[];

  recommendations: string[];
}

/**
 * System issue detected during verification
 */
export interface SystemIssue {
  severity: 'critical' | 'warning' | 'info';
  component: string;
  message: string;
  impact: string;
  recommendation: string;
}

/**
 * Quick health check result
 */
export interface QuickHealthCheck {
  status: SystemHealthStatus;
  timestamp: string;
  services: {
    api: boolean;
    postgresql: boolean;
    redis: boolean;
    neo4j: boolean;
    qdrant: boolean;
  };
  criticalIssues: number;
  warnings: number;
}
