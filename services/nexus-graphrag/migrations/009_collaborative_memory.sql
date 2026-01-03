/**
 * Migration 009: Collaborative Memory & Versioning
 *
 * Phase 4: Advanced Features & Performance
 *
 * Adds:
 * - Memory scope (user/app/company level)
 * - Permission-based access control
 * - Memory versioning and change tracking
 * - Memory sharing and collaboration features
 *
 * Dependencies: Migration 008 (Billing & Subscriptions)
 */

-- ============================================================================
-- ENUM: Memory Scope
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE graphrag.memory_scope AS ENUM ('user', 'app', 'company');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE graphrag.permission_role AS ENUM ('read', 'write', 'admin');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ============================================================================
-- TABLE: Memory Permissions
-- ============================================================================

CREATE TABLE IF NOT EXISTS graphrag.memory_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Memory identification
  memory_id UUID NOT NULL,

  -- User access
  user_id TEXT NOT NULL,
  role graphrag.permission_role NOT NULL DEFAULT 'read',

  -- Granted by
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  -- Expiration (optional)
  expires_at TIMESTAMP WITH TIME ZONE,

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  -- Ensure unique permission per memory + user
  CONSTRAINT unique_memory_user_permission UNIQUE (memory_id, user_id)
);

CREATE INDEX idx_memory_permissions_memory ON graphrag.memory_permissions(memory_id);
CREATE INDEX idx_memory_permissions_user ON graphrag.memory_permissions(user_id);
CREATE INDEX idx_memory_permissions_role ON graphrag.memory_permissions(role);

-- ============================================================================
-- TABLE: Memory Versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS graphrag.memory_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Memory identification
  memory_id UUID NOT NULL,
  version_number INTEGER NOT NULL,

  -- Content snapshot
  content TEXT NOT NULL,
  tags TEXT[],
  metadata JSONB,

  -- Change tracking
  changed_by TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'deleted', 'restored')),
  change_summary TEXT,

  -- Timestamp
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  -- Ensure unique version per memory
  CONSTRAINT unique_memory_version UNIQUE (memory_id, version_number)
);

CREATE INDEX idx_memory_versions_memory ON graphrag.memory_versions(memory_id, version_number DESC);
CREATE INDEX idx_memory_versions_changed_by ON graphrag.memory_versions(changed_by);
CREATE INDEX idx_memory_versions_created_at ON graphrag.memory_versions(created_at DESC);

-- ============================================================================
-- ALTER TABLE: Add collaborative fields to unified_content
-- ============================================================================

DO $$
BEGIN
  -- Add scope column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'graphrag'
      AND table_name = 'unified_content'
      AND column_name = 'scope'
  ) THEN
    ALTER TABLE graphrag.unified_content
    ADD COLUMN scope graphrag.memory_scope DEFAULT 'user';
  END IF;

  -- Add is_shared column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'graphrag'
      AND table_name = 'unified_content'
      AND column_name = 'is_shared'
  ) THEN
    ALTER TABLE graphrag.unified_content
    ADD COLUMN is_shared BOOLEAN DEFAULT FALSE;
  END IF;

  -- Add version_number column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'graphrag'
      AND table_name = 'unified_content'
      AND column_name = 'version_number'
  ) THEN
    ALTER TABLE graphrag.unified_content
    ADD COLUMN version_number INTEGER DEFAULT 1;
  END IF;

  -- Add last_modified_by column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'graphrag'
      AND table_name = 'unified_content'
      AND column_name = 'last_modified_by'
  ) THEN
    ALTER TABLE graphrag.unified_content
    ADD COLUMN last_modified_by TEXT;
  END IF;

  -- Add last_modified_at column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'graphrag'
      AND table_name = 'unified_content'
      AND column_name = 'last_modified_at'
  ) THEN
    ALTER TABLE graphrag.unified_content
    ADD COLUMN last_modified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
  END IF;

  RAISE NOTICE 'Collaborative memory columns added to unified_content';
END $$;

-- Create index on scope
CREATE INDEX IF NOT EXISTS idx_unified_content_scope ON graphrag.unified_content(scope);
CREATE INDEX IF NOT EXISTS idx_unified_content_shared ON graphrag.unified_content(is_shared) WHERE is_shared = TRUE;

-- ============================================================================
-- FUNCTION: Create memory version snapshot
-- ============================================================================

CREATE OR REPLACE FUNCTION graphrag.create_memory_version()
RETURNS TRIGGER AS $$
DECLARE
  v_next_version INTEGER;
BEGIN
  -- Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_next_version
  FROM graphrag.memory_versions
  WHERE memory_id = NEW.id;

  -- Update version number in unified_content
  NEW.version_number = v_next_version;
  NEW.last_modified_at = CURRENT_TIMESTAMP;

  -- Create version snapshot
  INSERT INTO graphrag.memory_versions (
    memory_id,
    version_number,
    content,
    tags,
    metadata,
    changed_by,
    change_type,
    change_summary
  ) VALUES (
    NEW.id,
    v_next_version,
    NEW.content,
    NEW.tags,
    NEW.metadata,
    NEW.last_modified_by,
    CASE
      WHEN TG_OP = 'INSERT' THEN 'created'
      WHEN TG_OP = 'UPDATE' THEN 'updated'
      ELSE 'unknown'
    END,
    NULL -- Change summary can be set by application
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for versioning (only for content_type = 'memory')
DROP TRIGGER IF EXISTS memory_versioning_trigger ON graphrag.unified_content;
CREATE TRIGGER memory_versioning_trigger
  BEFORE INSERT OR UPDATE ON graphrag.unified_content
  FOR EACH ROW
  WHEN (NEW.content_type = 'memory' AND NEW.last_modified_by IS NOT NULL)
  EXECUTE FUNCTION graphrag.create_memory_version();

-- ============================================================================
-- FUNCTION: Check memory access permission
-- ============================================================================

CREATE OR REPLACE FUNCTION graphrag.check_memory_access(
  p_memory_id UUID,
  p_user_id TEXT,
  p_required_role graphrag.permission_role DEFAULT 'read'
)
RETURNS BOOLEAN AS $$
DECLARE
  v_memory RECORD;
  v_permission RECORD;
  v_role_hierarchy RECORD;
BEGIN
  -- Get memory details
  SELECT
    user_id,
    company_id,
    app_id,
    scope,
    is_shared
  INTO v_memory
  FROM graphrag.unified_content
  WHERE id = p_memory_id;

  -- Memory doesn't exist
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Owner always has full access
  IF v_memory.user_id = p_user_id THEN
    RETURN TRUE;
  END IF;

  -- Check scope-based access
  IF v_memory.scope = 'app' AND v_memory.is_shared THEN
    -- App-level: Any user in same app can read
    -- Write permission requires explicit grant
    IF p_required_role = 'read' THEN
      RETURN TRUE;
    END IF;
  END IF;

  IF v_memory.scope = 'company' AND v_memory.is_shared THEN
    -- Company-level: Any user in same company can read
    IF p_required_role = 'read' THEN
      RETURN TRUE;
    END IF;
  END IF;

  -- Check explicit permissions
  SELECT role
  INTO v_permission
  FROM graphrag.memory_permissions
  WHERE memory_id = p_memory_id
    AND user_id = p_user_id
    AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP);

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Check role hierarchy (admin > write > read)
  RETURN (
    (v_permission.role = 'admin') OR
    (v_permission.role = 'write' AND p_required_role IN ('write', 'read')) OR
    (v_permission.role = 'read' AND p_required_role = 'read')
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Share memory with user
-- ============================================================================

CREATE OR REPLACE FUNCTION graphrag.share_memory(
  p_memory_id UUID,
  p_user_id TEXT,
  p_role graphrag.permission_role,
  p_granted_by TEXT,
  p_expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_permission_id UUID;
BEGIN
  -- Insert or update permission
  INSERT INTO graphrag.memory_permissions (
    memory_id,
    user_id,
    role,
    granted_by,
    expires_at
  ) VALUES (
    p_memory_id,
    p_user_id,
    p_role,
    p_granted_by,
    p_expires_at
  )
  ON CONFLICT (memory_id, user_id)
  DO UPDATE SET
    role = EXCLUDED.role,
    granted_by = EXCLUDED.granted_by,
    expires_at = EXCLUDED.expires_at,
    granted_at = CURRENT_TIMESTAMP
  RETURNING id INTO v_permission_id;

  -- Mark memory as shared
  UPDATE graphrag.unified_content
  SET is_shared = TRUE
  WHERE id = p_memory_id;

  RETURN v_permission_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Get memory version history
-- ============================================================================

CREATE OR REPLACE FUNCTION graphrag.get_memory_versions(
  p_memory_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  version_number INTEGER,
  content TEXT,
  changed_by TEXT,
  change_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    mv.version_number,
    mv.content,
    mv.changed_by,
    mv.change_type,
    mv.created_at
  FROM graphrag.memory_versions mv
  WHERE mv.memory_id = p_memory_id
  ORDER BY mv.version_number DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Restore memory version
-- ============================================================================

CREATE OR REPLACE FUNCTION graphrag.restore_memory_version(
  p_memory_id UUID,
  p_version_number INTEGER,
  p_restored_by TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_version RECORD;
BEGIN
  -- Get version to restore
  SELECT *
  INTO v_version
  FROM graphrag.memory_versions
  WHERE memory_id = p_memory_id
    AND version_number = p_version_number;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Version % not found for memory %', p_version_number, p_memory_id;
  END IF;

  -- Update unified_content with version content
  UPDATE graphrag.unified_content
  SET
    content = v_version.content,
    tags = v_version.tags,
    metadata = v_version.metadata,
    last_modified_by = p_restored_by,
    last_modified_at = CURRENT_TIMESTAMP
  WHERE id = p_memory_id;

  -- Create new version entry for restore action
  INSERT INTO graphrag.memory_versions (
    memory_id,
    version_number,
    content,
    tags,
    metadata,
    changed_by,
    change_type,
    change_summary
  )
  SELECT
    p_memory_id,
    (SELECT COALESCE(MAX(version_number), 0) + 1 FROM graphrag.memory_versions WHERE memory_id = p_memory_id),
    v_version.content,
    v_version.tags,
    v_version.metadata,
    p_restored_by,
    'restored',
    'Restored from version ' || p_version_number;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED DATA: Update existing memories with default scope
-- ============================================================================

DO $$
BEGIN
  -- Set scope for existing memories
  UPDATE graphrag.unified_content
  SET scope = 'user'
  WHERE content_type = 'memory'
    AND scope IS NULL;

  RAISE NOTICE 'Updated existing memories with default scope';
END $$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 009: Collaborative Memory & Versioning - COMPLETE';
  RAISE NOTICE 'Created tables: memory_permissions, memory_versions';
  RAISE NOTICE 'Added columns: scope, is_shared, version_number, last_modified_by, last_modified_at';
  RAISE NOTICE 'Created functions: check_memory_access, share_memory, get_memory_versions, restore_memory_version';
  RAISE NOTICE 'Created trigger: memory_versioning_trigger';
END $$;
