-- Migration: Create Artifacts Table for Universal File Storage
-- Version: 002
-- Description: Unified artifact storage table supporting PostgreSQL buffer and MinIO storage
-- Date: 2025-11-06

-- Create artifacts table in fileprocess schema
CREATE TABLE IF NOT EXISTS fileprocess.artifacts (
  -- Primary identification
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source tracking
  source_service VARCHAR(50) NOT NULL, -- 'sandbox', 'fileprocess', 'videoagent', 'geoagent', 'mageagent'
  source_id VARCHAR(255) NOT NULL,     -- execution_id, job_id, task_id, etc.

  -- File metadata
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_size BIGINT NOT NULL,          -- Size in bytes

  -- Storage backend configuration
  storage_backend VARCHAR(50) NOT NULL, -- 'postgres_buffer', 'minio', 'reference_only'
  storage_path TEXT,                    -- MinIO object path or external URL
  buffer_data TEXT,                     -- base64 encoded data for small files (<10MB)

  -- Presigned URL caching (for MinIO)
  presigned_url TEXT,                   -- Temporary download URL
  url_expires_at TIMESTAMPTZ,           -- Presigned URL expiration

  -- Additional metadata (JSON)
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,               -- TTL for automatic cleanup (default 7 days)

  -- Constraints
  CHECK (storage_backend IN ('postgres_buffer', 'minio', 'reference_only')),
  CHECK (file_size >= 0),
  CHECK (
    (storage_backend = 'postgres_buffer' AND buffer_data IS NOT NULL) OR
    (storage_backend = 'minio' AND storage_path IS NOT NULL) OR
    (storage_backend = 'reference_only' AND storage_path IS NOT NULL)
  )
);

-- Indexes for performance
CREATE INDEX idx_artifacts_source ON fileprocess.artifacts(source_service, source_id);
CREATE INDEX idx_artifacts_created_at ON fileprocess.artifacts(created_at DESC);
CREATE INDEX idx_artifacts_expires_at ON fileprocess.artifacts(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_artifacts_storage_backend ON fileprocess.artifacts(storage_backend);

-- NOTE: Removed idx_artifacts_expired partial index with NOW() predicate
-- (PostgreSQL requires IMMUTABLE functions in index predicates, but NOW() is VOLATILE)
-- The idx_artifacts_expires_at index on line 49 is sufficient for cleanup queries

-- GIN index for metadata JSON queries
CREATE INDEX idx_artifacts_metadata ON fileprocess.artifacts USING GIN(metadata);

-- Comments for documentation
COMMENT ON TABLE fileprocess.artifacts IS 'Universal artifact storage table supporting multi-tier storage (PostgreSQL buffer, MinIO, reference-only)';
COMMENT ON COLUMN fileprocess.artifacts.id IS 'Unique artifact identifier (UUID)';
COMMENT ON COLUMN fileprocess.artifacts.source_service IS 'Service that created the artifact (sandbox, fileprocess, videoagent, geoagent, mageagent)';
COMMENT ON COLUMN fileprocess.artifacts.source_id IS 'Source entity ID (execution_id, job_id, task_id)';
COMMENT ON COLUMN fileprocess.artifacts.filename IS 'Original filename';
COMMENT ON COLUMN fileprocess.artifacts.mime_type IS 'MIME type (e.g., image/svg+xml, application/pdf)';
COMMENT ON COLUMN fileprocess.artifacts.file_size IS 'File size in bytes';
COMMENT ON COLUMN fileprocess.artifacts.storage_backend IS 'Storage tier: postgres_buffer (<10MB), minio (10MB-5GB), reference_only (>5GB)';
COMMENT ON COLUMN fileprocess.artifacts.storage_path IS 'MinIO object path (minio://bucket/path) or external URL';
COMMENT ON COLUMN fileprocess.artifacts.buffer_data IS 'Base64 encoded file data for small files (<10MB)';
COMMENT ON COLUMN fileprocess.artifacts.presigned_url IS 'Cached presigned download URL (1 hour validity)';
COMMENT ON COLUMN fileprocess.artifacts.url_expires_at IS 'Presigned URL expiration timestamp';
COMMENT ON COLUMN fileprocess.artifacts.metadata IS 'Additional metadata (JSON): tags, source info, processing details';
COMMENT ON COLUMN fileprocess.artifacts.created_at IS 'Artifact creation timestamp';
COMMENT ON COLUMN fileprocess.artifacts.expires_at IS 'TTL expiration for automatic cleanup (default 7 days)';

-- NOTE: GRANT statements removed - fileprocess_api role doesn't exist in production
-- Permissions are handled by application's PostgreSQL connection credentials

-- Storage tier statistics view
CREATE OR REPLACE VIEW fileprocess.artifact_stats AS
SELECT
  storage_backend,
  COUNT(*) as artifact_count,
  SUM(file_size) as total_size_bytes,
  ROUND(SUM(file_size)::NUMERIC / 1024 / 1024, 2) as total_size_mb,
  ROUND(SUM(file_size)::NUMERIC / 1024 / 1024 / 1024, 2) as total_size_gb,
  AVG(file_size) as avg_size_bytes,
  MIN(file_size) as min_size_bytes,
  MAX(file_size) as max_size_bytes,
  COUNT(CASE WHEN expires_at < NOW() THEN 1 END) as expired_count
FROM fileprocess.artifacts
GROUP BY storage_backend;

COMMENT ON VIEW fileprocess.artifact_stats IS 'Statistics by storage backend (postgres_buffer, minio, reference_only)';

-- Source service statistics view
CREATE OR REPLACE VIEW fileprocess.artifact_source_stats AS
SELECT
  source_service,
  COUNT(*) as artifact_count,
  SUM(file_size) as total_size_bytes,
  ROUND(SUM(file_size)::NUMERIC / 1024 / 1024, 2) as total_size_mb,
  COUNT(DISTINCT source_id) as unique_sources,
  MAX(created_at) as last_artifact_created
FROM fileprocess.artifacts
GROUP BY source_service
ORDER BY artifact_count DESC;

COMMENT ON VIEW fileprocess.artifact_source_stats IS 'Statistics by source service (sandbox, fileprocess, etc.)';

-- Cleanup function for expired artifacts
CREATE OR REPLACE FUNCTION fileprocess.cleanup_expired_artifacts()
RETURNS TABLE(deleted_count BIGINT, freed_bytes BIGINT) AS $$
DECLARE
  v_deleted_count BIGINT;
  v_freed_bytes BIGINT;
BEGIN
  -- Calculate total size to be freed
  SELECT
    COUNT(*),
    COALESCE(SUM(file_size), 0)
  INTO v_deleted_count, v_freed_bytes
  FROM fileprocess.artifacts
  WHERE expires_at < NOW();

  -- Delete expired artifacts
  DELETE FROM fileprocess.artifacts
  WHERE expires_at < NOW();

  -- Return results
  RETURN QUERY SELECT v_deleted_count, v_freed_bytes;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fileprocess.cleanup_expired_artifacts IS 'Delete all expired artifacts and return cleanup statistics';

-- Example: Call cleanup function
-- SELECT * FROM fileprocess.cleanup_expired_artifacts();

-- Example queries:

-- Get artifacts for a specific execution
-- SELECT * FROM fileprocess.artifacts
-- WHERE source_service = 'sandbox' AND source_id = 'exec-123';

-- Get storage tier statistics
-- SELECT * FROM fileprocess.artifact_stats;

-- Get source service statistics
-- SELECT * FROM fileprocess.artifact_source_stats;

-- Find large files in PostgreSQL buffer (should be in MinIO)
-- SELECT id, filename, file_size, storage_backend
-- FROM fileprocess.artifacts
-- WHERE storage_backend = 'postgres_buffer' AND file_size > 10485760
-- ORDER BY file_size DESC;

-- Find expired artifacts ready for cleanup
-- SELECT id, filename, file_size, source_service, expires_at
-- FROM fileprocess.artifacts
-- WHERE expires_at < NOW()
-- ORDER BY expires_at;
