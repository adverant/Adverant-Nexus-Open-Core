/**
 * Global Test Setup
 * Initializes real connections and validates environment
 */

import dotenv from 'dotenv';
import { logger } from '../src/utils/logger';
import axios from 'axios';
import { Client as PgClient } from 'pg';
import Redis from 'ioredis';
import neo4j from 'neo4j-driver';
import { QdrantClient } from '@qdrant/js-client-rest';

// Load environment variables
dotenv.config({ path: '.env.test' });

// Extend Jest matchers
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidResponse(): R;
      toHaveRealData(): R;
      toCompleteWithinTime(time: number): R;
    }
  }
}

// Custom matchers for API validation
expect.extend({
  toBeValidResponse(received: any) {
    const pass = received &&
                 (received.status >= 200 && received.status < 300) &&
                 received.data !== undefined;
    return {
      pass,
      message: () => pass
        ? `Expected response not to be valid`
        : `Expected valid response with status 2xx and data, got ${JSON.stringify(received)}`
    };
  },

  toHaveRealData(received: any) {
    const isMockData =
      JSON.stringify(received).includes('mock') ||
      JSON.stringify(received).includes('test') ||
      JSON.stringify(received).includes('fake') ||
      JSON.stringify(received).includes('dummy') ||
      JSON.stringify(received).includes('example') ||
      JSON.stringify(received).includes('sample');

    const pass = !isMockData && received !== null && received !== undefined;

    return {
      pass,
      message: () => pass
        ? `Expected data to be mock data`
        : `Expected real data but found mock/test data: ${JSON.stringify(received)}`
    };
  },

  async toCompleteWithinTime(received: Promise<any>, expectedTime: number) {
    const start = Date.now();
    try {
      await received;
      const elapsed = Date.now() - start;
      const pass = elapsed <= expectedTime;

      return {
        pass,
        message: () => pass
          ? `Expected operation to take longer than ${expectedTime}ms`
          : `Expected operation to complete within ${expectedTime}ms but took ${elapsed}ms`
      };
    } catch (error) {
      return {
        pass: false,
        message: () => `Operation failed with error: ${error}`
      };
    }
  }
});

// Global test environment validation
beforeAll(async () => {
  console.log('🔍 Validating test environment...');

  const requiredEnvVars = [
    'OPENROUTER_API_KEY',
    'POSTGRES_HOST',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'REDIS_HOST',
    'NEO4J_URI',
    'NEO4J_USER',
    'NEO4J_PASSWORD',
    'QDRANT_HOST',
    'GRAPHRAG_ENDPOINT'
  ];

  const missing = requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  console.log('✅ Environment variables validated');

  // Validate real connections
  console.log('🔌 Testing real service connections...');

  // Test OpenRouter
  try {
    const openRouterResponse = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    if (!openRouterResponse.data.data || openRouterResponse.data.data.length === 0) {
      throw new Error('OpenRouter returned no models');
    }
    console.log(`✅ OpenRouter: ${openRouterResponse.data.data.length} models available`);
  } catch (error) {
    console.error('❌ OpenRouter connection failed:', error);
    throw error;
  }

  // Test PostgreSQL
  const pgClient = new PgClient({
    host: process.env.POSTGRES_HOST,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DATABASE || 'vibe_platform'
  });

  try {
    await pgClient.connect();
    const result = await pgClient.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected:', result.rows[0].now);
    await pgClient.end();
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error);
    throw error;
  }

  // Test Redis
  const redisClient = new Redis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD
  });

  try {
    await redisClient.ping();
    console.log('✅ Redis connected');
    await redisClient.quit();
  } catch (error) {
    console.error('❌ Redis connection failed:', error);
    throw error;
  }

  // Test Neo4j
  const neo4jDriver = neo4j.driver(
    process.env.NEO4J_URI || 'bolt://neo4j.vibe-data.svc.cluster.local:7687',
    neo4j.auth.basic(
      process.env.NEO4J_USER || 'neo4j',
      process.env.NEO4J_PASSWORD || ''
    )
  );

  try {
    const session = neo4jDriver.session();
    const result = await session.run('RETURN 1 AS test');
    console.log('✅ Neo4j connected:', result.records[0].get('test'));
    await session.close();
    await neo4jDriver.close();
  } catch (error) {
    console.error('❌ Neo4j connection failed:', error);
    throw error;
  }

  // Test Qdrant
  const qdrantClient = new QdrantClient({
    url: `http://${process.env.QDRANT_HOST || 'qdrant.vibe-data.svc.cluster.local'}:${process.env.QDRANT_PORT || '6333'}`,
    apiKey: process.env.QDRANT_API_KEY
  });

  try {
    const collections = await qdrantClient.getCollections();
    console.log('✅ Qdrant connected:', collections.collections.length, 'collections');
  } catch (error) {
    console.error('❌ Qdrant connection failed:', error);
    throw error;
  }

  // Test GraphRAG
  try {
    const graphRAGResponse = await axios.get(
      `${process.env.GRAPHRAG_ENDPOINT || 'http://graphrag.vibe-system.svc.cluster.local:8080'}/health`
    );
    console.log('✅ GraphRAG connected:', graphRAGResponse.data);
  } catch (error) {
    console.error('⚠️  GraphRAG connection failed (continuing):', error);
  }

  console.log('✅ All connections validated - using REAL services');
});

// Global test teardown
afterAll(async () => {
  console.log('🧹 Cleaning up test resources...');
  // Any global cleanup needed
});

// Increase timeout for async operations
jest.setTimeout(300000);

// Suppress console logs during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  };
}

export {};