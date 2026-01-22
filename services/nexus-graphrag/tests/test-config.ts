/**
 * Test Configuration for GraphRAG System
 * Provides centralized configuration for all test suites
 */

import { Pool } from 'pg';
import neo4j from 'neo4j-driver';
import Redis from 'ioredis';
import { QdrantClient } from '@qdrant/js-client-rest';

export interface TestConfig {
  api: {
    baseUrl: string;
    timeout: number;
    retryAttempts: number;
  };
  database: {
    postgres: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    };
    redis: {
      host: string;
      port: number;
    };
    neo4j: {
      uri: string;
      user: string;
      password: string;
    };
    qdrant: {
      url: string;
      apiKey?: string;
    };
  };
  websocket: {
    url: string;
    reconnectInterval: number;
    maxReconnectAttempts: number;
  };
  testing: {
    verbose: boolean;
    cleanup: boolean;
    seed: boolean;
    parallel: boolean;
  };
}

export const testConfig: TestConfig = {
  api: {
    baseUrl: process.env.TEST_API_URL || 'http://localhost:8090',
    timeout: 30000,
    retryAttempts: 3
  },
  database: {
    postgres: {
      host: process.env.TEST_PG_HOST || 'localhost',
      port: parseInt(process.env.TEST_PG_PORT || '5432'),
      database: process.env.TEST_PG_DATABASE || 'graphrag_test',
      user: process.env.TEST_PG_USER || 'postgres',
      password: process.env.TEST_PG_PASSWORD || 'postgres'
    },
    redis: {
      host: process.env.TEST_REDIS_HOST || 'localhost',
      port: parseInt(process.env.TEST_REDIS_PORT || '6379')
    },
    neo4j: {
      uri: process.env.TEST_NEO4J_URI || 'bolt://localhost:7687',
      user: process.env.TEST_NEO4J_USER || 'neo4j',
      password: process.env.TEST_NEO4J_PASSWORD || 'neo4j'
    },
    qdrant: {
      url: process.env.TEST_QDRANT_URL || 'http://localhost:6333',
      apiKey: process.env.TEST_QDRANT_API_KEY
    }
  },
  websocket: {
    url: process.env.TEST_WS_URL || 'ws://localhost:8091/ws',
    reconnectInterval: 1000,
    maxReconnectAttempts: 5
  },
  testing: {
    verbose: process.env.TEST_VERBOSE === 'true',
    cleanup: process.env.TEST_CLEANUP !== 'false',
    seed: process.env.TEST_SEED === 'true',
    parallel: process.env.TEST_PARALLEL !== 'false'
  }
};

/**
 * Test Database Connections
 */
export class TestConnections {
  private static instance: TestConnections;

  public postgresPool: Pool;
  public redisClient: Redis;
  public neo4jDriver: neo4j.Driver;
  public qdrantClient: QdrantClient;

  private constructor() {
    this.postgresPool = new Pool(testConfig.database.postgres);
    this.redisClient = new Redis(testConfig.database.redis);
    this.neo4jDriver = neo4j.driver(
      testConfig.database.neo4j.uri,
      neo4j.auth.basic(
        testConfig.database.neo4j.user,
        testConfig.database.neo4j.password
      )
    );
    this.qdrantClient = new QdrantClient({
      url: testConfig.database.qdrant.url,
      apiKey: testConfig.database.qdrant.apiKey
    });
  }

  static getInstance(): TestConnections {
    if (!TestConnections.instance) {
      TestConnections.instance = new TestConnections();
    }
    return TestConnections.instance;
  }

  async cleanup(): Promise<void> {
    await this.postgresPool.end();
    await this.redisClient.quit();
    await this.neo4jDriver.close();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const checks = await Promise.allSettled([
        this.postgresPool.query('SELECT 1'),
        this.redisClient.ping(),
        this.neo4jDriver.verifyConnectivity(),
        this.qdrantClient.getCollections()
      ]);

      return checks.every(check => check.status === 'fulfilled');
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }
}