-- Migration 012: Relevance Tracking & Memory Decay System
-- Adds relevance scoring and temporal decay tracking to unified_content table
-- Implements Nexus Memory Lens feature for intelligent memory retrieval

BEGIN;

-- ============================================================================
-- ALTER UNIFIED_CONTENT TABLE - ADD RELEVANCE COLUMNS
-- ============================================================================

-- Add columns to track access patterns and relevance metrics
ALTER TABLE graphrag.unified_content
ADD COLUMN IF NOT EXISTS last_accessed TIMESTAMPTZ DEFAULT NOW(),
ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS stability DECIMAL(5,4) DEFAULT 0.5 CHECK (stability >= 0 AND stability <= 1),
ADD COLUMN IF NOT EXISTS retrievability DECIMAL(5,4) DEFAULT 1.0 CHECK (retrievability >= 0 AND retrievability <= 1),
ADD COLUMN IF NOT EXISTS user_importance DECIMAL(3,2) DEFAULT NULL CHECK (user_importance IS NULL OR (user_importance >= 0 AND user_importance <= 1)),
ADD COLUMN IF NOT EXISTS ai_importance DECIMAL(3,2) DEFAULT NULL CHECK (ai_importance IS NULL OR (ai_importance >= 0 AND ai_importance <= 1)),
ADD COLUMN IF NOT EXISTS has_graph_relationships BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS relevance_score_cached DECIMAL(5,4) DEFAULT NULL CHECK (relevance_score_cached IS NULL OR (relevance_score_cached >= 0 AND relevance_score_cached <= 1)),
ADD COLUMN IF NOT EXISTS relevance_cache_expires_at TIMESTAMPTZ DEFAULT NULL;

-- Create indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_unified_content_last_accessed
    ON graphrag.unified_content(last_accessed DESC);

CREATE INDEX IF NOT EXISTS idx_unified_content_access_count
    ON graphrag.unified_content(access_count DESC);

CREATE INDEX IF NOT EXISTS idx_unified_content_retrievability
    ON graphrag.unified_content(retrievability DESC)
    WHERE retrievability > 0;

CREATE INDEX IF NOT EXISTS idx_unified_content_relevance_cache
    ON graphrag.unified_content(relevance_cache_expires_at)
    WHERE relevance_cache_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_unified_content_graph_relationships
    ON graphrag.unified_content(has_graph_relationships)
    WHERE has_graph_relationships = TRUE;

-- ============================================================================
-- RELEVANCE ACCESS LOG TABLE
-- ============================================================================

-- Track every access to content for pattern analysis
CREATE TABLE IF NOT EXISTS graphrag.relevance_access_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES graphrag.unified_content(id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    session_id VARCHAR(255),
    access_type VARCHAR(50) NOT NULL CHECK (access_type IN ('retrieve', 'view', 'edit', 'share')),
    context_type VARCHAR(50) CHECK (context_type IN ('query', 'related', 'manual', 'system')),
    relevance_score DECIMAL(5,4) CHECK (relevance_score >= 0 AND relevance_score <= 1),
    accessed_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Index for access pattern queries
CREATE INDEX IF NOT EXISTS idx_access_log_content_user
    ON graphrag.relevance_access_log(content_id, user_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_log_session
    ON graphrag.relevance_access_log(session_id, accessed_at DESC)
    WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_access_log_accessed_at
    ON graphrag.relevance_access_log(accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_access_log_access_type
    ON graphrag.relevance_access_log(access_type, accessed_at DESC);

-- ============================================================================
-- STABILITY HISTORY TABLE
-- ============================================================================

-- Track decay over time for analysis and debugging
CREATE TABLE IF NOT EXISTS graphrag.stability_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES graphrag.unified_content(id) ON DELETE CASCADE,
    stability DECIMAL(5,4) NOT NULL CHECK (stability >= 0 AND stability <= 1),
    retrievability DECIMAL(5,4) NOT NULL CHECK (retrievability >= 0 AND retrievability <= 1),
    access_count INTEGER NOT NULL,
    last_accessed TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Index for historical queries
CREATE INDEX IF NOT EXISTS idx_stability_history_content
    ON graphrag.stability_history(content_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_stability_history_recorded_at
    ON graphrag.stability_history(recorded_at DESC);

-- ============================================================================
-- POSTGRESQL FUNCTION: RECORD CONTENT ACCESS
-- ============================================================================

-- Function to record access and update relevance metrics
CREATE OR REPLACE FUNCTION graphrag.record_content_access(
    p_content_id UUID,
    p_user_id VARCHAR(255),
    p_session_id VARCHAR(255) DEFAULT NULL,
    p_access_type VARCHAR(50) DEFAULT 'retrieve',
    p_context_type VARCHAR(50) DEFAULT 'query',
    p_relevance_score DECIMAL(5,4) DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_current_stability DECIMAL(5,4);
    v_current_access_count INTEGER;
    v_new_stability DECIMAL(5,4);
BEGIN
    -- Get current metrics
    SELECT stability, access_count
    INTO v_current_stability, v_current_access_count
    FROM graphrag.unified_content
    WHERE id = p_content_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Content not found: %', p_content_id;
    END IF;

    -- Calculate new stability (increases with each access, approaches 1.0)
    -- Formula: new_stability = old_stability + (1 - old_stability) * 0.1
    v_new_stability := LEAST(1.0, v_current_stability + (1.0 - v_current_stability) * 0.1);

    -- Update unified_content record
    UPDATE graphrag.unified_content
    SET
        last_accessed = NOW(),
        access_count = access_count + 1,
        stability = v_new_stability,
        retrievability = 1.0, -- Reset to full retrievability on access
        relevance_score_cached = NULL, -- Invalidate cache
        relevance_cache_expires_at = NULL
    WHERE id = p_content_id;

    -- Log the access
    INSERT INTO graphrag.relevance_access_log (
        content_id,
        user_id,
        session_id,
        access_type,
        context_type,
        relevance_score,
        accessed_at,
        metadata
    ) VALUES (
        p_content_id,
        p_user_id,
        p_session_id,
        p_access_type,
        p_context_type,
        p_relevance_score,
        NOW(),
        jsonb_build_object(
            'new_stability', v_new_stability,
            'access_count', v_current_access_count + 1
        )
    );

    -- Record stability snapshot (sample every 10 accesses or first access)
    IF (v_current_access_count + 1) % 10 = 0 OR v_current_access_count = 0 THEN
        INSERT INTO graphrag.stability_history (
            content_id,
            stability,
            retrievability,
            access_count,
            last_accessed,
            recorded_at
        ) VALUES (
            p_content_id,
            v_new_stability,
            1.0,
            v_current_access_count + 1,
            NOW(),
            NOW()
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- POSTGRESQL FUNCTION: UPDATE RETRIEVABILITY BATCH
-- ============================================================================

-- Batch update retrievability for decay processing
-- This function should be called periodically (e.g., hourly) by a cron job
CREATE OR REPLACE FUNCTION graphrag.update_retrievability_batch(
    p_decay_rate DECIMAL(5,4) DEFAULT 0.0001,
    p_batch_size INTEGER DEFAULT 1000
) RETURNS TABLE(
    updated_count INTEGER,
    avg_retrievability DECIMAL(5,4),
    min_retrievability DECIMAL(5,4),
    max_retrievability DECIMAL(5,4)
) AS $$
DECLARE
    v_updated_count INTEGER := 0;
    v_avg_retrievability DECIMAL(5,4);
    v_min_retrievability DECIMAL(5,4);
    v_max_retrievability DECIMAL(5,4);
BEGIN
    -- Update retrievability for all content not accessed recently
    -- Formula: new_retrievability = current_retrievability * (1 - decay_rate * hours_since_access)
    WITH decay_updates AS (
        UPDATE graphrag.unified_content
        SET retrievability = GREATEST(
            0.0,
            retrievability * (1.0 - (p_decay_rate * EXTRACT(EPOCH FROM (NOW() - last_accessed)) / 3600))
        )
        WHERE
            retrievability > 0
            AND last_accessed < NOW() - INTERVAL '1 hour'
            AND id IN (
                SELECT id
                FROM graphrag.unified_content
                WHERE retrievability > 0
                    AND last_accessed < NOW() - INTERVAL '1 hour'
                ORDER BY last_accessed ASC
                LIMIT p_batch_size
            )
        RETURNING id, retrievability
    )
    SELECT
        COUNT(*)::INTEGER,
        AVG(retrievability)::DECIMAL(5,4),
        MIN(retrievability)::DECIMAL(5,4),
        MAX(retrievability)::DECIMAL(5,4)
    INTO
        v_updated_count,
        v_avg_retrievability,
        v_min_retrievability,
        v_max_retrievability
    FROM decay_updates;

    -- Return statistics
    updated_count := v_updated_count;
    avg_retrievability := COALESCE(v_avg_retrievability, 0);
    min_retrievability := COALESCE(v_min_retrievability, 0);
    max_retrievability := COALESCE(v_max_retrievability, 1);

    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER FUNCTION: CALCULATE RELEVANCE SCORE
-- ============================================================================

-- Calculate composite relevance score from all factors
CREATE OR REPLACE FUNCTION graphrag.calculate_relevance_score(
    p_content_id UUID,
    p_vector_similarity DECIMAL(5,4) DEFAULT NULL,
    p_use_cache BOOLEAN DEFAULT TRUE
) RETURNS DECIMAL(5,4) AS $$
DECLARE
    v_stability DECIMAL(5,4);
    v_retrievability DECIMAL(5,4);
    v_user_importance DECIMAL(3,2);
    v_ai_importance DECIMAL(3,2);
    v_has_graph BOOLEAN;
    v_cached_score DECIMAL(5,4);
    v_cache_expires TIMESTAMPTZ;
    v_final_score DECIMAL(5,4);
    v_vector_weight DECIMAL(3,2) := 0.30;
    v_stability_weight DECIMAL(3,2) := 0.15;
    v_retrievability_weight DECIMAL(3,2) := 0.20;
    v_user_importance_weight DECIMAL(3,2) := 0.20;
    v_ai_importance_weight DECIMAL(3,2) := 0.10;
    v_graph_boost DECIMAL(3,2) := 0.05;
BEGIN
    -- Check cache first
    IF p_use_cache THEN
        SELECT relevance_score_cached, relevance_cache_expires_at
        INTO v_cached_score, v_cache_expires
        FROM graphrag.unified_content
        WHERE id = p_content_id;

        IF v_cached_score IS NOT NULL AND v_cache_expires > NOW() THEN
            RETURN v_cached_score;
        END IF;
    END IF;

    -- Get all relevance factors
    SELECT
        stability,
        retrievability,
        user_importance,
        ai_importance,
        has_graph_relationships
    INTO
        v_stability,
        v_retrievability,
        v_user_importance,
        v_ai_importance,
        v_has_graph
    FROM graphrag.unified_content
    WHERE id = p_content_id;

    IF NOT FOUND THEN
        RETURN 0.0;
    END IF;

    -- Calculate weighted score
    v_final_score := 0.0;

    -- Vector similarity (if provided)
    IF p_vector_similarity IS NOT NULL THEN
        v_final_score := v_final_score + (p_vector_similarity * v_vector_weight);
    ELSE
        -- Redistribute weight if no vector similarity
        v_stability_weight := v_stability_weight + (v_vector_weight * 0.5);
        v_retrievability_weight := v_retrievability_weight + (v_vector_weight * 0.5);
    END IF;

    -- Stability factor
    v_final_score := v_final_score + (v_stability * v_stability_weight);

    -- Retrievability factor
    v_final_score := v_final_score + (v_retrievability * v_retrievability_weight);

    -- User importance (or default 0.5)
    v_final_score := v_final_score + (COALESCE(v_user_importance, 0.5) * v_user_importance_weight);

    -- AI importance (or default 0.5)
    v_final_score := v_final_score + (COALESCE(v_ai_importance, 0.5) * v_ai_importance_weight);

    -- Graph relationship boost
    IF v_has_graph THEN
        v_final_score := v_final_score + v_graph_boost;
    END IF;

    -- Normalize to [0, 1]
    v_final_score := LEAST(1.0, GREATEST(0.0, v_final_score));

    -- Cache the result for 1 hour
    UPDATE graphrag.unified_content
    SET
        relevance_score_cached = v_final_score,
        relevance_cache_expires_at = NOW() + INTERVAL '1 hour'
    WHERE id = p_content_id;

    RETURN v_final_score;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- ============================================================================
-- POST-MIGRATION VALIDATION
-- ============================================================================

DO $$
DECLARE
    column_count INTEGER;
    table_count INTEGER;
    function_count INTEGER;
BEGIN
    -- Verify columns added to unified_content
    SELECT COUNT(*) INTO column_count
    FROM information_schema.columns
    WHERE table_schema = 'graphrag'
    AND table_name = 'unified_content'
    AND column_name IN (
        'last_accessed',
        'access_count',
        'stability',
        'retrievability',
        'user_importance',
        'ai_importance',
        'has_graph_relationships',
        'relevance_score_cached',
        'relevance_cache_expires_at'
    );

    IF column_count < 9 THEN
        RAISE EXCEPTION 'Migration 012 failed: unified_content missing relevance columns (found %, expected 9)', column_count;
    END IF;

    -- Verify new tables created
    SELECT COUNT(*) INTO table_count
    FROM information_schema.tables
    WHERE table_schema = 'graphrag'
    AND table_name IN ('relevance_access_log', 'stability_history');

    IF table_count < 2 THEN
        RAISE EXCEPTION 'Migration 012 failed: relevance tracking tables not created';
    END IF;

    -- Verify functions created
    SELECT COUNT(*) INTO function_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'graphrag'
    AND p.proname IN (
        'record_content_access',
        'update_retrievability_batch',
        'calculate_relevance_score'
    );

    IF function_count < 3 THEN
        RAISE EXCEPTION 'Migration 012 failed: relevance functions not created';
    END IF;

    RAISE NOTICE 'Migration 012 completed successfully:';
    RAISE NOTICE '  - Columns: % relevance columns added to unified_content', column_count;
    RAISE NOTICE '  - Tables: % relevance tracking tables created', table_count;
    RAISE NOTICE '  - Functions: % PostgreSQL functions created', function_count;
    RAISE NOTICE '  - Nexus Memory Lens feature: ENABLED';
END $$;
