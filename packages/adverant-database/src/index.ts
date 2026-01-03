/**
 * @adverant/database
 * Unified database connection management for Nexus stack
 */

export { DatabaseManager } from './database-manager';
export { PostgresManager } from './managers/postgres-manager';
export { RedisManager } from './managers/redis-manager';
export { Neo4jManager } from './managers/neo4j-manager';
export { QdrantManager } from './managers/qdrant-manager';

export type {
  DatabaseConfig,
  PostgresConfig,
  RedisConfig,
  Neo4jConfig,
  QdrantConfig,
  DatabaseConnections,
  TransactionContext,
  HealthCheckResult,
} from './types';

// Re-export commonly used types from dependencies for convenience
export type { Pool, PoolClient, QueryResult } from 'pg';
export type { Redis, RedisOptions } from 'ioredis';
export type { Driver, Session } from 'neo4j-driver';
export type { QdrantClient } from '@qdrant/js-client-rest';
