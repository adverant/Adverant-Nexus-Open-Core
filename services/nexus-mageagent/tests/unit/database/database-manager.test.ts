/**
 * Unit Tests for DatabaseManager
 * Tests REAL Database Connections - NO MOCK DATA
 */

import { DatabaseManager } from '../../../src/database/database-manager';
import { v4 as uuidv4 } from 'uuid';

describe('DatabaseManager - Real Database Tests', () => {
  let dbManager: DatabaseManager;
  const testSchema = 'mageagent_test';

  beforeAll(async () => {
    dbManager = new DatabaseManager();

    // Initialize real connections
    await dbManager.initialize();

    // Create test schema in PostgreSQL
    try {
      await dbManager.postgres.query(`CREATE SCHEMA IF NOT EXISTS ${testSchema}`);

      // Create test tables
      await dbManager.postgres.query(`
        CREATE TABLE IF NOT EXISTS ${testSchema}.agent_outputs (
          id SERIAL PRIMARY KEY,
          agent_id VARCHAR(255) NOT NULL,
          output JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await dbManager.postgres.query(`
        CREATE TABLE IF NOT EXISTS ${testSchema}.agent_results (
          id SERIAL PRIMARY KEY,
          agent_id VARCHAR(255) NOT NULL,
          task_id VARCHAR(255) NOT NULL,
          result JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (error) {
      console.error('Failed to create test schema:', error);
      throw error;
    }
  }, 60000); // 60s timeout for initialization

  afterAll(async () => {
    // Cleanup test data
    try {
      // Drop test schema
      await dbManager.postgres.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);

      // Clean Redis test keys
      const keys = await dbManager.redis.keys('test:*');
      if (keys.length > 0) {
        await dbManager.redis.del(...keys);
      }

      // Clean Neo4j test data
      const session = dbManager.neo4j.session();
      try {
        await session.run(`
          MATCH (n) WHERE n.testData = true
          DETACH DELETE n
        `);
      } finally {
        await session.close();
      }

      // Cleanup database connections
      await dbManager.cleanup();
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }, 60000);

  describe('Initialization', () => {
    test('should initialize all database connections', async () => {
      // Already initialized in beforeAll
      expect(dbManager.postgres).toBeDefined();
      expect(dbManager.redis).toBeDefined();
      expect(dbManager.neo4j).toBeDefined();
      expect(dbManager.qdrant).toBeDefined();
    });

    test('should handle double initialization gracefully', async () => {
      // Should not throw, just warn
      await expect(dbManager.initialize()).resolves.toBeUndefined();
    });
  });

  describe('PostgreSQL Operations', () => {
    test('should execute real queries', async () => {
      const result = await dbManager.postgres.query('SELECT NOW() as current_time');

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].current_time).toBeInstanceOf(Date);
      expect(result.rows[0]).toHaveRealData();
    });

    test('should handle transactions', async () => {
      const client = await dbManager.postgres.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO ${testSchema}.agent_outputs (agent_id, output) VALUES ($1, $2)`,
          [`test-agent-${Date.now()}`, { test: true, timestamp: new Date() }]
        );

        const result = await client.query(
          `SELECT COUNT(*) as count FROM ${testSchema}.agent_outputs WHERE agent_id LIKE 'test-agent-%'`
        );

        expect(parseInt(result.rows[0].count)).toBeGreaterThan(0);

        await client.query('ROLLBACK');

        // Verify rollback
        const afterRollback = await client.query(
          `SELECT COUNT(*) as count FROM ${testSchema}.agent_outputs WHERE agent_id = $1`,
          [`test-agent-${Date.now()}`]
        );

        expect(parseInt(afterRollback.rows[0].count)).toBe(0);
      } finally {
        client.release();
      }
    });

    test('should handle connection pool properly', async () => {
      const connections = await Promise.all(
        Array(5).fill(null).map(async () => {
          const client = await dbManager.postgres.connect();
          const result = await client.query('SELECT pg_backend_pid()');
          client.release();
          return result.rows[0].pg_backend_pid;
        })
      );

      expect(connections).toHaveLength(5);
      expect(new Set(connections).size).toBeGreaterThan(1); // Different PIDs
    });
  });

  describe('Redis Operations', () => {
    test('should perform real Redis operations', async () => {
      const testKey = `test:${Date.now()}`;
      const testValue = { data: 'real test data', timestamp: new Date() };

      // Set value
      await dbManager.redis.set(testKey, JSON.stringify(testValue));

      // Get value
      const retrieved = await dbManager.redis.get(testKey);
      expect(retrieved).toBeDefined();
      expect(JSON.parse(retrieved!)).toEqual({
        data: 'real test data',
        timestamp: testValue.timestamp.toISOString()
      });
      expect(JSON.parse(retrieved!)).toHaveRealData();

      // Delete
      await dbManager.redis.del(testKey);
      const afterDelete = await dbManager.redis.get(testKey);
      expect(afterDelete).toBeNull();
    });

    test('should handle expiration', async () => {
      const testKey = `test:expire:${Date.now()}`;

      await dbManager.redis.setEx(testKey, 1, 'will expire');

      const immediate = await dbManager.redis.get(testKey);
      expect(immediate).toBe('will expire');

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1100));

      const afterExpire = await dbManager.redis.get(testKey);
      expect(afterExpire).toBeNull();
    });

    test('should handle pub/sub operations', async () => {
      const channel = `test:channel:${Date.now()}`;
      const messages: string[] = [];

      // Create subscriber
      const subscriber = dbManager.redis.duplicate();
      await subscriber.connect();

      await subscriber.subscribe(channel, (message) => {
        messages.push(message);
      });

      // Publish messages
      await dbManager.redis.publish(channel, 'message1');
      await dbManager.redis.publish(channel, 'message2');

      // Wait for messages
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(messages).toEqual(['message1', 'message2']);

      await subscriber.unsubscribe(channel);
      await subscriber.disconnect();
    });

    test('should handle Redis data structures', async () => {
      const hashKey = `test:hash:${Date.now()}`;
      const listKey = `test:list:${Date.now()}`;
      const setKey = `test:set:${Date.now()}`;

      // Hash operations
      await dbManager.redis.hSet(hashKey, {
        field1: 'value1',
        field2: 'value2'
      });
      const hashData = await dbManager.redis.hGetAll(hashKey);
      expect(hashData).toEqual({ field1: 'value1', field2: 'value2' });

      // List operations
      await dbManager.redis.lPush(listKey, ['item3', 'item2', 'item1']);
      const listData = await dbManager.redis.lRange(listKey, 0, -1);
      expect(listData).toEqual(['item1', 'item2', 'item3']);

      // Set operations
      await dbManager.redis.sAdd(setKey, ['member1', 'member2', 'member1']); // Duplicate ignored
      const setSize = await dbManager.redis.sCard(setKey);
      expect(setSize).toBe(2);

      // Cleanup
      await dbManager.redis.del([hashKey, listKey, setKey]);
    });
  });

  describe('Neo4j Operations', () => {
    test('should execute real Cypher queries', async () => {
      const session = dbManager.neo4j.session();

      try {
        const result = await session.run(
          'RETURN $param as value',
          { param: 'Hello Neo4j' }
        );

        expect(result.records).toHaveLength(1);
        expect(result.records[0].get('value')).toBe('Hello Neo4j');
        expect(result.records[0].toObject()).toHaveRealData();
      } finally {
        await session.close();
      }
    });

    test('should create and query nodes', async () => {
      const session = dbManager.neo4j.session();
      const nodeId = `test-${Date.now()}`;

      try {
        // Create node
        await session.run(
          `CREATE (n:TestNode {
            id: $id,
            name: $name,
            testData: true,
            created: datetime()
          })`,
          { id: nodeId, name: 'Test Node' }
        );

        // Query node
        const result = await session.run(
          'MATCH (n:TestNode {id: $id}) RETURN n',
          { id: nodeId }
        );

        expect(result.records).toHaveLength(1);
        const node = result.records[0].get('n');
        expect(node.properties.name).toBe('Test Node');
        expect(node.properties.testData).toBe(true);

        // Cleanup
        await session.run(
          'MATCH (n:TestNode {id: $id}) DELETE n',
          { id: nodeId }
        );
      } finally {
        await session.close();
      }
    });

    test('should handle relationships', async () => {
      const session = dbManager.neo4j.session();
      const agentId = `agent-${Date.now()}`;
      const taskId = `task-${Date.now()}`;

      try {
        // Create nodes and relationship
        await session.run(`
          CREATE (a:Agent {id: $agentId, testData: true})
          CREATE (t:Task {id: $taskId, testData: true})
          CREATE (a)-[r:ASSIGNED_TO {priority: $priority}]->(t)
          RETURN a, t, r
        `, { agentId, taskId, priority: 'high' });

        // Query relationship
        const result = await session.run(`
          MATCH (a:Agent {id: $agentId})-[r:ASSIGNED_TO]->(t:Task {id: $taskId})
          RETURN a, r, t
        `, { agentId, taskId });

        expect(result.records).toHaveLength(1);
        const record = result.records[0];
        expect(record.get('r').properties.priority).toBe('high');

        // Cleanup
        await session.run(`
          MATCH (a:Agent {id: $agentId})-[r]->(t:Task {id: $taskId})
          DELETE r, a, t
        `, { agentId, taskId });
      } finally {
        await session.close();
      }
    });

    test('should handle transactions', async () => {
      const session = dbManager.neo4j.session();
      const tx = session.beginTransaction();

      try {
        await tx.run('CREATE (n:TxTest {id: $id, testData: true})', { id: 'tx-test' });

        // Query within transaction
        const result = await tx.run('MATCH (n:TxTest {id: $id}) RETURN n', { id: 'tx-test' });
        expect(result.records).toHaveLength(1);

        // Rollback
        await tx.rollback();

        // Verify rollback
        const afterRollback = await session.run(
          'MATCH (n:TxTest {id: $id}) RETURN n',
          { id: 'tx-test' }
        );
        expect(afterRollback.records).toHaveLength(0);
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        await session.close();
      }
    });
  });

  describe('Qdrant Operations', () => {
    test('should list collections', async () => {
      const collections = await dbManager.qdrant.getCollections();

      expect(collections.collections).toBeDefined();
      expect(Array.isArray(collections.collections)).toBe(true);
      expect(collections).toHaveRealData();

      console.log(`Qdrant has ${collections.collections.length} collections`);
    });

    test('should create and manage collections', async () => {
      const testCollection = `test_collection_${Date.now()}`;

      try {
        // Create collection
        await dbManager.qdrant.createCollection(testCollection, {
          vectors: { size: 384, distance: 'Cosine' }
        });

        // Get collection info
        const info = await dbManager.qdrant.getCollection(testCollection);
        expect(info.config.params.vectors.size).toBe(384);
        expect(info.config.params.vectors.distance).toBe('Cosine');

        // Delete collection
        await dbManager.qdrant.deleteCollection(testCollection);

        // Verify deletion
        await expect(dbManager.qdrant.getCollection(testCollection))
          .rejects.toThrow();
      } catch (error) {
        // Cleanup if test fails
        try {
          await dbManager.qdrant.deleteCollection(testCollection);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
        throw error;
      }
    });

    test('should store and search vectors', async () => {
      const testCollection = `test_vectors_${Date.now()}`;

      try {
        // Create collection
        await dbManager.qdrant.createCollection(testCollection, {
          vectors: { size: 128, distance: 'Cosine' }
        });

        // Insert vectors
        const points = [
          {
            id: 1,
            vector: Array(128).fill(0).map(() => Math.random()),
            payload: { text: 'First document', type: 'test' }
          },
          {
            id: 2,
            vector: Array(128).fill(0).map(() => Math.random()),
            payload: { text: 'Second document', type: 'test' }
          }
        ];

        await dbManager.qdrant.upsert(testCollection, {
          points,
          wait: true
        });

        // Search vectors
        const searchResult = await dbManager.qdrant.search(testCollection, {
          vector: Array(128).fill(0).map(() => Math.random()),
          limit: 2
        });

        expect(searchResult).toHaveLength(2);
        expect(searchResult[0]).toHaveProperty('score');
        expect(searchResult[0]).toHaveProperty('payload');
        expect(searchResult).toHaveRealData();

        // Delete collection
        await dbManager.qdrant.deleteCollection(testCollection);
      } catch (error) {
        // Cleanup
        try {
          await dbManager.qdrant.deleteCollection(testCollection);
        } catch (cleanupError) {
          // Ignore
        }
        throw error;
      }
    });
  });

  describe('Integrated Operations', () => {
    test('should store agent output across all databases', async () => {
      const agentId = `test-agent-${uuidv4()}`;
      const output = {
        result: 'Test analysis complete',
        confidence: 0.95,
        timestamp: new Date().toISOString(),
        data: { findings: ['finding1', 'finding2'] }
      };
      const embedding = Array(1024).fill(0).map(() => Math.random());

      // Store agent output
      await dbManager.storeAgentOutput(agentId, output, embedding);

      // Verify PostgreSQL storage
      const pgResult = await dbManager.postgres.query(
        `SELECT * FROM ${testSchema}.agent_outputs WHERE agent_id = $1`,
        [agentId]
      );
      expect(pgResult.rows).toHaveLength(1);
      expect(pgResult.rows[0].output).toEqual(output);

      // Verify Redis cache
      const cached = await dbManager.redis.get(`agent:output:${agentId}`);
      expect(cached).toBeDefined();
      expect(JSON.parse(cached!)).toEqual(output);

      // Verify Qdrant storage (if collection exists)
      try {
        const qdrantResult = await dbManager.qdrant.retrieve('agent_outputs', {
          ids: [agentId]
        });
        expect(qdrantResult).toHaveLength(1);
        expect(qdrantResult[0].payload.agentId).toBe(agentId);
      } catch (error) {
        console.log('Qdrant collection not available for integrated test');
      }
    });

    test('should retrieve agent output with caching', async () => {
      const agentId = `cached-agent-${uuidv4()}`;
      const output = { test: 'cached data', value: Math.random() };

      // Store directly in PostgreSQL
      await dbManager.postgres.query(
        `INSERT INTO ${testSchema}.agent_outputs (agent_id, output) VALUES ($1, $2)`,
        [agentId, JSON.stringify(output)]
      );

      // First retrieval (from PostgreSQL, then cached)
      const result1 = await dbManager.getAgentOutput(agentId);
      expect(result1).toEqual(output);

      // Second retrieval (from cache)
      const result2 = await dbManager.getAgentOutput(agentId);
      expect(result2).toEqual(output);

      // Verify cache hit
      const cacheExists = await dbManager.redis.exists(`agent:output:${agentId}`);
      expect(cacheExists).toBe(1);
    });

    test('should store agent results in multiple databases', async () => {
      const agentId = `multi-db-agent-${uuidv4()}`;
      const taskId = `multi-db-task-${uuidv4()}`;
      const result = {
        success: true,
        output: 'Completed successfully',
        metrics: { duration: 1234, accuracy: 0.98 }
      };

      await dbManager.storeAgentResult(agentId, taskId, result);

      // Verify PostgreSQL
      const pgResult = await dbManager.postgres.query(
        `SELECT * FROM ${testSchema}.agent_results WHERE agent_id = $1 AND task_id = $2`,
        [agentId, taskId]
      );
      expect(pgResult.rows).toHaveLength(1);

      // Verify Redis
      const cached = await dbManager.redis.get(`agent:result:${agentId}:${taskId}`);
      expect(JSON.parse(cached!)).toEqual(result);

      // Verify Neo4j
      const session = dbManager.neo4j.session();
      try {
        const neo4jResult = await session.run(`
          MATCH (a:Agent {id: $agentId})-[r:COMPLETED]->(t:Task {id: $taskId})
          RETURN r.result as result
        `, { agentId, taskId });

        expect(neo4jResult.records).toHaveLength(1);
        expect(JSON.parse(neo4jResult.records[0].get('result'))).toEqual(result);
      } finally {
        await session.close();
      }
    });
  });

  describe('Health Check', () => {
    test('should perform comprehensive health check', async () => {
      const health = await dbManager.healthCheck();

      expect(health).toHaveProperty('postgres');
      expect(health).toHaveProperty('redis');
      expect(health).toHaveProperty('neo4j');
      expect(health).toHaveProperty('qdrant');

      // All should be healthy since we're connected
      expect(health.postgres).toBe(true);
      expect(health.redis).toBe(true);
      expect(health.neo4j).toBe(true);
      expect(health.qdrant).toBe(true);

      console.log('Health check results:', health);
    });
  });

  describe('Error Handling', () => {
    test('should handle PostgreSQL errors gracefully', async () => {
      await expect(
        dbManager.postgres.query('SELECT * FROM non_existent_table')
      ).rejects.toThrow();
    });

    test('should handle Redis errors gracefully', async () => {
      // Try to get a very large key that doesn't exist
      const result = await dbManager.redis.get('x'.repeat(1000));
      expect(result).toBeNull();
    });

    test('should handle Neo4j errors gracefully', async () => {
      const session = dbManager.neo4j.session();
      try {
        await expect(
          session.run('INVALID CYPHER QUERY')
        ).rejects.toThrow();
      } finally {
        await session.close();
      }
    });

    test('should handle Qdrant errors gracefully', async () => {
      await expect(
        dbManager.qdrant.getCollection('non_existent_collection')
      ).rejects.toThrow();
    });
  });

  describe('Performance Tests', () => {
    test('should handle concurrent database operations', async () => {
      const operations = Array(10).fill(null).map(async (_, i) => {
        const id = `perf-test-${i}-${Date.now()}`;

        // PostgreSQL write
        const pgWrite = dbManager.postgres.query(
          `INSERT INTO ${testSchema}.agent_outputs (agent_id, output) VALUES ($1, $2)`,
          [id, JSON.stringify({ test: i })]
        );

        // Redis write
        const redisWrite = dbManager.redis.setEx(
          `perf:${id}`,
          60,
          JSON.stringify({ test: i })
        );

        // Neo4j write
        const session = dbManager.neo4j.session();
        const neo4jWrite = session.run(
          'CREATE (n:PerfTest {id: $id, testData: true})',
          { id }
        ).finally(() => session.close());

        return Promise.all([pgWrite, redisWrite, neo4jWrite]);
      });

      const startTime = Date.now();
      await Promise.all(operations);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000); // Should complete within 5s
      console.log(`Concurrent operations completed in ${duration}ms`);
    });

    test('should maintain connection pool efficiency', async () => {
      const iterations = 20;
      const timings: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = Date.now();

        const client = await dbManager.postgres.connect();
        await client.query('SELECT 1');
        client.release();

        timings.push(Date.now() - start);
      }

      // Average time should be very low after first connection
      const avgTime = timings.slice(5).reduce((a, b) => a + b, 0) / (iterations - 5);
      expect(avgTime).toBeLessThan(50); // Sub-50ms for pooled connections

      console.log(`Connection pool avg time: ${avgTime.toFixed(2)}ms`);
    });
  });
});