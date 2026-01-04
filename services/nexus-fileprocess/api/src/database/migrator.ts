/**
 * Database Migration Runner for FileProcessAgent
 *
 * Automatically executes SQL migrations on application startup.
 * Implements idempotent migration pattern with version tracking.
 *
 * Architecture:
 * - Reads migration files from database/migrations/
 * - Tracks applied migrations in fileprocess.schema_migrations
 * - Executes pending migrations in version order
 * - Transactional safety: ROLLBACK on failure
 *
 * Design Pattern: Command Pattern (each migration is a command)
 * SOLID Principles:
 *   - Single Responsibility: Only handles database migrations
 *   - Open/Closed: Easy to add new migrations without modifying code
 *   - Dependency Inversion: Depends on Pool abstraction, not concrete implementation
 */

import { Pool, PoolClient } from 'pg';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  filePath: string;
}

export interface MigrationResult {
  version: string;
  name: string;
  success: boolean;
  error?: string;
  executionTimeMs: number;
}

export class DatabaseMigrator {
  private readonly migrationsDir: string;

  constructor(
    private readonly pool: Pool,
    migrationsPath?: string
  ) {
    // Default: database/migrations/ relative to project root
    this.migrationsDir = migrationsPath || path.join(__dirname, '../../database/migrations');
  }

  /**
   * Run all pending migrations
   */
  async runMigrations(): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];

    try {
      // Step 1: Ensure migrations tracking table exists
      await this.createMigrationsTable();

      // Step 2: Load migration files from disk
      const migrations = await this.loadMigrations();
      console.log(`[DatabaseMigrator] Found ${migrations.length} migration files`);

      // Step 3: Get already-applied migrations
      const applied = await this.getAppliedMigrations();
      console.log(`[DatabaseMigrator] Already applied: ${applied.length} migrations`);

      // Step 4: Filter pending migrations
      const pending = migrations.filter((m) => !applied.includes(m.version));

      if (pending.length === 0) {
        console.log('[DatabaseMigrator] ✓ Database schema is up-to-date (no pending migrations)');
        return results;
      }

      console.log(`[DatabaseMigrator] Pending migrations: ${pending.length}`);

      // Step 5: Execute pending migrations in order
      for (const migration of pending) {
        const result = await this.runMigration(migration);
        results.push(result);

        if (!result.success) {
          console.error(`[DatabaseMigrator] ❌ Migration ${migration.version} failed: ${result.error}`);
          throw new Error(`Migration ${migration.version} failed: ${result.error}`);
        }

        console.log(`[DatabaseMigrator] ✓ Migration ${migration.version} applied successfully (${result.executionTimeMs}ms)`);
      }

      console.log(`[DatabaseMigrator] ✓ All migrations completed successfully`);
      return results;
    } catch (error) {
      console.error('[DatabaseMigrator] ERROR: Migration process failed', error);
      throw error;
    }
  }

  /**
   * Create schema_migrations table if it doesn't exist
   */
  private async createMigrationsTable(): Promise<void> {
    const sql = `
      CREATE SCHEMA IF NOT EXISTS fileprocess;

      CREATE TABLE IF NOT EXISTS fileprocess.schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
        ON fileprocess.schema_migrations(applied_at);
    `;

    try {
      await this.pool.query(sql);
      console.log('[DatabaseMigrator] ✓ Migrations tracking table ready');
    } catch (error) {
      console.error('[DatabaseMigrator] ERROR: Failed to create migrations table', error);
      throw error;
    }
  }

  /**
   * Load migration files from disk
   */
  private async loadMigrations(): Promise<MigrationFile[]> {
    try {
      const files = await fs.readdir(this.migrationsDir);
      const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

      const migrations: MigrationFile[] = [];

      for (const file of sqlFiles) {
        const filePath = path.join(this.migrationsDir, file);
        const sql = await fs.readFile(filePath, 'utf-8');

        // Extract version from filename (e.g., "001_create_schema.sql" → "001")
        const match = file.match(/^(\d+)_(.+)\.sql$/);
        if (!match) {
          console.warn(`[DatabaseMigrator] Skipping invalid migration filename: ${file}`);
          continue;
        }

        const [, version, name] = match;

        // Validate extracted values
        if (!version || !name) {
          console.warn(`[DatabaseMigrator] Skipping migration with missing version or name: ${file}`);
          continue;
        }

        migrations.push({
          version,
          name,
          sql,
          filePath,
        });
      }

      return migrations;
    } catch (error) {
      console.error('[DatabaseMigrator] ERROR: Failed to load migration files', error);
      throw error;
    }
  }

  /**
   * Get list of already-applied migration versions
   */
  private async getAppliedMigrations(): Promise<string[]> {
    try {
      const result = await this.pool.query(
        'SELECT version FROM fileprocess.schema_migrations ORDER BY version'
      );
      return result.rows.map((row) => row.version);
    } catch (error) {
      // If table doesn't exist yet, return empty array
      if ((error as any).code === '42P01') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Execute a single migration within a transaction
   */
  private async runMigration(migration: MigrationFile): Promise<MigrationResult> {
    const startTime = Date.now();
    let client: PoolClient | undefined;

    try {
      client = await this.pool.connect();

      // Begin transaction
      await client.query('BEGIN');

      console.log(`[DatabaseMigrator] Running migration ${migration.version}: ${migration.name}`);

      // Execute migration SQL
      await client.query(migration.sql);

      // Record migration as applied
      await client.query(
        'INSERT INTO fileprocess.schema_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );

      // Commit transaction
      await client.query('COMMIT');

      const executionTimeMs = Date.now() - startTime;

      return {
        version: migration.version,
        name: migration.name,
        success: true,
        executionTimeMs,
      };
    } catch (error) {
      // Rollback transaction on error
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('[DatabaseMigrator] ERROR: Failed to rollback transaction', rollbackError);
        }
      }

      const executionTimeMs = Date.now() - startTime;

      return {
        version: migration.version,
        name: migration.name,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs,
      };
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Get current database schema version
   */
  async getCurrentVersion(): Promise<string | null> {
    try {
      const result = await this.pool.query(
        'SELECT version FROM fileprocess.schema_migrations ORDER BY version DESC LIMIT 1'
      );
      return result.rows.length > 0 ? result.rows[0].version : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Verify database schema is healthy
   */
  async verifySchema(): Promise<boolean> {
    try {
      // Check that all expected tables exist
      const result = await this.pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'fileprocess'
        AND table_name IN ('processing_jobs', 'document_dna', 'artifacts')
      `);

      const tables = result.rows.map((row) => row.table_name);
      const expectedTables = ['processing_jobs', 'document_dna', 'artifacts'];

      const allTablesExist = expectedTables.every((t) => tables.includes(t));

      if (allTablesExist) {
        console.log('[DatabaseMigrator] ✓ Schema verification passed (all tables exist)');
        return true;
      } else {
        console.error('[DatabaseMigrator] ❌ Schema verification failed (missing tables)');
        console.error(`  Expected: ${expectedTables.join(', ')}`);
        console.error(`  Found: ${tables.join(', ')}`);
        return false;
      }
    } catch (error) {
      console.error('[DatabaseMigrator] ERROR: Schema verification failed', error);
      return false;
    }
  }
}
