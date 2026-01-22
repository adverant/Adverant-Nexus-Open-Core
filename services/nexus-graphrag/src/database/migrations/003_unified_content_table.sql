-- Migration 003: Unified Content Storage Schema
-- Creates unified_content table for consolidated memory/document/episode storage
-- This migration resolves the "relation graphrag.unified_content does not exist" error

BEGIN;

-- Create unified_content table (embeddings stored in Qdrant, not PostgreSQL)
CREATE TABLE IF NOT EXISTS graphrag.unified_content (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('memory', 'document', 'episode', 'chunk')),
    content TEXT NOT NULL CHECK (char_length(content) > 0),
    metadata JSONB DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    importance DECIMAL(3,2) DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    embedding_model VARCHAR(100) DEFAULT 'voyage-2',
    embedding_generated BOOLEAN DEFAULT FALSE,
    source VARCHAR(255),
    user_id VARCHAR(255),
    session_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    parent_id UUID,
    hierarchy_level INTEGER DEFAULT 0
);

-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_unified_content_type
    ON graphrag.unified_content(content_type);

CREATE INDEX IF NOT EXISTS idx_unified_content_created_at
    ON graphrag.unified_content(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_unified_content_tags
    ON graphrag.unified_content USING GIN(tags);

CREATE INDEX IF NOT EXISTS idx_unified_content_metadata
    ON graphrag.unified_content USING GIN(metadata);

CREATE INDEX IF NOT EXISTS idx_unified_content_user_session
    ON graphrag.unified_content(user_id, session_id)
    WHERE user_id IS NOT NULL AND session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_unified_content_parent
    ON graphrag.unified_content(parent_id)
    WHERE parent_id IS NOT NULL;

-- Trigger function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION graphrag.update_unified_content_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to call the timestamp update function
DROP TRIGGER IF EXISTS update_unified_content_timestamp ON graphrag.unified_content;
CREATE TRIGGER update_unified_content_timestamp
    BEFORE UPDATE ON graphrag.unified_content
    FOR EACH ROW
    EXECUTE FUNCTION graphrag.update_unified_content_timestamp();

-- Migrate existing memories to unified_content table
-- This ensures backward compatibility and preserves all existing data
INSERT INTO graphrag.unified_content (
    id,
    content_type,
    content,
    metadata,
    tags,
    importance,
    embedding_generated,
    created_at,
    updated_at,
    user_id,
    session_id
)
SELECT
    id,
    'memory' as content_type,
    content,
    metadata,
    tags,
    COALESCE((metadata->>'importance')::decimal, 0.5) as importance,
    COALESCE(embedding_generated, FALSE) as embedding_generated,
    created_at,
    updated_at,
    metadata->>'user_id' as user_id,
    metadata->>'session_id' as session_id
FROM graphrag.memories
WHERE NOT EXISTS (
    SELECT 1 FROM graphrag.unified_content uc
    WHERE uc.id = graphrag.memories.id
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Post-migration validation
-- This ensures the migration completed successfully
DO $$
DECLARE
    table_exists boolean;
    column_count integer;
    index_count integer;
    migrated_count integer;
BEGIN
    -- Verify table exists
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'graphrag'
        AND table_name = 'unified_content'
    ) INTO table_exists;

    IF NOT table_exists THEN
        RAISE EXCEPTION 'Migration 003 failed: unified_content table was not created';
    END IF;

    -- Verify required columns exist
    SELECT COUNT(*) INTO column_count
    FROM information_schema.columns
    WHERE table_schema = 'graphrag'
    AND table_name = 'unified_content'
    AND column_name IN ('id', 'content_type', 'content', 'metadata', 'tags', 'embedding_generated');

    IF column_count < 6 THEN
        RAISE EXCEPTION 'Migration 003 failed: unified_content table missing required columns';
    END IF;

    -- Verify indexes were created
    SELECT COUNT(*) INTO index_count
    FROM pg_indexes
    WHERE schemaname = 'graphrag'
    AND tablename = 'unified_content';

    IF index_count < 6 THEN
        RAISE WARNING 'Migration 003: Some indexes may not have been created (found %, expected 6+)', index_count;
    END IF;

    -- Verify data migration
    SELECT COUNT(*) INTO migrated_count
    FROM graphrag.unified_content
    WHERE content_type = 'memory';

    RAISE NOTICE 'Migration 003 completed successfully:';
    RAISE NOTICE '  - Table: unified_content created';
    RAISE NOTICE '  - Columns: % required columns verified', column_count;
    RAISE NOTICE '  - Indexes: % indexes created', index_count;
    RAISE NOTICE '  - Data: % memories migrated', migrated_count;
END $$;
