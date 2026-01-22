import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { config } from '../config';

export class MigrationRunner {
  private pool: Pool;
  private migrationsPath: string;

  constructor() {
    this.pool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 5
    });

    this.migrationsPath = path.join(__dirname, './migrations');
  }

  async run(): Promise<void> {
    try {
      logger.info('Starting database migrations');

      // Create migrations table if it doesn't exist
      await this.createMigrationsTable();

      // Get all migration files
      const migrationFiles = this.getMigrationFiles();

      // Get applied migrations
      const appliedMigrations = await this.getAppliedMigrations();

      // Apply pending migrations
      for (const file of migrationFiles) {
        if (!appliedMigrations.includes(file)) {
          await this.applyMigration(file);
        }
      }

      logger.info('Database migrations completed');
    } catch (error) {
      logger.error('Migration failed', { error });
      throw error;
    } finally {
      await this.pool.end();
    }
  }

  private async createMigrationsTable(): Promise<void> {
    const query = `
      CREATE TABLE IF NOT EXISTS graphrag.schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL DEFAULT '',
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;

    const client = await this.pool.connect();
    try {
      // Ensure schema exists
      await client.query('CREATE SCHEMA IF NOT EXISTS graphrag');
      
      // Create migrations table
      await client.query(query);
      logger.info('Migrations table ready');
    } finally {
      client.release();
    }
  }

  private getMigrationFiles(): string[] {
    try {
      const files = fs.readdirSync(this.migrationsPath)
        .filter(file => file.endsWith('.sql'))
        .sort(); // Ensure migrations are applied in order

      logger.info('Found migration files', { count: files.length });
      return files;
    } catch (error) {
      logger.warn('No migrations directory found', { error });
      return [];
    }
  }

  private async getAppliedMigrations(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT filename FROM graphrag.schema_migrations ORDER BY filename'
      );
      return result.rows.map(row => row.filename);
    } finally {
      client.release();
    }
  }

  private async applyMigration(filename: string): Promise<void> {
    const client = await this.pool.connect();
    const filePath = path.join(this.migrationsPath, filename);

    try {
      logger.info('Applying migration', { filename });

      // Read migration file
      const sql = fs.readFileSync(filePath, 'utf8');

      // Calculate checksum
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      // Start transaction
      await client.query('BEGIN');

      // Apply migration
      await client.query(sql);

      // Record migration with checksum
      await client.query(
        'INSERT INTO graphrag.schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum]
      );

      // Commit transaction
      await client.query('COMMIT');

      logger.info('Migration applied successfully', { filename });

      // Validate migration-specific requirements
      await this.validateMigration(client, filename);

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Migration failed', { error, filename });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate migration-specific schema changes
   * Ensures critical tables, columns, and indexes were created successfully
   */
  private async validateMigration(client: any, filename: string): Promise<void> {
    const validations: Record<string, () => Promise<void>> = {
      '001_complete_schema.sql': async () => {
        await this.validateTableExists(client, 'memories');
        await this.validateTableExists(client, 'documents');
        await this.validateTableExists(client, 'document_chunks');
        logger.info('Migration 001 validation passed: Core schema verified');
      },

      '002_universal_entity_system.sql': async () => {
        // Validate entity system tables if they exist
        const entityTableExists = await this.checkTableExists(client, 'entities');
        if (entityTableExists) {
          await this.validateTableExists(client, 'entities');
          logger.info('Migration 002 validation passed: Entity system verified');
        } else {
          logger.warn('Migration 002: Entity table not found, skipping validation');
        }
      },

      '003_unified_content_table.sql': async () => {
        // Critical validation for unified_content table
        await this.validateTableExists(client, 'unified_content');
        await this.validateColumnExists(client, 'unified_content', 'content_type');
        await this.validateColumnExists(client, 'unified_content', 'content');
        await this.validateColumnExists(client, 'unified_content', 'embedding_generated');
        await this.validateColumnExists(client, 'unified_content', 'metadata');
        await this.validateColumnExists(client, 'unified_content', 'tags');

        // Validate critical indexes
        await this.validateIndexExists(client, 'idx_unified_content_type');
        await this.validateIndexExists(client, 'idx_unified_content_tags');

        logger.info('Migration 003 validation passed: Unified content schema verified');
      }
    };

    const validator = validations[filename];
    if (validator) {
      try {
        await validator();
      } catch (validationError: any) {
        logger.error('Migration validation failed', {
          filename,
          error: validationError.message
        });
        throw new Error(
          `Migration ${filename} validation failed: ${validationError.message}. ` +
          `The migration was applied but schema verification failed. ` +
          `Please check database state manually.`
        );
      }
    } else {
      logger.info('No specific validation defined for migration', { filename });
    }
  }

  /**
   * Check if a table exists (returns boolean, doesn't throw)
   */
  private async checkTableExists(client: any, tableName: string): Promise<boolean> {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'graphrag' AND table_name = $1
      )`,
      [tableName]
    );
    return result.rows[0].exists;
  }

  /**
   * Validate that a table exists (throws if not found)
   */
  private async validateTableExists(client: any, tableName: string): Promise<void> {
    const exists = await this.checkTableExists(client, tableName);

    if (!exists) {
      throw new Error(
        `Required table 'graphrag.${tableName}' does not exist. ` +
        `Migration failed to create expected schema.`
      );
    }
  }

  /**
   * Validate that a column exists in a table
   */
  private async validateColumnExists(
    client: any,
    tableName: string,
    columnName: string
  ): Promise<void> {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'graphrag'
        AND table_name = $1
        AND column_name = $2
      )`,
      [tableName, columnName]
    );

    if (!result.rows[0].exists) {
      throw new Error(
        `Required column '${columnName}' does not exist in 'graphrag.${tableName}'. ` +
        `Migration failed to create expected column.`
      );
    }
  }

  /**
   * Validate that an index exists
   */
  private async validateIndexExists(client: any, indexName: string): Promise<void> {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'graphrag' AND indexname = $1
      )`,
      [indexName]
    );

    if (!result.rows[0].exists) {
      throw new Error(
        `Required index '${indexName}' does not exist. ` +
        `Migration failed to create expected index.`
      );
    }
  }

  async checkConnection(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      logger.info('Database connection successful');
      return true;
    } catch (error) {
      logger.error('Database connection failed', { error });
      return false;
    }
  }

  async reset(): Promise<void> {
    const client = await this.pool.connect();
    try {
      logger.warn('Resetting database schema - this will delete all data!');
      
      await client.query('BEGIN');
      
      // Drop schema cascade
      await client.query('DROP SCHEMA IF EXISTS graphrag CASCADE');
      
      // Recreate schema
      await client.query('CREATE SCHEMA graphrag');
      
      await client.query('COMMIT');
      
      logger.info('Database schema reset complete');
      
      // Run migrations
      await this.run();
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Database reset failed', { error });
      throw error;
    } finally {
      client.release();
    }
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  const runner = new MigrationRunner();
  
  const command = process.argv[2];
  
  switch (command) {
    case 'reset':
      runner.reset()
        .then(() => process.exit(0))
        .catch(error => {
          console.error('Reset failed:', error);
          process.exit(1);
        });
      break;
      
    case 'check':
      runner.checkConnection()
        .then(connected => process.exit(connected ? 0 : 1))
        .catch(() => process.exit(1));
      break;
      
    default:
      runner.run()
        .then(() => process.exit(0))
        .catch(error => {
          console.error('Migration failed:', error);
          process.exit(1);
        });
  }
}
