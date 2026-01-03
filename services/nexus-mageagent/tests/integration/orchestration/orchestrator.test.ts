/**
 * Integration Tests for Orchestrator
 * Tests REAL Multi-Agent Orchestration with Real APIs
 */

import { Orchestrator } from '../../../src/orchestration/orchestrator';
import { OpenRouterClient } from '../../../src/clients/openrouter-client';
import { GraphRAGClient } from '../../../src/clients/graphrag-client';
import { DatabaseManager } from '../../../src/database/database-manager';
import { config } from '../../../src/config';
import { AgentRole } from '../../../src/agents/base-agent';

describe('Orchestrator - Real Multi-Agent Integration Tests', () => {
  let orchestrator: Orchestrator;
  let openRouterClient: OpenRouterClient;
  let graphRAGClient: GraphRAGClient;
  let databaseManager: DatabaseManager;

  beforeAll(async () => {
    // Initialize real services
    openRouterClient = new OpenRouterClient(
      process.env.OPENROUTER_API_KEY!,
      config.openRouter.baseUrl
    );

    graphRAGClient = new GraphRAGClient(config.graphRAG.externalEndpoint);

    databaseManager = new DatabaseManager();
    await databaseManager.initialize();

    // Create orchestrator with real dependencies
    orchestrator = new Orchestrator({
      openRouterClient,
      graphRAGClient,
      databaseManager,
      config: config.orchestration
    });

    // Verify all services are connected
    const models = await openRouterClient.listAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    console.log(`Connected to OpenRouter with ${models.length} models`);
  }, 60000);

  afterAll(async () => {
    await databaseManager.cleanup();
  });

  describe('Basic Orchestration', () => {
    test('should orchestrate a simple analysis task with real AI', async () => {
      const task = {
        objective: 'Analyze the benefits of microservices architecture',
        context: {
          domain: 'software engineering',
          focusAreas: ['scalability', 'maintainability', 'deployment']
        }
      };

      const result = await orchestrator.orchestrateTask(task, { type: 'analysis' });

      expect(result).toBeDefined();
      expect(result).toHaveRealData();
      expect(result.taskId).toBeDefined();
      expect(result.status).toBe('completed');
      expect(result.agents).toBeDefined();
      expect(result.agents.length).toBeGreaterThan(0);
      expect(result.result).toBeDefined();
      expect(result.result.analysis).toBeDefined();

      console.log('Analysis result:', {
        taskId: result.taskId,
        agentCount: result.agents.length,
        analysisLength: JSON.stringify(result.result.analysis).length
      });
    });

    test('should handle task status tracking', async () => {
      const task = {
        objective: 'Generate a TypeScript interface for user management',
        context: { language: 'TypeScript', requirements: ['CRUD operations', 'authentication'] }
      };

      const orchestrationResult = await orchestrator.orchestrateTask(task);
      const taskId = orchestrationResult.taskId;

      // Check task status
      const status = await orchestrator.getTaskStatus(taskId);

      expect(status).toBeDefined();
      expect(status.id).toBe(taskId);
      expect(status.status).toBe('completed');
      expect(status.objective).toBe(task.objective);
      expect(status.agents.length).toBeGreaterThan(0);
    });
  });

  describe('Agent Competition', () => {
    test('should run real agent competition with multiple models', async () => {
      const challenge = {
        challenge: 'Write an efficient algorithm to find the longest palindromic substring',
        competitorCount: 3,
        timeLimit: 60000, // 1 minute
        constraints: {
          language: 'Python',
          maxLines: 50,
          requireComplexityAnalysis: true
        }
      };

      const competitionResult = await orchestrator.runCompetition(challenge);

      expect(competitionResult).toHaveRealData();
      expect(competitionResult.competitionId).toBeDefined();
      expect(competitionResult.winner).toBeDefined();
      expect(competitionResult.winner.agentId).toBeDefined();
      expect(competitionResult.winner.model).toBeDefined();
      expect(competitionResult.winner.score).toBeGreaterThan(0);
      expect(competitionResult.winner.solution).toBeDefined();

      expect(competitionResult.rankings).toBeDefined();
      expect(competitionResult.rankings.length).toBeGreaterThanOrEqual(2);

      expect(competitionResult.consensus).toBeDefined();
      expect(competitionResult.patterns).toBeDefined();
      expect(Array.isArray(competitionResult.patterns)).toBe(true);

      console.log('Competition results:', {
        competitionId: competitionResult.competitionId,
        winner: competitionResult.winner.model,
        winnerScore: competitionResult.winner.score,
        competitors: competitionResult.rankings.length,
        patterns: competitionResult.patterns.length
      });

      // Verify diverse models were used
      const models = competitionResult.rankings.map(r => r.model);
      const uniqueModels = new Set(models);
      expect(uniqueModels.size).toBeGreaterThan(1);
    });

    test('should handle model-specific competition', async () => {
      const challenge = {
        challenge: 'Explain quantum computing to a 10-year-old',
        models: ['openai/gpt-3.5-turbo', 'anthropic/claude-3-haiku-20240307', 'google/gemini-flash-1.5'],
        competitorCount: 3,
        successCriteria: {
          clarity: 'high',
          accuracy: 'maintain scientific accuracy',
          engagement: 'use analogies and examples'
        }
      };

      const result = await orchestrator.runCompetition(challenge);

      expect(result).toHaveRealData();
      expect(result.rankings.length).toBe(3);

      // Verify specified models were used
      const usedModels = result.rankings.map(r => r.model);
      expect(challenge.models).toEqual(expect.arrayContaining(usedModels));

      console.log('Model-specific competition:', {
        models: usedModels,
        winnerExplanationLength: result.winner.solution.length
      });
    });

    test('should handle large-scale competition with many agents', async () => {
      const challenge = {
        challenge: 'Design a REST API for a social media platform',
        competitorCount: 5, // Test with more competitors
        constraints: {
          includeEndpoints: true,
          includeDataModels: true,
          includeSecurity: true,
          includeScalability: true
        }
      };

      const startTime = Date.now();
      const result = await orchestrator.runCompetition(challenge);
      const duration = Date.now() - startTime;

      expect(result).toHaveRealData();
      expect(result.rankings.length).toBeGreaterThanOrEqual(5);

      console.log('Large-scale competition:', {
        competitors: result.rankings.length,
        duration: `${duration}ms`,
        consensusTopics: Object.keys(result.consensus || {})
      });

      // All agents should have completed or timed out
      result.rankings.forEach(ranking => {
        expect(ranking.score).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('Agent Collaboration', () => {
    test('should orchestrate agent collaboration for complex tasks', async () => {
      const task = {
        objective: 'Build a complete authentication system design',
        context: {
          requirements: ['JWT tokens', 'OAuth2', 'MFA support', 'session management'],
          techStack: ['Node.js', 'PostgreSQL', 'Redis']
        },
        agents: [
          { role: AgentRole.RESEARCH, task: { id: 'research-auth', objective: 'Research best practices' } },
          { role: AgentRole.CODING, task: { id: 'code-auth', objective: 'Implement core logic' } },
          { role: AgentRole.REVIEW, task: { id: 'review-auth', objective: 'Review and improve' } }
        ]
      };

      const result = await orchestrator.orchestrateTask(task, { type: 'collaboration' });

      expect(result).toHaveRealData();
      expect(result.result.type).toBe('collaboration');
      expect(result.result.agents).toHaveLength(3);
      expect(result.result.contributions).toBeDefined();

      // Verify each agent contributed
      result.result.agents.forEach((agent: any) => {
        expect(result.result.contributions[agent.id]).toBeDefined();
      });

      console.log('Collaboration result:', {
        taskId: result.taskId,
        agents: result.result.agents.map((a: any) => ({ role: a.role, model: a.model })),
        contributionSizes: Object.entries(result.result.contributions)
          .map(([id, contrib]) => ({ id, size: JSON.stringify(contrib).length }))
      });
    });

    test('should handle collaborative synthesis', async () => {
      const task = {
        objective: 'Create a comprehensive guide for distributed systems monitoring',
        context: {
          topics: ['metrics', 'logging', 'tracing', 'alerting'],
          tools: ['Prometheus', 'Grafana', 'Jaeger', 'ELK Stack']
        }
      };

      const result = await orchestrator.orchestrateTask(task, { type: 'synthesis' });

      expect(result).toHaveRealData();
      expect(result.result.type).toBe('synthesis');
      expect(result.result.synthesis).toBeDefined();
      expect(result.result.agent).toBeDefined();

      console.log('Synthesis result:', {
        model: result.result.agent.model,
        synthesisLength: JSON.stringify(result.result.synthesis).length
      });
    });
  });

  describe('Model Selection and Validation', () => {
    test('should validate model availability', async () => {
      const validModel = 'openai/gpt-3.5-turbo';
      const invalidModel = 'invalid/non-existent-model';

      const isValidModelAvailable = await orchestrator.validateModel(validModel);
      const isInvalidModelAvailable = await orchestrator.validateModel(invalidModel);

      expect(isValidModelAvailable).toBe(true);
      expect(isInvalidModelAvailable).toBe(false);
    });

    test('should select appropriate models for different roles', async () => {
      // This test verifies internal model selection logic
      const researchTask = {
        objective: 'Research quantum computing applications',
        context: { depth: 'comprehensive', academic: true }
      };

      const codingTask = {
        objective: 'Implement a binary search tree in Rust',
        context: { language: 'Rust', optimized: true }
      };

      const [researchResult, codingResult] = await Promise.all([
        orchestrator.orchestrateTask(researchTask, { type: 'analysis' }),
        orchestrator.orchestrateTask(codingTask, { type: 'analysis' })
      ]);

      // Different tasks should potentially use different models
      console.log('Model selection:', {
        research: researchResult.agents[0]?.model,
        coding: codingResult.agents[0]?.model
      });

      expect(researchResult.agents[0]).toBeDefined();
      expect(codingResult.agents[0]).toBeDefined();
    });
  });

  describe('Active Agent Management', () => {
    test('should track active agents during execution', async () => {
      // Start multiple tasks concurrently
      const tasks = [
        orchestrator.orchestrateTask({ objective: 'Task 1: Explain recursion' }),
        orchestrator.orchestrateTask({ objective: 'Task 2: Design a cache system' }),
        orchestrator.orchestrateTask({ objective: 'Task 3: Optimize database queries' })
      ];

      // Check active agents while tasks are running
      setTimeout(async () => {
        const activeAgents = await orchestrator.getActiveAgents();
        console.log('Active agents during execution:', activeAgents.length);
        expect(activeAgents.length).toBeGreaterThan(0);
      }, 100);

      // Wait for all tasks to complete
      const results = await Promise.all(tasks);

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.status).toBe('completed');
      });
    });

    test('should handle agent lifecycle events', async () => {
      const events: any[] = [];

      // Listen to orchestrator events
      orchestrator.on('agentSpawned', (event) => {
        events.push({ type: 'spawned', ...event });
      });

      orchestrator.on('taskStarted', (event) => {
        events.push({ type: 'taskStarted', taskId: event.id });
      });

      orchestrator.on('taskCompleted', (event) => {
        events.push({ type: 'taskCompleted', taskId: event.task.id });
      });

      // Run a task
      await orchestrator.orchestrateTask({
        objective: 'Explain event-driven architecture',
        context: { includeExamples: true }
      });

      // Verify events were emitted
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'spawned')).toBe(true);
      expect(events.some(e => e.type === 'taskStarted')).toBe(true);
      expect(events.some(e => e.type === 'taskCompleted')).toBe(true);

      console.log('Lifecycle events captured:', events.length);

      // Cleanup listeners
      orchestrator.removeAllListeners();
    });
  });

  describe('Error Handling and Recovery', () => {
    test('should handle task failures gracefully', async () => {
      const invalidTask = {
        objective: '', // Empty objective
        context: {}
      };

      const result = await orchestrator.orchestrateTask(invalidTask);

      // Should still return a result structure
      expect(result).toBeDefined();
      expect(result.taskId).toBeDefined();
    });

    test('should handle agent failures in competition', async () => {
      const challenge = {
        challenge: 'Solve an impossible task: divide by zero gracefully',
        competitorCount: 3,
        timeLimit: 10000 // Short timeout
      };

      const result = await orchestrator.runCompetition(challenge);

      // Competition should complete even if some agents fail
      expect(result).toHaveRealData();
      expect(result.competitionId).toBeDefined();
      expect(result.rankings).toBeDefined();

      console.log('Handled failures:', {
        totalAgents: 3,
        completedAgents: result.rankings.filter(r => r.score > 0).length
      });
    });
  });

  describe('Memory Pattern Integration', () => {
    test('should store and recall orchestration patterns', async () => {
      // First task - establish pattern
      const task1 = {
        objective: 'Design a microservices communication pattern',
        context: { pattern: 'event-sourcing', technology: 'Kafka' }
      };

      const result1 = await orchestrator.orchestrateTask(task1);
      expect(result1.status).toBe('completed');

      // Small delay to ensure pattern is stored
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Second similar task - should benefit from stored patterns
      const task2 = {
        objective: 'Implement event-sourcing with message queues',
        context: { pattern: 'event-sourcing', technology: 'RabbitMQ' }
      };

      const result2 = await orchestrator.orchestrateTask(task2);
      expect(result2.status).toBe('completed');

      // Both should complete successfully with patterns stored
      console.log('Pattern integration test completed');
    });
  });

  describe('Performance and Scalability', () => {
    test('should handle concurrent orchestrations efficiently', async () => {
      const startTime = Date.now();

      const concurrentTasks = Array(5).fill(null).map((_, i) =>
        orchestrator.orchestrateTask({
          objective: `Concurrent task ${i}: Explain concept ${i}`,
          context: { index: i }
        })
      );

      const results = await Promise.all(concurrentTasks);
      const duration = Date.now() - startTime;

      expect(results).toHaveLength(5);
      results.forEach(result => {
        expect(result.status).toBe('completed');
        expect(result).toHaveRealData();
      });

      console.log(`Concurrent orchestration: ${results.length} tasks in ${duration}ms`);
      expect(duration).toBeLessThan(120000); // Should complete within 2 minutes
    });

    test('should maintain performance under load', async () => {
      const loadTest = async () => {
        const iterations = 3;
        const timings: number[] = [];

        for (let i = 0; i < iterations; i++) {
          const start = Date.now();

          await orchestrator.orchestrateTask({
            objective: `Load test task ${i}`,
            context: { iteration: i }
          });

          timings.push(Date.now() - start);
        }

        return timings;
      };

      const timings = await loadTest();
      const avgTime = timings.reduce((a, b) => a + b) / timings.length;

      console.log('Load test timings:', { timings, average: avgTime });

      // Performance should remain relatively stable
      const variance = Math.max(...timings) - Math.min(...timings);
      expect(variance).toBeLessThan(30000); // Max 30s variance
    });
  });

  describe('Real-World Scenarios', () => {
    test('should handle complex software architecture design', async () => {
      const architectureTask = {
        objective: 'Design a complete e-commerce platform architecture',
        context: {
          requirements: [
            'Handle 1M concurrent users',
            'Sub-second response time',
            'Multi-region deployment',
            'PCI compliance'
          ],
          components: [
            'Frontend (React/Next.js)',
            'API Gateway',
            'Microservices',
            'Databases',
            'Caching',
            'Message Queues',
            'Monitoring'
          ]
        }
      };

      const competition = await orchestrator.runCompetition({
        challenge: JSON.stringify(architectureTask),
        competitorCount: 4,
        timeLimit: 120000 // 2 minutes
      });

      expect(competition).toHaveRealData();
      expect(competition.winner.solution).toBeDefined();
      expect(competition.consensus).toBeDefined();

      console.log('Architecture design competition:', {
        winner: competition.winner.model,
        solutionTopics: Object.keys(competition.consensus || {}),
        patterns: competition.patterns.slice(0, 5)
      });
    });

    test('should handle code review and improvement workflow', async () => {
      // Collaborative code improvement
      const codeReviewTask = {
        objective: 'Review and improve a Python web scraper implementation',
        context: {
          code: `
def scrape_website(url):
    response = requests.get(url)
    soup = BeautifulSoup(response.text, 'html.parser')
    data = []
    for item in soup.find_all('div', class_='item'):
        data.append(item.text)
    return data
          `,
          requirements: [
            'Add error handling',
            'Implement rate limiting',
            'Add logging',
            'Make it async',
            'Add type hints'
          ]
        },
        agents: [
          { role: AgentRole.REVIEW, task: { id: 'review-code', objective: 'Review code quality' } },
          { role: AgentRole.CODING, task: { id: 'improve-code', objective: 'Implement improvements' } },
          { role: AgentRole.SYNTHESIS, task: { id: 'final-code', objective: 'Create final version' } }
        ]
      };

      const result = await orchestrator.orchestrateTask(codeReviewTask, { type: 'collaboration' });

      expect(result).toHaveRealData();
      expect(result.result.contributions).toBeDefined();

      const agents = result.result.agents;
      expect(agents).toHaveLength(3);

      console.log('Code review workflow:', {
        reviewAgent: agents.find((a: any) => a.role === 'review')?.model,
        codingAgent: agents.find((a: any) => a.role === 'coding')?.model,
        synthesisAgent: agents.find((a: any) => a.role === 'synthesis')?.model
      });
    });
  });
});