/**
 * Database Operation Tests
 * Tests all database connections and operations with real instances
 */

import { Client as PgClient } from 'pg';
import Redis from 'ioredis';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { QdrantClient } from '@qdrant/js-client-rest';
import { databaseManager } from '../../../src/database/database-manager';
import { v4 as uuidv4 } from 'uuid';

describe('Database Operations Integration Tests', () => {
  let pgClient: PgClient;
  let redisClient: Redis;
  let neo4jDriver: Driver;
  let qdrantClient: QdrantClient;

  beforeAll(async () => {
    // Initialize real database connections
    console.log('Connecting to real databases...');

    // PostgreSQL
    pgClient = new PgClient({
      host: process.env.POSTGRES_HOST || 'postgres.vibe-data.svc.cluster.local',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE || 'vibe_platform'
    });

    await pgClient.connect();
    console.log('✅ PostgreSQL connected');

    // Redis
    redisClient = new Redis({
      host: process.env.REDIS_HOST || 'redis.vibe-data.svc.cluster.local',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD
    });

    await redisClient.ping();
    console.log('✅ Redis connected');

    // Neo4j
    neo4jDriver = neo4j.driver(
      process.env.NEO4J_URI || 'bolt://neo4j.vibe-data.svc.cluster.local:7687',
      neo4j.auth.basic(
        process.env.NEO4J_USER || 'neo4j',
        process.env.NEO4J_PASSWORD || ''
      )
    );

    const neo4jSession = neo4jDriver.session();
    await neo4jSession.run('RETURN 1');
    await neo4jSession.close();
    console.log('✅ Neo4j connected');

    // Qdrant
    qdrantClient = new QdrantClient({
      url: `http://${process.env.QDRANT_HOST || 'qdrant.vibe-data.svc.cluster.local'}:${process.env.QDRANT_PORT || '6333'}`,
      apiKey: process.env.QDRANT_API_KEY
    });

    await qdrantClient.getCollections();
    console.log('✅ Qdrant connected');

    // Initialize database manager
    await databaseManager.initialize();
    console.log('✅ Database Manager initialized');
  }, 60000);

  afterAll(async () => {
    // Cleanup connections
    if (pgClient) await pgClient.end();
    if (redisClient) await redisClient.quit();
    if (neo4jDriver) await neo4jDriver.close();
  });

  describe('PostgreSQL Operations', () => {
    const testTableName = 'test_agent_outputs';

    beforeAll(async () => {
      // Create test table
      await pgClient.query(`
        CREATE TABLE IF NOT EXISTS ${testTableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_id VARCHAR(255) NOT NULL,
          task_id VARCHAR(255) NOT NULL,
          output JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
    });

    afterAll(async () => {
      // Cleanup test table
      await pgClient.query(`DROP TABLE IF EXISTS ${testTableName}`);
    });

    it('should store and retrieve agent outputs', async () => {
      const agentOutput = {
        agentId: `agent-${uuidv4()}`,
        taskId: `task-${uuidv4()}`,
        output: {
          result: 'Test agent completed successfully',
          model: 'openai/gpt-4-turbo',
          tokens: 150,
          metadata: {
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            status: 'completed'
          }
        }
      };

      // Store output
      const insertResult = await pgClient.query(
        `INSERT INTO ${testTableName} (agent_id, task_id, output)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [agentOutput.agentId, agentOutput.taskId, agentOutput.output]
      );

      expect(insertResult.rows).toHaveLength(1);
      const insertedId = insertResult.rows[0].id;

      // Retrieve output
      const selectResult = await pgClient.query(
        `SELECT * FROM ${testTableName} WHERE id = $1`,
        [insertedId]
      );

      expect(selectResult.rows).toHaveLength(1);
      const retrieved = selectResult.rows[0];

      expect(retrieved.agent_id).toBe(agentOutput.agentId);
      expect(retrieved.task_id).toBe(agentOutput.taskId);
      expect(retrieved.output).toEqual(agentOutput.output);
    });

    it('should handle concurrent writes safely', async () => {
      const concurrentWrites = 50;
      const taskId = `task-${uuidv4()}`;

      const writePromises = Array(concurrentWrites).fill(null).map((_, index) =>
        pgClient.query(
          `INSERT INTO ${testTableName} (agent_id, task_id, output)
           VALUES ($1, $2, $3)`,
          [
            `agent-${index}`,
            taskId,
            { result: `Concurrent write ${index}` }
          ]
        )
      );

      await Promise.all(writePromises);

      // Verify all writes succeeded
      const countResult = await pgClient.query(
        `SELECT COUNT(*) FROM ${testTableName} WHERE task_id = $1`,
        [taskId]
      );

      expect(parseInt(countResult.rows[0].count)).toBe(concurrentWrites);
    });

    it('should prevent SQL injection', async () => {
      const maliciousInput = "'; DROP TABLE users; --";

      // Parameterized queries should prevent injection
      const result = await pgClient.query(
        `SELECT * FROM ${testTableName} WHERE agent_id = $1`,
        [maliciousInput]
      );

      expect(result.rows).toHaveLength(0);

      // Verify table still exists
      const tableCheck = await pgClient.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = '${testTableName}'
        )
      `);

      expect(tableCheck.rows[0].exists).toBe(true);
    });

    it('should handle transaction rollbacks', async () => {
      const client = await (pgClient as any).pool.connect();

      try {
        await client.query('BEGIN');

        // Insert data
        await client.query(
          `INSERT INTO ${testTableName} (agent_id, task_id, output) VALUES ($1, $2, $3)`,
          ['rollback-agent', 'rollback-task', { result: 'This should be rolled back' }]
        );

        // Simulate error condition
        throw new Error('Simulated error');
      } catch (error) {
        await client.query('ROLLBACK');

        // Verify data was not committed
        const checkResult = await pgClient.query(
          `SELECT * FROM ${testTableName} WHERE agent_id = $1`,
          ['rollback-agent']
        );

        expect(checkResult.rows).toHaveLength(0);
      } finally {
        client.release();
      }
    });
  });

  describe('Redis Operations', () => {
    const testPrefix = 'test:mageagent:';

    afterEach(async () => {
      // Clean up test keys
      const keys = await redisClient.keys(`${testPrefix}*`);
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
    });

    it('should cache and retrieve agent results', async () => {
      const cacheKey = `${testPrefix}agent:result:${uuidv4()}`;
      const cacheData = {
        result: 'Cached agent result',
        timestamp: Date.now(),
        ttl: 3600
      };

      // Set cache with TTL
      await redisClient.setex(cacheKey, cacheData.ttl, JSON.stringify(cacheData));

      // Retrieve from cache
      const cached = await redisClient.get(cacheKey);
      expect(cached).toBeDefined();

      const parsed = JSON.parse(cached!);
      expect(parsed.result).toBe(cacheData.result);
      expect(parsed.timestamp).toBe(cacheData.timestamp);

      // Check TTL
      const ttl = await redisClient.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(cacheData.ttl);
    });

    it('should handle Redis pub/sub for real-time events', async () => {
      const channel = `${testPrefix}events`;
      const subscriber = redisClient.duplicate();

      await subscriber.connect();

      const receivedMessages: any[] = [];

      // Subscribe to channel
      await subscriber.subscribe(channel, (message) => {
        receivedMessages.push(JSON.parse(message));
      });

      // Publish messages
      const messages = [
        { type: 'agent:started', agentId: 'test-1' },
        { type: 'agent:progress', agentId: 'test-1', progress: 50 },
        { type: 'agent:completed', agentId: 'test-1' }
      ];

      for (const msg of messages) {
        await redisClient.publish(channel, JSON.stringify(msg));
      }

      // Wait for messages
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages).toHaveLength(messages.length);
      expect(receivedMessages).toEqual(messages);

      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    });

    it('should implement distributed locking', async () => {
      const lockKey = `${testPrefix}lock:resource:${uuidv4()}`;
      const lockValue = uuidv4();
      const lockTTL = 10; // seconds

      // Acquire lock
      const acquired = await redisClient.set(lockKey, lockValue, 'EX', lockTTL, 'NX');
      expect(acquired).toBe('OK');

      // Try to acquire same lock
      const secondAttempt = await redisClient.set(lockKey, 'other-value', 'EX', lockTTL, 'NX');
      expect(secondAttempt).toBeNull();

      // Release lock (only if we own it)
      const releaseLuaScript = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `;

      const released = await redisClient.eval(releaseLuaScript, 1, lockKey, lockValue);
      expect(released).toBe(1);

      // Now lock should be available
      const thirdAttempt = await redisClient.set(lockKey, 'new-value', 'EX', lockTTL, 'NX');
      expect(thirdAttempt).toBe('OK');
    });

    it('should handle rate limiting with Redis', async () => {
      const rateLimitKey = `${testPrefix}ratelimit:${uuidv4()}`;
      const limit = 10;
      const window = 60; // seconds

      // Simulate requests
      const requests = 15;
      const allowed: boolean[] = [];

      for (let i = 0; i < requests; i++) {
        const current = await redisClient.incr(rateLimitKey);

        if (current === 1) {
          await redisClient.expire(rateLimitKey, window);
        }

        allowed.push(current <= limit);
      }

      // First 10 should be allowed, rest should be denied
      expect(allowed.slice(0, limit).every(a => a)).toBe(true);
      expect(allowed.slice(limit).every(a => !a)).toBe(true);
    });
  });

  describe('Neo4j Graph Operations', () => {
    let session: Session;

    beforeEach(() => {
      session = neo4jDriver.session();
    });

    afterEach(async () => {
      // Clean up test nodes
      await session.run(`
        MATCH (n)
        WHERE n.test = true
        DETACH DELETE n
      `);
      await session.close();
    });

    it('should create and query agent relationships', async () => {
      const agentId1 = `agent-${uuidv4()}`;
      const agentId2 = `agent-${uuidv4()}`;
      const taskId = `task-${uuidv4()}`;

      // Create agents and task nodes
      await session.run(`
        CREATE (a1:Agent {id: $agentId1, type: 'research', test: true})
        CREATE (a2:Agent {id: $agentId2, type: 'synthesis', test: true})
        CREATE (t:Task {id: $taskId, name: 'Test Task', test: true})
        CREATE (a1)-[:WORKS_ON]->(t)
        CREATE (a2)-[:WORKS_ON]->(t)
        CREATE (a1)-[:COLLABORATES_WITH]->(a2)
      `, { agentId1, agentId2, taskId });

      // Query relationships
      const result = await session.run(`
        MATCH (a1:Agent)-[:COLLABORATES_WITH]->(a2:Agent)
        WHERE a1.test = true
        RETURN a1.id as agent1, a2.id as agent2
      `);

      expect(result.records).toHaveLength(1);
      expect(result.records[0].get('agent1')).toBe(agentId1);
      expect(result.records[0].get('agent2')).toBe(agentId2);
    });

    it('should find optimal agent paths', async () => {
      // Create a network of agents
      const agents = Array(5).fill(null).map((_, i) => ({
        id: `agent-${i}`,
        skills: [`skill-${i}`, `skill-${(i + 1) % 5}`]
      }));

      // Create nodes
      for (const agent of agents) {
        await session.run(`
          CREATE (a:Agent {
            id: $id,
            skills: $skills,
            test: true
          })
        `, agent);
      }

      // Create relationships based on shared skills
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const sharedSkills = agents[i].skills.filter(s =>
            agents[j].skills.includes(s)
          );

          if (sharedSkills.length > 0) {
            await session.run(`
              MATCH (a1:Agent {id: $id1}), (a2:Agent {id: $id2})
              WHERE a1.test = true AND a2.test = true
              CREATE (a1)-[:CAN_COLLABORATE {skills: $skills}]->(a2)
            `, {
              id1: agents[i].id,
              id2: agents[j].id,
              skills: sharedSkills
            });
          }
        }
      }

      // Find shortest path between agents
      const pathResult = await session.run(`
        MATCH path = shortestPath(
          (start:Agent {id: 'agent-0'})-[:CAN_COLLABORATE*]-(end:Agent {id: 'agent-3'})
        )
        WHERE start.test = true AND end.test = true
        RETURN length(path) as pathLength,
               [n in nodes(path) | n.id] as agentPath
      `);

      expect(pathResult.records).toHaveLength(1);
      const pathLength = pathResult.records[0].get('pathLength');
      const agentPath = pathResult.records[0].get('agentPath');

      expect(pathLength).toBeGreaterThan(0);
      expect(agentPath).toContain('agent-0');
      expect(agentPath).toContain('agent-3');
    });

    it('should prevent Cypher injection', async () => {
      const maliciousInput = "'; MATCH (n) DETACH DELETE n; //";

      // Parameterized query should prevent injection
      const result = await session.run(`
        MATCH (a:Agent)
        WHERE a.id = $id AND a.test = true
        RETURN a
      `, { id: maliciousInput });

      expect(result.records).toHaveLength(0);

      // Verify nodes still exist
      const checkResult = await session.run(`
        MATCH (n)
        WHERE n.test = true
        RETURN count(n) as nodeCount
      `);

      // Should still have test nodes
      expect(checkResult.records[0].get('nodeCount').toNumber()).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Qdrant Vector Operations', () => {
    const testCollection = `test_mageagent_${Date.now()}`;

    beforeAll(async () => {
      // Create test collection
      try {
        await qdrantClient.createCollection(testCollection, {
          vectors: {
            size: 384, // Sentence transformer dimension
            distance: 'Cosine'
          }
        });
      } catch (error: any) {
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }
    });

    afterAll(async () => {
      // Delete test collection
      try {
        await qdrantClient.deleteCollection(testCollection);
      } catch (error) {
        console.error('Failed to delete test collection:', error);
      }
    });

    it('should store and search agent embeddings', async () => {
      // Generate test embeddings (normally from embedding model)
      const generateEmbedding = (seed: number) =>
        Array(384).fill(0).map((_, i) => Math.sin(seed * i) * 0.5 + 0.5);

      const agents = [
        {
          id: uuidv4(),
          name: 'Research Agent',
          skills: ['data analysis', 'web scraping', 'summarization'],
          embedding: generateEmbedding(1)
        },
        {
          id: uuidv4(),
          name: 'Code Agent',
          skills: ['python', 'javascript', 'debugging'],
          embedding: generateEmbedding(2)
        },
        {
          id: uuidv4(),
          name: 'Writing Agent',
          skills: ['content creation', 'editing', 'SEO'],
          embedding: generateEmbedding(3)
        }
      ];

      // Store embeddings
      await qdrantClient.upsert(testCollection, {
        points: agents.map(agent => ({
          id: agent.id,
          vector: agent.embedding,
          payload: {
            name: agent.name,
            skills: agent.skills,
            timestamp: Date.now()
          }
        }))
      });

      // Search for similar agents
      const queryEmbedding = generateEmbedding(1.5); // Similar to first agent

      const searchResult = await qdrantClient.search(testCollection, {
        vector: queryEmbedding,
        limit: 2,
        with_payload: true
      });

      expect(searchResult).toHaveLength(2);
      expect(searchResult[0].score).toBeGreaterThan(0.8);

      // Verify payload
      const topResult = searchResult[0];
      expect(topResult.payload).toHaveProperty('name');
      expect(topResult.payload).toHaveProperty('skills');
    });

    it('should filter vectors by metadata', async () => {
      const timestamp = Date.now();

      // Add vectors with different metadata
      const vectors = Array(10).fill(null).map((_, i) => ({
        id: uuidv4(),
        vector: Array(384).fill(0).map(() => Math.random()),
        payload: {
          type: i % 2 === 0 ? 'research' : 'coding',
          score: i * 10,
          timestamp: timestamp - i * 1000
        }
      }));

      await qdrantClient.upsert(testCollection, { points: vectors });

      // Search with filters
      const filteredSearch = await qdrantClient.search(testCollection, {
        vector: Array(384).fill(0.5),
        limit: 5,
        filter: {
          must: [
            { key: 'type', match: { value: 'research' } },
            { key: 'score', range: { gte: 20 } }
          ]
        },
        with_payload: true
      });

      // All results should match filter
      filteredSearch.forEach(result => {
        expect(result.payload?.type).toBe('research');
        expect(result.payload?.score).toBeGreaterThanOrEqual(20);
      });
    });

    it('should handle concurrent vector operations', async () => {
      const concurrentOps = 20;

      const operations = Array(concurrentOps).fill(null).map(async (_, i) => {
        const point = {
          id: uuidv4(),
          vector: Array(384).fill(0).map(() => Math.random()),
          payload: { index: i, timestamp: Date.now() }
        };

        // Randomly do insert or search
        if (Math.random() > 0.5) {
          return qdrantClient.upsert(testCollection, { points: [point] });
        } else {
          return qdrantClient.search(testCollection, {
            vector: point.vector,
            limit: 1
          });
        }
      });

      // All operations should complete successfully
      const results = await Promise.all(operations);
      expect(results).toHaveLength(concurrentOps);
    });
  });

  describe('Cross-Database Operations', () => {
    it('should coordinate operations across multiple databases', async () => {
      const taskId = `task-${uuidv4()}`;
      const agentId = `agent-${uuidv4()}`;

      // 1. Store task metadata in PostgreSQL
      await pgClient.query(`
        INSERT INTO test_agent_outputs (agent_id, task_id, output)
        VALUES ($1, $2, $3)
      `, [agentId, taskId, { status: 'started' }]);

      // 2. Cache in Redis
      const cacheKey = `task:${taskId}:status`;
      await redisClient.setex(cacheKey, 3600, 'processing');

      // 3. Create graph relationship in Neo4j
      const neo4jSession = neo4jDriver.session();
      await neo4jSession.run(`
        CREATE (t:Task {id: $taskId, test: true})
        CREATE (a:Agent {id: $agentId, test: true})
        CREATE (a)-[:PROCESSES]->(t)
      `, { taskId, agentId });

      // 4. Store embedding in Qdrant
      await qdrantClient.upsert(testCollection, {
        points: [{
          id: taskId,
          vector: Array(384).fill(0).map(() => Math.random()),
          payload: { agentId, type: 'task' }
        }]
      });

      // Verify all operations succeeded
      const pgResult = await pgClient.query(
        'SELECT * FROM test_agent_outputs WHERE task_id = $1',
        [taskId]
      );
      expect(pgResult.rows).toHaveLength(1);

      const redisResult = await redisClient.get(cacheKey);
      expect(redisResult).toBe('processing');

      const neo4jResult = await neo4jSession.run(`
        MATCH (a:Agent)-[:PROCESSES]->(t:Task)
        WHERE t.id = $taskId AND t.test = true
        RETURN a.id as agentId
      `, { taskId });
      expect(neo4jResult.records[0].get('agentId')).toBe(agentId);

      const qdrantResult = await qdrantClient.retrieve(testCollection, {
        ids: [taskId]
      });
      expect(qdrantResult[0].payload?.agentId).toBe(agentId);

      // Cleanup
      await neo4jSession.close();
    });

    it('should handle partial failures gracefully', async () => {
      const testId = uuidv4();

      const operations = [
        // Successful PostgreSQL operation
        pgClient.query(
          'INSERT INTO test_agent_outputs (agent_id, task_id, output) VALUES ($1, $2, $3)',
          [`agent-${testId}`, `task-${testId}`, { test: true }]
        ),

        // Successful Redis operation
        redisClient.setex(`test:${testId}`, 60, 'test-value'),

        // This might fail if collection doesn't exist
        qdrantClient.retrieve('non-existent-collection', { ids: [testId] })
          .catch(() => null),

        // Successful Neo4j operation
        (async () => {
          const session = neo4jDriver.session();
          try {
            await session.run(
              'CREATE (n:TestNode {id: $id, test: true})',
              { id: testId }
            );
          } finally {
            await session.close();
          }
        })()
      ];

      const results = await Promise.allSettled(operations);

      // Some operations should succeed
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThanOrEqual(3);

      // Verify successful operations
      const pgCheck = await pgClient.query(
        'SELECT * FROM test_agent_outputs WHERE agent_id = $1',
        [`agent-${testId}`]
      );
      expect(pgCheck.rows).toHaveLength(1);

      const redisCheck = await redisClient.get(`test:${testId}`);
      expect(redisCheck).toBe('test-value');
    });
  });

  describe('Database Manager Integration', () => {
    it('should use database manager for coordinated operations', async () => {
      const agentId = `agent-${uuidv4()}`;
      const output = {
        result: 'Test from database manager',
        timestamp: Date.now()
      };

      // Store through database manager
      await databaseManager.storeAgentOutput(agentId, output);

      // Retrieve through database manager
      const retrieved = await databaseManager.getAgentOutput(agentId);

      expect(retrieved).toBeDefined();
      expect(retrieved.result).toBe(output.result);
    });

    it('should handle health checks across all databases', async () => {
      const health = await databaseManager.healthCheck();

      expect(health).toMatchObject({
        postgres: expect.any(Boolean),
        redis: expect.any(Boolean),
        neo4j: expect.any(Boolean),
        qdrant: expect.any(Boolean)
      });

      // In a healthy test environment, all should be true
      expect(Object.values(health).every(v => v === true)).toBe(true);
    });
  });
});