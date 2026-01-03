/**
 * Collaborative Memory Service
 *
 * Phase 4: Advanced Features & Performance
 *
 * Handles:
 * - Memory sharing and permissions
 * - Memory versioning and restoration
 * - Collaborative access control
 * - Team memory management
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { EnhancedTenantContext } from '../middleware/tenant-context';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export enum MemoryScope {
  USER = 'user',
  APP = 'app',
  COMPANY = 'company',
}

export enum PermissionRole {
  READ = 'read',
  WRITE = 'write',
  ADMIN = 'admin',
}

export interface MemoryPermission {
  id: string;
  memoryId: string;
  userId: string;
  role: PermissionRole;
  grantedBy: string;
  grantedAt: Date;
  expiresAt?: Date;
}

export interface MemoryVersion {
  id: string;
  memoryId: string;
  versionNumber: number;
  content: string;
  tags?: string[];
  metadata?: any;
  changedBy: string;
  changeType: 'created' | 'updated' | 'deleted' | 'restored';
  changeSummary?: string;
  createdAt: Date;
}

export interface ShareMemoryRequest {
  memoryId: string;
  userId: string;
  role: PermissionRole;
  grantedBy: string;
  expiresAt?: Date;
}

export interface CollaborativeMemory {
  id: string;
  content: string;
  scope: MemoryScope;
  isShared: boolean;
  versionNumber: number;
  lastModifiedBy?: string;
  lastModifiedAt?: Date;
  ownerId: string;
  permissions?: MemoryPermission[];
}

// ============================================================================
// COLLABORATIVE MEMORY SERVICE
// ============================================================================

export class CollaborativeMemoryService {
  constructor(private readonly db: Pool) {}

  /**
   * Share memory with another user
   */
  async shareMemory(request: ShareMemoryRequest): Promise<MemoryPermission> {
    try {
      const result = await this.db.query(
        `SELECT graphrag.share_memory($1, $2, $3, $4, $5) as permission_id`,
        [
          request.memoryId,
          request.userId,
          request.role,
          request.grantedBy,
          request.expiresAt || null,
        ]
      );

      const permissionId = result.rows[0].permission_id;

      // Get full permission details
      const permission = await this.getPermission(permissionId);

      logger.info('Memory shared successfully', {
        memoryId: request.memoryId,
        userId: request.userId,
        role: request.role,
        grantedBy: request.grantedBy,
      });

      return permission!;
    } catch (error) {
      logger.error('Failed to share memory', {
        error: error instanceof Error ? error.message : error,
        memoryId: request.memoryId,
        userId: request.userId,
      });
      throw error;
    }
  }

  /**
   * Revoke memory access from user
   */
  async revokeAccess(memoryId: string, userId: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        `DELETE FROM graphrag.memory_permissions
         WHERE memory_id = $1 AND user_id = $2`,
        [memoryId, userId]
      );

      const revoked = (result.rowCount || 0) > 0;

      if (revoked) {
        logger.info('Memory access revoked', {
          memoryId,
          userId,
        });
      }

      return revoked;
    } catch (error) {
      logger.error('Failed to revoke access', {
        error: error instanceof Error ? error.message : error,
        memoryId,
        userId,
      });
      throw error;
    }
  }

  /**
   * Check if user has access to memory
   */
  async checkAccess(
    memoryId: string,
    userId: string,
    requiredRole: PermissionRole = PermissionRole.READ
  ): Promise<boolean> {
    try {
      const result = await this.db.query(
        `SELECT graphrag.check_memory_access($1, $2, $3) as has_access`,
        [memoryId, userId, requiredRole]
      );

      return result.rows[0]?.has_access || false;
    } catch (error) {
      logger.error('Failed to check memory access', {
        error: error instanceof Error ? error.message : error,
        memoryId,
        userId,
        requiredRole,
      });
      return false;
    }
  }

  /**
   * Get all permissions for a memory
   */
  async getMemoryPermissions(memoryId: string): Promise<MemoryPermission[]> {
    try {
      const result = await this.db.query(
        `SELECT * FROM graphrag.memory_permissions
         WHERE memory_id = $1
         ORDER BY granted_at DESC`,
        [memoryId]
      );

      return result.rows.map(this.mapPermissionRow);
    } catch (error) {
      logger.error('Failed to get memory permissions', {
        error: error instanceof Error ? error.message : error,
        memoryId,
      });
      throw error;
    }
  }

  /**
   * Get all memories shared with user
   */
  async getSharedMemories(
    userId: string,
    tenantContext: EnhancedTenantContext
  ): Promise<CollaborativeMemory[]> {
    try {
      const result = await this.db.query(
        `SELECT DISTINCT
          uc.id,
          uc.content,
          uc.scope,
          uc.is_shared,
          uc.version_number,
          uc.last_modified_by,
          uc.last_modified_at,
          uc.user_id as owner_id
         FROM graphrag.unified_content uc
         LEFT JOIN graphrag.memory_permissions mp ON mp.memory_id = uc.id
         WHERE uc.company_id = $1
           AND uc.app_id = $2
           AND uc.content_type = 'memory'
           AND uc.is_shared = TRUE
           AND (
             uc.user_id = $3  -- Owner
             OR mp.user_id = $3  -- Explicitly shared
             OR (uc.scope = 'app' AND uc.is_shared = TRUE)  -- App-level
             OR (uc.scope = 'company' AND uc.is_shared = TRUE)  -- Company-level
           )
         ORDER BY uc.last_modified_at DESC`,
        [tenantContext.companyId, tenantContext.appId, userId]
      );

      return result.rows.map(this.mapCollaborativeMemoryRow);
    } catch (error) {
      logger.error('Failed to get shared memories', {
        error: error instanceof Error ? error.message : error,
        userId,
        companyId: tenantContext.companyId,
      });
      throw error;
    }
  }

  /**
   * Update memory scope (user/app/company)
   */
  async updateMemoryScope(
    memoryId: string,
    scope: MemoryScope,
    userId: string
  ): Promise<boolean> {
    try {
      // Check if user has admin access
      const hasAccess = await this.checkAccess(memoryId, userId, PermissionRole.ADMIN);

      if (!hasAccess) {
        throw new Error('User does not have admin access to this memory');
      }

      const result = await this.db.query(
        `UPDATE graphrag.unified_content
         SET scope = $1,
             is_shared = CASE WHEN $1 IN ('app', 'company') THEN TRUE ELSE is_shared END,
             last_modified_by = $2,
             last_modified_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [scope, userId, memoryId]
      );

      const updated = (result.rowCount || 0) > 0;

      if (updated) {
        logger.info('Memory scope updated', {
          memoryId,
          scope,
          userId,
        });
      }

      return updated;
    } catch (error) {
      logger.error('Failed to update memory scope', {
        error: error instanceof Error ? error.message : error,
        memoryId,
        scope,
      });
      throw error;
    }
  }

  // ============================================================================
  // VERSION MANAGEMENT
  // ============================================================================

  /**
   * Get version history for a memory
   */
  async getVersionHistory(
    memoryId: string,
    limit: number = 10
  ): Promise<MemoryVersion[]> {
    try {
      const result = await this.db.query(
        `SELECT * FROM graphrag.get_memory_versions($1, $2)`,
        [memoryId, limit]
      );

      return result.rows.map(this.mapVersionRow);
    } catch (error) {
      logger.error('Failed to get version history', {
        error: error instanceof Error ? error.message : error,
        memoryId,
      });
      throw error;
    }
  }

  /**
   * Get specific version of a memory
   */
  async getVersion(
    memoryId: string,
    versionNumber: number
  ): Promise<MemoryVersion | null> {
    try {
      const result = await this.db.query(
        `SELECT * FROM graphrag.memory_versions
         WHERE memory_id = $1 AND version_number = $2`,
        [memoryId, versionNumber]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapVersionRow(result.rows[0]);
    } catch (error) {
      logger.error('Failed to get memory version', {
        error: error instanceof Error ? error.message : error,
        memoryId,
        versionNumber,
      });
      throw error;
    }
  }

  /**
   * Restore memory to previous version
   */
  async restoreVersion(
    memoryId: string,
    versionNumber: number,
    restoredBy: string
  ): Promise<boolean> {
    try {
      // Check if user has write access
      const hasAccess = await this.checkAccess(
        memoryId,
        restoredBy,
        PermissionRole.WRITE
      );

      if (!hasAccess) {
        throw new Error('User does not have write access to this memory');
      }

      await this.db.query(
        `SELECT graphrag.restore_memory_version($1, $2, $3)`,
        [memoryId, versionNumber, restoredBy]
      );

      logger.info('Memory version restored', {
        memoryId,
        versionNumber,
        restoredBy,
      });

      return true;
    } catch (error) {
      logger.error('Failed to restore memory version', {
        error: error instanceof Error ? error.message : error,
        memoryId,
        versionNumber,
      });
      throw error;
    }
  }

  /**
   * Compare two versions
   */
  async compareVersions(
    memoryId: string,
    version1: number,
    version2: number
  ): Promise<{
    version1: MemoryVersion;
    version2: MemoryVersion;
    diff: {
      contentChanged: boolean;
      tagsChanged: boolean;
      metadataChanged: boolean;
    };
  }> {
    try {
      const [v1, v2] = await Promise.all([
        this.getVersion(memoryId, version1),
        this.getVersion(memoryId, version2),
      ]);

      if (!v1 || !v2) {
        throw new Error('One or both versions not found');
      }

      const diff = {
        contentChanged: v1.content !== v2.content,
        tagsChanged: JSON.stringify(v1.tags) !== JSON.stringify(v2.tags),
        metadataChanged: JSON.stringify(v1.metadata) !== JSON.stringify(v2.metadata),
      };

      return {
        version1: v1,
        version2: v2,
        diff,
      };
    } catch (error) {
      logger.error('Failed to compare versions', {
        error: error instanceof Error ? error.message : error,
        memoryId,
        version1,
        version2,
      });
      throw error;
    }
  }

  // ============================================================================
  // TEAM MEMORY MANAGEMENT
  // ============================================================================

  /**
   * Get all team memories (app or company scope)
   */
  async getTeamMemories(
    tenantContext: EnhancedTenantContext,
    scope?: MemoryScope
  ): Promise<CollaborativeMemory[]> {
    try {
      let query = `
        SELECT
          id,
          content,
          scope,
          is_shared,
          version_number,
          last_modified_by,
          last_modified_at,
          user_id as owner_id
        FROM graphrag.unified_content
        WHERE company_id = $1
          AND app_id = $2
          AND content_type = 'memory'
          AND is_shared = TRUE
      `;

      const params: any[] = [tenantContext.companyId, tenantContext.appId];

      if (scope) {
        query += ` AND scope = $3`;
        params.push(scope);
      } else {
        query += ` AND scope IN ('app', 'company')`;
      }

      query += ` ORDER BY last_modified_at DESC LIMIT 100`;

      const result = await this.db.query(query, params);

      return result.rows.map(this.mapCollaborativeMemoryRow);
    } catch (error) {
      logger.error('Failed to get team memories', {
        error: error instanceof Error ? error.message : error,
        companyId: tenantContext.companyId,
        appId: tenantContext.appId,
      });
      throw error;
    }
  }

  /**
   * Get memory collaboration stats
   */
  async getCollaborationStats(
    memoryId: string
  ): Promise<{
    totalCollaborators: number;
    totalVersions: number;
    lastModified: Date;
    topContributors: Array<{ userId: string; editCount: number }>;
  }> {
    try {
      const [permissions, versions, contributors] = await Promise.all([
        // Get permission count
        this.db.query(
          `SELECT COUNT(*) as count
           FROM graphrag.memory_permissions
           WHERE memory_id = $1`,
          [memoryId]
        ),

        // Get version count
        this.db.query(
          `SELECT COUNT(*) as count, MAX(created_at) as last_modified
           FROM graphrag.memory_versions
           WHERE memory_id = $1`,
          [memoryId]
        ),

        // Get top contributors
        this.db.query(
          `SELECT changed_by as user_id, COUNT(*) as edit_count
           FROM graphrag.memory_versions
           WHERE memory_id = $1
           GROUP BY changed_by
           ORDER BY edit_count DESC
           LIMIT 5`,
          [memoryId]
        ),
      ]);

      return {
        totalCollaborators: parseInt(permissions.rows[0]?.count || '0'),
        totalVersions: parseInt(versions.rows[0]?.count || '0'),
        lastModified: versions.rows[0]?.last_modified || new Date(),
        topContributors: contributors.rows.map(row => ({
          userId: row.user_id,
          editCount: parseInt(row.edit_count),
        })),
      };
    } catch (error) {
      logger.error('Failed to get collaboration stats', {
        error: error instanceof Error ? error.message : error,
        memoryId,
      });
      throw error;
    }
  }

  // ============================================================================
  // HELPER METHODS
  // ============================================================================

  private async getPermission(permissionId: string): Promise<MemoryPermission | null> {
    const result = await this.db.query(
      `SELECT * FROM graphrag.memory_permissions WHERE id = $1`,
      [permissionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapPermissionRow(result.rows[0]);
  }

  private mapPermissionRow(row: any): MemoryPermission {
    return {
      id: row.id,
      memoryId: row.memory_id,
      userId: row.user_id,
      role: row.role as PermissionRole,
      grantedBy: row.granted_by,
      grantedAt: new Date(row.granted_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }

  private mapVersionRow(row: any): MemoryVersion {
    return {
      id: row.id,
      memoryId: row.memory_id,
      versionNumber: row.version_number,
      content: row.content,
      tags: row.tags,
      metadata: row.metadata,
      changedBy: row.changed_by,
      changeType: row.change_type,
      changeSummary: row.change_summary,
      createdAt: new Date(row.created_at),
    };
  }

  private mapCollaborativeMemoryRow(row: any): CollaborativeMemory {
    return {
      id: row.id,
      content: row.content,
      scope: row.scope as MemoryScope,
      isShared: row.is_shared,
      versionNumber: row.version_number,
      lastModifiedBy: row.last_modified_by,
      lastModifiedAt: row.last_modified_at ? new Date(row.last_modified_at) : undefined,
      ownerId: row.owner_id,
    };
  }
}
