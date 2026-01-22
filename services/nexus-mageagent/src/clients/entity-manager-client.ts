/**
 * Entity Manager Client for MageAgent
 * Provides access to GraphRAG's Universal Entity System
 * Enables agents to store work as hierarchical entities
 */

import { GraphRAGClient } from './graphrag-client';
import { logger } from '../utils/logger';
import { createDomain } from '../types/domain';

// Updated type definitions with flexible domain
export interface CreateEntityRequest {
  type: string;
  domain: string;
  content: {
    [key: string]: any;
  };
  metadata?: {
    [key: string]: any;
  };
  relationships?: Array<{
    targetId: string;
    type: string;
    weight: number;
    metadata?: Record<string, any>;
  }>;
}

export interface EntityQueryRequest {
  query: string;
  domain?: string;
  contentTypes?: string[];
  limit?: number;
  offset?: number;
  filters?: Record<string, any>;
  options?: Record<string, any>;
}

export interface SearchEntitiesRequest {
  query: string;
  domain?: string;
  limit?: number;
  filters?: Record<string, any>;
}

export interface SearchEntitiesResponse {
  items: Array<{
    id: string;
    domain: string;
    type: string;
    content: any;
    metadata: Record<string, any>;
    score?: number;
  }>;
  total: number;
}

export interface CrossDomainQueryRequest {
  query: string;
  domains: string[];
  limit?: number;
  minSimilarity?: number;
}

export interface CrossDomainQueryResponse {
  results: Array<{
    entity: any;
    domain: string;
    similarity: number;
  }>;
  total: number;
}

export class EntityManagerClient {
  constructor(private graphRAGClient: GraphRAGClient) {}

  /**
   * Create a new Universal Entity
   */
  async createEntity(request: CreateEntityRequest): Promise<{ id: string; entity: any }> {
    try {
      // Validate domain
      const validatedDomain = createDomain(request.domain);

      logger.info('Creating Universal Entity', {
        domain: validatedDomain,
        type: request.type,
        hasContent: !!request.content
      });

      // Serialize content for storage
      const contentString = typeof request.content === 'string'
        ? request.content
        : JSON.stringify(request.content);

      // Use proper entity storage endpoint
      const result = await this.graphRAGClient.storeEntity({
        domain: validatedDomain,
        type: request.type,
        entityType: request.type,
        content: contentString,
        textContent: contentString,
        metadata: {
          title: request.metadata?.title || `${request.type}_${Date.now()}`,
          format: request.metadata?.format || 'text',
          source: 'mageagent-entity-system',
          createdAt: new Date().toISOString(),
          entityType: request.type,
          entityDomain: validatedDomain,
          ...request.content,
          ...request.metadata
        },
        tags: [
          'entity',
          request.type,
          validatedDomain,
          ...(request.metadata?.tags || [])
        ]
      });

      // Store relationships if provided
      const entityId = result.entityId || result.id || result.documentId;
      if (request.relationships && request.relationships.length > 0) {
        await this.storeRelationships(entityId, request.relationships);
      }

      logger.info('Universal Entity created', {
        id: entityId,
        domain: validatedDomain,
        type: request.type
      });

      return {
        id: entityId,
        entity: {
          id: entityId,
          domain: validatedDomain,
          type: request.type,
          content: request.content,
          metadata: request.metadata
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create Universal Entity', {
        error: errorMessage,
        domain: request.domain,
        type: request.type
      });
      throw new Error(`Failed to create entity: ${errorMessage}`);
    }
  }

  /**
   * Search entities by query (IMPLEMENTED)
   */
  async searchEntities(request: SearchEntitiesRequest): Promise<SearchEntitiesResponse> {
    try {
      logger.debug('Searching Universal Entities', {
        query: request.query,
        domain: request.domain,
        limit: request.limit
      });

      // Use GraphRAG search with entity-specific filters
      const searchParams: any = {
        query: request.query,
        limit: request.limit || 20,
        offset: 0
      };

      // Add domain filter if specified
      if (request.domain) {
        searchParams.filters = {
          ...searchParams.filters,
          entityDomain: request.domain
        };
      }

      // Add custom filters
      if (request.filters) {
        searchParams.filters = {
          ...searchParams.filters,
          ...request.filters
        };
      }

      const results = await this.graphRAGClient.search(searchParams);

      // Transform results to entity format
      const items = (Array.isArray(results) ? results : []).map((item: any) => ({
        id: item.id || item.documentId || 'unknown',
        domain: item.metadata?.entityDomain || item.metadata?.custom?.entityDomain || 'general',
        type: item.metadata?.entityType || item.metadata?.custom?.entityType || 'unknown',
        content: item.content || item.metadata?.custom || {},
        metadata: item.metadata || {},
        score: item.score || item.relevance || 0
      }));

      logger.debug('Universal Entities search completed', {
        resultsCount: items.length,
        query: request.query
      });

      return {
        items,
        total: items.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to search entities', {
        error: errorMessage,
        query: request.query,
        domain: request.domain
      });
      return { items: [], total: 0 };
    }
  }

  /**
   * Query entities by criteria (uses searchEntities internally)
   */
  async queryEntities(request: EntityQueryRequest): Promise<{
    items: any[];
    memoriesCount: number;
    documentsCount: number;
  }> {
    try {
      const searchRequest: SearchEntitiesRequest = {
        query: request.query || '',
        domain: request.domain,
        limit: request.limit,
        filters: request.filters
      };

      const results = await this.searchEntities(searchRequest);

      // Count by type
      const memoriesCount = results.items.filter((item: any) =>
        item.type === 'memory' || item.metadata?.type === 'memory'
      ).length;

      const documentsCount = results.items.filter((item: any) =>
        item.type === 'document' || item.metadata?.type === 'document'
      ).length;

      return {
        items: results.items,
        memoriesCount,
        documentsCount
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to query entities', {
        error: errorMessage,
        query: request.query
      });
      return { items: [], memoriesCount: 0, documentsCount: 0 };
    }
  }

  /**
   * Cross-domain query (IMPLEMENTED)
   */
  async queryCrossDomain(request: CrossDomainQueryRequest): Promise<CrossDomainQueryResponse> {
    try {
      logger.debug('Executing cross-domain query', {
        domains: request.domains,
        query: request.query
      });

      // Search each domain in parallel
      const searchPromises = request.domains.map((domain: string) =>
        this.searchEntities({
          query: request.query,
          domain,
          limit: request.limit || 10
        })
      );

      const results = await Promise.all(searchPromises);

      // Combine and score results
      const combinedResults: Array<{
        entity: any;
        domain: string;
        similarity: number;
      }> = [];

      results.forEach((result, index) => {
        const domain = request.domains[index];
        result.items.forEach((item: any) => {
          combinedResults.push({
            entity: item,
            domain,
            similarity: item.score || 0.5
          });
        });
      });

      // Filter by minimum similarity if specified
      let filteredResults = combinedResults;
      if (request.minSimilarity !== undefined) {
        filteredResults = combinedResults.filter(
          (r: any) => r.similarity >= request.minSimilarity!
        );
      }

      // Sort by similarity descending
      filteredResults.sort((a: any, b: any) => b.similarity - a.similarity);

      // Limit results
      const limitedResults = filteredResults.slice(0, request.limit || 20);

      logger.info('Cross-domain query completed', {
        totalFound: combinedResults.length,
        afterFiltering: limitedResults.length,
        domains: request.domains
      });

      return {
        results: limitedResults,
        total: limitedResults.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to execute cross-domain query', {
        error: errorMessage,
        query: request.query,
        domains: request.domains
      });
      return { results: [], total: 0 };
    }
  }

  /**
   * Update an existing entity
   */
  async updateEntity(
    entityId: string,
    updates: Partial<CreateEntityRequest>
  ): Promise<{ success: boolean }> {
    try {
      logger.debug('Updating entity', { entityId });

      // Validate domain if provided
      if (updates.domain) {
        createDomain(updates.domain);
      }

      // Update entity using proper endpoint
      if (updates.content) {
        const contentString = typeof updates.content === 'string'
          ? updates.content
          : JSON.stringify(updates.content);

        // Create a new version of the entity
        await this.graphRAGClient.storeEntity({
          domain: updates.domain || 'general',
          type: updates.type || 'entity',
          entityType: updates.type || 'entity',
          content: contentString,
          textContent: contentString,
          parentId: entityId, // Link to original entity
          metadata: {
            title: `${entityId}_updated_${Date.now()}`,
            format: 'text',
            source: 'mageagent-entity-system',
            updatedAt: new Date().toISOString(),
            originalEntityId: entityId,
            isUpdate: true,
            entityType: updates.type,
            entityDomain: updates.domain,
            ...updates.content,
            ...updates.metadata
          },
          tags: ['entity', 'update', ...(updates.metadata?.tags || [])]
        });
      }

      logger.info('Entity updated', { entityId });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to update entity', {
        error: errorMessage,
        entityId
      });
      throw new Error(`Failed to update entity: ${errorMessage}`);
    }
  }

  /**
   * Get entity by ID
   */
  async getEntity(entityId: string): Promise<any> {
    try {
      logger.debug('Getting entity', { entityId });

      // Get document by ID
      const entity = await this.graphRAGClient.getFullDocument(entityId);

      return {
        id: entityId,
        domain: entity.metadata?.entityDomain || entity.metadata?.custom?.entityDomain || 'general',
        type: entity.metadata?.entityType || entity.metadata?.custom?.entityType || 'unknown',
        content: entity.content || entity.metadata?.custom || {},
        metadata: entity.metadata || {}
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get entity', {
        error: errorMessage,
        entityId
      });
      throw new Error(`Failed to get entity: ${errorMessage}`);
    }
  }

  /**
   * Store relationships for an entity
   */
  private async storeRelationships(
    sourceId: string,
    relationships: Array<{
      targetId: string;
      type: string;
      weight: number;
      metadata?: Record<string, any>;
    }>
  ): Promise<void> {
    try {
      // Store each relationship as a memory
      const relationshipPromises = relationships.map((rel: any) =>
        this.graphRAGClient.storeMemory({
          content: `Relationship: ${rel.type} from ${sourceId} to ${rel.targetId}`,
          tags: ['entity-relationship', rel.type],
          metadata: {
            relationshipType: 'entity-relationship',
            sourceEntityId: sourceId,
            targetEntityId: rel.targetId,
            relationshipName: rel.type,
            weight: rel.weight,
            ...rel.metadata
          }
        })
      );

      await Promise.all(relationshipPromises);

      logger.debug('Relationships stored', {
        sourceId,
        count: relationships.length
      });
    } catch (error) {
      logger.warn('Failed to store some relationships', {
        error: error instanceof Error ? error.message : String(error),
        sourceId
      });
    }
  }
}

// Factory function for singleton instance
let clientInstance: EntityManagerClient | null = null;

export function getEntityManagerClient(client: GraphRAGClient): EntityManagerClient {
  if (!clientInstance) {
    clientInstance = new EntityManagerClient(client);
  }
  return clientInstance;
}

// Export factory function instead of singleton to support multi-tenancy
// Usage: const client = getEntityManagerClient(graphRAGClient);
// where graphRAGClient is created with createGraphRAGClient(tenantContext)

// ⚠️ Legacy singleton for backward compatibility
import { graphRAGClient } from './graphrag-client';
export const entityManagerClient = new EntityManagerClient(graphRAGClient);
