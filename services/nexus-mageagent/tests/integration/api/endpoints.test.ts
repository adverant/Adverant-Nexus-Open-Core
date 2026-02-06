/**
 * Integration tests for MageAgent API endpoints
 * Tests real API behaviors with actual service calls
 */

import axios, { AxiosInstance } from 'axios';
import { Server } from 'http';
import { config } from '../../../src/config';
import { logger } from '../../../src/utils/logger';

// Test configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001/api';
const TEST_TIMEOUT = 30000; // 30 seconds for real API calls

describe('MageAgent API Integration Tests', () => {
  let apiClient: AxiosInstance;
  let server: Server;

  beforeAll(async () => {
    // Create axios client for API calls
    apiClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: TEST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request/response interceptors for debugging
    apiClient.interceptors.request.use(
      (config) => {
        console.log(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('API Request Error:', error);
        return Promise.reject(error);
      }
    );

    apiClient.interceptors.response.use(
      (response) => {
        console.log(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        console.error('API Response Error:', error.response?.data || error.message);
        return Promise.reject(error);
      }
    );

    // Wait for service to be ready
    await waitForService();
  }, 60000);

  afterAll(async () => {
    // Cleanup if needed
  });

  // Helper function to wait for service readiness
  async function waitForService(maxRetries = 30, delay = 2000) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await apiClient.get('/health');
        if (response.data.status === 'healthy') {
          console.log('Service is ready');
          return;
        }
      } catch (error) {
        console.log(`Waiting for service... (attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Service failed to become ready');
  }

  describe('Health Check Endpoint', () => {
    it('should return healthy status when all services are operational', async () => {
      const response = await apiClient.get('/health');

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        status: expect.stringMatching(/healthy|degraded/),
        timestamp: expect.any(String),
        services: {
          databases: expect.objectContaining({
            postgres: expect.any(Boolean),
            redis: expect.any(Boolean),
            neo4j: expect.any(Boolean),
            qdrant: expect.any(Boolean)
          }),
          memAgent: expect.any(Boolean),
          websocket: expect.any(Object),
          orchestrator: expect.stringMatching(/running|not initialized/)
        }
      });

      // Verify real data (no mocks)
      expect(response.data).toHaveRealData();
    });

    it('should handle database connection failures gracefully', async () => {
      // This test assumes we can simulate a failure
      // In real integration testing, we might need to temporarily disconnect a service
      try {
        const response = await apiClient.get('/health');

        if (response.data.status === 'degraded') {
          expect(response.status).toBe(503);
          expect(response.data.services).toBeDefined();
        }
      } catch (error: any) {
        expect(error.response?.status).toBe(503);
      }
    });
  });

  describe('Orchestration Endpoint', () => {
    it('should orchestrate a simple task with real OpenRouter API', async () => {
      const taskRequest = {
        task: 'Analyze the benefits of TypeScript for large-scale applications',
        options: {
          maxTokens: 500,
          temperature: 0.7,
          models: ['openai/gpt-4-turbo', 'anthropic/claude-opus-4.6']
        }
      };

      const response = await apiClient.post('/orchestrate', taskRequest);

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        success: true,
        taskId: expect.any(String),
        status: expect.any(String),
        agents: expect.any(Array),
        result: expect.any(Object)
      });

      // Verify real API was used (result should contain actual analysis)
      expect(response.data.result).toHaveRealData();
      expect(response.data.agents.length).toBeGreaterThan(0);

      // Verify task ID format
      expect(response.data.taskId).toMatch(/^[a-f0-9-]+$/);
    }, 60000);

    it('should handle missing task parameter', async () => {
      try {
        await apiClient.post('/orchestrate', { options: {} });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.error).toBe('Task is required');
      }
    });

    it('should respect rate limiting', async () => {
      // Make multiple rapid requests
      const requests = Array(15).fill(null).map(() =>
        apiClient.post('/orchestrate', {
          task: 'Quick test task',
          options: { maxTokens: 50 }
        }).catch(e => e.response)
      );

      const responses = await Promise.all(requests);

      // Some requests should be rate limited
      const rateLimited = responses.filter(r => r?.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);

      // Rate limited responses should have retry information
      if (rateLimited.length > 0) {
        expect(rateLimited[0].data).toMatchObject({
          error: expect.stringContaining('rate limit'),
          retryAfter: expect.any(Number)
        });
      }
    });

    it('should handle large input gracefully', async () => {
      const largeTask = 'A'.repeat(1024 * 1024); // 1MB of text

      try {
        const response = await apiClient.post('/orchestrate', {
          task: largeTask,
          options: { maxTokens: 100 }
        });

        // Should either handle it or reject with appropriate error
        expect(response.status).toBe(200);
      } catch (error: any) {
        expect(error.response?.status).toBeOneOf([413, 400]);
      }
    });
  });

  describe('Competition Endpoint', () => {
    it('should run agent competition with real models', async () => {
      const competitionRequest = {
        challenge: 'Write a function to calculate fibonacci numbers efficiently',
        competitorCount: 3,
        models: [
          'openai/gpt-4-turbo',
          'anthropic/claude-opus-4.6',
          'meta-llama/llama-3-70b-instruct'
        ]
      };

      const response = await apiClient.post('/competition', competitionRequest);

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        success: true,
        competitionId: expect.any(String),
        winner: expect.objectContaining({
          agentId: expect.any(String),
          score: expect.any(Number),
          model: expect.any(String)
        }),
        rankings: expect.any(Array),
        consensus: expect.any(Object)
      });

      // Verify real competition results
      expect(response.data.rankings.length).toBe(competitionRequest.competitorCount);
      expect(response.data.winner.score).toBeGreaterThan(0);
      expect(response.data).toHaveRealData();
    }, 120000);

    it('should enforce stricter rate limits for competitions', async () => {
      // Competition endpoint has max 5 requests per 15 minutes
      const requests = Array(7).fill(null).map(() =>
        apiClient.post('/competition', {
          challenge: 'Quick competition',
          competitorCount: 2
        }).catch(e => e.response)
      );

      const responses = await Promise.all(requests);

      // Should hit rate limit after 5 requests
      const rateLimited = responses.filter(r => r?.status === 429);
      expect(rateLimited.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Agent Management Endpoints', () => {
    it('should list active agents', async () => {
      const response = await apiClient.get('/agents');

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        agents: expect.any(Array),
        count: expect.any(Number),
        timestamp: expect.any(String)
      });

      // If agents are active, verify their structure
      if (response.data.count > 0) {
        expect(response.data.agents[0]).toMatchObject({
          id: expect.any(String),
          type: expect.any(String),
          status: expect.any(String),
          model: expect.any(String)
        });
      }
    });

    it('should retrieve specific agent details', async () => {
      // First, create a task to ensure we have an agent
      const taskResponse = await apiClient.post('/orchestrate', {
        task: 'Simple test task',
        options: { maxTokens: 50 }
      });

      const agentId = taskResponse.data.agents[0]?.id;

      if (agentId) {
        const response = await apiClient.get(`/agents/${agentId}`);

        expect(response.status).toBe(200);
        expect(response.data).toMatchObject({
          agentId: agentId,
          output: expect.any(Object),
          timestamp: expect.any(String)
        });
      }
    });

    it('should return 404 for non-existent agent', async () => {
      try {
        await apiClient.get('/agents/non-existent-agent-id');
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.error).toBe('Agent not found');
      }
    });
  });

  describe('Memory Search Endpoint', () => {
    it('should search memory with real MemAgent', async () => {
      // First, store something in memory through a task
      await apiClient.post('/orchestrate', {
        task: 'Remember this: The capital of France is Paris',
        options: { storeInMemory: true }
      });

      // Search for it
      const searchResponse = await apiClient.post('/memory/search', {
        query: 'capital of France',
        limit: 5
      });

      expect(searchResponse.status).toBe(200);
      expect(searchResponse.data).toMatchObject({
        query: 'capital of France',
        results: expect.any(Array),
        count: expect.any(Number)
      });

      // Verify real search results
      if (searchResponse.data.count > 0) {
        expect(searchResponse.data.results[0]).toMatchObject({
          content: expect.any(String),
          score: expect.any(Number),
          metadata: expect.any(Object)
        });
      }
    });

    it('should handle complex search queries', async () => {
      const complexQueries = [
        'TypeScript AND JavaScript performance comparison',
        'machine learning OR artificial intelligence applications',
        '"exact phrase search" for testing',
        'special-characters_test.query'
      ];

      for (const query of complexQueries) {
        const response = await apiClient.post('/memory/search', { query });

        expect(response.status).toBe(200);
        expect(response.data.query).toBe(query);
        expect(response.data.results).toBeDefined();
      }
    });

    it('should respect memory search rate limits', async () => {
      // Memory search allows 30 requests per minute
      const requests = Array(35).fill(null).map((_, i) =>
        apiClient.post('/memory/search', {
          query: `test query ${i}`
        }).catch(e => e.response)
      );

      const responses = await Promise.all(requests);

      const rateLimited = responses.filter(r => r?.status === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  describe('Pattern Management Endpoints', () => {
    it('should store and retrieve patterns', async () => {
      const pattern = {
        pattern: 'Efficient async/await error handling pattern',
        context: 'javascript-best-practices',
        performance: {
          efficiency: 0.92,
          reliability: 0.95
        }
      };

      // Store pattern
      const storeResponse = await apiClient.post('/patterns', pattern);
      expect(storeResponse.status).toBe(200);
      expect(storeResponse.data.success).toBe(true);

      // Retrieve patterns
      const getResponse = await apiClient.get(`/patterns/${pattern.context}?limit=10`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.data).toMatchObject({
        context: pattern.context,
        patterns: expect.any(Array),
        count: expect.any(Number)
      });

      // Verify our pattern is included
      const storedPattern = getResponse.data.patterns.find(
        (p: any) => p.pattern === pattern.pattern
      );
      expect(storedPattern).toBeDefined();
    });

    it('should validate pattern input', async () => {
      try {
        await apiClient.post('/patterns', { context: 'test' });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.error).toContain('required');
      }
    });
  });

  describe('WebSocket Stats Endpoint', () => {
    it('should return WebSocket statistics', async () => {
      const response = await apiClient.get('/websocket/stats');

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        stats: expect.objectContaining({
          connected: expect.any(Number),
          rooms: expect.any(Number),
          totalEvents: expect.any(Number)
        }),
        timestamp: expect.any(String)
      });
    });
  });

  describe('Model Validation Endpoint', () => {
    it('should validate real OpenRouter models', async () => {
      const validModels = [
        'openai/gpt-4-turbo',
        'anthropic/claude-opus-4.6',
        'meta-llama/llama-3-70b-instruct'
      ];

      for (const modelId of validModels) {
        const response = await apiClient.post('/validate-model', { modelId });

        expect(response.status).toBe(200);
        expect(response.data).toMatchObject({
          modelId: modelId,
          valid: true,
          timestamp: expect.any(String)
        });
      }
    });

    it('should reject invalid models', async () => {
      const response = await apiClient.post('/validate-model', {
        modelId: 'invalid/non-existent-model'
      });

      expect(response.status).toBe(200);
      expect(response.data.valid).toBe(false);
    });
  });

  describe('Task Status Endpoint', () => {
    it('should track task status through completion', async () => {
      // Start a task
      const taskResponse = await apiClient.post('/orchestrate', {
        task: 'Generate a haiku about software testing',
        options: { maxTokens: 100 }
      });

      const taskId = taskResponse.data.taskId;

      // Check status
      const statusResponse = await apiClient.get(`/tasks/${taskId}`);

      expect(statusResponse.status).toBe(200);
      expect(statusResponse.data).toMatchObject({
        taskId: taskId,
        status: expect.objectContaining({
          state: expect.stringMatching(/pending|running|completed|failed/),
          progress: expect.any(Number),
          startTime: expect.any(String)
        }),
        timestamp: expect.any(String)
      });

      // If completed, verify end time
      if (statusResponse.data.status.state === 'completed') {
        expect(statusResponse.data.status.endTime).toBeDefined();
        expect(statusResponse.data.status.result).toBeDefined();
      }
    });

    it('should return 404 for non-existent task', async () => {
      try {
        await apiClient.get('/tasks/non-existent-task-id');
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.error).toBe('Task not found');
      }
    });
  });

  describe('Security and Error Handling', () => {
    it('should sanitize malicious input', async () => {
      const maliciousInputs = [
        { task: '<script>alert("XSS")</script>' },
        { task: '"; DROP TABLE users; --' },
        { task: '../../../etc/passwd' },
        { task: { $ne: null } } // NoSQL injection attempt
      ];

      for (const input of maliciousInputs) {
        const response = await apiClient.post('/orchestrate', input).catch(e => e.response);

        // Should either sanitize or reject
        expect(response.status).toBeOneOf([200, 400]);

        if (response.status === 200) {
          // Verify sanitization worked
          expect(response.data.result).not.toContain('<script>');
          expect(response.data.result).not.toContain('DROP TABLE');
        }
      }
    });

    it('should handle server errors gracefully', async () => {
      // Send malformed data to trigger server error
      try {
        await apiClient.post('/orchestrate', null);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response.status).toBeOneOf([400, 500]);
        expect(error.response.data.error).toBeDefined();

        // Should not expose internal details in production
        if (process.env.NODE_ENV === 'production') {
          expect(error.response.data.message).not.toContain('stack');
          expect(error.response.data.message).not.toContain('at ');
        }
      }
    });

    it('should enforce request size limits', async () => {
      const oversizedPayload = {
        task: 'A'.repeat(101 * 1024 * 1024) // 101MB
      };

      try {
        await apiClient.post('/orchestrate', oversizedPayload);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response?.status).toBeOneOf([413, 400]);
      }
    });
  });
});

// Custom Jest matcher for TypeScript
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeOneOf(expected: any[]): R;
    }
  }
}

expect.extend({
  toBeOneOf(received, expected) {
    const pass = expected.includes(received);
    return {
      pass,
      message: () =>
        `Expected ${received} to be one of ${expected.join(', ')}`
    };
  }
});