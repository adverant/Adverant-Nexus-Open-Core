/**
 * Usage Tracking Service
 *
 * Phase 3: Billing & Quota Enforcement
 *
 * Handles:
 * - API request tracking
 * - Storage usage calculation
 * - Compute time tracking
 * - Real-time usage metrics
 * - Monthly quota calculations
 */

import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { EnhancedTenantContext } from '../middleware/tenant-context';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type MetricType = 'api_request' | 'storage_mb' | 'compute_minutes';

export interface UsageMetric {
  id: string;
  companyId: string;
  appId: string;
  userId: string;
  metricType: MetricType;
  metricValue: number;
  requestId?: string;
  endpoint?: string;
  httpMethod?: string;
  statusCode?: number;
  timestamp: Date;
  durationMs?: number;
  metadata?: Record<string, any>;
}

export interface TrackUsageRequest {
  tenantContext: EnhancedTenantContext;
  metricType: MetricType;
  metricValue: number;
  endpoint?: string;
  httpMethod?: string;
  statusCode?: number;
  durationMs?: number;
  metadata?: Record<string, any>;
}

export interface UsageSummary {
  companyId: string;
  period: 'current_month' | 'last_month' | 'current_year';
  apiRequests: number;
  storageMB: number;
  computeMinutes: number;
  totalCost: number;
  breakdown: {
    byEndpoint: Record<string, number>;
    byUser: Record<string, number>;
    byApp: Record<string, number>;
  };
}

export interface QuotaStatus {
  companyId: string;
  tier: string;
  limits: {
    requestsPerMonth: number;
    storageLimitMB: number;
    computeMinutesPerMonth: number;
  };
  usage: {
    requestsThisMonth: number;
    storageMB: number;
    computeMinutesThisMonth: number;
  };
  remaining: {
    requests: number;
    storageMB: number;
    computeMinutes: number;
  };
  percentUsed: {
    requests: number;
    storage: number;
    compute: number;
  };
  isOverQuota: boolean;
  exceededLimits: string[];
}

// ============================================================================
// USAGE TRACKING SERVICE
// ============================================================================

export class UsageTrackingService {
  constructor(private readonly db: Pool) {}

  /**
   * Track a usage metric (API request, storage, compute)
   */
  async trackUsage(request: TrackUsageRequest): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO graphrag.usage_metrics (
          company_id,
          app_id,
          user_id,
          metric_type,
          metric_value,
          request_id,
          endpoint,
          http_method,
          status_code,
          duration_ms,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          request.tenantContext.companyId,
          request.tenantContext.appId,
          request.tenantContext.userId,
          request.metricType,
          request.metricValue,
          request.tenantContext.requestId,
          request.endpoint,
          request.httpMethod,
          request.statusCode,
          request.durationMs,
          request.metadata ? JSON.stringify(request.metadata) : null,
        ]
      );

      logger.debug('Usage metric tracked', {
        companyId: request.tenantContext.companyId,
        metricType: request.metricType,
        metricValue: request.metricValue,
      });
    } catch (error) {
      // Don't fail the request if usage tracking fails
      logger.error('Failed to track usage metric', {
        error: error instanceof Error ? error.message : error,
        companyId: request.tenantContext.companyId,
        metricType: request.metricType,
      });
    }
  }

  /**
   * Track API request (convenience method)
   */
  async trackAPIRequest(
    tenantContext: EnhancedTenantContext,
    endpoint: string,
    httpMethod: string,
    statusCode: number,
    durationMs: number
  ): Promise<void> {
    await this.trackUsage({
      tenantContext,
      metricType: 'api_request',
      metricValue: 1,
      endpoint,
      httpMethod,
      statusCode,
      durationMs,
    });
  }

  /**
   * Calculate current storage usage for a company
   */
  async calculateStorageUsage(companyId: string): Promise<number> {
    try {
      // Sum storage from unified_content
      const result = await this.db.query(
        `SELECT
          COALESCE(SUM(OCTET_LENGTH(content::text)), 0) / (1024 * 1024) as storage_mb
        FROM graphrag.unified_content
        WHERE company_id = $1`,
        [companyId]
      );

      const storageMB = parseFloat(result.rows[0]?.storage_mb || '0');

      // Track storage metric
      await this.db.query(
        `INSERT INTO graphrag.usage_metrics (
          company_id,
          app_id,
          user_id,
          metric_type,
          metric_value
        ) VALUES ($1, 'system', 'system', 'storage_mb', $2)
        ON CONFLICT DO NOTHING`,
        [companyId, storageMB]
      );

      return storageMB;
    } catch (error) {
      logger.error('Failed to calculate storage usage', {
        error: error instanceof Error ? error.message : error,
        companyId,
      });
      return 0;
    }
  }

  /**
   * Get current month usage for a company
   */
  async getCurrentMonthUsage(companyId: string): Promise<{
    apiRequests: number;
    storageMB: number;
    computeMinutes: number;
  }> {
    const result = await this.db.query(
      `SELECT
        metric_type,
        SUM(metric_value) as total_value
      FROM graphrag.usage_metrics
      WHERE company_id = $1
        AND DATE_TRUNC('month', timestamp) = DATE_TRUNC('month', CURRENT_TIMESTAMP)
      GROUP BY metric_type`,
      [companyId]
    );

    const usage = {
      apiRequests: 0,
      storageMB: 0,
      computeMinutes: 0,
    };

    for (const row of result.rows) {
      switch (row.metric_type) {
        case 'api_request':
          usage.apiRequests = parseInt(row.total_value);
          break;
        case 'storage_mb':
          usage.storageMB = parseFloat(row.total_value);
          break;
        case 'compute_minutes':
          usage.computeMinutes = parseFloat(row.total_value);
          break;
      }
    }

    return usage;
  }

  /**
   * Get quota status for a company
   */
  async getQuotaStatus(companyId: string): Promise<QuotaStatus | null> {
    // Get subscription and limits
    const subscriptionResult = await this.db.query(
      `SELECT
        s.tier,
        ql.requests_per_month,
        ql.storage_limit_mb,
        ql.compute_minutes_per_month
      FROM graphrag.subscriptions s
      JOIN graphrag.quota_limits ql ON ql.subscription_id = s.id
      WHERE s.company_id = $1
        AND s.status IN ('active', 'trialing')
      LIMIT 1`,
      [companyId]
    );

    if (subscriptionResult.rows.length === 0) {
      return null;
    }

    const {
      tier,
      requests_per_month,
      storage_limit_mb,
      compute_minutes_per_month,
    } = subscriptionResult.rows[0];

    // Get current usage
    const usage = await this.getCurrentMonthUsage(companyId);

    // Calculate remaining and percentage
    const calculateRemaining = (limit: number, used: number) => {
      if (limit === -1) return -1; // Unlimited
      return Math.max(0, limit - used);
    };

    const calculatePercent = (limit: number, used: number) => {
      if (limit === -1) return 0; // Unlimited
      if (limit === 0) return 100;
      return Math.min(100, (used / limit) * 100);
    };

    const remaining = {
      requests: calculateRemaining(requests_per_month, usage.apiRequests),
      storageMB: calculateRemaining(storage_limit_mb, usage.storageMB),
      computeMinutes: calculateRemaining(
        compute_minutes_per_month,
        usage.computeMinutes
      ),
    };

    const percentUsed = {
      requests: calculatePercent(requests_per_month, usage.apiRequests),
      storage: calculatePercent(storage_limit_mb, usage.storageMB),
      compute: calculatePercent(compute_minutes_per_month, usage.computeMinutes),
    };

    // Check if over quota
    const exceededLimits: string[] = [];
    if (requests_per_month !== -1 && usage.apiRequests >= requests_per_month) {
      exceededLimits.push('requests');
    }
    if (storage_limit_mb !== -1 && usage.storageMB >= storage_limit_mb) {
      exceededLimits.push('storage');
    }
    if (
      compute_minutes_per_month !== -1 &&
      usage.computeMinutes >= compute_minutes_per_month
    ) {
      exceededLimits.push('compute');
    }

    return {
      companyId,
      tier,
      limits: {
        requestsPerMonth: requests_per_month,
        storageLimitMB: storage_limit_mb,
        computeMinutesPerMonth: compute_minutes_per_month,
      },
      usage: {
        requestsThisMonth: usage.apiRequests,
        storageMB: usage.storageMB,
        computeMinutesThisMonth: usage.computeMinutes,
      },
      remaining,
      percentUsed,
      isOverQuota: exceededLimits.length > 0,
      exceededLimits,
    };
  }

  /**
   * Get usage summary with breakdown
   */
  async getUsageSummary(
    companyId: string,
    period: 'current_month' | 'last_month' | 'current_year' = 'current_month'
  ): Promise<UsageSummary> {
    // Calculate date range based on period
    let startDate: Date;
    let endDate: Date;

    const now = new Date();

    switch (period) {
      case 'current_month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        break;
      case 'last_month':
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
        break;
      case 'current_year':
        startDate = new Date(now.getFullYear(), 0, 1);
        endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
        break;
    }

    // Get total usage
    const totalResult = await this.db.query(
      `SELECT
        metric_type,
        SUM(metric_value) as total_value
      FROM graphrag.usage_metrics
      WHERE company_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
      GROUP BY metric_type`,
      [companyId, startDate, endDate]
    );

    let apiRequests = 0;
    let storageMB = 0;
    let computeMinutes = 0;

    for (const row of totalResult.rows) {
      switch (row.metric_type) {
        case 'api_request':
          apiRequests = parseInt(row.total_value);
          break;
        case 'storage_mb':
          storageMB = parseFloat(row.total_value);
          break;
        case 'compute_minutes':
          computeMinutes = parseFloat(row.total_value);
          break;
      }
    }

    // Get breakdown by endpoint
    const endpointResult = await this.db.query(
      `SELECT endpoint, COUNT(*) as count
      FROM graphrag.usage_metrics
      WHERE company_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
        AND metric_type = 'api_request'
        AND endpoint IS NOT NULL
      GROUP BY endpoint
      ORDER BY count DESC
      LIMIT 20`,
      [companyId, startDate, endDate]
    );

    const byEndpoint: Record<string, number> = {};
    for (const row of endpointResult.rows) {
      byEndpoint[row.endpoint] = parseInt(row.count);
    }

    // Get breakdown by user
    const userResult = await this.db.query(
      `SELECT user_id, COUNT(*) as count
      FROM graphrag.usage_metrics
      WHERE company_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
        AND metric_type = 'api_request'
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 20`,
      [companyId, startDate, endDate]
    );

    const byUser: Record<string, number> = {};
    for (const row of userResult.rows) {
      byUser[row.user_id] = parseInt(row.count);
    }

    // Get breakdown by app
    const appResult = await this.db.query(
      `SELECT app_id, COUNT(*) as count
      FROM graphrag.usage_metrics
      WHERE company_id = $1
        AND timestamp >= $2
        AND timestamp <= $3
        AND metric_type = 'api_request'
      GROUP BY app_id
      ORDER BY count DESC
      LIMIT 20`,
      [companyId, startDate, endDate]
    );

    const byApp: Record<string, number> = {};
    for (const row of appResult.rows) {
      byApp[row.app_id] = parseInt(row.count);
    }

    return {
      companyId,
      period,
      apiRequests,
      storageMB,
      computeMinutes,
      totalCost: 0, // Will be calculated based on tier pricing
      breakdown: {
        byEndpoint,
        byUser,
        byApp,
      },
    };
  }

  /**
   * Check if company is within quota for a specific metric
   */
  async checkQuota(companyId: string, metricType: MetricType): Promise<boolean> {
    try {
      const result = await this.db.query(
        'SELECT graphrag.check_quota($1, $2) as within_quota',
        [companyId, metricType]
      );

      return result.rows[0]?.within_quota || false;
    } catch (error) {
      logger.error('Failed to check quota', {
        error: error instanceof Error ? error.message : error,
        companyId,
        metricType,
      });
      // On error, allow the request (fail open)
      return true;
    }
  }

  /**
   * Log quota exceeded event
   */
  async logQuotaExceeded(
    companyId: string,
    metricType: MetricType,
    limit: number,
    usage: number
  ): Promise<void> {
    try {
      // Get subscription ID
      const subscriptionResult = await this.db.query(
        `SELECT id FROM graphrag.subscriptions
        WHERE company_id = $1 AND status IN ('active', 'trialing')
        LIMIT 1`,
        [companyId]
      );

      if (subscriptionResult.rows.length === 0) {
        return;
      }

      const subscriptionId = subscriptionResult.rows[0].id;

      // Log billing event
      await this.db.query(
        `INSERT INTO graphrag.billing_events (
          event_type,
          subscription_id,
          company_id,
          event_data,
          processed
        ) VALUES ($1, $2, $3, $4, $5)`,
        [
          'quota_exceeded',
          subscriptionId,
          companyId,
          JSON.stringify({ metricType, limit, usage }),
          true,
        ]
      );

      logger.warn('Quota exceeded', {
        companyId,
        metricType,
        limit,
        usage,
      });
    } catch (error) {
      logger.error('Failed to log quota exceeded event', {
        error: error instanceof Error ? error.message : error,
        companyId,
      });
    }
  }

  /**
   * Cleanup old usage metrics (retention policy)
   * Call this periodically (e.g., daily cron job)
   */
  async cleanupOldMetrics(retentionDays: number = 90): Promise<number> {
    try {
      const result = await this.db.query(
        `DELETE FROM graphrag.usage_metrics
        WHERE timestamp < CURRENT_TIMESTAMP - INTERVAL '1 day' * $1`,
        [retentionDays]
      );

      const deletedCount = result.rowCount || 0;

      if (deletedCount > 0) {
        logger.info('Cleaned up old usage metrics', {
          retentionDays,
          deletedCount,
        });
      }

      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup old metrics', {
        error: error instanceof Error ? error.message : error,
        retentionDays,
      });
      return 0;
    }
  }
}
