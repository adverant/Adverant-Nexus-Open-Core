/**
 * MageAgent Client V2 - Enhanced with Connection Pool, Circuit Breaker, Service Discovery
 * Production-ready wrapper around MageAgent service HTTP API
 */

import { logger } from '../utils/logger.js';
import { ServiceUnavailableError, ToolExecutionError } from '../utils/error-handler.js';
import { config, TOOL_TIMEOUTS } from '../config.js';
import { SmartConnectionPool } from '../utils/connection-pool.js';
import { circuitBreakerManager } from '../utils/circuit-breaker.js';
import { serviceDiscovery } from '../utils/service-discovery.js';

/**
 * Request context for API key tracking
 * Set by the smart router before handler execution
 */
interface RequestContext {
  apiKeyId?: string;
  userId?: string;
  tier?: string;
}

export class MageAgentClientV2 {
  private pool: SmartConnectionPool | null = null;
  private initialized: boolean = false;
  private baseUrl: string = '';

  /**
   * Current request context for API key usage tracking
   * Set by the smart router before each request
   */
  private requestContext: RequestContext | null = null;

  /**
   * Operation-specific timeout configuration
   * Different operations have different complexity and expected duration
   */
  private readonly OPERATION_TIMEOUTS = {
    orchestrate: 180000,    // 3 minutes - spawns multiple agents
    collaborate: 300000,    // 5 minutes - multi-iteration collaboration
    synthesize: 300000,     // 5 minutes - processes multiple sources
    analyze: 120000,        // 2 minutes - depth-dependent analysis
    competition: 180000     // 3 minutes - multiple agent competition
  };

  constructor() {
    logger.debug('MageAgent client V2 initialized (lazy loading enabled)');
  }

  /**
   * Set the request context for API key tracking
   * Called by the smart router before handler execution
   * @param context Request context with API key ID for usage attribution
   */
  setRequestContext(context: RequestContext | null): void {
    this.requestContext = context;
    if (context?.apiKeyId) {
      logger.debug('MageAgent client context set', {
        apiKeyId: `${context.apiKeyId.substring(0, 8)}...`,
        userId: context.userId ? `${context.userId.substring(0, 8)}...` : undefined
      });
    }
  }

  /**
   * Get headers with API key ID for usage tracking
   * @returns Headers object with X-API-Key-ID if context is set
   */
  private getTrackingHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.requestContext?.apiKeyId) {
      headers['X-API-Key-ID'] = this.requestContext.apiKeyId;
    }
    if (this.requestContext?.userId) {
      headers['X-User-ID'] = this.requestContext.userId;
    }
    return headers;
  }

  /**
   * Lazy initialization - discover endpoint and create connection pool
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.pool) {
      return;
    }

    try {
      // Discover working endpoint
      const endpoint = await serviceDiscovery.discover({
        name: 'mageagent',
        candidates: config.mageagent.endpoints,
        healthPath: config.mageagent.healthPath,
        timeout: config.mageagent.healthTimeout
      });

      if (!endpoint.healthy) {
        logger.warn('MageAgent endpoint discovered but unhealthy', {
          url: endpoint.url
        });
      }

      // Create connection pool with discovered endpoint
      this.baseUrl = endpoint.url;
      this.pool = new SmartConnectionPool(endpoint.url, config.connectionPool);
      this.initialized = true;

      logger.info('MageAgent client initialized', {
        endpoint: endpoint.url,
        latency: `${endpoint.latency}ms`
      });
    } catch (error) {
      logger.error('Failed to initialize MageAgent client', {
        error: (error as Error).message
      });
      throw new ServiceUnavailableError('mageagent', {
        message: 'Failed to discover MageAgent endpoint',
        candidates: config.mageagent.endpoints
      });
    }
  }

  /**
   * Execute request with circuit breaker protection
   */
  private async executeWithProtection<T>(
    toolName: string,
    fn: () => Promise<T>
  ): Promise<T> {
    await this.ensureInitialized();

    const breaker = circuitBreakerManager.getBreaker(
      'mageagent',
      config.circuitBreaker
    );

    try {
      return await breaker.execute(fn);
    } catch (error) {
      throw new ToolExecutionError(toolName, 'mageagent', error as Error);
    }
  }

  /**
   * Generic POST request with timeout and API key tracking headers
   */
  private async post<T = any>(
    endpoint: string,
    data: any,
    toolName: string
  ): Promise<T> {
    return this.executeWithProtection(toolName, async () => {
      if (!this.pool) throw new Error('Connection pool not initialized');

      const timeout = TOOL_TIMEOUTS[toolName] || config.mageagent.defaultTimeout;
      const trackingHeaders = this.getTrackingHeaders();

      // Pass tracking headers to the connection pool
      const response = await this.pool.post(endpoint, data, {
        headers: trackingHeaders
      }, timeout);

      return response.data;
    });
  }

  /**
   * Generic GET request with timeout and API key tracking headers
   */
  private async get<T = any>(endpoint: string, toolName: string): Promise<T> {
    return this.executeWithProtection(toolName, async () => {
      if (!this.pool) throw new Error('Connection pool not initialized');

      const timeout = TOOL_TIMEOUTS[toolName] || config.mageagent.defaultTimeout;
      const trackingHeaders = this.getTrackingHeaders();

      // Pass tracking headers to the connection pool
      const response = await this.pool.get(endpoint, {
        headers: trackingHeaders
      }, timeout);

      return response.data;
    });
  }

  /**
   * Check health (without circuit breaker)
   */
  async checkHealth(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      if (!this.pool) return false;

      const response = await this.pool.get('/mageagent/api/health', {}, 5000);
      return response.status === 200;
    } catch (error) {
      logger.debug('MageAgent health check failed', {
        error: (error as Error).message
      });
      return false;
    }
  }

  /**
   * Execute long-running operation with transparent async polling
   *
   * CRITICAL ARCHITECTURAL PATTERN: This method solves the async-sync impedance mismatch
   * between MCP protocol (expects synchronous responses) and MageAgent multi-agent operations
   * (which take 30-180 seconds).
   *
   * Flow:
   * 1. Submit operation with async:true → get taskId immediately (HTTP 202)
   * 2. Poll /api/tasks/{taskId} every 2-5s until completion
   * 3. Return ACTUAL RESULT to caller (transparent async)
   *
   * Benefits:
   * - MCP tool contract UNCHANGED (tools still return results, not taskIds)
   * - No timeout issues (operations can take minutes/hours)
   * - Scalable (multiple concurrent long operations via task queue)
   * - Graceful error handling (poll detects task failures)
   *
   * @param operation Function that calls MageAgent endpoint
   * @param maxWaitTime Maximum time to wait for result (default: 3min)
   * @returns Actual operation result
   * @throws ToolExecutionError if operation fails or times out
   */
  private async executeWithAsyncPolling<T = any>(
    operation: () => Promise<any>,
    maxWaitTime: number = 180000  // 3 minutes default
  ): Promise<T> {
    // Execute operation (with async flag, should return taskId)
    const response = await operation();

    // If response has taskId, it's async - poll for result
    if (response.taskId) {
      logger.debug('Operation submitted as async task, polling for result', {
        taskId: response.taskId,
        pollUrl: response.pollUrl,
        maxWait: `${maxWaitTime}ms`
      });

      return await this.pollForTaskCompletion(response.taskId, maxWaitTime);
    }

    // If got direct result (fast operation completed synchronously), return it
    logger.debug('Operation completed synchronously, returning immediate result');
    return response as T;
  }

  /**
   * Execute long-running operation with SSE streaming for real-time progress
   *
   * CRITICAL ARCHITECTURAL PATTERN: This method provides real-time progress updates
   * through Server-Sent Events (SSE) instead of HTTP polling.
   *
   * Flow:
   * 1. Submit operation with async:true → get taskId immediately (HTTP 202)
   * 2. Connect to /api/tasks/{taskId}/stream SSE endpoint
   * 3. Receive real-time progress events (5%, 15%, 25%, 70%, 80%, 95%)
   * 4. Return ACTUAL RESULT when task:complete event arrives
   *
   * Benefits over polling:
   * - Real-time progress (no 2-5s polling delay)
   * - Lower server load (no repeated HTTP requests)
   * - Instant notification of completion/failure
   * - Keepalive support (maintains connection health)
   *
   * @param operation Function that calls MageAgent endpoint
   * @param maxWaitTime Maximum time to wait for result (default: 3min)
   * @returns Actual operation result
   * @throws ToolExecutionError if operation fails or times out
   */
  private async executeWithSSEStreaming<T = any>(
    operation: () => Promise<any>,
    maxWaitTime: number = 180000  // 3 minutes default
  ): Promise<T> {
    // Execute operation (with async flag, should return taskId)
    const response = await operation();

    // If response has taskId, it's async - stream for result
    if (response.taskId) {
      logger.debug('Operation submitted as async task, streaming for result', {
        taskId: response.taskId,
        streamUrl: `/mageagent/api/tasks/${response.taskId}/stream`,
        maxWait: `${maxWaitTime}ms`
      });

      return await this.streamForTaskCompletion(response.taskId, maxWaitTime);
    }

    // If got direct result (fast operation completed synchronously), return it
    logger.debug('Operation completed synchronously, returning immediate result');
    return response as T;
  }

  /**
   * Stream task events via SSE until completion, failure, or timeout
   *
   * Connects to Server-Sent Events endpoint and processes events:
   * - task:progress: Real-time progress updates (5%, 15%, 25%, 70%, 80%, 95%)
   * - task:complete: Task succeeded, return result
   * - task:failed: Task failed, throw with error details
   * - keepalive: Connection health pings (every 15s)
   *
   * @param taskId Task ID to stream
   * @param maxWaitTime Maximum wait time in milliseconds
   * @returns Task result when completed
   * @throws Error with detailed context if task fails or times out
   */
  private async streamForTaskCompletion(taskId: string, maxWaitTime: number): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const startTime = Date.now();
      const streamUrl = `${this.baseUrl}/mageagent/api/tasks/${taskId}/stream`;

      let timeoutId: NodeJS.Timeout | null = null;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

      // Cleanup function - defined early to avoid hoisting issues
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (reader) reader.cancel().catch(() => {}); // Ignore cancel errors
      };

      // Timeout handler
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(
          `Task ${taskId} did not complete within ${maxWaitTime}ms. ` +
          `Task may still be running in background. ` +
          `Check task status manually: GET /api/tasks/${taskId}`
        ));
      }, maxWaitTime);

      let eventBuffer = '';

      // Fetch with streaming
      let response: any;
      try {
        response = await fetch(streamUrl, {
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });

        if (!response.ok) {
          cleanup();
          reject(new Error(`Failed to connect to SSE stream: HTTP ${response.status}`));
          return;
        }

        logger.debug('Connected to SSE stream', {
          taskId,
          streamUrl,
          status: response.status
        });

      } catch (error) {
        cleanup();
        reject(new Error(
          `Failed to connect to SSE stream for task ${taskId}: ${(error as Error).message}`
        ));
        return;
      }

      // Process SSE stream
      reader = response.body?.getReader() || null;
      const decoder = new TextDecoder();

      if (!reader) {
        cleanup();
        reject(new Error('Response body is not readable'));
        return;
      }

      const processEvent = (event: string, data: string) => {
        const elapsedMs = Date.now() - startTime;

        try {
          if (event === 'connected') {
            logger.debug('SSE connection established', { taskId, elapsed: `${elapsedMs}ms` });
            return;
          }

          if (event === 'task:progress') {
            const progressData = JSON.parse(data);
            logger.info('Task progress update', {
              taskId,
              progress: progressData.progress,
              message: progressData.message,
              elapsed: `${elapsedMs}ms`
            });
            return;
          }

          if (event === 'task:complete') {
            const completeData = JSON.parse(data);
            logger.info('Task completed successfully', {
              taskId,
              elapsed: `${elapsedMs}ms`
            });
            cleanup();
            resolve(completeData.result || completeData);
            return;
          }

          if (event === 'task:failed') {
            const failedData = JSON.parse(data);
            const errorDetails = failedData.error || failedData.message || 'No error details provided';
            logger.error('Task failed', {
              taskId,
              error: errorDetails,
              elapsed: `${elapsedMs}ms`
            });
            cleanup();
            reject(new Error(
              `Task ${taskId} failed after ${elapsedMs}ms: ${errorDetails}`
            ));
            return;
          }

        } catch (error) {
          logger.warn('Failed to process SSE event', {
            taskId,
            event,
            data,
            error: (error as Error).message
          });
        }
      };

      // Read stream
      const readStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              logger.debug('SSE stream ended', { taskId });
              cleanup();
              reject(new Error(`SSE stream ended before task completion for ${taskId}`));
              break;
            }

            // Decode chunk and add to buffer
            const chunk = decoder.decode(value, { stream: true });
            eventBuffer += chunk;

            // Process complete lines
            const lines = eventBuffer.split('\n');
            eventBuffer = lines.pop() || ''; // Keep incomplete line in buffer

            let currentEvent = '';
            let currentData = '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.substring(7).trim();
              } else if (line.startsWith('data: ')) {
                currentData = line.substring(6).trim();
              } else if (line.startsWith(':')) {
                // Keepalive comment, ignore
                continue;
              } else if (line === '') {
                // Empty line signals end of event
                if (currentEvent && currentData) {
                  processEvent(currentEvent, currentData);
                  currentEvent = '';
                  currentData = '';
                }
              }
            }
          }
        } catch (error) {
          cleanup();
          reject(new Error(
            `Error reading SSE stream for task ${taskId}: ${(error as Error).message}`
          ));
        }
      };

      readStream();
    });
  }

  /**
   * Poll task status endpoint until completion, failure, or timeout
   *
   * Implements intelligent exponential backoff:
   * - First 30s: poll every 2s (rapid feedback for quick tasks)
   * - After 30s: poll every 5s (reduced load for longer tasks)
   *
   * @param taskId Task ID to poll
   * @param maxWaitTime Maximum wait time in milliseconds
   * @returns Task result when completed
   * @throws Error with detailed context if task fails or times out
   */
  private async pollForTaskCompletion(taskId: string, maxWaitTime: number): Promise<any> {
    const startTime = Date.now();
    const initialPollInterval = 2000;  // 2s for first 30s (rapid phase)
    const laterPollInterval = 5000;    // 5s after 30s (conserve resources)
    const rapidPhaseThreshold = 30000; // 30s
    let pollAttempt = 0;

    while (Date.now() - startTime < maxWaitTime) {
      pollAttempt++;
      const elapsedMs = Date.now() - startTime;

      try {
        const taskStatus = await this.getTaskStatus(taskId);

        logger.debug('Polled task status', {
          taskId,
          status: taskStatus.status,
          attempt: pollAttempt,
          elapsed: `${elapsedMs}ms`
        });

        // Task completed successfully - return result
        if (taskStatus.status === 'completed' || taskStatus.status === 'success') {
          logger.info('Async task completed successfully', {
            taskId,
            pollAttempts: pollAttempt,
            totalDuration: `${elapsedMs}ms`
          });
          return taskStatus.result || taskStatus;
        }

        // Task failed - throw with detailed error context
        if (taskStatus.status === 'failed' || taskStatus.status === 'error') {
          const errorDetails = taskStatus.error || taskStatus.message || 'No error details provided';
          logger.error('Async task failed', {
            taskId,
            error: errorDetails,
            pollAttempts: pollAttempt,
            elapsed: `${elapsedMs}ms`
          });
          throw new Error(
            `Task ${taskId} failed after ${elapsedMs}ms: ${errorDetails}. ` +
            `Polled ${pollAttempt} times before detecting failure.`
          );
        }

        // Task still running (pending, processing, running states) - continue polling
        // Exponential backoff: rapid polling initially, slower later to conserve resources
        const nextPollInterval = elapsedMs < rapidPhaseThreshold
          ? initialPollInterval
          : laterPollInterval;

        logger.debug('Task still running, scheduling next poll', {
          taskId,
          currentStatus: taskStatus.status,
          nextPoll: `${nextPollInterval}ms`,
          elapsed: `${elapsedMs}ms`
        });

        await new Promise(resolve => setTimeout(resolve, nextPollInterval));

      } catch (error) {
        const err = error as Error;

        // If task not found (HTTP 404) and we JUST started, retry (race condition)
        // TaskManager might not have persisted the task yet when we poll immediately
        if (err.message.includes('404') || err.message.includes('not found')) {
          if (pollAttempt <= 3) {
            logger.warn('Task not found yet, retrying (possible task persistence race)', {
              taskId,
              attempt: pollAttempt
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;  // Retry without counting against maxWaitTime
          }
        }

        // For non-retryable errors (500, network failures, etc), throw immediately
        logger.error('Failed to poll task status', {
          taskId,
          error: err.message,
          attempt: pollAttempt,
          elapsed: `${elapsedMs}ms`
        });
        throw new Error(
          `Failed to poll task ${taskId} status: ${err.message}. ` +
          `Attempted ${pollAttempt} polls over ${elapsedMs}ms.`
        );
      }
    }

    // Timeout exceeded - task still running
    throw new Error(
      `Task ${taskId} did not complete within ${maxWaitTime}ms. ` +
      `Attempted ${pollAttempt} status polls. ` +
      `Task may still be running in background. ` +
      `Check task status manually: GET /api/tasks/${taskId}`
    );
  }

  // ========================================
  // Orchestration Operations
  // ========================================
  async orchestrate(task: {
    task: string;
    context?: any;
    maxAgents?: number;
    timeout?: number;
  }): Promise<any> {
    // IMPORTANT: Returns immediately with jobId + streaming URL
    // Client is responsible for connecting to SSE stream
    await this.ensureInitialized();

    const response = await this.post('/mageagent/api/orchestrate', {
      ...task,
      async: true  // Force async mode to get task ID
    }, 'nexus_orchestrate');

    // Return jobId and streaming information immediately
    return {
      success: true,
      jobId: response.taskId,
      status: 'pending',
      message: 'Task submitted successfully. Use streaming URL for real-time progress.',
      streamUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}/stream`,
      pollUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}`,
      websocket: response.metadata?.websocket,
      estimatedDuration: response.metadata?.estimatedDuration
    };
  }

  async runCompetition(competition: {
    challenge: string;
    competitorCount?: number;
    evaluationCriteria?: string[];
    timeout?: number;
  }): Promise<any> {
    // Returns immediately with jobId + streaming URL
    await this.ensureInitialized();

    const response = await this.post('/mageagent/api/competition', {
      ...competition,
      async: true
    }, 'nexus_agent_competition');

    return {
      success: true,
      jobId: response.taskId,
      status: 'pending',
      message: 'Competition submitted successfully. Use streaming URL for real-time progress.',
      streamUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}/stream`,
      pollUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}`,
      websocket: response.metadata?.websocket,
      estimatedDuration: response.metadata?.estimatedDuration
    };
  }

  async collaborate(collaboration: {
    objective: string;
    agents?: Array<{ role: string; focus?: string }>;
    iterations?: number;
  }): Promise<any> {
    // Returns immediately with jobId + streaming URL
    await this.ensureInitialized();

    const response = await this.post('/mageagent/api/collaborate', {
      ...collaboration,
      async: true
    }, 'nexus_agent_collaborate');

    return {
      success: true,
      jobId: response.taskId,
      status: 'pending',
      message: 'Collaboration submitted successfully. Use streaming URL for real-time progress.',
      streamUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}/stream`,
      pollUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}`,
      websocket: response.metadata?.websocket,
      estimatedDuration: response.metadata?.estimatedDuration
    };
  }

  // ========================================
  // Analysis & Synthesis
  // ========================================
  async analyze(analysis: {
    topic: string;
    depth?: 'quick' | 'standard' | 'deep';
    includeMemory?: boolean;
  }): Promise<any> {
    // Returns immediately with jobId + streaming URL
    await this.ensureInitialized();

    const response = await this.post('/mageagent/api/analyze', {
      topic: analysis.topic,
      depth: analysis.depth || 'standard',
      includeMemory: analysis.includeMemory,
      async: true
    }, 'nexus_analyze');

    return {
      success: true,
      jobId: response.taskId,
      status: 'pending',
      message: 'Analysis submitted successfully. Use streaming URL for real-time progress.',
      streamUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}/stream`,
      pollUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}`,
      websocket: response.metadata?.websocket,
      estimatedDuration: response.metadata?.estimatedDuration
    };
  }

  async synthesize(synthesis: {
    sources: string[];
    objective?: string;
    format?: 'summary' | 'report' | 'analysis' | 'recommendations';
  }): Promise<any> {
    // Returns immediately with jobId + streaming URL
    await this.ensureInitialized();

    const response = await this.post('/mageagent/api/synthesize', {
      sources: synthesis.sources,
      objective: synthesis.objective,
      format: synthesis.format,
      async: true
    }, 'nexus_synthesize');

    return {
      success: true,
      jobId: response.taskId,
      status: 'pending',
      message: 'Synthesis submitted successfully. Use streaming URL for real-time progress.',
      streamUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}/stream`,
      pollUrl: `${this.baseUrl}/mageagent/api/tasks/${response.taskId}`,
      websocket: response.metadata?.websocket,
      estimatedDuration: response.metadata?.estimatedDuration
    };
  }

  // ========================================
  // Memory & Patterns
  // ========================================
  async searchMemory(search: {
    query: string;
    limit?: number;
    tags?: string[];
  }): Promise<any> {
    return this.post('/mageagent/api/memory/search', search, 'nexus_memory_search');
  }

  async storePattern(pattern: {
    pattern: string;
    context: string;
    tags?: string[];
    confidence?: number;
  }): Promise<any> {
    return this.post('/mageagent/api/patterns', pattern, 'nexus_store_pattern');
  }

  // ========================================
  // Task & Agent Management
  // ========================================
  async getTaskStatus(taskId: string): Promise<any> {
    return this.get(`/mageagent/api/tasks/${taskId}`, 'nexus_task_status');
  }

  async listAgents(): Promise<any> {
    return this.get('/mageagent/api/agents', 'nexus_list_agents');
  }

  async getAgent(agentId: string): Promise<any> {
    return this.get(`/mageagent/api/agents/${agentId}`, 'nexus_agent_details');
  }

  // ========================================
  // System & Stats
  // ========================================
  async getWebSocketStats(): Promise<any> {
    return this.get('/mageagent/api/websocket/stats', 'nexus_websocket_stats');
  }

  async getModelStats(): Promise<any> {
    return this.get('/mageagent/api/models/stats', 'nexus_model_stats');
  }

  async selectModel(selection: {
    complexity: number;
    taskType: string;
    maxBudget?: number;
  }): Promise<any> {
    return this.post('/mageagent/api/models/select', selection, 'nexus_model_select');
  }

  // ========================================
  // Code Validation (Phase 3)
  // ========================================

  /**
   * Multi-model code validation using 3 models (GPT-4o, Claude 3.7, Sonnet 4.5)
   * Takes 8-28 seconds - designed for async/background execution
   */
  async validateCode(validation: {
    code: string;
    language: string;
    context?: string;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    models?: string[];
  }): Promise<any> {
    return this.post('/mageagent/api/validation/code', {
      ...validation,
      models: validation.models || [
        'openai/gpt-4o-2024-11-20',
        'anthropic/claude-3.7-sonnet',
        'anthropic/claude-sonnet-4.5'
      ],
      consensusRequired: true
    }, 'nexus_validate_code');
  }

  /**
   * Multi-model command validation for high-risk operations
   * Returns consensus analysis with risk assessment
   */
  async validateCommand(validation: {
    command: string;
    cwd?: string;
    environment?: Record<string, string>;
    riskHeuristics?: boolean;
  }): Promise<any> {
    return this.post('/mageagent/api/validation/command', {
      ...validation,
      riskHeuristics: validation.riskHeuristics !== false,
      models: [
        'openai/gpt-4o-2024-11-20',
        'anthropic/claude-3.7-sonnet',
        'anthropic/claude-sonnet-4.5'
      ]
    }, 'nexus_validate_command');
  }

  /**
   * Analyze code for patterns, best practices, and improvements
   * Faster single-model analysis (3-5 seconds)
   *
   * CRITICAL FIX: Routes to MageAgent's /api/analyze endpoint, NOT API Gateway's /api/validation/analyze
   * The old path caused infinite recursion (API Gateway calling itself)
   */
  async analyzeCode(analysis: {
    code: string;
    language: string;
    focusAreas?: string[];
    depth?: 'quick' | 'standard' | 'deep';
  }): Promise<any> {
    // Route to MageAgent's analysis endpoint
    // MageAgent expects 'topic' field for analysis requests
    return this.post('/mageagent/api/analyze', {
      topic: `Analyze ${analysis.language} code for ${analysis.focusAreas?.join(', ') || 'best practices'}`,
      depth: analysis.depth || 'standard',
      code: analysis.code,
      language: analysis.language,
      focusAreas: analysis.focusAreas,
      async: false  // Force synchronous for quick analysis (3-5s)
    }, 'nexus_analyze_code');
  }

  // ========================================
  // Job ID Pattern Methods (PHASE 2 Refactoring)
  // ========================================
  // These methods expose Job IDs directly instead of hiding async operations
  // Part of the universal Job ID pattern for cross-platform MCP compatibility

  /**
   * Submit orchestration task - returns immediately with jobId for polling
   * Part of 3-tool pattern: submit → status → result
   */
  async orchestrateSubmit(task: {
    task: string;
    context?: any;
    maxAgents?: number;
    timeout?: number;
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post('/mageagent/api/orchestrate', {
      ...task,
      async: true  // Force async mode to get task ID
    }, 'nexus_orchestrate_submit');

    return {
      jobId: response.taskId,
      status: 'queued',
      pollWith: 'nexus_orchestrate_status',
      estimatedTime: '30-180 seconds'
    };
  }

  /**
   * Get orchestration job status - can poll multiple times
   */
  async orchestrateStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    currentStep?: string;
    error?: string;
  }> {
    const taskStatus = await this.getTaskStatus(jobId);
    return {
      jobId,
      status: taskStatus.status || 'unknown',
      progress: taskStatus.progress || 0,
      currentStep: taskStatus.currentStep,
      error: taskStatus.error
    };
  }

  /**
   * Get orchestration job result - call when status is 'completed'
   */
  async orchestrateResult(jobId: string): Promise<any> {
    const taskStatus = await this.getTaskStatus(jobId);
    if (taskStatus.status !== 'completed' && taskStatus.status !== 'success') {
      throw new Error(`Task ${jobId} has status '${taskStatus.status}', not completed`);
    }
    return taskStatus.result || taskStatus;
  }

  /**
   * Submit competition task - returns immediately with jobId for polling
   */
  async competitionSubmit(competition: {
    challenge: string;
    competitorCount?: number;
    evaluationCriteria?: string[];
    timeout?: number;
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post('/mageagent/api/competition', {
      ...competition,
      async: true
    }, 'nexus_agent_competition_submit');

    return {
      jobId: response.taskId,
      status: 'queued',
      pollWith: 'nexus_agent_competition_status',
      estimatedTime: '45-180 seconds'
    };
  }

  /**
   * Get competition job status
   */
  async competitionStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    currentCompetitor?: number;
    totalCompetitors?: number;
    error?: string;
  }> {
    const taskStatus = await this.getTaskStatus(jobId);
    return {
      jobId,
      status: taskStatus.status || 'unknown',
      progress: taskStatus.progress || 0,
      currentCompetitor: taskStatus.currentCompetitor,
      totalCompetitors: taskStatus.totalCompetitors,
      error: taskStatus.error
    };
  }

  /**
   * Get competition job result
   */
  async competitionResult(jobId: string): Promise<any> {
    const taskStatus = await this.getTaskStatus(jobId);
    if (taskStatus.status !== 'completed' && taskStatus.status !== 'success') {
      throw new Error(`Task ${jobId} has status '${taskStatus.status}', not completed`);
    }
    return taskStatus.result || taskStatus;
  }

  /**
   * Submit collaboration task
   */
  async collaborateSubmit(collaboration: {
    objective: string;
    agents?: Array<{ role: string; focus?: string }>;
    iterations?: number;
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post('/mageagent/api/collaborate', {
      ...collaboration,
      async: true
    }, 'nexus_agent_collaborate_submit');

    return {
      jobId: response.taskId,
      status: 'queued',
      pollWith: 'nexus_agent_collaborate_status',
      estimatedTime: '60-300 seconds'
    };
  }

  /**
   * Get collaboration job status
   */
  async collaborateStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    currentIteration?: number;
    totalIterations?: number;
    activeAgents?: number;
    error?: string;
  }> {
    const taskStatus = await this.getTaskStatus(jobId);
    return {
      jobId,
      status: taskStatus.status || 'unknown',
      progress: taskStatus.progress || 0,
      currentIteration: taskStatus.currentIteration,
      totalIterations: taskStatus.totalIterations,
      activeAgents: taskStatus.activeAgents,
      error: taskStatus.error
    };
  }

  /**
   * Get collaboration job result
   */
  async collaborateResult(jobId: string): Promise<any> {
    const taskStatus = await this.getTaskStatus(jobId);
    if (taskStatus.status !== 'completed' && taskStatus.status !== 'success') {
      throw new Error(`Task ${jobId} has status '${taskStatus.status}', not completed`);
    }
    return taskStatus.result || taskStatus;
  }

  /**
   * Submit analysis task
   */
  async analyzeSubmit(analysis: {
    topic: string;
    depth?: 'quick' | 'standard' | 'deep';
    includeMemory?: boolean;
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post('/mageagent/api/analyze', {
      topic: analysis.topic,
      depth: analysis.depth || 'standard',
      includeMemory: analysis.includeMemory,
      async: true
    }, 'nexus_analyze_submit');

    const estimateMap = {
      quick: '10-30 seconds',
      standard: '30-120 seconds',
      deep: '60-300 seconds'
    };

    return {
      jobId: response.taskId,
      status: 'queued',
      pollWith: 'nexus_analyze_status',
      estimatedTime: estimateMap[analysis.depth || 'standard']
    };
  }

  /**
   * Get analysis job status
   */
  async analyzeStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    currentPhase?: string;
    agentsActive?: number;
    error?: string;
  }> {
    const taskStatus = await this.getTaskStatus(jobId);
    return {
      jobId,
      status: taskStatus.status || 'unknown',
      progress: taskStatus.progress || 0,
      currentPhase: taskStatus.currentPhase,
      agentsActive: taskStatus.agentsActive,
      error: taskStatus.error
    };
  }

  /**
   * Get analysis job result
   */
  async analyzeResult(jobId: string): Promise<any> {
    const taskStatus = await this.getTaskStatus(jobId);
    if (taskStatus.status !== 'completed' && taskStatus.status !== 'success') {
      throw new Error(`Task ${jobId} has status '${taskStatus.status}', not completed`);
    }
    return taskStatus.result || taskStatus;
  }

  /**
   * Submit synthesis task
   */
  async synthesizeSubmit(synthesis: {
    sources: string[];
    objective?: string;
    format?: 'summary' | 'report' | 'analysis' | 'recommendations';
  }): Promise<{ jobId: string; status: string; pollWith: string; estimatedTime: string }> {
    const response = await this.post('/mageagent/api/synthesize', {
      sources: synthesis.sources,
      objective: synthesis.objective,
      format: synthesis.format,
      async: true
    }, 'nexus_synthesize_submit');

    return {
      jobId: response.taskId,
      status: 'queued',
      pollWith: 'nexus_synthesize_status',
      estimatedTime: '30-300 seconds'
    };
  }

  /**
   * Get synthesis job status
   */
  async synthesizeStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    sourcesProcessed?: number;
    totalSources?: number;
    error?: string;
  }> {
    const taskStatus = await this.getTaskStatus(jobId);
    return {
      jobId,
      status: taskStatus.status || 'unknown',
      progress: taskStatus.progress || 0,
      sourcesProcessed: taskStatus.sourcesProcessed,
      totalSources: taskStatus.totalSources,
      error: taskStatus.error
    };
  }

  /**
   * Get synthesis job result
   */
  async synthesizeResult(jobId: string): Promise<any> {
    const taskStatus = await this.getTaskStatus(jobId);
    if (taskStatus.status !== 'completed' && taskStatus.status !== 'success') {
      throw new Error(`Task ${jobId} has status '${taskStatus.status}', not completed`);
    }
    return taskStatus.result || taskStatus;
  }

  // ========================================
  // Diagnostics
  // ========================================
  getConnectionStats() {
    return this.pool?.getStats() || null;
  }

  getCircuitBreakerStats() {
    return circuitBreakerManager.getBreaker('mageagent').getStats();
  }
}

// Export singleton instance
export const mageagentClientV2 = new MageAgentClientV2();
