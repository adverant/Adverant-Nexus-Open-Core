/**
 * End-to-End tests for complete agent workflows
 * Tests full user journeys with real services and APIs
 */

import axios, { AxiosInstance } from 'axios';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001/api';
const WS_URL = process.env.WS_URL || 'http://localhost:3001';
const TEST_TIMEOUT = 300000; // 5 minutes for complex workflows

describe('MageAgent End-to-End Workflow Tests', () => {
  let apiClient: AxiosInstance;
  let wsClient: Socket;

  beforeAll(async () => {
    // Setup API client
    apiClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: TEST_TIMEOUT
    });

    // Wait for service readiness
    await waitForService();
  }, 60000);

  afterAll(async () => {
    if (wsClient && wsClient.connected) {
      wsClient.disconnect();
    }
  });

  async function waitForService(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await apiClient.get('/health');
        if (response.data.status === 'healthy') {
          return;
        }
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    throw new Error('Service failed to become ready');
  }

  describe('Complete Research Workflow', () => {
    it('should complete a full research task with multiple agents', async () => {
      const workflowId = uuidv4();
      const researchTopic = 'The impact of quantum computing on cryptography';

      // Step 1: Initialize research task
      console.log('Step 1: Starting research task...');
      const orchestrateResponse = await apiClient.post('/orchestrate', {
        task: `Research and analyze: ${researchTopic}`,
        options: {
          workflowId,
          agentTypes: ['research', 'analysis', 'synthesis'],
          maxTokens: 2000,
          storeInMemory: true,
          includeReferences: true
        }
      });

      expect(orchestrateResponse.status).toBe(200);
      expect(orchestrateResponse.data.success).toBe(true);
      const taskId = orchestrateResponse.data.taskId;

      // Step 2: Monitor progress via WebSocket
      console.log('Step 2: Monitoring progress via WebSocket...');
      const progressUpdates: any[] = [];

      wsClient = io(WS_URL);

      await new Promise<void>((resolve) => {
        wsClient.on('connect', () => {
          console.log('WebSocket connected');
          wsClient.emit('subscribe', { taskId });
          resolve();
        });
      });

      wsClient.on('task:progress', (update) => {
        console.log(`Progress: ${update.progress}% - ${update.status}`);
        progressUpdates.push(update);
      });

      // Step 3: Wait for task completion
      console.log('Step 3: Waiting for task completion...');
      let taskComplete = false;
      let finalStatus;

      while (!taskComplete) {
        const statusResponse = await apiClient.get(`/tasks/${taskId}`);
        finalStatus = statusResponse.data.status;

        if (finalStatus.state === 'completed' || finalStatus.state === 'failed') {
          taskComplete = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }

      expect(finalStatus.state).toBe('completed');
      expect(finalStatus.result).toBeDefined();

      // Step 4: Verify research results
      console.log('Step 4: Verifying research results...');
      const result = finalStatus.result;

      expect(result).toMatchObject({
        summary: expect.any(String),
        keyFindings: expect.any(Array),
        analysis: expect.any(Object),
        references: expect.any(Array)
      });

      // Verify real research content
      expect(result.summary).toContain('quantum');
      expect(result.summary).toContain('cryptography');
      expect(result.keyFindings.length).toBeGreaterThan(0);
      expect(result.references.length).toBeGreaterThan(0);

      // Step 5: Verify memory storage
      console.log('Step 5: Verifying memory storage...');
      const memorySearchResponse = await apiClient.post('/memory/search', {
        query: researchTopic,
        limit: 5
      });

      expect(memorySearchResponse.status).toBe(200);
      expect(memorySearchResponse.data.count).toBeGreaterThan(0);

      const storedMemory = memorySearchResponse.data.results[0];
      expect(storedMemory.metadata.workflowId).toBe(workflowId);

      // Step 6: Verify agent collaboration
      console.log('Step 6: Verifying agent collaboration...');
      const agents = orchestrateResponse.data.agents;

      expect(agents.length).toBeGreaterThanOrEqual(3);
      expect(agents.some((a: any) => a.type === 'research')).toBe(true);
      expect(agents.some((a: any) => a.type === 'analysis')).toBe(true);
      expect(agents.some((a: any) => a.type === 'synthesis')).toBe(true);

      // Step 7: Verify patterns learned
      console.log('Step 7: Checking learned patterns...');
      const patternsResponse = await apiClient.get('/patterns/research-workflow');

      expect(patternsResponse.status).toBe(200);
      expect(patternsResponse.data.patterns.length).toBeGreaterThan(0);

      console.log('Research workflow completed successfully!');
    }, TEST_TIMEOUT);
  });

  describe('Competitive Code Generation Workflow', () => {
    it('should run a complete code generation competition', async () => {
      const challenge = {
        title: 'Implement efficient cache with LRU eviction',
        requirements: [
          'Support get and put operations',
          'O(1) time complexity',
          'Thread-safe implementation',
          'Configurable capacity'
        ]
      };

      // Step 1: Start competition
      console.log('Step 1: Starting code generation competition...');
      const competitionResponse = await apiClient.post('/competition', {
        challenge: JSON.stringify(challenge),
        competitorCount: 4,
        models: [
          'openai/gpt-4-turbo',
          'anthropic/claude-3-opus',
          'meta-llama/llama-3-70b-instruct',
          'mistral/mixtral-8x22b-instruct'
        ]
      });

      expect(competitionResponse.status).toBe(200);
      const competitionId = competitionResponse.data.competitionId;

      // Step 2: Track competition progress via WebSocket
      console.log('Step 2: Tracking competition progress...');
      if (!wsClient || !wsClient.connected) {
        wsClient = io(WS_URL);
        await new Promise<void>((resolve) => {
          wsClient.on('connect', resolve);
        });
      }

      const competitorUpdates: any[] = [];
      wsClient.emit('subscribe', { competitionId });

      wsClient.on('competition:update', (update) => {
        console.log(`Competition update: Agent ${update.agentId} - Score: ${update.score}`);
        competitorUpdates.push(update);
      });

      // Step 3: Wait for competition completion
      console.log('Step 3: Waiting for competition results...');
      await new Promise(resolve => setTimeout(resolve, 30000)); // Give time for competition

      // Step 4: Analyze results
      console.log('Step 4: Analyzing competition results...');
      const winner = competitionResponse.data.winner;
      const rankings = competitionResponse.data.rankings;

      expect(winner).toMatchObject({
        agentId: expect.any(String),
        model: expect.any(String),
        score: expect.any(Number),
        solution: expect.any(String)
      });

      expect(rankings.length).toBe(4);
      expect(rankings[0].score).toBeGreaterThanOrEqual(rankings[1].score);

      // Step 5: Verify code quality
      console.log('Step 5: Verifying code quality...');
      const winnerCode = winner.solution;

      // Check for key implementation details
      expect(winnerCode).toContain('class');
      expect(winnerCode).toContain('get');
      expect(winnerCode).toContain('put');
      expect(winnerCode.toLowerCase()).toContain('lru');

      // Step 6: Test consensus mechanism
      console.log('Step 6: Checking consensus analysis...');
      const consensus = competitionResponse.data.consensus;

      expect(consensus).toMatchObject({
        commonPatterns: expect.any(Array),
        bestPractices: expect.any(Array),
        performanceMetrics: expect.any(Object)
      });

      // Step 7: Store winning solution
      console.log('Step 7: Storing winning solution...');
      const storeResponse = await apiClient.post('/patterns', {
        pattern: winner.solution,
        context: 'code-generation-lru-cache',
        performance: {
          score: winner.score,
          model: winner.model
        }
      });

      expect(storeResponse.status).toBe(200);

      console.log('Code generation competition completed!');
    }, TEST_TIMEOUT);
  });

  describe('Complex Multi-Stage Analysis Workflow', () => {
    it('should handle complex multi-stage data analysis', async () => {
      const analysisStages = [
        {
          stage: 'data_collection',
          task: 'Gather information about renewable energy trends in 2024'
        },
        {
          stage: 'processing',
          task: 'Process and categorize the collected data by energy type'
        },
        {
          stage: 'analysis',
          task: 'Analyze growth patterns and identify key drivers'
        },
        {
          stage: 'visualization',
          task: 'Create a summary report with key insights'
        }
      ];

      const workflowId = uuidv4();
      const stageResults: any[] = [];

      // Execute each stage
      for (const [index, stage] of analysisStages.entries()) {
        console.log(`Executing stage ${index + 1}: ${stage.stage}`);

        const stageResponse = await apiClient.post('/orchestrate', {
          task: stage.task,
          options: {
            workflowId,
            stageNumber: index + 1,
            previousResults: index > 0 ? stageResults[index - 1] : null,
            maxTokens: 1500
          }
        });

        expect(stageResponse.status).toBe(200);
        expect(stageResponse.data.success).toBe(true);

        // Wait for stage completion
        const taskId = stageResponse.data.taskId;
        let stageComplete = false;

        while (!stageComplete) {
          const statusResponse = await apiClient.get(`/tasks/${taskId}`);
          const status = statusResponse.data.status;

          if (status.state === 'completed') {
            stageComplete = true;
            stageResults.push(status.result);
          } else if (status.state === 'failed') {
            fail(`Stage ${stage.stage} failed: ${status.error}`);
          }

          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      // Verify complete workflow results
      expect(stageResults.length).toBe(4);

      // Check data collection stage
      expect(stageResults[0]).toMatchObject({
        data: expect.any(Array),
        sources: expect.any(Array),
        timestamp: expect.any(String)
      });

      // Check processing stage
      expect(stageResults[1]).toMatchObject({
        categories: expect.any(Object),
        totalItems: expect.any(Number)
      });

      // Check analysis stage
      expect(stageResults[2]).toMatchObject({
        trends: expect.any(Array),
        keyDrivers: expect.any(Array),
        insights: expect.any(String)
      });

      // Check visualization stage
      expect(stageResults[3]).toMatchObject({
        summary: expect.any(String),
        highlights: expect.any(Array),
        recommendations: expect.any(Array)
      });

      console.log('Multi-stage analysis workflow completed!');
    }, TEST_TIMEOUT);
  });

  describe('Error Recovery and Resilience Workflow', () => {
    it('should handle and recover from agent failures', async () => {
      // Intentionally trigger failures and test recovery
      const faultyTask = {
        task: 'Process this data: ' + 'X'.repeat(10 * 1024 * 1024), // 10MB of data
        options: {
          maxRetries: 3,
          fallbackModels: ['openai/gpt-3.5-turbo', 'anthropic/claude-2'],
          timeoutMs: 5000 // Short timeout to trigger failures
        }
      };

      console.log('Testing error recovery mechanisms...');

      const response = await apiClient.post('/orchestrate', faultyTask).catch(e => e.response);

      if (response.status === 200) {
        // System recovered successfully
        expect(response.data).toMatchObject({
          success: true,
          taskId: expect.any(String),
          recoveryAttempts: expect.any(Number)
        });
      } else {
        // System failed gracefully
        expect(response.status).toBeOneOf([400, 413, 500]);
        expect(response.data.error).toBeDefined();
        expect(response.data.message).toBeDefined();
      }
    });
  });

  describe('Real-time Collaboration Workflow', () => {
    it('should enable real-time multi-agent collaboration', async () => {
      const collaborationTask = {
        task: 'Collaboratively write a technical blog post about microservices',
        options: {
          collaborationMode: 'parallel',
          agents: [
            { type: 'research', focus: 'gather technical details' },
            { type: 'writer', focus: 'create content structure' },
            { type: 'editor', focus: 'improve clarity and flow' },
            { type: 'reviewer', focus: 'technical accuracy check' }
          ]
        }
      };

      // Start collaboration
      const response = await apiClient.post('/orchestrate', collaborationTask);
      expect(response.status).toBe(200);

      const taskId = response.data.taskId;

      // Monitor real-time updates
      if (!wsClient || !wsClient.connected) {
        wsClient = io(WS_URL);
        await new Promise<void>((resolve) => {
          wsClient.on('connect', resolve);
        });
      }

      const collaborationEvents: any[] = [];
      wsClient.emit('subscribe', { taskId, includeAgentComms: true });

      wsClient.on('agent:message', (event) => {
        console.log(`Agent ${event.from} -> ${event.to}: ${event.type}`);
        collaborationEvents.push(event);
      });

      // Wait for completion
      let complete = false;
      let finalResult;

      while (!complete) {
        const status = await apiClient.get(`/tasks/${taskId}`);
        if (status.data.status.state === 'completed') {
          complete = true;
          finalResult = status.data.status.result;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Verify collaboration occurred
      expect(collaborationEvents.length).toBeGreaterThan(0);
      expect(finalResult).toMatchObject({
        content: expect.any(String),
        metadata: expect.objectContaining({
          contributors: expect.any(Array),
          revisions: expect.any(Number)
        })
      });

      // Verify content quality
      expect(finalResult.content).toContain('microservices');
      expect(finalResult.content.length).toBeGreaterThan(1000);

      console.log('Real-time collaboration workflow completed!');
    }, TEST_TIMEOUT);
  });

  describe('Performance Metrics Collection', () => {
    it('should collect comprehensive performance metrics', async () => {
      const performanceTask = {
        task: 'Analyze system performance and generate optimization recommendations',
        options: {
          collectMetrics: true,
          includeProfile: true
        }
      };

      const startTime = Date.now();
      const response = await apiClient.post('/orchestrate', performanceTask);
      const endTime = Date.now();

      expect(response.status).toBe(200);

      // Check response time
      const responseTime = endTime - startTime;
      console.log(`Total response time: ${responseTime}ms`);
      expect(responseTime).toBeLessThan(60000); // Should complete within 1 minute

      // Get detailed metrics
      const taskId = response.data.taskId;
      const metricsResponse = await apiClient.get(`/tasks/${taskId}/metrics`).catch(() => null);

      if (metricsResponse) {
        expect(metricsResponse.data).toMatchObject({
          executionTime: expect.any(Number),
          tokenUsage: expect.any(Object),
          apiCalls: expect.any(Array),
          memoryUsage: expect.any(Object)
        });
      }
    });
  });
});

describe('WebSocket Event Streaming Tests', () => {
  let wsClient: Socket;
  let apiClient: AxiosInstance;

  beforeAll(() => {
    apiClient = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000
    });
  });

  afterEach(() => {
    if (wsClient && wsClient.connected) {
      wsClient.disconnect();
    }
  });

  it('should stream real-time agent outputs', async () => {
    // Start a streaming task
    const response = await apiClient.post('/orchestrate', {
      task: 'Write a story about AI agents working together',
      options: {
        stream: true,
        maxTokens: 500
      }
    });

    const taskId = response.data.taskId;

    // Connect WebSocket
    wsClient = io(WS_URL);
    const streamedTokens: string[] = [];

    await new Promise<void>((resolve) => {
      wsClient.on('connect', () => {
        wsClient.emit('subscribe', { taskId, streamTokens: true });
        resolve();
      });
    });

    wsClient.on('token', (token) => {
      streamedTokens.push(token);
    });

    // Wait for streaming to complete
    await new Promise(resolve => setTimeout(resolve, 20000));

    // Verify streaming worked
    expect(streamedTokens.length).toBeGreaterThan(0);
    const fullText = streamedTokens.join('');
    expect(fullText).toContain('AI');
    expect(fullText).toContain('agents');
  });
});