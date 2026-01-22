/**
 * PostgreSQL Manager
 * Handles PostgreSQL connection pooling, transactions, and queries
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import { createLogger } from '@adverant/logger';
import { createRetry } from '@adverant/resilience';
import type { PostgresConfig, TransactionContext, HealthCheckResult } from '../types';

const logger = createLogger({ service: 'adverant-database' });

export class PostgresManager {
  private pool: Pool | null = null;
  private config: PostgresConfig;
  private retry = createRetry({
    maxRetries: 3,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
  });

  constructor(config: PostgresConfig) {
    this.config = config;
  }

  /**
   * Initialize PostgreSQL connection pool
   */
  async initialize(): Promise<void> {
    try {
      const poolConfig: PoolConfig = {
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        max: this.config.max || 20,
        idleTimeoutMillis: this.config.idleTimeoutMillis || 30000,
        connectionTimeoutMillis: this.config.connectionTimeoutMillis || 10000,
      };

      if (this.config.ssl !== undefined) {
        poolConfig.ssl = this.config.ssl;
      }

      this.pool = new Pool(poolConfig);

      // Set up event listeners
      this.pool.on('error', (err) => {
        logger.error('PostgreSQL pool error', { error: err.message });
      });

      this.pool.on('connect', () => {
        logger.debug('PostgreSQL client connected');
      });

      this.pool.on('remove', () => {
        logger.debug('PostgreSQL client removed');
      });

      // Test connection
      const result = await this.retry.execute(async () => {
        if (!this.pool) throw new Error('Pool not initialized');
        const client = await this.pool.connect();
        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }
      });

      logger.info('PostgreSQL connected successfully', {
        host: this.config.host,
        database: this.config.database,
      });

      // Set schema if provided
      if (this.config.schema) {
        await this.setSearchPath(this.config.schema);
      }
    } catch (error) {
      logger.error('PostgreSQL initialization failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        host: this.config.host,
      });
      throw error;
    }
  }

  /**
   * Execute a query
   */
  async query<T = any>(text: string, values?: any[]): Promise<{ rows: T[]; rowCount: number }> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized');
    }

    try {
      const result = await this.pool.query(text, values);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount || 0,
      };
    } catch (error) {
      logger.error('PostgreSQL query error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query: text.substring(0, 100),
      });
      throw error;
    }
  }

  /**
   * Get a client from the pool
   */
  async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized');
    }
    return this.pool.connect();
  }

  /**
   * Execute a transaction
   */
  async transaction<T>(
    callback: (context: TransactionContext) => Promise<T>
  ): Promise<T> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized');
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const context: TransactionContext = {
        client,
        commit: async () => {
          await client.query('COMMIT');
        },
        rollback: async () => {
          await client.query('ROLLBACK');
        },
      };

      const result = await callback(context);
      await context.commit();
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Transaction failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Set search path (schema)
   */
  private async setSearchPath(schema: string): Promise<void> {
    if (!this.pool) {
      throw new Error('PostgreSQL pool not initialized');
    }

    try {
      await this.query(`SET search_path TO ${schema}, public`);
      logger.debug('Search path set', { schema });
    } catch (error) {
      logger.warn('Failed to set search path', {
        schema,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.pool) {
      return {
        healthy: false,
        error: 'Pool not initialized',
      };
    }

    const startTime = Date.now();

    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        const latency = Date.now() - startTime;

        return {
          healthy: true,
          latency,
          details: {
            totalCount: this.pool.totalCount,
            idleCount: this.pool.idleCount,
            waitingCount: this.pool.waitingCount,
          },
        };
      } finally {
        client.release();
      }
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Close all connections
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info('PostgreSQL connections closed');
    }
  }

  /**
   * Get the underlying pool (for advanced usage)
   */
  getPool(): Pool | null {
    return this.pool;
  }
}
