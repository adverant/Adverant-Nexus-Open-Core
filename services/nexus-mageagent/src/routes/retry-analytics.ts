/**
 * Retry Analytics API Routes
 * Provides endpoints for querying retry patterns, attempts, and effectiveness metrics
 */

import { Router, Request, Response } from 'express';
import { DatabaseManager } from '../database/database-manager';
import { logger } from '../utils/logger';

export function createRetryAnalyticsRoutes(databaseManager: DatabaseManager): Router {
  const router = Router();

  /**
   * GET /api/retry/patterns
   * List error patterns with success rates and occurrence counts
   */
  router.get('/patterns', async (req: Request, res: Response) => {
    try {
      const { limit = 50, offset = 0, category, service } = req.query;

      let query = `
        SELECT
          id,
          error_type,
          error_message,
          service_name,
          operation_name,
          category,
          severity,
          retryable,
          retry_success_count,
          retry_failure_count,
          ROUND(success_rate::numeric, 4) as success_rate,
          occurrence_count,
          recommended_strategy,
          first_seen_at,
          last_seen_at,
          updated_at
        FROM retry_intelligence.error_patterns
        WHERE 1=1
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (category) {
        query += ` AND category = $${paramIndex++}`;
        params.push(category);
      }

      if (service) {
        query += ` AND service_name = $${paramIndex++}`;
        params.push(service);
      }

      query += ` ORDER BY occurrence_count DESC, last_seen_at DESC`;
      query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      params.push(Number(limit), Number(offset));

      const result = await databaseManager.postgres.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          limit: Number(limit),
          offset: Number(offset),
          total: result.rowCount || 0
        }
      });
    } catch (error) {
      logger.error('Error fetching retry patterns', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch retry patterns',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * GET /api/retry/patterns/:id
   * Get detailed information about a specific error pattern
   */
  router.get('/patterns/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const patternResult = await databaseManager.postgres.query(
        `SELECT * FROM retry_intelligence.error_patterns WHERE id = $1`,
        [id]
      );

      if (patternResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Pattern not found'
        });
      }

      // Get recent attempts for this pattern
      const attemptsResult = await databaseManager.postgres.query(
        `SELECT * FROM retry_intelligence.retry_attempts
         WHERE pattern_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [id]
      );

      return res.json({
        success: true,
        data: {
          pattern: patternResult.rows[0],
          recentAttempts: attemptsResult.rows
        }
      });
    } catch (error) {
      logger.error('Error fetching pattern details', { error, patternId: req.params.id });
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch pattern details',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * GET /api/retry/attempts
   * Query retry attempts with filtering
   */
  router.get('/attempts', async (req: Request, res: Response) => {
    try {
      const {
        limit = 100,
        offset = 0,
        taskId,
        agentId,
        success,
        startDate,
        endDate
      } = req.query;

      let query = `
        SELECT
          ra.id,
          ra.pattern_id,
          ra.task_id,
          ra.agent_id,
          ra.attempt_number,
          ra.success,
          ra.execution_time_ms,
          ra.error_if_failed,
          ra.strategy_applied,
          ra.modifications_applied,
          ra.created_at,
          ep.error_type,
          ep.service_name,
          ep.operation_name
        FROM retry_intelligence.retry_attempts ra
        JOIN retry_intelligence.error_patterns ep ON ra.pattern_id = ep.id
        WHERE 1=1
      `;

      const params: any[] = [];
      let paramIndex = 1;

      if (taskId) {
        query += ` AND ra.task_id = $${paramIndex++}`;
        params.push(taskId);
      }

      if (agentId) {
        query += ` AND ra.agent_id = $${paramIndex++}`;
        params.push(agentId);
      }

      if (success !== undefined) {
        query += ` AND ra.success = $${paramIndex++}`;
        params.push(success === 'true');
      }

      if (startDate) {
        query += ` AND ra.created_at >= $${paramIndex++}`;
        params.push(startDate);
      }

      if (endDate) {
        query += ` AND ra.created_at <= $${paramIndex++}`;
        params.push(endDate);
      }

      query += ` ORDER BY ra.created_at DESC`;
      query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      params.push(Number(limit), Number(offset));

      const result = await databaseManager.postgres.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          limit: Number(limit),
          offset: Number(offset),
          total: result.rowCount || 0
        }
      });
    } catch (error) {
      logger.error('Error fetching retry attempts', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch retry attempts',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * GET /api/retry/analytics
   * Get aggregated analytics and effectiveness metrics
   */
  router.get('/analytics', async (req: Request, res: Response) => {
    try {
      const { timeframe = '24h' } = req.query;

      // Calculate time window
      let timeWindow = '24 hours';
      if (timeframe === '7d') timeWindow = '7 days';
      else if (timeframe === '30d') timeWindow = '30 days';

      // Get overall statistics
      const statsQuery = `
        SELECT
          COUNT(DISTINCT ep.id) as total_patterns,
          COUNT(ra.id) as total_attempts,
          SUM(CASE WHEN ra.success THEN 1 ELSE 0 END) as successful_retries,
          SUM(CASE WHEN NOT ra.success THEN 1 ELSE 0 END) as failed_retries,
          ROUND(AVG(ra.execution_time_ms)::numeric, 2) as avg_execution_time_ms,
          ROUND(
            (SUM(CASE WHEN ra.success THEN 1 ELSE 0 END)::float /
             NULLIF(COUNT(ra.id), 0) * 100)::numeric, 2
          ) as overall_success_rate_pct
        FROM retry_intelligence.error_patterns ep
        LEFT JOIN retry_intelligence.retry_attempts ra ON ep.id = ra.pattern_id
        WHERE ra.created_at >= NOW() - INTERVAL '${timeWindow}'
      `;

      const statsResult = await databaseManager.postgres.query(statsQuery);

      // Get top error types
      const topErrorsQuery = `
        SELECT
          error_type,
          service_name,
          operation_name,
          occurrence_count,
          ROUND(success_rate::numeric, 4) as success_rate
        FROM retry_intelligence.error_patterns
        ORDER BY occurrence_count DESC
        LIMIT 10
      `;

      const topErrorsResult = await databaseManager.postgres.query(topErrorsQuery);

      // Get retry effectiveness by category
      const categoryQuery = `
        SELECT * FROM retry_intelligence.v_retry_effectiveness
        ORDER BY overall_success_percentage DESC
      `;

      const categoryResult = await databaseManager.postgres.query(categoryQuery);

      // Get recent retry activity
      const recentQuery = `
        SELECT * FROM retry_intelligence.v_recent_retries
        ORDER BY created_at DESC
        LIMIT 10
      `;

      const recentResult = await databaseManager.postgres.query(recentQuery);

      res.json({
        success: true,
        data: {
          timeframe,
          statistics: statsResult.rows[0],
          topErrors: topErrorsResult.rows,
          effectivenessByCategory: categoryResult.rows,
          recentActivity: recentResult.rows
        }
      });
    } catch (error) {
      logger.error('Error fetching retry analytics', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch retry analytics',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * GET /api/retry/recommendation
   * Get retry recommendation for a specific error type and operation
   */
  router.get('/recommendation', async (req: Request, res: Response) => {
    try {
      const { errorType, service, operation } = req.query;

      if (!errorType || !service || !operation) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters: errorType, service, operation'
        });
      }

      const result = await databaseManager.postgres.query(
        `SELECT retry_intelligence.get_retry_recommendation($1, $2, $3) as recommendation`,
        [errorType, service, operation]
      );

      return res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      logger.error('Error fetching retry recommendation', { error });
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch retry recommendation',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  /**
   * POST /api/retry/cleanup
   * Trigger cleanup of old retry attempts (90+ days)
   */
  router.post('/cleanup', async (_req: Request, res: Response) => {
    try {
      const result = await databaseManager.postgres.query(
        `SELECT retry_intelligence.cleanup_old_attempts() as deleted_count`
      );

      res.json({
        success: true,
        message: 'Cleanup completed successfully',
        deletedCount: result.rows[0].deleted_count
      });
    } catch (error) {
      logger.error('Error running retry cleanup', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to run cleanup',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  return router;
}
