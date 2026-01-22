/**
 * Unified Database Manager
 * Coordinates PostgreSQL, Redis, Neo4j, and Qdrant connections
 */

import { createLogger } from '@adverant/logger';
import { PostgresManager } from './managers/postgres-manager';
import { RedisManager } from './managers/redis-manager';
import { Neo4jManager } from './managers/neo4j-manager';
import { QdrantManager } from './managers/qdrant-manager';
import type { DatabaseConfig, DatabaseConnections, HealthCheckResult } from './types';

const logger = createLogger({ service: 'adverant-database' });

export class DatabaseManager {
  private config: DatabaseConfig;
  private connections: DatabaseConnections = {};
  private initialized = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  /**
   * Initialize all configured databases
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('DatabaseManager already initialized');
      return;
    }

    const initPromises: Promise<void>[] = [];

    // Initialize PostgreSQL
    if (this.config.postgres) {
      logger.debug('Initializing PostgreSQL connection');
      const postgresManager = new PostgresManager(this.config.postgres);
      initPromises.push(
        postgresManager.initialize().then(() => {
          this.connections.postgres = postgresManager;
          logger.info('PostgreSQL connection established');
        })
      );
    }

    // Initialize Redis
    if (this.config.redis) {
      logger.debug('Initializing Redis connection');
      const redisManager = new RedisManager(this.config.redis);
      initPromises.push(
        redisManager.initialize().then(() => {
          this.connections.redis = redisManager;
          logger.info('Redis connection established');
        })
      );
    }

    // Initialize Neo4j
    if (this.config.neo4j) {
      logger.debug('Initializing Neo4j connection');
      const neo4jManager = new Neo4jManager(this.config.neo4j);
      initPromises.push(
        neo4jManager.initialize().then(() => {
          this.connections.neo4j = neo4jManager;
          logger.info('Neo4j connection established');
        })
      );
    }

    // Initialize Qdrant
    if (this.config.qdrant) {
      logger.debug('Initializing Qdrant connection');
      const qdrantManager = new QdrantManager(this.config.qdrant);
      initPromises.push(
        qdrantManager.initialize().then(() => {
          this.connections.qdrant = qdrantManager;
          logger.info('Qdrant connection established');
        })
      );
    }

    try {
      await Promise.all(initPromises);
      this.initialized = true;
      logger.info('All database connections initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize database connections', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      await this.close(); // Clean up any partial connections
      throw error;
    }
  }

  /**
   * Get PostgreSQL manager
   */
  getPostgres(): PostgresManager {
    if (!this.connections.postgres) {
      throw new Error('PostgreSQL not configured or not initialized');
    }
    return this.connections.postgres;
  }

  /**
   * Get Redis manager
   */
  getRedis(): RedisManager {
    if (!this.connections.redis) {
      throw new Error('Redis not configured or not initialized');
    }
    return this.connections.redis;
  }

  /**
   * Get Neo4j manager
   */
  getNeo4j(): Neo4jManager {
    if (!this.connections.neo4j) {
      throw new Error('Neo4j not configured or not initialized');
    }
    return this.connections.neo4j;
  }

  /**
   * Get Qdrant manager
   */
  getQdrant(): QdrantManager {
    if (!this.connections.qdrant) {
      throw new Error('Qdrant not configured or not initialized');
    }
    return this.connections.qdrant;
  }

  /**
   * Get all connections
   */
  getConnections(): DatabaseConnections {
    return this.connections;
  }

  /**
   * Check if a specific database is configured and connected
   */
  hasDatabase(database: 'postgres' | 'redis' | 'neo4j' | 'qdrant'): boolean {
    return !!this.connections[database];
  }

  /**
   * Health check for all databases
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    databases: {
      postgres?: HealthCheckResult;
      redis?: HealthCheckResult;
      neo4j?: HealthCheckResult;
      qdrant?: HealthCheckResult;
    };
  }> {
    const healthChecks: {
      postgres?: HealthCheckResult;
      redis?: HealthCheckResult;
      neo4j?: HealthCheckResult;
      qdrant?: HealthCheckResult;
    } = {};

    const checkPromises: Promise<void>[] = [];

    // Check PostgreSQL
    if (this.connections.postgres) {
      checkPromises.push(
        this.connections.postgres.healthCheck().then((result) => {
          healthChecks.postgres = result;
        })
      );
    }

    // Check Redis
    if (this.connections.redis) {
      checkPromises.push(
        this.connections.redis.healthCheck().then((result) => {
          healthChecks.redis = result;
        })
      );
    }

    // Check Neo4j
    if (this.connections.neo4j) {
      checkPromises.push(
        this.connections.neo4j.healthCheck().then((result) => {
          healthChecks.neo4j = result;
        })
      );
    }

    // Check Qdrant
    if (this.connections.qdrant) {
      checkPromises.push(
        this.connections.qdrant.healthCheck().then((result) => {
          healthChecks.qdrant = result;
        })
      );
    }

    await Promise.all(checkPromises);

    // Determine overall health
    const allHealthy = Object.values(healthChecks).every((check) => check.healthy);

    return {
      healthy: allHealthy,
      databases: healthChecks,
    };
  }

  /**
   * Get connection statistics
   */
  async getStatistics(): Promise<{
    postgres?: {
      totalConnections: number;
      idleConnections: number;
      waitingCount: number;
    };
    redis?: {
      connections: number;
      db: number;
    };
    neo4j?: {
      version: string;
      database?: string;
    };
    qdrant?: {
      collections: string[];
      collectionCount: number;
    };
  }> {
    const stats: any = {};

    // PostgreSQL stats
    if (this.connections.postgres) {
      const pool = this.connections.postgres.getPool();
      if (pool) {
        stats.postgres = {
          totalConnections: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingCount: pool.waitingCount,
        };
      }
    }

    // Redis stats
    if (this.connections.redis) {
      const health = await this.connections.redis.healthCheck();
      if (health.healthy && health.details) {
        stats.redis = health.details;
      }
    }

    // Neo4j stats
    if (this.connections.neo4j) {
      const health = await this.connections.neo4j.healthCheck();
      if (health.healthy && health.details) {
        stats.neo4j = health.details;
      }
    }

    // Qdrant stats
    if (this.connections.qdrant) {
      const health = await this.connections.qdrant.healthCheck();
      if (health.healthy && health.details) {
        stats.qdrant = health.details;
      }
    }

    return stats;
  }

  /**
   * Close all database connections
   */
  async close(): Promise<void> {
    logger.info('Closing all database connections');

    const closePromises: Promise<void>[] = [];

    if (this.connections.postgres) {
      closePromises.push(
        this.connections.postgres.close().catch((error) => {
          logger.error('Error closing PostgreSQL connection', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        })
      );
    }

    if (this.connections.redis) {
      closePromises.push(
        this.connections.redis.close().catch((error) => {
          logger.error('Error closing Redis connection', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        })
      );
    }

    if (this.connections.neo4j) {
      closePromises.push(
        this.connections.neo4j.close().catch((error) => {
          logger.error('Error closing Neo4j connection', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        })
      );
    }

    // Qdrant doesn't have a close method (HTTP client)
    if (this.connections.qdrant) {
      logger.debug('Qdrant client cleared (HTTP client, no close needed)');
    }

    await Promise.all(closePromises);

    this.connections = {};
    this.initialized = false;
    logger.info('All database connections closed');
  }

  /**
   * Check if DatabaseManager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
