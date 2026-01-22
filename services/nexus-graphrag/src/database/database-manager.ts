import { Pool } from 'pg';
import Redis from 'ioredis';
import { Driver } from 'neo4j-driver';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DatabaseManager as UnifiedDatabaseManager } from '@adverant/database';
import { logger } from '../utils/logger';
import { DatabaseConfig } from '../types';

export class DatabaseManager {
  private dbManager!: UnifiedDatabaseManager;

  constructor(private config: DatabaseConfig) {}

  async initialize(): Promise<void> {
    try {
      // Debug logging
      logger.info('DatabaseManager config', {
        postgres: { host: this.config.postgres?.host, port: this.config.postgres?.port },
        redis: { host: this.config.redis?.host, port: this.config.redis?.port },
        neo4j: { uri: this.config.neo4j?.uri },
        qdrant: { url: this.config.qdrant?.url }
      });

      // Validate Qdrant config before initialization
      if (!this.config.qdrant?.url) {
        throw new Error(`Qdrant config is missing url: ${this.config.qdrant?.url}`);
      }

      // Initialize unified database manager
      // Neo4j is optional - only include if connection is available
      const dbConfig: any = {
        postgres: {
          host: this.config.postgres.host,
          port: this.config.postgres.port,
          database: this.config.postgres.database,
          user: this.config.postgres.user,
          password: this.config.postgres.password,
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
          // Set default search_path to use graphrag schema first, then public
          options: '-c search_path=graphrag,public',
        },
        redis: {
          host: this.config.redis.host,
          port: this.config.redis.port,
          password: this.config.redis.password,
          maxRetriesPerRequest: 3,
        },
        qdrant: {
          url: this.config.qdrant.url,
          apiKey: this.config.qdrant.apiKey,
        },
      };

      // Only initialize Neo4j if it's configured and available
      // Skip for local development if Neo4j is not running
      const skipNeo4j = process.env.SKIP_NEO4J === 'true';
      if (!skipNeo4j && this.config.neo4j) {
        dbConfig.neo4j = {
          uri: this.config.neo4j.uri,
          username: this.config.neo4j.user,
          password: this.config.neo4j.password,
          maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 60 * 1000, // 60 seconds
          encrypted: false, // Disable encryption for local development (Neo4j 5.x default changed to encrypted)
        };
      } else {
        logger.warn('Neo4j is disabled - episodic memory features will not be available');
      }

      this.dbManager = new UnifiedDatabaseManager(dbConfig);

      // Initialize all databases
      await this.dbManager.initialize();
      logger.info('All databases initialized successfully via @adverant/database');

      // Ensure required Qdrant collections exist (service-specific setup)
      await this.ensureQdrantCollections();

    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw new Error(`Failed to initialize databases: ${(error as Error).message}`);
    }
  }
  
  private async ensureQdrantCollections(): Promise<void> {
    const requiredCollections = [
      { name: 'documents', dimension: 1024 },
      { name: 'chunks', dimension: 1024 },
      { name: 'document_summaries', dimension: 1024 },
      { name: 'unified_content', dimension: 1024 }
    ];

    const qdrantManager = this.dbManager.getQdrant();

    for (const collection of requiredCollections) {
      const exists = await qdrantManager.collectionExists(collection.name);

      if (!exists) {
        logger.info(`Creating Qdrant collection: ${collection.name}`);

        // Use the underlying Qdrant client for advanced collection setup
        const client = qdrantManager.getClient();
        if (client) {
          await client.createCollection(collection.name, {
            vectors: {
              size: collection.dimension,
              distance: 'Cosine' as any,
            } as any,
            optimizers_config: {
              default_segment_number: 2,
            },
            replication_factor: 2,
          } as any);
        }
      }
    }
  }
  
  async checkHealth(): Promise<any> {
    // Use unified database manager health check
    const dbHealth = await this.dbManager.healthCheck();

    // Transform to match GraphRAG's expected format
    const health = {
      healthy: dbHealth.healthy,
      services: {
        postgres: dbHealth.databases.postgres
          ? {
              status: dbHealth.databases.postgres.healthy ? 'healthy' : 'unhealthy',
              latency: dbHealth.databases.postgres.latency,
              ...dbHealth.databases.postgres.details,
            }
          : { status: 'unknown' },
        redis: dbHealth.databases.redis
          ? {
              status: dbHealth.databases.redis.healthy ? 'healthy' : 'unhealthy',
              latency: dbHealth.databases.redis.latency,
              ...dbHealth.databases.redis.details,
            }
          : { status: 'unknown' },
        neo4j: dbHealth.databases.neo4j
          ? {
              status: dbHealth.databases.neo4j.healthy ? 'healthy' : 'unhealthy',
              latency: dbHealth.databases.neo4j.latency,
              ...dbHealth.databases.neo4j.details,
            }
          : { status: 'unknown' },
        qdrant: dbHealth.databases.qdrant
          ? {
              status: dbHealth.databases.qdrant.healthy ? 'healthy' : 'unhealthy',
              latency: dbHealth.databases.qdrant.latency,
              ...dbHealth.databases.qdrant.details,
            }
          : { status: 'unknown' },
      },
    };

    return health;
  }
  
  async close(): Promise<void> {
    try {
      await this.dbManager.close();
      logger.info('All database connections closed via @adverant/database');
    } catch (error) {
      logger.error('Error closing database connections:', error);
      throw error;
    }
  }

  // Getters for database clients (maintains backward compatibility)
  get postgres(): Pool {
    return this.dbManager.getPostgres().getPool()!;
  }

  get redis(): Redis {
    return this.dbManager.getRedis().getClient();
  }

  get neo4j(): Driver {
    return this.dbManager.getNeo4j().getDriver()!;
  }

  get qdrant(): QdrantClient {
    return this.dbManager.getQdrant().getClient()!;
  }
}
