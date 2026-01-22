import { Redis } from 'ioredis';
import { OpenRouterClient } from '../clients/openrouter-client';
import { GraphRAGClient } from '../clients/graphrag-client';
import { DatabaseManager } from '../database/database-manager';
import { Agent, AgentRole, AgentTask } from '../agents/base-agent';
import { ResearchAgent } from '../agents/research-agent';
import { CodingAgent } from '../agents/coding-agent';
import { ReviewAgent } from '../agents/review-agent';
import { SynthesisAgent } from '../agents/synthesis-agent';
import { SpecialistAgent, SpecialistAgentConfig } from '../agents/specialist-agent';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { AgentPool } from '../utils/agent-pool';
import { orchestrationQueue } from '../utils/task-queue';
import { parallelAgentSpawner } from '../utils/parallel-agent-spawner';
import { ModelSelector, ModelSelectionCriteria } from '../utils/model-selector';
import { adaptiveTimeoutManager } from '../utils/adaptive-timeout-manager';
import { entityManagerClient, EntityManagerClient, getEntityManagerClient } from '../clients/entity-manager-client';
import { EnhancedAgentConfig } from '../agents/enhanced-base-agent';
import { MemoryStorageQueue } from '../core/memory-storage-queue';
import { AgentGenerator } from './agent-generator';
import { ConsensusEngine } from './consensus-engine';

// Import memory and cognitive services
// PHASE 35: Import TenantContext for multi-tenant isolation
import { episodeService, TenantContext } from '../services/episode-service';
import { contextService } from '../services/context-service';
import { documentStorageService } from '../services/document-storage-service';
import { conversationThreadingService } from '../services/conversation-threading-service';
import { agentLearningService } from '../services/agent-learning-service';
import { graphRAGMemoryRepository } from '../services/graphrag-memory-repository';
import { createStreamingPipeline } from '../services/streaming-storage-pipeline';
import { progressiveSummarizationEngine } from '../services/progressive-summarization';
import { AdaptiveEntityExtractor } from '../services/adaptive-entity-extractor';

// Import synthesis checkpoint service for WAL-based crash recovery
import { SynthesisCheckpointService } from '../services/synthesis-checkpoint-service';

// Import intelligent retry system
import { RetryAnalyzer } from '../retry/retry-analyzer';
import { RetryExecutor, createRetryExecutor } from '../retry/orchestrator-integration';

// PHASE 2.3: Import Disposable Resource for RAII pattern
import { DisposableResource } from '../utils/disposable';

// Import service clients for Universal Request Orchestrator
import { WorkflowRouterService, getWorkflowRouterService } from '../services/workflow-router-service';
import { getCyberAgentClient } from '../clients/cyberagent-client';
import { getFileProcessClient } from '../clients/fileprocess-client';
import { getSandboxClient } from '../clients/sandbox-client';

export interface OrchestratorConfig {
  maxConcurrentAgents: number;
  defaultTimeout: number;
  taskQueueSize: number;
  competition: {
    minAgents: number;
    maxAgents: number;
    evaluationTimeout: number;
  };
  modelSelection: {
    costOptimization: boolean;
    latencyThreshold: number;
    qualityThreshold: number;
  };
}

export interface AgentSpawnRequest {
  role: AgentRole;
  task: AgentTask;
  model?: string;
  competitionGroup?: string;
  collaborationGroup?: string;
  specialistConfig?: SpecialistAgentConfig; // For dynamically generated specialist agents
}

export interface OrchestratorTask {
  id: string;
  type: 'analysis' | 'competition' | 'collaboration' | 'synthesis' | 'workflow' | 'file_process' | 'security_scan' | 'code_execute';
  objective: string;
  context: any;
  constraints?: any;
  agents?: AgentSpawnRequest[];
  createdAt: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  sessionId?: string;
  threadId?: string;
  memoryContext?: any;
  entityId?: string; // Link to Universal Entity
  domain?: string;
  userId?: string;
}

export interface CompetitionChallenge {
  challenge: string;
  competitorCount?: number;
  models?: string[];
  timeLimit?: number;
  timeout?: number; // Support both timeLimit and timeout
  constraints?: any;
  successCriteria?: any;
}

export interface CompetitionResult {
  competitionId: string;
  winner: {
    agentId: string;
    model: string;
    score: number;
    solution: any;
  };
  rankings: Array<{
    agentId: string;
    model: string;
    score: number;
    solution: any;
  }>;
  consensus: any;
  patterns: string[];
  timestamp: string;
}

export class Orchestrator extends EventEmitter {
  private agentPool: AgentPool;
  private tasks: Map<string, OrchestratorTask> = new Map();
  // private _taskQueue: PQueue;
  private currentSessionId: string = uuidv4();
  private activeThreads: Map<string, string> = new Map(); // taskId -> threadId
  private modelSelector: ModelSelector;
  private agentGenerator: AgentGenerator;
  private consensusEngine: ConsensusEngine;

  private checkpointService: SynthesisCheckpointService;

  // Intelligent retry system
  private retryAnalyzer: RetryAnalyzer;
  private retryExecutor: RetryExecutor;

  // PHASE 35: Current tenant context for multi-tenant isolation during task execution
  private currentTenantContext?: TenantContext;

  constructor(
    private dependencies: {
      openRouterClient: OpenRouterClient;
      graphRAGClient: GraphRAGClient;
      databaseManager: DatabaseManager;
      config: OrchestratorConfig;
      memoryStorageQueue: MemoryStorageQueue;
      redisClient: Redis;
    }
  ) {
    super();

    // Initialize model selector with intelligent fallback
    this.modelSelector = new ModelSelector(dependencies.openRouterClient);

    // Initialize dynamic agent generator (replaces hardcoded templates)
    this.agentGenerator = new AgentGenerator(
      dependencies.openRouterClient,
      dependencies.graphRAGClient,
      this.modelSelector
    );

    // Initialize 3-layer consensus engine (Phase 2)
    this.consensusEngine = new ConsensusEngine(
      dependencies.openRouterClient,
      dependencies.graphRAGClient,
      this.modelSelector
    );

    // Initialize agent pool with configuration
    this.agentPool = new AgentPool(
      dependencies.config.maxConcurrentAgents,
      3600000, // 1 hour max age
      600000   // 10 minutes idle time
    );

    // Initialize synthesis checkpoint service for WAL-based crash recovery
    this.checkpointService = new SynthesisCheckpointService(dependencies.redisClient);

    // Initialize intelligent retry system
    this.retryAnalyzer = new RetryAnalyzer(dependencies.databaseManager.postgres);
    this.retryExecutor = createRetryExecutor(this.retryAnalyzer);

    // Wire retry events to orchestrator event bus for WebSocket streaming
    this.wireRetryEvents();

    // Create task queue with no concurrency limit
    // this._taskQueue = new PQueue({
    //   concurrency: Infinity, // NO LIMIT - process all tasks as they come
    //   timeout: dependencies.config.defaultTimeout
    // });

    // Recover any pending synthesis checkpoints from previous crashes
    this.recoverPendingCheckpointsAsync();

    logger.info('Orchestrator initialized with intelligent retry system');
  }

  /**
   * Wire retry executor events to orchestrator for WebSocket streaming.
   * All retry events are forwarded to the orchestrator event bus for real-time client updates.
   */
  private wireRetryEvents(): void {
    // Forward all retry events to orchestrator event bus
    this.retryExecutor.on('retry:attempt', (event) => {
      this.emit('retry:attempt', event);
      logger.debug('Retry attempt', { taskId: event.taskId, attempt: event.attemptNumber });
    });

    this.retryExecutor.on('retry:analysis', (event) => {
      this.emit('retry:analysis', event);
      logger.debug('Retry analysis', { taskId: event.taskId, confidence: event.confidence });
    });

    this.retryExecutor.on('retry:backoff', (event) => {
      this.emit('retry:backoff', event);
      logger.debug('Retry backoff', { taskId: event.taskId, delayMs: event.delayMs });
    });

    this.retryExecutor.on('retry:success', (event) => {
      this.emit('retry:success', event);
      logger.info('Retry succeeded', { taskId: event.taskId, totalAttempts: event.totalAttempts });
    });

    this.retryExecutor.on('retry:exhausted', (event) => {
      this.emit('retry:exhausted', event);
      logger.warn('Retries exhausted', { taskId: event.taskId, attempts: event.attempts });
    });

    logger.debug('Retry event forwarding configured');
  }

  // Main orchestration entry point with memory integration and queuing
  async orchestrateTask(task: any, options: any = {}): Promise<any> {
    // Add to queue for controlled execution
    return orchestrationQueue.add(async () => {
      return this._executeOrchestration(task, options);
    }, options.timeout || 60000);
  }

  /**
   * Create a Universal Entity for the orchestration task
   * PHASE 55: Use tenant-aware EntityManagerClient for multi-tenant isolation
   */
  private async createTaskEntity(task: OrchestratorTask): Promise<string | undefined> {
    try {
      // PHASE 55: Use tenant-aware client if tenant context is available
      const client = this.currentTenantContext
        ? getEntityManagerClient(createGraphRAGClient(this.currentTenantContext))
        : entityManagerClient;

      const entity = await client.createEntity({
        type: 'orchestration_task',
        domain: task.domain || 'general',
        content: {
          objective: task.objective,
          type: task.type,
          context: task.context
        },
        metadata: {
          sessionId: task.sessionId,
          threadId: task.threadId,
          userId: task.userId,
          status: task.status,
          createdAt: task.createdAt.toISOString()
        }
      });

      logger.info('Created orchestration entity', {
        entityId: entity.id,
        taskId: task.id
      });

      return entity.id;
    } catch (error) {
      logger.error('Failed to create task entity', { error, taskId: task.id });
      return undefined;
    }
  }

  /**
   * Update task entity with results
   * PHASE 55: Use tenant-aware EntityManagerClient for multi-tenant isolation
   */
  private async updateTaskEntity(task: OrchestratorTask): Promise<void> {
    if (!task.entityId) return;

    try {
      // PHASE 55: Use tenant-aware client if tenant context is available
      const client = this.currentTenantContext
        ? getEntityManagerClient(createGraphRAGClient(this.currentTenantContext))
        : entityManagerClient;

      await client.updateEntity(task.entityId, {
        content: {
          objective: task.objective,
          type: task.type,
          context: task.context,
          result: this.summarizeResult(task.result)
        },
        metadata: {
          sessionId: task.sessionId,
          threadId: task.threadId,
          userId: task.userId,
          status: task.status,
          createdAt: task.createdAt.toISOString(),
          completedAt: new Date().toISOString(),
          agentCount: this.getTaskAgentCount(task),
          models: this.getTaskModels(task)
        }
      });

      logger.info('Updated orchestration entity', {
        entityId: task.entityId,
        taskId: task.id,
        status: task.status
      });
    } catch (error) {
      logger.error('Failed to update task entity', { error, taskId: task.id });
    }
  }

  // Internal orchestration execution
  private async _executeOrchestration(task: any, options: any = {}): Promise<any> {
    // PHASE 51: Capture tenant context in LOCAL variable to avoid race conditions
    // The singleton pattern with async TaskQueue means this.currentTenantContext can be
    // overwritten by concurrent requests before this task completes. Using a local variable
    // ensures the closure captures the correct tenant context for THIS specific request.
    // CRITICAL: All downstream calls in this method MUST use this local variable, NOT this.currentTenantContext
    const localTenantContext: TenantContext | undefined = options.tenantContext;

    // PHASE 34: Also set on instance for backwards compatibility with code outside this method
    this.currentTenantContext = localTenantContext;

    // Extract query string
    const query = typeof task === 'string' ? task : task.objective || task.query || '';

    // ✨ BYPASS FOR SHORT MESSAGES: Route directly to single LLM, skip GraphRAG
    // GraphRAG requires minimum 10 characters for episode storage
    const MIN_GRAPHRAG_LENGTH = 10;
    if (query.trim().length < MIN_GRAPHRAG_LENGTH) {
      logger.info('Short message detected - bypassing GraphRAG, using single LLM', {
        queryLength: query.trim().length,
        minRequired: MIN_GRAPHRAG_LENGTH,
        bypass: true
      });

      const taskId = options.taskId || uuidv4();

      try {
        // Use OpenRouter for simple chat-style response
        const response = await this.dependencies.openRouterClient.createCompletion({
          model: 'anthropic/claude-3.5-sonnet',
          messages: [{ role: 'user', content: query }],
          max_tokens: 2000,
          temperature: 0.7
        });

        const answer = response.choices[0]?.message?.content || 'No response generated';

        logger.info('Short message processed successfully', {
          taskId,
          queryLength: query.trim().length,
          answerLength: answer.length
        });

        return {
          answer,
          reasoning: 'Short message processed by single LLM (bypassed multi-agent orchestration due to GraphRAG minimum length requirement)',
          sources: [],
          confidence: 0.8,
          metadata: {
            taskId,
            model: 'anthropic/claude-3.5-sonnet',
            bypass: true,
            reason: 'message_too_short_for_graphrag',
            minLengthRequired: MIN_GRAPHRAG_LENGTH,
            actualLength: query.trim().length
          }
        };
      } catch (error: any) {
        logger.error('Failed to process short message via OpenRouter', {
          error: error.message,
          taskId,
          queryLength: query.trim().length
        });

        // Provide helpful error message
        throw new Error(
          `Failed to process short message: ${error.message}. ` +
          `Note: Messages shorter than ${MIN_GRAPHRAG_LENGTH} characters are processed directly without multi-agent orchestration.`
        );
      }
    }

    // Assess task complexity for adaptive timeout
    const complexity = this.assessTaskComplexity(query);
    // Use provided taskId if available (from TaskManager), otherwise generate new one
    const taskId = options.taskId || uuidv4();

    // Calculate adaptive timeout
    const selectedModel = options.model || 'anthropic/claude-3.5-sonnet';
    const estimatedTimeout = adaptiveTimeoutManager.getEstimatedCompletionTime(
      selectedModel,
      complexity
    ) || this.getDefaultTimeout(complexity);

    // Respect client-provided timeout if higher than estimated
    const timeout = options.timeout || estimatedTimeout;

    logger.info('Starting orchestration with adaptive timeout:', {
      taskId,
      query: query.substring(0, 100),
      complexity,
      estimatedTimeout,
      actualTimeout: timeout,
      model: selectedModel
    });

    // Start adaptive monitoring for stall detection
    adaptiveTimeoutManager.startMonitoring(
      taskId,
      selectedModel,
      complexity
    );

    // Create or continue conversation thread
    // PHASE38: Pass tenant context for multi-tenant isolation
    let threadId = options.threadId;
    if (!threadId) {
      const thread = await conversationThreadingService.createThread(
        query,
        this.currentSessionId,
        { source: 'orchestrator' },
        localTenantContext  // PHASE 51: Use local variable for race-condition safety
      );
      threadId = thread.id;
    }

    // Add user message to thread
    await conversationThreadingService.addMessage(
      threadId,
      'user',
      query,
      { timestamp: new Date() }
    );

    // CRITICAL: Store user query in GraphRAG for comprehensive memory
    // PHASE 41: Pass tenantContext for multi-tenant isolation
    await graphRAGMemoryRepository.storeConversationMessage({
      threadId,
      role: 'user',
      content: query,
      metadata: {
        taskId,
        timestamp: new Date()
      }
    }, localTenantContext);  // PHASE 51: Use local variable for race-condition safety

    // Synthesize context from all memory sources with limits
    // CRITICAL FIX: Use paged context synthesis for extreme complexity tasks
    let memoryContext;
    try {
      // Detect if task requires paged memory processing
      // Convert complexity string to numeric score for comparison
      const complexityScore = complexity === 'extreme' ? 1.0 :
                             complexity === 'complex' ? 0.8 :
                             complexity === 'medium' ? 0.5 : 0.3;

      const requiresPaging = complexityScore >= 0.8 || // High/Extreme complexity tasks
        query.length > 500 || // Very long prompts
        (query.toLowerCase().includes('50000') || // Explicit large outputs
         query.toLowerCase().includes('50,000') ||
         query.toLowerCase().includes('large') ||
         query.toLowerCase().includes('extensive') ||
         query.toLowerCase().includes('comprehensive'));

      if (requiresPaging) {
        logger.info('Using paged context synthesis for extreme complexity task', {
          complexity,
          queryLength: query.length,
          maxTokens: 4000,
          chunkSize: 2
        });

        // PHASE 56: Pass tenant context for multi-tenant isolation
        memoryContext = await contextService.synthesizeContextPaged(query, {
          sessionId: this.currentSessionId,
          threadId,
          includeEpisodes: true,
          includeDocuments: false, // Disable document loading to save memory
          includeMemories: true,
          includeGraph: false, // Disable graph loading to save memory
          limit: 5, // Reduce limit from 10 to 5
          maxTokens: 4000, // Hard token budget for paged retrieval
          chunkSize: 2, // Process 2 memories at a time
          tenantContext: this.currentTenantContext // PHASE 56: Multi-tenant isolation
        });
      } else {
        // Standard context synthesis for normal tasks
        // PHASE 56: Pass tenant context for multi-tenant isolation
        memoryContext = await contextService.synthesizeContext(query, {
          sessionId: this.currentSessionId,
          threadId,
          includeEpisodes: true,
          includeDocuments: false, // Disable document loading to save memory
          includeMemories: true,
          includeGraph: false, // Disable graph loading to save memory
          limit: 5, // Reduce limit from 10 to 5
          tenantContext: this.currentTenantContext // PHASE 56: Multi-tenant isolation
        });
      }
    } catch (error) {
      logger.warn('Failed to synthesize context, using minimal context', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      memoryContext = { summary: '', relevantMemories: [], relevanceScore: 0 };
    }

    // Create episode for user input
    // PHASE 34: Pass tenant context for multi-tenant isolation
    await episodeService.createFromUserInput(
      query,
      this.currentSessionId,
      { threadId, context: memoryContext.summary },
      localTenantContext  // PHASE 51: Use local variable for race-condition safety
    );

    // Create a proper task object with memory context (use the taskId we generated for monitoring)
    const orchestratorTask: OrchestratorTask = {
      id: taskId,
      type: options.type || 'analysis',
      objective: query,
      context: typeof task === 'object' ? { ...task, memoryContext } : { query: task, memoryContext },
      constraints: options.constraints,
      createdAt: new Date(),
      status: 'pending',
      sessionId: this.currentSessionId,
      threadId,
      memoryContext,
      domain: options.domain,
      userId: options.userId
    };

    // Create Universal Entity for this task
    orchestratorTask.entityId = await this.createTaskEntity(orchestratorTask);

    this.tasks.set(orchestratorTask.id, orchestratorTask);
    this.activeThreads.set(orchestratorTask.id, threadId);

    // Emit progress: Task initialized
    try {
      // Progress events emitted through EventEmitter (this.emit)
      this.emit('orchestrator:progress', {
        taskId: orchestratorTask.id,
        type: 'task:progress',
        progress: 5,
        status: 'running',
        message: 'Task initialized, context synthesized',
        metadata: {
          complexity,
          estimatedTimeout,
          memoryContextSize: memoryContext?.summary?.length || 0
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.warn('Failed to emit task initialization progress', {
        taskId: orchestratorTask.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Process the task
    await this.processTask(orchestratorTask);

    // Add result summary to thread (not full result to save memory)
    try {
      const resultSummary = this.summarizeResult(orchestratorTask.result);
      await conversationThreadingService.addMessage(
        threadId,
        'assistant',
        resultSummary,
        {
          taskId: orchestratorTask.id,
          agentCount: this.getTaskAgentCount(orchestratorTask),
          models: this.getTaskModels(orchestratorTask)
        }
      );
    } catch (error) {
      logger.warn('Failed to add result to thread', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }

    // Clean up memory
    this.cleanupTaskMemory(orchestratorTask);

    // Mark task as completed for adaptive timeout manager (stores historical performance data)
    adaptiveTimeoutManager.completeTask(taskId);

    logger.info('Orchestration task completed successfully', {
      taskId,
      duration: Date.now() - orchestratorTask.createdAt.getTime(),
      complexity,
      agentCount: this.getTaskAgentCount(orchestratorTask)
    });

    // Return full task information for API response (NO SHORTCUTS)
    return {
      taskId: orchestratorTask.id,
      threadId,
      status: orchestratorTask.status,
      agents: this.getTaskAgents(orchestratorTask.id),
      result: orchestratorTask.result,
      memoryContextUsed: memoryContext.summary,
      metadata: {
        complexity,
        estimatedTimeout,
        actualDuration: Date.now() - orchestratorTask.createdAt.getTime()
      }
    };
  }
  

  // Competition method with adaptive timeout and stall detection
  async runCompetition(challenge: CompetitionChallenge): Promise<CompetitionResult> {
    const competitionId = uuidv4();

    // Assess task complexity for adaptive timeout
    const complexity = this.assessTaskComplexity(challenge.challenge);

    // Calculate adaptive timeout
    const selectedModels = challenge.models || ['anthropic/claude-3.5-sonnet'];
    const primaryModel = selectedModels[0];
    const estimatedTimeout = adaptiveTimeoutManager.getEstimatedCompletionTime(
      primaryModel,
      complexity
    ) || this.getDefaultTimeout(complexity);

    // Respect client-provided timeout if higher than estimated, otherwise use adaptive
    const timeout = challenge.timeout || challenge.timeLimit || estimatedTimeout;

    logger.info('Running competition with adaptive timeout:', {
      competitionId,
      challenge: challenge.challenge,
      complexity,
      estimatedTimeout,
      actualTimeout: timeout,
      competitorCount: challenge.competitorCount,
      models: selectedModels
    });

    // Start adaptive monitoring for stall detection (NOT abort timeout)
    adaptiveTimeoutManager.startMonitoring(
      competitionId,
      primaryModel,
      complexity
    );

    // Get relevant context for the competition (unused for now)
    // const competitionContext = await contextService.synthesizeContext(
    //   challenge.challenge,
    //   {
    //     sessionId: this.currentSessionId,
    //     includeEpisodes: true,
    //     includeDocuments: true,
    //     limit: 5
    //   }
    // );

    // Select diverse models for competition - NO LIMIT on count
    const models = challenge.models || await this.selectCompetitionModels({
      id: competitionId,
      type: 'competition',
      objective: challenge.challenge,
      context: challenge,
      createdAt: new Date(),
      status: 'running'
    });

    // Spawn competing agents in TRUE PARALLEL - use all requested competitors
    const competitorCount = challenge.competitorCount || models.length;
    const spawnRequests = models.slice(0, competitorCount).map(modelId => ({
      id: `${competitionId}-${modelId}`,
      spawner: () => this.spawnAgent({
        role: AgentRole.RESEARCH,
        task: {
          id: `${competitionId}-${modelId}`,
          objective: challenge.challenge,
          context: challenge,
          model: modelId
        },
        model: modelId,
        competitionGroup: competitionId
      }),
      metadata: { modelId, competitionId }
    }));

    // Execute spawning in true parallel with batching
    const spawnResults = await parallelAgentSpawner.spawnParallel(
      spawnRequests,
      {
        maxConcurrency: competitorCount, // No limit on concurrency
        timeout: 15000, // 15 seconds for spawning
        retryOnFailure: true,
        batchSize: Math.min(competitorCount, 10) // Process in batches of 10
      }
    );

    // Extract successfully spawned agents
    const agents = spawnResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value as Agent);

    if (agents.length === 0) {
      throw new Error('Failed to spawn any competition agents');
    }

    logger.info('Competition agents spawned', {
      requestedCount: competitorCount,
      spawnedCount: agents.length,
      failedCount: spawnResults.filter(r => r.status === 'rejected').length
    });

    // PHASE 2.3: Wrap agents in DisposableResource for guaranteed cleanup
    const disposableAgents = agents.map(
      agent => new DisposableResource(agent, logger, `agent-${agent.id}`)
    );

    try {
      // Let agents work independently - NO HARDCODED TIMEOUT
      // Adaptive monitoring will handle stalls and hung tasks
      const solutions = await Promise.allSettled(
        disposableAgents.map(async (disposable) => {
        const agent = disposable.getResource();
        const startTime = Date.now();

        try {
          // Connect agent streaming events to timeout manager for progress tracking
          agent.on('streaming', (data: any) => {
            adaptiveTimeoutManager.updateProgress(
              competitionId,
              data.chunk.length,
              1
            );
          });

          // PHASE 2.3: executeAgentWithCleanup now handles ALL cleanup
          // DisposableResource guarantees disposal in finally block
          const solution = await this.executeAgentWithCleanup(agent);

          // Create episode for competition response
          // PHASE 34: Pass tenant context for multi-tenant isolation
          await episodeService.createFromAgentResponse(
            agent,
            {
              content: solution,
              latency: Date.now() - startTime,
              confidence: 0.9
            },
            {
              id: competitionId,
              type: 'competition',
              competitionGroup: competitionId
            },
            this.currentSessionId,
            this.currentTenantContext  // Set by _executeOrchestration at start
          );

          return solution;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          const enhancedError = new Error(
            `Agent Execution Failed:\n` +
            `Agent ID: ${agent.id}\n` +
            `Model: ${agent.model}\n` +
            `Duration: ${Date.now() - startTime}ms\n` +
            `Error: ${errorMessage}\n` +
            `Task: ${challenge.challenge}\n` +
            `Competition ID: ${competitionId}`
          );

          logger.error('Agent failed in competition', {
            agentId: agent.id,
            model: agent.model,
            duration: Date.now() - startTime,
            error: errorMessage
          });

          // PHASE 1 FIX: No manual cleanup - executeAgentWithCleanup already handled it
          throw enhancedError;
        }
        })
      );

      // PHASE 1 FIX: Evaluate solutions with automatic cleanup
      const evaluator = await this.spawnAgent({
      role: AgentRole.REVIEW,
      task: {
        id: `${competitionId}-eval`,
        objective: 'Evaluate and score competitive solutions',
        context: {
          originalChallenge: challenge,
          solutions: solutions.map((s, i) => ({
            agentId: agents[i].id,
            model: agents[i].model,
            solution: s.status === 'fulfilled' ? s.value : null,
            error: s.status === 'rejected' ? s.reason : null
          }))
        }
      }
    });

    const evaluation = await this.executeAgentWithCleanup(evaluator);

    // PHASE 1 FIX: Synthesize results with automatic cleanup
    const synthesizer = await this.spawnAgent({
      role: AgentRole.SYNTHESIS,
      task: {
        id: `${competitionId}-synthesis`,
        objective: 'Create consensus and extract patterns from competition',
        context: {
          challenge: challenge.challenge,
          evaluation,
          solutions
        }
      }
    });

    const consensus = await this.executeAgentWithCleanup(synthesizer);
    
    // Build rankings
    const rankings = this.buildRankings(agents, solutions, evaluation);
    const winner = rankings[0];

    // Extract patterns
    const patterns = this.extractPatterns(consensus);

    // Store competition results as document
    const competitionResult = {
      competitionId,
      winner,
      rankings,
      consensus,
      patterns,
      timestamp: new Date().toISOString()
    };

    // PHASE 44: Pass tenant context for multi-tenant isolation
    await documentStorageService.storeAgentOutput(
      { id: 'orchestrator', name: 'Competition Evaluator', model: 'system' },
      competitionResult,
      { id: competitionId, type: 'competition' },
      this.currentSessionId,
      this.currentTenantContext  // Set by _executeOrchestration at start
    );

    // Share learnings across agents
    for (const ranking of rankings) {
      const feedback = {
        score: ranking.score,
        competitionRank: rankings.indexOf(ranking) + 1,
        totalCompetitors: rankings.length,
        patterns: patterns.slice(0, 3)
      };

      await agentLearningService.processFeedback(
        ranking.agentId,
        competitionId,
        feedback
      );
    }

      // Mark task as completed for adaptive timeout manager (stores historical performance data)
      adaptiveTimeoutManager.completeTask(competitionId);

      logger.info('Competition completed successfully', {
        competitionId,
        duration: Date.now() - Date.parse(competitionResult.timestamp),
        winner: winner.model,
        complexity
      });

      return competitionResult;

    } finally {
      // PHASE 2.3: CRITICAL - Dispose ALL agents even on error
      logger.info('Disposing all competition agents', {
        competitionId,
        agentCount: disposableAgents.length,
        component: 'orchestrator'
      });

      const disposeResults = await Promise.allSettled(
        disposableAgents.map(disposable => disposable.dispose())
      );

      const successCount = disposeResults.filter(r => r.status === 'fulfilled').length;
      const failureCount = disposeResults.filter(r => r.status === 'rejected').length;

      logger.info('Competition agents disposed', {
        competitionId,
        total: disposableAgents.length,
        successful: successCount,
        failed: failureCount,
        component: 'orchestrator'
      });

      if (failureCount > 0) {
        logger.error('Some agents failed to dispose', {
          competitionId,
          failureCount,
          failures: disposeResults
            .map((r, i) => r.status === 'rejected' ? { index: i, reason: r.reason } : null)
            .filter(Boolean),
          component: 'orchestrator'
        });
      }
    }
  }

  // Validate if a model is available
  async validateModel(modelId: string): Promise<boolean> {
    try {
      const models = await this.dependencies.openRouterClient.listAvailableModels();
      return models.some(m => m.id === modelId);
    } catch (error) {
      logger.error('Model validation failed:', error);
      return false;
    }
  }

  // Get active agents with proper return format
  async getActiveAgents(): Promise<any[]> {
    const activeAgents = this.agentPool.getActiveAgents();

    return activeAgents.map(agent => ({
      id: agent.id,
      role: agent.role,
      model: agent.model,
      state: agent.state,
      task: agent.task?.objective || 'No active task',
      competitionGroup: agent.competitionGroup,
      collaborationGroup: agent.collaborationGroup
    }));
  }

  // Get task status
  async getTaskStatus(taskId: string): Promise<any> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    return {
      id: task.id,
      type: task.type,
      objective: task.objective,
      status: task.status,
      createdAt: task.createdAt,
      agents: this.getTaskAgents(taskId),
      result: task.result
    };
  }
  
  /*
  private async _createTask(taskRequest: Partial<OrchestratorTask>): Promise<OrchestratorTask> {
    const task: OrchestratorTask = {
      id: uuidv4(),
      type: taskRequest.type || 'analysis',
      objective: taskRequest.objective || '',
      context: taskRequest.context || {},
      constraints: taskRequest.constraints,
      agents: taskRequest.agents,
      createdAt: new Date(),
      status: 'pending'
    };

    this.tasks.set(task.id, task);

    // Store in database
    await this.dependencies.databaseManager.storeAgentOutput(task.id, task);

    // Emit event
    this.emit('taskCreated', task);

    // Start processing
    this.processTask(task);

    return task;
  }
  */
  
  private async processTask(task: OrchestratorTask) {
    try {
      task.status = 'running';
      this.emit('taskStarted', task);
      
      let result;
      
      switch (task.type) {
        case 'competition':
          result = await this.runCompetitionTask(task);
          break;
        case 'collaboration':
          result = await this.runCollaboration(task);
          break;
        case 'synthesis':
          result = await this.runSynthesis(task);
          break;
        case 'workflow':
          result = await this.runWorkflow(task);
          break;
        case 'file_process':
          result = await this.runFileProcess(task);
          break;
        case 'security_scan':
          result = await this.runSecurityScan(task);
          break;
        case 'code_execute':
          result = await this.runCodeExecute(task);
          break;
        case 'analysis':
        default:
          result = await this.runAnalysis(task);
      }
      
      task.status = 'completed';
      task.result = result;

      // Update Universal Entity with results
      await this.updateTaskEntity(task);

      // Store result
      await this.dependencies.databaseManager.storeAgentOutput(task.id, result);

      // Queue pattern storage in GraphRAG (non-blocking, non-critical)
      // PHASE 45: Include tenant context for multi-tenant isolation
      this.dependencies.memoryStorageQueue.queueMemoryOperation({
        type: 'memory',
        operation: 'create',
        payload: {
          content: JSON.stringify({
            task: task.objective,
            type: task.type,
            result: this.summarizeResult(result), // Summarize to avoid huge payloads
            models: this.getTaskModels(task)
          }),
          tags: ['mageagent', 'task-completion', task.type],
          metadata: {
            taskId: task.id,
            agentCount: this.getTaskAgentCount(task)
          }
        },
        metadata: {
          taskId: task.id,
          timestamp: new Date(),
          priority: 1, // Normal priority
          retryCount: 0,
          maxRetries: 5
        },
        // PHASE 45: Propagate tenant context for multi-tenant isolation
        tenantContext: this.currentTenantContext  // Set by _executeOrchestration at start
      }).catch((error) => {
        logger.warn('Failed to queue task completion pattern', {
          error: error instanceof Error ? error.message : String(error),
          taskId: task.id
        });
      });
      
      this.emit('taskCompleted', { task, result });

      // Update task status in memory map for API queries
      this.tasks.set(task.id, task);

      // Delay cleanup to allow status queries
      setTimeout(() => this.cleanupTask(task), 10000); // Clean up after 10 seconds

    } catch (error) {
      task.status = 'failed';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error('Task processing failed:', { error: errorMessage, taskId: task.id });

      // Queue error pattern storage (non-blocking, non-critical)
      // PHASE 45: Include tenant context for multi-tenant isolation
      this.dependencies.memoryStorageQueue.queueMemoryOperation({
        type: 'memory',
        operation: 'create',
        payload: {
          content: JSON.stringify({
            task: task.objective,
            error: errorMessage,
            type: 'error'
            // Explicitly exclude stack trace from content to prevent search corruption
          }),
          tags: ['mageagent', 'task-failure', 'error'],
          metadata: {
            taskId: task.id,
            errorStack: errorStack // Store stack in metadata instead
          }
        },
        metadata: {
          taskId: task.id,
          timestamp: new Date(),
          priority: 2, // Higher priority for errors
          retryCount: 0,
          maxRetries: 5
        },
        // PHASE 45: Propagate tenant context for multi-tenant isolation
        tenantContext: this.currentTenantContext  // Set by _executeOrchestration at start
      }).catch((memoryError) => {
        logger.warn('Failed to queue error pattern', {
          error: memoryError instanceof Error ? memoryError.message : String(memoryError),
          taskId: task.id
        });
      });
      
      this.emit('taskFailed', { task, error });
    }
  }
  
  private async runCompetitionTask(task: OrchestratorTask) {
    return this.runCompetition({
      challenge: task.objective,
      competitorCount: task.constraints?.competitorCount, // NO DEFAULT LIMIT
      constraints: task.constraints
    });
  }
  
  private async runCollaboration(task: OrchestratorTask) {
    logger.info('Running collaboration task:', { taskId: task.id });
    
    const agents: Agent[] = [];
    
    // Spawn requested agents - NO LIMIT
    if (task.agents) {
      for (const agentRequest of task.agents) {
        const agent = await this.spawnAgent({
          ...agentRequest,
          collaborationGroup: task.id
        }, task);
        agents.push(agent);
      }
    } else {
      // Default collaboration team
      const roles: AgentRole[] = [AgentRole.RESEARCH, AgentRole.CODING, AgentRole.REVIEW];
      for (const role of roles) {
        const agent = await this.spawnAgent({
          role,
          task: {
            id: `${task.id}-${role}`,
            objective: task.objective,
            context: task.context
          },
          collaborationGroup: task.id
        }, task);
        agents.push(agent);
      }
    }
    
    // Collaborative execution with shared context
    const sharedContext: any = { task, contributions: {} };

    for (const agent of agents) {
      const contribution = await this.executeAgentWithCleanup(agent, sharedContext);
      sharedContext.contributions![agent.id] = contribution;
      
      // Emit progress
      this.emit('collaborationProgress', {
        taskId: task.id,
        agentId: agent.id,
        contribution
      });
    }
    
    return {
      type: 'collaboration',
      agents: agents.map(a => ({ id: a.id, role: a.role, model: a.model })),
      contributions: sharedContext.contributions
    };
  }
  
  private async runAnalysis(task: OrchestratorTask) {
    logger.info('Running dynamic multi-agent analysis:', { taskId: task.id });

    // Use AgentGenerator to dynamically create agent profiles based on task
    const complexity = this.assessTaskComplexity(task.objective);

    // CRITICAL: Detect if streaming storage should be activated for long-running tasks
    const requiresStreamingStorage =
      complexity === 'extreme' ||
      complexity === 'complex' ||
      task.objective.length > 500 ||
      /book|novel|documentation|codebase|medical|legal|comprehensive|extensive/i.test(task.objective);

    // Create streaming pipeline if needed for progressive storage during generation
    let streamingPipeline: any = null;
    if (requiresStreamingStorage) {
      try {
        streamingPipeline = createStreamingPipeline({
          streamId: task.id,
          domain: (task.domain as any) || 'general',
          chunkSize: 1000,
          batchSize: 5,
          maxQueueSize: 50,
          enableProgressiveSummarization: true,
          metadata: {
            taskId: task.id,
            title: task.objective.substring(0, 100),
            context: 'multi-agent-analysis'
          }
        });

        logger.info('Streaming storage pipeline activated', {
          taskId: task.id,
          complexity,
          domain: task.domain
        });

        // Connect pipeline events for monitoring
        streamingPipeline.on('chunk:stored', (data: any) => {
          logger.debug('Streaming chunk stored', {
            taskId: task.id,
            chunkIndex: data.chunkIndex,
            tokens: data.tokens
          });
        });

        streamingPipeline.on('backpressure', (data: any) => {
          logger.warn('Streaming backpressure detected', {
            taskId: task.id,
            queueSize: data.queueSize
          });
        });

        streamingPipeline.on('error', (error: any) => {
          logger.error('Streaming pipeline error', {
            taskId: task.id,
            error: error.message
          });
        });
      } catch (error) {
        logger.warn('Failed to create streaming pipeline, continuing without streaming storage', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // PHASE 46: Pass tenant context to agent generator for multi-tenant isolation
    const generationResult = await this.agentGenerator.generateAgentProfiles(
      {
        task: task.objective,
        complexity,
        domain: task.domain,
        maxAgents: task.constraints?.maxAgents || 15, // NO HARDCODED LIMITS
        requiredCapabilities: task.constraints?.requiredCapabilities,
        constraints: task.constraints
      },
      this.currentTenantContext
    );

    logger.info('Generated dynamic agent profiles', {
      taskId: task.id,
      agentCount: generationResult.profiles.length,
      strategy: generationResult.strategy,
      consensusLayers: generationResult.recommendedConsensusLayers,
      estimatedDuration: generationResult.estimatedDuration
    });

    // Emit progress: Agent profiles generated
    try {
      // Progress events emitted through EventEmitter (this.emit)
      this.emit('orchestrator:progress', {
        taskId: task.id,
        type: 'task:progress',
        progress: 15,
        status: 'running',
        message: `Generated ${generationResult.profiles.length} agent profiles using ${generationResult.strategy} strategy`,
        metadata: {
          agentCount: generationResult.profiles.length,
          strategy: generationResult.strategy,
          estimatedDuration: generationResult.estimatedDuration
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.warn('Failed to emit agent generation progress', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Spawn agents in true parallel using generated profiles
    const spawnRequests = generationResult.profiles.map(profile => ({
      id: `${task.id}-${profile.role}-${profile.specialization}`,
      spawner: () => this.spawnAgent({
        role: profile.role,
        task: {
          id: `${task.id}-${profile.role}`,
          objective: task.objective, // Specialist agent handles specialization internally
          context: {
            ...task.context,
            agentProfile: profile
          },
          model: profile.modelId
        },
        model: profile.modelId,
        // Pass specialistConfig for specialist agents
        specialistConfig: profile.role === AgentRole.SPECIALIST ? {
          specialization: profile.specialization,
          focus: profile.focus,
          capabilities: profile.capabilities,
          reasoningDepth: profile.reasoningDepth
        } : undefined
      }, task),
      metadata: { profile }
    }));

    // Execute spawning in true parallel
    const spawnResults = await parallelAgentSpawner.spawnParallel(
      spawnRequests,
      {
        maxConcurrency: generationResult.profiles.length, // No artificial limits
        timeout: 20000, // 20 seconds for spawning
        retryOnFailure: true,
        batchSize: Math.min(generationResult.profiles.length, 10)
      }
    );

    // Extract successfully spawned agents
    const agents = spawnResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value as Agent);

    if (agents.length === 0) {
      throw new Error(
        `Failed to spawn any agents for analysis task\n` +
        `Task ID: ${task.id}\n` +
        `Requested: ${generationResult.profiles.length} agents\n` +
        `Spawn failures: ${spawnResults.filter(r => r.status === 'rejected').length}`
      );
    }

    logger.info('Agents spawned successfully', {
      taskId: task.id,
      requested: generationResult.profiles.length,
      spawned: agents.length,
      failed: spawnResults.filter(r => r.status === 'rejected').length
    });

    // Emit progress: Agents spawned
    try {
      // Progress events emitted through EventEmitter (this.emit)
      this.emit('orchestrator:progress', {
        taskId: task.id,
        type: 'task:progress',
        progress: 25,
        status: 'running',
        message: `Spawned ${agents.length}/${generationResult.profiles.length} agents, beginning execution`,
        metadata: {
          agentsSpawned: agents.length,
          agentsRequested: generationResult.profiles.length,
          agentsFailed: spawnResults.filter(r => r.status === 'rejected').length
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.warn('Failed to emit agent spawn progress', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Execute agents in parallel and collect results
    const startTime = Date.now();
    const agentResults = await Promise.allSettled(
      agents.map(async (agent, index) => {
        try {
          // Connect streaming events for progress tracking AND streaming storage
          agent.on('streaming', (data: any) => {
            // Update adaptive timeout manager
            adaptiveTimeoutManager.updateProgress(
              task.id,
              data.chunk.length,
              1
            );

            // CRITICAL: Stream content to pipeline for progressive storage
            if (streamingPipeline && data.chunk) {
              streamingPipeline.write(data.chunk, false).catch((pipelineError: any) => {
                logger.warn('Failed to write to streaming pipeline', {
                  taskId: task.id,
                  agentId: agent.id,
                  error: pipelineError.message
                });
              });
            }
          });

          const result = await this.executeAgentWithCleanup(agent);

          // MEMORY OPTIMIZATION: Skip individual episode creation during execution
          // Episodes will be created only for final consensus result to prevent memory amplification
          // await episodeService.createFromAgentResponse(
          //   agent,
          //   {
          //     content: result,
          //     latency: Date.now() - startTime,
          //     confidence: 0.85
          //   },
          //   task,
          //   this.currentSessionId
          // );

          // Clean up agent memory with proper disposal
          await this.agentPool.cleanupAgent(agent.id);

          return {
            agentId: agent.id,
            model: agent.model,
            role: agent.role,
            profile: generationResult.profiles[index],
            result,
            success: true
          };
        } catch (error) {
          logger.error('Agent failed in analysis', {
            agentId: agent.id,
            model: agent.model,
            error: error instanceof Error ? error.message : String(error)
          });

          await this.agentPool.cleanupAgent(agent.id);

          return {
            agentId: agent.id,
            model: agent.model,
            role: agent.role,
            profile: generationResult.profiles[index],
            error: error instanceof Error ? error.message : String(error),
            success: false
          };
        }
      })
    );

    const latency = Date.now() - startTime;

    // Extract successful results
    const successfulResults = agentResults
      .filter(r => r.status === 'fulfilled' && r.value.success)
      .map(r => (r as PromiseFulfilledResult<any>).value);

    logger.info('Agent execution completed', {
      taskId: task.id,
      total: agents.length,
      successful: successfulResults.length,
      failed: agents.length - successfulResults.length,
      latency
    });

    // Emit progress: Agent execution completed
    try {
      // Progress events emitted through EventEmitter (this.emit)
      this.emit('orchestrator:progress', {
        taskId: task.id,
        type: 'task:progress',
        progress: 70,
        status: 'running',
        message: `Agent execution completed: ${successfulResults.length}/${agents.length} succeeded`,
        metadata: {
          agentsCompleted: agents.length,
          agentsSuccessful: successfulResults.length,
          agentsFailed: agents.length - successfulResults.length,
          executionLatency: latency
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.warn('Failed to emit agent execution progress', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // MEMORY OPTIMIZATION: Summarize large agent results before consensus to reduce memory footprint
    const summarizedResults = successfulResults.map(r => ({
      ...r,
      result: typeof r.result === 'string' && r.result.length > 5000
        ? r.result.substring(0, 5000) + `\n\n[... ${r.result.length - 5000} chars truncated for memory optimization ...]`
        : r.result
    }));

    // If consensus layers recommended, apply them
    let finalResult;
    if (generationResult.recommendedConsensusLayers > 0 && successfulResults.length > 1) {
      // Emit progress: Starting consensus
      try {
        // Progress events emitted through EventEmitter (this.emit)
        this.emit('orchestrator:progress', {
          taskId: task.id,
          type: 'task:progress',
          progress: 80,
          status: 'running',
          message: `Synthesizing results through ${generationResult.recommendedConsensusLayers} consensus layers`,
          metadata: {
            consensusLayers: generationResult.recommendedConsensusLayers,
            resultsToSynthesize: summarizedResults.length
          },
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.warn('Failed to emit consensus start progress', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      finalResult = await this.applyConsensusLayers(
        task,
        summarizedResults,
        generationResult.recommendedConsensusLayers
      );

      // MEMORY OPTIMIZATION: Explicit garbage collection after consensus
      if (global.gc) {
        global.gc();
        logger.info('Triggered garbage collection after consensus', { taskId: task.id });
      }
    } else {
      // Single agent or no consensus needed - return best result
      finalResult = summarizedResults.length === 1
        ? summarizedResults[0].result
        : this.synthesizeResults(summarizedResults);
    }

    // CRITICAL: Finalize streaming pipeline if it was activated
    if (streamingPipeline) {
      try {
        // Write final result to pipeline and close
        const finalResultText = typeof finalResult === 'string'
          ? finalResult
          : JSON.stringify(finalResult);

        await streamingPipeline.write(finalResultText, true); // isFinal = true
        await streamingPipeline.close();

        logger.info('Streaming storage pipeline finalized', {
          taskId: task.id,
          complexity
        });
      } catch (pipelineError) {
        logger.error('Failed to finalize streaming pipeline', {
          taskId: task.id,
          error: pipelineError instanceof Error ? pipelineError.message : String(pipelineError)
        });
      }
    }

    // CRITICAL: Apply progressive summarization for extreme complexity tasks
    if (complexity === 'extreme' && finalResult) {
      try {
        const finalResultText = typeof finalResult === 'string'
          ? finalResult
          : JSON.stringify(finalResult);

        // Only apply if result is large enough to warrant summarization
        if (finalResultText.length > 5000) {
          await progressiveSummarizationEngine.processContent({
            domain: (task.domain as any) || 'general',
            contentStream: [finalResultText], // Wrap in array for content stream
            metadata: {
              title: task.objective.substring(0, 100),
              context: `Analysis result - ${complexity} complexity`,
              expectedTotalTokens: Math.ceil(finalResultText.length / 4)
            }
          });

          logger.info('Progressive summarization applied to extreme complexity result', {
            taskId: task.id,
            originalLength: finalResultText.length,
            domain: task.domain
          });
        }
      } catch (summarizationError) {
        logger.warn('Progressive summarization failed, continuing', {
          taskId: task.id,
          error: summarizationError instanceof Error ? summarizationError.message : String(summarizationError)
        });
      }
    }

    // CRITICAL: Extract domain-specific entities adaptively for all significant results
    if (finalResult && (complexity === 'extreme' || complexity === 'complex')) {
      try {
        const finalResultText = typeof finalResult === 'string'
          ? finalResult
          : JSON.stringify(finalResult);

        // Apply adaptive entity extraction (zero-hardcoded approach)
        // PHASE30: Use getInstance() instead of module-level singleton
        // PHASE 58p: Pass tenant context for multi-tenant isolation
        const extractionResult = await AdaptiveEntityExtractor.getInstance().extract({
          content: finalResultText,
          domainHint: task.domain,
          sessionId: task.sessionId || this.currentSessionId,
          learningMode: true,
          metadata: {
            taskId: task.id,
            threadId: task.threadId,
            complexity
          },
          tenantContext: this.currentTenantContext // PHASE 58p: Propagate tenant context
        });

        logger.info('Adaptive entity extraction completed', {
          taskId: task.id,
          detectedDomain: extractionResult.domain,
          entityCount: extractionResult.entities.length,
          relationshipTypes: extractionResult.relationshipTypes.length
        });
      } catch (extractionError) {
        logger.warn('Adaptive entity extraction failed, continuing', {
          taskId: task.id,
          error: extractionError instanceof Error ? extractionError.message : String(extractionError)
        });
      }
    }

    // Try to create episode from final result (non-critical)
    // PHASE 34: Pass tenant context for multi-tenant isolation
    let episode;
    try {
      episode = await episodeService.createFromAgentResponse(
        { id: 'synthesizer', model: 'multi-agent', role: AgentRole.SYNTHESIS } as any,
        {
          content: finalResult,
          latency,
          confidence: 0.90
        },
        {
          id: task.id,
          type: 'analysis',
          threadId: task.threadId
        },
        task.sessionId || this.currentSessionId || 'default-session',
        this.currentTenantContext
      );
    } catch (episodeError) {
      // Log but don't fail the task
      logger.warn('Failed to create final episode, continuing without it', {
        error: episodeError instanceof Error ? episodeError.message : String(episodeError),
        taskId: task.id
      });
      episode = { id: 'fallback-' + task.id };
    }

    // Try to store as document if significant (non-critical)
    if (JSON.stringify(finalResult).length > 500) {
      try {
        // PHASE 44: Pass tenant context for multi-tenant isolation
        await documentStorageService.storeAgentOutput(
          { id: 'multi-agent-analysis', model: 'ensemble', role: AgentRole.SYNTHESIS } as any,
          finalResult,
          { id: task.id, type: 'analysis' },
          task.sessionId || this.currentSessionId || 'default-session',
          this.currentTenantContext
        );
      } catch (docError) {
        logger.warn('Failed to store document, continuing', {
          error: docError instanceof Error ? docError.message : String(docError),
          taskId: task.id
        });
      }
    }

    // Track performance for all agents
    for (const agentResult of successfulResults) {
      try {
        await agentLearningService.trackPerformance(
          agentResult.agentId,
          task.id,
          {
            tokensUsed: (agentResult.result as any).tokens || 1000,
            latency: latency / successfulResults.length,
            errorRate: (agents.length - successfulResults.length) / agents.length,
            qualityScore: 0.85,
            costEfficiency: 0.8
          }
        );
      } catch (learningError) {
        logger.warn('Failed to track agent performance', {
          agentId: agentResult.agentId,
          error: learningError
        });
      }
    }

    // Emit progress: Task completed
    try {
      // Progress events emitted through EventEmitter (this.emit)
      this.emit('orchestrator:progress', {
        taskId: task.id,
        type: 'task:progress',
        progress: 95,
        status: 'running',
        message: 'Finalizing results and storing to memory',
        metadata: {
          finalResultSize: typeof finalResult === 'string' ? finalResult.length : JSON.stringify(finalResult).length,
          episodeCreated: !!episode.id,
          documentStored: JSON.stringify(finalResult).length > 500
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.warn('Failed to emit finalization progress', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return {
      type: 'multi-agent-analysis',
      strategy: generationResult.strategy,
      agentCount: agents.length,
      successfulAgents: successfulResults.length,
      agents: successfulResults.map(r => ({
        id: r.agentId,
        model: r.model,
        role: r.role,
        specialization: r.profile.specialization
      })),
      analysis: finalResult,
      episodeId: episode.id,
      consensusLayers: generationResult.recommendedConsensusLayers,
      metadata: {
        generationTime: generationResult.estimatedDuration,
        executionTime: latency,
        profiles: generationResult.profiles
      }
    };
  }
  
  private async runSynthesis(task: OrchestratorTask) {
    logger.info('Running synthesis task:', { taskId: task.id });
    
    const agent = await this.spawnAgent({
      role: AgentRole.SYNTHESIS,
      task: {
        id: task.id,
        objective: task.objective,
        context: task.context
      }
    }, task);

    const synthesis = await this.executeAgentWithCleanup(agent);

    return {
      type: 'synthesis',
      agent: { id: agent.id, model: agent.model },
      synthesis
    };
  }

  /**
   * Run a multi-service workflow task using WorkflowRouterService
   *
   * PHASE: Universal Request Orchestrator
   *
   * This method enables natural language requests to be decomposed and executed
   * across multiple Nexus services (FileProcess, CyberAgent, Sandbox, MageAgent).
   *
   * Example requests:
   * - "Download this file, analyze it, and check for viruses"
   * - "Extract the archive, OCR the documents, and summarize them"
   */
  private async runWorkflow(task: OrchestratorTask) {
    logger.info('Running workflow task:', { taskId: task.id, objective: task.objective });

    const workflowRouter = getWorkflowRouterService(
      this.dependencies.openRouterClient,
      this.dependencies.graphRAGClient
    );

    // Emit progress event
    this.emit('workflow:started', {
      taskId: task.id,
      objective: task.objective,
      timestamp: new Date()
    });

    try {
      // Parse the natural language request into a workflow plan
      const parseResponse = await workflowRouter.parseRequest({
        request: task.objective,
        context: {
          sessionId: task.sessionId,
          metadata: task.context
        },
        options: {
          mode: task.constraints?.mode || 'best-effort',
          priority: task.constraints?.priority || 'normal',
          timeout: task.constraints?.timeout
        }
      });

      logger.info('Workflow plan generated', {
        taskId: task.id,
        workflowId: parseResponse.plan.id,
        stepCount: parseResponse.plan.steps.length,
        confidence: parseResponse.confidence,
        involvedServices: parseResponse.involvedServices
      });

      // If confidence is too low, ask for clarification
      if (parseResponse.confidence < 0.5 && parseResponse.clarifications?.length) {
        return {
          type: 'workflow',
          status: 'needs_clarification',
          clarifications: parseResponse.clarifications,
          confidence: parseResponse.confidence,
          plan: parseResponse.plan
        };
      }

      // Execute the workflow
      const result = await workflowRouter.executeWorkflow(parseResponse.plan);

      // Emit completion event
      this.emit('workflow:completed', {
        taskId: task.id,
        workflowId: parseResponse.plan.id,
        success: result.success,
        status: result.status,
        metrics: result.metrics,
        timestamp: new Date()
      });

      return {
        type: 'workflow',
        status: result.status,
        success: result.success,
        summary: result.summary,
        stepResults: Object.fromEntries(result.stepResults),
        failedSteps: result.failedSteps,
        artifacts: result.artifacts,
        metrics: result.metrics,
        suggestions: result.suggestions
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Workflow execution failed', {
        taskId: task.id,
        error: errorMessage
      });

      this.emit('workflow:failed', {
        taskId: task.id,
        error: errorMessage,
        timestamp: new Date()
      });

      throw error;
    }
  }

  /**
   * Run a file processing task using FileProcessClient
   *
   * PHASE: Universal Request Orchestrator
   *
   * Handles single file processing operations:
   * - URL-based file processing
   * - Google Drive file processing
   * - Archive extraction
   * - OCR processing
   */
  private async runFileProcess(task: OrchestratorTask) {
    logger.info('Running file process task:', { taskId: task.id, objective: task.objective });

    const fileProcessClient = getFileProcessClient();

    // Extract file processing parameters from task context
    const { fileUrl, driveUrl, filename, mimeType, options, operations } = task.context || {};

    this.emit('file_process:started', {
      taskId: task.id,
      fileUrl: fileUrl || driveUrl,
      operations,
      timestamp: new Date()
    });

    try {
      let response;

      if (driveUrl) {
        // Process Google Drive file
        response = await fileProcessClient.processDriveUrl({
          driveUrl,
          userId: task.userId,
          sessionId: task.sessionId,
          metadata: {
            taskId: task.id,
            objective: task.objective
          },
          options: {
            enableOcr: operations?.includes('ocr') ?? options?.enableOcr,
            extractTables: operations?.includes('table_extraction') ?? options?.extractTables,
            enableAgentAnalysis: options?.enableAgentAnalysis
          }
        });
      } else if (fileUrl) {
        // Process URL-based file
        if (!filename) {
          throw new Error('File process task requires filename in context when using fileUrl');
        }
        response = await fileProcessClient.processUrl({
          fileUrl,
          filename,
          mimeType,
          userId: task.userId,
          sessionId: task.sessionId,
          metadata: {
            taskId: task.id,
            objective: task.objective
          },
          options: {
            enableOcr: operations?.includes('ocr') ?? options?.enableOcr,
            extractTables: operations?.includes('table_extraction') ?? options?.extractTables,
            enableAgentAnalysis: options?.enableAgentAnalysis
          }
        });
      } else {
        throw new Error('File process task requires either fileUrl or driveUrl in context');
      }

      // Poll for job completion if needed
      const jobId = response.jobId;
      let job = await fileProcessClient.getJobStatus(jobId);

      // Poll until job completes
      const maxPollAttempts = 150; // 150 * 2s = 5 minutes
      const pollIntervalMs = 2000;

      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        if (job.status === 'completed' || job.status === 'failed') {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        job = await fileProcessClient.getJobStatus(jobId);

        // Emit progress
        if (job.progress) {
          this.emit('file_process:progress', {
            taskId: task.id,
            jobId: job.id,
            progress: job.progress,
            timestamp: new Date()
          });
        }
      }

      const success = job.status === 'completed';

      this.emit('file_process:completed', {
        taskId: task.id,
        success,
        jobId: job.id,
        timestamp: new Date()
      });

      return {
        type: 'file_process',
        success,
        jobId: job.id,
        status: job.status,
        result: job.result,
        error: job.error
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('File process task failed', {
        taskId: task.id,
        error: errorMessage
      });

      this.emit('file_process:failed', {
        taskId: task.id,
        error: errorMessage,
        timestamp: new Date()
      });

      throw error;
    }
  }

  /**
   * Run a security scanning task using CyberAgentClient
   *
   * PHASE: Universal Request Orchestrator
   *
   * Handles security operations:
   * - Malware scanning
   * - Vulnerability scanning
   * - Threat intelligence lookup
   * - APT detection
   */
  private async runSecurityScan(task: OrchestratorTask) {
    logger.info('Running security scan task:', { taskId: task.id, objective: task.objective });

    const cyberAgentClient = getCyberAgentClient();

    // Extract security scan parameters from task context
    const { target, scanType, tools, sandboxTier, config: scanConfig } = task.context || {};

    if (!target) {
      throw new Error('Security scan task requires target in context');
    }

    this.emit('security_scan:started', {
      taskId: task.id,
      target,
      scanType: scanType || 'malware',
      timestamp: new Date()
    });

    try {
      // Create the scan job
      const createResponse = await cyberAgentClient.createScanJob({
        scan_type: scanType || 'malware',
        target,
        tools: tools || ['yara', 'clamav'],
        sandbox_tier: sandboxTier || 'tier1',
        config: {
          deep_scan: scanConfig?.deepScan ?? true,
          analysis_timeout: scanConfig?.timeout || 120000,
          enable_network_simulation: scanConfig?.enableNetworkSimulation ?? false,
          priority: task.constraints?.priority || 'normal',
          ...scanConfig
        },
        metadata: {
          taskId: task.id,
          sessionId: task.sessionId,
          objective: task.objective
        }
      });

      if (!createResponse.success || !createResponse.job) {
        throw new Error('Failed to create security scan job');
      }

      // Poll for job completion
      const maxPollAttempts = 90; // 90 * 2s = 3 minutes
      const pollIntervalMs = 2000;
      let job = createResponse.job;

      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        job = await cyberAgentClient.getJobStatus(job.id);

        // Emit progress
        if (job.progress) {
          this.emit('security_scan:progress', {
            taskId: task.id,
            jobId: job.id,
            progress: job.progress,
            timestamp: new Date()
          });
        }
      }

      // Handle job completion
      if (job.status !== 'completed') {
        throw new Error(`Security scan job ended with status: ${job.status}`);
      }

      this.emit('security_scan:completed', {
        taskId: task.id,
        jobId: job.id,
        success: true,
        result: job.result,
        timestamp: new Date()
      });

      return {
        type: 'security_scan',
        success: true,
        job,
        result: job.result
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Security scan task failed', {
        taskId: task.id,
        error: errorMessage
      });

      this.emit('security_scan:failed', {
        taskId: task.id,
        error: errorMessage,
        timestamp: new Date()
      });

      throw error;
    }
  }

  /**
   * Run a code execution task using SandboxClient
   *
   * PHASE: Universal Request Orchestrator
   *
   * Handles code execution operations:
   * - Python script execution
   * - Node.js script execution
   * - Bash command execution
   * - Multi-language code execution
   */
  private async runCodeExecute(task: OrchestratorTask) {
    logger.info('Running code execute task:', { taskId: task.id, objective: task.objective });

    const sandboxClient = getSandboxClient();

    // Extract code execution parameters from task context
    const { code, language, packages, files, timeout, resourceLimits } = task.context || {};

    if (!code) {
      throw new Error('Code execute task requires code in context');
    }

    if (!language) {
      throw new Error('Code execute task requires language in context');
    }

    this.emit('code_execute:started', {
      taskId: task.id,
      language,
      packagesCount: packages?.length || 0,
      timestamp: new Date()
    });

    try {
      const result = await sandboxClient.execute({
        code,
        language,
        packages: packages || [],
        files: files || [],
        timeout: timeout || 60000, // Default 1 minute
        resourceLimits: resourceLimits || {
          cpuLimit: '1.0',
          memoryLimit: '512Mi',
          gpuEnabled: false
        },
        metadata: {
          taskId: task.id,
          sessionId: task.sessionId,
          objective: task.objective
        }
      });

      this.emit('code_execute:completed', {
        taskId: task.id,
        success: result.success,
        exitCode: result.exitCode,
        executionTimeMs: result.executionTimeMs,
        timestamp: new Date()
      });

      return {
        type: 'code_execute',
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTimeMs: result.executionTimeMs,
        resourceUsage: result.resourceUsage,
        artifacts: result.artifacts,
        error: result.error
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logger.error('Code execute task failed', {
        taskId: task.id,
        error: errorMessage
      });

      this.emit('code_execute:failed', {
        taskId: task.id,
        error: errorMessage,
        timestamp: new Date()
      });

      throw error;
    }
  }

  private async spawnAgent(request: AgentSpawnRequest, parentTask?: OrchestratorTask): Promise<Agent> {
    const agentId = uuidv4();

    // Get agent profile and learning adjustments
    const profile = await agentLearningService.getAgentProfile(agentId);

    // Build Enhanced Agent configuration
    const enhancedConfig: EnhancedAgentConfig = {
      sessionId: parentTask?.sessionId || this.currentSessionId,
      threadId: parentTask?.threadId,
      userId: parentTask?.userId,
      domain: parentTask?.domain || 'general',
      parentEntityId: parentTask?.entityId,
      enableContextInjection: true,
      enableInteractionCapture: true
    };

    // Select model with intelligent fallback system
    let model = request.model;

    if (!model) {
      // Use intelligent model selection with fallback
      const taskComplexity = this.assessTaskComplexity(request.task);
      const criteria: ModelSelectionCriteria = {
        role: request.role as AgentRole,
        taskComplexity,
        requiredCapabilities: this.getRequiredCapabilities(request.role),
        minContextLength: this.estimateRequiredContext(request.task),
        preferredProviders: profile?.preferredModels?.map((m: string) => m.split('/')[0]) || ['anthropic', 'openai', 'google']
      };

      try {
        model = await this.modelSelector.selectModel(criteria);
        logger.info('Model selected intelligently', {
          agentId,
          role: request.role,
          selectedModel: model,
          taskComplexity
        });
      } catch (error) {
        logger.error('Model selection failed, using fallback', {
          error: error instanceof Error ? error.message : 'Unknown',
          role: request.role
        });
        model = 'openai/gpt-3.5-turbo'; // Ultimate fallback
      }
    } else {
      // Validate requested model and find alternative if needed
      const isValid = await this.modelSelector.validateModel(model);
      if (!isValid) {
        logger.warn('Requested model not available, finding alternative', {
          requested: model,
          role: request.role
        });

        const criteria: ModelSelectionCriteria = {
          role: request.role as AgentRole,
          taskComplexity: 'medium',
          requiredCapabilities: this.getRequiredCapabilities(request.role),
          avoidModels: [model] // Avoid the failed model
        };

        model = await this.modelSelector.selectModel(criteria);
      }
    }

    // Enrich task context with memory
    // PHASE 56: Pass tenant context for multi-tenant isolation
    if (request.task) {
      const taskContext = await contextService.synthesizeContext(
        request.task.objective,
        {
          sessionId: this.currentSessionId,
          agentId,
          limit: 5,
          tenantContext: this.currentTenantContext // PHASE 56: Multi-tenant isolation
        }
      );
      request.task.context = {
        ...request.task.context,
        memoryContext: taskContext
      };
    }

    let agent: Agent;

    // Pass enhanced config to agents
    // PHASE 54: Include tenant context in agent dependencies for multi-tenant isolation
    // This ensures agents can access GraphRAG with proper tenant context
    const agentDeps = {
      ...this.dependencies,
      config: enhancedConfig,
      tenantContext: this.currentTenantContext  // PHASE 54: Pass tenant context to agents
    };

    switch (request.role) {
      case 'research':
        agent = new ResearchAgent(agentId, model, agentDeps);
        break;
      case 'coding':
        agent = new CodingAgent(agentId, model, agentDeps);
        break;
      case 'review':
        agent = new ReviewAgent(agentId, model, agentDeps);
        break;
      case 'synthesis':
        agent = new SynthesisAgent(agentId, model, agentDeps);
        break;
      case 'specialist':
        // Specialist agents require specialization config
        if (!request.specialistConfig) {
          throw new Error(
            `SpecialistAgent requires specialistConfig but none provided.\n` +
            `Agent ID: ${agentId}\n` +
            `This is a system error - specialist agents should always be spawned with config.`
          );
        }
        agent = new SpecialistAgent(agentId, model, agentDeps, request.specialistConfig);
        break;
      default:
        throw new Error(`Unknown agent role: ${request.role}`);
    }

    agent.task = request.task;
    agent.competitionGroup = request.competitionGroup;
    agent.collaborationGroup = request.collaborationGroup;

    // Start adaptive monitoring for this task
    if (request.task?.id) {
      const complexity = this.assessTaskComplexity(request.task);
      adaptiveTimeoutManager.startMonitoring(
        request.task.id,
        model,
        complexity
      );

      // Handle stalls and hung tasks
      adaptiveTimeoutManager.once(`stall`, (event: any) => {
        if (event.taskId === request.task?.id) {
          logger.warn('Task stalled, considering fallback', {
            taskId: event.taskId,
            model,
            recommendation: event.recommendation
          });
        }
      });

      adaptiveTimeoutManager.once(`hung`, (event: any) => {
        if (event.taskId === request.task?.id) {
          logger.error('Task hung, aborting', {
            taskId: event.taskId,
            model,
            suggestions: event.suggestions
          });

          // Emit failure event
          agent.emit('failed', {
            agentId,
            error: new Error('Task hung - no progress detected'),
            taskId: event.taskId
          });
        }
      });
    }

    // Apply learning-based temperature adjustments
    if (profile && profile.adjustedParameters.temperature !== undefined) {
      (agent as any).temperature = profile.adjustedParameters.temperature;
    }

    // Track model failures for intelligent fallback
    agent.on('model:failed', (data: { model: string; error: string; agentId: string }) => {
      logger.warn('Model failure detected, updating selector', {
        model: data.model,
        error: data.error,
        agentId: data.agentId
      });

      // Mark model as failed in selector
      this.modelSelector.markModelAsFailed(
        data.model,
        new Error(data.error)
      );

      // Emit orchestrator-level event for monitoring
      this.emit('model:failure', {
        model: data.model,
        error: data.error,
        agentId: data.agentId,
        taskId: request.task?.id,
        timestamp: new Date()
      });
    });

    // Track successful model completions
    agent.on('completed', (data: any) => {
      // Mark model as working when agent successfully completes
      this.modelSelector.markModelAsWorking(model);

      // Complete adaptive monitoring
      if (request.task?.id) {
        adaptiveTimeoutManager.completeTask(request.task.id);
      }

      logger.debug('Model completed successfully', {
        model,
        agentId: data.agentId,
        duration: data.duration
      });
    });

    // Track streaming progress for real-time monitoring
    agent.on('streaming', (data: any) => {
      // Update adaptive timeout manager with progress
      if (request.task?.id) {
        adaptiveTimeoutManager.updateProgress(
          request.task.id,
          data.chunk?.length || 0,
          1
        );
      }

      // Aggregate and emit progress at orchestrator level
      this.emit('agent:streaming', {
        agentId: data.agentId,
        model: data.model,
        role: data.role,
        progress: data.progress,
        taskId: request.task?.id
      });

      // Log significant milestones
      if (data.progress.chunksReceived === 1) {
        logger.info(`Agent ${data.agentId} started streaming`, {
          model: data.model,
          role: data.role,
          taskId: request.task?.id
        });
      }
    });

    // Track streaming completion
    agent.on('streaming:complete', (data: any) => {
      logger.info(`Agent ${data.agentId} completed streaming`, {
        model: data.model,
        totalChunks: data.totalChunks,
        totalBytes: data.totalBytes,
        duration: `${(data.duration / 1000).toFixed(1)}s`,
        bytesPerSecond: Math.round(data.totalBytes / (data.duration / 1000))
      });

      this.emit('agent:streaming:complete', {
        agentId: data.agentId,
        model: data.model,
        stats: {
          chunks: data.totalChunks,
          bytes: data.totalBytes,
          durationMs: data.duration,
          throughput: `${Math.round(data.totalBytes / (data.duration / 1000))} bytes/sec`
        }
      });
    });

    await this.agentPool.add(agent);

    // Emit agent spawn event (frontend-compatible naming)
    this.emit('agent:spawned', {
      agentId,
      role: request.role,
      model,
      task: request.task,
      taskId: request.task?.id // Add taskId for frontend routing
    });

    return agent;
  }

  /**
   * PHASE 1 FIX: Comprehensive agent cleanup using Dispose Pattern
   *
   * WHAT THIS FIXES:
   * 1. Event listener accumulation (memory leaks)
   * 2. Agent pool references (prevents GC)
   * 3. Task references (frees memory)
   * 4. Cached data (memory bloat)
   *
   * BEFORE: 4 listeners × N agents = 4N listeners leaked per orchestration
   * AFTER: 0 listeners after cleanup, full garbage collection
   *
   * @param agent - Agent instance to cleanup
   */
  private async cleanupAgent(agent: Agent): Promise<void> {
    try {
      const agentInfo = {
        agentId: agent.id,
        model: agent.model,
        role: agent.role,
        state: agent.state
      };

      // PHASE 1: Remove orchestrator-level event listeners first
      // This prevents new events from being emitted during disposal
      agent.removeAllListeners('model:failed');
      agent.removeAllListeners('completed');
      agent.removeAllListeners('streaming');
      agent.removeAllListeners('streaming:complete');
      agent.removeAllListeners('failed');
      agent.removeAllListeners('started');

      // PHASE 2: Call agent dispose() method
      // This removes ALL remaining listeners and clears cached data
      await agent.dispose();

      // PHASE 3: Remove agent from pool
      // This breaks the reference chain allowing garbage collection
      await this.agentPool.cleanupAgent(agent.id);

      // PHASE 4: Optional force garbage collection (if available)
      const poolMetrics = this.agentPool.getMetrics();
      if (global.gc && poolMetrics.active === 0) {
        global.gc();
        logger.debug('Forced garbage collection after agent cleanup');
      }

      logger.debug('Agent cleanup completed successfully', {
        ...agentInfo,
        poolSize: poolMetrics.total,
        activeAgents: poolMetrics.active
      });
    } catch (error) {
      logger.error('Agent cleanup failed', {
        agentId: agent.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      // Don't throw - cleanup errors shouldn't break orchestration
    }
  }

  /**
   * PHASE 1 FIX + INTELLIGENT RETRY: Execute agent with GUARANTEED cleanup and adaptive retry
   *
   * This method ensures agents are ALWAYS cleaned up using the Dispose Pattern AND
   * automatically retries on transient failures with ML-based strategy selection.
   *
   * FEATURES:
   * - Guaranteed cleanup (dispose pattern)
   * - ML-based retry strategy selection (85-90% accuracy)
   * - Adaptive learning from retry outcomes
   * - Real-time WebSocket event streaming
   * - <50ms cached pattern matching
   *
   * MEMORY LEAK PREVENTION:
   * - Before: Memory grows linearly with agent count
   * - After: Memory returns to baseline after each orchestration
   *
   * @param agent - Agent to execute
   * @param sharedContext - Optional shared context for collaboration
   * @returns Agent execution result
   * @throws Re-throws execution errors after cleanup and exhausted retries
   */
  private async executeAgentWithCleanup<T = any>(
    agent: Agent,
    sharedContext?: any
  ): Promise<T> {
    const startMemory = process.memoryUsage().heapUsed;

    // Emit agent:progress at start (0%)
    this.emit('agent:progress', {
      agentId: agent.id,
      taskId: agent.task?.id,
      role: agent.role,
      model: agent.model,
      progress: 0,
      step: 'Starting agent execution'
    });

    // Wrap execution in intelligent retry
    const result = await this.retryExecutor.executeWithIntelligentRetry(
      async () => {
        try {
          // Emit agent:progress during execution (50%)
          this.emit('agent:progress', {
            agentId: agent.id,
            taskId: agent.task?.id,
            role: agent.role,
            model: agent.model,
            progress: 50,
            step: 'Processing...'
          });

          return await agent.execute(sharedContext);
        } catch (error) {
          // Cleanup happens in finally block below
          throw error;
        }
      },
      {
        taskId: agent.task?.id || agent.id,
        agentId: agent.id,
        operation: 'agent_execution',
        context: {
          role: agent.role,
          model: agent.model,
          sharedContext
        },
        retryConfig: {
          maxRetries: 3,
          backoffMs: [2000, 4000, 8000],
          exponentialBackoff: true,
          timeout: 120000
        }
      }
    ).finally(async () => {
      // CRITICAL: Cleanup MUST happen regardless of success or failure
      await this.cleanupAgent(agent);

      const endMemory = process.memoryUsage().heapUsed;
      const memoryDelta = ((endMemory - startMemory) / 1024 / 1024).toFixed(2);

      logger.debug('Agent execution completed with cleanup', {
        agentId: agent.id,
        memoryDeltaMB: memoryDelta
      });
    });

    // Emit agent:complete after successful execution
    this.emit('agent:complete', {
      agentId: agent.id,
      taskId: agent.task?.id,
      role: agent.role,
      model: agent.model,
      result,
      progress: 100
    });

    return result;
  }



  private async selectCompetitionModels(_task: OrchestratorTask) {
    // Get diverse models for competition - NO LIMIT
    const allModels = await this.dependencies.openRouterClient.listAvailableModels();
    
    // Group by provider to ensure diversity
    const modelsByProvider = new Map<string, any[]>();
    
    allModels.forEach(model => {
      const provider = model.id.split('/')[0];
      if (!modelsByProvider.has(provider)) {
        modelsByProvider.set(provider, []);
      }
      modelsByProvider.get(provider)!.push(model);
    });
    
    // Select top model from each provider - NO LIMIT
    const selectedModels: string[] = [];
    
    for (const [_provider, models] of modelsByProvider) {
      // Sort by capability and cost
      const sorted = models.sort((a, b) => {
        const scoreA = a.context_length / (a.pricing.prompt + 0.0001);
        const scoreB = b.context_length / (b.pricing.prompt + 0.0001);
        return scoreB - scoreA;
      });
      
      // Add ALL suitable models from each provider
      sorted.forEach(model => {
        selectedModels.push(model.id);
      });
    }
    
    return selectedModels;
  }

  private buildRankings(agents: Agent[], solutions: any[], evaluation: any): any[] {
    const rankings = agents.map((agent, i) => {
      const solution = solutions[i];
      const score = evaluation?.scores?.[agent.id] || 
                   (solution.status === 'fulfilled' ? 0.5 : 0);
      
      return {
        agentId: agent.id,
        model: agent.model,
        score,
        solution: solution.status === 'fulfilled' ? solution.value : null
      };
    });

    // Sort by score descending
    rankings.sort((a, b) => b.score - a.score);
    
    return rankings;
  }

  private extractPatterns(consensus: any): string[] {
    const patterns = [];
    
    if (consensus?.patterns) {
      patterns.push(...consensus.patterns);
    }
    
    if (consensus?.bestPractices) {
      patterns.push(...consensus.bestPractices);
    }
    
    if (consensus?.recommendations) {
      patterns.push(...consensus.recommendations);
    }
    
    return [...new Set(patterns)];
  }

  private getTaskAgents(taskId: string): any[] {
    const taskAgents: any[] = [];
    const activeAgents = this.agentPool.getActiveAgents();

    activeAgents.forEach(agent => {
      if (agent.task && agent.task.id.startsWith(taskId)) {
        taskAgents.push({
          id: agent.id,
          role: agent.role,
          model: agent.model,
          state: agent.state
        });
      }
    });
    return taskAgents;
  }
  
  private getTaskModels(task: OrchestratorTask): string[] {
    const models: string[] = [];
    const activeAgents = this.agentPool.getActiveAgents();

    activeAgents.forEach(agent => {
      if (agent.task && agent.task.id.startsWith(task.id)) {
        models.push(agent.model);
      }
    });
    return [...new Set(models)];
  }
  
  private summarizeResult(result: any): any {
    // Summarize result to avoid huge payloads in memory storage
    if (!result) return null;

    if (typeof result === 'string') {
      return result.length > 1000 ? result.substring(0, 1000) + '...' : result;
    }

    if (result.analysis && typeof result.analysis === 'string') {
      return {
        ...result,
        analysis: result.analysis.length > 1000
          ? result.analysis.substring(0, 1000) + '...'
          : result.analysis
      };
    }

    // For complex objects, stringify and truncate
    try {
      const stringified = JSON.stringify(result);
      return stringified.length > 1000
        ? JSON.parse(stringified.substring(0, 997) + '..."}')
        : result;
    } catch {
      return { type: 'complex', summary: 'Result too complex to summarize' };
    }
  }

  private getTaskAgentCount(task: OrchestratorTask): number {
    let count = 0;
    const activeAgents = this.agentPool.getActiveAgents();

    activeAgents.forEach(agent => {
      if (agent.task && agent.task.id.startsWith(task.id)) {
        count++;
      }
    });
    return count;
  }

  private async cleanupTask(task: OrchestratorTask): Promise<void> {
    try {
      // Remove agents associated with this task with proper disposal
      const activeAgents = this.agentPool.getActiveAgents();
      for (const agent of activeAgents) {
        if (agent.task && agent.task.id.startsWith(task.id)) {
          await this.agentPool.remove(agent.id);
        }
      }

      // Remove task from map after a delay to allow for status queries
      setTimeout(() => {
        this.tasks.delete(task.id);
        logger.debug('Task cleaned up', { taskId: task.id });
      }, 300000); // Keep for 5 minutes

    } catch (error) {
      logger.error('Error cleaning up task', {
        taskId: task.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Public method to get agent pool metrics
  getAgentPoolMetrics() {
    return this.agentPool.getMetrics();
  }

  // Get conversation history for a thread
  async getConversationHistory(threadId: string): Promise<any> {
    return await conversationThreadingService.getThread(threadId);
  }

  // Provide feedback for a task
  async provideFeedback(taskId: string, feedback: any): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Process feedback for all agents involved
    const agents = this.getTaskAgents(taskId);
    for (const agent of agents) {
      await agentLearningService.processFeedback(
        agent.id,
        taskId,
        feedback
      );
    }

    // Store feedback as episode
    // PHASE 34: Pass tenant context for multi-tenant isolation
    await episodeService.createFromUserInput(
      `Feedback for task ${taskId}: ${JSON.stringify(feedback)}`,
      task.sessionId || this.currentSessionId || 'default-session',
      { type: 'feedback', taskId, threadId: task.threadId },
      this.currentTenantContext
    );
  }

  // Start a new session
  startNewSession(): string {
    this.currentSessionId = uuidv4();
    logger.info('Started new orchestration session', { sessionId: this.currentSessionId });
    return this.currentSessionId;
  }

  // Clean up task memory to prevent leaks
  private cleanupTaskMemory(task: OrchestratorTask): void {
    try {
      // Clear memory context
      if (task.memoryContext) {
        task.memoryContext = null;
      }

      // Clear context memory references
      if (task.context && task.context.memoryContext) {
        task.context.memoryContext = null;
      }

      // Clear result if it's too large
      if (task.result && JSON.stringify(task.result).length > 100000) {
        task.result = { summary: 'Result cleared due to size', taskId: task.id };
      }

      // Clear agent references
      if (task.agents) {
        delete (task as any).agents;
      }

      // Remove from active threads
      this.activeThreads.delete(task.id);

      // Schedule task removal from cache
      setTimeout(() => {
        this.tasks.delete(task.id);
      }, 60000); // Keep for 1 minute for status queries
    } catch (error) {
      logger.error('Error cleaning up task memory', {
        taskId: task.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  // Cleanup method for graceful shutdown
  async cleanup(): Promise<void> {
    logger.info('Orchestrator cleanup started');

    // Clean up all tasks
    for (const task of this.tasks.values()) {
      this.cleanupTask(task);
    }

    // Clear memory caches
    episodeService.clearCache();
    conversationThreadingService.clearCache();

    // Destroy agent pool with proper disposal
    await this.agentPool.destroy();

    logger.info('Orchestrator cleanup completed');
  }

  private getRequiredCapabilities(role: string): any {
    switch (role) {
      case 'coding':
        return { coding: true, functionCalling: true };
      case 'research':
        return { analysis: true, factual: true };
      case 'review':
        return { analysis: true, quality: 'high' };
      case 'synthesis':
        return { creative: true, analysis: true };
      default:
        return { analysis: true };
    }
  }

  /**
   * Apply multi-layer consensus to agent results
   * This is Phase 2: 3-Layer Consensus Engine (simplified version for Phase 1)
   */
  private async applyConsensusLayers(
    task: OrchestratorTask,
    agentResults: any[],
    layerCount: number
  ): Promise<any> {
    logger.info('Applying 3-layer consensus engine', {
      taskId: task.id,
      layerCount,
      agentCount: agentResults.length
    });

    // Transform agent results into consensus engine format
    const agentOutputs = agentResults.map(r => ({
      agentId: r.agentId,
      role: r.role,
      model: r.model,
      specialization: r.profile.specialization || 'general',
      focus: r.profile.focus || 'analysis',
      reasoningDepth: r.profile.reasoningDepth || 'medium',
      result: r.result,
      profile: r.profile
    }));

    // Apply 3-layer consensus using ConsensusEngine
    // PHASE 43: Pass tenant context for multi-tenant isolation
    const consensusResult = await this.consensusEngine.applyConsensus(
      task.objective,
      agentOutputs,
      layerCount,
      this.currentTenantContext
    );

    logger.info('Consensus engine completed', {
      taskId: task.id,
      consensusStrength: consensusResult.consensusStrength,
      confidenceScore: consensusResult.confidenceScore,
      conflicts: consensusResult.layers.conflictResolutions.length,
      uncertainties: consensusResult.uncertainties.length
    });

    // Return the final synthesized output
    return consensusResult.finalOutput;
  }

  /**
   * Simple synthesis of multiple agent results
   * Used when consensus layers are not needed
   */
  private synthesizeResults(agentResults: any[]): any {
    // For single or two agents, just combine results
    if (agentResults.length === 1) {
      return agentResults[0].result;
    }

    // For multiple agents, create a structured synthesis
    return {
      type: 'multi-agent-synthesis',
      agentCount: agentResults.length,
      results: agentResults.map(r => ({
        role: r.role,
        model: r.model,
        specialization: r.profile.specialization,
        analysis: r.result
      })),
      summary: 'Multiple agents completed analysis. Review individual agent results above.'
    };
  }

  /**
   * Assess task complexity for adaptive timeout calculation
   * Supports 4 levels: simple, medium, complex, extreme
   */
  private assessTaskComplexity(task?: string | AgentTask | object): 'simple' | 'medium' | 'complex' | 'extreme' {
    if (!task) return 'medium';

    // Extract text for analysis
    let text: string;
    if (typeof task === 'string') {
      text = task;
    } else if ('objective' in task) {
      text = (task as AgentTask).objective;
    } else {
      text = JSON.stringify(task);
    }

    const lowerText = text.toLowerCase();
    const wordCount = text.split(' ').length;

    // Extreme complexity: 100k+ words, medical/legal tasks, book creation, complex coding
    if (
      text.length > 10000 || // Very long descriptions
      wordCount > 1000 ||
      /100k|100000|book|novel|series|medical|diagnosis|legal|contract|docmage|vibecoding/i.test(text) ||
      /entire codebase|full implementation|complete system|architecture design/i.test(text) ||
      (lowerText.includes('blueprint') && lowerText.includes('detailed'))
    ) {
      return 'extreme'; // 10x multiplier = 600s (10 min) baseline
    }

    // Complex tasks
    if (
      wordCount > 30 ||
      text.length > 2000 ||
      lowerText.includes('analyze') ||
      lowerText.includes('design') ||
      lowerText.includes('architect') ||
      lowerText.includes('implement') ||
      lowerText.includes('research') ||
      lowerText.includes('investigate') ||
      lowerText.includes('refactor') ||
      lowerText.includes('optimize') ||
      lowerText.includes('competition') ||
      lowerText.includes('collaborate')
    ) {
      return 'complex';
    }

    // Simple tasks
    if (
      wordCount < 10 &&
      (lowerText.includes('what is') ||
       lowerText.includes('calculate') ||
       lowerText.includes('what') && wordCount < 5)
    ) {
      return 'simple';
    }

    return 'medium';
  }

  /**
   * Get default timeout based on complexity when no historical data available
   */
  private getDefaultTimeout(complexity: 'simple' | 'medium' | 'complex' | 'extreme'): number {
    const baseTimeout = 60000; // 60 seconds base
    const multipliers = {
      simple: 1,    // 60s
      medium: 2,    // 120s
      complex: 4,   // 240s
      extreme: 10   // 600s (10 minutes)
    };
    return baseTimeout * multipliers[complexity];
  }

  private estimateRequiredContext(task?: AgentTask): number {
    if (!task) return 8000;

    const contextSize = JSON.stringify(task.context || {}).length;
    const objectiveSize = task.objective.length;
    const totalSize = contextSize + objectiveSize;

    // Add buffer for response
    const estimatedTokens = Math.ceil(totalSize / 4) * 2; // Rough token estimation

    if (estimatedTokens > 32000) return 128000;
    if (estimatedTokens > 16000) return 32000;
    if (estimatedTokens > 8000) return 16000;
    return 8000;
  }

  // Public method to get model statistics
  getModelStats(): any {
    const selectorStats = this.modelSelector.getModelStats();

    return {
      selector: selectorStats,
      activeAgents: this.agentPool.getActiveAgents().length,
      activeTasks: 0, // Task manager not implemented yet
      sessions: {
        current: this.currentSessionId,
        total: this.sessionCount
      },
      performance: {
        avgResponseTime: this.avgResponseTime,
        totalTasks: this.totalTasksProcessed
      },
      timestamp: new Date().toISOString()
    };
  }

  // Tracking variables for performance metrics
  private sessionCount = 0;
  private avgResponseTime = 0;
  private totalTasksProcessed = 0;

  /**
   * STARTUP RECOVERY: Check for pending checkpoints and complete persistence
   *
   * Called during Orchestrator initialization.
   * Recovers synthesis results from crashes during persistence phase.
   *
   * Recovery Pattern: WAL Replay
   * - Query Redis for pending checkpoints
   * - Complete dual-write persistence (Qdrant + Neo4j)
   * - Mark checkpoints as committed
   * - Delete recovered checkpoints
   */
  async recoverPendingCheckpoints(): Promise<number> {
    try {
      const pendingCheckpoints = await this.checkpointService.listPendingCheckpoints();

      if (pendingCheckpoints.length === 0) {
        logger.info('No pending synthesis checkpoints to recover');
        return 0;
      }

      logger.info('Recovering pending synthesis checkpoints', {
        pendingCount: pendingCheckpoints.length
      });

      let recovered = 0;

      for (const checkpoint of pendingCheckpoints) {
        try {
          // Complete persistence for interrupted synthesis
          await this.persistSynthesisResultDurable(
            checkpoint.taskId,
            checkpoint.synthesisResult,
            {
              model: checkpoint.metadata.model,
              agentCount: checkpoint.agentCount,
              consensusStrength: checkpoint.consensusStrength,
              taskType: 'recovered'
            }
          );

          // Commit checkpoint (mark as persisted)
          await this.checkpointService.commitCheckpoint(checkpoint.taskId);

          logger.info('Recovered checkpoint successfully', {
            taskId: checkpoint.taskId,
            checkpointId: checkpoint.checkpointId,
            resultSize: checkpoint.synthesisResult.length
          });

          recovered++;
        } catch (recoveryError) {
          logger.error('Failed to recover checkpoint', {
            taskId: checkpoint.taskId,
            checkpointId: checkpoint.checkpointId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          });
          // Continue with next checkpoint
        }
      }

      logger.info('Checkpoint recovery completed', {
        totalPending: pendingCheckpoints.length,
        recovered,
        failed: pendingCheckpoints.length - recovered
      });

      return recovered;

    } catch (error) {
      logger.error('Checkpoint recovery process failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  /**
   * Async wrapper for startup recovery (non-blocking)
   */
  private recoverPendingCheckpointsAsync(): void {
    this.recoverPendingCheckpoints()
      .then((recovered) => {
        if (recovered > 0) {
          logger.info('Startup checkpoint recovery completed', { recovered });
        }
      })
      .catch((error) => {
        logger.error('Startup checkpoint recovery failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /**
   * CRITICAL: Persist synthesis result with durability guarantees
   *
   * Dual-Write Pattern:
   * 1. Qdrant document (searchable, vector-embedded, persistent)
   * 2. GraphRAG storage via MemoryStorageQueue (with retry logic)
   *
   * Sequential writes (NOT Promise.all) ensure atomicity.
   * If crash occurs during write 2, write 1 still persisted.
   */
  private async persistSynthesisResultDurable(
    taskId: string,
    synthesisResult: string,
    metadata: {
      model: string;
      agentCount: number;
      consensusStrength: number;
      taskType: string;
    }
  ): Promise<void> {
    // WRITE 1: Store as Qdrant document (primary persistent storage)
    try {
      const docId = await this.dependencies.graphRAGClient.storeDocument(synthesisResult, {
        title: `Synthesis Result: ${taskId}`,
        metadata: {
          type: 'markdown',
          category: 'synthesis_result',
          tags: ['mageagent', 'synthesis', 'orchestration', metadata.taskType, `task:${taskId}`],
          taskId,
          agentCount: metadata.agentCount,
          consensusStrength: metadata.consensusStrength,
          synthesisModel: metadata.model,
          timestamp: new Date().toISOString(),
          source: 'mageagent-orchestrator',
          durable: true // Flag for recovery queries
        }
      });

      logger.info('Synthesis result stored as document (primary)', {
        taskId,
        documentId: docId,
        storageBackend: 'Qdrant',
        contentLength: synthesisResult.length
      });
    } catch (docError) {
      // Document storage failure is FATAL - violates durability guarantee
      const errorMessage = docError instanceof Error ? docError.message : String(docError);

      logger.error('CRITICAL: Document storage failed (primary persistence)', {
        taskId,
        error: errorMessage,
        contentLength: synthesisResult.length,
        storageBackend: 'Qdrant'
      });

      throw new Error(
        `Synthesis result persistence failed (task: ${taskId}):\n` +
        `Storage backend: Qdrant\n` +
        `Error: ${errorMessage}\n` +
        `Result size: ${synthesisResult.length} chars\n` +
        `This violates durability guarantee - synthesis result cannot be recovered.`
      );
    }

    // WRITE 2: Store via MemoryStorageQueue (async with retry logic)
    // PHASE 45: Include tenant context for multi-tenant isolation
    try {
      await this.dependencies.memoryStorageQueue.queueMemoryOperation({
        type: 'document',
        operation: 'create',
        payload: {
          content: synthesisResult,
          title: `Synthesis Result: ${taskId}`,
          metadata: {
            type: 'markdown',
            category: 'synthesis_result',
            tags: ['mageagent', 'synthesis', metadata.taskType],
            taskId,
            synthesisModel: metadata.model,
            timestamp: new Date().toISOString(),
            source: 'mageagent-orchestrator-checkpoint'
          }
        },
        metadata: {
          taskId,
          agentId: 'synthesizer',
          timestamp: new Date(),
          priority: 9, // High priority
          retryCount: 0,
          maxRetries: 5
        },
        // PHASE 45: Propagate tenant context for multi-tenant isolation
        tenantContext: this.currentTenantContext
      });

      logger.debug('Synthesis result queued for GraphRAG storage (secondary)', {
        taskId,
        storageBackend: 'MemoryStorageQueue',
        contentLength: synthesisResult.length
      });
    } catch (queueError) {
      // Queue storage failure is NON-FATAL
      // Result already persisted in Qdrant (write 1 succeeded)
      logger.warn('MemoryStorageQueue write failed (non-fatal - primary storage succeeded)', {
        taskId,
        error: queueError instanceof Error ? queueError.message : String(queueError)
      });
    }

    // WRITE 3: Create lightweight episode pointer for timeline tracking
    // This enables discovery via nexus_recall_episodes() while keeping episodes under 25K token limit
    try {
      const previewLength = Math.min(300, synthesisResult.length);
      const preview = synthesisResult.substring(0, previewLength);
      const episodeContent =
        `Synthesis completed for task ${taskId}. ` +
        `Result stored as document (ID: ${taskId}). ` +
        `Model: ${metadata.model}, Agents: ${metadata.agentCount}, ` +
        `Consensus: ${metadata.consensusStrength.toFixed(2)}. ` +
        `Preview: ${preview}...`;

      await this.dependencies.graphRAGClient.storeEpisode({
        content: episodeContent,
        type: 'system_response',
        metadata: {
          taskId,
          taskType: metadata.taskType,
          synthesisModel: metadata.model,
          agentCount: metadata.agentCount,
          consensusStrength: metadata.consensusStrength,
          synthesisLength: synthesisResult.length,
          timestamp: new Date().toISOString(),
          source: 'mageagent-orchestrator',
          category: 'synthesis_completion'
        }
      });

      logger.debug('Synthesis episode pointer created for timeline tracking', {
        taskId,
        episodeLength: episodeContent.length,
        storageBackend: 'Neo4j'
      });
    } catch (episodeError) {
      // Episode storage failure is NON-FATAL
      // Result already persisted in Qdrant (write 1 succeeded)
      logger.warn('Episode pointer creation failed (non-fatal - primary storage succeeded)', {
        taskId,
        error: episodeError instanceof Error ? episodeError.message : String(episodeError),
        note: 'Synthesis result is still accessible via document retrieval'
      });
    }
  }

}
