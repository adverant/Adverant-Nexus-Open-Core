import { DatabaseManager } from '../database/database-manager';
import { logger } from '../utils/logger';
import { AgentRole } from '../agents/base-agent';

export interface PerformanceMetrics {
  agentId: string;
  taskId: string;
  agentRole: AgentRole;
  model: string;
  latencyMs: number;
  tokensUsed?: number;
  costUsd?: number;
  success: boolean;
  errorMessage?: string;
  qualityScore?: number;
  taskComplexity: 'simple' | 'medium' | 'complex' | 'extreme';
  taskObjective: string;
  startedAt: Date;
  completedAt: Date;
}

export interface ModelPerformanceStats {
  model: string;
  role: AgentRole;
  complexity: string;
  totalExecutions: number;
  successRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgTokens: number;
  avgCostUsd: number;
  avgQualityScore: number;
  costEfficiencyScore: number; // quality / cost
}

export class AgentPerformanceProfiler {
  constructor(private databaseManager: DatabaseManager) {}

  /**
   * Record agent performance metrics after execution
   */
  async recordMetrics(metrics: PerformanceMetrics): Promise<void> {
    try {
      const pool = this.databaseManager.getPool();

      await pool.query(`
        INSERT INTO mageagent.agent_performance_metrics (
          agent_id, task_id, agent_role, model,
          latency_ms, tokens_used, cost_usd,
          success, error_message, quality_score,
          task_complexity, task_objective,
          started_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        metrics.agentId,
        metrics.taskId,
        metrics.agentRole,
        metrics.model,
        metrics.latencyMs,
        metrics.tokensUsed,
        metrics.costUsd,
        metrics.success,
        metrics.errorMessage,
        metrics.qualityScore,
        metrics.taskComplexity,
        metrics.taskObjective.substring(0, 500), // Truncate
        metrics.startedAt,
        metrics.completedAt
      ]);

      logger.debug('Agent performance metrics recorded', {
        agentId: metrics.agentId,
        model: metrics.model,
        latencyMs: metrics.latencyMs,
        success: metrics.success
      });
    } catch (error) {
      logger.error('Failed to record agent performance metrics', {
        error: error instanceof Error ? error.message : String(error),
        agentId: metrics.agentId
      });
      // Don't throw - metrics recording is non-critical
    }
  }

  /**
   * Get performance statistics for a specific model
   */
  async getModelStats(
    model: string,
    role?: AgentRole,
    complexity?: string
  ): Promise<ModelPerformanceStats[]> {
    try {
      const pool = this.databaseManager.getPool();

      let query = `
        SELECT * FROM mageagent.agent_model_stats
        WHERE model = $1
      `;
      const params: any[] = [model];

      if (role) {
        query += ` AND agent_role = $${params.length + 1}`;
        params.push(role);
      }

      if (complexity) {
        query += ` AND task_complexity = $${params.length + 1}`;
        params.push(complexity);
      }

      const result = await pool.query(query, params);

      return result.rows.map((row: any) => ({
        model: row.model,
        role: row.agent_role,
        complexity: row.task_complexity,
        totalExecutions: parseInt(row.total_executions),
        successRate: parseFloat(row.success_rate),
        p50LatencyMs: parseInt(row.p50_latency_ms),
        p95LatencyMs: parseInt(row.p95_latency_ms),
        p99LatencyMs: parseInt(row.p99_latency_ms),
        avgTokens: parseInt(row.avg_tokens),
        avgCostUsd: parseFloat(row.avg_cost_usd),
        avgQualityScore: parseFloat(row.avg_quality_score),
        costEfficiencyScore: row.avg_cost_usd > 0
          ? parseFloat(row.avg_quality_score) / parseFloat(row.avg_cost_usd)
          : 0
      }));
    } catch (error) {
      logger.error('Failed to get model stats', {
        error: error instanceof Error ? error.message : String(error),
        model
      });
      return [];
    }
  }

  /**
   * Get best performing models for a given role and complexity
   */
  async getBestModels(
    role: AgentRole,
    complexity: string,
    limit: number = 5,
    optimizeFor: 'latency' | 'cost' | 'quality' | 'efficiency' = 'efficiency'
  ): Promise<ModelPerformanceStats[]> {
    try {
      const pool = this.databaseManager.getPool();

      let orderBy: string;
      switch (optimizeFor) {
        case 'latency':
          orderBy = 'p95_latency_ms ASC';
          break;
        case 'cost':
          orderBy = 'avg_cost_usd ASC';
          break;
        case 'quality':
          orderBy = 'avg_quality_score DESC';
          break;
        case 'efficiency':
          orderBy = '(avg_quality_score / NULLIF(avg_cost_usd, 0)) DESC';
          break;
      }

      const result = await pool.query(`
        SELECT *,
          (avg_quality_score / NULLIF(avg_cost_usd, 0)) as cost_efficiency_score
        FROM mageagent.agent_model_stats
        WHERE agent_role = $1
          AND task_complexity = $2
          AND total_executions >= 10  -- Minimum sample size
          AND success_rate >= 0.8     -- Minimum success rate
        ORDER BY ${orderBy}
        LIMIT $3
      `, [role, complexity, limit]);

      return result.rows.map((row: any) => ({
        model: row.model,
        role: row.agent_role,
        complexity: row.task_complexity,
        totalExecutions: parseInt(row.total_executions),
        successRate: parseFloat(row.success_rate),
        p50LatencyMs: parseInt(row.p50_latency_ms),
        p95LatencyMs: parseInt(row.p95_latency_ms),
        p99LatencyMs: parseInt(row.p99_latency_ms),
        avgTokens: parseInt(row.avg_tokens),
        avgCostUsd: parseFloat(row.avg_cost_usd),
        avgQualityScore: parseFloat(row.avg_quality_score),
        costEfficiencyScore: parseFloat(row.cost_efficiency_score)
      }));
    } catch (error) {
      logger.error('Failed to get best models', {
        error: error instanceof Error ? error.message : String(error),
        role,
        complexity
      });
      return [];
    }
  }

  /**
   * Refresh materialized view stats (should be called hourly via cron)
   */
  async refreshStats(): Promise<void> {
    try {
      const pool = this.databaseManager.getPool();
      await pool.query('SELECT mageagent.refresh_agent_stats()');
      logger.info('Agent performance stats refreshed successfully');
    } catch (error) {
      logger.error('Failed to refresh agent performance stats', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get performance trends over time
   */
  async getPerformanceTrends(
    model: string,
    role: AgentRole,
    days: number = 30
  ): Promise<Array<{ date: string; avgLatencyMs: number; successRate: number; avgCost: number }>> {
    try {
      const pool = this.databaseManager.getPool();

      const result = await pool.query(`
        SELECT
          DATE(created_at) as date,
          ROUND(AVG(latency_ms), 0) as avg_latency_ms,
          ROUND(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END), 3) as success_rate,
          ROUND(AVG(cost_usd), 4) as avg_cost
        FROM mageagent.agent_performance_metrics
        WHERE model = $1
          AND agent_role = $2
          AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `, [model, role]);

      return result.rows.map((row: any) => ({
        date: row.date,
        avgLatencyMs: parseInt(row.avg_latency_ms),
        successRate: parseFloat(row.success_rate),
        avgCost: parseFloat(row.avg_cost)
      }));
    } catch (error) {
      logger.error('Failed to get performance trends', {
        error: error instanceof Error ? error.message : String(error),
        model,
        role
      });
      return [];
    }
  }
}

// Singleton instance
let profilerInstance: AgentPerformanceProfiler | null = null;

export function initializeProfiler(databaseManager: DatabaseManager): AgentPerformanceProfiler {
  if (!profilerInstance) {
    profilerInstance = new AgentPerformanceProfiler(databaseManager);
  }
  return profilerInstance;
}

export function getProfiler(): AgentPerformanceProfiler {
  if (!profilerInstance) {
    throw new Error('AgentPerformanceProfiler not initialized. Call initializeProfiler() first.');
  }
  return profilerInstance;
}
