-- Communities Table Migration
-- Provides storage for detected community clusters in the knowledge graph
-- Used by Data Explorer graph visualization feature

-- =============================================================================
-- COMMUNITIES TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS graphrag.communities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Community identification
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Hierarchy
    level INTEGER NOT NULL DEFAULT 0,
    parent_id UUID REFERENCES graphrag.communities(id) ON DELETE SET NULL,

    -- Statistics
    member_count INTEGER NOT NULL DEFAULT 0,

    -- Metadata
    keywords TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',

    -- Audit
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Community membership (junction table)
CREATE TABLE IF NOT EXISTS graphrag.community_members (
    community_id UUID NOT NULL REFERENCES graphrag.communities(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES graphrag.universal_entities(id) ON DELETE CASCADE,
    membership_score FLOAT DEFAULT 1.0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, entity_id)
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_communities_level ON graphrag.communities(level);
CREATE INDEX IF NOT EXISTS idx_communities_parent ON graphrag.communities(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_communities_member_count ON graphrag.communities(member_count DESC);
CREATE INDEX IF NOT EXISTS idx_communities_keywords ON graphrag.communities USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_community_members_entity ON graphrag.community_members(entity_id);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- Auto-update updated_at timestamp
DROP TRIGGER IF EXISTS update_communities_updated_at ON graphrag.communities;
CREATE TRIGGER update_communities_updated_at
    BEFORE UPDATE ON graphrag.communities
    FOR EACH ROW
    EXECUTE FUNCTION graphrag.update_updated_at_column();

-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT ALL PRIVILEGES ON TABLE graphrag.communities TO CURRENT_USER;
GRANT ALL PRIVILEGES ON TABLE graphrag.community_members TO CURRENT_USER;

-- =============================================================================
-- MIGRATION COMPLETE
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Communities table migration completed successfully';
    RAISE NOTICE '- graphrag.communities table created';
    RAISE NOTICE '- graphrag.community_members junction table created';
    RAISE NOTICE '- Indexes and triggers created';
END $$;
