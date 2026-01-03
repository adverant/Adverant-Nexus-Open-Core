/**
 * Collaborative Memory API Routes
 *
 * Phase 4: Advanced Features & Performance
 *
 * Provides endpoints for:
 * - Memory sharing and permissions
 * - Version history and restoration
 * - Team memory management
 * - Collaboration statistics
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import {
  CollaborativeMemoryService,
  MemoryScope,
  PermissionRole,
} from '../services/collaborative-memory-service';
import {
  extractTenantContext,
  requireUserContext,
} from '../middleware/tenant-context';

// ============================================================================
// CREATE COLLABORATIVE MEMORY ROUTES
// ============================================================================

export function createCollaborativeMemoryRoutes(db: Pool): Router {
  const router = Router();
  const collaborativeMemoryService = new CollaborativeMemoryService(db);

  // All routes require tenant context and user context
  router.use(extractTenantContext);
  router.use(requireUserContext);

  // ============================================================================
  // MEMORY SHARING & PERMISSIONS
  // ============================================================================

  /**
   * POST /api/memory/:memoryId/share
   * Share memory with another user
   */
  router.post(
    '/:memoryId/share',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId } = req.params;
        const { userId: targetUserId, role, expiresAt } = req.body;
        const { userId: grantedBy } = req.tenantContext!;

        // Validate role
        if (!Object.values(PermissionRole).includes(role)) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: `Invalid role. Must be one of: ${Object.values(PermissionRole).join(', ')}`,
            code: 'INVALID_ROLE',
          });
        }

        // Check if granter has admin access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          grantedBy,
          PermissionRole.ADMIN
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to share this memory',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const permission = await collaborativeMemoryService.shareMemory({
          memoryId,
          userId: targetUserId,
          role,
          grantedBy,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        });

        return res.status(201).json({
          success: true,
          permission,
          message: 'Memory shared successfully',
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * DELETE /api/memory/:memoryId/share/:userId
   * Revoke memory access from user
   */
  router.delete(
    '/:memoryId/share/:userId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId, userId: targetUserId } = req.params;
        const { userId: requestingUser } = req.tenantContext!;

        // Check if requesting user has admin access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          requestingUser,
          PermissionRole.ADMIN
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to revoke access',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const revoked = await collaborativeMemoryService.revokeAccess(
          memoryId,
          targetUserId
        );

        if (!revoked) {
          return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: 'Permission not found',
            code: 'PERMISSION_NOT_FOUND',
          });
        }

        return res.json({
          success: true,
          message: 'Access revoked successfully',
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * GET /api/memory/:memoryId/permissions
   * Get all permissions for a memory
   */
  router.get(
    '/:memoryId/permissions',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId } = req.params;
        const { userId } = req.tenantContext!;

        // Check if user has admin access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          userId,
          PermissionRole.ADMIN
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to view permissions',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const permissions = await collaborativeMemoryService.getMemoryPermissions(
          memoryId
        );

        return res.json({
          success: true,
          permissions,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * GET /api/memory/shared
   * Get all memories shared with current user
   */
  router.get(
    '/shared',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { userId } = req.tenantContext!;

        const sharedMemories = await collaborativeMemoryService.getSharedMemories(
          userId,
          req.tenantContext!
        );

        return res.json({
          success: true,
          memories: sharedMemories,
          total: sharedMemories.length,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * PUT /api/memory/:memoryId/scope
   * Update memory scope (user/app/company)
   */
  router.put(
    '/:memoryId/scope',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId } = req.params;
        const { scope } = req.body;
        const { userId } = req.tenantContext!;

        // Validate scope
        if (!Object.values(MemoryScope).includes(scope)) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: `Invalid scope. Must be one of: ${Object.values(MemoryScope).join(', ')}`,
            code: 'INVALID_SCOPE',
          });
        }

        const updated = await collaborativeMemoryService.updateMemoryScope(
          memoryId,
          scope,
          userId
        );

        if (!updated) {
          return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: 'Memory not found',
            code: 'MEMORY_NOT_FOUND',
          });
        }

        return res.json({
          success: true,
          message: 'Memory scope updated successfully',
          scope,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  // ============================================================================
  // VERSION MANAGEMENT
  // ============================================================================

  /**
   * GET /api/memory/:memoryId/versions
   * Get version history for a memory
   */
  router.get(
    '/:memoryId/versions',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId } = req.params;
        const { limit = 10 } = req.query;
        const { userId } = req.tenantContext!;

        // Check if user has read access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          userId,
          PermissionRole.READ
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to view this memory',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const versions = await collaborativeMemoryService.getVersionHistory(
          memoryId,
          parseInt(limit as string)
        );

        return res.json({
          success: true,
          versions,
          total: versions.length,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * GET /api/memory/:memoryId/versions/:versionNumber
   * Get specific version of a memory
   */
  router.get(
    '/:memoryId/versions/:versionNumber',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId, versionNumber } = req.params;
        const { userId } = req.tenantContext!;

        // Check if user has read access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          userId,
          PermissionRole.READ
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to view this memory',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const version = await collaborativeMemoryService.getVersion(
          memoryId,
          parseInt(versionNumber)
        );

        if (!version) {
          return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: 'Version not found',
            code: 'VERSION_NOT_FOUND',
          });
        }

        return res.json({
          success: true,
          version,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * POST /api/memory/:memoryId/versions/:versionNumber/restore
   * Restore memory to previous version
   */
  router.post(
    '/:memoryId/versions/:versionNumber/restore',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId, versionNumber } = req.params;
        const { userId } = req.tenantContext!;

        const restored = await collaborativeMemoryService.restoreVersion(
          memoryId,
          parseInt(versionNumber),
          userId
        );

        if (!restored) {
          return res.status(404).json({
            success: false,
            error: 'Not Found',
            message: 'Version not found or restore failed',
            code: 'RESTORE_FAILED',
          });
        }

        return res.json({
          success: true,
          message: 'Memory restored successfully',
          restoredVersion: parseInt(versionNumber),
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * GET /api/memory/:memoryId/versions/compare
   * Compare two versions
   */
  router.get(
    '/:memoryId/versions/compare',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId } = req.params;
        const { version1, version2 } = req.query;
        const { userId } = req.tenantContext!;

        if (!version1 || !version2) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: 'Both version1 and version2 query parameters are required',
            code: 'MISSING_VERSIONS',
          });
        }

        // Check if user has read access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          userId,
          PermissionRole.READ
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to view this memory',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const comparison = await collaborativeMemoryService.compareVersions(
          memoryId,
          parseInt(version1 as string),
          parseInt(version2 as string)
        );

        return res.json({
          success: true,
          comparison,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  // ============================================================================
  // TEAM MEMORY MANAGEMENT
  // ============================================================================

  /**
   * GET /api/memory/team
   * Get all team memories (app or company scope)
   */
  router.get(
    '/team',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { scope } = req.query;

        // Validate scope if provided
        if (scope && !Object.values(MemoryScope).includes(scope as MemoryScope)) {
          return res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: `Invalid scope. Must be one of: ${Object.values(MemoryScope).join(', ')}`,
            code: 'INVALID_SCOPE',
          });
        }

        const teamMemories = await collaborativeMemoryService.getTeamMemories(
          req.tenantContext!,
          scope as MemoryScope | undefined
        );

        return res.json({
          success: true,
          memories: teamMemories,
          total: teamMemories.length,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  /**
   * GET /api/memory/:memoryId/stats
   * Get collaboration statistics for a memory
   */
  router.get(
    '/:memoryId/stats',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { memoryId } = req.params;
        const { userId } = req.tenantContext!;

        // Check if user has read access
        const hasAccess = await collaborativeMemoryService.checkAccess(
          memoryId,
          userId,
          PermissionRole.READ
        );

        if (!hasAccess) {
          return res.status(403).json({
            success: false,
            error: 'Forbidden',
            message: 'You do not have permission to view this memory',
            code: 'INSUFFICIENT_PERMISSIONS',
          });
        }

        const stats = await collaborativeMemoryService.getCollaborationStats(
          memoryId
        );

        return res.json({
          success: true,
          stats,
        });
      } catch (error) {
        return next(error);
      }
    }
  );

  logger.info('Collaborative memory routes initialized at /api/memory');

  return router;
}

export default createCollaborativeMemoryRoutes;
