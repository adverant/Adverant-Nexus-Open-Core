/**
 * System Verifier
 *
 * Comprehensive diagnostic tool for GraphRAG system health verification.
 * Checks all data stores (PostgreSQL, Qdrant, Neo4j, Redis) and verifies
 * proper functioning of document ingestion, memory storage, and entity management.
 *
 * Features:
 * - Database connectivity checks
 * - Data consistency verification
 * - Vector index health monitoring
 * - Relationship graph validation
 * - Ingestion pipeline metrics
 * - Issue detection and recommendations
 *
 * Usage:
 * ```typescript
 * const verifier = new SystemVerifier({
 *   postgresPool,
 *   qdrantClient,
 *   neo4jDriver,
 *   redisClient
 * });
 *
 * const report = await verifier.runFullDiagnostics();
 * ```
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import Redis from 'ioredis';
import { logger } from '../utils/logger.js';
import {
  SystemVerificationReport,
  SystemHealthStatus,
  DatabaseStatus,
  DocumentStorageReport,
  MemoryStorageReport,
  EntityStorageReport,
  RelationshipReport,
  VectorIndexHealth,
  IngestionMetrics,
  SystemIssue,
  QuickHealthCheck
} from './types.js';

export interface SystemVerifierConfig {
  postgresPool: Pool;
  qdrantClient: QdrantClient;
  neo4jDriver: neo4j.Driver;
  redisClient: Redis;
}

export class SystemVerifier {
  private postgresPool: Pool;
  private qdrantClient: QdrantClient;
  private neo4jDriver: neo4j.Driver;
  private redisClient: Redis;
  private issues: SystemIssue[] = [];
  private recommendations: string[] = [];

  constructor(config: SystemVerifierConfig) {
    this.postgresPool = config.postgresPool;
    this.qdrantClient = config.qdrantClient;
    this.neo4jDriver = config.neo4jDriver;
    this.redisClient = config.redisClient;
  }

  /**
   * Run complete system diagnostics
   */
  async runFullDiagnostics(): Promise<SystemVerificationReport> {
    logger.info('Starting comprehensive system diagnostics');
    const startTime = Date.now();

    // Reset state
    this.issues = [];
    this.recommendations = [];

    // Check database connections
    const databases = await this.verifyDatabaseConnections();

    // Verify storage systems
    const storage = {
      documents: await this.verifyDocumentStorage(),
      memories: await this.verifyMemoryStorage(),
      entities: await this.verifyEntityStorage()
    };

    // Verify relationships
    const relationships = await this.verifyRelationships();

    // Check vector indexes
    const vectorIndexes = await this.verifyVectorIndexes();

    // Get ingestion metrics
    const ingestion = await this.getIngestionMetrics();

    // Determine overall status
    const overallStatus = this.determineOverallStatus();

    const report: SystemVerificationReport = {
      timestamp: new Date().toISOString(),
      overallStatus,
      databases,
      storage,
      relationships,
      vectorIndexes,
      ingestion,
      issues: this.issues,
      recommendations: this.recommendations
    };

    const duration = Date.now() - startTime;
    logger.info('System diagnostics completed', {
      duration,
      status: overallStatus,
      issues: this.issues.length,
      recommendations: this.recommendations.length
    });

    return report;
  }

  /**
   * Quick health check (fast, essential checks only)
   */
  async quickHealthCheck(): Promise<QuickHealthCheck> {
    const services = {
      api: true, // If we're running this code, API is up
      postgresql: await this.checkPostgresHealth(),
      redis: await this.checkRedisHealth(),
      neo4j: await this.checkNeo4jHealth(),
      qdrant: await this.checkQdrantHealth()
    };

    const allHealthy = Object.values(services).every(v => v === true);
    const someUnhealthy = Object.values(services).some(v => v === false);

    let status: SystemHealthStatus;
    if (allHealthy) {
      status = SystemHealthStatus.HEALTHY;
    } else if (someUnhealthy && services.postgresql && services.qdrant) {
      status = SystemHealthStatus.DEGRADED;
    } else {
      status = SystemHealthStatus.UNHEALTHY;
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      services,
      criticalIssues: services.postgresql || services.qdrant ? 0 : 1,
      warnings: someUnhealthy ? 1 : 0
    };
  }

  /**
   * Verify database connections
   */
  private async verifyDatabaseConnections() {
    return {
      postgresql: await this.checkPostgresConnection(),
      redis: await this.checkRedisConnection(),
      neo4j: await this.checkNeo4jConnection(),
      qdrant: await this.checkQdrantConnection()
    };
  }

  /**
   * Check PostgreSQL connection
   */
  private async checkPostgresConnection(): Promise<DatabaseStatus> {
    const startTime = Date.now();
    try {
      const client = await this.postgresPool.connect();
      await client.query('SELECT 1');
      client.release();

      const latency = Date.now() - startTime;
      return { connected: true, latency };
    } catch (error) {
      this.addIssue('critical', 'PostgreSQL',
        'PostgreSQL connection failed',
        'Document and entity storage unavailable',
        'Check PostgreSQL service and connection credentials'
      );
      return {
        connected: false,
        latency: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Check Redis connection
   */
  private async checkRedisConnection(): Promise<DatabaseStatus> {
    const startTime = Date.now();
    try {
      await this.redisClient.ping();
      const latency = Date.now() - startTime;
      return { connected: true, latency };
    } catch (error) {
      this.addIssue('warning', 'Redis',
        'Redis connection failed',
        'Caching unavailable, performance degraded',
        'Check Redis service'
      );
      return {
        connected: false,
        latency: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Check Neo4j connection
   */
  private async checkNeo4jConnection(): Promise<DatabaseStatus> {
    const startTime = Date.now();
    const session = this.neo4jDriver.session();
    try {
      await session.run('RETURN 1');
      const latency = Date.now() - startTime;
      return { connected: true, latency };
    } catch (error) {
      this.addIssue('warning', 'Neo4j',
        'Neo4j connection failed',
        'Relationship graph unavailable',
        'Check Neo4j service'
      );
      return {
        connected: false,
        latency: Date.now() - startTime,
        error: (error as Error).message
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Check Qdrant connection
   */
  private async checkQdrantConnection(): Promise<DatabaseStatus> {
    const startTime = Date.now();
    try {
      await this.qdrantClient.getCollections();
      const latency = Date.now() - startTime;
      return { connected: true, latency };
    } catch (error) {
      this.addIssue('critical', 'Qdrant',
        'Qdrant connection failed',
        'Vector search unavailable',
        'Check Qdrant service'
      );
      return {
        connected: false,
        latency: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Health check methods (faster, no latency measurement)
   */
  private async checkPostgresHealth(): Promise<boolean> {
    try {
      const client = await this.postgresPool.connect();
      await client.query('SELECT 1');
      client.release();
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedisHealth(): Promise<boolean> {
    try {
      await this.redisClient.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async checkNeo4jHealth(): Promise<boolean> {
    const session = this.neo4jDriver.session();
    try {
      await session.run('RETURN 1');
      return true;
    } catch {
      return false;
    } finally {
      await session.close();
    }
  }

  private async checkQdrantHealth(): Promise<boolean> {
    try {
      await this.qdrantClient.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Verify document storage (GraphRAGStorageEngine)
   */
  private async verifyDocumentStorage(): Promise<DocumentStorageReport> {
    const client = await this.postgresPool.connect();
    try {
      // PostgreSQL counts (only full documents and metadata, NOT chunks)
      const documents = await this.countRows(client, 'graphrag.documents');
      const documentSummaries = await this.countRows(client, 'graphrag.document_summaries');
      const documentOutlines = await this.countRows(client, 'graphrag.document_outlines');
      const searchIndex = await this.countRows(client, 'graphrag.search_index');

      // Qdrant collections (chunks are stored here, NOT in PostgreSQL)
      const chunksCollection = await this.getQdrantCollectionInfo('chunks');
      const documentsCollection = await this.getQdrantCollectionInfo('documents');

      // Neo4j counts
      const neo4jData = await this.getNeo4jDocumentCounts();

      // Validate document storage
      // NOTE: Chunks are stored in Qdrant, not PostgreSQL
      if (documents > 0 && chunksCollection.pointCount === 0) {
        this.addIssue('critical', 'Document Storage',
          `${documents} documents but no chunk vectors in Qdrant`,
          'Vector search will not work',
          'Verify embedding generation and Qdrant storage'
        );
      }

      // Check Neo4j sync
      if (documents > 0 && neo4jData.documentNodes === 0) {
        this.addIssue('critical', 'Document Storage',
          `${documents} documents in PostgreSQL but 0 in Neo4j graph`,
          'Graph relationships unavailable',
          'Verify Neo4j storage pipeline'
        );
      }

      return {
        postgresql: {
          documents,
          documentSummaries,
          documentOutlines,
          searchIndex
        },
        qdrant: {
          chunksCollection,
          documentsCollection
        },
        neo4j: neo4jData
      };

    } finally {
      client.release();
    }
  }

  /**
   * Verify memory storage (UnifiedStorageEngine)
   */
  private async verifyMemoryStorage(): Promise<MemoryStorageReport> {
    const client = await this.postgresPool.connect();
    try {
      // PostgreSQL counts
      const unifiedContent = await this.countRows(client, 'graphrag.unified_content');
      const memories = await this.countRowsWhere(
        client,
        'graphrag.unified_content',
        "content_type = 'memory'"
      );

      // Qdrant collection
      const unifiedContentCollection = await this.getQdrantCollectionInfo('unified_content');

      // Neo4j counts
      const session = this.neo4jDriver.session();
      let memoryNodes = 0;
      let episodeNodes = 0;

      try {
        const memoryResult = await session.run('MATCH (m:Memory) RETURN count(m) as count');
        memoryNodes = memoryResult.records[0]?.get('count').toNumber() || 0;

        const episodeResult = await session.run('MATCH (e:Episode) RETURN count(e) as count');
        episodeNodes = episodeResult.records[0]?.get('count').toNumber() || 0;
      } finally {
        await session.close();
      }

      return {
        postgresql: {
          unifiedContent,
          memories
        },
        qdrant: {
          unifiedContentCollection
        },
        neo4j: {
          memoryNodes,
          episodeNodes
        }
      };

    } finally {
      client.release();
    }
  }

  /**
   * Verify entity storage
   */
  private async verifyEntityStorage(): Promise<EntityStorageReport> {
    const client = await this.postgresPool.connect();
    try {
      // Total entities
      const universalEntities = await this.countRows(client, 'graphrag.universal_entities');

      // Entities by domain
      const domainResult = await client.query(`
        SELECT domain, COUNT(*) as count
        FROM graphrag.universal_entities
        GROUP BY domain
      `);
      const entitiesByDomain: Record<string, number> = {};
      domainResult.rows.forEach(row => {
        entitiesByDomain[row.domain] = parseInt(row.count);
      });

      // Entities by type
      const typeResult = await client.query(`
        SELECT entity_type, COUNT(*) as count
        FROM graphrag.universal_entities
        GROUP BY entity_type
      `);
      const entitiesByType: Record<string, number> = {};
      typeResult.rows.forEach(row => {
        entitiesByType[row.entity_type] = parseInt(row.count);
      });

      // Neo4j entity nodes
      const session = this.neo4jDriver.session();
      let entityNodes = 0;
      let entityRelationships = 0;

      try {
        const nodeResult = await session.run('MATCH (e:Entity) RETURN count(e) as count');
        entityNodes = nodeResult.records[0]?.get('count').toNumber() || 0;

        const relResult = await session.run('MATCH ()-[r:ENTITY_RELATIONSHIP]->() RETURN count(r) as count');
        entityRelationships = relResult.records[0]?.get('count').toNumber() || 0;
      } finally {
        await session.close();
      }

      // Validate entity storage
      if (universalEntities > 0 && entityNodes === 0) {
        this.addIssue('info', 'Entity Storage',
          `${universalEntities} entities in PostgreSQL but 0 in Neo4j`,
          'Entity graph traversal unavailable',
          'Entities may not be linked in Neo4j graph'
        );
      }

      return {
        postgresql: {
          universalEntities,
          entitiesByDomain,
          entitiesByType
        },
        neo4j: {
          entityNodes,
          entityRelationships
        }
      };

    } finally {
      client.release();
    }
  }

  /**
   * Verify Neo4j relationships
   */
  private async verifyRelationships(): Promise<RelationshipReport> {
    const session = this.neo4jDriver.session();
    try {
      // Total relationships
      const totalResult = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
      const totalRelationships = totalResult.records[0]?.get('count').toNumber() || 0;

      // Relationships by type
      const typeResult = await session.run(`
        MATCH ()-[r]->()
        RETURN type(r) as relType, count(r) as count
        ORDER BY count DESC
      `);

      const byType: Record<string, number> = {};
      typeResult.records.forEach(record => {
        byType[record.get('relType')] = record.get('count').toNumber();
      });

      // Orphaned nodes (nodes with no relationships)
      const orphanResult = await session.run(`
        MATCH (n)
        WHERE NOT (n)-[]-()
        RETURN count(n) as count
      `);
      const orphanedNodes = orphanResult.records[0]?.get('count').toNumber() || 0;

      if (orphanedNodes > 10) {
        this.addIssue('info', 'Neo4j Relationships',
          `${orphanedNodes} orphaned nodes found`,
          'Some nodes not connected in graph',
          'Review relationship creation logic'
        );
      }

      return {
        neo4j: {
          totalRelationships,
          byType,
          orphanedNodes
        }
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Verify vector indexes
   */
  private async verifyVectorIndexes(): Promise<VectorIndexHealth[]> {
    const collections = ['chunks', 'unified_content', 'documents', 'document_summaries'];
    const health: VectorIndexHealth[] = [];

    for (const collectionName of collections) {
      try {
        const collection = await this.qdrantClient.getCollection(collectionName);
        const pointCount = collection.points_count || 0;
        const indexedVectorCount = collection.indexed_vectors_count || 0;
        const indexingRatio = pointCount > 0 ? indexedVectorCount / pointCount : 0;

        let status: 'green' | 'yellow' | 'red';
        let needsOptimization = false;

        if (indexingRatio >= 0.9) {
          status = 'green';
        } else if (indexingRatio >= 0.5) {
          status = 'yellow';
          needsOptimization = true;
        } else {
          status = 'red';
          needsOptimization = true;
        }

        if (status === 'red' && pointCount > 0) {
          this.addIssue('warning', 'Vector Indexes',
            `Collection '${collectionName}' has poor indexing ratio: ${(indexingRatio * 100).toFixed(1)}%`,
            'Vector search performance degraded',
            'Run Qdrant optimization'
          );
        }

        health.push({
          collection: collectionName,
          pointCount,
          indexedVectorCount,
          indexingRatio,
          segmentCount: collection.segments_count || 0,
          status,
          needsOptimization
        });

      } catch (error) {
        // Collection doesn't exist
        health.push({
          collection: collectionName,
          pointCount: 0,
          indexedVectorCount: 0,
          indexingRatio: 0,
          segmentCount: 0,
          status: 'red',
          needsOptimization: false
        });
      }
    }

    return health;
  }

  /**
   * Get ingestion metrics
   */
  private async getIngestionMetrics(): Promise<IngestionMetrics> {
    try {
      // Get all job keys from Redis
      const jobKeys = await this.redisClient.keys('ingestion:job:*');

      let totalJobsCreated = jobKeys.length;
      let jobsCompleted = 0;
      let jobsFailed = 0;
      let jobsInProgress = 0;
      let totalFilesProcessed = 0;
      let totalFilesSucceeded = 0;
      let totalFilesFailed = 0;
      let totalProcessingTime = 0;

      for (const key of jobKeys) {
        const jobData = await this.redisClient.get(key);
        if (!jobData) continue;

        try {
          const job = JSON.parse(jobData);

          if (job.status === 'completed') {
            jobsCompleted++;
            totalProcessingTime += job.processingTime || 0;
          } else if (job.status === 'failed') {
            jobsFailed++;
          } else if (job.status === 'in_progress') {
            jobsInProgress++;
          }

          totalFilesProcessed += job.filesProcessed || 0;
          totalFilesSucceeded += job.filesSucceeded || 0;
          totalFilesFailed += job.filesFailed || 0;

        } catch {
          // Skip invalid job data
        }
      }

      const averageProcessingTime = jobsCompleted > 0 ? totalProcessingTime / jobsCompleted : 0;

      return {
        totalJobsCreated,
        jobsCompleted,
        jobsFailed,
        jobsInProgress,
        totalFilesProcessed,
        totalFilesSucceeded,
        totalFilesFailed,
        averageProcessingTime
      };

    } catch (error) {
      logger.warn('Failed to get ingestion metrics', { error: (error as Error).message });
      return {
        totalJobsCreated: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        jobsInProgress: 0,
        totalFilesProcessed: 0,
        totalFilesSucceeded: 0,
        totalFilesFailed: 0,
        averageProcessingTime: 0
      };
    }
  }

  /**
   * Helper: Count rows in table
   */
  private async countRows(client: any, table: string): Promise<number> {
    try {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.warn(`Failed to count rows in ${table}`, { error: (error as Error).message });
      return 0;
    }
  }

  /**
   * Helper: Count rows with WHERE clause
   */
  private async countRowsWhere(client: any, table: string, where: string): Promise<number> {
    try {
      const result = await client.query(`SELECT COUNT(*) as count FROM ${table} WHERE ${where}`);
      return parseInt(result.rows[0].count);
    } catch (error) {
      logger.warn(`Failed to count rows in ${table} with WHERE`, { error: (error as Error).message });
      return 0;
    }
  }

  /**
   * Helper: Get Qdrant collection info
   */
  private async getQdrantCollectionInfo(collectionName: string) {
    try {
      const collection = await this.qdrantClient.getCollection(collectionName);
      return {
        exists: true,
        pointCount: collection.points_count || 0,
        vectorsIndexed: collection.indexed_vectors_count || 0,
        status: collection.status || 'unknown'
      };
    } catch (error) {
      return {
        exists: false,
        pointCount: 0,
        vectorsIndexed: 0,
        status: 'not_found'
      };
    }
  }

  /**
   * Helper: Get Neo4j document counts
   */
  private async getNeo4jDocumentCounts() {
    const session = this.neo4jDriver.session();
    try {
      const docResult = await session.run('MATCH (d:Document) RETURN count(d) as count');
      const documentNodes = docResult.records[0]?.get('count').toNumber() || 0;

      const chunkResult = await session.run('MATCH (c:Chunk) RETURN count(c) as count');
      const chunkNodes = chunkResult.records[0]?.get('count').toNumber() || 0;

      const relationships: any = {};
      const relTypes = ['CONTAINS', 'FOLLOWS', 'SIMILAR_TO', 'PARENT_OF'];

      for (const relType of relTypes) {
        const result = await session.run(
          `MATCH ()-[r:${relType}]->() RETURN count(r) as count`
        );
        relationships[relType] = result.records[0]?.get('count').toNumber() || 0;
      }

      return {
        documentNodes,
        chunkNodes,
        relationships
      };

    } finally {
      await session.close();
    }
  }

  /**
   * Add an issue to the report
   */
  private addIssue(
    severity: 'critical' | 'warning' | 'info',
    component: string,
    message: string,
    impact: string,
    recommendation: string
  ): void {
    this.issues.push({
      severity,
      component,
      message,
      impact,
      recommendation
    });

    if (!this.recommendations.includes(recommendation)) {
      this.recommendations.push(recommendation);
    }
  }

  /**
   * Determine overall system health status
   */
  private determineOverallStatus(): SystemHealthStatus {
    const criticalIssues = this.issues.filter(i => i.severity === 'critical').length;
    const warnings = this.issues.filter(i => i.severity === 'warning').length;

    if (criticalIssues > 0) {
      return SystemHealthStatus.UNHEALTHY;
    } else if (warnings > 2) {
      return SystemHealthStatus.DEGRADED;
    } else {
      return SystemHealthStatus.HEALTHY;
    }
  }
}
