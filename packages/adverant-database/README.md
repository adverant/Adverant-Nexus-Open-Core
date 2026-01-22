# @adverant/database

**Unified database connection management for Nexus stack** - Reduce database-related code by 67% with consistent patterns across PostgreSQL, Redis, Neo4j, and Qdrant.

## Features

- **Unified Interface**: Single DatabaseManager for all four databases
- **Connection Pooling**: Optimized connection management for PostgreSQL
- **Health Monitoring**: Built-in health checks for all databases
- **Transaction Support**: PostgreSQL and Neo4j transaction helpers
- **Retry Logic**: Automatic retry with exponential backoff using @adverant/resilience
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Graceful Shutdown**: Proper cleanup of all database connections
- **Production-Ready**: Comprehensive error handling and logging

## Supported Databases

- **PostgreSQL**: Relational database with connection pooling and transactions
- **Redis**: In-memory cache and pub/sub with ioredis client
- **Neo4j**: Graph database with session management
- **Qdrant**: Vector database for embeddings and similarity search

## Installation

```bash
npm install @adverant/database
```

## Quick Start

### Basic Usage with All Databases

```typescript
import { DatabaseManager } from '@adverant/database';

const dbManager = new DatabaseManager({
  postgres: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'nexus',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  neo4j: {
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    username: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD,
  },
  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
  },
});

// Initialize all configured databases
await dbManager.initialize();

// Use individual managers
const postgres = dbManager.getPostgres();
const redis = dbManager.getRedis();
const neo4j = dbManager.getNeo4j();
const qdrant = dbManager.getQdrant();

// Health check
const health = await dbManager.healthCheck();
console.log('All databases healthy:', health.healthy);

// Graceful shutdown
await dbManager.close();
```

### Using Individual Managers

```typescript
import { PostgresManager, RedisManager } from '@adverant/database';

// PostgreSQL only
const postgres = new PostgresManager({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'postgres',
  password: 'password',
});

await postgres.initialize();

// Redis only
const redis = new RedisManager({
  host: 'localhost',
  port: 6379,
});

await redis.initialize();
```

## PostgreSQL Manager

### Configuration

```typescript
interface PostgresConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;                    // Max pool size (default: 20)
  idleTimeoutMillis?: number;      // Idle timeout (default: 30000)
  connectionTimeoutMillis?: number; // Connection timeout (default: 10000)
  ssl?: boolean | object;          // SSL configuration
  schema?: string;                 // Default schema (e.g., 'public')
}
```

### Usage Examples

#### Basic Queries

```typescript
const postgres = dbManager.getPostgres();

// Simple query
const result = await postgres.query<User>(
  'SELECT * FROM users WHERE id = $1',
  [userId]
);

console.log('Users:', result.rows);
console.log('Row count:', result.rowCount);
```

#### Transactions

```typescript
// Automatic transaction with rollback on error
const result = await postgres.transaction(async (context) => {
  // All queries in this callback are part of the transaction
  await context.client.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
  await context.client.query('INSERT INTO accounts (user_id) VALUES ($1)', [1]);

  // Commit happens automatically if no error
  return { success: true };
});

// Manual control
await postgres.transaction(async (context) => {
  try {
    await context.client.query('UPDATE balance SET amount = $1', [100]);

    if (someCondition) {
      await context.rollback();
      return;
    }

    await context.commit();
  } catch (error) {
    await context.rollback();
    throw error;
  }
});
```

#### Connection Pool

```typescript
// Get a client from the pool for multiple operations
const client = await postgres.getClient();

try {
  await client.query('BEGIN');
  await client.query('INSERT INTO logs (message) VALUES ($1)', ['test']);
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release(); // IMPORTANT: Always release!
}
```

#### Health Check

```typescript
const health = await postgres.healthCheck();

if (health.healthy) {
  console.log(`PostgreSQL healthy (latency: ${health.latency}ms)`);
  console.log('Pool stats:', health.details);
} else {
  console.error('PostgreSQL unhealthy:', health.error);
}
```

## Redis Manager

### Configuration

```typescript
interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;                     // Database number (default: 0)
  keyPrefix?: string;              // Prefix for all keys
  tls?: boolean | object;          // TLS configuration
  maxRetriesPerRequest?: number;   // Max retries (default: 3)
}
```

### Usage Examples

#### Basic Operations

```typescript
const redis = dbManager.getRedis();

// Get/Set
await redis.set('user:123', JSON.stringify(userData), 3600); // 1 hour TTL
const cached = await redis.get('user:123');

// Delete
await redis.delete('user:123');

// Delete by pattern
const deleted = await redis.deletePattern('user:*');
console.log(`Deleted ${deleted} keys`);

// Check existence
const exists = await redis.exists('user:123');

// Get TTL
const ttl = await redis.ttl('user:123'); // Returns seconds remaining
```

#### Pub/Sub

```typescript
// Subscribe to a channel
await redis.subscribe('notifications', (message) => {
  console.log('Received:', message);
});

// Publish to a channel
await redis.publish('notifications', JSON.stringify({ event: 'user_created' }));
```

#### Atomic Operations

```typescript
// Increment/Decrement
await redis.increment('page:views', 1);
await redis.decrement('credits:user:123', 10);

// Multi-get/set
const users = await redis.mget(['user:1', 'user:2', 'user:3']);

await redis.mset({
  'user:1': JSON.stringify(user1),
  'user:2': JSON.stringify(user2),
});
```

## Neo4j Manager

### Configuration

```typescript
interface Neo4jConfig {
  uri: string;                          // bolt://localhost:7687
  username: string;
  password: string;
  database?: string;                    // Target database (default: 'neo4j')
  maxConnectionPoolSize?: number;       // Max pool size (default: 100)
  connectionAcquisitionTimeout?: number; // Timeout (default: 60000)
  connectionTimeout?: number;           // Connection timeout (default: 30000)
  maxTransactionRetryTime?: number;     // Retry timeout (default: 30000)
  encrypted?: boolean;                  // Use encryption (default: false)
  trustStrategy?: string;               // Trust strategy for TLS
}
```

### Usage Examples

#### Basic Queries

```typescript
const neo4j = dbManager.getNeo4j();

// Simple query
const users = await neo4j.query<{ name: string; age: number }>(
  'MATCH (u:User) WHERE u.age > $age RETURN u.name as name, u.age as age',
  { age: 18 }
);

console.log('Users:', users);
```

#### Transactions

```typescript
// Read transaction
const result = await neo4j.readTransaction(async (tx) => {
  const res = await tx.run('MATCH (n:User) RETURN count(n) as count');
  return res.records[0].get('count').toNumber();
});

// Write transaction
await neo4j.writeTransaction(async (tx) => {
  await tx.run(
    'CREATE (u:User {id: $id, name: $name})',
    { id: '123', name: 'Alice' }
  );
});
```

#### Batch Operations

```typescript
// Execute multiple queries in a transaction
await neo4j.executeBatch([
  {
    cypher: 'CREATE (u:User {id: $id, name: $name})',
    parameters: { id: '1', name: 'Alice' },
  },
  {
    cypher: 'CREATE (u:User {id: $id, name: $name})',
    parameters: { id: '2', name: 'Bob' },
  },
  {
    cypher: 'MATCH (a:User {id: $id1}), (b:User {id: $id2}) CREATE (a)-[:KNOWS]->(b)',
    parameters: { id1: '1', id2: '2' },
  },
]);
```

#### Indexes and Constraints

```typescript
// Create index
await neo4j.createIndex('User', 'email', 'BTREE');

// Create unique constraint
await neo4j.createConstraint('User', 'id', 'UNIQUE');
```

#### Statistics

```typescript
const stats = await neo4j.getStatistics();

console.log('Total nodes:', stats.nodeCount);
console.log('Total relationships:', stats.relationshipCount);
console.log('Label counts:', stats.labelCounts);
```

## Qdrant Manager

### Configuration

```typescript
interface QdrantConfig {
  url: string;                     // http://localhost:6333
  apiKey?: string;                 // API key for authentication
  timeout?: number;                // Request timeout (default: 30000)
  collections?: Array<{            // Auto-initialize collections
    name: string;
    vectorSize: number;
    distance?: 'Cosine' | 'Euclid' | 'Dot';
  }>;
}
```

### Usage Examples

#### Collection Management

```typescript
const qdrant = dbManager.getQdrant();

// Create collection
await qdrant.createCollection('documents', 1536, 'Cosine');

// Check if collection exists
const exists = await qdrant.collectionExists('documents');

// Get collection info
const info = await qdrant.getCollectionInfo('documents');
console.log('Points:', info.pointsCount);
console.log('Vectors:', info.vectorsCount);

// Delete collection
await qdrant.deleteCollection('documents');
```

#### Vector Operations

```typescript
// Upsert vectors
await qdrant.upsert('documents', [
  {
    id: 'doc1',
    vector: [0.1, 0.2, 0.3, ...], // 1536-dimensional embedding
    payload: {
      title: 'Document 1',
      content: 'Sample content',
      metadata: { source: 'import' },
    },
  },
  {
    id: 'doc2',
    vector: [0.4, 0.5, 0.6, ...],
    payload: { title: 'Document 2' },
  },
]);

// Search for similar vectors
const results = await qdrant.search(
  'documents',
  queryVector, // [0.15, 0.25, 0.35, ...]
  10,          // Limit
  { source: 'import' }, // Filter by payload
  0.7          // Score threshold
);

console.log('Similar documents:', results);
// [
//   { id: 'doc1', score: 0.95, payload: { title: 'Document 1', ... } },
//   ...
// ]
```

#### Point Operations

```typescript
// Retrieve points by IDs
const points = await qdrant.retrieve('documents', ['doc1', 'doc2'], true);

// Delete points
await qdrant.delete('documents', ['doc1', 'doc2']);

// Delete by filter
await qdrant.deleteByFilter('documents', { source: 'import' });

// Scroll through points
const { points, nextOffset } = await qdrant.scroll('documents', 100);
```

## DatabaseManager API

### Initialization

```typescript
const dbManager = new DatabaseManager({
  postgres: { /* config */ },
  redis: { /* config */ },
  neo4j: { /* config */ },
  qdrant: { /* config */ },
});

await dbManager.initialize();
```

### Accessing Managers

```typescript
// Get specific manager
const postgres = dbManager.getPostgres();
const redis = dbManager.getRedis();
const neo4j = dbManager.getNeo4j();
const qdrant = dbManager.getQdrant();

// Check if database is configured
if (dbManager.hasDatabase('postgres')) {
  // PostgreSQL is available
}
```

### Health Checks

```typescript
// Check all databases
const health = await dbManager.healthCheck();

console.log('Overall healthy:', health.healthy);
console.log('PostgreSQL:', health.databases.postgres);
console.log('Redis:', health.databases.redis);
console.log('Neo4j:', health.databases.neo4j);
console.log('Qdrant:', health.databases.qdrant);
```

### Statistics

```typescript
const stats = await dbManager.getStatistics();

console.log('PostgreSQL pool:', stats.postgres);
console.log('Redis connections:', stats.redis);
console.log('Neo4j version:', stats.neo4j);
console.log('Qdrant collections:', stats.qdrant);
```

### Graceful Shutdown

```typescript
// Close all connections
await dbManager.close();

// Or close individual managers
await postgres.close();
await redis.close();
await neo4j.close();
```

## Migration Guide

### From GraphRAG Database Manager

**Before**:
```typescript
import { DatabaseManager } from './database/database-manager';

const dbManager = new DatabaseManager();
await dbManager.initialize();

const postgres = dbManager.getPostgresClient();
const redis = dbManager.getRedisClient();
```

**After**:
```typescript
import { DatabaseManager } from '@adverant/database';

const dbManager = new DatabaseManager({
  postgres: { host, port, database, user, password },
  redis: { host, port },
  neo4j: { uri, username, password },
  qdrant: { url },
});

await dbManager.initialize();

const postgres = dbManager.getPostgres();
const redis = dbManager.getRedis();
```

### From MageAgent Database Manager

**Before**:
```typescript
import config from './config';
import { Pool } from 'pg';
import Redis from 'redis';

const postgres = new Pool(config.postgres);
const redis = Redis.createClient(config.redis);
```

**After**:
```typescript
import { DatabaseManager } from '@adverant/database';

const dbManager = new DatabaseManager({
  postgres: config.postgres,
  redis: config.redis,
});

await dbManager.initialize();

const postgres = dbManager.getPostgres();
const redis = dbManager.getRedis();

// Use ioredis API (standardized)
await redis.set('key', 'value');
```

### From GeoAgent Database Manager

**Before**:
```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  // ...
});

await pool.query('SELECT PostGIS_Version()');
```

**After**:
```typescript
import { PostgresManager } from '@adverant/database';

const postgres = new PostgresManager({
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

await postgres.initialize();

// PostGIS still works
await postgres.query('SELECT PostGIS_Version()');
```

## Best Practices

### 1. Always Initialize Before Use

```typescript
const dbManager = new DatabaseManager(config);
await dbManager.initialize(); // REQUIRED

// Now safe to use
const postgres = dbManager.getPostgres();
```

### 2. Use Transactions for Related Operations

```typescript
// Good - atomic
await postgres.transaction(async (context) => {
  await context.client.query('INSERT INTO users ...');
  await context.client.query('INSERT INTO profiles ...');
});

// Bad - not atomic
await postgres.query('INSERT INTO users ...');
await postgres.query('INSERT INTO profiles ...'); // May fail leaving orphaned user
```

### 3. Always Release Pool Clients

```typescript
// Good
const client = await postgres.getClient();
try {
  await client.query('...');
} finally {
  client.release(); // REQUIRED
}

// Better - use transactions which handle this automatically
await postgres.transaction(async (context) => {
  await context.client.query('...');
});
```

### 4. Health Check Before Critical Operations

```typescript
const health = await dbManager.healthCheck();

if (!health.healthy) {
  logger.error('Database unhealthy, aborting operation');
  throw new Error('Database unavailable');
}

// Proceed with operation
await postgres.query('...');
```

### 5. Graceful Shutdown

```typescript
// Handle process termination
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully');
  await dbManager.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully');
  await dbManager.close();
  process.exit(0);
});
```

### 6. Use Type Parameters for Query Results

```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

// Type-safe query results
const result = await postgres.query<User>(
  'SELECT * FROM users WHERE id = $1',
  [userId]
);

// TypeScript knows result.rows is User[]
const user: User = result.rows[0];
```

## Performance Considerations

### PostgreSQL Connection Pooling

```typescript
const postgres = new PostgresManager({
  // ...
  max: 20,                    // Maximum pool size
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 10000, // Fail after 10s if no connection available
});
```

**Recommendations**:
- **Small apps**: max: 10
- **Medium apps**: max: 20 (default)
- **Large apps**: max: 50
- **Formula**: `max = (available_db_connections / num_app_instances) - 10`

### Redis Connection Reuse

```typescript
// Good - single client reused
const redis = new RedisManager(config);
await redis.initialize();

// Use for all operations
await redis.get('key1');
await redis.get('key2');

// Bad - creates new connection each time
async function getKey() {
  const redis = new RedisManager(config);
  await redis.initialize();
  return await redis.get('key');
}
```

### Neo4j Session Management

```typescript
// Sessions are lightweight - create per operation
const session = neo4j.getSession();
try {
  await session.run('MATCH ...');
} finally {
  await session.close(); // REQUIRED
}

// Or use the query helper which handles this automatically
await neo4j.query('MATCH ...');
```

## Error Handling

All managers throw descriptive errors that can be caught and handled:

```typescript
try {
  await postgres.query('SELECT * FROM users');
} catch (error) {
  if (error.code === '42P01') {
    logger.error('Table does not exist');
  } else {
    logger.error('Query failed', { error: error.message });
  }
}

try {
  await redis.get('key');
} catch (error) {
  logger.error('Redis error', { error: error.message });
  // Fallback to database
  await postgres.query('...');
}
```

## License

ISC

## Contributing

See the main Nexus repository for contribution guidelines.
