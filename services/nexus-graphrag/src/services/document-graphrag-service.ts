/**
 * Document GraphRAG Service
 *
 * Provides GraphRAG integration for the Universal Document Viewer.
 * Handles:
 * - Entity extraction and linking to documents
 * - Relationship discovery between document entities
 * - Related document discovery (via embeddings, entities, citations)
 * - Memory references to documents
 * - User-created entity annotations
 *
 * Integrates with:
 * - PostgreSQL: Entity mentions, relationships, memories
 * - Neo4j: Graph relationships
 * - Qdrant: Document similarity via embeddings
 */

import { Pool } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import {
  DocumentEntity,
  DocumentRelationship,
  RelatedDocument,
  Memory,
  EntityMention,
} from '../types';
import { logger } from '../utils/logger';

// ============================================================================
// INTERFACES
// ============================================================================

export interface DocumentGraphRAGConfig {
  postgresPool: Pool;
  qdrantClient: QdrantClient;
  neo4jDriver: neo4j.Driver;
  redisCache?: any;
}

export interface CreateEntityData {
  name: string;
  type: string;
  description?: string;
  startOffset: number;
  endOffset: number;
  matchedText: string;
  chunkId?: string;
}

export interface LinkEntityData {
  spans: Array<{
    startOffset: number;
    endOffset: number;
    matchedText: string;
    chunkId?: string;
  }>;
}

export interface RelatedDocumentMethod {
  method: 'embedding' | 'entity' | 'citation' | 'all';
  minSimilarity?: number;
  minSharedEntities?: number;
}

// ============================================================================
// DOCUMENT GRAPHRAG SERVICE
// ============================================================================

export class DocumentGraphRAGService {
  private postgresPool: Pool;
  private qdrantClient: QdrantClient;
  private neo4jDriver: neo4j.Driver;
  private redisCache?: any;

  constructor(config: DocumentGraphRAGConfig) {
    this.postgresPool = config.postgresPool;
    this.qdrantClient = config.qdrantClient;
    this.neo4jDriver = config.neo4jDriver;
    this.redisCache = config.redisCache;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ENTITY EXTRACTION & LINKING
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get entities extracted from document with text spans
   */
  async getDocumentEntities(documentId: string, tenantId: string): Promise<DocumentEntity[]> {
    try {
      // Verify document belongs to tenant
      const tenantCheck = await this.postgresPool.query(
        'SELECT id FROM graphrag.documents WHERE id = $1 AND tenant_id = $2',
        [documentId, tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      // Get entities with their mentions
      const query = `
        SELECT
          e.id as entity_id,
          e.name as entity_name,
          e.type as entity_type,
          e.metadata as entity_metadata,
          jsonb_agg(
            jsonb_build_object(
              'id', dem.id,
              'documentId', dem.document_id,
              'entityId', dem.entity_id,
              'chunkId', dem.chunk_id,
              'startOffset', dem.start_offset,
              'endOffset', dem.end_offset,
              'matchedText', dem.matched_text,
              'confidence', dem.confidence,
              'detectionMethod', dem.detection_method,
              'createdAt', dem.created_at
            )
            ORDER BY dem.start_offset
          ) as mentions
        FROM graphrag.universal_entities e
        JOIN graphrag.document_entity_mentions dem ON dem.entity_id = e.id
        WHERE dem.document_id = $1
        GROUP BY e.id, e.name, e.type, e.metadata
        ORDER BY COUNT(dem.id) DESC, e.name
      `;

      const result = await this.postgresPool.query(query, [documentId]);

      const entities: DocumentEntity[] = result.rows.map((row) => ({
        id: row.entity_id,
        name: row.entity_name,
        type: row.entity_type,
        mentions: row.mentions as EntityMention[],
        metadata: row.entity_metadata || {},
      }));

      return entities;
    } catch (error) {
      logger.error('Failed to get document entities', { error, documentId });
      throw error;
    }
  }

  /**
   * Get relationships where document entities participate
   */
  async getDocumentRelationships(documentId: string, tenantId: string): Promise<DocumentRelationship[]> {
    try {
      // Verify document belongs to tenant
      const tenantCheck = await this.postgresPool.query(
        'SELECT id FROM graphrag.documents WHERE id = $1 AND tenant_id = $2',
        [documentId, tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      const query = `
        SELECT DISTINCT
          dr.id,
          dr.source_document_id,
          dr.target_document_id,
          dr.relationship_type,
          dr.similarity_score,
          dr.shared_entity_count,
          dr.evidence_text,
          dr.detection_method,
          dr.confidence,
          dr.created_at,
          dr.created_by
        FROM graphrag.document_relationships dr
        WHERE dr.source_document_id = $1 OR dr.target_document_id = $1
        ORDER BY dr.similarity_score DESC NULLS LAST, dr.shared_entity_count DESC
      `;

      const result = await this.postgresPool.query(query, [documentId]);

      const relationships: DocumentRelationship[] = result.rows.map((row) => ({
        id: row.id,
        sourceDocumentId: row.source_document_id,
        targetDocumentId: row.target_document_id,
        relationshipType: row.relationship_type,
        similarityScore: row.similarity_score,
        sharedEntityCount: row.shared_entity_count,
        evidenceText: row.evidence_text,
        detectionMethod: row.detection_method,
        confidence: row.confidence,
        createdAt: row.created_at,
        createdBy: row.created_by,
      }));

      return relationships;
    } catch (error) {
      logger.error('Failed to get document relationships', { error, documentId });
      throw error;
    }
  }

  /**
   * Find related documents using multiple methods
   */
  async getRelatedDocuments(
    documentId: string,
    tenantId: string,
    options: RelatedDocumentMethod = { method: 'all' },
    limit: number = 10
  ): Promise<RelatedDocument[]> {
    try {
      // Verify document belongs to tenant
      const tenantCheck = await this.postgresPool.query(
        'SELECT id FROM graphrag.documents WHERE id = $1 AND tenant_id = $2',
        [documentId, tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      const { method, minSimilarity = 0.7, minSharedEntities = 2 } = options;

      let relatedDocs: RelatedDocument[] = [];

      if (method === 'entity' || method === 'all') {
        const entityRelated = await this.findRelatedByEntities(documentId, minSharedEntities, limit);
        relatedDocs = this.mergeRelatedDocuments(relatedDocs, entityRelated);
      }

      if (method === 'embedding' || method === 'all') {
        const embeddingRelated = await this.findRelatedByEmbedding(documentId, tenantId, minSimilarity, limit);
        relatedDocs = this.mergeRelatedDocuments(relatedDocs, embeddingRelated);
      }

      if (method === 'citation' || method === 'all') {
        const citationRelated = await this.findRelatedByCitation(documentId);
        relatedDocs = this.mergeRelatedDocuments(relatedDocs, citationRelated);
      }

      // Sort by similarity score and limit
      relatedDocs.sort((a, b) => b.similarityScore - a.similarityScore);

      return relatedDocs.slice(0, limit);
    } catch (error) {
      logger.error('Failed to get related documents', { error, documentId, options });
      throw error;
    }
  }

  /**
   * Get memories that reference this document
   */
  async getDocumentMemories(documentId: string, tenantId: string, limit: number = 20): Promise<Memory[]> {
    try {
      // Verify document belongs to tenant
      const tenantCheck = await this.postgresPool.query(
        'SELECT id FROM graphrag.documents WHERE id = $1 AND tenant_id = $2',
        [documentId, tenantId]
      );

      if (tenantCheck.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      // Query memories that reference this document
      // This assumes a memories table with document_id references
      const query = `
        SELECT
          m.id,
          m.content,
          m.tags,
          m.timestamp,
          m.metadata
        FROM graphrag.memories m
        WHERE m.tenant_id = $1
          AND (
            m.metadata->>'documentId' = $2
            OR m.metadata->'documentIds' ? $2
          )
        ORDER BY m.timestamp DESC
        LIMIT $3
      `;

      const result = await this.postgresPool.query(query, [tenantId, documentId, limit]);

      const memories: Memory[] = result.rows.map((row) => ({
        id: row.id,
        content: row.content,
        tags: row.tags || [],
        timestamp: row.timestamp,
        metadata: row.metadata || {},
      }));

      return memories;
    } catch (error) {
      logger.error('Failed to get document memories', { error, documentId });
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ENTITY CREATION & LINKING
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Create new entity linked to document
   */
  async createEntityFromDocument(
    documentId: string,
    tenantId: string,
    userId: string,
    entityData: CreateEntityData
  ): Promise<DocumentEntity> {
    const client = await this.postgresPool.connect();

    try {
      await client.query('BEGIN');

      // Verify document belongs to tenant
      const docCheck = await client.query(
        'SELECT id FROM graphrag.documents WHERE id = $1 AND tenant_id = $2',
        [documentId, tenantId]
      );

      if (docCheck.rows.length === 0) {
        throw new Error(`Document not found: ${documentId}`);
      }

      // Create entity
      const entityQuery = `
        INSERT INTO graphrag.universal_entities (name, type, description, tenant_id, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, type, metadata
      `;

      const entityResult = await client.query(entityQuery, [
        entityData.name,
        entityData.type,
        entityData.description,
        tenantId,
        userId,
      ]);

      const entity = entityResult.rows[0];

      // Create mention
      const mentionQuery = `
        INSERT INTO graphrag.document_entity_mentions (
          document_id, entity_id, chunk_id, start_offset, end_offset, matched_text, confidence, detection_method, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1.0, 'manual', $7)
        RETURNING id, document_id, entity_id, chunk_id, start_offset, end_offset, matched_text, confidence, detection_method, created_at
      `;

      const mentionResult = await client.query(mentionQuery, [
        documentId,
        entity.id,
        entityData.chunkId,
        entityData.startOffset,
        entityData.endOffset,
        entityData.matchedText,
        userId,
      ]);

      await client.query('COMMIT');

      const mention: EntityMention = {
        id: mentionResult.rows[0].id,
        documentId: mentionResult.rows[0].document_id,
        entityId: mentionResult.rows[0].entity_id,
        chunkId: mentionResult.rows[0].chunk_id,
        startOffset: mentionResult.rows[0].start_offset,
        endOffset: mentionResult.rows[0].end_offset,
        matchedText: mentionResult.rows[0].matched_text,
        confidence: mentionResult.rows[0].confidence,
        detectionMethod: mentionResult.rows[0].detection_method,
        createdAt: mentionResult.rows[0].created_at,
      };

      return {
        id: entity.id,
        name: entity.name,
        type: entity.type,
        mentions: [mention],
        metadata: entity.metadata || {},
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to create entity from document', { error, documentId, entityData });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Link existing entity to text spans in document
   */
  async linkEntityToDocument(
    documentId: string,
    entityId: string,
    tenantId: string,
    userId: string,
    linkData: LinkEntityData
  ): Promise<void> {
    const client = await this.postgresPool.connect();

    try {
      await client.query('BEGIN');

      // Verify document and entity belong to tenant
      const checkQuery = `
        SELECT
          (SELECT COUNT(*) FROM graphrag.documents WHERE id = $1 AND tenant_id = $2) as doc_exists,
          (SELECT COUNT(*) FROM graphrag.universal_entities WHERE id = $3 AND tenant_id = $2) as entity_exists
      `;

      const checkResult = await client.query(checkQuery, [documentId, tenantId, entityId]);

      if (checkResult.rows[0].doc_exists === '0') {
        throw new Error(`Document not found: ${documentId}`);
      }

      if (checkResult.rows[0].entity_exists === '0') {
        throw new Error(`Entity not found: ${entityId}`);
      }

      // Insert mentions
      const mentionQuery = `
        INSERT INTO graphrag.document_entity_mentions (
          document_id, entity_id, chunk_id, start_offset, end_offset, matched_text, confidence, detection_method, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1.0, 'manual', $7)
      `;

      for (const span of linkData.spans) {
        await client.query(mentionQuery, [
          documentId,
          entityId,
          span.chunkId,
          span.startOffset,
          span.endOffset,
          span.matchedText,
          userId,
        ]);
      }

      await client.query('COMMIT');

      logger.info('Linked entity to document', {
        documentId,
        entityId,
        spanCount: linkData.spans.length,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to link entity to document', { error, documentId, entityId });
      throw error;
    } finally {
      client.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPER METHODS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Find related documents by shared entities
   */
  private async findRelatedByEntities(
    documentId: string,
    minSharedEntities: number,
    limit: number
  ): Promise<RelatedDocument[]> {
    try {
      const query = `
        WITH doc_entities AS (
          SELECT DISTINCT entity_id
          FROM graphrag.document_entity_mentions
          WHERE document_id = $1
        ),
        related_docs AS (
          SELECT
            dem.document_id,
            COUNT(DISTINCT dem.entity_id) AS shared_count,
            jsonb_agg(DISTINCT jsonb_build_object(
              'id', e.id,
              'name', e.name,
              'type', e.type
            )) AS shared_entities_json
          FROM graphrag.document_entity_mentions dem
          JOIN graphrag.universal_entities e ON e.id = dem.entity_id
          WHERE dem.entity_id IN (SELECT entity_id FROM doc_entities)
            AND dem.document_id != $1
          GROUP BY dem.document_id
          HAVING COUNT(DISTINCT dem.entity_id) >= $2
        )
        SELECT
          rd.document_id,
          d.title,
          d.type,
          rd.shared_count,
          rd.shared_entities_json,
          (rd.shared_count::FLOAT / (SELECT COUNT(*) FROM doc_entities)) AS similarity_score
        FROM related_docs rd
        JOIN graphrag.documents d ON d.id = rd.document_id
        ORDER BY rd.shared_count DESC, similarity_score DESC
        LIMIT $3
      `;

      const result = await this.postgresPool.query(query, [documentId, minSharedEntities, limit]);

      return result.rows.map((row) => ({
        id: row.document_id,
        title: row.title,
        type: row.type,
        similarityScore: parseFloat(row.similarity_score),
        sharedEntityCount: parseInt(row.shared_count, 10),
        sharedEntities: row.shared_entities_json || [],
      }));
    } catch (error) {
      logger.error('Failed to find related documents by entities', { error, documentId });
      return [];
    }
  }

  /**
   * Find related documents by embedding similarity
   */
  private async findRelatedByEmbedding(
    documentId: string,
    tenantId: string,
    minSimilarity: number,
    limit: number
  ): Promise<RelatedDocument[]> {
    try {
      const collectionName = `tenant_${tenantId}_documents`;

      // Get document's average embedding (from its chunks)
      const chunksQuery = `
        SELECT id FROM graphrag.document_chunks WHERE document_id = $1 LIMIT 5
      `;

      const chunksResult = await this.postgresPool.query(chunksQuery, [documentId]);
      const chunkIds = chunksResult.rows.map((r) => r.id);

      if (chunkIds.length === 0) {
        return [];
      }

      // Get embeddings from Qdrant
      const points = await this.qdrantClient.retrieve(collectionName, {
        ids: chunkIds,
        with_vector: true,
      });

      if (points.length === 0 || !points[0].vector) {
        return [];
      }

      // Use first chunk's vector as representative
      const docVector = points[0].vector as number[];

      // Search for similar documents
      const searchResult = await this.qdrantClient.search(collectionName, {
        vector: docVector,
        limit: limit + 10,
        score_threshold: minSimilarity,
        with_payload: true,
      });

      // Group by document_id and get highest score
      const docScores = new Map<string, number>();

      for (const result of searchResult) {
        const payload = result.payload as any;
        const docId = payload.document_id;

        if (docId === documentId) continue;

        const currentScore = docScores.get(docId) || 0;
        if (result.score > currentScore) {
          docScores.set(docId, result.score);
        }
      }

      // Get document details
      const relatedDocIds = Array.from(docScores.keys()).slice(0, limit);

      if (relatedDocIds.length === 0) {
        return [];
      }

      const docsQuery = `
        SELECT id, title, type
        FROM graphrag.documents
        WHERE id = ANY($1)
      `;

      const docsResult = await this.postgresPool.query(docsQuery, [relatedDocIds]);

      return docsResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        similarityScore: docScores.get(row.id) || 0,
        sharedEntityCount: 0,
        sharedEntities: [],
      }));
    } catch (error) {
      logger.error('Failed to find related documents by embedding', { error, documentId });
      return [];
    }
  }

  /**
   * Find related documents by citation relationships
   */
  private async findRelatedByCitation(documentId: string): Promise<RelatedDocument[]> {
    try {
      const query = `
        SELECT
          d.id,
          d.title,
          d.type,
          dr.similarity_score,
          dr.shared_entity_count
        FROM graphrag.document_relationships dr
        JOIN graphrag.documents d ON (
          CASE
            WHEN dr.source_document_id = $1 THEN d.id = dr.target_document_id
            ELSE d.id = dr.source_document_id
          END
        )
        WHERE (dr.source_document_id = $1 OR dr.target_document_id = $1)
          AND dr.relationship_type IN ('cites', 'cited_by', 'references')
        ORDER BY dr.confidence DESC
      `;

      const result = await this.postgresPool.query(query, [documentId]);

      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        similarityScore: row.similarity_score || 0.5,
        sharedEntityCount: row.shared_entity_count || 0,
        sharedEntities: [],
      }));
    } catch (error) {
      logger.error('Failed to find related documents by citation', { error, documentId });
      return [];
    }
  }

  /**
   * Merge related document results from multiple methods
   */
  private mergeRelatedDocuments(
    existing: RelatedDocument[],
    newDocs: RelatedDocument[]
  ): RelatedDocument[] {
    const docMap = new Map<string, RelatedDocument>();

    // Add existing documents
    for (const doc of existing) {
      docMap.set(doc.id, doc);
    }

    // Merge or add new documents
    for (const doc of newDocs) {
      const existingDoc = docMap.get(doc.id);

      if (existingDoc) {
        // Merge: take max similarity, sum shared entities
        existingDoc.similarityScore = Math.max(existingDoc.similarityScore, doc.similarityScore);
        existingDoc.sharedEntityCount += doc.sharedEntityCount;

        // Merge shared entities (dedup by id)
        const entityIds = new Set(existingDoc.sharedEntities.map((e) => e.id));
        for (const entity of doc.sharedEntities) {
          if (!entityIds.has(entity.id)) {
            existingDoc.sharedEntities.push(entity);
          }
        }
      } else {
        docMap.set(doc.id, doc);
      }
    }

    return Array.from(docMap.values());
  }
}
