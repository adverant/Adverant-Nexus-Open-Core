import { Pool } from 'pg';
import Redis from 'ioredis';
import { Driver } from 'neo4j-driver';
import { QdrantClient } from '@qdrant/js-client-rest';
import { DatabaseManager as UnifiedDatabaseManager } from '@adverant/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { MemoryCache, RedisCache } from '../utils/cache';
import { parameterizeCypherQuery } from '../utils/security';

export interface DatabaseConnections {
  postgres: Pool;
  redis: Redis;
  neo4j: Driver;
  qdrant: QdrantClient;
}

export class DatabaseManager {
  private dbManager!: UnifiedDatabaseManager;
  private isInitialized = false;
  private memoryCache: MemoryCache;
  private redisCache: RedisCache | null = null;
  private connectionStats = {
    postgres: { active: 0, idle: 0, total: 0 },
    redis: { connected: false, errors: 0 },
    neo4j: { active: 0, idle: 0 },
    qdrant: { requests: 0, errors: 0 }
  };

  constructor() {
    this.memoryCache = new MemoryCache(300000); // 5 minute TTL
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('DatabaseManager already initialized');
      return;
    }

    logger.info('Initializing database connections...');

    try {
      // Initialize unified database manager
      this.dbManager = new UnifiedDatabaseManager({
        postgres: {
          host: config.databases.postgres.host,
          port: config.databases.postgres.port,
          database: config.databases.postgres.database,
          user: config.databases.postgres.user,
          password: config.databases.postgres.password,
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        },
        redis: {
          host: config.databases.redis.host,
          port: config.databases.redis.port,
          password: config.databases.redis.password,
          maxRetriesPerRequest: 3,
        },
        neo4j: {
          uri: `bolt://${config.databases.neo4j.host}:${config.databases.neo4j.port}`,
          username: config.databases.neo4j.user,
          password: config.databases.neo4j.password,
          encrypted: config.databases.neo4j.encrypted,
          maxConnectionLifetime: 3600000, // 1 hour
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 60000, // 60 seconds
          trustStrategy: 'TRUST_ALL_CERTIFICATES',
        },
        qdrant: {
          url: `http://${config.databases.qdrant.host}:${config.databases.qdrant.port}`,
          apiKey: config.databases.qdrant.apiKey,
          timeout: 30000,
        },
      });

      // Initialize all databases
      await this.dbManager.initialize();
      logger.info('All databases initialized successfully via @adverant/database');

      // Initialize Redis cache (uses ioredis now)
      this.redisCache = new RedisCache(this.redis);
      this.connectionStats.redis.connected = true;

      // Ensure required Qdrant collections exist (service-specific setup)
      await this.ensureQdrantCollections();

      this.isInitialized = true;
      logger.info('All database connections initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.error('Failed to initialize database connections', {
        error: errorMessage,
        stack: errorStack
      });
      throw error;
    }
  }

  private async ensureQdrantCollections(): Promise<void> {
    const requiredCollections = [
      { name: 'agent_outputs', size: 1024 },
      { name: 'competition_results', size: 768 },
      { name: 'synthesis_documents', size: 1024 },
    ];

    const qdrantManager = this.dbManager.getQdrant();

    for (const collection of requiredCollections) {
      const exists = await qdrantManager.collectionExists(collection.name);

      if (!exists) {
        logger.info(`Creating Qdrant collection '${collection.name}'`);
        const client = qdrantManager.getClient();
        if (client) {
          await client.createCollection(collection.name, {
            vectors: {
              size: collection.size,
              distance: 'Cosine' as any,
            } as any,
          });
        }
      } else {
        logger.info(`Qdrant collection '${collection.name}' already exists`);
      }
    }
  }

  // Getters for database connections (maintains backward compatibility)
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

  // Utility methods
  async storeAgentOutput(agentId: string, output: any, embedding?: number[]): Promise<void> {
    try {
      // Ensure table exists (defensive programming)
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS agent_outputs (
          id SERIAL PRIMARY KEY,
          agent_id TEXT NOT NULL,
          output JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Create indexes (only if they don't exist)
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent_id ON agent_outputs(agent_id)
      `);
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_outputs_created_at ON agent_outputs(created_at DESC)
      `);

      // Store in PostgreSQL
      await this.postgres.query(
        `INSERT INTO agent_outputs (agent_id, output, created_at) VALUES ($1, $2, $3)`,
        [agentId, JSON.stringify(output), new Date()]
      );

      // Store embedding in Qdrant if provided
      if (embedding) {
        await this.qdrant.upsert('agent_outputs', {
          wait: true,
          points: [{
            id: agentId,
            vector: embedding,
            payload: {
              agentId,
              output,
              timestamp: new Date().toISOString()
            }
          }]
        });
      }

      // Cache in Redis
      await this.redis.setex(
        `agent:output:${agentId}`,
        3600, // 1 hour TTL
        JSON.stringify(output)
      );

      logger.info('Agent output stored successfully', { agentId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to store agent output', {
        error: errorMessage,
        agentId
      });
      throw error;
    }
  }

  async getAgentOutput(agentId: string): Promise<any> {
    try {
      // Try Redis cache first
      const cached = await this.redis.get(`agent:output:${agentId}`);
      if (cached) {
        logger.debug('Agent output retrieved from cache', { agentId });
        return JSON.parse(cached);
      }

      // Fallback to PostgreSQL
      const result = await this.postgres.query(
        `SELECT output FROM agent_outputs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [agentId]
      );

      if (result.rows.length > 0) {
        const output = result.rows[0].output;
        // Re-cache
        await this.redis.setex(
          `agent:output:${agentId}`,
          3600,
          JSON.stringify(output)
        );
        return output;
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to get agent output', {
        error: errorMessage,
        agentId
      });
      throw error;
    }
  }

  async getTaskStatus(taskId: string): Promise<any> {
    try {
      // Try Redis cache first
      const cached = await this.redis.get(`task:status:${taskId}`);
      if (cached) {
        logger.debug('Task status retrieved from cache', { taskId });
        return JSON.parse(cached);
      }

      // Fallback to PostgreSQL
      const result = await this.postgres.query(
        `SELECT * FROM agent_results WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [taskId]
      );

      if (result.rows.length > 0) {
        const taskStatus = {
          taskId,
          status: result.rows[0].success ? 'completed' : 'failed',
          result: result.rows[0].content,
          createdAt: result.rows[0].created_at,
          updatedAt: result.rows[0].created_at,
          agents: []
        };

        // Cache the result
        await this.redis.setex(
          `task:status:${taskId}`,
          300, // 5 minute TTL
          JSON.stringify(taskStatus)
        );

        return taskStatus;
      }

      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get task status', {
        error: errorMessage,
        taskId
      });
      throw error;
    }
  }

  async storeAgentResult(agentId: string, taskId: string, result: any): Promise<void> {
    try {
      // Ensure table exists (defensive programming)
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS agent_results (
          id SERIAL PRIMARY KEY,
          agent_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          result JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Create indexes (only if they don't exist)
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_results_task_id ON agent_results(task_id)
      `);
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_results_agent_id ON agent_results(agent_id)
      `);

      // Store in PostgreSQL
      await this.postgres.query(
        `INSERT INTO agent_results (agent_id, task_id, result, created_at) VALUES ($1, $2, $3, $4)`,
        [agentId, taskId, JSON.stringify(result), new Date()]
      );

      // Store in Redis with TTL
      const cacheKey = `agent:result:${agentId}:${taskId}`;
      await this.redis.setex(
        cacheKey,
        3600, // 1 hour TTL
        JSON.stringify(result)
      );

      // Store in Neo4j for graph analysis
      const session = this.neo4j.session();
      try {
        // Use parameterized query with validation
        const cypherQuery = `
          MERGE (a:Agent {id: $agentId})
          MERGE (t:Task {id: $taskId})
          CREATE (a)-[:COMPLETED {
            result: $result,
            timestamp: datetime()
          }]->(t)
        `;

        const { query, params } = parameterizeCypherQuery(cypherQuery, {
          agentId,
          taskId,
          result: JSON.stringify(result)
        });

        await session.run(query, params);
      } finally {
        await session.close();
      }

      logger.info('Agent result stored successfully', { agentId, taskId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Failed to store agent result', {
        error: errorMessage,
        agentId,
        taskId
      });
      throw error;
    }
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    // Use unified database manager health check
    const dbHealth = await this.dbManager.healthCheck();

    // Transform to match MageAgent's expected format
    const health: Record<string, boolean> = {
      postgres: dbHealth.databases.postgres?.healthy || false,
      redis: dbHealth.databases.redis?.healthy || false,
      neo4j: dbHealth.databases.neo4j?.healthy || false,
      qdrant: dbHealth.databases.qdrant?.healthy || false,
    };

    return health;
  }

  async getConnectionMetrics(): Promise<any> {
    // Get statistics from unified database manager
    const dbStats = await this.dbManager.getStatistics();

    const metrics: any = {
      postgres: dbStats.postgres || this.connectionStats.postgres,
      redis: dbStats.redis || this.connectionStats.redis,
      neo4j: dbStats.neo4j || this.connectionStats.neo4j,
      qdrant: dbStats.qdrant || this.connectionStats.qdrant,
      cache: {
        memory: this.memoryCache.getMetrics(),
        redis: this.redisCache ? 'enabled' : 'disabled'
      }
    };

    return metrics;
  }

  async cleanup(): Promise<void> {
    logger.info('Cleaning up database connections...');

    try {
      // Clean up caches
      this.memoryCache.destroy();

      // Close all database connections via unified manager
      await this.dbManager.close();

      this.isInitialized = false;
      logger.info('Database connections cleaned up successfully via @adverant/database');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Error during database cleanup', {
        error: errorMessage
      });
    }
  }
}

// Singleton instance
export const databaseManager = new DatabaseManager();
