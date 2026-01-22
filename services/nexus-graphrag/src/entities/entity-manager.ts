/**
 * Universal Entity Manager
 * Handles CRUD operations for universal entities with unlimited storage
 * Supports hierarchical queries, bi-temporal tracking, and cross-domain relationships
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { toPostgresArray } from '../utils/postgres-helpers';
import {
  UniversalEntity,
  CreateUniversalEntityRequest,
  UpdateUniversalEntityRequest,
  CreateEntityRelationshipRequest,
  EntityRelationship,
  UniversalEntityQuery,
  UniversalEntityQueryResult,
  HierarchyQueryResult,
  HierarchyNode,
  CrossDomainQuery,
  CrossDomainQueryResult,
  BulkCreateEntitiesRequest,
  BulkCreateEntitiesResult,
} from './universal-entity';
import {
  PostgreSQLErrorParser,
  ValidationError,
  EntityNotFoundError,
} from '../utils/database-errors';

export class EntityManager {
  private postgresPool: Pool;

  constructor(postgresPool: Pool) {
    this.postgresPool = postgresPool;
    logger.info('Entity Manager initialized');
  }

  /**
   * Valid domains for Universal Entity System
   * These match the PostgreSQL CHECK constraint
   */
  private static readonly VALID_DOMAINS = [
    'creative_writing', 'code', 'medical', 'legal', 'conversation',
    'general', 'research', 'business', 'education', 'technical'
  ] as const;

  /**
   * Create a new universal entity (NO SIZE LIMITS)
   *
   * Implements comprehensive validation and error handling:
   * - Pre-validates domain before database call
   * - Parses PostgreSQL errors for detailed feedback
   * - Provides actionable error messages with suggestions
   */
  async create(request: CreateUniversalEntityRequest): Promise<UniversalEntity> {
    try {
      // Pre-validation: Domain
      if (!EntityManager.VALID_DOMAINS.includes(request.domain as any)) {
        throw new ValidationError(
          `Invalid domain: "${request.domain}". Must be one of: ${EntityManager.VALID_DOMAINS.join(', ')}.`,
          {
            domain: request.domain,
            validDomains: EntityManager.VALID_DOMAINS,
            hint: 'Use one of the predefined domain categories'
          }
        );
      }

      // Pre-validation: Content
      if (!request.textContent && !request.codeContent && !request.structuredData &&
          !request.imageUrl && !request.fileUrl) {
        throw new ValidationError(
          'At least one content field must be provided (textContent, codeContent, structuredData, imageUrl, or fileUrl)',
          {
            provided: Object.keys(request),
            hint: 'Entities must have content to be stored'
          }
        );
      }

      // Pre-validation: Hierarchy level
      if (request.hierarchyLevel !== undefined && request.hierarchyLevel < 0) {
        throw new ValidationError(
          `Invalid hierarchy level: ${request.hierarchyLevel}. Must be >= 0.`,
          {
            hierarchyLevel: request.hierarchyLevel,
            hint: 'Hierarchy level must be a non-negative integer'
          }
        );
      }

      // Pre-validation: Confidence
      if (request.confidence !== undefined && (request.confidence < 0 || request.confidence > 1)) {
        throw new ValidationError(
          `Invalid confidence score: ${request.confidence}. Must be between 0 and 1.`,
          {
            confidence: request.confidence,
            hint: 'Confidence must be a decimal between 0.0 and 1.0'
          }
        );
      }

      const query = `
        INSERT INTO graphrag.universal_entities (
          domain, entity_type, hierarchy_level, parent_id,
          story_time_valid_from, story_time_valid_until,
          text_content, code_content, structured_data, image_url, file_url,
          current_state, confidence, metadata, tags, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        RETURNING
          id, domain, entity_type, hierarchy_level, parent_id, hierarchy_path,
          story_time_valid_from, story_time_valid_until,
          ingestion_time_valid_from, ingestion_time_valid_until,
          text_content, code_content, structured_data, image_url, file_url,
          current_state, confidence, metadata, tags,
          created_at, updated_at, created_by
      `;

      const values = [
        request.domain,
        request.entityType,
        request.hierarchyLevel || 0,
        request.parentId,
        JSON.stringify(request.storyTimeValidFrom),
        JSON.stringify(request.storyTimeValidUntil),
        request.textContent,
        request.codeContent,
        JSON.stringify(request.structuredData),
        request.imageUrl,
        request.fileUrl,
        JSON.stringify(request.currentState || {}),
        request.confidence || 1.0,
        JSON.stringify(request.metadata || {}),
        request.tags || [],
        request.createdBy
      ];

      const result = await this.postgresPool.query(query, values);
      const entity = this.mapRowToEntity(result.rows[0]);

      logger.info('Entity created', {
        id: entity.id,
        domain: entity.domain,
        entityType: entity.entityType,
        hasText: !!request.textContent,
        hasCode: !!request.codeContent,
        textLength: request.textContent?.length || 0
      });

      return entity;
    } catch (error: any) {
      // Parse PostgreSQL errors for detailed, actionable messages
      const dbError = PostgreSQLErrorParser.parse(error, {
        domain: request.domain,
        hierarchyLevel: request.hierarchyLevel,
        confidence: request.confidence
      });

      logger.error('Failed to create entity', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        request
      });

      throw dbError;
    }
  }

  /**
   * Update an existing entity (with optional versioning)
   */
  async update(request: UpdateUniversalEntityRequest): Promise<UniversalEntity> {
    try {
      // If creating new version, close current version first
      if (request.createNewVersion) {
        await this.closeCurrentVersion(request.id, request.storyTimeValidUntil);
      }

      const setClauses: string[] = [];
      const values: any[] = [];
      let paramCounter = 1;

      // Build SET clauses for provided fields
      if (request.textContent !== undefined) {
        setClauses.push(`text_content = $${paramCounter++}`);
        values.push(request.textContent);
      }

      if (request.codeContent !== undefined) {
        setClauses.push(`code_content = $${paramCounter++}`);
        values.push(request.codeContent);
      }

      if (request.structuredData !== undefined) {
        setClauses.push(`structured_data = $${paramCounter++}`);
        values.push(JSON.stringify(request.structuredData));
      }

      if (request.imageUrl !== undefined) {
        setClauses.push(`image_url = $${paramCounter++}`);
        values.push(request.imageUrl);
      }

      if (request.fileUrl !== undefined) {
        setClauses.push(`file_url = $${paramCounter++}`);
        values.push(request.fileUrl);
      }

      if (request.currentState !== undefined) {
        setClauses.push(`current_state = $${paramCounter++}`);
        values.push(JSON.stringify(request.currentState));
      }

      if (request.confidence !== undefined) {
        setClauses.push(`confidence = $${paramCounter++}`);
        values.push(request.confidence);
      }

      if (request.metadata !== undefined) {
        setClauses.push(`metadata = $${paramCounter++}`);
        values.push(JSON.stringify(request.metadata));
      }

      if (request.tags !== undefined) {
        setClauses.push(`tags = $${paramCounter++}`);
        values.push(toPostgresArray(request.tags)); // Convert JS array to PostgreSQL array format
      }

      if (setClauses.length === 0) {
        throw new Error('No fields to update');
      }

      // Always update updated_at
      setClauses.push(`updated_at = NOW()`);

      const query = `
        UPDATE graphrag.universal_entities
        SET ${setClauses.join(', ')}
        WHERE id = $${paramCounter}
        RETURNING
          id, domain, entity_type, hierarchy_level, parent_id, hierarchy_path,
          story_time_valid_from, story_time_valid_until,
          ingestion_time_valid_from, ingestion_time_valid_until,
          text_content, code_content, structured_data, image_url, file_url,
          current_state, confidence, metadata, tags,
          created_at, updated_at, created_by
      `;

      values.push(request.id);

      const result = await this.postgresPool.query(query, values);

      if (result.rows.length === 0) {
        throw new EntityNotFoundError(request.id, 'universal_entity');
      }

      const entity = this.mapRowToEntity(result.rows[0]);

      logger.info('Entity updated', {
        id: entity.id,
        newVersion: request.createNewVersion,
        fieldsUpdated: setClauses.length
      });

      return entity;
    } catch (error: any) {
      // Re-throw custom errors as-is
      if (error instanceof EntityNotFoundError || error instanceof ValidationError) {
        throw error;
      }

      // Parse PostgreSQL errors
      const dbError = PostgreSQLErrorParser.parse(error, {
        entityId: request.id,
        confidence: request.confidence
      });

      logger.error('Failed to update entity', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        request
      });

      throw dbError;
    }
  }

  /**
   * Get entity by ID
   */
  async getById(id: string): Promise<UniversalEntity | null> {
    try {
      // Simplified query to return latest version (matches getWithHierarchy behavior)
      // Removed strict NULL check to handle entities created without bi-temporal tracking
      const query = `
        SELECT
          id, domain, entity_type, hierarchy_level, parent_id, hierarchy_path,
          story_time_valid_from, story_time_valid_until,
          ingestion_time_valid_from, ingestion_time_valid_until,
          text_content, code_content, structured_data, image_url, file_url,
          current_state, confidence, metadata, tags,
          created_at, updated_at, created_by
        FROM graphrag.universal_entities
        WHERE id = $1
        ORDER BY ingestion_time_valid_from DESC
        LIMIT 1
      `;

      const result = await this.postgresPool.query(query, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error: any) {
      const dbError = PostgreSQLErrorParser.parse(error, { entityId: id });

      logger.error('Failed to get entity by ID', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        id
      });

      throw dbError;
    }
  }

  /**
   * Query entities with filters
   */
  async query(query: UniversalEntityQuery): Promise<UniversalEntityQueryResult> {
    try {
      const whereClauses: string[] = ['ingestion_time_valid_until IS NULL']; // Only current versions by default
      const values: any[] = [];
      let paramCounter = 1;

      // Domain filter
      if (query.domain) {
        if (Array.isArray(query.domain)) {
          whereClauses.push(`domain = ANY($${paramCounter++})`);
          values.push(query.domain);
        } else {
          whereClauses.push(`domain = $${paramCounter++}`);
          values.push(query.domain);
        }
      }

      // Entity type filter
      if (query.entityType) {
        if (Array.isArray(query.entityType)) {
          whereClauses.push(`entity_type = ANY($${paramCounter++})`);
          values.push(query.entityType);
        } else {
          whereClauses.push(`entity_type = $${paramCounter++}`);
          values.push(query.entityType);
        }
      }

      // Tags filter
      if (query.tags && query.tags.length > 0) {
        whereClauses.push(`tags && $${paramCounter++}`);
        values.push(toPostgresArray(query.tags)); // Convert JS array for PostgreSQL array overlap operator
      }

      // Parent filter
      if (query.parentId) {
        whereClauses.push(`parent_id = $${paramCounter++}`);
        values.push(query.parentId);
      }

      // Hierarchy level filter
      if (query.hierarchyLevel !== undefined) {
        whereClauses.push(`hierarchy_level = $${paramCounter++}`);
        values.push(query.hierarchyLevel);
      }

      // Search text
      if (query.searchText) {
        whereClauses.push(`search_vector @@ plainto_tsquery('english', $${paramCounter++})`);
        values.push(query.searchText);
      }

      // Include historical versions
      if (query.includeHistoricalVersions) {
        whereClauses[0] = '1=1'; // Remove current version filter
      }

      const whereClause = whereClauses.join(' AND ');

      // Count total
      const countQuery = `SELECT COUNT(*) as total FROM graphrag.universal_entities WHERE ${whereClause}`;
      const countResult = await this.postgresPool.query(countQuery, values);
      const total = parseInt(countResult.rows[0].total);

      // Order by
      const orderBy = query.orderBy || 'created_at';
      const orderDirection = query.orderDirection || 'desc';

      // Limit and offset
      const limit = query.limit || 50;
      const offset = query.offset || 0;

      // Get entities
      const selectQuery = `
        SELECT
          id, domain, entity_type, hierarchy_level, parent_id, hierarchy_path,
          story_time_valid_from, story_time_valid_until,
          ingestion_time_valid_from, ingestion_time_valid_until,
          text_content, code_content, structured_data, image_url, file_url,
          current_state, confidence, metadata, tags,
          created_at, updated_at, created_by
        FROM graphrag.universal_entities
        WHERE ${whereClause}
        ORDER BY ${orderBy} ${orderDirection}
        LIMIT $${paramCounter} OFFSET $${paramCounter + 1}
      `;

      const selectResult = await this.postgresPool.query(selectQuery, [...values, limit, offset]);
      const entities = selectResult.rows.map(row => this.mapRowToEntity(row));

      // Get relationships if requested
      let relationships: EntityRelationship[] | undefined;
      if (query.includeRelationships) {
        const entityIds = entities.map(e => e.id);
        if (entityIds.length > 0) {
          relationships = await this.getRelationshipsForEntities(entityIds, query.relationshipTypes);
        }
      }

      logger.debug('Entities queried', {
        total,
        returned: entities.length,
        filters: query
      });

      return {
        entities,
        relationships,
        total,
        hasMore: offset + entities.length < total
      };
    } catch (error: any) {
      const dbError = PostgreSQLErrorParser.parse(error, { query });

      logger.error('Failed to query entities', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        query
      });

      throw dbError;
    }
  }

  /**
   * Get entity with full hierarchy (all descendants)
   */
  async getWithHierarchy(entityId: string): Promise<HierarchyQueryResult> {
    try {
      const query = 'SELECT * FROM graphrag.get_entity_with_hierarchy($1)';
      const result = await this.postgresPool.query(query, [entityId]);

      const entities = result.rows.map(row => this.mapRowToEntity(row));
      const relationships = await this.getRelationshipsForEntities(entities.map(e => e.id));

      // Build hierarchy tree
      const entityMap = new Map(entities.map(e => [e.id, e]));
      const hierarchyTree = this.buildHierarchyTree(entities, relationships, entityMap);

      logger.info('Hierarchy retrieved', {
        rootId: entityId,
        totalEntities: entities.length
      });

      return {
        entities,
        relationships,
        total: entities.length,
        hasMore: false,
        hierarchyTree
      };
    } catch (error: any) {
      const dbError = PostgreSQLErrorParser.parse(error, { entityId });

      logger.error('Failed to get hierarchy', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        entityId
      });

      throw dbError;
    }
  }

  /**
   * Create entity relationship
   */
  async createRelationship(request: CreateEntityRelationshipRequest): Promise<EntityRelationship> {
    try {
      const query = `
        INSERT INTO graphrag.entity_relationships (
          source_entity_id, target_entity_id, relationship_type,
          weight, directionality, metadata, reasoning, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          id, source_entity_id, target_entity_id, relationship_type,
          weight, directionality, metadata, reasoning, created_at, created_by
      `;

      const values = [
        request.sourceEntityId,
        request.targetEntityId,
        request.relationshipType,
        request.weight || 1.0,
        request.directionality || 'directed',
        JSON.stringify(request.metadata || {}),
        request.reasoning,
        request.createdBy
      ];

      const result = await this.postgresPool.query(query, values);
      const relationship = this.mapRowToRelationship(result.rows[0]);

      logger.info('Relationship created', {
        id: relationship.id,
        type: relationship.relationshipType,
        source: request.sourceEntityId,
        target: request.targetEntityId
      });

      return relationship;
    } catch (error: any) {
      const dbError = PostgreSQLErrorParser.parse(error, {
        sourceEntityId: request.sourceEntityId,
        targetEntityId: request.targetEntityId
      });

      logger.error('Failed to create relationship', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        request
      });

      throw dbError;
    }
  }

  /**
   * Cross-domain query (find entities across multiple domains)
   */
  async crossDomainQuery(query: CrossDomainQuery): Promise<CrossDomainQueryResult> {
    try {
      // This is a simplified implementation
      // In production, you'd use semantic similarity with embeddings

      const entityQuery: UniversalEntityQuery = {
        domain: query.domains,
        entityType: query.entityTypes,
        tags: query.tags,
        searchText: query.query,
        limit: query.maxResults || 20
      };

      const result = await this.query(entityQuery);

      // Build cross-references (entities related across domains)
      const resultsWithCrossRefs = await Promise.all(
        result.entities.map(async entity => {
          const relationships = await this.getRelationshipsForEntities([entity.id]);
          const crossRefIds = relationships
            .map(r => r.sourceEntityId === entity.id ? r.targetEntityId : r.sourceEntityId)
            .filter(id => id !== entity.id);

          const crossReferences: UniversalEntity[] = [];
          for (const id of crossRefIds.slice(0, 3)) { // Limit to 3 cross-refs per entity
            const crossRef = await this.getById(id);
            if (crossRef && !query.domains.includes(crossRef.domain)) {
              crossReferences.push(crossRef);
            }
          }

          return {
            entity,
            similarity: entity.confidence, // Simplified - in production use actual similarity
            reasoning: `Found in ${entity.domain} domain matching query`,
            crossReferences
          };
        })
      );

      logger.info('Cross-domain query executed', {
        domains: query.domains,
        resultsCount: resultsWithCrossRefs.length
      });

      return {
        results: resultsWithCrossRefs,
        total: result.total
      };
    } catch (error: any) {
      const dbError = PostgreSQLErrorParser.parse(error, { query });

      logger.error('Failed to execute cross-domain query', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        query
      });

      throw dbError;
    }
  }

  /**
   * Bulk create entities and relationships
   */
  async bulkCreate(request: BulkCreateEntitiesRequest): Promise<BulkCreateEntitiesResult> {
    const client = await this.postgresPool.connect();

    try {
      await client.query('BEGIN');

      const created: Array<{ tempId?: string; entity: UniversalEntity }> = [];
      const failed: Array<{ tempId?: string; error: string }> = [];
      const entityIdMap = new Map<string, string>(); // temp ID -> real ID

      // Create entities
      for (let i = 0; i < request.entities.length; i++) {
        const entityRequest = request.entities[i];
        const tempId = `temp_${i}`;

        try {
          const entity = await this.create(entityRequest);
          created.push({ tempId, entity });
          entityIdMap.set(tempId, entity.id);
        } catch (error: any) {
          failed.push({ tempId, error: error.message });
        }
      }

      // Create relationships
      let relationshipsCreated = 0;
      if (request.relationships) {
        for (const relRequest of request.relationships) {
          try {
            // Map temp IDs to real IDs if needed
            const sourceId = relRequest.sourceEntityId.startsWith('temp_')
              ? entityIdMap.get(relRequest.sourceEntityId) || relRequest.sourceEntityId
              : relRequest.sourceEntityId;

            const targetId = relRequest.targetEntityId.startsWith('temp_')
              ? entityIdMap.get(relRequest.targetEntityId) || relRequest.targetEntityId
              : relRequest.targetEntityId;

            await this.createRelationship({
              ...relRequest,
              sourceEntityId: sourceId,
              targetEntityId: targetId
            });

            relationshipsCreated++;
          } catch (error) {
            logger.warn('Failed to create relationship in bulk operation', { error, relRequest });
          }
        }
      }

      await client.query('COMMIT');

      logger.info('Bulk create completed', {
        created: created.length,
        failed: failed.length,
        relationshipsCreated
      });

      return {
        success: failed.length === 0,
        created,
        failed,
        relationshipsCreated
      };
    } catch (error: any) {
      await client.query('ROLLBACK');

      const dbError = PostgreSQLErrorParser.parse(error, {
        entitiesCount: request.entities.length,
        relationshipsCount: request.relationships?.length || 0
      });

      logger.error('Bulk create failed', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        request
      });

      throw dbError;
    } finally {
      client.release();
    }
  }

  /**
   * Delete entity (soft delete by closing version)
   */
  async delete(entityId: string): Promise<void> {
    try {
      const query = `
        UPDATE graphrag.universal_entities
        SET ingestion_time_valid_until = NOW()
        WHERE id = $1 AND ingestion_time_valid_until IS NULL
      `;

      await this.postgresPool.query(query, [entityId]);

      logger.info('Entity deleted (soft)', { id: entityId });
    } catch (error: any) {
      const dbError = PostgreSQLErrorParser.parse(error, { entityId });

      logger.error('Failed to delete entity', {
        error: dbError.message,
        code: dbError.code,
        details: dbError.details,
        entityId
      });

      throw dbError;
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private async closeCurrentVersion(entityId: string, storyTimeValidUntil?: any): Promise<void> {
    const query = `
      UPDATE graphrag.universal_entities
      SET
        ingestion_time_valid_until = NOW(),
        story_time_valid_until = $2
      WHERE id = $1 AND ingestion_time_valid_until IS NULL
    `;

    await this.postgresPool.query(query, [entityId, JSON.stringify(storyTimeValidUntil)]);
  }

  /**
   * Query relationships for a single entity with direction filtering
   */
  async queryRelationships(
    entityId: string,
    _tenantContext: any,
    direction: 'incoming' | 'outgoing' | 'both' = 'both'
  ): Promise<EntityRelationship[]> {
    let query = `
      SELECT
        id, source_entity_id, target_entity_id, relationship_type,
        weight, directionality, metadata, reasoning, created_at, created_by
      FROM graphrag.entity_relationships
      WHERE 1=1
    `;

    const values: any[] = [];
    let paramCount = 1;

    // Apply direction filtering
    if (direction === 'incoming') {
      query += ` AND target_entity_id = $${paramCount++}`;
      values.push(entityId);
    } else if (direction === 'outgoing') {
      query += ` AND source_entity_id = $${paramCount++}`;
      values.push(entityId);
    } else {
      query += ` AND (source_entity_id = $${paramCount} OR target_entity_id = $${paramCount})`;
      values.push(entityId);
      paramCount++;
    }

    const result = await this.postgresPool.query(query, values);
    return result.rows.map(row => this.mapRowToRelationship(row));
  }

  private async getRelationshipsForEntities(
    entityIds: string[],
    types?: string[]
  ): Promise<EntityRelationship[]> {
    if (entityIds.length === 0) return [];

    let query = `
      SELECT
        id, source_entity_id, target_entity_id, relationship_type,
        weight, directionality, metadata, reasoning, created_at, created_by
      FROM graphrag.entity_relationships
      WHERE source_entity_id = ANY($1) OR target_entity_id = ANY($1)
    `;

    const values: any[] = [entityIds];

    if (types && types.length > 0) {
      query += ` AND relationship_type = ANY($2)`;
      values.push(types);
    }

    const result = await this.postgresPool.query(query, values);
    return result.rows.map(row => this.mapRowToRelationship(row));
  }

  private buildHierarchyTree(
    entities: UniversalEntity[],
    relationships: EntityRelationship[],
    entityMap: Map<string, UniversalEntity>
  ): HierarchyNode | undefined {
    // Find root entity (lowest hierarchy level)
    const root = entities.reduce((prev, curr) =>
      curr.hierarchyLevel < prev.hierarchyLevel ? curr : prev
    );

    return this.buildHierarchyNode(root, entities, relationships, entityMap);
  }

  private buildHierarchyNode(
    entity: UniversalEntity,
    allEntities: UniversalEntity[],
    allRelationships: EntityRelationship[],
    entityMap: Map<string, UniversalEntity>
  ): HierarchyNode {
    const children = allEntities.filter(e => e.parentId === entity.id);
    const relationships = allRelationships.filter(
      r => r.sourceEntityId === entity.id || r.targetEntityId === entity.id
    );

    return {
      entity,
      children: children.map(child => this.buildHierarchyNode(child, allEntities, allRelationships, entityMap)),
      relationships
    };
  }

  private mapRowToEntity(row: any): UniversalEntity {
    return {
      id: row.id,
      domain: row.domain,
      entityType: row.entity_type,
      hierarchyLevel: row.hierarchy_level,
      parentId: row.parent_id,
      hierarchyPath: row.hierarchy_path,
      storyTimeValidFrom: row.story_time_valid_from,
      storyTimeValidUntil: row.story_time_valid_until,
      ingestionTimeValidFrom: row.ingestion_time_valid_from,
      ingestionTimeValidUntil: row.ingestion_time_valid_until,
      textContent: row.text_content,
      codeContent: row.code_content,
      structuredData: row.structured_data,
      imageUrl: row.image_url,
      fileUrl: row.file_url,
      currentState: row.current_state || {},
      confidence: row.confidence,
      metadata: row.metadata || {},
      tags: row.tags || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by
    };
  }

  private mapRowToRelationship(row: any): EntityRelationship {
    return {
      id: row.id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      relationshipType: row.relationship_type,
      weight: row.weight,
      directionality: row.directionality,
      metadata: row.metadata || {},
      reasoning: row.reasoning,
      createdAt: row.created_at,
      createdBy: row.created_by
    };
  }
}
