-- ============================================================================
-- Intelligent Retry Loop System - Database Schema
-- ============================================================================
-- Purpose: Store error patterns and retry attempts for ML-based retry intelligence
-- Version: 1.0.0
-- Created: 2025-11-07
-- ============================================================================

-- Create schema for retry intelligence
CREATE SCHEMA IF NOT EXISTS retry_intelligence;

-- ============================================================================
-- Table: error_patterns
-- ============================================================================
-- Stores historical error patterns with ML-generated categorization and
-- retry strategy recommendations
-- ============================================================================

CREATE TABLE IF NOT EXISTS retry_intelligence.error_patterns (
  -- Primary identification
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Error identification
  error_type VARCHAR(100) NOT NULL,           -- Error class name (e.g., 'TimeoutError', 'ConnectionError')
  error_message TEXT NOT NULL,                -- Full error message
  error_stack TEXT,                           -- Stack trace for pattern matching
  error_code VARCHAR(50),                     -- Error code if available (e.g., 'ECONNREFUSED')

  -- Context identification
  service_name VARCHAR(100) NOT NULL,         -- Service where error occurred (e.g., 'mageagent', 'fileprocess')
  operation_name VARCHAR(200) NOT NULL,       -- Operation that failed (e.g., 'agent_execution', 'document_conversion')
  input_context JSONB,                        -- Serialized context at time of error

  -- ML-generated categorization
  category VARCHAR(100),                      -- Category: 'transient', 'configuration', 'data_quality', 'resource_exhaustion', 'infrastructure'
  severity VARCHAR(50),                       -- Severity: 'low', 'medium', 'high', 'critical'
  retryable BOOLEAN NOT NULL DEFAULT true,    -- Whether this error type is retryable

  -- Success metrics (updated as retries are attempted)
  retry_success_count INTEGER NOT NULL DEFAULT 0,
  retry_failure_count INTEGER NOT NULL DEFAULT 0,
  success_rate DECIMAL(5,4),                  -- Calculated: success_count / (success_count + failure_count)

  -- Retry strategy recommendations (ML-generated, JSON format)
  recommended_strategy JSONB NOT NULL DEFAULT '{
    "maxRetries": 3,
    "backoffMs": [1000, 2000, 4000],
    "exponentialBackoff": true,
    "timeout": null,
    "modifications": []
  }'::jsonb,

  -- Pattern matching metadata
  normalized_message TEXT,                    -- Normalized error message for fuzzy matching
  message_hash VARCHAR(64),                   -- SHA-256 hash of normalized message for exact matching

  -- Occurrence tracking
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,

  -- Audit fields
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT positive_occurrence_count CHECK (occurrence_count > 0),
  CONSTRAINT positive_retry_counts CHECK (retry_success_count >= 0 AND retry_failure_count >= 0),
  CONSTRAINT valid_success_rate CHECK (success_rate IS NULL OR (success_rate >= 0 AND success_rate <= 1))
);

-- ============================================================================
-- Table: retry_attempts
-- ============================================================================
-- Records individual retry attempts for learning and analytics
-- ============================================================================

CREATE TABLE IF NOT EXISTS retry_intelligence.retry_attempts (
  -- Primary identification
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Reference to error pattern
  pattern_id UUID REFERENCES retry_intelligence.error_patterns(id) ON DELETE CASCADE,

  -- Attempt identification
  task_id VARCHAR(200) NOT NULL,              -- Task/job/operation ID being retried
  agent_id VARCHAR(200),                      -- Agent ID if applicable
  attempt_number INTEGER NOT NULL,            -- Attempt number (1 = first retry after initial failure)

  -- Retry strategy that was applied
  strategy_applied JSONB NOT NULL,            -- Full strategy used for this attempt
  modifications_applied JSONB,                -- Any modifications made to operation parameters

  -- Outcome metrics
  success BOOLEAN NOT NULL,                   -- Whether this attempt succeeded
  execution_time_ms INTEGER,                  -- How long the retry took
  error_if_failed TEXT,                       -- Error message if this attempt failed

  -- Context for analysis
  context_snapshot JSONB,                     -- Snapshot of context at retry time

  -- Audit fields
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT positive_attempt_number CHECK (attempt_number > 0),
  CONSTRAINT positive_execution_time CHECK (execution_time_ms IS NULL OR execution_time_ms >= 0)
);

-- ============================================================================
-- Indexes for Performance
-- ============================================================================

-- Primary query patterns
CREATE INDEX idx_error_patterns_type_service
  ON retry_intelligence.error_patterns(error_type, service_name);

CREATE INDEX idx_error_patterns_service_operation
  ON retry_intelligence.error_patterns(service_name, operation_name);

CREATE INDEX idx_error_patterns_category
  ON retry_intelligence.error_patterns(category)
  WHERE category IS NOT NULL;

CREATE INDEX idx_error_patterns_success_rate
  ON retry_intelligence.error_patterns(success_rate DESC NULLS LAST)
  WHERE retryable = true;

CREATE INDEX idx_error_patterns_message_hash
  ON retry_intelligence.error_patterns(message_hash);

-- Time-based queries
CREATE INDEX idx_error_patterns_last_seen
  ON retry_intelligence.error_patterns(last_seen_at DESC);

CREATE INDEX idx_error_patterns_occurrence_count
  ON retry_intelligence.error_patterns(occurrence_count DESC);

-- Retry attempts queries
CREATE INDEX idx_retry_attempts_pattern_id
  ON retry_intelligence.retry_attempts(pattern_id);

CREATE INDEX idx_retry_attempts_task_id
  ON retry_intelligence.retry_attempts(task_id);

CREATE INDEX idx_retry_attempts_success
  ON retry_intelligence.retry_attempts(success);

CREATE INDEX idx_retry_attempts_created_at
  ON retry_intelligence.retry_attempts(created_at DESC);

-- Composite index for pattern matching
CREATE INDEX idx_error_patterns_matching
  ON retry_intelligence.error_patterns(service_name, operation_name, error_type, retryable)
  WHERE retryable = true;

-- ============================================================================
-- Functions for Automated Maintenance
-- ============================================================================

-- Function: Update error pattern statistics
CREATE OR REPLACE FUNCTION retry_intelligence.update_pattern_stats()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE retry_intelligence.error_patterns
  SET
    retry_success_count = retry_success_count + CASE WHEN NEW.success THEN 1 ELSE 0 END,
    retry_failure_count = retry_failure_count + CASE WHEN NEW.success THEN 0 ELSE 1 END,
    success_rate = (
      CASE
        WHEN (retry_success_count + retry_failure_count + 1) > 0
        THEN (retry_success_count + CASE WHEN NEW.success THEN 1 ELSE 0 END)::DECIMAL /
             (retry_success_count + retry_failure_count + 1)
        ELSE NULL
      END
    ),
    last_seen_at = NOW(),
    updated_at = NOW()
  WHERE id = NEW.pattern_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: Automatically update pattern stats when retry attempt recorded
CREATE TRIGGER trigger_update_pattern_stats
AFTER INSERT ON retry_intelligence.retry_attempts
FOR EACH ROW
EXECUTE FUNCTION retry_intelligence.update_pattern_stats();

-- Function: Clean up old retry attempts (retention policy)
CREATE OR REPLACE FUNCTION retry_intelligence.cleanup_old_attempts(
  retention_days INTEGER DEFAULT 90
)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM retry_intelligence.retry_attempts
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function: Get retry recommendation for error
CREATE OR REPLACE FUNCTION retry_intelligence.get_retry_recommendation(
  p_error_type VARCHAR,
  p_error_message TEXT,
  p_service_name VARCHAR,
  p_operation_name VARCHAR
)
RETURNS JSONB AS $$
DECLARE
  recommendation JSONB;
BEGIN
  -- Find best matching pattern with highest success rate
  SELECT
    jsonb_build_object(
      'patternId', id,
      'shouldRetry', retryable,
      'strategy', recommended_strategy,
      'confidence', success_rate,
      'category', category,
      'severity', severity,
      'reasoning', format(
        'Historical pattern with %s%% success rate (%s successful, %s failed attempts)',
        ROUND(success_rate * 100, 1),
        retry_success_count,
        retry_failure_count
      )
    )
  INTO recommendation
  FROM retry_intelligence.error_patterns
  WHERE
    service_name = p_service_name AND
    operation_name = p_operation_name AND
    error_type = p_error_type AND
    retryable = true
  ORDER BY
    -- Prioritize patterns with:
    -- 1. Higher success rate
    -- 2. More occurrences (more reliable data)
    -- 3. More recent
    success_rate DESC NULLS LAST,
    occurrence_count DESC,
    last_seen_at DESC
  LIMIT 1;

  -- If no exact match found, return default safe strategy
  IF recommendation IS NULL THEN
    recommendation := jsonb_build_object(
      'patternId', NULL,
      'shouldRetry', true,
      'strategy', jsonb_build_object(
        'maxRetries', 2,
        'backoffMs', array[1000, 2000],
        'exponentialBackoff', true
      ),
      'confidence', 0.5,
      'category', 'unknown',
      'severity', 'medium',
      'reasoning', 'No historical pattern found, using conservative default strategy'
    );
  END IF;

  RETURN recommendation;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Views for Analytics
-- ============================================================================

-- View: Most common errors by service
CREATE OR REPLACE VIEW retry_intelligence.v_common_errors AS
SELECT
  service_name,
  operation_name,
  error_type,
  category,
  COUNT(*) as error_count,
  AVG(success_rate) as avg_success_rate,
  SUM(occurrence_count) as total_occurrences,
  MAX(last_seen_at) as last_occurrence
FROM retry_intelligence.error_patterns
GROUP BY service_name, operation_name, error_type, category
ORDER BY total_occurrences DESC;

-- View: Retry effectiveness metrics
CREATE OR REPLACE VIEW retry_intelligence.v_retry_effectiveness AS
SELECT
  service_name,
  operation_name,
  category,
  COUNT(*) as pattern_count,
  AVG(success_rate) as avg_success_rate,
  SUM(retry_success_count) as total_successes,
  SUM(retry_failure_count) as total_failures,
  ROUND(
    CASE
      WHEN SUM(retry_success_count + retry_failure_count) > 0
      THEN (SUM(retry_success_count)::DECIMAL / SUM(retry_success_count + retry_failure_count)) * 100
      ELSE 0
    END,
    2
  ) as overall_success_percentage
FROM retry_intelligence.error_patterns
WHERE retryable = true
GROUP BY service_name, operation_name, category
ORDER BY overall_success_percentage DESC;

-- View: Recent retry activity
CREATE OR REPLACE VIEW retry_intelligence.v_recent_retries AS
SELECT
  ra.id,
  ra.task_id,
  ra.attempt_number,
  ra.success,
  ra.execution_time_ms,
  ra.created_at,
  ep.service_name,
  ep.operation_name,
  ep.error_type,
  ep.category,
  ep.severity
FROM retry_intelligence.retry_attempts ra
JOIN retry_intelligence.error_patterns ep ON ra.pattern_id = ep.id
WHERE ra.created_at > NOW() - INTERVAL '24 hours'
ORDER BY ra.created_at DESC;

-- ============================================================================
-- Seed Data: Common Error Patterns
-- ============================================================================

-- LibreOffice-specific patterns
INSERT INTO retry_intelligence.error_patterns (
  error_type,
  error_message,
  error_code,
  service_name,
  operation_name,
  category,
  severity,
  retryable,
  recommended_strategy,
  normalized_message,
  message_hash
) VALUES
-- Connection timeout
(
  'TimeoutError',
  'LibreOffice connection timeout after 30 seconds',
  'ETIMEDOUT',
  'fileprocess',
  'document_conversion',
  'transient',
  'medium',
  true,
  '{"maxRetries": 3, "backoffMs": [1000, 2000, 4000], "exponentialBackoff": true, "timeout": 60000, "modifications": [{"type": "parameter_change", "description": "Increase timeout to 60 seconds", "changes": {"timeout": 60000}}]}'::jsonb,
  'libreoffice connection timeout',
  encode(digest('libreoffice connection timeout', 'sha256'), 'hex')
),
-- Service unavailable
(
  'ServiceUnavailableError',
  'LibreOffice service is not responding',
  'ECONNREFUSED',
  'fileprocess',
  'document_conversion',
  'infrastructure',
  'high',
  true,
  '{"maxRetries": 5, "backoffMs": [2000, 4000, 8000, 16000, 32000], "exponentialBackoff": true, "modifications": []}'::jsonb,
  'libreoffice service not responding',
  encode(digest('libreoffice service not responding', 'sha256'), 'hex')
),
-- Invalid format
(
  'FormatError',
  'Document format not recognized by LibreOffice',
  'INVALID_FORMAT',
  'fileprocess',
  'document_conversion',
  'data_quality',
  'low',
  true,
  '{"maxRetries": 1, "backoffMs": [1000], "exponentialBackoff": false, "modifications": [{"type": "parameter_change", "description": "Enable format auto-detection", "changes": {"autoDetectFormat": true}}]}'::jsonb,
  'document format not recognized',
  encode(digest('document format not recognized', 'sha256'), 'hex')
),
-- Memory limit
(
  'OutOfMemoryError',
  'LibreOffice process exceeded memory limit',
  'ENOMEM',
  'fileprocess',
  'document_conversion',
  'resource_exhaustion',
  'high',
  true,
  '{"maxRetries": 2, "backoffMs": [2000, 4000], "exponentialBackoff": true, "modifications": [{"type": "parameter_change", "description": "Reduce batch size and increase memory limit", "changes": {"batchSize": 1, "memoryLimitMB": 2048}}]}'::jsonb,
  'process exceeded memory limit',
  encode(digest('process exceeded memory limit', 'sha256'), 'hex')
),
-- Lock file exists
(
  'FileLockError',
  'Document lock file exists, cannot open for editing',
  'ELOCKED',
  'fileprocess',
  'document_conversion',
  'transient',
  'low',
  true,
  '{"maxRetries": 3, "backoffMs": [1000, 2000, 3000], "exponentialBackoff": false, "modifications": [{"type": "alternative_method", "description": "Clean up lock files before retry", "changes": {"cleanupLocks": true}}]}'::jsonb,
  'document lock file exists',
  encode(digest('document lock file exists', 'sha256'), 'hex')
);

-- General MageAgent patterns
INSERT INTO retry_intelligence.error_patterns (
  error_type,
  error_message,
  error_code,
  service_name,
  operation_name,
  category,
  severity,
  retryable,
  recommended_strategy,
  normalized_message,
  message_hash
) VALUES
-- Model API timeout
(
  'TimeoutError',
  'OpenRouter API request timeout',
  'ETIMEDOUT',
  'mageagent',
  'agent_execution',
  'transient',
  'medium',
  true,
  '{"maxRetries": 3, "backoffMs": [2000, 4000, 8000], "exponentialBackoff": true, "timeout": 120000, "modifications": []}'::jsonb,
  'openrouter api request timeout',
  encode(digest('openrouter api request timeout', 'sha256'), 'hex')
),
-- Rate limit
(
  'RateLimitError',
  'Model API rate limit exceeded',
  'RATE_LIMIT',
  'mageagent',
  'agent_execution',
  'infrastructure',
  'medium',
  true,
  '{"maxRetries": 5, "backoffMs": [5000, 10000, 20000, 40000, 60000], "exponentialBackoff": true, "modifications": [{"type": "parameter_change", "description": "Switch to alternative model", "changes": {"fallbackModel": true}}]}'::jsonb,
  'model api rate limit exceeded',
  encode(digest('model api rate limit exceeded', 'sha256'), 'hex')
),
-- Context length exceeded
(
  'ContextLengthError',
  'Context length exceeds model maximum',
  'CONTEXT_TOO_LONG',
  'mageagent',
  'agent_execution',
  'data_quality',
  'high',
  true,
  '{"maxRetries": 2, "backoffMs": [1000, 2000], "exponentialBackoff": false, "modifications": [{"type": "parameter_change", "description": "Reduce context size or switch to larger context model", "changes": {"maxContextTokens": 4000, "compressionEnabled": true}}]}'::jsonb,
  'context length exceeds model maximum',
  encode(digest('context length exceeds model maximum', 'sha256'), 'hex')
);

-- ============================================================================
-- Grants (adjust based on your security requirements)
-- ============================================================================

-- Grant read/write access to mageagent service role
-- GRANT USAGE ON SCHEMA retry_intelligence TO mageagent_service;
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA retry_intelligence TO mageagent_service;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA retry_intelligence TO mageagent_service;

-- ============================================================================
-- End of Schema
-- ============================================================================

-- Verify installation
DO $$
BEGIN
  RAISE NOTICE 'Intelligent Retry System schema installed successfully';
  RAISE NOTICE 'Schema: retry_intelligence';
  RAISE NOTICE 'Tables: error_patterns, retry_attempts';
  RAISE NOTICE 'Views: v_common_errors, v_retry_effectiveness, v_recent_retries';
  RAISE NOTICE 'Functions: update_pattern_stats(), cleanup_old_attempts(), get_retry_recommendation()';
  RAISE NOTICE 'Seeded % error patterns', (SELECT COUNT(*) FROM retry_intelligence.error_patterns);
END $$;
