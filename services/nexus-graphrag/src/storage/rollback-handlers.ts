/**
 * Rollback Handlers for Saga Compensating Transactions
 *
 * Provides compensating transactions to undo database operations
 * when a saga fails and needs to rollback.
 *
 * CRITICAL: These handlers MUST fully undo the forward operations
 * to maintain data consistency across databases.
 *
 * @see REMEDIATION_PLAN.md Task 2.1
 */

import { Pool, PoolClient } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import { Driver, Session } from 'neo4j-driver';
import { logger } from '../utils/logger';
import { EnhancedTenantContext } from '../middleware/tenant-context';

/**
 * Rollback Result
 */
export interface RollbackResult {
  success: boolean;
  recordsDeleted: number;
  error?: Error;
}

/**
 * Rollback Handlers Class
 *
 * Provides compensating transactions for database operations.
 * All methods are idempotent and safe to retry.
 */
export class RollbackHandlers {
  constructor(
    private readonly postgresPool: Pool,
    private readonly qdrantClient: QdrantClient | null,
    private readonly neo4jDriver: Driver | null
  ) {}

  /**
   * Rollback PostgreSQL memory insertion
   *
   * Deletes the memory record from unified_content table.
   * IDEMPOTENT: Deleting a non-existent record is safe.
   *
   * @param memoryId - ID of memory to delete
   * @param tenantContext - Tenant isolation context
   * @returns RollbackResult
   */
  async rollbackPostgres(
    memoryId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<RollbackResult> {
    const client = await this.postgresPool.connect();

    try {
      // Set tenant context for Row Level Security
      await client.query(
        'SELECT graphrag.set_tenant_context($1, $2, $3)',
        [tenantContext.companyId, tenantContext.appId, tenantContext.userId]
      );

      logger.info('[ROLLBACK] Deleting memory from PostgreSQL', {
        memoryId,
        tenantContext: {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          userId: tenantContext.userId
        }
      });

      // IDEMPOTENT DELETE: Deleting non-existent record returns 0 rows
      const result = await client.query(`
        DELETE FROM graphrag.unified_content
        WHERE id = $1
        AND content_type = 'memory'
        AND company_id = $2
        AND app_id = $3
        RETURNING id
      `, [memoryId, tenantContext.companyId, tenantContext.appId]);

      const recordsDeleted = result.rowCount || 0;

      if (recordsDeleted > 0) {
        logger.info('[ROLLBACK] Successfully deleted memory from PostgreSQL', {
          memoryId,
          recordsDeleted
        });
      } else {
        logger.warn('[ROLLBACK] Memory not found in PostgreSQL (may have been already deleted)', {
          memoryId
        });
      }

      return {
        success: true,
        recordsDeleted
      };

    } catch (error: any) {
      logger.error('[ROLLBACK] Failed to delete memory from PostgreSQL', {
        error: error.message,
        stack: error.stack,
        memoryId,
        code: error.code,
        detail: error.detail
      });

      return {
        success: false,
        recordsDeleted: 0,
        error
      };
    } finally {
      client.release();
    }
  }

  /**
   * Rollback Qdrant vector insertion
   *
   * Deletes the memory vector from unified_content collection.
   * IDEMPOTENT: Deleting a non-existent point is safe.
   *
   * @param memoryId - ID of memory vector to delete
   * @returns RollbackResult
   */
  async rollbackQdrant(memoryId: string): Promise<RollbackResult> {
    if (!this.qdrantClient) {
      logger.warn('[ROLLBACK] Qdrant client not initialized, skipping vector rollback', {
        memoryId
      });
      return {
        success: true,
        recordsDeleted: 0
      };
    }

    try {
      logger.info('[ROLLBACK] Deleting memory vector from Qdrant', {
        memoryId
      });

      // IDEMPOTENT DELETE: Deleting non-existent point is safe
      await this.qdrantClient.delete('unified_content', {
        wait: true,
        points: [memoryId]
      });

      logger.info('[ROLLBACK] Successfully deleted memory vector from Qdrant', {
        memoryId
      });

      return {
        success: true,
        recordsDeleted: 1 // Qdrant doesn't return deleted count
      };

    } catch (error: any) {
      // Check if error is "point not found" - this is OK
      if (error.status === 404 || error.message?.includes('not found')) {
        logger.warn('[ROLLBACK] Memory vector not found in Qdrant (may have been already deleted)', {
          memoryId
        });
        return {
          success: true,
          recordsDeleted: 0
        };
      }

      logger.error('[ROLLBACK] Failed to delete memory vector from Qdrant', {
        error: error.message,
        stack: error.stack,
        memoryId,
        status: error.status,
        data: error.data
      });

      return {
        success: false,
        recordsDeleted: 0,
        error
      };
    }
  }

  /**
   * Rollback Neo4j node creation
   *
   * Deletes the memory node from Neo4j graph.
   * IDEMPOTENT: Deleting a non-existent node is safe.
   *
   * @param memoryId - ID of memory node to delete
   * @param tenantContext - Tenant isolation context
   * @returns RollbackResult
   */
  async rollbackNeo4j(
    memoryId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<RollbackResult> {
    if (!this.neo4jDriver) {
      logger.warn('[ROLLBACK] Neo4j driver not initialized, skipping graph rollback', {
        memoryId
      });
      return {
        success: true,
        recordsDeleted: 0
      };
    }

    const session: Session = this.neo4jDriver.session();

    try {
      logger.info('[ROLLBACK] Deleting memory node from Neo4j', {
        memoryId,
        tenantContext: {
          companyId: tenantContext.companyId,
          appId: tenantContext.appId,
          userId: tenantContext.userId
        }
      });

      // IDEMPOTENT DELETE: MATCH returns 0 nodes if not found
      // DELETE of 0 nodes is safe
      const result = await session.run(`
        MATCH (m:Memory {
          id: $id,
          company_id: $companyId,
          app_id: $appId
        })
        DETACH DELETE m
        RETURN count(m) AS deleted
      `, {
        id: memoryId,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId
      });

      const recordsDeleted = result.records[0]?.get('deleted')?.toNumber() || 0;

      if (recordsDeleted > 0) {
        logger.info('[ROLLBACK] Successfully deleted memory node from Neo4j', {
          memoryId,
          recordsDeleted
        });
      } else {
        logger.warn('[ROLLBACK] Memory node not found in Neo4j (may have been already deleted)', {
          memoryId
        });
      }

      return {
        success: true,
        recordsDeleted
      };

    } catch (error: any) {
      logger.error('[ROLLBACK] Failed to delete memory node from Neo4j', {
        error: error.message,
        stack: error.stack,
        memoryId,
        code: error.code
      });

      return {
        success: false,
        recordsDeleted: 0,
        error
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Rollback document metadata insertion
   *
   * Used when storing large memories as documents.
   * Deletes document metadata from documents table.
   *
   * @param documentId - ID of document to delete
   * @returns RollbackResult
   */
  async rollbackDocumentMetadata(documentId: string): Promise<RollbackResult> {
    const client = await this.postgresPool.connect();

    try {
      logger.info('[ROLLBACK] Deleting document metadata from PostgreSQL', {
        documentId
      });

      // IDEMPOTENT DELETE
      const result = await client.query(`
        DELETE FROM documents
        WHERE id = $1
        RETURNING id
      `, [documentId]);

      const recordsDeleted = result.rowCount || 0;

      if (recordsDeleted > 0) {
        logger.info('[ROLLBACK] Successfully deleted document metadata', {
          documentId,
          recordsDeleted
        });
      } else {
        logger.warn('[ROLLBACK] Document metadata not found (may have been already deleted)', {
          documentId
        });
      }

      return {
        success: true,
        recordsDeleted
      };

    } catch (error: any) {
      logger.error('[ROLLBACK] Failed to delete document metadata', {
        error: error.message,
        stack: error.stack,
        documentId,
        code: error.code
      });

      return {
        success: false,
        recordsDeleted: 0,
        error
      };
    } finally {
      client.release();
    }
  }

  /**
   * Rollback document chunks
   *
   * Deletes all chunks associated with a document from Qdrant.
   *
   * @param documentId - Parent document ID
   * @param chunkIds - Array of chunk IDs to delete
   * @returns RollbackResult
   */
  async rollbackDocumentChunks(
    documentId: string,
    chunkIds: string[]
  ): Promise<RollbackResult> {
    if (!this.qdrantClient) {
      logger.warn('[ROLLBACK] Qdrant client not initialized, skipping chunk rollback', {
        documentId
      });
      return {
        success: true,
        recordsDeleted: 0
      };
    }

    if (chunkIds.length === 0) {
      logger.info('[ROLLBACK] No chunks to delete', { documentId });
      return {
        success: true,
        recordsDeleted: 0
      };
    }

    try {
      logger.info('[ROLLBACK] Deleting document chunks from Qdrant', {
        documentId,
        chunkCount: chunkIds.length
      });

      // IDEMPOTENT DELETE: Batch delete all chunks
      await this.qdrantClient.delete('unified_content', {
        wait: true,
        points: chunkIds
      });

      logger.info('[ROLLBACK] Successfully deleted document chunks from Qdrant', {
        documentId,
        chunksDeleted: chunkIds.length
      });

      return {
        success: true,
        recordsDeleted: chunkIds.length
      };

    } catch (error: any) {
      logger.error('[ROLLBACK] Failed to delete document chunks from Qdrant', {
        error: error.message,
        stack: error.stack,
        documentId,
        chunkCount: chunkIds.length,
        status: error.status
      });

      return {
        success: false,
        recordsDeleted: 0,
        error
      };
    }
  }

  /**
   * Verify rollback success
   *
   * Checks if a memory was successfully deleted from all databases.
   * Useful for post-rollback validation.
   *
   * @param memoryId - ID to verify
   * @param tenantContext - Tenant context
   * @returns Object indicating presence in each database
   */
  async verifyRollback(
    memoryId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<{
    postgres: boolean;
    qdrant: boolean;
    neo4j: boolean;
  }> {
    const verification = {
      postgres: false,
      qdrant: false,
      neo4j: false
    };

    // Check PostgreSQL
    const pgClient = await this.postgresPool.connect();
    try {
      await pgClient.query(
        'SELECT graphrag.set_tenant_context($1, $2, $3)',
        [tenantContext.companyId, tenantContext.appId, tenantContext.userId]
      );

      const pgResult = await pgClient.query(`
        SELECT id FROM graphrag.unified_content
        WHERE id = $1 AND content_type = 'memory'
      `, [memoryId]);

      verification.postgres = pgResult.rowCount! > 0;
    } catch (error: any) {
      logger.error('[ROLLBACK-VERIFY] Failed to check PostgreSQL', {
        error: error.message,
        memoryId
      });
    } finally {
      pgClient.release();
    }

    // Check Qdrant
    if (this.qdrantClient) {
      try {
        const qdrantResult = await this.qdrantClient.retrieve('unified_content', {
          ids: [memoryId],
          with_payload: false,
          with_vector: false
        });

        verification.qdrant = qdrantResult.length > 0;
      } catch (error: any) {
        // 404 means not found - that's what we want
        verification.qdrant = false;
      }
    }

    // Check Neo4j
    if (this.neo4jDriver) {
      const session = this.neo4jDriver.session();
      try {
        const neo4jResult = await session.run(`
          MATCH (m:Memory {id: $id})
          RETURN count(m) AS count
        `, { id: memoryId });

        const count = neo4jResult.records[0]?.get('count')?.toNumber() || 0;
        verification.neo4j = count > 0;
      } catch (error: any) {
        logger.error('[ROLLBACK-VERIFY] Failed to check Neo4j', {
          error: error.message,
          memoryId
        });
      } finally {
        await session.close();
      }
    }

    logger.info('[ROLLBACK-VERIFY] Rollback verification complete', {
      memoryId,
      verification,
      fullyDeleted: !verification.postgres && !verification.qdrant && !verification.neo4j
    });

    return verification;
  }
}
