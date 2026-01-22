/**
 * Performance and Load Tests for MageAgent Platform
 * Tests system behavior under various load conditions with real APIs
 */

import axios, { AxiosInstance } from 'axios';
import { performance } from 'perf_hooks';
import { cpus } from 'os';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001/api';
const LOAD_TEST_DURATION = parseInt(process.env.LOAD_TEST_DURATION || '300000'); // 5 minutes default

interface PerformanceMetrics {
  responseTime: number;
  statusCode: number;
  error?: string;
  timestamp: number;
  memoryUsage: NodeJS.MemoryUsage;
}

interface LoadTestResults {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  percentiles: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
  };
  throughput: number;
  errorRate: number;
  errors: Record<string, number>;
}

describe('MageAgent Performance Tests', () => {
  let apiClient: AxiosInstance;
  const metrics: PerformanceMetrics[] = [];

  beforeAll(async () => {
    apiClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: 60000,
      validateStatus: () => true // Don't throw on any status
    });

    // Warm up the service
    console.log('Warming up service...');
    for (let i = 0; i < 5; i++) {
      await apiClient.get('/health').catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  afterEach(() => {
    // Clear metrics after each test
    metrics.length = 0;
  });

  async function executeRequest(
    method: 'get' | 'post',
    path: string,
    data?: any
  ): Promise<PerformanceMetrics> {
    const startTime = performance.now();
    const startMemory = process.memoryUsage();

    try {
      const response = await apiClient[method](path, data);
      const endTime = performance.now();

      return {
        responseTime: endTime - startTime,
        statusCode: response.status,
        timestamp: Date.now(),
        memoryUsage: process.memoryUsage()
      };
    } catch (error: any) {
      const endTime = performance.now();

      return {
        responseTime: endTime - startTime,
        statusCode: error.response?.status || 0,
        error: error.message,
        timestamp: Date.now(),
        memoryUsage: process.memoryUsage()
      };
    }
  }

  function calculateResults(metrics: PerformanceMetrics[]): LoadTestResults {
    const successfulRequests = metrics.filter(m => m.statusCode >= 200 && m.statusCode < 300);
    const failedRequests = metrics.filter(m => m.statusCode >= 400 || m.statusCode === 0);

    const responseTimes = metrics.map(m => m.responseTime).sort((a, b) => a - b);
    const errors = failedRequests.reduce((acc, m) => {
      const key = m.error || `HTTP ${m.statusCode}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const p = (percentile: number) => {
      const index = Math.floor(responseTimes.length * percentile);
      return responseTimes[index] || 0;
    };

    const testDuration = (metrics[metrics.length - 1].timestamp - metrics[0].timestamp) / 1000;

    return {
      totalRequests: metrics.length,
      successfulRequests: successfulRequests.length,
      failedRequests: failedRequests.length,
      averageResponseTime: responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
      minResponseTime: responseTimes[0] || 0,
      maxResponseTime: responseTimes[responseTimes.length - 1] || 0,
      percentiles: {
        p50: p(0.50),
        p75: p(0.75),
        p90: p(0.90),
        p95: p(0.95),
        p99: p(0.99)
      },
      throughput: metrics.length / testDuration,
      errorRate: failedRequests.length / metrics.length,
      errors
    };
  }

  describe('Baseline Performance Tests', () => {
    it('should handle single requests efficiently', async () => {
      const endpoints = [
        { method: 'get' as const, path: '/health' },
        { method: 'get' as const, path: '/agents' },
        { method: 'post' as const, path: '/memory/search', data: { query: 'test', limit: 5 } }
      ];

      for (const endpoint of endpoints) {
        const metric = await executeRequest(endpoint.method, endpoint.path, endpoint.data);

        console.log(`${endpoint.method.toUpperCase()} ${endpoint.path}: ${metric.responseTime.toFixed(2)}ms`);

        // Performance assertions
        expect(metric.statusCode).toBeGreaterThanOrEqual(200);
        expect(metric.statusCode).toBeLessThan(500);

        // Response time SLAs
        if (endpoint.path === '/health') {
          expect(metric.responseTime).toBeLessThan(100); // Health check should be fast
        } else {
          expect(metric.responseTime).toBeLessThan(5000); // Other endpoints within 5s
        }
      }
    });

    it('should maintain performance with complex orchestration tasks', async () => {
      const complexTask = {
        task: 'Analyze the technical architecture of a microservices system',
        options: {
          maxTokens: 1000,
          models: ['openai/gpt-4-turbo'],
          includeAnalysis: true
        }
      };

      const startMemory = process.memoryUsage();
      const metric = await executeRequest('post', '/orchestrate', complexTask);

      expect(metric.statusCode).toBe(200);
      expect(metric.responseTime).toBeLessThan(30000); // 30s for complex tasks

      // Memory leak check
      const memoryIncrease = metric.memoryUsage.heapUsed - startMemory.heapUsed;
      expect(memoryIncrease).toBeLessThan(100 * 1024 * 1024); // Less than 100MB increase

      console.log(`Complex orchestration completed in ${metric.responseTime.toFixed(2)}ms`);
    });
  });

  describe('Concurrent Load Tests', () => {
    it('should handle concurrent health check requests', async () => {
      const concurrentRequests = 100;
      const iterations = 10;

      console.log(`Testing ${concurrentRequests} concurrent health checks...`);

      for (let i = 0; i < iterations; i++) {
        const promises = Array(concurrentRequests).fill(null).map(() =>
          executeRequest('get', '/health')
        );

        const results = await Promise.all(promises);
        metrics.push(...results);

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const testResults = calculateResults(metrics);

      console.log('Concurrent Health Check Results:');
      console.log(`Total Requests: ${testResults.totalRequests}`);
      console.log(`Success Rate: ${((1 - testResults.errorRate) * 100).toFixed(2)}%`);
      console.log(`Average Response Time: ${testResults.averageResponseTime.toFixed(2)}ms`);
      console.log(`95th Percentile: ${testResults.percentiles.p95.toFixed(2)}ms`);
      console.log(`Throughput: ${testResults.throughput.toFixed(2)} req/s`);

      // Assertions
      expect(testResults.errorRate).toBeLessThan(0.05); // Less than 5% error rate
      expect(testResults.percentiles.p95).toBeLessThan(1000); // 95% within 1s
      expect(testResults.throughput).toBeGreaterThan(50); // At least 50 req/s
    });

    it('should handle concurrent orchestration requests', async () => {
      const concurrentRequests = 20;
      const tasks = [
        'Explain quantum computing in simple terms',
        'Write a haiku about software testing',
        'List 5 benefits of microservices',
        'Compare REST and GraphQL',
        'Describe the CAP theorem'
      ];

      console.log(`Testing ${concurrentRequests} concurrent orchestration requests...`);

      const promises = Array(concurrentRequests).fill(null).map((_, index) =>
        executeRequest('post', '/orchestrate', {
          task: tasks[index % tasks.length],
          options: { maxTokens: 200 }
        })
      );

      const results = await Promise.all(promises);
      metrics.push(...results);

      const testResults = calculateResults(metrics);

      console.log('Concurrent Orchestration Results:');
      console.log(`Success Rate: ${((1 - testResults.errorRate) * 100).toFixed(2)}%`);
      console.log(`Average Response Time: ${testResults.averageResponseTime.toFixed(2)}ms`);

      // More lenient for complex operations
      expect(testResults.errorRate).toBeLessThan(0.20); // Less than 20% error rate
      expect(testResults.averageResponseTime).toBeLessThan(60000); // Average under 1 minute
    }, 300000);
  });

  describe('Sustained Load Tests', () => {
    it('should maintain performance under sustained load', async () => {
      const duration = 60000; // 1 minute
      const requestsPerSecond = 10;
      const startTime = Date.now();

      console.log(`Running sustained load test for ${duration/1000}s at ${requestsPerSecond} req/s...`);

      const interval = setInterval(async () => {
        const promises = Array(requestsPerSecond).fill(null).map(() => {
          const random = Math.random();
          if (random < 0.7) {
            return executeRequest('get', '/health');
          } else if (random < 0.9) {
            return executeRequest('get', '/agents');
          } else {
            return executeRequest('post', '/memory/search', { query: 'test' });
          }
        });

        const results = await Promise.all(promises);
        metrics.push(...results);
      }, 1000);

      // Wait for test duration
      await new Promise(resolve => setTimeout(resolve, duration));
      clearInterval(interval);

      const testResults = calculateResults(metrics);

      console.log('Sustained Load Test Results:');
      console.log(`Total Requests: ${testResults.totalRequests}`);
      console.log(`Duration: ${duration/1000}s`);
      console.log(`Average Throughput: ${testResults.throughput.toFixed(2)} req/s`);
      console.log(`Error Rate: ${(testResults.errorRate * 100).toFixed(2)}%`);
      console.log(`Response Time Percentiles:`);
      console.log(`  P50: ${testResults.percentiles.p50.toFixed(2)}ms`);
      console.log(`  P75: ${testResults.percentiles.p75.toFixed(2)}ms`);
      console.log(`  P90: ${testResults.percentiles.p90.toFixed(2)}ms`);
      console.log(`  P95: ${testResults.percentiles.p95.toFixed(2)}ms`);
      console.log(`  P99: ${testResults.percentiles.p99.toFixed(2)}ms`);

      // Performance SLAs
      expect(testResults.errorRate).toBeLessThan(0.10); // Less than 10% errors
      expect(testResults.percentiles.p95).toBeLessThan(5000); // 95% within 5s
      expect(testResults.throughput).toBeGreaterThan(5); // At least 5 req/s sustained
    }, 120000);
  });

  describe('Spike Load Tests', () => {
    it('should handle traffic spikes gracefully', async () => {
      const normalLoad = 5;
      const spikeLoad = 50;
      const spikeDuration = 10000; // 10 seconds

      console.log('Testing traffic spike handling...');

      // Normal load
      console.log('Phase 1: Normal load');
      for (let i = 0; i < 5; i++) {
        const promises = Array(normalLoad).fill(null).map(() =>
          executeRequest('get', '/health')
        );
        const results = await Promise.all(promises);
        metrics.push(...results);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Spike
      console.log('Phase 2: Traffic spike');
      const spikeStart = Date.now();
      while (Date.now() - spikeStart < spikeDuration) {
        const promises = Array(spikeLoad).fill(null).map(() =>
          executeRequest('get', '/health')
        );
        const results = await Promise.all(promises);
        metrics.push(...results);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Return to normal
      console.log('Phase 3: Return to normal');
      for (let i = 0; i < 5; i++) {
        const promises = Array(normalLoad).fill(null).map(() =>
          executeRequest('get', '/health')
        );
        const results = await Promise.all(promises);
        metrics.push(...results);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Analyze spike impact
      const normalMetrics = metrics.slice(0, 5 * normalLoad);
      const spikeMetrics = metrics.slice(5 * normalLoad, -5 * normalLoad);
      const recoveryMetrics = metrics.slice(-5 * normalLoad);

      const normalAvg = normalMetrics.reduce((a, m) => a + m.responseTime, 0) / normalMetrics.length;
      const spikeAvg = spikeMetrics.reduce((a, m) => a + m.responseTime, 0) / spikeMetrics.length;
      const recoveryAvg = recoveryMetrics.reduce((a, m) => a + m.responseTime, 0) / recoveryMetrics.length;

      console.log(`Normal avg response time: ${normalAvg.toFixed(2)}ms`);
      console.log(`Spike avg response time: ${spikeAvg.toFixed(2)}ms`);
      console.log(`Recovery avg response time: ${recoveryAvg.toFixed(2)}ms`);

      // Assertions
      expect(spikeAvg).toBeLessThan(normalAvg * 10); // Spike shouldn't degrade by more than 10x
      expect(recoveryAvg).toBeLessThan(normalAvg * 2); // Should recover to near normal
    });
  });

  describe('Memory and Resource Tests', () => {
    it('should not leak memory under load', async () => {
      const iterations = 50;
      const memorySnapshots: NodeJS.MemoryUsage[] = [];

      console.log('Testing for memory leaks...');

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const initialMemory = process.memoryUsage();
      memorySnapshots.push(initialMemory);

      for (let i = 0; i < iterations; i++) {
        await executeRequest('post', '/orchestrate', {
          task: `Test task ${i}`,
          options: { maxTokens: 100 }
        });

        if (i % 10 === 0) {
          if (global.gc) global.gc();
          const memory = process.memoryUsage();
          memorySnapshots.push(memory);
          console.log(`Iteration ${i}: Heap used: ${(memory.heapUsed / 1024 / 1024).toFixed(2)}MB`);
        }
      }

      // Analyze memory growth
      const firstSnapshot = memorySnapshots[0];
      const lastSnapshot = memorySnapshots[memorySnapshots.length - 1];
      const memoryGrowth = lastSnapshot.heapUsed - firstSnapshot.heapUsed;
      const growthPercentage = (memoryGrowth / firstSnapshot.heapUsed) * 100;

      console.log(`Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB (${growthPercentage.toFixed(2)}%)`);

      // Memory should not grow excessively
      expect(growthPercentage).toBeLessThan(50); // Less than 50% growth
    });

    it('should handle resource exhaustion gracefully', async () => {
      // Test with extremely large payloads
      const largePayload = {
        task: 'A'.repeat(1024 * 1024), // 1MB task
        options: {
          maxTokens: 4000,
          temperature: 0.9
        }
      };

      const results = await Promise.all(
        Array(10).fill(null).map(() =>
          executeRequest('post', '/orchestrate', largePayload)
        )
      );

      const errors = results.filter(r => r.statusCode >= 400);
      const successRate = 1 - (errors.length / results.length);

      console.log(`Large payload success rate: ${(successRate * 100).toFixed(2)}%`);

      // Should handle gracefully even if some fail
      expect(successRate).toBeGreaterThan(0.5); // At least 50% should succeed or fail gracefully
    });
  });

  describe('API Performance Benchmarks', () => {
    it('should meet performance benchmarks for all endpoints', async () => {
      const benchmarks = [
        { endpoint: '/health', method: 'get' as const, targetP95: 100, targetThroughput: 100 },
        { endpoint: '/agents', method: 'get' as const, targetP95: 500, targetThroughput: 50 },
        { endpoint: '/memory/search', method: 'post' as const, targetP95: 2000, targetThroughput: 20,
          data: { query: 'test', limit: 5 } },
        { endpoint: '/orchestrate', method: 'post' as const, targetP95: 30000, targetThroughput: 5,
          data: { task: 'Simple test', options: { maxTokens: 100 } } }
      ];

      for (const benchmark of benchmarks) {
        console.log(`\nBenchmarking ${benchmark.method.toUpperCase()} ${benchmark.endpoint}`);

        const testDuration = 30000; // 30 seconds per benchmark
        const startTime = Date.now();
        const endpointMetrics: PerformanceMetrics[] = [];

        while (Date.now() - startTime < testDuration) {
          const promises = Array(10).fill(null).map(() =>
            executeRequest(benchmark.method, benchmark.endpoint, benchmark.data)
          );

          const results = await Promise.all(promises);
          endpointMetrics.push(...results);

          await new Promise(resolve => setTimeout(resolve, 100));
        }

        const results = calculateResults(endpointMetrics);

        console.log(`Results for ${benchmark.endpoint}:`);
        console.log(`  P95 Response Time: ${results.percentiles.p95.toFixed(2)}ms (target: ${benchmark.targetP95}ms)`);
        console.log(`  Throughput: ${results.throughput.toFixed(2)} req/s (target: ${benchmark.targetThroughput} req/s)`);
        console.log(`  Error Rate: ${(results.errorRate * 100).toFixed(2)}%`);

        // Verify benchmarks are met
        expect(results.percentiles.p95).toBeLessThan(benchmark.targetP95);
        expect(results.throughput).toBeGreaterThan(benchmark.targetThroughput);
      }
    }, 300000);
  });
});