-- Migration: 003_create_processing_patterns_table.sql
-- Purpose: Create table for storing processing patterns for unknown file types
-- Root Cause Addressed: Issue #4 - No pattern learning system
--
-- This enables:
-- - Pattern caching (60s → 10s for repeated file types)
-- - GraphRAG semantic search integration
-- - Success/failure tracking
-- - Pattern evolution over time

-- Create processing_patterns table
CREATE TABLE IF NOT EXISTS fileprocess.processing_patterns (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- File type identification
  mime_type TEXT NOT NULL,
  file_characteristics JSONB NOT NULL DEFAULT '{}', -- extension, magicBytes, averageSize, commonPackages

  -- Processing code
  processing_code TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('python', 'node', 'go', 'rust', 'java', 'bash')),
  packages TEXT[] NOT NULL DEFAULT '{}',

  -- Success/failure metrics
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  success_rate NUMERIC(5, 4) NOT NULL DEFAULT 0.0 CHECK (success_rate >= 0 AND success_rate <= 1),
  average_execution_time_ms NUMERIC(10, 2) NOT NULL DEFAULT 0.0,

  -- GraphRAG integration
  embedding JSONB, -- VoyageAI embedding for semantic search
  graphrag_node_id TEXT, -- GraphRAG node ID for linking

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT positive_success_count CHECK (success_count >= 0),
  CONSTRAINT positive_failure_count CHECK (failure_count >= 0),
  CONSTRAINT positive_execution_time CHECK (average_execution_time_ms >= 0)
);

-- Create indexes for fast lookups

-- Index for MIME type lookups (most common query)
CREATE INDEX IF NOT EXISTS idx_processing_patterns_mime_type
  ON fileprocess.processing_patterns (mime_type);

-- Index for file extension lookups (fallback query)
CREATE INDEX IF NOT EXISTS idx_processing_patterns_extension
  ON fileprocess.processing_patterns ((file_characteristics->>'extension'));

-- Index for GraphRAG node ID lookups (semantic search)
CREATE INDEX IF NOT EXISTS idx_processing_patterns_graphrag_node_id
  ON fileprocess.processing_patterns (graphrag_node_id)
  WHERE graphrag_node_id IS NOT NULL;

-- Index for success rate sorting
CREATE INDEX IF NOT EXISTS idx_processing_patterns_success_rate
  ON fileprocess.processing_patterns (success_rate DESC, success_count DESC);

-- Index for last used timestamp (for cache eviction)
CREATE INDEX IF NOT EXISTS idx_processing_patterns_last_used
  ON fileprocess.processing_patterns (last_used_at DESC);

-- GIN index for JSONB file characteristics (for advanced queries)
CREATE INDEX IF NOT EXISTS idx_processing_patterns_characteristics
  ON fileprocess.processing_patterns USING GIN (file_characteristics);

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION fileprocess.update_processing_patterns_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
CREATE TRIGGER trigger_update_processing_patterns_updated_at
  BEFORE UPDATE ON fileprocess.processing_patterns
  FOR EACH ROW
  EXECUTE FUNCTION fileprocess.update_processing_patterns_updated_at();

-- Add comments for documentation
COMMENT ON TABLE fileprocess.processing_patterns IS 'Storage for processing patterns learned from unknown file types. Enables pattern caching and reuse for 6x performance improvement.';
COMMENT ON COLUMN fileprocess.processing_patterns.id IS 'Unique pattern identifier (UUID)';
COMMENT ON COLUMN fileprocess.processing_patterns.mime_type IS 'MIME type of files this pattern processes (e.g., application/x-eps)';
COMMENT ON COLUMN fileprocess.processing_patterns.file_characteristics IS 'JSON object with file characteristics: extension, magicBytes, averageSize, commonPackages';
COMMENT ON COLUMN fileprocess.processing_patterns.processing_code IS 'Code to execute for processing this file type';
COMMENT ON COLUMN fileprocess.processing_patterns.language IS 'Programming language of processing code (python, node, go, rust, java, bash)';
COMMENT ON COLUMN fileprocess.processing_patterns.packages IS 'Array of required packages/dependencies';
COMMENT ON COLUMN fileprocess.processing_patterns.success_count IS 'Number of successful executions';
COMMENT ON COLUMN fileprocess.processing_patterns.failure_count IS 'Number of failed executions';
COMMENT ON COLUMN fileprocess.processing_patterns.success_rate IS 'Success rate (0.0 to 1.0)';
COMMENT ON COLUMN fileprocess.processing_patterns.average_execution_time_ms IS 'Average execution time in milliseconds';
COMMENT ON COLUMN fileprocess.processing_patterns.embedding IS 'VoyageAI embedding vector for semantic search (JSON array of floats)';
COMMENT ON COLUMN fileprocess.processing_patterns.graphrag_node_id IS 'GraphRAG node ID for linking to knowledge graph';
COMMENT ON COLUMN fileprocess.processing_patterns.created_at IS 'Pattern creation timestamp';
COMMENT ON COLUMN fileprocess.processing_patterns.updated_at IS 'Pattern last update timestamp (auto-updated)';
COMMENT ON COLUMN fileprocess.processing_patterns.last_used_at IS 'Pattern last usage timestamp';

-- NOTE: GRANT statements removed - fileprocess_api role doesn't exist in production
-- Permissions are handled by application's PostgreSQL connection credentials (unified_brain superuser)
-- If you need specific role-based permissions, create the fileprocess_api role first:
--   CREATE ROLE fileprocess_api WITH LOGIN PASSWORD 'your_password';
--   GRANT SELECT, INSERT, UPDATE ON fileprocess.processing_patterns TO fileprocess_api;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA fileprocess TO fileprocess_api;

-- Insert example pattern for demonstration (optional - comment out for production)
-- INSERT INTO fileprocess.processing_patterns (
--   mime_type,
--   file_characteristics,
--   processing_code,
--   language,
--   packages,
--   success_count,
--   failure_count,
--   success_rate,
--   average_execution_time_ms
-- ) VALUES (
--   'application/x-eps',
--   '{"extension": ".eps", "commonPackages": ["ghostscript", "imagemagick"]}',
--   'import subprocess; result = subprocess.run(["gs", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", "-sOutputFile=output.pdf", input_file], capture_output=True); print(result.stdout.decode())',
--   'python',
--   ARRAY['ghostscript'],
--   10,
--   1,
--   0.9091,
--   8500.0
-- );

-- Verify table creation
SELECT
  'processing_patterns table created successfully' as status,
  COUNT(*) as pattern_count
FROM fileprocess.processing_patterns;
