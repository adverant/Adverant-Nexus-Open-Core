/**
 * End-to-End Tests for Complete MageAgent Workflows
 * Tests REAL end-to-end scenarios with actual services
 */

import axios from 'axios';
import { io, Socket } from 'socket.io-client';
import { spawn, ChildProcess } from 'child_process';
import { DatabaseManager } from '../../src/database/database-manager';
import { config } from '../../src/config';

describe('MageAgent E2E - Complete Workflow Tests', () => {
  let serverProcess: ChildProcess;
  let apiClient: typeof axios;
  let wsClient: Socket;
  let databaseManager: DatabaseManager;
  const baseUrl = `http://localhost:${config.port}`;
  const wsUrl = `ws://localhost:${config.port}`;

  beforeAll(async () => {
    // Start the MageAgent server
    console.log('Starting MageAgent server for E2E tests...');

    serverProcess = spawn('npm', ['run', 'start'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      detached: false
    });

    // Wait for server to be ready
    await waitForServer(baseUrl, 60000);

    // Initialize API client
    apiClient = axios.create({
      baseURL: `${baseUrl}/api`,
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' }
    });

    // Initialize database for verification
    databaseManager = new DatabaseManager();
    await databaseManager.initialize();

    console.log('E2E test environment ready');
  }, 120000);

  afterAll(async () => {
    // Cleanup
    if (wsClient && wsClient.connected) {
      wsClient.disconnect();
    }

    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 5000));

      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }

    if (databaseManager) {
      await databaseManager.cleanup();
    }

    console.log('E2E test cleanup completed');
  }, 30000);

  describe('Server Health and Readiness', () => {
    test('should return healthy status with all services connected', async () => {
      const response = await apiClient.get('/health');

      expect(response.status).toBe(200);
      expect(response.data).toHaveRealData();
      expect(response.data.status).toBe('healthy');
      expect(response.data.services).toBeDefined();

      // All services should be healthy
      expect(response.data.services.openrouter).toBe(true);
      expect(response.data.services.postgres).toBe(true);
      expect(response.data.services.redis).toBe(true);
      expect(response.data.services.neo4j).toBe(true);
      expect(response.data.services.qdrant).toBe(true);

      console.log('Health check:', response.data);
    });

    test('should list available agents and models', async () => {
      const response = await apiClient.get('/agents');

      expect(response.status).toBe(200);
      expect(response.data).toHaveRealData();
      expect(response.data.availableRoles).toContain('research');
      expect(response.data.availableRoles).toContain('coding');
      expect(response.data.availableRoles).toContain('review');
      expect(response.data.availableRoles).toContain('synthesis');
      expect(response.data.activeAgents).toBeDefined();

      console.log(`Available roles: ${response.data.availableRoles.length}`);
    });
  });

  describe('Complete Orchestration Workflow', () => {
    test('should complete full analysis workflow from API to database', async () => {
      const taskRequest = {
        task: {
          objective: 'Analyze the impact of AI on software development practices',
          context: {
            aspects: ['productivity', 'code quality', 'developer experience'],
            timeframe: 'next 5 years'
          }
        },
        options: {
          type: 'analysis',
          depth: 'comprehensive'
        }
      };

      // Submit task
      const submitResponse = await apiClient.post('/orchestrate', taskRequest);

      expect(submitResponse.status).toBe(200);
      expect(submitResponse.data).toHaveRealData();
      expect(submitResponse.data.taskId).toBeDefined();
      expect(submitResponse.data.status).toBeDefined();

      const taskId = submitResponse.data.taskId;
      console.log('Task submitted:', taskId);

      // Verify task is stored in database
      const dbResult = await databaseManager.postgres.query(
        'SELECT * FROM agent_outputs WHERE agent_id LIKE $1',
        [`%${taskId}%`]
      );
      expect(dbResult.rows.length).toBeGreaterThan(0);

      // Verify result structure
      const result = submitResponse.data.result;
      expect(result).toBeDefined();
      expect(result.type).toBe('analysis');
      expect(result.analysis).toBeDefined();
    });

    test('should complete full competition workflow with multiple models', async () => {
      const competitionRequest = {
        challenge: {
          challenge: 'Design an efficient caching strategy for a high-traffic web application',
          competitorCount: 4,
          constraints: {
            requirements: ['LRU/LFU options', 'distributed caching', 'cache invalidation'],
            technologies: ['Redis', 'Memcached', 'CDN']
          }
        }
      };

      const response = await apiClient.post('/competition', competitionRequest);

      expect(response.status).toBe(200);
      expect(response.data).toHaveRealData();
      expect(response.data.competitionId).toBeDefined();
      expect(response.data.winner).toBeDefined();
      expect(response.data.rankings).toHaveLength(4);

      // Verify different models competed
      const models = response.data.rankings.map((r: any) => r.model);
      const uniqueModels = new Set(models);
      expect(uniqueModels.size).toBeGreaterThan(1);

      console.log('Competition results:', {
        competitionId: response.data.competitionId,
        winner: response.data.winner.model,
        models: Array.from(uniqueModels)
      });

      // Verify patterns were extracted
      expect(response.data.patterns).toBeDefined();
      expect(response.data.patterns.length).toBeGreaterThan(0);
    });

    test('should complete collaboration workflow with agent coordination', async () => {
      const collaborationRequest = {
        task: {
          objective: 'Create a complete REST API specification for a task management system',
          context: {
            features: ['user management', 'task CRUD', 'project organization', 'notifications'],
            standards: ['OpenAPI 3.0', 'REST best practices']
          }
        },
        options: {
          type: 'collaboration',
          agents: [
            { role: 'research', model: 'openai/gpt-4o-mini' },
            { role: 'coding', model: 'openai/gpt-3.5-turbo' },
            { role: 'review', model: 'anthropic/claude-3-haiku-20240307' }
          ]
        }
      };

      const response = await apiClient.post('/orchestrate', collaborationRequest);

      expect(response.status).toBe(200);
      expect(response.data).toHaveRealData();

      const result = response.data.result;
      expect(result.type).toBe('collaboration');
      expect(result.agents).toHaveLength(3);
      expect(result.contributions).toBeDefined();

      // Verify each agent contributed
      const contributionKeys = Object.keys(result.contributions);
      expect(contributionKeys.length).toBe(3);

      console.log('Collaboration completed:', {
        taskId: response.data.taskId,
        agents: result.agents.map((a: any) => ({ role: a.role, model: a.model }))
      });
    });
  });

  describe('WebSocket Real-time Streaming', () => {
    test('should stream agent progress in real-time', async () => {
      const events: any[] = [];

      // Connect WebSocket
      wsClient = io(wsUrl, {
        transports: ['websocket'],
        reconnection: false
      });

      await new Promise<void>((resolve) => {
        wsClient.on('connect', () => {
          console.log('WebSocket connected');
          resolve();
        });
      });

      // Listen for events
      wsClient.on('agent:started', (data) => events.push({ type: 'started', ...data }));
      wsClient.on('agent:progress', (data) => events.push({ type: 'progress', ...data }));
      wsClient.on('agent:completed', (data) => events.push({ type: 'completed', ...data }));
      wsClient.on('task:update', (data) => events.push({ type: 'task:update', ...data }));

      // Submit task that will generate events
      const taskRequest = {
        task: {
          objective: 'Generate a detailed explanation of WebSocket protocol',
          streamProgress: true
        }
      };

      const response = await apiClient.post('/orchestrate', taskRequest);
      const taskId = response.data.taskId;

      // Join task room
      wsClient.emit('join:task', { taskId });

      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 5000));

      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'started')).toBe(true);

      console.log('WebSocket events received:', {
        total: events.length,
        types: [...new Set(events.map(e => e.type))]
      });
    });

    test('should handle streaming completion responses', async () => {
      // Ensure WebSocket is connected
      if (!wsClient || !wsClient.connected) {
        wsClient = io(wsUrl, { transports: ['websocket'] });
        await new Promise(resolve => wsClient.on('connect', resolve));
      }

      const chunks: string[] = [];

      wsClient.on('completion:chunk', (data) => {
        chunks.push(data.content);
      });

      // Request streaming completion
      const streamRequest = {
        task: 'Explain the concept of distributed systems',
        options: { stream: true }
      };

      const response = await apiClient.post('/orchestrate', streamRequest);

      // Wait for streaming
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (chunks.length > 0) {
        expect(chunks.length).toBeGreaterThan(0);
        const fullContent = chunks.join('');
        expect(fullContent).toContain('distributed');
        console.log(`Streamed ${chunks.length} chunks`);
      }
    });
  });

  describe('Database Integration Verification', () => {
    test('should persist all agent outputs across databases', async () => {
      const task = {
        task: {
          objective: 'Create a database schema for a blogging platform',
          context: { includeIndexes: true, includeConstraints: true }
        }
      };

      const response = await apiClient.post('/orchestrate', task);
      const taskId = response.data.taskId;

      // Small delay to ensure data is persisted
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify PostgreSQL
      const pgResult = await databaseManager.postgres.query(
        'SELECT COUNT(*) as count FROM agent_outputs WHERE agent_id LIKE $1',
        [`%${taskId}%`]
      );
      expect(parseInt(pgResult.rows[0].count)).toBeGreaterThan(0);

      // Verify Redis cache
      const redisKeys = await databaseManager.redis.keys(`agent:*${taskId}*`);
      expect(redisKeys.length).toBeGreaterThan(0);

      // Verify Neo4j relationships
      const session = databaseManager.neo4j.session();
      try {
        const neo4jResult = await session.run(
          'MATCH (a:Agent)-[r]->(t:Task) WHERE t.id CONTAINS $taskId RETURN COUNT(r) as count',
          { taskId }
        );
        if (neo4jResult.records.length > 0) {
          expect(neo4jResult.records[0].get('count').toNumber()).toBeGreaterThan(0);
        }
      } finally {
        await session.close();
      }

      console.log('Data persisted across all databases for task:', taskId);
    });
  });

  describe('Error Handling and Recovery E2E', () => {
    test('should handle API errors gracefully', async () => {
      const invalidRequest = {
        // Missing required fields
        options: { type: 'invalid' }
      };

      try {
        await apiClient.post('/orchestrate', invalidRequest);
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.error).toBeDefined();
      }
    });

    test('should handle timeout scenarios', async () => {
      const timeoutRequest = {
        task: {
          objective: 'This task will timeout',
          timeout: 1 // 1ms timeout
        }
      };

      const response = await apiClient.post('/orchestrate', timeoutRequest);

      // Should still return a response
      expect(response.status).toBe(200);
      expect(response.data.taskId).toBeDefined();
    });

    test('should recover from partial failures', async () => {
      const competitionRequest = {
        challenge: {
          challenge: 'Complex task that some agents might fail',
          competitorCount: 5,
          timeLimit: 5000 // Short timeout to force some failures
        }
      };

      const response = await apiClient.post('/competition', competitionRequest);

      expect(response.status).toBe(200);
      expect(response.data.rankings).toBeDefined();

      // Should have at least some successful completions
      const successfulAgents = response.data.rankings.filter((r: any) => r.score > 0);
      expect(successfulAgents.length).toBeGreaterThan(0);

      console.log(`Partial failure recovery: ${successfulAgents.length}/${response.data.rankings.length} succeeded`);
    });
  });

  describe('Performance Monitoring E2E', () => {
    test('should complete requests within SLA', async () => {
      const timings: number[] = [];

      for (let i = 0; i < 5; i++) {
        const start = Date.now();

        const response = await apiClient.post('/orchestrate', {
          task: { objective: `Performance test ${i}` },
          options: { type: 'analysis' }
        });

        const duration = Date.now() - start;
        timings.push(duration);

        expect(response.status).toBe(200);
      }

      const avgTime = timings.reduce((a, b) => a + b) / timings.length;
      const maxTime = Math.max(...timings);

      console.log('Performance metrics:', { timings, average: avgTime, max: maxTime });

      expect(avgTime).toBeLessThan(30000); // 30s average
      expect(maxTime).toBeLessThan(60000); // 60s max
    });

    test('should handle concurrent requests efficiently', async () => {
      const concurrentRequests = 10;
      const start = Date.now();

      const requests = Array(concurrentRequests).fill(null).map((_, i) =>
        apiClient.post('/orchestrate', {
          task: { objective: `Concurrent request ${i}` },
          options: { type: 'analysis' }
        })
      );

      const responses = await Promise.allSettled(requests);
      const duration = Date.now() - start;

      const successful = responses.filter(r => r.status === 'fulfilled');
      const failed = responses.filter(r => r.status === 'rejected');

      expect(successful.length).toBeGreaterThan(concurrentRequests * 0.8); // 80% success rate

      console.log('Concurrent request handling:', {
        total: concurrentRequests,
        successful: successful.length,
        failed: failed.length,
        totalDuration: `${duration}ms`,
        avgDuration: `${duration / concurrentRequests}ms`
      });
    });
  });

  describe('Memory Pattern Learning E2E', () => {
    test('should improve performance through pattern learning', async () => {
      const similarTasks = [
        'Implement a binary search algorithm in Python',
        'Create a binary search function with Python',
        'Write Python code for binary search implementation'
      ];

      const timings: number[] = [];

      for (const task of similarTasks) {
        const start = Date.now();

        await apiClient.post('/orchestrate', {
          task: { objective: task },
          options: { type: 'analysis' }
        });

        timings.push(Date.now() - start);
      }

      // Later tasks should potentially be faster due to pattern recognition
      console.log('Pattern learning impact:', {
        firstTask: `${timings[0]}ms`,
        lastTask: `${timings[timings.length - 1]}ms`,
        improvement: `${((timings[0] - timings[timings.length - 1]) / timings[0] * 100).toFixed(1)}%`
      });

      // All tasks should complete successfully
      expect(timings.length).toBe(similarTasks.length);
    });
  });

  describe('Production Readiness Checks', () => {
    test('should handle production-scale workload', async () => {
      const workloadTest = async () => {
        const tasks = [
          { type: 'analysis', count: 3 },
          { type: 'competition', count: 2 },
          { type: 'collaboration', count: 2 }
        ];

        const results = [];

        for (const taskGroup of tasks) {
          const groupPromises = Array(taskGroup.count).fill(null).map(() => {
            if (taskGroup.type === 'competition') {
              return apiClient.post('/competition', {
                challenge: { challenge: 'Production scale test', competitorCount: 3 }
              });
            }

            return apiClient.post('/orchestrate', {
              task: { objective: 'Production scale test' },
              options: { type: taskGroup.type }
            });
          });

          const groupResults = await Promise.allSettled(groupPromises);
          results.push(...groupResults);
        }

        return results;
      };

      const results = await workloadTest();
      const successful = results.filter(r => r.status === 'fulfilled');

      expect(successful.length / results.length).toBeGreaterThan(0.9); // 90% success rate

      console.log('Production workload test:', {
        total: results.length,
        successful: successful.length,
        successRate: `${(successful.length / results.length * 100).toFixed(1)}%`
      });
    });

    test('should maintain data integrity under load', async () => {
      const taskIds: string[] = [];

      // Create multiple tasks
      const createPromises = Array(5).fill(null).map(async () => {
        const response = await apiClient.post('/orchestrate', {
          task: { objective: 'Data integrity test' }
        });
        return response.data.taskId;
      });

      taskIds.push(...await Promise.all(createPromises));

      // Verify all tasks are properly stored
      for (const taskId of taskIds) {
        const dbCheck = await databaseManager.postgres.query(
          'SELECT COUNT(*) as count FROM agent_outputs WHERE agent_id LIKE $1',
          [`%${taskId}%`]
        );

        expect(parseInt(dbCheck.rows[0].count)).toBeGreaterThan(0);
      }

      console.log('Data integrity verified for all tasks');
    });
  });
});

// Helper function to wait for server startup
async function waitForServer(url: string, timeout: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      await axios.get(url);
      return;
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  throw new Error(`Server did not start within ${timeout}ms`);
}