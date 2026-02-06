/**
 * Simplified Routes - Orchestration Only, No WebSocket
 * All real-time features are accessed via GraphRAG service
 *
 * Refactored with:
 * - Type-safe error handling using custom error classes
 * - Consistent API response formatting
 * - asyncHandler wrapper to eliminate try-catch boilerplate
 * - Middleware-based service validation
 */

import { Router, Request, Response } from 'express';
import { Orchestrator } from '../orchestration/orchestrator';
import { createGraphRAGClient, graphRAGClient } from '../clients/graphrag-client';
import { extractTenantContext, extractTenantContextOptional, provideSystemTenantContext } from '../middleware/tenant-context';
import { databaseManager } from '../database/database-manager';
import { logger } from '../utils/logger';
import { intentClassifier } from '../services/intent-classifier-service';
import { fieldCompatibilityMiddleware, responseFieldCompatibilityMiddleware } from '../middleware/field-compatibility';
import {
  validators,
  handleValidationErrors,
  sanitizeInputs,
  validateSchema,
  validationSchemas
} from '../middleware/validation';
import { apiRateLimiters } from '../middleware/security';
import { getTaskManager as getTaskManagerInstance, TaskManager } from '../core/task-manager';

// Import new error handling system
import {
  ApiResponse
} from '../utils/api-response';
import {
  ValidationError,
  NotFoundError,
  TimeoutError,
  OperationError,
  ErrorFactory
} from '../utils/errors';
import {
  asyncHandler,
  correlationId,
  requestTiming,
  errorHandler
} from '../middleware/error-handler';

// Import autonomous routes for Manus.ai-style autonomous execution
import {
  autonomousRouter,
  initializeAutonomousRoutes,
  updateGodModeTools,
  getGodModeTools,
  type AutonomousRoutesConfig,
} from './autonomous-routes.js';

const router = Router();
const internalRouter = Router(); // Rate-limit-exempt router for internal services

let orchestrator: Orchestrator | null = null;
let taskManager: TaskManager | null = null;

export function initializeRoutes(orchestratorInstance: Orchestrator, taskManagerInstance?: TaskManager): Router {
  orchestrator = orchestratorInstance;
  try {
    taskManager = taskManagerInstance || getTaskManagerInstance();
  } catch (error) {
    logger.warn('TaskManager not initialized, async operations will use fallback mode');
  }
  return router;
}

// Export separate internal router that bypasses rate limiting
export function initializeInternalRoutes(orchestratorInstance: Orchestrator, taskManagerInstance?: TaskManager): Router {
  orchestrator = orchestratorInstance;
  try {
    taskManager = taskManagerInstance || getTaskManagerInstance();
  } catch (error) {
    logger.warn('TaskManager not initialized for internal routes, async operations will use fallback mode');
  }
  return internalRouter;
}

// Alias for compatibility
export const initializeSimplifiedRoutes = initializeRoutes;

// Apply global middleware
router.use(correlationId);
router.use(requestTiming);

// ============================================================================
// PUBLIC ENDPOINTS
// ============================================================================

// Unified smart endpoint that intelligently determines operation type
router.post('/process',
  extractTenantContext,
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  fieldCompatibilityMiddleware,
  responseFieldCompatibilityMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { query, prompt, task, challenge, objective, input, request } = req.body;
    const mainInput = query || prompt || task || challenge || objective || input || request;

    if (!mainInput) {
      throw new ValidationError('No input provided', {
        acceptedFields: ['query', 'prompt', 'task', 'challenge', 'objective', 'input', 'request'],
        context: { hint: 'This endpoint intelligently determines the operation type based on your input' }
      });
    }

    // Analyze the input to determine operation type
    const inputLower = mainInput.toLowerCase();
    let operation = 'orchestrate'; // default

    // Determine operation based on keywords and context
    if (inputLower.includes('compete') || inputLower.includes('competition') ||
        inputLower.includes('compare') || inputLower.includes('versus') ||
        inputLower.includes('which is better')) {
      operation = 'competition';
    } else if (inputLower.includes('analyze') || inputLower.includes('analysis') ||
               inputLower.includes('examine') || inputLower.includes('investigate')) {
      operation = 'analyze';
    } else if (inputLower.includes('synthesize') || inputLower.includes('combine') ||
               inputLower.includes('merge') || inputLower.includes('integrate')) {
      operation = 'synthesize';
    } else if (inputLower.includes('collaborate') || inputLower.includes('team up') ||
               inputLower.includes('work together')) {
      operation = 'collaborate';
    } else if (inputLower.includes('remember') || inputLower.includes('store') ||
               inputLower.includes('save this')) {
      operation = 'store';
    } else if (inputLower.includes('recall') || inputLower.includes('search') ||
               inputLower.includes('find') || inputLower.includes('what did')) {
      operation = 'search';
    }

    // Create tenant-scoped GraphRAG client for this request
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    // Execute based on determined operation
    let result;
    // PHASE 50: Include tenantContext in options for all orchestrateTask calls
    const options = {
      timeout: req.body.timeout || 60000,
      maxAgents: req.body.maxAgents || 3,
      context: req.body.context || {},
      tenantContext: req.tenantContext
    };

    switch (operation) {
      case 'competition':
        result = await orchestrator.runCompetition({
          challenge: mainInput,
          competitorCount: req.body.competitorCount || 3,
          models: req.body.models,
          timeout: options.timeout
        });
        break;

      case 'analyze':
        result = await orchestrator.orchestrateTask(
          `Perform deep analysis on: ${mainInput}`,
          {
            ...options,
            analysisDepth: req.body.depth || 'standard'
          }
        );
        break;

      case 'synthesize':
        const sources = req.body.sources || [mainInput];
        result = await orchestrator.orchestrateTask(
          `Synthesize the following: ${sources.join(', ')}`,
          {
            ...options,
            synthesisFormat: req.body.format || 'summary'
          }
        );
        break;

      case 'collaborate':
        result = await orchestrator.orchestrateTask(
          mainInput,
          {
            ...options,
            collaborationMode: true,
            agents: req.body.agents
          }
        );
        break;

      case 'store':
        result = await graphRAGClient.storeMemory({
          content: mainInput,
          tags: req.body.tags || ['user-input'],
          metadata: {
            source: 'smart-endpoint',
            timestamp: new Date().toISOString()
          }
        });
        break;

      case 'search':
        result = await graphRAGClient.recallMemory({
          query: mainInput,
          limit: req.body.limit || 10
        });
        break;

      default:
        // Default orchestration
        result = await orchestrator.orchestrateTask(mainInput, options);
    }

    return ApiResponse.success(res, {
      operation,
      input: mainInput,
      result
    }, {
      detectedOperation: operation,
      processingTime: (req as any).startTime ? Date.now() - (req as any).startTime : undefined,
      hint: 'This endpoint automatically determined the operation type'
    });
  })
);

// Health check endpoint
router.get('/health',
  extractTenantContextOptional,
  asyncHandler(async (req: Request, res: Response) => {
    const dbHealth = await databaseManager.healthCheck();

    // Only check GraphRAG health if we have tenant context
    let graphRAGHealthy: boolean | string = 'not checked (no tenant context)';
    if (req.tenantContext) {
      const graphRAGClient = createGraphRAGClient(req.tenantContext);
      graphRAGHealthy = await graphRAGClient.checkHealth();
    }

    const allHealthy = Object.values(dbHealth).every(status => status) &&
                       (typeof graphRAGHealthy === 'boolean' ? graphRAGHealthy : true);

    return ApiResponse.custom(res, allHealthy ? 200 : 503, {
      status: allHealthy ? 'healthy' : 'degraded',
      services: {
        databases: dbHealth,
        graphRAG: graphRAGHealthy,
        orchestrator: orchestrator ? 'running' : 'not initialized'
      },
      note: 'WebSocket functionality available at GraphRAG service'
    });
  })
);

// Task status polling endpoint - get status of async tasks
router.get('/tasks/:taskId',
  apiRateLimiters.memorySearch, // Use memorySearch rate limiter (30 req/min) - simple GET operation
  asyncHandler(async (req: Request, res: Response) => {
    const { taskId } = req.params;

    if (!taskId) {
      throw new ValidationError('Task ID is required');
    }

    // Get task manager instance (may be null if not initialized)
    const taskManagerInstance = taskManager || getTaskManagerInstance();

    if (!taskManagerInstance) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Task management service not initialized',
        suggestion: 'Try again in a few moments or use WebSocket for real-time updates'
      });
    }

    try {
      // Get task status from TaskManager (uses Redis or in-memory storage)
      const taskStatus = await taskManagerInstance.getTaskStatus(taskId);

      if (!taskStatus) {
        return res.status(404).json({
          error: 'Task not found',
          taskId,
          message: 'The specified task ID does not exist or has expired',
          suggestion: 'Tasks expire after completion. Use WebSocket for real-time updates.'
        });
      }

      return res.json({
        success: true,
        taskId,
        status: taskStatus.status || 'unknown',
        progress: taskStatus.progress || 0,
        result: taskStatus.result || null,
        error: taskStatus.error || null,
        createdAt: taskStatus.createdAt || null,
        completedAt: taskStatus.completedAt || null,
        agents: taskStatus.agents || [],
        metadata: taskStatus.metadata || {},
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to retrieve task status', {
        taskId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      throw ErrorFactory.internalError(
        'Failed to retrieve task status',
        { taskId, error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  }));

// Queue management endpoints (Task Queue Implementation - Phase 1 MVP)
// ============================================================================

/**
 * GET /queue/list
 * Get all tasks currently in the queue with metrics
 * Returns queue positions, estimated wait times, and overall queue metrics
 */
router.get('/queue/list',
  apiRateLimiters.memorySearch, // Light operation, use memorySearch limiter
  asyncHandler(async (_req: Request, res: Response) => {
    // Get task manager instance
    const taskManagerInstance = taskManager || getTaskManagerInstance();

    if (!taskManagerInstance) {
      throw ErrorFactory.serviceUnavailable('Task management service');
    }

    try {
      // Get the queue list with metrics from TaskManager
      const queueData = await taskManagerInstance.getQueueList();

      return ApiResponse.success(res, {
        queue: queueData.queue,
        metrics: queueData.metrics,
        timestamp: new Date().toISOString()
      }, {
        note: 'Queue positions are 0-indexed (0 = next to process)',
        websocket: {
          url: 'ws://graphrag:8090/graphrag',
          events: ['queue:position-update', 'queue:started'],
          note: 'Subscribe for real-time queue updates'
        }
      });

    } catch (error) {
      logger.error('Failed to retrieve queue list', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      throw ErrorFactory.internalError(
        'Failed to retrieve queue list',
        { error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  })
);

/**
 * GET /queue/status/:taskId
 * Get queue position and estimated wait time for a specific task
 * Useful for frontend to show progress to users
 */
router.get('/queue/status/:taskId',
  apiRateLimiters.memorySearch, // Light operation
  asyncHandler(async (req: Request, res: Response) => {
    const { taskId } = req.params;

    if (!taskId) {
      throw new ValidationError('Task ID is required');
    }

    // Get task manager instance
    const taskManagerInstance = taskManager || getTaskManagerInstance();

    if (!taskManagerInstance) {
      throw ErrorFactory.serviceUnavailable('Task management service');
    }

    try {
      // Get queue position and estimated wait time
      const [position, estimatedWaitTime, taskStatus] = await Promise.all([
        taskManagerInstance.getQueuePosition(taskId),
        taskManagerInstance.calculateEstimatedWaitTime(taskId),
        taskManagerInstance.getTaskStatus(taskId)
      ]);

      if (!taskStatus) {
        throw new NotFoundError('Task not found', {
          resourceType: 'Task',
          resourceId: taskId,
          context: { message: 'This task does not exist in the queue' }
        });
      }

      // Check if task is already processing or completed
      const isQueued = taskStatus.status === 'pending' || taskStatus.status === 'waiting';
      const isProcessing = taskStatus.status === 'active' || taskStatus.status === 'processing';
      const isCompleted = taskStatus.status === 'completed' || taskStatus.status === 'failed';

      return ApiResponse.success(res, {
        taskId,
        status: taskStatus.status,
        queuePosition: isQueued ? position : null,
        estimatedWaitTime: isQueued ? estimatedWaitTime : null,
        isQueued,
        isProcessing,
        isCompleted,
        progress: taskStatus.progress || 0,
        createdAt: taskStatus.createdAt,
        startedAt: taskStatus.startedAt,
        metadata: taskStatus.metadata || {},
        timestamp: new Date().toISOString()
      }, {
        note: isProcessing
          ? 'Task is currently being processed'
          : isCompleted
          ? 'Task has been completed'
          : `Task is in queue at position ${position}`,
        websocket: {
          url: 'ws://graphrag:8090/graphrag',
          subscribe: `queue:${taskId}`,
          events: ['queue:position-update', 'queue:started']
        }
      });

    } catch (error) {
      // If it's already a known error type, re-throw it
      if (error instanceof NotFoundError) {
        throw error;
      }

      logger.error('Failed to retrieve queue status', {
        taskId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      throw ErrorFactory.internalError(
        'Failed to retrieve queue status',
        { taskId, error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  })
);

/**
 * DELETE /queue/cancel/:taskId
 * Cancel a task that's waiting in the queue
 * Cannot cancel tasks that are already processing
 */
router.delete('/queue/cancel/:taskId',
  apiRateLimiters.orchestrate, // Modification operation, use orchestrate limiter
  asyncHandler(async (req: Request, res: Response) => {
    const { taskId } = req.params;

    if (!taskId) {
      throw new ValidationError('Task ID is required');
    }

    // Get task manager instance
    const taskManagerInstance = taskManager || getTaskManagerInstance();

    if (!taskManagerInstance) {
      throw ErrorFactory.serviceUnavailable('Task management service');
    }

    try {
      // Get current task status to check if it can be cancelled
      const taskStatus = await taskManagerInstance.getTaskStatus(taskId);

      if (!taskStatus) {
        throw new NotFoundError('Task not found', {
          resourceType: 'Task',
          resourceId: taskId,
          context: { message: 'This task does not exist' }
        });
      }

      // Check if task can be cancelled
      if (taskStatus.status === 'completed' || taskStatus.status === 'failed') {
        throw new OperationError('Cannot cancel completed task', {
          taskId,
          status: taskStatus.status,
          message: 'Task has already been completed and cannot be cancelled'
        });
      }

      if (taskStatus.status === 'active' || taskStatus.status === 'processing') {
        throw new OperationError('Cannot cancel processing task', {
          taskId,
          status: taskStatus.status,
          message: 'Task is currently being processed and cannot be cancelled. Please wait for completion.'
        });
      }

      // Cancel the task
      const cancelled = await taskManagerInstance.cancelTask(taskId);

      if (!cancelled) {
        throw new OperationError('Failed to cancel task', {
          taskId,
          message: 'Task cancellation failed. The task may have already started processing.'
        });
      }

      // Emit queue position updates for remaining tasks
      await taskManagerInstance.emitQueuePositionUpdates();

      return ApiResponse.success(res, {
        taskId,
        cancelled: true,
        message: 'Task successfully cancelled and removed from queue',
        timestamp: new Date().toISOString()
      }, {
        note: 'Queue positions have been updated for remaining tasks'
      });

    } catch (error) {
      // If it's already a known error type, re-throw it
      if (error instanceof NotFoundError || error instanceof OperationError) {
        throw error;
      }

      logger.error('Failed to cancel task', {
        taskId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      throw ErrorFactory.internalError(
        'Failed to cancel task',
        { taskId, error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  })
);

// Orchestration endpoint - with async task support
// PHASE 40: Added extractTenantContext middleware to ensure req.tenantContext is populated
// This is CRITICAL for multi-tenant isolation through the async Bull queue boundary
router.post('/orchestrate',
  extractTenantContext,  // PHASE 40: Extract tenant context BEFORE rate limiting (required for tenant-based rate limits)
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  fieldCompatibilityMiddleware,
  responseFieldCompatibilityMiddleware,
  validateSchema(validationSchemas.orchestrate),
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { task, options = {}, timeout, maxAgents, context } = req.body;

    // Check if streaming is requested (streamProgress parameter)
    const streamProgress = options.streamProgress === true ||
                          req.body.streamProgress === true ||
                          req.query.streamProgress === 'true';

    if (!task) {
      throw new ValidationError('Task is required', {
        acceptedFields: ['task', 'prompt', 'query', 'objective']
      });
    }

    // Merge options with explicit parameters
    // PHASE 50: Include tenantContext for sync path orchestration
    const orchestrationOptions = {
      ...options,
      timeout: options.timeout || timeout || 600000,
      maxAgents: maxAgents || options.maxAgents || 3,
      context: context || options.context,
      streamProgress,  // Forward streamProgress flag
      tenantContext: req.tenantContext
    };

    // If streaming requested, redirect to streaming orchestrator
    if (streamProgress) {
      logger.info('Streaming requested - forwarding to streaming orchestrator', {
        taskId: 'pending',
        streamProgress: true
      });

      // Use streaming endpoint (will be handled by StreamingOrchestrator)
      // This enables real-time WebSocket progress updates
      return res.status(307).json({
        redirectTo: '/mageagent/api/streaming/orchestrate',
        message: 'Streaming mode enabled - use /mageagent/api/streaming/orchestrate for WebSocket progress',
        streamProgress: true,
        websocket: {
          namespace: '/nexus/mageagent',
          events: ['task:start', 'agent:spawned', 'agent:progress', 'agent:complete', 'task:complete']
        },
        requestBody: req.body
      });
    }

    // ALWAYS use async mode for MageAgent operations (OpenRouter takes long time)
    if (taskManager) {
      try {
        // PHASE 28: Add comprehensive error handling and logging
        logger.info('[PHASE28-ROUTE] Creating orchestration task', {
          endpoint: '/orchestrate',
          task: task.substring(0, 100),
          timeout: orchestrationOptions.timeout,
          maxAgents: orchestrationOptions.maxAgents
        });

        // PHASE 31: Pass tenantContext to createTask for async propagation
        const taskId = await taskManager.createTask('orchestrate', {
          task,
          options: orchestrationOptions
        }, {
          timeout: orchestrationOptions.timeout,
          priority: options.priority || 0,
          tenantContext: req.tenantContext
        });

        logger.info('[PHASE28-ROUTE] Orchestration task created successfully', {
          endpoint: '/orchestrate',
          taskId,
          timeout: orchestrationOptions.timeout
        });

        return ApiResponse.accepted(
          res,
          taskId,
          `/api/tasks/${taskId}`,
          'Orchestration task created successfully. Use WebSocket or poll task endpoint for results.',
          {
            estimatedDuration: 'This task may take 2-10 minutes to complete',
            websocket: {
              url: 'ws://graphrag:8090/graphrag',
              subscribe: `memory:${taskId}`,
              note: 'Connect to WebSocket for real-time progress updates'
            }
          }
        );
      } catch (error: any) {
        logger.error('[PHASE28-ROUTE] Failed to create orchestration task', {
          endpoint: '/orchestrate',
          error: error.message,
          stack: error.stack,
          taskManagerAvailable: !!taskManager,
          task: task.substring(0, 100)
        });

        // Return proper error response
        throw ErrorFactory.internalError(
          'Failed to create orchestration task',
          {
            error: error.message,
            suggestion: 'Check if MageAgent service is properly initialized and Bull queue is connected'
          }
        );
      }
    }

    // Fallback if TaskManager unavailable (not recommended)
    const result = await orchestrator.orchestrateTask(task, orchestrationOptions);

    return ApiResponse.success(res, {
      taskId: result.taskId,
      status: result.status,
      agents: result.agents,
      result: result.result
    });
  })
);

// Smart unified endpoint with LLM-powered intent classification
router.post('/process',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    // Extract input from various possible fields
    const input = req.body.input || req.body.prompt || req.body.task ||
                 req.body.query || req.body.challenge || req.body;

    if (!input || (typeof input === 'object' && Object.keys(input).length === 0)) {
      throw new ValidationError('Input required', {
        acceptedFields: ['input', 'prompt', 'task', 'query', 'challenge']
      });
    }

    // Use LLM to classify intent and extract parameters
    const classification = await intentClassifier.classifyIntent(input);

    logger.info('Intent classification result', {
      operation: classification.operation,
      confidence: classification.confidence,
      reasoning: classification.reasoning
    });

    // Handle unknown operations
    if (classification.operation === 'unknown' || classification.confidence < 0.3) {
      throw new OperationError('Could not determine operation', {
        classification,
        availableOperations: [
          'orchestrate - General task execution',
          'competition - Compare multiple solutions',
          'analyze - Deep analysis of topics',
          'synthesize - Combine information sources',
          'collaborate - Iterative agent collaboration',
          'search - Search memories and documents',
          'store - Store information for later recall',
          'workflow - Multi-service workflow execution (file download → analysis → security scan)',
          'file_process - Process files (PDF, Office, archives, OCR)',
          'security_scan - Malware scanning and threat detection',
          'code_execute - Execute code in isolated sandbox'
        ]
      });
    }

    // Execute based on classified operation
    let result;
    const params = classification.extractedParams;

    switch (classification.operation) {
      case 'orchestrate':
        // PHASE 50: Add tenantContext for multi-tenant isolation
        result = await orchestrator.orchestrateTask(
          params.task || input,
          {
            maxAgents: params.maxAgents || 3,
            timeout: params.timeout || 60000,
            context: params.context,
            parallel: true,
            tenantContext: req.tenantContext
          }
        );
        break;

      case 'competition':
        result = await orchestrator.runCompetition({
          challenge: params.task || input,
          competitorCount: params.competitorCount || 3,
          timeout: params.timeout || 90000
        });
        break;

      case 'analyze':
        // PHASE 50: Add tenantContext for multi-tenant isolation
        result = await orchestrator.orchestrateTask(
          params.task || input,
          {
            type: 'analysis',
            depth: params.depth || 'standard',
            includeMemory: params.includeMemory !== false,
            timeout: params.timeout || 120000,
            maxAgents: 3,
            parallel: true,
            tenantContext: req.tenantContext
          }
        );
        break;

      case 'synthesize':
        result = await orchestrator.orchestrateTask(
          {
            objective: params.objective || 'Synthesize information',
            sources: params.sources || [input],
            format: params.format || 'summary'
          },
          {
            type: 'synthesis',
            timeout: params.timeout || 60000,
            maxAgents: 2,
            parallel: true,
            // PHASE 50: Add tenantContext for multi-tenant isolation
            tenantContext: req.tenantContext
          }
        );
        break;

      case 'collaborate':
        result = await orchestrator.orchestrateTask(
          {
            objective: params.objective || input,
            agents: params.agents
          },
          {
            type: 'collaboration',
            timeout: params.timeout || 180000,
            maxAgents: params.agents?.length || 4,
            parallel: true,
            // PHASE 50: Add tenantContext for multi-tenant isolation
            tenantContext: req.tenantContext
          }
        );
        break;

      case 'search':
        const searchQuery = typeof params === 'object' && 'query' in params ? (params as any).query :
                           typeof params === 'object' && 'task' in params ? (params as any).task :
                           typeof input === 'string' ? input : JSON.stringify(input);
        const searchResults = await graphRAGClient.search({
          query: searchQuery,
          limit: (params as any).limit || 10,
          filters: { tags: (params as any).tags }
        });
        result = {
          operation: 'search',
          results: searchResults,
          count: searchResults.length,
          source: 'GraphRAG'
        };
        break;

      case 'store':
        const contentToStore = typeof params === 'object' && (params as any).content ? (params as any).content :
                              typeof input === 'string' ? input : JSON.stringify(input);
        const stored = await graphRAGClient.storeMemory({
          content: contentToStore,
          tags: (params as any).tags,
          metadata: (params as any).metadata
        });
        result = {
          operation: 'store',
          stored,
          message: 'Information stored successfully',
          source: 'GraphRAG'
        };
        break;

      // PHASE: Universal Request Orchestrator - Multi-service workflow execution
      case 'workflow': {
        // Use TaskManager for async workflow execution
        const wfParams = params as any; // Dynamic params from LLM extraction
        if (taskManager) {
          const workflowTaskId = await taskManager.createTask('workflow', {
            objective: wfParams.task || input,
            context: {
              ...wfParams.context,
              metadata: wfParams.metadata
            },
            constraints: {
              mode: wfParams.mode || 'best-effort',
              priority: wfParams.priority || 'normal',
              timeout: wfParams.timeout || 300000
            }
          }, {
            timeout: wfParams.timeout || 300000,
            priority: wfParams.priority === 'high' ? 1 : wfParams.priority === 'critical' ? 2 : 0,
            tenantContext: req.tenantContext
          });

          result = {
            operation: 'workflow',
            taskId: workflowTaskId,
            status: 'queued',
            message: 'Workflow task created. Use /api/tasks/{taskId} to check status.',
            async: true
          };
        } else {
          throw new OperationError('TaskManager unavailable for workflow execution');
        }
        break;
      }

      case 'file_process': {
        // Use TaskManager for async file processing
        const fpParams = params as any; // Dynamic params from LLM extraction
        if (taskManager) {
          const fileTaskId = await taskManager.createTask('file_process', {
            objective: fpParams.task || 'Process file',
            context: {
              fileUrl: fpParams.fileUrl || fpParams.url,
              driveUrl: fpParams.driveUrl,
              filename: fpParams.filename,
              mimeType: fpParams.mimeType,
              options: fpParams.options,
              operations: fpParams.operations || ['extract_content']
            },
            constraints: {
              priority: fpParams.priority || 'normal',
              timeout: fpParams.timeout || 300000
            }
          }, {
            timeout: fpParams.timeout || 300000,
            tenantContext: req.tenantContext
          });

          result = {
            operation: 'file_process',
            taskId: fileTaskId,
            status: 'queued',
            message: 'File processing task created. Use /api/tasks/{taskId} to check status.',
            async: true
          };
        } else {
          throw new OperationError('TaskManager unavailable for file processing');
        }
        break;
      }

      case 'security_scan': {
        // Use TaskManager for async security scanning
        const ssParams = params as any; // Dynamic params from LLM extraction
        if (taskManager) {
          const scanTaskId = await taskManager.createTask('security_scan', {
            objective: ssParams.task || 'Security scan',
            context: {
              target: ssParams.target || ssParams.url || ssParams.fileUrl,
              scanType: ssParams.scanType || 'malware',
              tools: ssParams.tools || ['yara', 'clamav'],
              sandboxTier: ssParams.sandboxTier || 'tier1',
              config: ssParams.config
            },
            constraints: {
              priority: ssParams.priority || 'normal',
              timeout: ssParams.timeout || 180000
            }
          }, {
            timeout: ssParams.timeout || 180000,
            tenantContext: req.tenantContext
          });

          result = {
            operation: 'security_scan',
            taskId: scanTaskId,
            status: 'queued',
            message: 'Security scan task created. Use /api/tasks/{taskId} to check status.',
            async: true
          };
        } else {
          throw new OperationError('TaskManager unavailable for security scanning');
        }
        break;
      }

      case 'code_execute': {
        // Use TaskManager for async code execution
        const ceParams = params as any; // Dynamic params from LLM extraction
        if (taskManager) {
          const execTaskId = await taskManager.createTask('code_execute', {
            objective: ceParams.task || 'Execute code',
            context: {
              code: ceParams.code,
              language: ceParams.language,
              packages: ceParams.packages || [],
              files: ceParams.files || [],
              timeout: ceParams.codeTimeout || 60000,
              resourceLimits: ceParams.resourceLimits
            },
            constraints: {
              priority: ceParams.priority || 'normal',
              timeout: ceParams.timeout || 120000
            }
          }, {
            timeout: ceParams.timeout || 120000,
            tenantContext: req.tenantContext
          });

          result = {
            operation: 'code_execute',
            taskId: execTaskId,
            status: 'queued',
            message: 'Code execution task created. Use /api/tasks/{taskId} to check status.',
            async: true
          };
        } else {
          throw new OperationError('TaskManager unavailable for code execution');
        }
        break;
      }

      default:
        throw new OperationError('Operation not supported', {
          operation: classification.operation
        });
    }

    return ApiResponse.success(res, {
      operation: classification.operation,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      result
    }, {
      processingTime: (req as any).startTime ? Date.now() - (req as any).startTime : undefined,
      parallel: true
    });
  })
);

// Collaboration endpoint - multi-agent iterative collaboration
// PHASE 53: Added extractTenantContext middleware for multi-tenant isolation
router.post('/collaborate',
  extractTenantContext,  // PHASE 53: Extract tenant context BEFORE request processing
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  fieldCompatibilityMiddleware,
  responseFieldCompatibilityMiddleware,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { objective, agents, iterations = 2 } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!objective) {
      throw new ValidationError('Objective is required', {
        acceptedFields: ['objective', 'task', 'goal']
      });
    }

    // Default agent configuration if not provided
    const agentConfig = agents || [
      { role: 'research', focus: 'information gathering' },
      { role: 'synthesis', focus: 'integration and analysis' }
    ];

    const collaborationParams = {
      objective,
      agents: agentConfig,
      iterations: Math.min(iterations, 5),
      timeout: req.body.timeout || 180000
    };

    // Use TaskManager for async pattern if available and requested
    if (taskManager && asyncMode) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('collaborate', collaborationParams, {
        timeout: collaborationParams.timeout,
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        'Collaboration task created',
        { estimatedDuration: `${iterations * 60} seconds (${iterations} iterations)` }
      );
    }

    // Execute collaboration
    const result = await orchestrator.orchestrateTask(objective, {
      type: 'collaboration',
      agents: agentConfig,
      iterations,
      timeout: collaborationParams.timeout,
      collaborationMode: true,
      // PHASE 50: Add tenantContext for multi-tenant isolation
      tenantContext: req.tenantContext
    });

    return ApiResponse.success(res, {
      objective,
      iterations: result.iterations || iterations,
      agents: result.agents,
      result: result.result,
      consensus: result.consensus,
      insights: result.insights
    });
  })
);

// Competition endpoint - simplified
router.post('/competition',
  extractTenantContext,
  apiRateLimiters.competition,
  sanitizeInputs,
  fieldCompatibilityMiddleware,
  responseFieldCompatibilityMiddleware,
  validateSchema(validationSchemas.competition),
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { challenge, competitorCount = 3, models, timeout } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!challenge) {
      throw new ValidationError('Challenge is required', {
        acceptedFields: ['challenge', 'prompt', 'task', 'question']
      });
    }

    const competitionParams = {
      challenge,
      competitorCount,
      models,
      timeout: timeout || 120000
    };

    // Use TaskManager for async if requested
    if (taskManager && asyncMode) {
      try {
        // PHASE 28: Add comprehensive error handling
        logger.info('[PHASE28-ROUTE] Creating competition task', {
          endpoint: '/competition',
          challenge: challenge.substring(0, 100),
          competitorCount,
          timeout: competitionParams.timeout
        });

        // PHASE 31: Pass tenantContext for async propagation
        const taskId = await taskManager.createTask('compete', competitionParams, {
          tenantContext: req.tenantContext
        });

        logger.info('[PHASE28-ROUTE] Competition task created successfully', {
          endpoint: '/competition',
          taskId
        });

        return ApiResponse.accepted(res, taskId, `/api/tasks/${taskId}`, 'Competition task created');
      } catch (error: any) {
        logger.error('[PHASE28-ROUTE] Failed to create competition task', {
          endpoint: '/competition',
          error: error.message,
          stack: error.stack,
          taskManagerAvailable: !!taskManager
        });

        throw ErrorFactory.internalError(
          'Failed to create competition task',
          {
            error: error.message,
            suggestion: 'Check if MageAgent service is properly initialized and Bull queue is connected'
          }
        );
      }
    }

    // Run competition with timeout
    const result = await orchestrator.runCompetition(competitionParams);

    // Create tenant-scoped GraphRAG client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    // Store results in GraphRAG
    await graphRAGClient.storeMemory({
      content: JSON.stringify({
        competitionId: result.competitionId,
        winner: result.winner.agentId,
        result: result,
        patterns: result.patterns
      }),
      tags: ['competition', 'mageagent', result.competitionId],
      metadata: {
        type: 'competition-result',
        timestamp: new Date().toISOString()
      }
    });

    return ApiResponse.success(res, {
      competitionId: result.competitionId,
      winner: result.winner,
      rankings: result.rankings,
      consensus: result.consensus,
      realtime: {
        note: 'Competition results stored in GraphRAG',
        websocket: 'ws://graphrag:8090/graphrag',
        query: `competition:${result.competitionId}`
      }
    });
  })
);

// Agent management
router.get('/agents',
  sanitizeInputs,
  asyncHandler(async (_req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const agents = await orchestrator.getActiveAgents();

    return ApiResponse.success(res, {
      agents,
      count: agents.length
    });
  })
);

// Analysis endpoint - deep analysis using specialized agents
// PHASE 53: Added extractTenantContext middleware to ensure req.tenantContext is populated
router.post('/analyze',
  extractTenantContext,  // PHASE 53: Extract tenant context BEFORE request processing
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { topic, depth = 'standard', includeMemory = true } = req.body;
    // PHASE 54: Change default to async mode to prevent timeouts
    // Only use sync mode if explicitly requested via sync=true parameter
    const syncMode = req.body.sync === true || req.query.sync === 'true';

    if (!topic) {
      throw new ValidationError('Topic is required', {
        acceptedFields: ['topic', 'subject', 'query']
      });
    }

    const analysisParams = {
      topic,
      depth,
      includeMemory,
      timeout: req.body.timeout || 120000
    };

    // PHASE 54: Use async mode by default when TaskManager is available
    // Only fall back to sync if explicitly requested or TaskManager unavailable
    if (taskManager && !syncMode) {
      try {
        // PHASE 28: Add comprehensive error handling
        // PHASE 54: Enhanced logging to show async is default mode
        logger.info('[PHASE54-ROUTE] Creating analysis task (async mode - default)', {
          endpoint: '/analyze',
          topic: topic.substring(0, 100),
          depth,
          timeout: analysisParams.timeout,
          mode: 'async',
          reason: syncMode ? 'explicit sync request' : 'default async mode'
        });

        // PHASE 31: Pass tenantContext for async propagation
        const taskId = await taskManager.createTask('analyze', analysisParams, {
          tenantContext: req.tenantContext
        });

        logger.info('[PHASE28-ROUTE] Analysis task created successfully', {
          endpoint: '/analyze',
          taskId
        });

        return ApiResponse.accepted(
          res,
          taskId,
          `/api/tasks/${taskId}`,
          'Analysis task created',
          { estimatedDuration: depth === 'deep' ? '5-10 minutes' : '2-5 minutes' }
        );
      } catch (error: any) {
        logger.error('[PHASE28-ROUTE] Failed to create analysis task', {
          endpoint: '/analyze',
          error: error.message,
          stack: error.stack,
          taskManagerAvailable: !!taskManager
        });

        throw ErrorFactory.internalError(
          'Failed to create analysis task',
          {
            error: error.message,
            suggestion: 'Check if MageAgent service is properly initialized and Bull queue is connected'
          }
        );
      }
    }

    // PHASE 54: Log synchronous execution (fallback mode)
    logger.warn('[PHASE54-ROUTE] Executing analysis in synchronous mode', {
      endpoint: '/analyze',
      topic: topic.substring(0, 100),
      depth,
      timeout: analysisParams.timeout,
      mode: 'synchronous',
      reason: syncMode
        ? 'explicitly requested by user'
        : 'TaskManager not available',
      warning: 'May timeout for long-running analyses (>120s)'
    });

    // Execute analysis
    // PHASE 50: Add tenantContext for multi-tenant isolation in sync path
    const result = await orchestrator.orchestrateTask(
      `Perform ${depth} analysis on: ${topic}`,
      {
        type: 'analysis',
        depth,
        includeMemory,
        timeout: analysisParams.timeout,
        maxAgents: depth === 'deep' ? 5 : 3,
        tenantContext: req.tenantContext
      }
    );

    return ApiResponse.success(res, {
      topic,
      depth,
      analysis: result.result,
      insights: result.insights,
      sources: result.sources,
      confidence: result.confidence
    });
  })
);

// Synthesis endpoint - combine information from multiple sources
// PHASE 53: Added extractTenantContext middleware for multi-tenant isolation
router.post('/synthesize',
  extractTenantContext,  // PHASE 53: Extract tenant context BEFORE request processing
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { sources, objective, format = 'summary' } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!sources || !Array.isArray(sources) || sources.length === 0) {
      throw new ValidationError('Sources array is required', {
        acceptedFields: ['sources'],
        example: { sources: ['source1', 'source2', 'source3'] }
      });
    }

    const synthesisParams = {
      sources,
      objective: objective || 'Synthesize information',
      format,
      timeout: req.body.timeout || 60000
    };

    // Use TaskManager for async if requested
    if (taskManager && asyncMode) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('synthesize', synthesisParams, {
        tenantContext: req.tenantContext
      });
      return ApiResponse.accepted(res, taskId, `/api/tasks/${taskId}`, 'Synthesis task created');
    }

    // Execute synthesis
    const result = await orchestrator.orchestrateTask(
      {
        objective: synthesisParams.objective,
        sources: synthesisParams.sources,
        format: synthesisParams.format
      },
      {
        type: 'synthesis',
        timeout: synthesisParams.timeout,
        maxAgents: 2,
        // PHASE 50: Add tenantContext for multi-tenant isolation
        tenantContext: req.tenantContext
      }
    );

    return ApiResponse.success(res, {
      objective: synthesisParams.objective,
      sourcesAnalyzed: sources.length,
      format,
      synthesis: result.result,
      keyPoints: result.keyPoints,
      confidence: result.confidence
    });
  })
);

// Vision/OCR endpoint - async task pattern with job tracking
router.post('/vision/extract-text',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, format = 'base64', preferAccuracy = false, language, metadata } = req.body;

    if (!image) {
      throw new ValidationError('Image is required', {
        acceptedFields: ['image', 'format', 'preferAccuracy', 'language', 'metadata'],
        example: {
          image: '<base64-encoded-image-data>',
          format: 'base64',
          preferAccuracy: true,
          language: 'en'
        }
      });
    }

    // Validate format
    if (!['base64', 'url', 'buffer'].includes(format)) {
      throw new ValidationError('Invalid format', {
        acceptedValues: ['base64', 'url', 'buffer'],
        provided: format
      });
    }

    logger.info('[Vision OCR] Text extraction request', {
      format,
      preferAccuracy,
      language,
      imageSize: typeof image === 'string' ? image.length : 0
    });

    const visionRequest = {
      image,
      format,
      preferAccuracy,
      language,
      metadata,
      jobId: undefined // Public endpoint doesn't track FileProcess jobs
    };

    // ALWAYS use async mode for MageAgent operations (OpenRouter takes long time)
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('vision_ocr', visionRequest, {
        timeout: 120000,
        priority: preferAccuracy ? 1 : 0,  // High accuracy = higher priority
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        'Vision OCR task created successfully. Use WebSocket or poll task endpoint for results.',
        {
          estimatedDuration: preferAccuracy ? '10-45 seconds' : '5-30 seconds',
          modelSelection: preferAccuracy ? 'Claude Opus 4 (highest accuracy)' : 'GPT-4o (balanced)',
          websocket: {
            url: 'ws://graphrag:8090/graphrag',
            subscribe: `vision:${taskId}`,
            note: 'Connect to WebSocket for real-time progress updates'
          },
          polling: {
            url: `/api/tasks/${taskId}`,
            intervalMs: 1000,
            note: 'Poll this endpoint for task status and result'
          }
        }
      );
    }

    // Fallback if TaskManager unavailable (not recommended)
    const { visionService } = await import('../services/vision-service');
    const result = await visionService.extractText(visionRequest);

    return ApiResponse.success(res, {
      text: result.text,
      confidence: result.confidence,
      modelUsed: result.modelUsed,
      processingTime: result.processingTime,
      metadata: result.metadata
    });
  })
);

// Internal vision/OCR endpoint (rate-limit exempt for FileProcess Worker)
// Supports both sync and async modes with job tracking
internalRouter.post('/vision/extract-text',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, format = 'base64', preferAccuracy = false, language, metadata, jobId } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!image) {
      throw new ValidationError('Image is required', {
        acceptedFields: ['image', 'format', 'preferAccuracy', 'language', 'metadata', 'jobId', 'async']
      });
    }

    logger.info('[Internal Vision OCR] Text extraction request from FileProcess Worker', {
      source: req.headers['x-source'] || 'unknown',
      format,
      preferAccuracy,
      language,
      asyncMode,
      jobId: jobId || 'none'
    });

    // Import VisionService
    const { visionService } = await import('../services/vision-service');

    const visionRequest = {
      image,
      format,
      preferAccuracy,
      language,
      metadata: {
        ...metadata,
        jobId,
        source: 'fileprocess-worker'
      },
      jobId
    };

    // ASYNC MODE: Return taskId immediately for job tracking
    if (taskManager && asyncMode) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('vision_ocr', visionRequest, {
        timeout: 60000,
        priority: preferAccuracy ? 1 : 0,
        metadata: { jobId, source: 'fileprocess-worker' },
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        'Vision OCR task created successfully',
        {
          endpoint: 'internal',
          estimatedDuration: preferAccuracy ? '10-30 seconds' : '5-15 seconds',
          modelSelection: preferAccuracy ? 'Claude Opus 4' : 'GPT-4o',
          jobId,
          websocket: {
            url: 'ws://graphrag:8090/graphrag',
            subscribe: `vision:${taskId}`
          }
        }
      );
    }

    // SYNC MODE: Direct VisionService call (faster for small images)
    try {
      const result = await visionService.extractText(visionRequest);

      return ApiResponse.success(res, {
        text: result.text,
        confidence: result.confidence,
        modelUsed: result.modelUsed,
        processingTime: result.processingTime,
        jobId,
        metadata: result.metadata
      }, {
        endpoint: 'internal',
        note: 'Rate limiting bypassed for internal service'
      });
    } catch (visionError: any) {
      // Auto-switch to async on failure
      if (taskManager) {
        logger.warn('[Internal Vision OCR] Sync mode failed, switching to async', {
          error: visionError.message,
          jobId
        });

        // PHASE 31: Pass tenantContext for async propagation
        const taskId = await taskManager.createTask('vision_ocr', visionRequest, {
          timeout: 60000,
          priority: 2, // Higher priority for fallback
          metadata: { jobId, source: 'fileprocess-worker', fallback: true },
          tenantContext: req.tenantContext
        });

        return ApiResponse.accepted(
          res,
          taskId,
          `/api/tasks/${taskId}`,
          'Switched to async mode due to sync failure',
          { endpoint: 'internal', jobId }
        );
      }
      throw visionError;
    }
  })
);

// Internal layout analysis endpoint (rate-limit exempt for FileProcess Worker)
// Phase 2.2: Document layout analysis with 11 element types (99.2% accuracy target)
internalRouter.post('/vision/analyze-layout',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, format = 'base64', language = 'en', jobId } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!image) {
      throw new ValidationError('Image is required', {
        acceptedFields: ['image', 'format', 'language', 'jobId', 'async'],
        example: {
          image: '<base64-encoded-image-data>',
          format: 'base64',
          language: 'en',
          jobId: 'optional-job-id',
          async: false
        }
      });
    }

    logger.info('[Internal Layout Analysis] Request from FileProcess Worker', {
      source: req.headers['x-source'] || 'unknown',
      format,
      language,
      asyncMode,
      imageSize: typeof image === 'string' ? image.length : 0,
      jobId: jobId || 'none'
    });

    // Import VisionService
    const { visionService } = await import('../services/vision-service');

    const visionRequest = {
      image,
      format,
      language,
      metadata: {
        jobId,
        source: 'fileprocess-worker'
      },
      jobId
    };

    // ASYNC MODE: Return taskId immediately for job tracking
    if (taskManager && asyncMode) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('layout_analysis', visionRequest, {
        timeout: 90000, // Layout analysis can take longer
        priority: 1, // High priority for document processing
        metadata: { jobId, source: 'fileprocess-worker' },
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        'Layout analysis task created successfully',
        {
          endpoint: 'internal',
          estimatedDuration: '15-45 seconds',
          modelSelection: 'GPT-4o Vision or Claude Opus 4.6',
          targetAccuracy: '99.2%',
          elementTypes: 11,
          jobId,
          websocket: {
            url: 'ws://graphrag:8090/graphrag',
            subscribe: `layout:${taskId}`
          }
        }
      );
    }

    // SYNC MODE: Direct VisionService call
    try {
      const result = await visionService.analyzeLayout(visionRequest);

      return ApiResponse.success(res, {
        elements: result.elements,
        readingOrder: result.readingOrder,
        confidence: result.confidence,
        modelUsed: result.modelUsed,
        processingTime: result.processingTime,
        jobId,
        stats: {
          totalElements: result.elements.length,
          elementTypes: [...new Set(result.elements.map(e => e.type))],
          avgConfidence: result.elements.length > 0
            ? result.elements.reduce((sum, e) => sum + e.confidence, 0) / result.elements.length
            : 0
        }
      }, {
        endpoint: 'internal',
        note: 'Rate limiting bypassed for internal service'
      });
    } catch (layoutError: any) {
      // Auto-switch to async on failure
      if (taskManager) {
        logger.warn('[Internal Layout Analysis] Sync mode failed, switching to async', {
          error: layoutError.message,
          jobId
        });

        // PHASE 31: Pass tenantContext for async propagation
        const taskId = await taskManager.createTask('layout_analysis', visionRequest, {
          timeout: 90000,
          priority: 2, // Higher priority for fallback
          metadata: { jobId, source: 'fileprocess-worker', fallback: true },
          tenantContext: req.tenantContext
        });

        return ApiResponse.accepted(
          res,
          taskId,
          `/api/tasks/${taskId}`,
          'Switched to async mode due to sync failure',
          { endpoint: 'internal', jobId }
        );
      }
      throw layoutError;
    }
  })
);

// Internal table extraction endpoint (rate-limit exempt for FileProcess Worker)
// Phase 2.3: Table structure extraction with 97.9% accuracy target
internalRouter.post('/vision/extract-table',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, format = 'base64', language = 'en', jobId } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!image) {
      throw new ValidationError('Image is required', {
        acceptedFields: ['image', 'format', 'language', 'jobId', 'async'],
        example: {
          image: '<base64-encoded-image-data>',
          format: 'base64',
          language: 'en',
          jobId: 'optional-job-id',
          async: false
        }
      });
    }

    logger.info('[Internal Table Extraction] Request from FileProcess Worker', {
      source: req.headers['x-source'] || 'unknown',
      format,
      language,
      asyncMode,
      imageSize: typeof image === 'string' ? image.length : 0,
      jobId: jobId || 'none'
    });

    // Import VisionService
    const { visionService } = await import('../services/vision-service.js');

    const visionRequest = {
      image,
      format,
      language,
      metadata: {
        jobId,
        source: 'fileprocess-worker'
      },
      jobId
    };

    // ASYNC MODE: Return taskId immediately for job tracking
    if (taskManager && asyncMode) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('table_extraction', visionRequest, {
        timeout: 90000, // Table extraction can take longer
        priority: 1, // High priority for document processing
        metadata: { jobId, source: 'fileprocess-worker' },
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        'Table extraction task created successfully',
        {
          endpoint: 'internal',
          estimatedDuration: '15-45 seconds',
          modelSelection: 'GPT-4o Vision or Claude Opus 4.6',
          targetAccuracy: '97.9%',
          jobId,
          websocket: {
            url: 'ws://graphrag:8090/graphrag',
            subscribe: `table:${taskId}`
          }
        }
      );
    }

    // SYNC MODE: Direct VisionService call
    try {
      const result = await visionService.extractTable(visionRequest);

      return ApiResponse.success(res, {
        rows: result.rows,
        columns: result.columns,
        confidence: result.confidence,
        modelUsed: result.modelUsed,
        processingTime: result.processingTime,
        jobId,
        stats: {
          totalRows: result.rows.length,
          totalColumns: result.columns,
          totalCells: result.rows.reduce((sum, row) => sum + row.cells.length, 0),
          headerRows: result.rows.filter(row => row.isHeader).length,
          avgConfidence: result.rows.length > 0
            ? result.rows.reduce((sum, row) =>
                sum + row.cells.reduce((cellSum, cell) => cellSum + cell.confidence, 0) / row.cells.length
              , 0) / result.rows.length
            : 0
        }
      }, {
        endpoint: 'internal',
        note: 'Rate limiting bypassed for internal service'
      });
    } catch (tableError: any) {
      // Auto-switch to async on failure
      if (taskManager) {
        logger.warn('[Internal Table Extraction] Sync mode failed, switching to async', {
          error: tableError.message,
          jobId
        });

        // PHASE 31: Pass tenantContext for async propagation
        const taskId = await taskManager.createTask('table_extraction', visionRequest, {
          timeout: 90000,
          priority: 2, // Higher priority for fallback
          metadata: { jobId, source: 'fileprocess-worker', fallback: true },
          tenantContext: req.tenantContext
        });

        return ApiResponse.accepted(
          res,
          taskId,
          `/api/tasks/${taskId}`,
          'Switched to async mode due to sync failure',
          { endpoint: 'internal', jobId }
        );
      }
      throw tableError;
    }
  })
);

// Internal file-process endpoint for PDFs and documents (rate-limit exempt for FileProcess Worker)
// Handles PDF → text conversion using pdf-parse library for efficient text extraction
// Falls back to Vision OCR only for scanned PDFs that need OCR
internalRouter.post('/file-process',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { fileBuffer, filename, mimeType, operations = ['extract_content'], options = {} } = req.body;

    if (!fileBuffer) {
      throw new ValidationError('fileBuffer is required (base64 encoded)', {
        acceptedFields: ['fileBuffer', 'filename', 'mimeType', 'operations', 'options'],
        example: {
          fileBuffer: '<base64-encoded-file>',
          filename: 'document.pdf',
          mimeType: 'application/pdf',
          operations: ['extract_content', 'extract_tables'],
          options: { enableOcr: true, extractTables: true }
        }
      });
    }

    const startTime = Date.now();
    logger.info('[Internal FileProcess] Document processing request from FileProcess Worker', {
      source: req.headers['x-source'] || 'fileprocess-worker',
      filename,
      mimeType,
      operations,
      options,
      bufferSize: typeof fileBuffer === 'string' ? fileBuffer.length : 0
    });

    // Decode base64 buffer
    const buffer = Buffer.from(fileBuffer, 'base64');
    logger.info('[Internal FileProcess] Decoded buffer', { size: buffer.length });

    let extractedText = '';
    let pages: { pageNumber: number; text: string; confidence: number }[] = [];
    let tables: any[] = [];
    let pageCount = 1;
    let confidence = 0.95;
    let modelUsed = 'pdf.js-extract';

    // Handle PDF files - use pdf.js-extract for PER-PAGE text extraction
    if (mimeType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
      try {
        // Use pdf.js-extract library for per-page text extraction
        const { PDFExtract } = await import('pdf.js-extract');
        const pdfExtract = new PDFExtract();

        logger.info('[Internal FileProcess] Processing PDF via pdf.js-extract (per-page)', {
          filename,
          bufferSize: buffer.length
        });

        // Extract text using buffer - pdf.js-extract provides per-page data
        const pdfData = await new Promise<any>((resolve, reject) => {
          pdfExtract.extractBuffer(buffer, { normalizeWhitespace: true }, (err: Error | null, data: any) => {
            if (err) reject(err);
            else resolve(data);
          });
        });

        pageCount = pdfData.pdfInfo?.numPages || pdfData.pages?.length || 1;

        // Extract text from each page individually
        pages = pdfData.pages.map((page: any, index: number) => {
          // Combine all text items from the page's content array
          const pageText = page.content
            .map((item: any) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')  // Normalize whitespace
            .trim();

          return {
            pageNumber: page.pageInfo?.num || index + 1,
            text: pageText,
            confidence: 0.95
          };
        });

        // Combine all page text for the full document text
        extractedText = pages.map(p => p.text).join('\n\n');
        confidence = 0.95;

        logger.info('[Internal FileProcess] PDF processed via pdf.js-extract', {
          filename,
          textLength: extractedText.length,
          pageCount,
          pagesExtracted: pages.length,
          samplePageLengths: pages.slice(0, 3).map(p => ({ page: p.pageNumber, length: p.text.length })),
          pdfInfo: {
            fingerprint: pdfData.pdfInfo?.fingerprint,
            title: pdfData.meta?.metadata?.['dc:title'],
            author: pdfData.meta?.metadata?.['dc:creator']
          }
        });

        // If no text extracted, the PDF might be scanned - try Vision OCR
        if (!extractedText || extractedText.trim().length < 50) {
          logger.info('[Internal FileProcess] PDF has minimal text, attempting Vision OCR for scanned content', {
            filename,
            textLength: extractedText?.length || 0
          });

          // For scanned PDFs, we would need to:
          // 1. Convert PDF pages to images (requires pdf2pic or similar)
          // 2. Run Vision OCR on each image
          // This is a more complex operation - for now, return what we have
          // with a note that it may be a scanned document

          if (!extractedText || extractedText.trim().length === 0) {
            // Truly empty - likely a scanned PDF
            logger.warn('[Internal FileProcess] PDF appears to be scanned (no extractable text)', { filename });
            throw new OperationError('PDF appears to be scanned with no extractable text', {
              filename,
              suggestion: 'This PDF may contain scanned images. OCR processing for scanned PDFs requires PDF-to-image conversion which is not yet supported.',
              extractedTextLength: 0
            });
          }
        }

      } catch (pdfError: any) {
        // Check if this is our own OperationError (scanned PDF)
        if (pdfError instanceof OperationError) {
          throw pdfError;
        }

        logger.error('[Internal FileProcess] pdf.js-extract failed for PDF', {
          error: pdfError.message,
          filename
        });

        // Return error with details
        throw new OperationError('PDF processing via pdf.js-extract failed', {
          originalError: pdfError.message,
          filename,
          suggestion: 'The PDF may be corrupted, encrypted, or in an unsupported format'
        });
      }
    } else if (mimeType === 'application/epub+zip' || filename?.toLowerCase().endsWith('.epub')) {
      // Handle EPUB files - extract chapters and combine text
      try {
        const EPub = (await import('epub2')).default;
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');

        // epub2 requires a file path, so write buffer to temp file
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `epub_${Date.now()}_${Math.random().toString(36).slice(2)}.epub`);

        logger.info('[Internal FileProcess] Processing EPUB via epub2', {
          filename,
          bufferSize: buffer.length,
          tempFile
        });

        // Write buffer to temp file
        fs.writeFileSync(tempFile, buffer);

        try {
          const epub = await EPub.createAsync(tempFile);

          // Get all chapters/sections in reading order
          const flow = epub.flow || [];
          const chapters: { id: string; order: number; title?: string; text: string }[] = [];

          // Extract text from each chapter
          for (let i = 0; i < flow.length; i++) {
            const chapter = flow[i];
            try {
              const chapterContent = await new Promise<string>((resolve, reject) => {
                epub.getChapter(chapter.id, (err: Error | null, text: string) => {
                  if (err) reject(err);
                  else resolve(text || '');
                });
              });

              // Strip HTML tags to get plain text
              const plainText = chapterContent
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')  // Remove style tags
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // Remove script tags
                .replace(/<[^>]+>/g, ' ')  // Remove HTML tags
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#\d+;/g, '')  // Remove numeric entities
                .replace(/\s+/g, ' ')  // Normalize whitespace
                .trim();

              if (plainText.length > 0) {
                chapters.push({
                  id: chapter.id,
                  order: i + 1,
                  title: chapter.title,
                  text: plainText
                });
              }
            } catch (chapterErr) {
              logger.warn('[Internal FileProcess] Failed to extract EPUB chapter', {
                chapterId: chapter.id,
                error: (chapterErr as Error).message
              });
            }
          }

          // Convert chapters to pages structure (each chapter = 1 page)
          pageCount = chapters.length || 1;
          pages = chapters.map((ch, idx) => ({
            pageNumber: idx + 1,
            text: ch.text,
            confidence: 0.95
          }));

          // Combine all chapter text
          extractedText = chapters.map(ch => ch.text).join('\n\n');
          modelUsed = 'epub2';
          confidence = 0.95;

          // Get metadata if available
          const metadata = {
            title: epub.metadata?.title,
            creator: epub.metadata?.creator,
            publisher: epub.metadata?.publisher,
            language: epub.metadata?.language,
            date: epub.metadata?.date
          };

          logger.info('[Internal FileProcess] EPUB processed via epub2', {
            filename,
            textLength: extractedText.length,
            chaptersExtracted: chapters.length,
            metadata,
            sampleChapterLengths: chapters.slice(0, 3).map(ch => ({
              order: ch.order,
              title: ch.title,
              length: ch.text.length
            }))
          });

        } finally {
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
          } catch (cleanupErr) {
            logger.warn('[Internal FileProcess] Failed to cleanup temp EPUB file', { tempFile });
          }
        }

        if (!extractedText || extractedText.trim().length === 0) {
          throw new OperationError('EPUB appears to have no extractable text content', {
            filename,
            suggestion: 'The EPUB may be DRM-protected or use an unsupported format'
          });
        }

      } catch (epubError: any) {
        if (epubError instanceof OperationError) {
          throw epubError;
        }

        logger.error('[Internal FileProcess] EPUB extraction failed', {
          error: epubError.message,
          filename
        });

        throw new OperationError('EPUB processing failed', {
          originalError: epubError.message,
          filename,
          suggestion: 'The EPUB may be corrupted, DRM-protected, or in an unsupported format'
        });
      }
    } else {
      // For non-PDF/non-EPUB files, treat as plain text
      extractedText = buffer.toString('utf-8');
      pageCount = 1;
      pages = [{ pageNumber: 1, text: extractedText, confidence: 1.0 }];
      modelUsed = 'direct-text';
      confidence = 1.0;
    }

    const processingTime = Date.now() - startTime;

    return ApiResponse.success(res, {
      text: extractedText,
      pages,
      tables,
      metadata: {
        filename,
        mimeType,
        fileSize: buffer.length,
        operations
      },
      pageCount,
      confidence,
      modelUsed,
      processingTime
    }, {
      endpoint: 'internal',
      note: 'Rate limiting bypassed for internal service'
    });
  })
);

// ============================================================================
// VIDEOAGENT SUPPORT ENDPOINTS (Phase 1 Remediation)
// ============================================================================

/**
 * POST /vision/analyze
 *
 * General-purpose image analysis (objects, scenes, context)
 * Used by VideoAgent for frame understanding
 */
router.post('/vision/analyze',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { image, format = 'base64', detail_level = 'standard', metadata } = req.body;

    if (!image) {
      throw new ValidationError('Image is required', {
        acceptedFields: ['image', 'format', 'detail_level', 'metadata'],
        example: {
          image: '<base64-encoded-image-data>',
          format: 'base64',
          detail_level: 'standard'
        }
      });
    }

    logger.info('[Vision Analysis] Image analysis request', {
      format,
      detail_level,
      imageSize: typeof image === 'string' ? image.length : 0
    });

    const visionRequest = {
      image,
      format,
      detail_level,
      metadata
    };

    // ALWAYS use async mode for MageAgent operations (OpenRouter takes long time)
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('vision_analysis', visionRequest, {
        timeout: 120000,
        priority: detail_level === 'high' ? 1 : 0,
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        'Vision analysis task created successfully. Use WebSocket or poll task endpoint for results.',
        {
          estimatedDuration: '5-30 seconds',
          modelSelection: 'GPT-4o Vision or Claude Opus 4.6'
        }
      );
    }

    // Fallback if TaskManager unavailable (not recommended)
    const { visionService } = await import('../services/vision-service');
    const result = await visionService.analyzeImage(visionRequest);

    return ApiResponse.success(res, {
      description: result.description,
      objects: result.objects,
      scene_type: result.scene_type,
      confidence: result.confidence,
      modelUsed: result.modelUsed,
      processingTime: result.processingTime
    });
  })
);

/**
 * POST /memory/store
 *
 * Store memory in GraphRAG (convenience endpoint for VideoAgent)
 */
router.post('/memory/store',
  extractTenantContext,
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { content, tags, metadata } = req.body;

    if (!content) {
      throw new ValidationError('Content is required', {
        acceptedFields: ['content', 'tags', 'metadata'],
        example: {
          content: 'Memory content here',
          tags: ['tag1', 'tag2'],
          metadata: { source: 'videoagent' }
        }
      });
    }

    logger.info('[Memory Store] Storing memory via MageAgent proxy', {
      contentLength: content.length,
      tags: tags?.length || 0,
      tenantContext: req.tenantContext
    });

    // Create tenant-scoped GraphRAG client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    const result = await graphRAGClient.storeMemory({
      content,
      tags: tags || [],
      metadata: {
        ...metadata,
        source: 'mageagent-proxy',
        timestamp: new Date().toISOString()
      }
    });

    return ApiResponse.success(res, {
      success: true,
      memory_id: result.id || result.memoryId,
      stored_at: new Date().toISOString()
    });
  })
);

/**
 * POST /embedding/generate
 *
 * Generate embeddings for text (proxy to GraphRAG's VoyageAI embeddings)
 */
router.post('/embedding/generate',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { content, type = 'text', model } = req.body;

    if (!content) {
      throw new ValidationError('Content is required', {
        acceptedFields: ['content', 'type', 'model'],
        example: {
          content: 'Text to generate embeddings for',
          type: 'text',
          model: 'voyage-2'
        }
      });
    }

    logger.info('[Embedding Generate] Generating embeddings', {
      contentLength: typeof content === 'string' ? content.length : 0,
      type,
      model: model || 'default'
    });

    // Note: This is a placeholder - actual embedding generation would require
    // direct GraphRAG API integration or OpenRouter embedding models
    return ApiResponse.success(res, {
      embedding: Array(1024).fill(0.1), // Placeholder 1024-dim embedding
      dimensions: 1024,
      model: model || 'voyage-2',
      type,
      note: 'Placeholder - requires GraphRAG embedding API integration'
    });
  })
);

/**
 * POST /text/classify
 *
 * Classify text into categories
 */
router.post('/text/classify',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { text, categories, metadata } = req.body;

    if (!text || !categories || !Array.isArray(categories)) {
      throw new ValidationError('Text and categories array are required', {
        acceptedFields: ['text', 'categories', 'metadata', 'async'],
        example: {
          text: 'Text to classify',
          categories: ['category1', 'category2'],
          metadata: {},
          async: true
        }
      });
    }

    logger.info('[Text Classification] Classifying text', {
      textLength: text.length,
      categoryCount: categories.length
    });

    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    // ALWAYS use async mode for MageAgent operations (OpenRouter takes long time)
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('text_classification', {
        text,
        categories,
        metadata
      }, {
        timeout: 120000,
        priority: 0,
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(res, taskId, `/api/tasks/${taskId}`,
        'Text classification task created successfully. Use WebSocket or poll task endpoint for results.');
    }

    // Fallback sync mode (not recommended - will likely timeout)
    const prompt = `Classify this text into ONE of these categories: ${categories.join(', ')}.\n\nText: "${text}"\n\nRespond with JSON: {"category": "...", "confidence": 0.XX}`;

    const result = await orchestrator.orchestrateTask(prompt, {
      taskType: 'classification',
      maxTokens: 100,
      // PHASE 50: Add tenantContext for multi-tenant isolation
      tenantContext: req.tenantContext
    });

    // Parse response
    let category = categories[0];
    let confidence = 0.5;
    try {
      const responseText = result.response || result.result || '{}';
      const parsed = JSON.parse(responseText);
      category = parsed.category || category;
      confidence = parsed.confidence || confidence;
    } catch {
      for (const cat of categories) {
        if ((result.response || '').toLowerCase().includes(cat.toLowerCase())) {
          category = cat;
          confidence = 0.7;
          break;
        }
      }
    }

    return ApiResponse.success(res, {
      category,
      confidence,
      all_categories: categories
    });
  })
);

/**
 * POST /text/sentiment
 *
 * Analyze sentiment of text
 */
router.post('/text/sentiment',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { text, granularity = 'simple', metadata } = req.body;

    if (!text) {
      throw new ValidationError('Text is required', {
        acceptedFields: ['text', 'granularity', 'metadata', 'async']
      });
    }

    logger.info('[Text Sentiment] Analyzing sentiment', {
      textLength: text.length
    });

    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    // ALWAYS use async mode for MageAgent operations (OpenRouter takes long time)
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('sentiment_analysis', {
        text,
        granularity,
        metadata
      }, {
        timeout: 120000,
        priority: 0,
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(res, taskId, `/api/tasks/${taskId}`,
        'Sentiment analysis task created successfully. Use WebSocket or poll task endpoint for results.');
    }

    // Fallback sync mode (not recommended - will likely timeout)
    const prompt = `Analyze sentiment. Respond JSON: {"sentiment": "positive|negative|neutral", "score": 0.XX}\n\nText: "${text}"`;

    const result = await orchestrator.orchestrateTask(prompt, {
      taskType: 'sentiment',
      maxTokens: 100,
      // PHASE 50: Add tenantContext for multi-tenant isolation
      tenantContext: req.tenantContext
    });

    let sentiment = 'neutral';
    let score = 0;
    try {
      const parsed = JSON.parse(result.response || result.result || '{}');
      sentiment = parsed.sentiment || sentiment;
      score = parsed.score || score;
    } catch {
      // Fallback
      const lower = text.toLowerCase();
      if (lower.includes('good') || lower.includes('great')) {
        sentiment = 'positive';
        score = 0.7;
      } else if (lower.includes('bad') || lower.includes('terrible')) {
        sentiment = 'negative';
        score = -0.7;
      }
    }

    return ApiResponse.success(res, {
      sentiment,
      score,
      aspects: []
    });
  })
);

/**
 * POST /text/topics
 *
 * Extract topics from text
 */
router.post('/text/topics',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { text, max_topics = 5, metadata } = req.body;

    if (!text) {
      throw new ValidationError('Text is required', {
        acceptedFields: ['text', 'max_topics', 'metadata', 'async']
      });
    }

    logger.info('[Text Topics] Extracting topics', {
      textLength: text.length
    });

    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    // ALWAYS use async mode for MageAgent operations (OpenRouter takes long time)
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('topic_extraction', {
        text,
        max_topics,
        metadata
      }, {
        timeout: 120000,
        priority: 0,
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(res, taskId, `/api/tasks/${taskId}`,
        'Topic extraction task created successfully. Use WebSocket or poll task endpoint for results.');
    }

    // Fallback sync mode (not recommended - will likely timeout)
    const prompt = `Extract ${max_topics} topics. JSON: {"topics": [{"topic": "...", "relevance": 0.XX}]}\n\nText: "${text}"`;

    const result = await orchestrator.orchestrateTask(prompt, {
      taskType: 'topics',
      maxTokens: 200,
      // PHASE 50: Add tenantContext for multi-tenant isolation
      tenantContext: req.tenantContext
    });

    let topics = [];
    try {
      const parsed = JSON.parse(result.response || result.result || '{}');
      topics = parsed.topics || [];
    } catch {
      const words = text.toLowerCase().split(/\s+/);
      const freq: Record<string, number> = {};
      for (const word of words) {
        if (word.length > 4) freq[word] = (freq[word] || 0) + 1;
      }
      topics = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, max_topics)
        .map(([topic, count]) => ({
          topic,
          relevance: Math.min(count / words.length * 10, 1)
        }));
    }

    return ApiResponse.success(res, {
      topics: topics.slice(0, max_topics)
    });
  })
);

/**
 * POST /audio/transcribe
 *
 * Transcribe audio to text
 */
router.post('/audio/transcribe',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { audio, format = 'mp3', language = 'en', timestamps = false } = req.body;
    const asyncMode = req.body.async === true;

    if (!audio) {
      throw new ValidationError('Audio is required');
    }

    logger.info('[Audio Transcribe] Request', {
      format,
      language,
      asyncMode
    });

    if (asyncMode && taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('audio_transcription', {
        audio,
        format,
        language,
        timestamps
      }, { timeout: 120000, tenantContext: req.tenantContext });

      return ApiResponse.accepted(res, taskId, `/api/tasks/${taskId}`, 'Audio transcription task created');
    }

    // Placeholder - requires Whisper API
    return ApiResponse.success(res, {
      text: '[Transcription placeholder - Whisper integration pending]',
      language,
      confidence: 0.0,
      note: 'Requires Whisper API integration'
    });
  })
);

// Model statistics endpoint
router.get('/models/stats',
  sanitizeInputs,
  asyncHandler(async (_req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const stats = orchestrator.getModelStats();

    return ApiResponse.success(res, {
      stats,
      note: 'Model statistics include fallback chains and failure tracking'
    });
  })
);

// Model selection endpoint - dynamic model selection based on task complexity
router.post('/models/select',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { complexity, taskType, maxBudget } = req.body;

    if (complexity === undefined || !taskType) {
      throw new ValidationError('Complexity and taskType are required', {
        acceptedFields: ['complexity', 'taskType', 'maxBudget']
      });
    }

    // Simple model selection logic
    let selectedModel = 'anthropic/claude-opus-4.6';
    let estimatedCost = 0.003;
    let reasoning = 'Default balanced model';

    if (complexity >= 0.8) {
      selectedModel = 'anthropic/claude-opus-4';
      estimatedCost = 0.015;
      reasoning = 'High complexity task requires most capable model';
    } else if (complexity >= 0.5) {
      selectedModel = 'anthropic/claude-opus-4.6';
      estimatedCost = 0.003;
      reasoning = 'Medium complexity, balanced performance/cost';
    } else if (complexity < 0.3) {
      selectedModel = 'anthropic/claude-3-haiku';
      estimatedCost = 0.00025;
      reasoning = 'Low complexity, optimized for speed and cost';
    }

    // Task type specific overrides
    if (taskType === 'code' && complexity >= 0.6) {
      selectedModel = 'anthropic/claude-opus-4';
      reasoning = 'Code tasks benefit from highest reasoning capability';
    } else if (taskType === 'creative_writing') {
      selectedModel = 'anthropic/claude-opus-4.6';
      reasoning = 'Opus excels at creative tasks';
    }

    // Budget constraint
    if (maxBudget !== undefined && estimatedCost > maxBudget) {
      selectedModel = 'anthropic/claude-3-haiku';
      estimatedCost = 0.00025;
      reasoning = `Downgraded to meet budget constraint of $${maxBudget}`;
    }

    return ApiResponse.success(res, {
      model: {
        name: selectedModel,
        provider: 'anthropic',
        estimatedCost,
        estimatedLatency: complexity >= 0.8 ? '5-10s' : '2-5s',
        reasoning
      },
      input: {
        complexity,
        taskType,
        maxBudget
      }
    });
  })
);

router.get('/agents/:agentId',
  sanitizeInputs,
  validators.agentId,
  handleValidationErrors,
  asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = req.params;

    // STEP 1: Check if agent is currently active (in orchestrator)
    if (orchestrator) {
      try {
        const activeAgents = await orchestrator.getActiveAgents();
        const activeAgent = activeAgents.find(
          (a: any) => a.id === agentId || a.agentId === agentId
        );

        if (activeAgent) {
          // Return live agent details
          logger.debug('Returning active agent details', { agentId });
          return ApiResponse.success(res, {
            agentId,
            status: 'active',
            agent: activeAgent
          });
        }
      } catch (error) {
        // If orchestrator fails, fall through to database lookup
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to check active agents, falling back to database', {
          agentId,
          error: errorMessage
        });
      }
    }

    // STEP 2: Fallback to completed agent output (existing logic)
    const output = await databaseManager.getAgentOutput(agentId);

    if (!output) {
      throw ErrorFactory.notFound('Agent', agentId);
    }

    return ApiResponse.success(res, {
      agentId,
      status: 'completed',
      output
    });
  })
);

// Pattern management (delegated to GraphRAG)
router.get('/patterns/:context',
  extractTenantContext,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { context } = req.params;
    const { limit = 5 } = req.query;

    // Create tenant-scoped GraphRAG client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    const patterns = await graphRAGClient.recallMemory({
      query: `patterns context:${context}`,
      limit: parseInt(limit as string, 10),
      tags: ['pattern', context]
    });

    return ApiResponse.success(res, {
      context,
      patterns,
      count: patterns.length,
      source: 'GraphRAG service'
    });
  })
);

// Memory operations (fully delegated to GraphRAG)
router.post('/memory/search',
  extractTenantContext,
  apiRateLimiters.memorySearch,
  sanitizeInputs,
  validateSchema(validationSchemas.memorySearch),
  asyncHandler(async (req: Request, res: Response) => {
    const { query, limit = 10 } = req.body;

    if (!query) {
      throw new ValidationError('Query is required');
    }

    // Create tenant-scoped GraphRAG client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    const results = await graphRAGClient.recallMemory({ query, limit });

    return ApiResponse.success(res, {
      query,
      results,
      count: results.length,
      source: 'GraphRAG service',
      websocket: 'ws://graphrag:8090/graphrag/memory'
    });
  })
);

// WebSocket information endpoint
router.get('/websocket-info', (_req: Request, res: Response) => {
  return ApiResponse.success(res, {
    status: 'WebSocket moved to GraphRAG service',
    migration: {
      reason: 'Proper separation of concerns',
      before: 'MageAgent handled both orchestration and real-time data',
      after: 'MageAgent handles orchestration, GraphRAG handles real-time data'
    },
    graphragWebSocket: {
      url: 'ws://graphrag:8090',
      paths: {
        main: '/graphrag',
        memory: '/graphrag/memory',
        documents: '/graphrag/documents',
        search: '/graphrag/search'
      },
      features: [
        'Real-time memory updates',
        'Document indexing notifications',
        'Search result streaming',
        'Episode tracking'
      ]
    },
    instructions: {
      connection: 'Connect directly to GraphRAG WebSocket service',
      authentication: 'Use same auth tokens as REST API',
      subscription: 'Subscribe to specific resources for updates'
    }
  });
});

// WebSocket stats endpoint - delegated to GraphRAG
router.get('/websocket/stats',
  extractTenantContextOptional,
  asyncHandler(async (req: Request, res: Response) => {
    const wsInfo = {
      message: 'WebSocket functionality is managed by GraphRAG service',
      graphragEndpoint: 'http://graphrag:8090/api/websocket/stats',
      fallback: {
        activeConnections: 0,
        totalMessages: 0,
        uptime: process.uptime(),
        status: 'Delegated to GraphRAG'
      }
    };

    // Try to get actual stats from GraphRAG if tenant context available
    if (req.tenantContext) {
      try {
        const graphRAGClient = createGraphRAGClient(req.tenantContext);
        const graphragStats = await graphRAGClient.getWebSocketStats();
        return ApiResponse.success(res, {
          ...wsInfo,
          graphragStats
        });
      } catch {
        return ApiResponse.success(res, wsInfo);
      }
    }

    return ApiResponse.success(res, wsInfo);
  })
);

// Pattern storage endpoint
router.post('/patterns',
  extractTenantContext,
  apiRateLimiters.memorySearch,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { pattern, context, tags, confidence } = req.body;

    if (!pattern || !context) {
      throw new ValidationError('Pattern and context are required');
    }

    // Create tenant-scoped GraphRAG client
    const graphRAGClient = createGraphRAGClient(req.tenantContext!);

    // Store pattern as a special type of memory in GraphRAG
    const storedPattern = await graphRAGClient.storeMemory({
      content: JSON.stringify({
        pattern,
        context,
        confidence: confidence || 0.5
      }),
      tags: ['pattern', ...(tags || [])],
      metadata: {
        type: 'pattern',
        confidence: confidence || 0.5,
        timestamp: new Date().toISOString()
      }
    });

    return ApiResponse.success(res, {
      patternId: storedPattern.memoryId,
      stored: storedPattern,
      message: 'Pattern stored successfully in GraphRAG'
    });
  })
);

// Task status endpoint - integrated with TaskManager
router.get('/tasks/:taskId',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { taskId } = req.params;

    // Try TaskManager first (for new async tasks)
    if (taskManager) {
      const task = await taskManager.getTaskStatus(taskId);
      if (task) {
        return ApiResponse.success(res, {
          task: {
            id: task.id,
            type: task.type,
            status: task.status,
            progress: task.progress,
            result: task.status === 'completed' ? task.result : undefined,
            error: task.status === 'failed' ? task.error : undefined,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            metadata: task.metadata
          }
        });
      }
    }

    // Fallback to database for legacy tasks
    const taskStatus = await databaseManager.getTaskStatus(taskId);

    if (!taskStatus) {
      throw new NotFoundError('Task not found', {
        resourceType: 'Task',
        resourceId: taskId,
        context: { message: 'This task ID does not exist in either the async queue or historical database' }
      });
    }

    return ApiResponse.success(res, {
      task: {
        id: taskId,
        status: taskStatus.status,
        result: taskStatus.result,
        createdAt: taskStatus.createdAt,
        updatedAt: taskStatus.updatedAt,
        agents: taskStatus.agents || [],
        source: 'database'
      }
    });
  })
);

// Server-Sent Events (SSE) endpoint for real-time task progress streaming
// Enables Nexus API Gateway to subscribe to task progress events
router.get('/tasks/:taskId/stream',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    const { taskId } = req.params;

    // Verify task exists
    if (taskManager) {
      const task = await taskManager.getTaskStatus(taskId);
      if (!task) {
        throw new NotFoundError('Task not found', {
          resourceType: 'Task',
          resourceId: taskId
        });
      }

      // If task already completed or failed, return final state and close
      if (task.status === 'completed' || task.status === 'failed') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'close',
          'X-Accel-Buffering': 'no' // Disable nginx buffering
        });

        const finalEvent = {
          type: task.status === 'completed' ? 'task:complete' : 'task:failed',
          taskId,
          status: task.status,
          progress: 100,
          result: task.result,
          error: task.error,
          timestamp: new Date().toISOString()
        };

        res.write(`event: ${finalEvent.type}\n`);
        res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
        res.end();
        return;
      }
    }

    // Setup SSE headers for streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });

    // Send initial connection confirmation
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ taskId, timestamp: new Date().toISOString() })}\n\n`);

    // Create event listeners for this task
    const progressListener = (event: any) => {
      if (event.id === taskId || event.taskId === taskId) {
        const progressEvent = {
          type: 'task:progress',
          taskId,
          progress: event.progress || 0,
          message: event.message || '',
          metadata: event.metadata || {},
          timestamp: new Date().toISOString()
        };

        res.write(`event: task:progress\n`);
        res.write(`data: ${JSON.stringify(progressEvent)}\n\n`);

        logger.debug('SSE: Sent progress event', { taskId, progress: event.progress });
      }
    };

    const completeListener = (event: any) => {
      if (event.id === taskId || event.taskId === taskId) {
        const completeEvent = {
          type: 'task:complete',
          taskId,
          status: 'completed',
          progress: 100,
          result: event.result,
          timestamp: new Date().toISOString()
        };

        res.write(`event: task:complete\n`);
        res.write(`data: ${JSON.stringify(completeEvent)}\n\n`);
        res.end();

        logger.info('SSE: Task completed, closing stream', { taskId });

        // Cleanup listeners
        if (taskManager) {
          taskManager.off('task:progress', progressListener);
          taskManager.off('task:completed', completeListener);
          taskManager.off('task:failed', failedListener);
        }
      }
    };

    const failedListener = (event: any) => {
      if (event.id === taskId || event.taskId === taskId) {
        const errorEvent = {
          type: 'task:failed',
          taskId,
          status: 'failed',
          error: event.error || 'Unknown error',
          timestamp: new Date().toISOString()
        };

        res.write(`event: task:failed\n`);
        res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
        res.end();

        logger.error('SSE: Task failed, closing stream', { taskId, error: event.error });

        // Cleanup listeners
        if (taskManager) {
          taskManager.off('task:progress', progressListener);
          taskManager.off('task:completed', completeListener);
          taskManager.off('task:failed', failedListener);
        }
      }
    };

    // Register listeners if TaskManager available
    if (taskManager) {
      taskManager.on('task:progress', progressListener);
      taskManager.on('task:completed', completeListener);
      taskManager.on('task:failed', failedListener);

      logger.info('SSE: Client connected to task stream', { taskId });
    } else {
      // No TaskManager - send error and close
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: 'TaskManager not available' })}\n\n`);
      res.end();
      return;
    }

    // Send keepalive ping every 15 seconds to prevent connection timeout
    const keepaliveInterval = setInterval(() => {
      res.write(`:keepalive ${new Date().toISOString()}\n\n`);
    }, 15000);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(keepaliveInterval);

      if (taskManager) {
        taskManager.off('task:progress', progressListener);
        taskManager.off('task:completed', completeListener);
        taskManager.off('task:failed', failedListener);
      }

      logger.info('SSE: Client disconnected from task stream', { taskId });
    });

    // Handle connection errors
    req.on('error', (error) => {
      clearInterval(keepaliveInterval);

      if (taskManager) {
        taskManager.off('task:progress', progressListener);
        taskManager.off('task:completed', completeListener);
        taskManager.off('task:failed', failedListener);
      }

      logger.error('SSE: Connection error', { taskId, error: error.message });
    });
  })
);

// Model validation endpoint
router.post('/validate-model',
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { modelId } = req.body;

    if (!modelId) {
      throw new ValidationError('Model ID is required');
    }

    const isValid = await orchestrator.validateModel(modelId);

    return ApiResponse.success(res, {
      modelId,
      valid: isValid
    });
  })
);

// Code validation endpoint - multi-model consensus validation
router.post('/validation/code',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { code, language, context, riskLevel } = req.body;

    if (!code || !language) {
      throw new ValidationError('Code and language are required', {
        acceptedFields: ['code', 'language', 'context', 'riskLevel']
      });
    }

    const validationId = `val_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Use TaskManager for async execution if available
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('validateCode', { code, language, context, riskLevel }, {
        tenantContext: req.tenantContext
      });
      return ApiResponse.accepted(
        res,
        { validationId, taskId },
        `/api/tasks/${taskId}`,
        'Code validation started',
        { estimatedTime: '8-28 seconds' }
      );
    }

    // Fallback to sync execution
    const result = await orchestrator.orchestrateTask(
      `Validate ${language} code for security and best practices`,
      {
        type: 'validation',
        code: code.substring(0, 200),
        language,
        riskLevel,
        maxAgents: 3,
        // PHASE 50: Add tenantContext for multi-tenant isolation
        tenantContext: req.tenantContext
      }
    );

    return ApiResponse.success(res, { validationId, ...result });
  })
);

// Command validation endpoint
router.post('/validation/command',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { command, cwd, environment } = req.body;

    if (!command) {
      throw new ValidationError('Command is required');
    }

    const validationId = `cmd_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Use TaskManager for async execution
    if (taskManager) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('validateCommand', { command, cwd, environment }, {
        tenantContext: req.tenantContext
      });
      return ApiResponse.accepted(
        res,
        { validationId, taskId },
        `/api/tasks/${taskId}`,
        'Command validation started',
        { estimatedTime: '8-28 seconds' }
      );
    }

    // Fallback to sync execution
    const result = await orchestrator.orchestrateTask(
      `Validate shell command for security risks: ${command.substring(0, 100)}`,
      {
        type: 'validation',
        command,
        cwd,
        maxAgents: 3,
        // PHASE 50: Add tenantContext for multi-tenant isolation
        tenantContext: req.tenantContext
      }
    );

    return ApiResponse.success(res, { validationId, ...result });
  })
);

// Code analysis endpoint - fast single-model analysis
router.post('/code/analyze',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { code, language, focusAreas, depth = 'standard' } = req.body;

    if (!code || !language) {
      throw new ValidationError('Code and language are required');
    }

    const analysisId = `ana_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const result = await orchestrator.orchestrateTask(
      `Analyze ${language} code for ${focusAreas?.join(', ') || 'best practices'}`,
      {
        type: 'analysis',
        code: code.substring(0, 500),
        language,
        focusAreas,
        depth,
        maxAgents: 1,
        // PHASE 50: Add tenantContext for multi-tenant isolation
        tenantContext: req.tenantContext
      }
    );

    return ApiResponse.success(res, { analysisId, ...result });
  })
);

// Sandbox execution endpoint
router.post('/sandbox/execute',
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { code, language, timeout = 30000, context, trigger_learning = true } = req.body;

    if (!code || !language) {
      throw new ValidationError('Code and language are required');
    }

    // Execute via orchestration (orchestrator will handle sandbox routing)
    const result = await orchestrator.orchestrateTask(
      `Execute ${language} code in sandbox`,
      {
        type: 'sandbox_execution',
        code,
        language,
        timeout,
        context,
        trigger_learning,
        maxAgents: 1,
        // PHASE 50: Add tenantContext for multi-tenant isolation
        tenantContext: req.tenantContext
      }
    );

    return ApiResponse.success(res, result);
  })
);

// ============================================================================
// INTERNAL MICROSERVICE ENDPOINTS (RATE-LIMIT EXEMPT)
// ============================================================================
// These endpoints bypass MageAgent's globalRateLimiter to allow high-throughput
// internal microservice communication within the nexus-network.
// ============================================================================

/**
 * Internal orchestration endpoint for trusted microservices
 * PHASE 58n: Added provideSystemTenantContext to enable episode storage for internal calls
 */
internalRouter.post('/orchestrate',
  provideSystemTenantContext,  // PHASE 58n: Provide default tenant context (nexus-system/internal)
  sanitizeInputs,
  fieldCompatibilityMiddleware,
  responseFieldCompatibilityMiddleware,
  validateSchema(validationSchemas.orchestrate),
  asyncHandler(async (req: Request, res: Response) => {
    if (!orchestrator) {
      throw ErrorFactory.serviceUnavailable('Orchestrator');
    }

    const { task, options = {}, timeout, maxAgents, context } = req.body;
    const asyncMode = req.body.async === true || req.query.async === 'true';

    if (!task) {
      throw new ValidationError('Task is required', {
        acceptedFields: ['task', 'prompt', 'query', 'objective'],
        context: { endpoint: 'internal' }
      });
    }

    // Log internal request for monitoring
    logger.info('[Internal Endpoint] Orchestration request from trusted service', {
      source: req.headers['x-source'] || 'unknown',
      requestId: req.headers['x-request-id'],
      task: task.substring(0, 100) + (task.length > 100 ? '...' : ''),
      maxAgents: maxAgents || options.maxAgents || 3,
      timeout: options.timeout || timeout || 600000
    });

    // Merge options with explicit parameters
    const orchestrationOptions = {
      ...options,
      timeout: options.timeout || timeout || 600000,
      maxAgents: maxAgents || options.maxAgents || 3,
      context: context || options.context,
      stream: options.stream || false
    };

    // If timeout is high (>60s) or async mode requested, use async pattern
    const forceAsync = orchestrationOptions.timeout > 60000;

    // If TaskManager available and (async mode requested OR high timeout), use async pattern
    if (taskManager && (asyncMode || forceAsync)) {
      // PHASE 31: Pass tenantContext for async propagation
      const taskId = await taskManager.createTask('orchestrate', {
        task,
        options: orchestrationOptions
      }, {
        timeout: orchestrationOptions.timeout,
        priority: options.priority || 0,
        tenantContext: req.tenantContext
      });

      return ApiResponse.accepted(
        res,
        taskId,
        `/api/tasks/${taskId}`,
        forceAsync ? 'Task requires extended processing time, using async mode' : 'Task created successfully',
        {
          estimatedDuration: 'This task may take 2-10 minutes to complete',
          endpoint: 'internal'
        }
      );
    }

    // For synchronous mode or when TaskManager unavailable, wait with shorter timeout
    const waitTimeout = Math.min(orchestrationOptions.timeout, 30000);

    try {
      const result = await orchestrator.orchestrateTask(task, {
        ...orchestrationOptions,
        timeout: waitTimeout,
        // PHASE 50: Add tenantContext for multi-tenant isolation
        tenantContext: req.tenantContext
      });

      return ApiResponse.success(res, {
        taskId: result.taskId,
        status: result.status,
        agents: result.agents,
        result: result.result
      }, {
        endpoint: 'internal',
        note: 'Rate limiting bypassed for internal service'
      });
    } catch (timeoutError: any) {
      if (timeoutError.message?.includes('timeout') || timeoutError.message?.includes('Timeout')) {
        // If timeout, create async task if TaskManager available
        if (taskManager) {
          // PHASE 31: Pass tenantContext for async propagation
          const taskId = await taskManager.createTask('orchestrate', {
            task,
            options: orchestrationOptions
          }, {
            tenantContext: req.tenantContext
          });

          return ApiResponse.accepted(
            res,
            taskId,
            `/api/tasks/${taskId}`,
            'Task is taking longer than expected, switched to async mode',
            {
              note: 'Use the poll URL to check task status',
              endpoint: 'internal'
            }
          );
        }
        throw new TimeoutError('The orchestration task exceeded the maximum allowed time', {
          timeout: waitTimeout,
          asyncAvailable: true,
          context: { endpoint: 'internal' },
          troubleshooting: {
            openrouter: 'Check OpenRouter client logs for LLM errors',
            taskmanager: 'Check TaskManager queue for async task failures',
            orchestrator: 'Check Orchestrator logs for agent spawning issues'
          }
        });
      }
      throw timeoutError;
    }
  })
);

// =============================================================================
// PHASE: Universal Request Orchestrator Endpoints
// =============================================================================

/**
 * Multi-service workflow execution endpoint
 *
 * Enables natural language requests to be decomposed and executed across
 * multiple Nexus services (FileProcess, CyberAgent, Sandbox, MageAgent).
 *
 * Example requests:
 * - "Download this file, analyze it, and check for viruses"
 * - "Extract the archive, OCR the documents, and summarize them"
 */
router.post('/workflow',
  extractTenantContext,
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!taskManager) {
      throw ErrorFactory.serviceUnavailable('TaskManager');
    }

    const { request, objective, context, options = {} } = req.body;
    const workflowRequest = request || objective;

    if (!workflowRequest) {
      throw new ValidationError('Request or objective is required', {
        acceptedFields: ['request', 'objective'],
        example: {
          request: 'Download https://example.com/report.pdf, extract text, check for viruses, and summarize the content'
        }
      });
    }

    const taskId = await taskManager.createTask('workflow', {
      objective: workflowRequest,
      context: context || {},
      constraints: {
        mode: options.mode || 'best-effort',
        priority: options.priority || 'normal',
        timeout: options.timeout || 300000
      }
    }, {
      timeout: options.timeout || 300000,
      priority: options.priority === 'high' ? 1 : options.priority === 'critical' ? 2 : 0,
      tenantContext: req.tenantContext
    });

    logger.info('Workflow task created', {
      taskId,
      request: workflowRequest.substring(0, 100),
      mode: options.mode || 'best-effort'
    });

    return ApiResponse.accepted(
      res,
      taskId,
      `/api/tasks/${taskId}`,
      'Workflow task created. Multi-service execution will begin shortly.',
      {
        estimatedDuration: 'Varies based on workflow complexity (30s - 5min)',
        services: ['fileprocess', 'cyberagent', 'sandbox', 'mageagent', 'graphrag']
      }
    );
  })
);

/**
 * File processing endpoint
 *
 * Process files from URL or Google Drive with support for:
 * - PDF, Office documents, images
 * - Archive extraction (ZIP, RAR, 7Z, TAR)
 * - OCR processing
 * - Table extraction
 */
router.post('/file-process',
  extractTenantContext,
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!taskManager) {
      throw ErrorFactory.serviceUnavailable('TaskManager');
    }

    const { fileUrl, driveUrl, filename, mimeType, options = {}, operations = [] } = req.body;

    if (!fileUrl && !driveUrl) {
      throw new ValidationError('File URL or Drive URL is required', {
        acceptedFields: ['fileUrl', 'driveUrl'],
        example: {
          fileUrl: 'https://example.com/document.pdf',
          options: { enableOcr: true, extractTables: true }
        }
      });
    }

    if (fileUrl && !filename) {
      throw new ValidationError('Filename is required when using fileUrl', {
        acceptedFields: ['filename'],
        example: { filename: 'document.pdf' }
      });
    }

    const taskId = await taskManager.createTask('file_process', {
      objective: `Process file: ${filename || 'from Drive'}`,
      context: {
        fileUrl,
        driveUrl,
        filename,
        mimeType,
        options,
        operations: operations.length > 0 ? operations : ['extract_content']
      },
      constraints: {
        priority: options.priority || 'normal',
        timeout: options.timeout || 300000
      }
    }, {
      timeout: options.timeout || 300000,
      tenantContext: req.tenantContext
    });

    logger.info('File processing task created', {
      taskId,
      fileUrl: fileUrl || driveUrl,
      operations
    });

    return ApiResponse.accepted(
      res,
      taskId,
      `/api/tasks/${taskId}`,
      'File processing task created.',
      {
        estimatedDuration: 'Varies based on file size (10s - 5min)',
        supportedFormats: ['PDF', 'DOCX', 'XLSX', 'PPTX', 'images', 'archives']
      }
    );
  })
);

/**
 * Security scanning endpoint
 *
 * Scan files and URLs for security threats:
 * - Malware detection
 * - Vulnerability scanning
 * - Threat intelligence lookup
 * - YARA rule matching
 */
router.post('/security-scan',
  extractTenantContext,
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!taskManager) {
      throw ErrorFactory.serviceUnavailable('TaskManager');
    }

    const { target, scanType = 'malware', tools, sandboxTier, config = {} } = req.body;

    if (!target) {
      throw new ValidationError('Target is required', {
        acceptedFields: ['target'],
        example: {
          target: 'https://example.com/suspicious-file.exe',
          scanType: 'malware',
          tools: ['yara', 'clamav'],
          sandboxTier: 'tier2'
        }
      });
    }

    const taskId = await taskManager.createTask('security_scan', {
      objective: `Security scan: ${scanType}`,
      context: {
        target,
        scanType,
        tools: tools || ['yara', 'clamav'],
        sandboxTier: sandboxTier || 'tier1',
        config
      },
      constraints: {
        priority: config.priority || 'normal',
        timeout: config.timeout || 180000
      }
    }, {
      timeout: config.timeout || 180000,
      tenantContext: req.tenantContext
    });

    logger.info('Security scan task created', {
      taskId,
      target: target.substring(0, 100),
      scanType,
      tools: tools || ['yara', 'clamav']
    });

    return ApiResponse.accepted(
      res,
      taskId,
      `/api/tasks/${taskId}`,
      'Security scan task created.',
      {
        estimatedDuration: 'Varies based on scan type (30s - 3min)',
        scanTypes: ['malware', 'vulnerability', 'threat_intel', 'apt'],
        availableTools: ['yara', 'clamav', 'cuckoo', 'volatility', 'nmap', 'nuclei']
      }
    );
  })
);

/**
 * Code execution endpoint
 *
 * Execute code in isolated sandbox environment:
 * - Python, Node.js, Go, Rust, Java, Bash
 * - Package installation
 * - Resource limits
 * - Artifact retrieval
 */
router.post('/execute-code',
  extractTenantContext,
  apiRateLimiters.orchestrate,
  sanitizeInputs,
  asyncHandler(async (req: Request, res: Response) => {
    if (!taskManager) {
      throw ErrorFactory.serviceUnavailable('TaskManager');
    }

    const { code, language, packages = [], files = [], timeout: codeTimeout = 60000, resourceLimits } = req.body;

    if (!code) {
      throw new ValidationError('Code is required', {
        acceptedFields: ['code'],
        example: {
          code: 'print("Hello, World!")',
          language: 'python',
          packages: ['numpy', 'pandas'],
          timeout: 60000
        }
      });
    }

    if (!language) {
      throw new ValidationError('Language is required', {
        acceptedFields: ['language'],
        supportedLanguages: ['python', 'node', 'go', 'rust', 'java', 'bash']
      });
    }

    const taskId = await taskManager.createTask('code_execute', {
      objective: `Execute ${language} code`,
      context: {
        code,
        language,
        packages,
        files,
        timeout: codeTimeout,
        resourceLimits: resourceLimits || {
          cpuLimit: '1.0',
          memoryLimit: '512Mi',
          gpuEnabled: false
        }
      },
      constraints: {
        priority: req.body.priority || 'normal',
        timeout: Math.min(codeTimeout + 30000, 330000) // Add 30s buffer, max 5.5min
      }
    }, {
      timeout: Math.min(codeTimeout + 30000, 330000),
      tenantContext: req.tenantContext
    });

    logger.info('Code execution task created', {
      taskId,
      language,
      packagesCount: packages.length,
      timeout: codeTimeout
    });

    return ApiResponse.accepted(
      res,
      taskId,
      `/api/tasks/${taskId}`,
      'Code execution task created.',
      {
        estimatedDuration: `${Math.ceil(codeTimeout / 1000)}s (based on timeout)`,
        supportedLanguages: ['python', 'node', 'go', 'rust', 'java', 'bash'],
        maxTimeout: '5 minutes'
      }
    );
  })
);

// Mount autonomous routes for goal tracking, planning, reflection, and evaluation
// These endpoints are called by nexus-gateway's autonomous-bridge.ts
router.use('/autonomous', autonomousRouter);
internalRouter.use('/autonomous', autonomousRouter);

logger.info('Autonomous routes mounted', {
  routes: [
    'POST /autonomous/define-goal',
    'POST /autonomous/create-plan',
    'POST /autonomous/reflect',
    'POST /autonomous/replan',
    'POST /autonomous/evaluate',
  ],
});

// Apply error handling middleware (MUST BE LAST)
router.use(errorHandler);
internalRouter.use(errorHandler);

export default router;
export { internalRouter };
export {
  initializeAutonomousRoutes,
  autonomousRouter,
  updateGodModeTools,
  getGodModeTools,
  type AutonomousRoutesConfig,
};
