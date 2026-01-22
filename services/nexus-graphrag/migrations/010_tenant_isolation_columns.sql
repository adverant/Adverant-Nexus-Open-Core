-- ============================================================================
-- Migration 010: Add Tenant Isolation Columns to unified_content
-- ============================================================================
-- Purpose: Add company_id and app_id columns for multi-tenant data isolation
-- Fixes: Critical security vulnerability allowing cross-tenant data access
-- Related: Phase 2 user-level isolation (migration 006)
-- Date: 2025-11-18
-- ============================================================================

BEGIN;

-- Step 1: Add tenant isolation columns
-- These columns enable multi-tenant data isolation at the database level
ALTER TABLE graphrag.unified_content
  ADD COLUMN IF NOT EXISTS company_id VARCHAR(255) NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS app_id VARCHAR(255) NOT NULL DEFAULT 'system';

-- Step 2: Backfill existing data
-- All existing records are assigned to 'system' tenant for backward compatibility
UPDATE graphrag.unified_content
SET company_id = 'system', app_id = 'system'
WHERE company_id IS NULL OR app_id IS NULL;

-- Step 3: Create indexes for tenant queries
-- These indexes optimize tenant-filtered queries
CREATE INDEX IF NOT EXISTS idx_unified_content_tenant
  ON graphrag.unified_content(company_id, app_id);

CREATE INDEX IF NOT EXISTS idx_unified_content_full_isolation
  ON graphrag.unified_content(company_id, app_id, user_id);

-- Step 4: Create composite index for content type + tenant filtering
CREATE INDEX IF NOT EXISTS idx_unified_content_type_tenant
  ON graphrag.unified_content(content_type, company_id, app_id);

-- Step 5: Update existing RLS policies to include tenant filtering
-- Drop old policy if it exists
DROP POLICY IF EXISTS tenant_user_isolation_unified_content ON graphrag.unified_content;

-- Create new comprehensive RLS policy for SELECT
CREATE POLICY tenant_user_isolation_unified_content ON graphrag.unified_content
  FOR SELECT
  USING (
    -- Tenant-level isolation
    company_id = current_setting('graphrag.company_id', true)::text
    AND app_id = current_setting('graphrag.app_id', true)::text
    AND (
      -- User-level isolation (with system user bypass)
      user_id = current_setting('graphrag.user_id', true)::text
      OR user_id = 'system'
      OR user_id IS NULL  -- Backward compatibility
    )
  );

-- Create RLS policy for INSERT
DROP POLICY IF EXISTS tenant_user_insert_unified_content ON graphrag.unified_content;

CREATE POLICY tenant_user_insert_unified_content ON graphrag.unified_content
  FOR INSERT
  WITH CHECK (
    company_id = current_setting('graphrag.company_id', true)::text
    AND app_id = current_setting('graphrag.app_id', true)::text
    AND (
      user_id = current_setting('graphrag.user_id', true)::text
      OR user_id = 'system'
      OR user_id IS NULL
    )
  );

-- Create RLS policy for UPDATE
DROP POLICY IF EXISTS tenant_user_update_unified_content ON graphrag.unified_content;

CREATE POLICY tenant_user_update_unified_content ON graphrag.unified_content
  FOR UPDATE
  USING (
    company_id = current_setting('graphrag.company_id', true)::text
    AND app_id = current_setting('graphrag.app_id', true)::text
    AND (
      user_id = current_setting('graphrag.user_id', true)::text
      OR user_id = 'system'
      OR user_id IS NULL
    )
  )
  WITH CHECK (
    company_id = current_setting('graphrag.company_id', true)::text
    AND app_id = current_setting('graphrag.app_id', true)::text
    AND (
      user_id = current_setting('graphrag.user_id', true)::text
      OR user_id = 'system'
      OR user_id IS NULL
    )
  );

-- Create RLS policy for DELETE
DROP POLICY IF EXISTS tenant_user_delete_unified_content ON graphrag.unified_content;

CREATE POLICY tenant_user_delete_unified_content ON graphrag.unified_content
  FOR DELETE
  USING (
    company_id = current_setting('graphrag.company_id', true)::text
    AND app_id = current_setting('graphrag.app_id', true)::text
    AND (
      user_id = current_setting('graphrag.user_id', true)::text
      OR user_id = 'system'
      OR user_id IS NULL
    )
  );

-- Step 6: Enable RLS on the table (if not already enabled)
ALTER TABLE graphrag.unified_content ENABLE ROW LEVEL SECURITY;

-- Step 7: Record migration in schema_migrations table
INSERT INTO graphrag.schema_migrations (filename, checksum, migration_type, status)
VALUES (
  '010_tenant_isolation_columns.sql',
  'abc123def456',  -- Checksum placeholder
  'schema',
  'completed'
)
ON CONFLICT (filename) DO NOTHING;

COMMIT;

-- ============================================================================
-- Verification Queries
-- ============================================================================
-- Run these after migration to verify success:
--
-- 1. Check columns exist:
--    \d graphrag.unified_content
--
-- 2. Check indexes created:
--    \di graphrag.idx_unified_content_*
--
-- 3. Check RLS policies:
--    \dRp graphrag.unified_content
--
-- 4. Verify data backfill:
--    SELECT count(*) FROM graphrag.unified_content WHERE company_id = 'system';
--
-- ============================================================================
