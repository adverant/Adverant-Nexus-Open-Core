/**
 * Type definitions for @adverant/database
 */

import type { PoolClient } from 'pg';
import type { PostgresManager } from './managers/postgres-manager';
import type { RedisManager } from './managers/redis-manager';
import type { Neo4jManager } from './managers/neo4j-manager';
import type { QdrantManager } from './managers/qdrant-manager';

/**
 * PostgreSQL configuration
 */
export interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Redis configuration
 */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest?: number;
  retryStrategy?: (times: number) => number;
  keyPrefix?: string;
  tls?: boolean | { rejectUnauthorized: boolean };
}

/**
 * Neo4j configuration
 */
export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
  maxConnectionLifetime?: number;
  maxConnectionPoolSize?: number;
  connectionAcquisitionTimeout?: number;
  connectionTimeout?: number;
  maxTransactionRetryTime?: number;
  encrypted?: boolean;
  trustStrategy?: string;
}

/**
 * Qdrant configuration
 */
export interface QdrantConfig {
  url: string;
  apiKey?: string;
  timeout?: number;
  collections?: Array<{
    name: string;
    vectorSize: number;
    distance?: 'Cosine' | 'Euclid' | 'Dot';
  }>;
}

/**
 * Database manager configuration
 */
export interface DatabaseConfig {
  postgres?: PostgresConfig;
  redis?: RedisConfig;
  neo4j?: Neo4jConfig;
  qdrant?: QdrantConfig;
}

/**
 * Database connections
 */
export interface DatabaseConnections {
  postgres?: PostgresManager;
  redis?: RedisManager;
  neo4j?: Neo4jManager;
  qdrant?: QdrantManager;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  latency?: number;
  error?: string;
  details?: Record<string, any>;
}

/**
 * Database health status
 */
export interface DatabaseHealth {
  postgres?: HealthCheckResult;
  redis?: HealthCheckResult;
  neo4j?: HealthCheckResult;
  qdrant?: HealthCheckResult;
  overall: boolean;
}

/**
 * Transaction context for PostgreSQL
 */
export interface TransactionContext {
  client: PoolClient;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Database manager options
 */
export interface DatabaseManagerOptions {
  config: DatabaseConfig;
  enableHealthChecks?: boolean;
  healthCheckInterval?: number;
}

/**
 * Query result type
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
  command: string;
}

/**
 * Neo4j session options
 */
export interface Neo4jSessionOptions {
  database?: string;
  defaultAccessMode?: 'READ' | 'WRITE';
}

/**
 * Qdrant collection info
 */
export interface QdrantCollectionInfo {
  name: string;
  vectorSize: number;
  distance: 'Cosine' | 'Euclid' | 'Dot';
  exists: boolean;
}
