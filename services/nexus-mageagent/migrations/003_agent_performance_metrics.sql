-- Agent Performance Metrics Migration
-- Creates tables and views for tracking agent performance over time

-- Create schema if not exists
CREATE SCHEMA IF NOT EXISTS mageagent;

-- Agent Performance Metrics Table
CREATE TABLE IF NOT EXISTS mageagent.agent_performance_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id VARCHAR(100) NOT NULL,
  task_id VARCHAR(100) NOT NULL,
  agent_role VARCHAR(50) NOT NULL,
  model VARCHAR(200) NOT NULL,

  -- Performance Metrics
  latency_ms INTEGER NOT NULL,
  tokens_used INTEGER,
  cost_usd DECIMAL(10, 6),

  -- Quality Metrics
  success BOOLEAN NOT NULL,
  error_message TEXT,
  quality_score DECIMAL(3, 2), -- 0.00 to 1.00

  -- Context
  task_complexity VARCHAR(20), -- simple, medium, complex, extreme
  task_objective TEXT,

  -- Timestamps
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_agent_performance_model ON mageagent.agent_performance_metrics(model);
CREATE INDEX IF NOT EXISTS idx_agent_performance_role ON mageagent.agent_performance_metrics(agent_role);
CREATE INDEX IF NOT EXISTS idx_agent_performance_complexity ON mageagent.agent_performance_metrics(task_complexity);
CREATE INDEX IF NOT EXISTS idx_agent_performance_created_at ON mageagent.agent_performance_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_performance_model_role ON mageagent.agent_performance_metrics(model, agent_role);
CREATE INDEX IF NOT EXISTS idx_agent_performance_success ON mageagent.agent_performance_metrics(success);

-- Agent Model Statistics (Materialized View)
-- Aggregates performance metrics per model/role/complexity
CREATE MATERIALIZED VIEW IF NOT EXISTS mageagent.agent_model_stats AS
SELECT
  model,
  agent_role,
  task_complexity,
  COUNT(*) as total_executions,
  SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful_executions,
  ROUND(AVG(CASE WHEN success THEN 1.0 ELSE 0.0 END), 3) as success_rate,
  ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms), 0) as p50_latency_ms,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) as p95_latency_ms,
  ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms), 0) as p99_latency_ms,
  ROUND(AVG(tokens_used), 0) as avg_tokens,
  ROUND(AVG(cost_usd), 4) as avg_cost_usd,
  ROUND(AVG(quality_score), 3) as avg_quality_score
FROM mageagent.agent_performance_metrics
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY model, agent_role, task_complexity;

-- Index for materialized view
CREATE INDEX IF NOT EXISTS idx_agent_model_stats_model ON mageagent.agent_model_stats(model);
CREATE INDEX IF NOT EXISTS idx_agent_model_stats_role ON mageagent.agent_model_stats(agent_role);
CREATE INDEX IF NOT EXISTS idx_agent_model_stats_model_role ON mageagent.agent_model_stats(model, agent_role);

-- Function to refresh stats (should be called hourly via cron)
CREATE OR REPLACE FUNCTION mageagent.refresh_agent_stats()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mageagent.agent_model_stats;
END;
$$;

-- Grant permissions (adjust as needed for your setup)
GRANT USAGE ON SCHEMA mageagent TO postgres;
GRANT SELECT, INSERT ON mageagent.agent_performance_metrics TO postgres;
GRANT SELECT ON mageagent.agent_model_stats TO postgres;
GRANT EXECUTE ON FUNCTION mageagent.refresh_agent_stats() TO postgres;

-- Insert comment for documentation
COMMENT ON TABLE mageagent.agent_performance_metrics IS 'Tracks agent performance metrics for optimization and cost analysis';
COMMENT ON MATERIALIZED VIEW mageagent.agent_model_stats IS 'Aggregated statistics for model performance, refreshed hourly';
COMMENT ON FUNCTION mageagent.refresh_agent_stats() IS 'Refreshes the agent_model_stats materialized view';
