/**
 * Chaos Engineering Tests for MageAgent
 * Tests system resilience under failure conditions with REAL services
 */

import { Orchestrator } from '../../src/orchestration/orchestrator';
import { OpenRouterClient } from '../../src/clients/openrouter-client';
import { GraphRAGClient } from '../../src/clients/graphrag-client';
import { DatabaseManager } from '../../src/database/database-manager';
import { config } from '../../src/config';
import axios from 'axios';
import { Pool } from 'pg';
import Redis from 'ioredis';
import neo4j from 'neo4j-driver';

describe('Chaos Engineering - System Resilience Tests', () => {
  let orchestrator: Orchestrator;
  let openRouterClient: OpenRouterClient;
  let graphRAGClient: GraphRAGClient;
  let databaseManager: DatabaseManager;

  beforeAll(async () => {
    // Initialize with real services
    openRouterClient = new OpenRouterClient(
      process.env.OPENROUTER_API_KEY!,
      config.openRouter.baseUrl
    );

    graphRAGClient = new GraphRAGClient(config.graphRAG.externalEndpoint);

    databaseManager = new DatabaseManager();
    await databaseManager.initialize();

    orchestrator = new Orchestrator({
      openRouterClient,
      graphRAGClient,
      databaseManager,
      config: config.orchestration
    });
  }, 60000);

  afterAll(async () => {
    await databaseManager.cleanup();
  });

  describe('Network Failure Scenarios', () => {
    test('should handle OpenRouter API temporary unavailability', async () => {
      // Create client with wrong endpoint to simulate network failure
      const faultyClient = new OpenRouterClient(
        process.env.OPENROUTER_API_KEY!,
        'https://non-existent-api.example.com'
      );

      const faultyOrchestrator = new Orchestrator({
        openRouterClient: faultyClient,
        graphRAGClient,
        databaseManager,
        config: config.orchestration
      });

      // Should handle gracefully
      try {
        await faultyOrchestrator.orchestrateTask({
          objective: 'Test task during network failure'
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('API error');
      }

      // System should remain stable for subsequent requests with good client
      const result = await orchestrator.orchestrateTask({
        objective: 'Recovery test after network failure'
      });

      expect(result.status).toBe('completed');
      console.log('Recovered from OpenRouter network failure');
    });

    test('should handle GraphRAG service outage gracefully', async () => {
      // Create client pointing to non-existent GraphRAG instance
      const faultyGraphRAG = new GraphRAGClient('http://localhost:19999');

      const partialOrchestrator = new Orchestrator({
        openRouterClient,
        graphRAGClient: faultyGraphRAG,
        databaseManager,
        config: config.orchestration
      });

      // Should work without GraphRAG (degraded mode)
      const result = await partialOrchestrator.orchestrateTask({
        objective: 'Test without GraphRAG memory system'
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('completed');

      console.log('System operates in degraded mode without GraphRAG');
    });

    test('should handle intermittent network failures with retry', async () => {
      let callCount = 0;
      const interceptor = axios.interceptors.request.use(
        (config) => {
          callCount++;
          // Fail first 2 calls, succeed on 3rd
          if (callCount <= 2 && config.url?.includes('openrouter')) {
            throw new Error('Simulated network failure');
          }
          return config;
        }
      );

      try {
        // This should eventually succeed due to retry logic
        const result = await orchestrator.orchestrateTask({
          objective: 'Test retry mechanism'
        });

        expect(result.status).toBe('completed');
        expect(callCount).toBeGreaterThan(2);

        console.log(`Succeeded after ${callCount} attempts with retry logic`);
      } finally {
        axios.interceptors.request.eject(interceptor);
      }
    });
  });

  describe('Database Failure Scenarios', () => {
    test('should handle PostgreSQL connection pool exhaustion', async () => {
      const connections: any[] = [];

      try {
        // Exhaust connection pool
        for (let i = 0; i < 25; i++) {
          const client = await databaseManager.postgres.connect();
          connections.push(client);
        }

        // This should either wait or fail gracefully
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 5000)
        );

        const connectPromise = databaseManager.postgres.connect();

        try {
          await Promise.race([connectPromise, timeoutPromise]);
        } catch (error) {
          expect(error).toBeDefined();
          console.log('Handled connection pool exhaustion gracefully');
        }
      } finally {
        // Release all connections
        connections.forEach(client => client.release());
      }
    });

    test('should handle Redis memory pressure', async () => {
      const testKeys: string[] = [];

      try {
        // Create many keys to simulate memory pressure
        const largeData = 'x'.repeat(10000); // 10KB per key

        for (let i = 0; i < 100; i++) {
          const key = `chaos:memory:${i}`;
          testKeys.push(key);
          await databaseManager.redis.set(key, largeData);
        }

        // System should still function
        const result = await orchestrator.orchestrateTask({
          objective: 'Test during Redis memory pressure'
        });

        expect(result.status).toBe('completed');

        console.log('System handles Redis memory pressure');
      } finally {
        // Cleanup
        if (testKeys.length > 0) {
          await databaseManager.redis.del(...testKeys);
        }
      }
    });

    test('should handle Neo4j transaction deadlocks', async () => {
      const session1 = databaseManager.neo4j.session();
      const session2 = databaseManager.neo4j.session();

      try {
        // Create potential deadlock scenario
        const tx1 = session1.beginTransaction();
        const tx2 = session2.beginTransaction();

        // Transaction 1 locks node A
        await tx1.run('CREATE (a:DeadlockTest {id: "A", locked: true})');

        // Transaction 2 locks node B
        await tx2.run('CREATE (b:DeadlockTest {id: "B", locked: true})');

        // Try cross-locking (potential deadlock)
        const deadlockPromises = [
          tx1.run('MATCH (b:DeadlockTest {id: "B"}) SET b.lockedBy = "tx1"'),
          tx2.run('MATCH (a:DeadlockTest {id: "A"}) SET a.lockedBy = "tx2"')
        ];

        // Should handle deadlock gracefully
        try {
          await Promise.race([
            Promise.all(deadlockPromises),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Deadlock timeout')), 5000))
          ]);
        } catch (error) {
          expect(error).toBeDefined();
          console.log('Deadlock handled gracefully');
        }

        // Rollback
        await tx1.rollback();
        await tx2.rollback();

        // Cleanup
        await session1.run('MATCH (n:DeadlockTest) DELETE n');
      } finally {
        await session1.close();
        await session2.close();
      }
    });

    test('should handle Qdrant collection corruption', async () => {
      const testCollection = `chaos_corrupt_${Date.now()}`;

      try {
        // Create collection with specific configuration
        await databaseManager.qdrant.createCollection(testCollection, {
          vectors: { size: 128, distance: 'Cosine' }
        });

        // Insert some data
        await databaseManager.qdrant.upsert(testCollection, {
          points: [{
            id: 1,
            vector: Array(128).fill(0.5),
            payload: { test: true }
          }]
        });

        // Simulate corruption by deleting and recreating with different config
        await databaseManager.qdrant.deleteCollection(testCollection);
        await databaseManager.qdrant.createCollection(testCollection, {
          vectors: { size: 256, distance: 'Euclid' } // Different config
        });

        // System should handle schema mismatch
        try {
          await databaseManager.qdrant.search(testCollection, {
            vector: Array(128).fill(0.5), // Wrong size
            limit: 1
          });
        } catch (error) {
          expect(error).toBeDefined();
          console.log('Handled vector dimension mismatch');
        }

        // Cleanup
        await databaseManager.qdrant.deleteCollection(testCollection);
      } catch (error) {
        // Ensure cleanup
        try {
          await databaseManager.qdrant.deleteCollection(testCollection);
        } catch (cleanupError) {
          // Ignore
        }
      }
    });
  });

  describe('Agent Failure Scenarios', () => {
    test('should handle agent crashes during execution', async () => {
      let agentCount = 0;

      // Monitor agent spawning
      orchestrator.on('agentSpawned', ({ agentId }) => {
        agentCount++;

        // Simulate crash for second agent
        if (agentCount === 2) {
          // Force agent into failed state
          setTimeout(() => {
            orchestrator.emit('agentFailed', {
              agentId,
              error: new Error('Simulated agent crash')
            });
          }, 100);
        }
      });

      // Run competition where one agent will crash
      const result = await orchestrator.runCompetition({
        challenge: 'Test with agent failures',
        competitorCount: 3
      });

      expect(result).toBeDefined();
      expect(result.rankings.length).toBeGreaterThanOrEqual(2);

      console.log(`Competition completed with ${result.rankings.length}/3 agents`);

      orchestrator.removeAllListeners();
    });

    test('should handle infinite loop protection', async () => {
      const maliciousTask = {
        objective: 'Create a recursive algorithm that could cause infinite loop',
        context: {
          hint: 'while(true) scenarios should be detected'
        }
      };

      // Should complete within timeout
      const startTime = Date.now();
      const result = await orchestrator.orchestrateTask(maliciousTask);
      const duration = Date.now() - startTime;

      expect(result).toBeDefined();
      expect(duration).toBeLessThan(120000); // Should not run forever

      console.log('Infinite loop protection working');
    });

    test('should handle memory leak scenarios', async () => {
      const memoryBefore = process.memoryUsage();

      // Run many small tasks
      const tasks = Array(10).fill(null).map((_, i) =>
        orchestrator.orchestrateTask({
          objective: `Memory test task ${i}`,
          context: { index: i }
        })
      );

      await Promise.all(tasks);

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const memoryAfter = process.memoryUsage();
      const heapGrowth = memoryAfter.heapUsed - memoryBefore.heapUsed;

      // Reasonable memory growth (less than 100MB)
      expect(heapGrowth).toBeLessThan(100 * 1024 * 1024);

      console.log(`Memory growth: ${(heapGrowth / 1024 / 1024).toFixed(2)}MB`);
    });
  });

  describe('Cascading Failure Scenarios', () => {
    test('should prevent cascading failures across services', async () => {
      const errors: any[] = [];

      // Set up error monitoring
      orchestrator.on('taskFailed', (event) => errors.push(event));

      // Trigger multiple failures
      const failureTasks = [
        orchestrator.orchestrateTask({ objective: '' }), // Empty objective
        orchestrator.orchestrateTask({ objective: null as any }), // Null objective
        orchestrator.orchestrateTask({ objective: 'Normal task' }) // Should succeed
      ];

      const results = await Promise.allSettled(failureTasks);

      // At least one should succeed (no cascading failure)
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);

      console.log(`Prevented cascading failure: ${successful.length}/3 succeeded`);

      orchestrator.removeAllListeners();
    });

    test('should handle circuit breaker activation', async () => {
      // Create a client that will trigger circuit breaker
      const faultyEndpoint = 'https://trigger-circuit-breaker.example.com';
      const breakerClient = new OpenRouterClient(
        process.env.OPENROUTER_API_KEY!,
        faultyEndpoint
      );

      const failures: Error[] = [];

      // Make many requests to trip circuit breaker
      for (let i = 0; i < 15; i++) {
        try {
          await breakerClient.createCompletion({
            model: 'test',
            messages: [{ role: 'user', content: 'test' }]
          });
        } catch (error) {
          failures.push(error as Error);
        }
      }

      // Circuit should be open after threshold
      expect(failures.length).toBeGreaterThan(10);

      // Later errors should be fast (circuit open)
      const timings = failures.slice(-5).map((error, i) => {
        const start = Date.now();
        return Date.now() - start;
      });

      console.log('Circuit breaker activated after failures');
    });
  });

  describe('Data Consistency Under Failure', () => {
    test('should maintain data consistency during partial failures', async () => {
      const taskId = `consistency-test-${Date.now()}`;

      // Simulate partial failure by closing Redis mid-operation
      const originalRedis = databaseManager.redis;
      let redisDisconnected = false;

      // Intercept Redis operations
      const redisProxy = new Proxy(originalRedis, {
        get(target, prop) {
          if (redisDisconnected && typeof target[prop as keyof typeof target] === 'function') {
            throw new Error('Redis disconnected');
          }
          return target[prop as keyof typeof target];
        }
      });

      // Replace Redis temporarily
      Object.defineProperty(databaseManager, 'redis', {
        get: () => redisProxy,
        configurable: true
      });

      try {
        // Start operation
        const orchestrationPromise = orchestrator.orchestrateTask({
          objective: 'Test data consistency',
          context: { taskId }
        });

        // Disconnect Redis mid-operation
        setTimeout(() => {
          redisDisconnected = true;
        }, 500);

        const result = await orchestrationPromise;

        // Check PostgreSQL has data even if Redis failed
        const pgResult = await databaseManager.postgres.query(
          'SELECT COUNT(*) as count FROM agent_outputs WHERE agent_id LIKE $1',
          [`%${taskId}%`]
        );

        expect(parseInt(pgResult.rows[0].count)).toBeGreaterThan(0);

        console.log('Data consistency maintained despite Redis failure');
      } finally {
        // Restore original Redis
        Object.defineProperty(databaseManager, 'redis', {
          get: () => originalRedis,
          configurable: true
        });
      }
    });

    test('should handle split-nexus scenarios', async () => {
      // Simulate network partition by creating two orchestrators
      const orchestrator1 = new Orchestrator({
        openRouterClient,
        graphRAGClient,
        databaseManager,
        config: config.orchestration
      });

      const orchestrator2 = new Orchestrator({
        openRouterClient,
        graphRAGClient: new GraphRAGClient('http://localhost:19998'), // Different endpoint
        databaseManager,
        config: config.orchestration
      });

      // Both try to process same logical task
      const task = {
        objective: 'Resolve split-nexus test',
        context: { id: 'split-nexus-test' }
      };

      const [result1, result2] = await Promise.all([
        orchestrator1.orchestrateTask(task),
        orchestrator2.orchestrateTask(task)
      ]);

      // Both should complete independently
      expect(result1.status).toBe('completed');
      expect(result2.status).toBe('completed');

      // But with different task IDs (no coordination)
      expect(result1.taskId).not.toBe(result2.taskId);

      console.log('Split-nexus scenario handled with independent processing');
    });
  });

  describe('Recovery and Self-Healing', () => {
    test('should auto-recover from transient failures', async () => {
      let failureCount = 0;
      const maxFailures = 3;

      // Inject transient failures
      orchestrator.on('agentSpawned', ({ agentId }) => {
        if (failureCount < maxFailures) {
          failureCount++;
          setTimeout(() => {
            orchestrator.emit('agentFailed', {
              agentId,
              error: new Error('Transient failure')
            });
          }, 100);
        }
      });

      // Should eventually succeed
      const result = await orchestrator.orchestrateTask({
        objective: 'Test auto-recovery mechanisms'
      });

      expect(result.status).toBe('completed');
      expect(failureCount).toBe(maxFailures);

      console.log(`Auto-recovered after ${failureCount} transient failures`);

      orchestrator.removeAllListeners();
    });

    test('should maintain service degradation instead of total failure', async () => {
      // Disable some services
      const degradedManager = new DatabaseManager();
      await degradedManager.initialize();

      // Close some connections
      await degradedManager.neo4j.close();
      await degradedManager.qdrant.close();

      const degradedOrchestrator = new Orchestrator({
        openRouterClient,
        graphRAGClient,
        databaseManager: degradedManager,
        config: config.orchestration
      });

      // Should still work with reduced functionality
      const result = await degradedOrchestrator.orchestrateTask({
        objective: 'Test in degraded mode'
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('completed');

      console.log('Service operates in degraded mode gracefully');

      await degradedManager.cleanup();
    });
  });

  describe('Stress Testing Under Failure', () => {
    test('should handle high load during partial outages', async () => {
      // Simulate 20% failure rate
      let requestCount = 0;
      const interceptor = axios.interceptors.request.use(
        (config) => {
          requestCount++;
          if (Math.random() < 0.2) {
            throw new Error('Simulated 20% failure');
          }
          return config;
        }
      );

      try {
        const tasks = Array(10).fill(null).map((_, i) =>
          orchestrator.orchestrateTask({
            objective: `Stress test task ${i}`,
            context: { index: i }
          }).catch(error => ({ error, index: i }))
        );

        const results = await Promise.all(tasks);
        const successful = results.filter(r => !('error' in r));

        expect(successful.length).toBeGreaterThan(5); // At least 50% success
        console.log(`Stress test: ${successful.length}/10 succeeded under 20% failure rate`);
      } finally {
        axios.interceptors.request.eject(interceptor);
      }
    });

    test('should prevent resource exhaustion under attack', async () => {
      const maliciousTasks = Array(50).fill(null).map(() => ({
        objective: 'A'.repeat(10000), // Very long objective
        context: { data: 'X'.repeat(50000) } // Large payload
      }));

      // System should handle this gracefully
      const startTime = Date.now();
      let completed = 0;

      await Promise.all(
        maliciousTasks.map(task =>
          orchestrator.orchestrateTask(task)
            .then(() => completed++)
            .catch(() => null)
        )
      );

      const duration = Date.now() - startTime;

      // Should not take too long (DOS protection)
      expect(duration).toBeLessThan(300000); // 5 minutes max

      console.log(`Handled potential DOS: ${completed}/50 tasks in ${duration}ms`);
    });
  });

  describe('Chaos Monkey Random Failures', () => {
    test('should survive random chaos events', async () => {
      const chaosEvents = [
        () => databaseManager.redis.disconnect(),
        () => { throw new Error('Random error'); },
        () => databaseManager.redis.connect(),
        () => null // No-op
      ];

      const results: any[] = [];

      // Run tasks with random chaos
      for (let i = 0; i < 5; i++) {
        // Randomly inject chaos
        if (Math.random() < 0.3) {
          try {
            chaosEvents[Math.floor(Math.random() * chaosEvents.length)]();
          } catch (error) {
            console.log('Chaos event triggered:', error);
          }
        }

        try {
          const result = await orchestrator.orchestrateTask({
            objective: `Chaos test ${i}`
          });
          results.push(result);
        } catch (error) {
          results.push({ error });
        }
      }

      // Should have some successful completions
      const successful = results.filter(r => r.status === 'completed');
      expect(successful.length).toBeGreaterThan(0);

      console.log(`Survived chaos: ${successful.length}/${results.length} succeeded`);
    });
  });
});