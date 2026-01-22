/**
 * API Gateway Client V2
 * Client for Nexus API Gateway HTTP endpoints with Service Discovery
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { serviceDiscovery } from '../utils/service-discovery.js';
import { ServiceUnavailableError } from '../utils/error-handler.js';

export interface ExecutionLearningRequest {
  code: string;
  language: string;
  context?: Record<string, any>;
  trigger_learning?: boolean;
  timeout?: number;
}

export interface ExecutionLearningResponse {
  success: boolean;
  execution: {
    id: string;
    status: 'success' | 'failure' | 'timeout';
    output?: string;
    error?: string;
    exitCode?: number;
    duration: number;
  };
  learning_triggered: boolean;
  learning_job_id?: string;
  pattern_stored: boolean;
}

export interface LearnedKnowledgeRequest {
  topic: string;
  context?: Record<string, any>;
  limit?: number;
}

export interface LearnedKnowledgeResponse {
  knowledge: Array<{
    id: string;
    topic: string;
    title: string;
    content: string;
    layer: 'OVERVIEW' | 'PROCEDURES' | 'TECHNIQUES' | 'EXPERT';
    timestamp: string;
  }>;
  count: number;
}

/**
 * API Gateway Client with Service Discovery
 */
export class APIGatewayClient {
  private client: AxiosInstance | null = null;
  private baseURL: string | null = null;
  private initialized: boolean = false;

  /**
   * Operation-specific timeout configuration
   * Validation operations use multi-model consensus (8-28s)
   */
  private readonly OPERATION_TIMEOUTS = {
    validateCode: 60000,      // 60s - multi-model consensus validation
    validateCommand: 60000,    // 60s - multi-model consensus validation
    sandboxExecute: 120000,    // 120s - code execution + learning
    analyzeCode: 30000         // 30s - single-model analysis
  };

  constructor(legacyConfig?: { baseURL: string; timeout?: number }) {
    // Support legacy constructor for backward compatibility
    if (legacyConfig?.baseURL) {
      this.baseURL = legacyConfig.baseURL;
      this.client = axios.create({
        baseURL: legacyConfig.baseURL,
        timeout: legacyConfig.timeout || 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      this.initialized = true;
      logger.info('APIGatewayClient initialized (legacy mode)', { baseURL: this.baseURL });
    } else {
      logger.debug('APIGatewayClient initialized (lazy loading with service discovery)');
    }
  }

  /**
   * Lazy initialization with service discovery
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.client) {
      return;
    }

    try {
      // Discover working endpoint
      const endpoint = await serviceDiscovery.discover({
        name: 'apiGateway',
        candidates: config.apiGateway.endpoints,
        healthPath: config.apiGateway.healthPath,
        timeout: config.apiGateway.healthTimeout
      });

      if (!endpoint.healthy) {
        logger.warn('API Gateway endpoint discovered but unhealthy', {
          url: endpoint.url
        });
      }

      this.baseURL = endpoint.url;
      this.client = axios.create({
        baseURL: endpoint.url,
        timeout: config.apiGateway.defaultTimeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      this.initialized = true;

      logger.info('APIGatewayClient initialized with service discovery', {
        endpoint: endpoint.url,
        latency: `${endpoint.latency}ms`
      });
    } catch (error) {
      logger.error('Failed to initialize API Gateway client', {
        error: (error as Error).message
      });
      throw new ServiceUnavailableError('apiGateway', {
        message: 'Failed to discover API Gateway endpoint',
        candidates: config.apiGateway.endpoints
      });
    }
  }

  /**
   * Execute operation with transparent async polling
   *
   * API Gateway validation endpoints return { validationId, status: "pending", pollUrl }
   * This method polls the result endpoint until completion
   *
   * @param operation Function that calls API Gateway endpoint
   * @param maxWaitTime Maximum time to wait for result
   * @returns Actual operation result
   */
  private async executeWithAsyncPolling<T = any>(
    operation: () => Promise<any>,
    maxWaitTime: number = 60000  // 60s default
  ): Promise<T> {
    // Execute operation (should return validationId if async)
    const response = await operation();

    // If response has validationId, it's async - poll for result
    if (response.validationId) {
      logger.debug('Validation submitted as async task, polling for result', {
        validationId: response.validationId,
        pollUrl: response.pollUrl,
        maxWait: `${maxWaitTime}ms`
      });

      return await this.pollForValidationCompletion(response.validationId, maxWaitTime);
    }

    // If got direct result (fast operation completed synchronously), return it
    logger.debug('Operation completed synchronously, returning immediate result');
    return response as T;
  }

  /**
   * Poll validation result endpoint until completion, failure, or timeout
   *
   * Implements intelligent exponential backoff:
   * - First 30s: poll every 2s (rapid feedback for quick validations)
   * - After 30s: poll every 5s (reduced load for longer validations)
   *
   * @param validationId Validation ID to poll
   * @param maxWaitTime Maximum wait time in milliseconds
   * @returns Validation result when completed
   */
  private async pollForValidationCompletion(validationId: string, maxWaitTime: number): Promise<any> {
    const startTime = Date.now();
    const initialPollInterval = 2000;  // 2s for first 30s
    const laterPollInterval = 5000;    // 5s after 30s
    const rapidPhaseThreshold = 30000; // 30s
    let pollAttempt = 0;

    while (Date.now() - startTime < maxWaitTime) {
      pollAttempt++;
      const elapsedMs = Date.now() - startTime;

      try {
        const validationStatus = await this.getValidationResultForPolling(validationId);

        logger.debug('Polled validation status', {
          validationId,
          status: validationStatus.status,
          attempt: pollAttempt,
          elapsed: `${elapsedMs}ms`
        });

        // Validation completed successfully - return result
        if (validationStatus.status === 'completed' || validationStatus.status === 'success') {
          logger.info('Async validation completed successfully', {
            validationId,
            pollAttempts: pollAttempt,
            totalDuration: `${elapsedMs}ms`
          });
          return validationStatus.result || validationStatus;
        }

        // Validation failed - throw with detailed error context
        if (validationStatus.status === 'failed' || validationStatus.status === 'error') {
          const errorDetails = validationStatus.error || validationStatus.message || 'No error details provided';
          logger.error('Async validation failed', {
            validationId,
            error: errorDetails,
            pollAttempts: pollAttempt,
            elapsed: `${elapsedMs}ms`
          });
          throw new Error(
            `Validation ${validationId} failed after ${elapsedMs}ms: ${errorDetails}. ` +
            `Polled ${pollAttempt} times before detecting failure.`
          );
        }

        // Validation still running - continue polling with exponential backoff
        const nextPollInterval = elapsedMs < rapidPhaseThreshold
          ? initialPollInterval
          : laterPollInterval;

        logger.debug('Validation still running, scheduling next poll', {
          validationId,
          currentStatus: validationStatus.status,
          nextPoll: `${nextPollInterval}ms`,
          elapsed: `${elapsedMs}ms`
        });

        await new Promise(resolve => setTimeout(resolve, nextPollInterval));

      } catch (error) {
        const err = error as Error;

        // If validation not found (HTTP 404) and we JUST started, retry (race condition)
        if (err.message.includes('404') || err.message.includes('not found')) {
          if (pollAttempt <= 3) {
            logger.warn('Validation not found yet, retrying (possible persistence race)', {
              validationId,
              attempt: pollAttempt
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
        }

        // For non-retryable errors, throw immediately
        logger.error('Failed to poll validation status', {
          validationId,
          error: err.message,
          attempt: pollAttempt,
          elapsed: `${elapsedMs}ms`
        });
        throw new Error(
          `Failed to poll validation ${validationId} status: ${err.message}. ` +
          `Attempted ${pollAttempt} polls over ${elapsedMs}ms.`
        );
      }
    }

    // Timeout reached - throw error with context
    throw new Error(
      `Validation ${validationId} timed out after ${maxWaitTime}ms. ` +
      `Attempted ${pollAttempt} polls. Validation may still be running - ` +
      `check /api/validation/result/${validationId} manually.`
    );
  }

  /**
   * Get validation result by ID (private method for polling)
   */
  private async getValidationResultForPolling(validationId: string): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      const response = await this.client.get(`/api/validation/result/${validationId}`);
      return response.data;
    } catch (error: any) {
      // If 404, validation not found yet (race condition possible)
      if (error.response?.status === 404) {
        throw new Error('not found');
      }
      throw error;
    }
  }

  /**
   * Get validation result by ID (public method for nexus_validation_result tool)
   */
  async getValidationResult(validationId: string): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      logger.debug('Getting validation result', { validationId });
      const response = await this.client.get(`/api/validation/result/${validationId}`);
      return response.data;
    } catch (error: any) {
      logger.error('Get validation result failed', { error: error.message });
      throw new Error(`Get validation result failed: ${error.message}`);
    }
  }

  /**
   * Execute code in Nexus Sandbox and trigger learning (nexus_sandbox_execute)
   */
  async executionLearningRun(request: ExecutionLearningRequest): Promise<ExecutionLearningResponse> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    // Transparent async polling - MCP layer sees synchronous interface
    return this.executeWithAsyncPolling(
      async () => {
        logger.debug('Sending execution-learning request', {
          language: request.language,
          codeLength: request.code.length,
          triggerLearning: request.trigger_learning
        });

        const response = await this.client!.post<ExecutionLearningResponse>(
          '/api/execution-learning/run',
          request
        );

        return response.data;
      },
      this.OPERATION_TIMEOUTS.sandboxExecute
    );
  }

  /**
   * Query learned knowledge from LearningAgent
   */
  async recallLearnedKnowledge(request: LearnedKnowledgeRequest): Promise<LearnedKnowledgeResponse> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      logger.debug('Querying learned knowledge', { topic: request.topic });

      const response = await this.client.post<any>(
        '/api/learning/recall',
        {
          topic: request.topic,
          layer: 'all',
          max_results: request.limit || 10
        }
      );

      // Transform response to match expected schema
      return {
        knowledge: response.data.knowledge || [],
        count: response.data.count || 0
      };
    } catch (error: any) {
      logger.error('Learned knowledge query failed', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Learned knowledge query failed: ${error.message}`);
    }
  }

  /**
   * Trigger learning job for specific topic
   */
  async triggerLearning(params: {
    topic: string;
    trigger: string;
    priority?: number;
    context?: Record<string, any>;
  }): Promise<{ job_id: string; jobId: string; status: string }> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      logger.debug('Triggering learning job', {
        topic: params.topic,
        trigger: params.trigger,
        priority: params.priority
      });

      const response = await this.client.post('/api/learning/trigger', params);

      // Transform response - handle both jobId and job_id
      const jobId = response.data.jobId || response.data.job_id;

      return {
        job_id: jobId,
        jobId: jobId,
        status: response.data.status || 'pending'
      };
    } catch (error: any) {
      logger.error('Learning trigger failed', {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Learning trigger failed: ${error.message}`);
    }
  }

  /**
   * Validate code using multi-model consensus (Phase 3)
   */
  async validateCode(params: {
    code: string;
    language: string;
    context?: string;
    riskLevel?: string;
  }): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    // Transparent async polling - MCP layer sees synchronous interface
    return this.executeWithAsyncPolling(
      async () => {
        logger.debug('Validating code', {
          language: params.language,
          codeLength: params.code.length
        });

        const response = await this.client!.post('/api/validation/code', params);
        return response.data;
      },
      this.OPERATION_TIMEOUTS.validateCode
    );
  }

  /**
   * Validate command with risk detection (Phase 3)
   */
  async validateCommand(params: {
    command: string;
    cwd?: string;
    environment?: Record<string, string>;
  }): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    // Transparent async polling - MCP layer sees synchronous interface
    return this.executeWithAsyncPolling(
      async () => {
        logger.debug('Validating command', { command: params.command });

        const response = await this.client!.post('/api/validation/command', params);
        return response.data;
      },
      this.OPERATION_TIMEOUTS.validateCommand
    );
  }

  /**
   * Analyze code (Phase 3)
   */
  async analyzeCode(params: {
    code: string;
    language: string;
    focusAreas?: string[];
    depth?: string;
  }): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      logger.debug('Analyzing code', {
        language: params.language,
        depth: params.depth
      });

      const response = await this.client.post('/api/validation/analyze', params);
      return response.data;
    } catch (error: any) {
      logger.error('Code analysis failed', { error: error.message });
      throw new Error(`Code analysis failed: ${error.message}`);
    }
  }


  // ==================== Phase 4: Context Injection ====================

  /**
   * Inject relevant context before tool execution
   */
  async injectContext(params: {
    toolName: string;
    toolArgs: any;
    sessionId?: string;
  }): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      logger.debug('Injecting context', { toolName: params.toolName });

      const response = await this.client.post('/api/context/inject', {
        tool_name: params.toolName,
        arguments: params.toolArgs,
        session_id: params.sessionId,
        hook_type: 'manual',
        timestamp: new Date().toISOString()
      });

      return response.data;
    } catch (error: any) {
      logger.error('Context injection failed', { error: error.message });
      throw new Error(`Context injection failed: ${error.message}`);
    }
  }

  /**
   * Get proactive suggestions for a context injection
   */
  async getSuggestions(contextId: string): Promise<any> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      logger.debug('Getting suggestions', { contextId });

      const response = await this.client.get(`/api/context/suggestions/${contextId}`);
      return response.data;
    } catch (error: any) {
      logger.error('Get suggestions failed', { error: error.message });
      throw new Error(`Get suggestions failed: ${error.message}`);
    }
  }

  /**
   * Health check for API Gateway
   */
  async checkHealth(): Promise<{ status: string; services: Record<string, any> }> {
    await this.ensureInitialized();
    if (!this.client) throw new Error('API Gateway client not initialized');

    try {
      const response = await this.client.get('/api/health');
      return response.data;
    } catch (error: any) {
      logger.error('API Gateway health check failed', { error: error.message });
      throw new Error(`API Gateway health check failed: ${error.message}`);
    }
  }
}

/**
 * Create singleton client instance (legacy support)
 */
export function createAPIGatewayClient(baseURL: string): APIGatewayClient {
  return new APIGatewayClient({ baseURL });
}

/**
 * Default client with service discovery
 * Automatically discovers working endpoint from multiple candidates:
 * - nexus-api-gateway:8092 (Docker internal network)
 * - host.docker.internal:9092 (Docker Desktop host access)
 * - localhost:9092 (direct host network)
 * - 127.0.0.1:9092 (explicit localhost)
 *
 * Service discovery happens lazily on first method call
 */
export const apiGatewayClient = new APIGatewayClient();
