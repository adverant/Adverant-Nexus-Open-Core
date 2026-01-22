-- Document Viewer Tables Migration
-- Adds support for Universal Document Viewer feature
-- Date: 2025-12-11

-- ============================================================================
-- 1. Document Entity Mentions
-- ============================================================================
-- Links entities to specific text spans in documents
CREATE TABLE IF NOT EXISTS graphrag.document_entity_mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES graphrag.universal_entities(id) ON DELETE CASCADE,
    chunk_id TEXT REFERENCES graphrag.document_chunks(id) ON DELETE SET NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    matched_text TEXT NOT NULL,
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    detection_method VARCHAR(50) DEFAULT 'automatic',
    created_at TIMESTAMP DEFAULT NOW(),
    created_by UUID,
    CONSTRAINT valid_offsets CHECK (start_offset >= 0 AND end_offset > start_offset)
);

-- Indexes for document_entity_mentions
CREATE INDEX IF NOT EXISTS idx_doc_entity_mentions_doc_id
    ON graphrag.document_entity_mentions(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_entity_mentions_entity_id
    ON graphrag.document_entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_doc_entity_mentions_chunk_id
    ON graphrag.document_entity_mentions(chunk_id);
CREATE INDEX IF NOT EXISTS idx_doc_entity_mentions_confidence
    ON graphrag.document_entity_mentions(confidence);

-- ============================================================================
-- 2. Document Annotations
-- ============================================================================
-- User-created highlights, notes, comments, and bookmarks
CREATE TABLE IF NOT EXISTS graphrag.document_annotations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('highlight', 'note', 'comment', 'bookmark')),
    chunk_id TEXT REFERENCES graphrag.document_chunks(id) ON DELETE SET NULL,
    start_offset INTEGER,
    end_offset INTEGER,
    page_number INTEGER,
    content TEXT,
    color VARCHAR(20) DEFAULT 'yellow',
    parent_id UUID REFERENCES graphrag.document_annotations(id) ON DELETE CASCADE,
    resolved BOOLEAN DEFAULT FALSE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT valid_annotation_offsets CHECK (
        (start_offset IS NULL AND end_offset IS NULL) OR
        (start_offset >= 0 AND end_offset > start_offset)
    )
);

-- Indexes for document_annotations
CREATE INDEX IF NOT EXISTS idx_doc_annotations_doc_id
    ON graphrag.document_annotations(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_annotations_user_id
    ON graphrag.document_annotations(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_annotations_type
    ON graphrag.document_annotations(type);
CREATE INDEX IF NOT EXISTS idx_doc_annotations_parent_id
    ON graphrag.document_annotations(parent_id);
CREATE INDEX IF NOT EXISTS idx_doc_annotations_created_at
    ON graphrag.document_annotations(created_at DESC);

-- ============================================================================
-- 3. Document View History
-- ============================================================================
-- Tracks user document viewing sessions
CREATE TABLE IF NOT EXISTS graphrag.document_view_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    document_id UUID NOT NULL REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    viewer_mode VARCHAR(20) CHECK (viewer_mode IN ('slide-over', 'full-tab', 'split-dock', 'modal')),
    source_tab VARCHAR(50),
    source_entity_id UUID,
    last_page INTEGER,
    last_section TEXT,
    scroll_position INTEGER DEFAULT 0,
    opened_at TIMESTAMP DEFAULT NOW(),
    closed_at TIMESTAMP,
    duration_seconds INTEGER,
    CONSTRAINT valid_duration CHECK (
        (closed_at IS NULL AND duration_seconds IS NULL) OR
        (closed_at IS NOT NULL AND duration_seconds >= 0)
    )
);

-- Indexes for document_view_history
CREATE INDEX IF NOT EXISTS idx_doc_view_history_user_id
    ON graphrag.document_view_history(user_id);
CREATE INDEX IF NOT EXISTS idx_doc_view_history_doc_id
    ON graphrag.document_view_history(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_view_history_opened_at
    ON graphrag.document_view_history(opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_view_history_source_entity
    ON graphrag.document_view_history(source_entity_id) WHERE source_entity_id IS NOT NULL;

-- ============================================================================
-- 4. Document Render Cache
-- ============================================================================
-- Caches rendered document output for complex conversions
CREATE TABLE IF NOT EXISTS graphrag.document_render_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    renderer_type VARCHAR(50) NOT NULL,
    render_options JSONB DEFAULT '{}',
    rendered_content TEXT,
    rendered_pages JSONB,
    source_hash VARCHAR(256) NOT NULL,
    render_version VARCHAR(20) DEFAULT '1.0.0',
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    UNIQUE(document_id, renderer_type, md5(render_options::text))
);

-- Indexes for document_render_cache
CREATE INDEX IF NOT EXISTS idx_doc_render_cache_doc_id
    ON graphrag.document_render_cache(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_render_cache_renderer_type
    ON graphrag.document_render_cache(renderer_type);
CREATE INDEX IF NOT EXISTS idx_doc_render_cache_expires_at
    ON graphrag.document_render_cache(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================================
-- 5. Document Relationships
-- ============================================================================
-- Links between documents (similarity, citations, references)
CREATE TABLE IF NOT EXISTS graphrag.document_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_document_id UUID NOT NULL REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    target_document_id UUID NOT NULL REFERENCES graphrag.documents(id) ON DELETE CASCADE,
    relationship_type VARCHAR(50) NOT NULL,
    similarity_score FLOAT CHECK (similarity_score IS NULL OR (similarity_score >= 0 AND similarity_score <= 1)),
    shared_entity_count INTEGER DEFAULT 0 CHECK (shared_entity_count >= 0),
    evidence_text TEXT,
    detection_method VARCHAR(50) DEFAULT 'automatic',
    confidence FLOAT DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    created_at TIMESTAMP DEFAULT NOW(),
    created_by UUID,
    CONSTRAINT no_self_reference CHECK (source_document_id != target_document_id),
    CONSTRAINT unique_relationship UNIQUE (source_document_id, target_document_id, relationship_type)
);

-- Indexes for document_relationships
CREATE INDEX IF NOT EXISTS idx_doc_relationships_source
    ON graphrag.document_relationships(source_document_id);
CREATE INDEX IF NOT EXISTS idx_doc_relationships_target
    ON graphrag.document_relationships(target_document_id);
CREATE INDEX IF NOT EXISTS idx_doc_relationships_type
    ON graphrag.document_relationships(relationship_type);
CREATE INDEX IF NOT EXISTS idx_doc_relationships_similarity
    ON graphrag.document_relationships(similarity_score DESC) WHERE similarity_score IS NOT NULL;

-- ============================================================================
-- 6. User Document Preferences
-- ============================================================================
-- Per-user preferences for document viewer
CREATE TABLE IF NOT EXISTS graphrag.user_document_preferences (
    user_id UUID PRIMARY KEY,
    default_viewer_mode VARCHAR(20) DEFAULT 'slide-over'
        CHECK (default_viewer_mode IN ('slide-over', 'full-tab', 'split-dock', 'modal')),
    default_theme VARCHAR(20) DEFAULT 'auto',
    theme_overrides JSONB DEFAULT '{}',
    font_size INTEGER DEFAULT 16 CHECK (font_size >= 8 AND font_size <= 32),
    font_family VARCHAR(100) DEFAULT 'system',
    line_height FLOAT DEFAULT 1.6 CHECK (line_height >= 1.0 AND line_height <= 3.0),
    sidebar_default_tab VARCHAR(20) DEFAULT 'entities',
    sidebar_collapsed BOOLEAN DEFAULT FALSE,
    show_entity_highlights BOOLEAN DEFAULT TRUE,
    custom_shortcuts JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for user preferences lookups
CREATE INDEX IF NOT EXISTS idx_user_doc_prefs_updated
    ON graphrag.user_document_preferences(updated_at DESC);

-- ============================================================================
-- Helper Functions
-- ============================================================================

-- Function: Get full document with all related data
CREATE OR REPLACE FUNCTION graphrag.get_document_full(doc_id UUID)
RETURNS TABLE(
    document JSONB,
    entities JSONB,
    annotations JSONB,
    relationships JSONB,
    view_history JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        -- Main document info
        row_to_json(d)::jsonb AS document,

        -- Entities mentioned in document
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', e.id,
                    'name', e.name,
                    'type', e.type,
                    'mentions', (
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'start', dem.start_offset,
                                'end', dem.end_offset,
                                'text', dem.matched_text,
                                'confidence', dem.confidence
                            )
                        )
                        FROM graphrag.document_entity_mentions dem
                        WHERE dem.document_id = doc_id AND dem.entity_id = e.id
                    )
                )
            )
            FROM graphrag.universal_entities e
            WHERE e.id IN (
                SELECT entity_id FROM graphrag.document_entity_mentions WHERE document_id = doc_id
            )),
            '[]'::jsonb
        ) AS entities,

        -- User annotations
        COALESCE(
            (SELECT jsonb_agg(row_to_json(a)::jsonb)
             FROM graphrag.document_annotations a
             WHERE a.document_id = doc_id),
            '[]'::jsonb
        ) AS annotations,

        -- Related documents
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', dr.id,
                    'targetDocumentId', dr.target_document_id,
                    'type', dr.relationship_type,
                    'similarity', dr.similarity_score,
                    'sharedEntities', dr.shared_entity_count
                )
            )
            FROM graphrag.document_relationships dr
            WHERE dr.source_document_id = doc_id),
            '[]'::jsonb
        ) AS relationships,

        -- Recent view history (last 10 sessions)
        COALESCE(
            (SELECT jsonb_agg(row_to_json(v)::jsonb)
             FROM (
                 SELECT * FROM graphrag.document_view_history
                 WHERE document_id = doc_id
                 ORDER BY opened_at DESC
                 LIMIT 10
             ) v),
            '[]'::jsonb
        ) AS view_history

    FROM graphrag.documents d
    WHERE d.id = doc_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Find related documents by shared entities
CREATE OR REPLACE FUNCTION graphrag.find_related_documents_by_entities(
    doc_id UUID,
    min_shared_entities INTEGER DEFAULT 2,
    result_limit INTEGER DEFAULT 10
)
RETURNS TABLE(
    document_id UUID,
    document_title TEXT,
    shared_entity_count INTEGER,
    shared_entities JSONB,
    similarity_score FLOAT
) AS $$
BEGIN
    RETURN QUERY
    WITH doc_entities AS (
        SELECT DISTINCT entity_id
        FROM graphrag.document_entity_mentions
        WHERE document_id = doc_id
    ),
    related_docs AS (
        SELECT
            dem.document_id,
            COUNT(DISTINCT dem.entity_id) AS shared_count,
            jsonb_agg(DISTINCT jsonb_build_object(
                'id', e.id,
                'name', e.name,
                'type', e.type
            )) AS shared_entities_json
        FROM graphrag.document_entity_mentions dem
        JOIN graphrag.universal_entities e ON e.id = dem.entity_id
        WHERE dem.entity_id IN (SELECT entity_id FROM doc_entities)
            AND dem.document_id != doc_id
        GROUP BY dem.document_id
        HAVING COUNT(DISTINCT dem.entity_id) >= min_shared_entities
    )
    SELECT
        rd.document_id,
        d.title,
        rd.shared_count::INTEGER,
        rd.shared_entities_json,
        COALESCE(dr.similarity_score, (rd.shared_count::FLOAT / 100.0)) AS similarity
    FROM related_docs rd
    JOIN graphrag.documents d ON d.id = rd.document_id
    LEFT JOIN graphrag.document_relationships dr
        ON dr.source_document_id = doc_id AND dr.target_document_id = rd.document_id
    ORDER BY rd.shared_count DESC, similarity DESC
    LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Cleanup Function for Expired Cache
-- ============================================================================

CREATE OR REPLACE FUNCTION graphrag.cleanup_expired_render_cache()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM graphrag.document_render_cache
    WHERE expires_at IS NOT NULL AND expires_at < NOW();

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create a scheduled cleanup (requires pg_cron extension, optional)
-- This is commented out as it requires pg_cron extension
-- SELECT cron.schedule('cleanup-render-cache', '0 2 * * *',
--     'SELECT graphrag.cleanup_expired_render_cache();');

-- ============================================================================
-- Grants (assuming graphrag_user role exists)
-- ============================================================================

-- Grant permissions on new tables
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graphrag_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON graphrag.document_entity_mentions TO graphrag_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON graphrag.document_annotations TO graphrag_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON graphrag.document_view_history TO graphrag_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON graphrag.document_render_cache TO graphrag_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON graphrag.document_relationships TO graphrag_user;
        GRANT SELECT, INSERT, UPDATE, DELETE ON graphrag.user_document_preferences TO graphrag_user;

        -- Grant execute on functions
        GRANT EXECUTE ON FUNCTION graphrag.get_document_full(UUID) TO graphrag_user;
        GRANT EXECUTE ON FUNCTION graphrag.find_related_documents_by_entities(UUID, INTEGER, INTEGER) TO graphrag_user;
        GRANT EXECUTE ON FUNCTION graphrag.cleanup_expired_render_cache() TO graphrag_user;
    END IF;
END
$$;
