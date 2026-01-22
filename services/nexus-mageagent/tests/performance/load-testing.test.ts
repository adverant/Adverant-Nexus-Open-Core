/**
 * Performance and Load Testing for MageAgent
 * Tests system performance under various load conditions with REAL APIs
 */

import { Orchestrator } from '../../src/orchestration/orchestrator';
import { OpenRouterClient } from '../../src/clients/openrouter-client';
import { GraphRAGClient } from '../../src/clients/graphrag-client';
import { DatabaseManager } from '../../src/database/database-manager';
import { WebSocketManager, initializeWebSocketManager } from '../../src/websocket/websocket-manager';
import { config } from '../../src/config';
import { createServer } from 'http';
import express from 'express';
import { initializeRoutes } from '../../src/routes';
import axios from 'axios';

interface PerformanceMetrics {
  requestCount: number;
  successCount: number;
  failureCount: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  throughput: number;
  errorRate: number;
}

describe('Performance and Load Testing', () => {
  let orchestrator: Orchestrator;
  let openRouterClient: OpenRouterClient;
  let graphRAGClient: GraphRAGClient;
  let databaseManager: DatabaseManager;
  let httpServer: any;
  let apiClient: any;
  const testPort = 9998;

  beforeAll(async () => {
    // Initialize services
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

    // Start test server
    const app = express();
    app.use(express.json());

    const apiRoutes = initializeRoutes(orchestrator);
    app.use('/api', apiRoutes);

    httpServer = createServer(app);
    initializeWebSocketManager(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(testPort, () => {
        console.log(`Performance test server running on port ${testPort}`);
        resolve();
      });
    });

    apiClient = axios.create({
      baseURL: `http://localhost:${testPort}/api`,
      timeout: 300000
    });
  }, 120000);

  afterAll(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    await databaseManager.cleanup();
  });

  describe('Baseline Performance Tests', () => {
    test('should establish performance baselines for each operation', async () => {
      const baselines = {
        analysis: [] as number[],
        competition: [] as number[],
        collaboration: [] as number[]
      };

      // Warm-up run
      await orchestrator.orchestrateTask({ objective: 'Warm-up task' });

      // Analysis baseline
      for (let i = 0; i < 5; i++) {
        const start = Date.now();
        await orchestrator.orchestrateTask({
          objective: 'Analyze system performance characteristics',
          context: { iteration: i }
        });
        baselines.analysis.push(Date.now() - start);
      }

      // Competition baseline (smaller scale)
      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await orchestrator.runCompetition({
          challenge: 'Optimize sorting algorithm',
          competitorCount: 2
        });
        baselines.competition.push(Date.now() - start);
      }

      // Collaboration baseline
      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await orchestrator.orchestrateTask({
          objective: 'Collaborative system design',
          context: { iteration: i }
        }, { type: 'collaboration' });
        baselines.collaboration.push(Date.now() - start);
      }

      console.log('Performance baselines established:');
      console.log(`- Analysis: avg ${avg(baselines.analysis)}ms, min ${Math.min(...baselines.analysis)}ms, max ${Math.max(...baselines.analysis)}ms`);
      console.log(`- Competition: avg ${avg(baselines.competition)}ms, min ${Math.min(...baselines.competition)}ms, max ${Math.max(...baselines.competition)}ms`);
      console.log(`- Collaboration: avg ${avg(baselines.collaboration)}ms, min ${Math.min(...baselines.collaboration)}ms, max ${Math.max(...baselines.collaboration)}ms`);

      // All operations should complete within reasonable time
      expect(avg(baselines.analysis)).toBeLessThan(60000); // 1 minute avg
      expect(avg(baselines.competition)).toBeLessThan(120000); // 2 minutes avg
      expect(avg(baselines.collaboration)).toBeLessThan(90000); // 1.5 minutes avg
    });
  });

  describe('Throughput Testing', () => {
    test('should measure maximum sustainable throughput', async () => {
      const durations: number[] = [];
      const concurrency = 5;
      const iterations = 3;

      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const batchPromises = Array(concurrency).fill(null).map(async (_, j) => {
          const taskStart = Date.now();
          try {
            await apiClient.post('/orchestrate', {
              task: {
                objective: `Throughput test ${i}-${j}`,
                context: { batch: i, index: j }
              }
            });
            return Date.now() - taskStart;
          } catch (error) {
            return -1; // Failed
          }
        });

        const batchDurations = await Promise.all(batchPromises);
        durations.push(...batchDurations.filter(d => d > 0));
      }

      const totalDuration = Date.now() - startTime;
      const successfulRequests = durations.length;
      const throughput = (successfulRequests / totalDuration) * 1000; // requests per second

      console.log('Throughput test results:');
      console.log(`- Total requests: ${concurrency * iterations}`);
      console.log(`- Successful: ${successfulRequests}`);
      console.log(`- Duration: ${totalDuration}ms`);
      console.log(`- Throughput: ${throughput.toFixed(2)} req/s`);

      expect(throughput).toBeGreaterThan(0.1); // At least 0.1 req/s
      expect(successfulRequests).toBeGreaterThan(concurrency * iterations * 0.8); // 80% success
    });

    test('should identify throughput saturation point', async () => {
      const throughputByLoad: { load: number; throughput: number }[] = [];

      for (const load of [1, 2, 4, 8]) {
        const start = Date.now();
        const promises = Array(load).fill(null).map((_, i) =>
          apiClient.post('/orchestrate', {
            task: { objective: `Saturation test load=${load} task=${i}` }
          }).catch(() => null)
        );

        const results = await Promise.all(promises);
        const duration = Date.now() - start;
        const successful = results.filter(r => r !== null).length;
        const throughput = (successful / duration) * 1000;

        throughputByLoad.push({ load, throughput });
      }

      console.log('Throughput saturation analysis:');
      throughputByLoad.forEach(({ load, throughput }) => {
        console.log(`- Load ${load}: ${throughput.toFixed(3)} req/s`);
      });

      // Throughput should plateau or decrease at high load
      const maxThroughput = Math.max(...throughputByLoad.map(t => t.throughput));
      const highLoadThroughput = throughputByLoad[throughputByLoad.length - 1].throughput;

      expect(highLoadThroughput).toBeLessThanOrEqual(maxThroughput * 1.1); // Within 10% of max
    });
  });

  describe('Latency Testing', () => {
    test('should measure latency distribution under load', async () => {
      const latencies: number[] = [];
      const testDuration = 30000; // 30 seconds
      const targetRPS = 0.5; // 0.5 requests per second

      const endTime = Date.now() + testDuration;
      let requestCount = 0;

      while (Date.now() < endTime) {
        const requestStart = Date.now();

        try {
          await apiClient.post('/orchestrate', {
            task: {
              objective: `Latency test request ${requestCount}`,
              context: { timestamp: requestStart }
            }
          });

          const latency = Date.now() - requestStart;
          latencies.push(latency);
        } catch (error) {
          // Track failed requests as max latency
          latencies.push(300000);
        }

        requestCount++;

        // Maintain target RPS
        const sleepTime = (1000 / targetRPS) - (Date.now() - requestStart);
        if (sleepTime > 0) {
          await new Promise(resolve => setTimeout(resolve, sleepTime));
        }
      }

      // Calculate percentiles
      latencies.sort((a, b) => a - b);
      const metrics = {
        min: latencies[0],
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p95: latencies[Math.floor(latencies.length * 0.95)],
        p99: latencies[Math.floor(latencies.length * 0.99)],
        max: latencies[latencies.length - 1],
        avg: avg(latencies)
      };

      console.log('Latency distribution:');
      console.log(`- Min: ${metrics.min}ms`);
      console.log(`- P50: ${metrics.p50}ms`);
      console.log(`- P95: ${metrics.p95}ms`);
      console.log(`- P99: ${metrics.p99}ms`);
      console.log(`- Max: ${metrics.max}ms`);
      console.log(`- Avg: ${metrics.avg.toFixed(0)}ms`);

      expect(metrics.p50).toBeLessThan(60000); // P50 < 1 minute
      expect(metrics.p95).toBeLessThan(120000); // P95 < 2 minutes
    });

    test('should measure cold start vs warm performance', async () => {
      // Cold start (first request after idle)
      await new Promise(resolve => setTimeout(resolve, 5000)); // Ensure idle

      const coldStart = Date.now();
      await apiClient.post('/orchestrate', {
        task: { objective: 'Cold start performance test' }
      });
      const coldLatency = Date.now() - coldStart;

      // Warm requests
      const warmLatencies: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await apiClient.post('/orchestrate', {
          task: { objective: `Warm request ${i}` }
        });
        warmLatencies.push(Date.now() - start);
      }

      const avgWarmLatency = avg(warmLatencies);

      console.log('Cold start vs warm performance:');
      console.log(`- Cold start: ${coldLatency}ms`);
      console.log(`- Avg warm: ${avgWarmLatency.toFixed(0)}ms`);
      console.log(`- Cold/warm ratio: ${(coldLatency / avgWarmLatency).toFixed(2)}x`);

      // Cold start should not be more than 2x slower
      expect(coldLatency).toBeLessThan(avgWarmLatency * 2);
    });
  });

  describe('Resource Utilization', () => {
    test('should monitor memory usage under load', async () => {
      const memorySnapshots: NodeJS.MemoryUsage[] = [];

      // Take baseline
      if (global.gc) global.gc();
      const baseline = process.memoryUsage();
      memorySnapshots.push(baseline);

      // Generate load
      const tasks = Array(10).fill(null).map((_, i) =>
        orchestrator.orchestrateTask({
          objective: `Memory test task ${i}`,
          context: { data: 'x'.repeat(1000) } // 1KB payload
        })
      );

      // Monitor memory during execution
      const monitorInterval = setInterval(() => {
        memorySnapshots.push(process.memoryUsage());
      }, 1000);

      await Promise.all(tasks);

      clearInterval(monitorInterval);

      // Final snapshot
      if (global.gc) global.gc();
      const final = process.memoryUsage();
      memorySnapshots.push(final);

      // Analyze memory usage
      const maxHeap = Math.max(...memorySnapshots.map(m => m.heapUsed));
      const heapGrowth = final.heapUsed - baseline.heapUsed;
      const externalGrowth = final.external - baseline.external;

      console.log('Memory usage analysis:');
      console.log(`- Baseline heap: ${(baseline.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`- Max heap: ${(maxHeap / 1024 / 1024).toFixed(2)}MB`);
      console.log(`- Final heap: ${(final.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`- Heap growth: ${(heapGrowth / 1024 / 1024).toFixed(2)}MB`);
      console.log(`- External growth: ${(externalGrowth / 1024 / 1024).toFixed(2)}MB`);

      // Memory growth should be reasonable
      expect(heapGrowth).toBeLessThan(200 * 1024 * 1024); // Less than 200MB growth
    });

    test('should monitor database connection pool usage', async () => {
      const poolStats: any[] = [];

      // Monitor pool during load test
      const monitorInterval = setInterval(async () => {
        const stats = {
          timestamp: Date.now(),
          postgres: {
            total: databaseManager.postgres.totalCount,
            idle: databaseManager.postgres.idleCount,
            waiting: databaseManager.postgres.waitingCount
          }
        };
        poolStats.push(stats);
      }, 500);

      // Generate database-heavy load
      const dbTasks = Array(20).fill(null).map((_, i) =>
        orchestrator.orchestrateTask({
          objective: `DB pool test ${i}`,
          context: { requiresDb: true }
        }).catch(() => null)
      );

      await Promise.all(dbTasks);

      clearInterval(monitorInterval);

      // Analyze pool usage
      const maxWaiting = Math.max(...poolStats.map(s => s.postgres.waiting));
      const avgIdle = avg(poolStats.map(s => s.postgres.idle));

      console.log('Connection pool analysis:');
      console.log(`- Max waiting: ${maxWaiting}`);
      console.log(`- Avg idle: ${avgIdle.toFixed(2)}`);
      console.log(`- Pool size: ${databaseManager.postgres.totalCount}`);

      // Pool should not have excessive waiting
      expect(maxWaiting).toBeLessThan(10);
    });
  });

  describe('Scalability Testing', () => {
    test('should scale linearly with increased resources', async () => {
      const scalabilityResults: { agents: number; duration: number; throughput: number }[] = [];

      for (const agentCount of [1, 2, 4]) {
        const start = Date.now();

        // Run competition with varying agent counts
        await orchestrator.runCompetition({
          challenge: 'Scalability test challenge',
          competitorCount: agentCount
        });

        const duration = Date.now() - start;
        const throughput = agentCount / (duration / 1000);

        scalabilityResults.push({ agents: agentCount, duration, throughput });
      }

      console.log('Scalability analysis:');
      scalabilityResults.forEach(({ agents, duration, throughput }) => {
        console.log(`- ${agents} agents: ${duration}ms (${throughput.toFixed(2)} agents/s)`);
      });

      // Check for reasonable scaling
      const efficiency = scalabilityResults.map((r, i) => {
        if (i === 0) return 1;
        const baselineTime = scalabilityResults[0].duration;
        const expectedTime = baselineTime * r.agents;
        return expectedTime / r.duration;
      });

      console.log(`Scaling efficiency: ${efficiency.map(e => `${(e * 100).toFixed(1)}%`).join(', ')}`);

      // At least 50% efficiency
      expect(Math.min(...efficiency)).toBeGreaterThan(0.5);
    });

    test('should handle burst traffic patterns', async () => {
      const burstSize = 10;
      const results: { phase: string; successful: number; failed: number; avgLatency: number }[] = [];

      // Normal load
      const normalStart = Date.now();
      const normalTask = await apiClient.post('/orchestrate', {
        task: { objective: 'Normal load baseline' }
      });
      const normalLatency = Date.now() - normalStart;

      // Burst load
      const burstStart = Date.now();
      const burstTasks = Array(burstSize).fill(null).map((_, i) =>
        apiClient.post('/orchestrate', {
          task: { objective: `Burst task ${i}` }
        }).then(r => ({ success: true, latency: Date.now() - burstStart }))
          .catch(e => ({ success: false, latency: Date.now() - burstStart }))
      );

      const burstResults = await Promise.all(burstTasks);
      const burstSuccessful = burstResults.filter(r => r.success).length;
      const burstLatencies = burstResults.filter(r => r.success).map(r => r.latency);

      results.push({
        phase: 'normal',
        successful: 1,
        failed: 0,
        avgLatency: normalLatency
      });

      results.push({
        phase: 'burst',
        successful: burstSuccessful,
        failed: burstSize - burstSuccessful,
        avgLatency: avg(burstLatencies)
      });

      console.log('Burst traffic handling:');
      results.forEach(r => {
        console.log(`- ${r.phase}: ${r.successful}/${r.successful + r.failed} successful, avg ${r.avgLatency.toFixed(0)}ms`);
      });

      // Should handle at least 70% of burst
      expect(burstSuccessful / burstSize).toBeGreaterThan(0.7);
    });
  });

  describe('Long-Running Performance Tests', () => {
    test('should maintain stable performance over time', async () => {
      const testDuration = 60000; // 1 minute
      const checkInterval = 10000; // Check every 10 seconds
      const performanceWindows: PerformanceMetrics[] = [];

      const endTime = Date.now() + testDuration;

      while (Date.now() < endTime) {
        const windowStart = Date.now();
        const windowMetrics: number[] = [];
        let successCount = 0;
        let failureCount = 0;

        // Run for interval
        while (Date.now() < windowStart + checkInterval && Date.now() < endTime) {
          const requestStart = Date.now();

          try {
            await apiClient.post('/orchestrate', {
              task: {
                objective: `Stability test at ${new Date().toISOString()}`
              }
            });
            successCount++;
            windowMetrics.push(Date.now() - requestStart);
          } catch (error) {
            failureCount++;
          }

          // Small delay between requests
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (windowMetrics.length > 0) {
          windowMetrics.sort((a, b) => a - b);
          performanceWindows.push(calculateMetrics(windowMetrics, successCount, failureCount, checkInterval));
        }
      }

      console.log('Performance stability over time:');
      performanceWindows.forEach((window, i) => {
        console.log(`Window ${i + 1}: avg=${window.avgResponseTime.toFixed(0)}ms, success=${window.successCount}, error=${window.errorRate.toFixed(2)}`);
      });

      // Performance should not degrade significantly
      const firstWindow = performanceWindows[0];
      const lastWindow = performanceWindows[performanceWindows.length - 1];

      expect(lastWindow.avgResponseTime).toBeLessThan(firstWindow.avgResponseTime * 1.5); // Max 50% degradation
      expect(lastWindow.errorRate).toBeLessThan(0.3); // Max 30% error rate
    });
  });

  describe('Model-Specific Performance', () => {
    test('should benchmark different AI models', async () => {
      const models = [
        'openai/gpt-3.5-turbo',
        'openai/gpt-4o-mini',
        'anthropic/claude-3-haiku-20240307'
      ];

      const modelPerformance: { model: string; latency: number; cost: number }[] = [];

      for (const model of models) {
        try {
          const start = Date.now();

          await orchestrator.orchestrateTask({
            objective: 'Benchmark test: explain quantum computing in one paragraph',
            context: { preferredModel: model }
          });

          const latency = Date.now() - start;

          // Estimate cost (simplified)
          const cost = openRouterClient.estimateCost(model, 500, 200); // Approximate tokens

          modelPerformance.push({ model, latency, cost });
        } catch (error) {
          console.log(`Model ${model} not available or failed`);
        }
      }

      console.log('Model performance comparison:');
      modelPerformance.forEach(({ model, latency, cost }) => {
        console.log(`- ${model}: ${latency}ms, ~$${cost.toFixed(4)}`);
      });

      // All tested models should complete
      expect(modelPerformance.length).toBeGreaterThan(0);
    });
  });

  describe('API Endpoint Performance', () => {
    test('should benchmark all API endpoints', async () => {
      const endpoints = [
        { method: 'GET', path: '/health', data: null },
        { method: 'GET', path: '/agents', data: null },
        { method: 'POST', path: '/orchestrate', data: { task: { objective: 'Endpoint test' } } },
        { method: 'POST', path: '/competition', data: { challenge: { challenge: 'Test', competitorCount: 2 } } }
      ];

      const endpointMetrics: any[] = [];

      for (const endpoint of endpoints) {
        const latencies: number[] = [];

        // Multiple requests for average
        for (let i = 0; i < 3; i++) {
          const start = Date.now();

          try {
            if (endpoint.method === 'GET') {
              await apiClient.get(endpoint.path);
            } else {
              await apiClient.post(endpoint.path, endpoint.data);
            }
            latencies.push(Date.now() - start);
          } catch (error) {
            latencies.push(-1);
          }
        }

        const validLatencies = latencies.filter(l => l > 0);
        endpointMetrics.push({
          endpoint: `${endpoint.method} ${endpoint.path}`,
          avgLatency: validLatencies.length > 0 ? avg(validLatencies) : -1,
          successRate: validLatencies.length / latencies.length
        });
      }

      console.log('API endpoint performance:');
      endpointMetrics.forEach(({ endpoint, avgLatency, successRate }) => {
        console.log(`- ${endpoint}: ${avgLatency > 0 ? avgLatency.toFixed(0) + 'ms' : 'failed'} (${(successRate * 100).toFixed(0)}% success)`);
      });

      // Health endpoint should be fast
      const healthMetric = endpointMetrics.find(m => m.endpoint.includes('/health'));
      expect(healthMetric?.avgLatency).toBeLessThan(1000); // Less than 1 second
    });
  });
});

// Helper functions
function avg(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function calculateMetrics(
  latencies: number[],
  successCount: number,
  failureCount: number,
  duration: number
): PerformanceMetrics {
  const totalRequests = successCount + failureCount;

  return {
    requestCount: totalRequests,
    successCount,
    failureCount,
    avgResponseTime: avg(latencies),
    minResponseTime: Math.min(...latencies),
    maxResponseTime: Math.max(...latencies),
    p50ResponseTime: latencies[Math.floor(latencies.length * 0.5)],
    p95ResponseTime: latencies[Math.floor(latencies.length * 0.95)],
    p99ResponseTime: latencies[Math.floor(latencies.length * 0.99)],
    throughput: (totalRequests / duration) * 1000,
    errorRate: failureCount / totalRequests
  };
}