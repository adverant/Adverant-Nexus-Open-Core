/**
 * Service Catalog Repository
 *
 * CRUD operations for service entities in the Living Service Knowledge Graph.
 * Uses the Universal Entity System to store services, capabilities, and metrics.
 */

import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import {
  ServiceEntity,
  CapabilityEntity,
  PerformanceMetricEntity,
  ServiceRegistrationRequest,
  ServiceStatus,
  PerformanceMetrics,
  InteractionRecord,
  HealthCheckResult,
} from './types.js';

/**
 * Service Catalog Repository
 */
export class ServiceCatalogRepository {
  private pool: Pool;
  private initialized = false;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Initialize the repository (ensure domain exists)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Note: In production, the 'service_catalog' domain would be added
    // via database migration. For now, we work with existing domain constraints.
    this.initialized = true;
  }

  // ============================================================================
  // SERVICE CRUD
  // ============================================================================

  /**
   * Register or update a service
   */
  async registerService(request: ServiceRegistrationRequest): Promise<ServiceEntity> {
    await this.initialize();

    const now = new Date();
    const serviceId = uuidv4();

    // Build natural language description for semantic search
    const textContent = this.buildServiceTextContent(request);

    const service: ServiceEntity = {
      id: serviceId,
      domain: 'service_catalog',
      entityType: 'service',
      hierarchyLevel: 0,
      textContent,
      structuredData: {
        name: request.name,
        version: request.version,
        description: request.description,
        status: 'active',
        endpoints: request.endpoints,
        capabilities: request.capabilities.map(c => c.name),
        queryTypes: [],
        protocols: request.protocols || ['rest'],
        authRequired: request.authRequired ?? true,
        rateLimits: request.rateLimits,
        dependencies: request.dependencies,
      },
      metadata: {
        kubernetes: request.kubernetes,
        registeredAt: now.toISOString(),
        lastUpdated: now.toISOString(),
        tags: request.tags,
      },
      createdAt: now,
      updatedAt: now,
    };

    // Check if service already exists
    const existing = await this.getServiceByName(request.name);
    if (existing) {
      // Update existing service
      return this.updateService(existing.id, request);
    }

    // Insert service entity
    await this.pool.query(
      `INSERT INTO universal_entities (
        id, domain, entity_type, hierarchy_level, text_content,
        structured_data, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        service.id,
        'technical', // Use 'technical' domain since 'service_catalog' may not exist yet
        'service',
        0,
        service.textContent,
        JSON.stringify(service.structuredData),
        JSON.stringify(service.metadata),
        service.createdAt,
        service.updatedAt,
      ]
    );

    // Register capabilities
    for (const capability of request.capabilities) {
      await this.registerCapability(service.id, capability);
    }

    return service;
  }

  /**
   * Update an existing service
   */
  async updateService(
    serviceId: string,
    request: Partial<ServiceRegistrationRequest>
  ): Promise<ServiceEntity> {
    const existing = await this.getService(serviceId);
    if (!existing) {
      throw new Error(`Service ${serviceId} not found`);
    }

    const now = new Date();
    const textContent = request.description
      ? this.buildServiceTextContent(request as ServiceRegistrationRequest)
      : existing.textContent;

    const updatedData = {
      ...existing.structuredData,
      ...(request.name && { name: request.name }),
      ...(request.version && { version: request.version }),
      ...(request.description && { description: request.description }),
      ...(request.endpoints && { endpoints: request.endpoints }),
      ...(request.protocols && { protocols: request.protocols }),
      ...(request.authRequired !== undefined && { authRequired: request.authRequired }),
      ...(request.rateLimits && { rateLimits: request.rateLimits }),
      ...(request.dependencies && { dependencies: request.dependencies }),
    };

    const updatedMetadata = {
      ...existing.metadata,
      lastUpdated: now.toISOString(),
      ...(request.kubernetes && { kubernetes: request.kubernetes }),
      ...(request.tags && { tags: request.tags }),
    };

    await this.pool.query(
      `UPDATE universal_entities
       SET text_content = $1, structured_data = $2, metadata = $3, updated_at = $4
       WHERE id = $5`,
      [textContent, JSON.stringify(updatedData), JSON.stringify(updatedMetadata), now, serviceId]
    );

    // Update capabilities if provided
    if (request.capabilities) {
      // Delete existing capabilities
      await this.pool.query(
        `DELETE FROM universal_entities WHERE parent_id = $1 AND entity_type = 'capability'`,
        [serviceId]
      );
      // Register new capabilities
      for (const capability of request.capabilities) {
        await this.registerCapability(serviceId, capability);
      }
    }

    return this.getService(serviceId) as Promise<ServiceEntity>;
  }

  /**
   * Get a service by ID
   */
  async getService(serviceId: string): Promise<ServiceEntity | null> {
    const result = await this.pool.query(
      `SELECT * FROM universal_entities WHERE id = $1 AND entity_type = 'service'`,
      [serviceId]
    );

    if (result.rows.length === 0) return null;

    return this.rowToServiceEntity(result.rows[0]);
  }

  /**
   * Get a service by name
   */
  async getServiceByName(name: string): Promise<ServiceEntity | null> {
    const result = await this.pool.query(
      `SELECT * FROM universal_entities
       WHERE entity_type = 'service'
       AND structured_data->>'name' = $1`,
      [name]
    );

    if (result.rows.length === 0) return null;

    return this.rowToServiceEntity(result.rows[0]);
  }

  /**
   * List all services
   */
  async listServices(options: {
    status?: ServiceStatus;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ services: ServiceEntity[]; total: number }> {
    const { status, limit = 50, offset = 0 } = options;

    let whereClause = `entity_type = 'service'`;
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (status) {
      whereClause += ` AND structured_data->>'status' = $${paramIndex++}`;
      params.push(status);
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) FROM universal_entities WHERE ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await this.pool.query(
      `SELECT * FROM universal_entities
       WHERE ${whereClause}
       ORDER BY updated_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    return {
      services: result.rows.map(row => this.rowToServiceEntity(row)),
      total,
    };
  }

  /**
   * Delete a service and its capabilities
   */
  async deleteService(serviceId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Delete capabilities first
      await client.query(
        `DELETE FROM universal_entities WHERE parent_id = $1`,
        [serviceId]
      );

      // Delete service
      const result = await client.query(
        `DELETE FROM universal_entities WHERE id = $1 AND entity_type = 'service'`,
        [serviceId]
      );

      await client.query('COMMIT');
      return result.rowCount > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Update service status (from health check)
   */
  async updateServiceStatus(serviceId: string, status: ServiceStatus): Promise<void> {
    const now = new Date();

    await this.pool.query(
      `UPDATE universal_entities
       SET structured_data = jsonb_set(structured_data, '{status}', $1::jsonb),
           metadata = jsonb_set(metadata, '{lastHealthCheck}', $2::jsonb),
           updated_at = $3
       WHERE id = $4 AND entity_type = 'service'`,
      [JSON.stringify(status), JSON.stringify(now.toISOString()), now, serviceId]
    );
  }

  // ============================================================================
  // CAPABILITY CRUD
  // ============================================================================

  /**
   * Register a capability for a service
   */
  async registerCapability(
    serviceId: string,
    capability: ServiceRegistrationRequest['capabilities'][0]
  ): Promise<CapabilityEntity> {
    const now = new Date();
    const capabilityId = uuidv4();

    const textContent = `${capability.name}: ${capability.description}. ` +
      `Matches queries like: ${capability.queryPatterns.join(', ')}. ` +
      `Input types: ${capability.inputTypes.join(', ')}. ` +
      `Output types: ${capability.outputTypes.join(', ')}.`;

    const entity: CapabilityEntity = {
      id: capabilityId,
      domain: 'service_catalog',
      entityType: 'capability',
      hierarchyLevel: 1,
      parentId: serviceId,
      textContent,
      structuredData: {
        name: capability.name,
        queryPatterns: capability.queryPatterns,
        inputTypes: capability.inputTypes,
        outputTypes: capability.outputTypes,
        endpoint: capability.endpoint,
        method: capability.method,
        costTier: capability.costTier || 'standard',
        estimatedDuration: capability.estimatedDuration || { minMs: 100, avgMs: 1000, maxMs: 10000 },
        examples: capability.examples,
      },
      metadata: {
        createdAt: now.toISOString(),
        lastUpdated: now.toISOString(),
        usageCount: 0,
        successRate: 1.0,
      },
      createdAt: now,
      updatedAt: now,
    };

    await this.pool.query(
      `INSERT INTO universal_entities (
        id, domain, entity_type, hierarchy_level, parent_id, text_content,
        structured_data, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entity.id,
        'technical',
        'capability',
        1,
        serviceId,
        entity.textContent,
        JSON.stringify(entity.structuredData),
        JSON.stringify(entity.metadata),
        entity.createdAt,
        entity.updatedAt,
      ]
    );

    return entity;
  }

  /**
   * Get capabilities for a service
   */
  async getCapabilities(serviceId: string): Promise<CapabilityEntity[]> {
    const result = await this.pool.query(
      `SELECT * FROM universal_entities
       WHERE parent_id = $1 AND entity_type = 'capability'
       ORDER BY created_at`,
      [serviceId]
    );

    return result.rows.map(row => this.rowToCapabilityEntity(row));
  }

  /**
   * Get all capabilities across services
   */
  async listAllCapabilities(): Promise<CapabilityEntity[]> {
    const result = await this.pool.query(
      `SELECT * FROM universal_entities
       WHERE entity_type = 'capability'
       ORDER BY updated_at DESC`
    );

    return result.rows.map(row => this.rowToCapabilityEntity(row));
  }

  // ============================================================================
  // METRICS CRUD
  // ============================================================================

  /**
   * Record a service interaction
   */
  async recordInteraction(record: InteractionRecord): Promise<void> {
    // Update capability usage stats
    await this.pool.query(
      `UPDATE universal_entities
       SET metadata = jsonb_set(
         jsonb_set(metadata, '{usageCount}',
           (COALESCE((metadata->>'usageCount')::int, 0) + 1)::text::jsonb),
         '{lastUpdated}', $1::jsonb
       )
       WHERE parent_id = (
         SELECT id FROM universal_entities
         WHERE entity_type = 'service' AND structured_data->>'name' = $2
       )
       AND entity_type = 'capability'
       AND structured_data->>'name' = $3`,
      [JSON.stringify(record.timestamp), record.serviceName, record.capabilityName]
    );

    // Store interaction in metrics table or log
    // This would typically go to a time-series database or analytics system
  }

  /**
   * Store performance metrics
   */
  async storeMetrics(
    serviceId: string,
    period: 'hourly' | 'daily' | 'weekly',
    metrics: PerformanceMetrics
  ): Promise<PerformanceMetricEntity> {
    const now = new Date();
    const metricId = uuidv4();

    const entity: PerformanceMetricEntity = {
      id: metricId,
      domain: 'service_catalog',
      entityType: 'metric',
      hierarchyLevel: 1,
      parentId: serviceId,
      structuredData: {
        period,
        timestamp: now.toISOString(),
        metrics,
      },
      createdAt: now,
      updatedAt: now,
    };

    await this.pool.query(
      `INSERT INTO universal_entities (
        id, domain, entity_type, hierarchy_level, parent_id,
        structured_data, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entity.id,
        'technical',
        'metric',
        1,
        serviceId,
        JSON.stringify(entity.structuredData),
        entity.createdAt,
        entity.updatedAt,
      ]
    );

    return entity;
  }

  /**
   * Get recent metrics for a service
   */
  async getMetrics(
    serviceId: string,
    period: 'hourly' | 'daily' | 'weekly',
    limit = 24
  ): Promise<PerformanceMetricEntity[]> {
    const result = await this.pool.query(
      `SELECT * FROM universal_entities
       WHERE parent_id = $1
       AND entity_type = 'metric'
       AND structured_data->>'period' = $2
       ORDER BY (structured_data->>'timestamp')::timestamp DESC
       LIMIT $3`,
      [serviceId, period, limit]
    );

    return result.rows.map(row => this.rowToMetricEntity(row));
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Build natural language description for semantic search
   */
  private buildServiceTextContent(request: ServiceRegistrationRequest): string {
    const capabilities = request.capabilities
      .map(c => `${c.name} (${c.description})`)
      .join('; ');

    return `${request.name} v${request.version}: ${request.description}. ` +
      `Capabilities: ${capabilities}. ` +
      `Protocols: ${request.protocols?.join(', ') || 'REST'}. ` +
      `${request.tags?.length ? `Tags: ${request.tags.join(', ')}.` : ''}`;
  }

  /**
   * Convert database row to ServiceEntity
   */
  private rowToServiceEntity(row: Record<string, unknown>): ServiceEntity {
    return {
      id: row.id as string,
      domain: 'service_catalog',
      entityType: 'service',
      hierarchyLevel: 0,
      textContent: row.text_content as string,
      structuredData: row.structured_data as ServiceEntity['structuredData'],
      metadata: row.metadata as ServiceEntity['metadata'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Convert database row to CapabilityEntity
   */
  private rowToCapabilityEntity(row: Record<string, unknown>): CapabilityEntity {
    return {
      id: row.id as string,
      domain: 'service_catalog',
      entityType: 'capability',
      hierarchyLevel: 1,
      parentId: row.parent_id as string,
      textContent: row.text_content as string,
      structuredData: row.structured_data as CapabilityEntity['structuredData'],
      metadata: row.metadata as CapabilityEntity['metadata'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Convert database row to PerformanceMetricEntity
   */
  private rowToMetricEntity(row: Record<string, unknown>): PerformanceMetricEntity {
    return {
      id: row.id as string,
      domain: 'service_catalog',
      entityType: 'metric',
      hierarchyLevel: 1,
      parentId: row.parent_id as string,
      structuredData: row.structured_data as PerformanceMetricEntity['structuredData'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

// Export singleton factory
let repositoryInstance: ServiceCatalogRepository | null = null;

export function getServiceCatalogRepository(pool: Pool): ServiceCatalogRepository {
  if (!repositoryInstance) {
    repositoryInstance = new ServiceCatalogRepository(pool);
  }
  return repositoryInstance;
}
