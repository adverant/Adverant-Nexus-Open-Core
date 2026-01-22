/**
 * Neo4j Manager
 * Handles Neo4j driver initialization and session management
 */

import neo4j, { Driver, Session, auth, Config } from 'neo4j-driver';
import { createLogger } from '@adverant/logger';
import { createRetry } from '@adverant/resilience';
import type { Neo4jConfig, HealthCheckResult } from '../types';

const logger = createLogger({ service: 'adverant-database' });

export class Neo4jManager {
  private driver: Driver | null = null;
  private config: Neo4jConfig;
  private retry = createRetry({
    maxRetries: 3,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
  });

  constructor(config: Neo4jConfig) {
    this.config = config;
  }

  /**
   * Initialize Neo4j driver
   */
  async initialize(): Promise<void> {
    try {
      const driverConfig: Config = {
        maxConnectionPoolSize: this.config.maxConnectionPoolSize || 100,
        connectionAcquisitionTimeout: this.config.connectionAcquisitionTimeout || 120000, // Increased to 2 minutes for ARM64
        connectionTimeout: this.config.connectionTimeout || 60000, // Increased to 1 minute for ARM64
        maxTransactionRetryTime: this.config.maxTransactionRetryTime || 30000,
        encrypted: this.config.encrypted !== undefined ? this.config.encrypted : false,
      };

      if (this.config.trustStrategy) {
        driverConfig.trust = this.config.trustStrategy as any;
      }

      this.driver = neo4j.driver(
        this.config.uri,
        auth.basic(this.config.username, this.config.password),
        driverConfig
      );

      // Test connection
      await this.retry.execute(async () => {
        if (!this.driver) throw new Error('Driver not initialized');
        await this.driver.verifyConnectivity();
      });

      logger.info('Neo4j connected successfully', {
        uri: this.config.uri,
        database: this.config.database,
      });
    } catch (error) {
      logger.error('Neo4j initialization failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        uri: this.config.uri,
      });
      throw error;
    }
  }

  /**
   * Get a Neo4j session
   */
  getSession(database?: string): Session {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    const sessionConfig: { database?: string } = {};

    if (database || this.config.database) {
      sessionConfig.database = database || this.config.database;
    }

    return this.driver.session(sessionConfig);
  }

  /**
   * Execute a Cypher query
   */
  async query<T = any>(
    cypher: string,
    parameters?: Record<string, any>,
    database?: string
  ): Promise<T[]> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    const session = this.getSession(database);

    try {
      const result = await session.run(cypher, parameters);
      return result.records.map((record) => record.toObject() as T);
    } catch (error) {
      logger.error('Neo4j query error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query: cypher.substring(0, 100),
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a read transaction
   */
  async readTransaction<T = any>(
    work: (tx: any) => Promise<T>,
    database?: string
  ): Promise<T> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    const session = this.getSession(database);

    try {
      return await session.executeRead(work);
    } catch (error) {
      logger.error('Neo4j read transaction error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a write transaction
   */
  async writeTransaction<T = any>(
    work: (tx: any) => Promise<T>,
    database?: string
  ): Promise<T> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    const session = this.getSession(database);

    try {
      return await session.executeWrite(work);
    } catch (error) {
      logger.error('Neo4j write transaction error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a batch of queries in a transaction
   */
  async executeBatch(
    queries: Array<{ cypher: string; parameters?: Record<string, any> }>,
    database?: string
  ): Promise<void> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    const session = this.getSession(database);

    try {
      await session.executeWrite(async (tx) => {
        for (const { cypher, parameters } of queries) {
          await tx.run(cypher, parameters);
        }
      });
    } catch (error) {
      logger.error('Neo4j batch execution error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        batchSize: queries.length,
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Create indexes
   */
  async createIndex(
    label: string,
    property: string,
    indexType: 'BTREE' | 'TEXT' | 'POINT' = 'BTREE',
    database?: string
  ): Promise<void> {
    const indexName = `idx_${label}_${property}`.toLowerCase();
    const cypher = `CREATE INDEX ${indexName} IF NOT EXISTS FOR (n:${label}) ON (n.${property})`;

    await this.query(cypher, {}, database);
    logger.debug('Neo4j index created', { label, property, indexType });
  }

  /**
   * Create constraint
   */
  async createConstraint(
    label: string,
    property: string,
    constraintType: 'UNIQUE' | 'EXISTS' = 'UNIQUE',
    database?: string
  ): Promise<void> {
    const constraintName = `constraint_${label}_${property}`.toLowerCase();

    let cypher: string;
    if (constraintType === 'UNIQUE') {
      cypher = `CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${property} IS UNIQUE`;
    } else {
      cypher = `CREATE CONSTRAINT ${constraintName} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${property} IS NOT NULL`;
    }

    await this.query(cypher, {}, database);
    logger.debug('Neo4j constraint created', { label, property, constraintType });
  }

  /**
   * Clear all nodes and relationships (use with caution!)
   */
  async clearDatabase(database?: string): Promise<void> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    logger.warn('Clearing Neo4j database', { database: database || this.config.database });

    const session = this.getSession(database);

    try {
      await session.executeWrite(async (tx) => {
        // Delete all relationships first
        await tx.run('MATCH ()-[r]->() DELETE r');
        // Then delete all nodes
        await tx.run('MATCH (n) DELETE n');
      });

      logger.info('Neo4j database cleared');
    } catch (error) {
      logger.error('Failed to clear Neo4j database', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Get database statistics
   */
  async getStatistics(database?: string): Promise<{
    nodeCount: number;
    relationshipCount: number;
    labelCounts: Record<string, number>;
  }> {
    if (!this.driver) {
      throw new Error('Neo4j driver not initialized');
    }

    const session = this.getSession(database);

    try {
      // Get total node count
      const nodeCountResult = await session.run('MATCH (n) RETURN count(n) as count');
      const nodeCount = nodeCountResult.records[0]?.get('count').toNumber() || 0;

      // Get total relationship count
      const relCountResult = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
      const relationshipCount = relCountResult.records[0]?.get('count').toNumber() || 0;

      // Get label counts
      const labelResult = await session.run(`
        CALL db.labels() YIELD label
        CALL {
          WITH label
          MATCH (n)
          WHERE label IN labels(n)
          RETURN count(n) as count
        }
        RETURN label, count
      `);

      const labelCounts: Record<string, number> = {};
      for (const record of labelResult.records) {
        const label = record.get('label') as string;
        const count = record.get('count').toNumber();
        labelCounts[label] = count;
      }

      return { nodeCount, relationshipCount, labelCounts };
    } catch (error) {
      logger.error('Failed to get Neo4j statistics', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.driver) {
      return {
        healthy: false,
        error: 'Driver not initialized',
      };
    }

    const startTime = Date.now();

    try {
      await this.driver.verifyConnectivity();
      const latency = Date.now() - startTime;

      // Get server info
      const session = this.getSession();
      let serverVersion = 'unknown';

      try {
        const result = await session.run('CALL dbms.components() YIELD versions RETURN versions[0] as version');
        serverVersion = result.records[0]?.get('version') || 'unknown';
      } catch (error) {
        logger.warn('Could not retrieve Neo4j version', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        await session.close();
      }

      return {
        healthy: true,
        latency,
        details: {
          version: serverVersion,
          database: this.config.database,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Close the driver
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      logger.info('Neo4j driver closed');
    }
  }

  /**
   * Get the underlying driver (for advanced usage)
   */
  getDriver(): Driver | null {
    return this.driver;
  }
}
