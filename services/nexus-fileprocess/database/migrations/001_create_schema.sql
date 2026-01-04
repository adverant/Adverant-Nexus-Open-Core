-- FileProcessAgent Database Schema
-- Creates schema, tables, and indexes for production-grade document processing
--
-- Requirements:
-- - PostgreSQL 14+ for relational data
-- - Job tracking with status management
-- - Document DNA metadata storage (vectors stored in Qdrant)
-- - Optimized indexes for high-throughput queries
--
-- Architecture:
-- - PostgreSQL: Job metadata, status tracking, structural data
-- - Qdrant: Semantic embeddings for vector search
-- - Redis: Job queue and caching

-- Create dedicated schema for isolation
CREATE SCHEMA IF NOT EXISTS fileprocess;

-- Processing Jobs Table
-- Tracks all document processing jobs with comprehensive metadata
CREATE TABLE IF NOT EXISTS fileprocess.processing_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    filename VARCHAR(1024) NOT NULL,
    mime_type VARCHAR(255),
    file_size BIGINT,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    confidence DOUBLE PRECISION,
    processing_time_ms BIGINT,
    document_dna_id UUID,
    error_code VARCHAR(100),
    error_message TEXT,
    ocr_tier_used VARCHAR(50),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_status CHECK (
        status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT valid_confidence CHECK (
        confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
    ),
    CONSTRAINT valid_processing_time CHECK (
        processing_time_ms IS NULL OR processing_time_ms >= 0
    ),
    CONSTRAINT valid_file_size CHECK (
        file_size IS NULL OR file_size >= 0
    )
);

-- Document DNA Table
-- Stores document metadata and structural data
-- Note: Semantic embeddings stored in Qdrant for vector search
CREATE TABLE IF NOT EXISTS fileprocess.document_dna (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES fileprocess.processing_jobs(id) ON DELETE CASCADE,
    qdrant_point_id UUID NOT NULL,              -- Reference to Qdrant vector point
    structural_data JSONB NOT NULL,             -- Layout, tables, regions
    original_content BYTEA,                     -- Original file bytes
    embedding_dimensions INTEGER DEFAULT 1024,  -- Track embedding size
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT unique_job_dna UNIQUE (job_id),
    CONSTRAINT unique_qdrant_point UNIQUE (qdrant_point_id)
);

-- Indexes for High-Performance Queries

-- Job status queries (most common operation)
CREATE INDEX IF NOT EXISTS idx_jobs_status
    ON fileprocess.processing_jobs(status, created_at DESC);

-- User-specific job queries
CREATE INDEX IF NOT EXISTS idx_jobs_user_id
    ON fileprocess.processing_jobs(user_id, created_at DESC);

-- Job status + user filtering
CREATE INDEX IF NOT EXISTS idx_jobs_user_status
    ON fileprocess.processing_jobs(user_id, status, created_at DESC);

-- Document DNA lookup by job_id
CREATE INDEX IF NOT EXISTS idx_dna_job_id
    ON fileprocess.document_dna(job_id);

-- Qdrant point lookup
CREATE INDEX IF NOT EXISTS idx_dna_qdrant_point_id
    ON fileprocess.document_dna(qdrant_point_id);

-- JSONB metadata queries (GIN index for efficient JSONB queries)
CREATE INDEX IF NOT EXISTS idx_jobs_metadata
    ON fileprocess.processing_jobs USING gin(metadata);

-- Created timestamp for time-range queries
CREATE INDEX IF NOT EXISTS idx_jobs_created_at
    ON fileprocess.processing_jobs(created_at DESC);

-- Document DNA creation timestamp
CREATE INDEX IF NOT EXISTS idx_dna_created_at
    ON fileprocess.document_dna(created_at DESC);

-- Trigger to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION fileprocess.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_jobs_updated_at
    BEFORE UPDATE ON fileprocess.processing_jobs
    FOR EACH ROW
    EXECUTE FUNCTION fileprocess.update_updated_at_column();

-- Performance Statistics View
CREATE OR REPLACE VIEW fileprocess.processing_stats AS
SELECT
    status,
    COUNT(*) as count,
    AVG(confidence) as avg_confidence,
    AVG(processing_time_ms) as avg_processing_time_ms,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY processing_time_ms) as median_processing_time_ms,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_ms) as p95_processing_time_ms,
    MIN(created_at) as first_job,
    MAX(created_at) as last_job
FROM fileprocess.processing_jobs
GROUP BY status;

-- Grant permissions (adjust as needed for your setup)
-- GRANT USAGE ON SCHEMA fileprocess TO unified_brain;
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA fileprocess TO unified_brain;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA fileprocess TO unified_brain;

-- NOTE: schema_migrations table is managed by DatabaseMigrator, not by migration SQL files
