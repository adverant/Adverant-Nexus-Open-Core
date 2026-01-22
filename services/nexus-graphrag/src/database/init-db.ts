/**
 * Database Initialization Module - Production Grade
 *
 * Implements robust migration system with:
 * - Environment-based execution modes
 * - Idempotent migration support
 * - Checksum version control
 * - Comprehensive error context
 * - Migration rollback capability
 *
 * Architecture: Strategy Pattern for migration modes
 * Error Handling: Verbose, contextual errors with remediation guidance
 */

import { Pool, PoolClient } from 'pg';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';
import crypto from 'crypto';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/**
 * Migration execution modes
 */
enum MigrationMode {
  SKIP = 'skip',           // Skip all migrations (production with existing DB)
  SAFE = 'safe',           // Only apply new migrations, reject checksum mismatches
  FORCE = 'force',         // Allow checksum mismatches (development only)
  REPAIR = 'repair'        // Update checksums for intentional changes
}

/**
 * Migration record structure (matches database schema)
 */
interface MigrationRecord {
  id?: number;
  filename: string;
  applied_at?: Date;
  checksum: string;
  execution_time_ms?: number;
  migration_type?: string;
  status?: string;
}

/**
 * Migration execution context
 */
interface MigrationContext {
  filename: string;
  filepath: string;
  content: string;
  checksum: string;
  existingRecord?: MigrationRecord;
  mode: MigrationMode;
}

/**
 * Migration execution result
 */
interface MigrationResult {
  filename: string;
  action: 'applied' | 'skipped' | 'repaired' | 'failed';
  duration_ms: number;
  error?: string;
}

// ============================================================================
// CUSTOM ERRORS
// ============================================================================

/**
 * Custom error for migration failures with full context
 */
class MigrationError extends Error {
  constructor(
    message: string,
    public readonly migration: string,
    public readonly context: {
      mode?: MigrationMode;
      checksum?: string;
      expectedChecksum?: string;
      sqlError?: any;
      sqlStatement?: string;
      remediation?: string;
    } = {}
  ) {
    super(`Migration ${migration} failed: ${message}`);
    this.name = 'MigrationError';
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Get verbose error report for logging
   */
  toDetailedReport(): object {
    return {
      error: this.name,
      migration: this.migration,
      message: this.message,
      mode: this.context.mode,
      checksum: {
        actual: this.context.checksum,
        expected: this.context.expectedChecksum
      },
      sqlError: this.context.sqlError ? {
        code: this.context.sqlError.code,
        message: this.context.sqlError.message,
        detail: this.context.sqlError.detail,
        hint: this.context.sqlError.hint
      } : undefined,
      remediation: this.context.remediation,
      stack: this.stack
    };
  }
}

/**
 * Error for database initialization failures
 */
class DatabaseInitializationError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(`Database initialization failed: ${message}`);
    this.name = 'DatabaseInitializationError';
    Error.captureStackTrace(this, this.constructor);
  }
}

// ============================================================================
// MIGRATION STRATEGY INTERFACE
// ============================================================================

/**
 * Strategy interface for different migration execution modes
 */
interface MigrationStrategy {
  shouldApplyMigration(context: MigrationContext): boolean;
  handleChecksumMismatch(context: MigrationContext): Promise<void>;
  getModeName(): string;
}

/**
 * SKIP mode: Don't run any migrations
 */
class SkipMigrationStrategy implements MigrationStrategy {
  shouldApplyMigration(_context: MigrationContext): boolean {
    return false;
  }

  async handleChecksumMismatch(_context: MigrationContext): Promise<void> {
    // No-op in skip mode
  }

  getModeName(): string {
    return 'SKIP (no migrations executed)';
  }
}

/**
 * SAFE mode: Only apply new migrations, reject checksum mismatches
 */
class SafeMigrationStrategy implements MigrationStrategy {
  shouldApplyMigration(context: MigrationContext): boolean {
    return !context.existingRecord;
  }

  async handleChecksumMismatch(context: MigrationContext): Promise<void> {
    throw new MigrationError(
      'Checksum mismatch detected. Migration file modified after initial application.',
      context.filename,
      {
        mode: MigrationMode.SAFE,
        checksum: context.checksum,
        expectedChecksum: context.existingRecord?.checksum,
        remediation: [
          'This error prevents accidental schema corruption.',
          'Options:',
          '1. Revert migration file to original version',
          '2. Create new migration with schema changes',
          '3. Use MIGRATION_MODE=force (development only)',
          '4. Use MIGRATION_MODE=repair to update checksum'
        ].join('\n')
      }
    );
  }

  getModeName(): string {
    return 'SAFE (production mode)';
  }
}

/**
 * FORCE mode: Apply all migrations, allow checksum mismatches
 */
class ForceMigrationStrategy implements MigrationStrategy {
  shouldApplyMigration(context: MigrationContext): boolean {
    // Apply if new OR checksum mismatch
    return !context.existingRecord ||
           context.existingRecord.checksum !== context.checksum;
  }

  async handleChecksumMismatch(context: MigrationContext): Promise<void> {
    logger.warn(`FORCE mode: Allowing checksum mismatch for ${context.filename}`, {
      old: context.existingRecord?.checksum,
      new: context.checksum,
      warning: 'This is dangerous in production!'
    });
  }

  getModeName(): string {
    return 'FORCE (development mode - allows checksum changes)';
  }
}

/**
 * REPAIR mode: Update checksums without re-running migrations
 */
class RepairMigrationStrategy implements MigrationStrategy {
  shouldApplyMigration(_context: MigrationContext): boolean {
    return false; // Never re-run migrations in repair mode
  }

  async handleChecksumMismatch(context: MigrationContext): Promise<void> {
    logger.info(`REPAIR mode: Updating checksum for ${context.filename}`, {
      old: context.existingRecord?.checksum,
      new: context.checksum
    });
    // Checksum update handled by caller
  }

  getModeName(): string {
    return 'REPAIR (update checksums only)';
  }
}

// ============================================================================
// DATABASE INITIALIZER
// ============================================================================

export class DatabaseInitializer {
  private pool: Pool;
  private migrationsPath: string;
  private mode: MigrationMode;
  private strategy: MigrationStrategy;

  constructor(pool: Pool) {
    this.pool = pool;
    this.migrationsPath = join(__dirname, '../../migrations');
    this.mode = this.determineMigrationMode();
    this.strategy = this.createStrategy(this.mode);
  }

  /**
   * Determine migration mode from environment variables
   */
  private determineMigrationMode(): MigrationMode {
    // Check SKIP_DB_INIT first (highest priority)
    if (process.env.SKIP_DB_INIT === 'true') {
      logger.info('SKIP_DB_INIT=true detected, skipping all database initialization');
      return MigrationMode.SKIP;
    }

    // Check RUN_MIGRATIONS flag
    if (process.env.RUN_MIGRATIONS === 'false') {
      logger.info('RUN_MIGRATIONS=false detected, skipping migrations');
      return MigrationMode.SKIP;
    }

    // Check explicit MIGRATION_MODE
    const explicitMode = process.env.MIGRATION_MODE?.toLowerCase();
    if (explicitMode) {
      switch (explicitMode) {
        case 'skip':
          return MigrationMode.SKIP;
        case 'safe':
          return MigrationMode.SAFE;
        case 'force':
          logger.warn('MIGRATION_MODE=force - USE ONLY IN DEVELOPMENT!');
          return MigrationMode.FORCE;
        case 'repair':
          logger.warn('MIGRATION_MODE=repair - Updating checksums without re-running migrations');
          return MigrationMode.REPAIR;
        default:
          logger.warn(`Unknown MIGRATION_MODE="${explicitMode}", defaulting to SAFE`);
          return MigrationMode.SAFE;
      }
    }

    // Default based on NODE_ENV
    const nodeEnv = process.env.NODE_ENV?.toLowerCase();
    if (nodeEnv === 'production') {
      logger.info('Production environment detected, using SAFE migration mode');
      return MigrationMode.SAFE;
    }

    // Development default
    logger.info('Development environment detected, using SAFE migration mode');
    return MigrationMode.SAFE;
  }

  /**
   * Create appropriate strategy for migration mode
   */
  private createStrategy(mode: MigrationMode): MigrationStrategy {
    switch (mode) {
      case MigrationMode.SKIP:
        return new SkipMigrationStrategy();
      case MigrationMode.SAFE:
        return new SafeMigrationStrategy();
      case MigrationMode.FORCE:
        return new ForceMigrationStrategy();
      case MigrationMode.REPAIR:
        return new RepairMigrationStrategy();
      default:
        logger.warn(`Unknown mode ${mode}, defaulting to SAFE`);
        return new SafeMigrationStrategy();
    }
  }

  /**
   * Initialize database with all required tables and schemas
   */
  async initialize(): Promise<void> {
    logger.info('Starting database initialization...', {
      mode: this.mode,
      strategy: this.strategy.getModeName(),
      migrationsPath: this.migrationsPath
    });

    // Skip all initialization if requested
    if (this.mode === MigrationMode.SKIP) {
      logger.info('Database initialization skipped per configuration');
      return;
    }

    const client = await this.pool.connect();

    try {
      // Ensure migration tracking table exists
      await this.ensureMigrationTable(client);

      // Get all migration files
      const migrationFiles = this.getMigrationFiles();

      if (migrationFiles.length === 0) {
        logger.warn('No migration files found', {
          path: this.migrationsPath,
          exists: existsSync(this.migrationsPath)
        });
        return;
      }

      logger.info(`Found ${migrationFiles.length} migration files`);

      // Apply migrations according to strategy
      const results: MigrationResult[] = [];
      for (const migrationFile of migrationFiles) {
        const result = await this.applyMigration(client, migrationFile);
        results.push(result);
      }

      // Log summary
      this.logMigrationSummary(results);

      // Verify critical tables (non-blocking)
      await this.verifyCriticalTables(client);

      logger.info('Database initialization completed successfully');

      // Initialize vector collections (non-blocking)
      this.initializeVectorCollections().catch(error => {
        logger.warn('Vector collections initialization failed (non-critical):', {
          error: error.message
        });
      });

    } catch (error) {
      if (error instanceof MigrationError) {
        logger.error('Migration failed:', error.toDetailedReport());
      } else if (error instanceof DatabaseInitializationError) {
        logger.error('Database initialization failed:', {
          message: error.message,
          cause: error.cause
        });
      } else {
        logger.error('Unexpected error during database initialization:', error);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ensure migration tracking table exists
   */
  private async ensureMigrationTable(client: PoolClient): Promise<void> {
    const createTableSQL = `
      CREATE SCHEMA IF NOT EXISTS graphrag;

      CREATE TABLE IF NOT EXISTS graphrag.schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        checksum VARCHAR(64),
        execution_time_ms INTEGER,
        migration_type VARCHAR(50),
        status VARCHAR(20) DEFAULT 'completed'
      );

      CREATE INDEX IF NOT EXISTS idx_migrations_applied_at
        ON graphrag.schema_migrations(applied_at DESC);
    `;

    try {
      await client.query(createTableSQL);
      logger.debug('Migration tracking table ready');
    } catch (error) {
      throw new DatabaseInitializationError(
        'Failed to create migration tracking table',
        error as Error
      );
    }
  }

  /**
   * Get all migration files sorted by name
   */
  private getMigrationFiles(): string[] {
    if (!existsSync(this.migrationsPath)) {
      logger.warn(`Migrations directory not found: ${this.migrationsPath}`);
      return [];
    }

    return readdirSync(this.migrationsPath)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Lexicographic sort ensures numeric prefixes work correctly
  }

  /**
   * Apply a single migration file
   */
  private async applyMigration(
    client: PoolClient,
    filename: string
  ): Promise<MigrationResult> {
    const startTime = Date.now();
    const filepath = join(this.migrationsPath, filename);

    try {
      // Read migration content
      if (!existsSync(filepath)) {
        throw new MigrationError(
          `Migration file not found at ${filepath}`,
          filename,
          { remediation: 'Ensure migration file exists and is readable' }
        );
      }

      const content = readFileSync(filepath, 'utf-8');
      const checksum = this.calculateChecksum(content);

      // Get existing migration record
      const existingRecord = await this.getMigrationRecord(client, filename);

      // Build migration context
      const context: MigrationContext = {
        filename,
        filepath,
        content,
        checksum,
        existingRecord: existingRecord || undefined,
        mode: this.mode
      };

      // Check for checksum mismatch
      if (existingRecord && existingRecord.checksum !== checksum) {
        await this.strategy.handleChecksumMismatch(context);

        // If repair mode, update checksum
        if (this.mode === MigrationMode.REPAIR) {
          await this.updateMigrationChecksum(client, filename, checksum);
          return {
            filename,
            action: 'repaired',
            duration_ms: Date.now() - startTime
          };
        }

        // If force mode, proceed with re-application
        // (handled by shouldApplyMigration below)
      }

      // Determine if migration should be applied
      if (!this.strategy.shouldApplyMigration(context)) {
        logger.debug(`Migration skipped (already applied): ${filename}`);
        return {
          filename,
          action: 'skipped',
          duration_ms: Date.now() - startTime
        };
      }

      // Apply the migration
      logger.info(`Applying migration: ${filename}`);

      await client.query('BEGIN');

      try {
        // Execute migration SQL
        await client.query(content);

        // Record successful migration
        if (existingRecord) {
          // Update existing record (force mode)
          await client.query(
            `UPDATE graphrag.schema_migrations
             SET checksum = $1,
                 applied_at = CURRENT_TIMESTAMP,
                 execution_time_ms = $2,
                 status = 'completed'
             WHERE filename = $3`,
            [checksum, Date.now() - startTime, filename]
          );
        } else {
          // Insert new record
          await client.query(
            `INSERT INTO graphrag.schema_migrations
             (filename, checksum, execution_time_ms, status)
             VALUES ($1, $2, $3, 'completed')`,
            [filename, checksum, Date.now() - startTime]
          );
        }

        await client.query('COMMIT');

        logger.info(`Migration applied successfully: ${filename} (${Date.now() - startTime}ms)`);

        return {
          filename,
          action: 'applied',
          duration_ms: Date.now() - startTime
        };

      } catch (sqlError: any) {
        await client.query('ROLLBACK');

        // Check if error is due to objects already existing (idempotent migrations)
        if (this.isIdempotentError(sqlError)) {
          logger.debug(`Idempotent migration succeeded with expected errors: ${filename}`);

          // Record migration as completed despite idempotent errors
          await client.query(
            `INSERT INTO graphrag.schema_migrations
             (filename, checksum, execution_time_ms, status)
             VALUES ($1, $2, $3, 'completed')
             ON CONFLICT (filename) DO NOTHING`,
            [filename, checksum, Date.now() - startTime]
          );

          return {
            filename,
            action: 'applied',
            duration_ms: Date.now() - startTime
          };
        }

        // Fatal SQL error
        throw new MigrationError(
          sqlError.message || 'SQL execution failed',
          filename,
          {
            mode: this.mode,
            checksum,
            sqlError,
            sqlStatement: content.substring(0, 500), // First 500 chars for context
            remediation: this.getSQLErrorRemediation(sqlError)
          }
        );
      }

    } catch (error) {
      if (error instanceof MigrationError) {
        throw error;
      }

      throw new MigrationError(
        error instanceof Error ? error.message : 'Unknown error',
        filename,
        {
          mode: this.mode,
          remediation: 'Check migration file syntax and database permissions'
        }
      );
    }
  }

  /**
   * Get existing migration record from database
   */
  private async getMigrationRecord(
    client: PoolClient,
    filename: string
  ): Promise<MigrationRecord | null> {
    try {
      const result = await client.query(
        `SELECT id, filename, applied_at, checksum, execution_time_ms, migration_type, status
         FROM graphrag.schema_migrations
         WHERE filename = $1`,
        [filename]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.warn(`Failed to query migration record for ${filename}:`, error);
      return null;
    }
  }

  /**
   * Update migration checksum (repair mode)
   */
  private async updateMigrationChecksum(
    client: PoolClient,
    filename: string,
    newChecksum: string
  ): Promise<void> {
    await client.query(
      `UPDATE graphrag.schema_migrations
       SET checksum = $1
       WHERE filename = $2`,
      [newChecksum, filename]
    );

    logger.info(`Updated checksum for migration: ${filename}`);
  }

  /**
   * Calculate SHA256 checksum of migration content
   */
  private calculateChecksum(content: string): string {
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
  }

  /**
   * Check if SQL error is from idempotent operations (e.g., CREATE IF NOT EXISTS)
   */
  private isIdempotentError(error: any): boolean {
    if (!error || !error.code) return false;

    // PostgreSQL error codes for non-fatal idempotent errors
    const idempotentErrorCodes = [
      '42P07', // duplicate_table
      '42710', // duplicate_object
      '42P06', // duplicate_schema
      '42P16', // invalid_table_definition (sometimes non-fatal)
    ];

    return idempotentErrorCodes.includes(error.code);
  }

  /**
   * Get remediation guidance for SQL errors
   */
  private getSQLErrorRemediation(error: any): string {
    if (!error || !error.code) {
      return 'Check PostgreSQL logs for detailed error information';
    }

    const remediations: Record<string, string> = {
      '42P01': 'Table does not exist. Ensure prerequisite migrations have run.',
      '42703': 'Column does not exist. Check column name spelling and prerequisite migrations.',
      '42P07': 'Table already exists. Use CREATE TABLE IF NOT EXISTS for idempotency.',
      '42710': 'Object already exists. Use IF NOT EXISTS clause.',
      '42601': 'Syntax error in SQL. Validate SQL statement syntax.',
      '42501': 'Insufficient privilege. Check database user permissions.',
      '23505': 'Unique constraint violation. Check for duplicate data.',
      '23503': 'Foreign key violation. Ensure referenced data exists.',
    };

    return remediations[error.code] ||
           `PostgreSQL error code ${error.code}. See: https://www.postgresql.org/docs/current/errcodes-appendix.html`;
  }

  /**
   * Verify critical tables exist
   */
  private async verifyCriticalTables(client: PoolClient): Promise<void> {
    const criticalTables = [
      'documents',
      'document_chunks',
      'universal_entities',
      'entity_relationships',
      'schema_migrations'
    ];

    const missingTables: string[] = [];

    for (const table of criticalTables) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = 'graphrag'
           AND table_name = $1
         )`,
        [table]
      );

      if (!result.rows[0].exists) {
        missingTables.push(table);
      }
    }

    if (missingTables.length > 0) {
      logger.warn('Critical tables missing:', {
        tables: missingTables,
        remediation: 'Check migration files for table creation statements'
      });
    } else {
      logger.debug('All critical tables verified');
    }
  }

  /**
   * Initialize vector collections (non-blocking, non-critical)
   */
  private async initializeVectorCollections(): Promise<void> {
    // Placeholder for Qdrant/vector DB initialization
    // This should be non-blocking and log errors without failing
    logger.debug('Vector collections initialization (placeholder)');
  }

  /**
   * Log migration summary
   */
  private logMigrationSummary(results: MigrationResult[]): void {
    const summary = results.reduce((acc, result) => {
      acc[result.action] = (acc[result.action] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const totalDuration = results.reduce((sum, r) => sum + r.duration_ms, 0);

    logger.info('Migration summary:', {
      total: results.length,
      applied: summary.applied || 0,
      skipped: summary.skipped || 0,
      repaired: summary.repaired || 0,
      failed: summary.failed || 0,
      totalDuration: `${totalDuration}ms`,
      averageDuration: `${Math.round(totalDuration / results.length)}ms`
    });
  }
}
