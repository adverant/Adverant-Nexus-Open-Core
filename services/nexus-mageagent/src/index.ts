/**
 * MageAgent Server - AI Orchestration with Real-Time WebSocket Streaming
 * Socket.IO enabled for real-time agent progress, tool execution, and streaming updates
 *
 * HEALTH CHECK FIX: Health endpoint positioned to avoid rate limiting and
 * includes caching to reduce database load from frequent Kubernetes probes.
 */

// PHASE31: Add uncaught exception handler FIRST to catch module initialization errors
process.on('uncaughtException', (error: Error) => {
  // eslint-disable-next-line no-console -- Early error handler before logger initialization
  console.error('[PHASE31-UNCAUGHT-EXCEPTION] Module initialization error:', {
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  // Don't exit - let the service try to continue
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  // eslint-disable-next-line no-console -- Early error handler before logger initialization
  console.error('[PHASE31-UNHANDLED-REJECTION] Promise rejection during initialization:', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    timestamp: new Date().toISOString()
  });
});

// Initialize OpenTelemetry tracing FIRST (must be before any other imports)
import { initializeTracing } from './tracing/tracer';
initializeTracing();

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { Redis } from 'ioredis';
import { config } from './config';
import { logger } from './utils/logger';
import { OpenRouterClient } from './clients/openrouter-client';
import { Orchestrator } from './orchestration/orchestrator';
import { createGraphRAGClient } from './clients/graphrag-client';
import { databaseManager } from './database/database-manager';
import { initializeRoutes, initializeInternalRoutes, initializeAutonomousRoutes, updateGodModeTools, autonomousRouter } from './routes';
import { initializeStreamingRoutes } from './routes/streaming-routes';

// Import autonomous execution modules
import {
  createGoalTracker,
  createReflectionEngine,
  createPatternLearner,
} from './autonomous/index.js';
import { TaskDecompositionAgent } from './agents/task-decomposition-agent.js';

// Import GOD-MODE tools for autonomous agent execution
import {
  initializePlanningTool,
  destroyPlanningTool,
} from './tools/planning-tool.js';
import {
  createHumanInputTool,
  setHumanInputTool,
  type HumanInputTool,
} from './tools/human-input-tool.js';
import {
  getVisionAnalyzer,
} from './services/vision-analyzer.js';
import googleGeospatialRouter, { cleanupGoogleClients } from './routes/google-geospatial';
import geospatialPredictionsRouter from './routes/geospatial-predictions';
import { createRetryAnalyticsRoutes } from './routes/retry-analytics';
import { initializeLLMRoutes } from './routes/llm-routes';
import { initializeTaskManager } from './core/task-manager';
import { RedisTaskRepository } from './core/redis-task-repository';
import { TaskRecoveryStrategyFactory } from './core/task-recovery-strategy';
import { MemoryStorageQueue } from './core/memory-storage-queue';
import {
  securityHeaders,
  globalRateLimiter,
  configureCors,
  requestSizeLimiter,
  ipBlocker,
  securityMiddleware
} from './middleware/security';
import { errorHandler as globalErrorHandler, notFoundHandler } from './middleware/error-handler';
import { usageTrackingMiddleware, flushPendingReports } from './middleware/usage-tracking';
import { adaptiveTimeoutManager } from './utils/adaptive-timeout-manager';
import { WebSocketManager } from './websocket/websocket-manager';
import { initializeEnhancedWebSocketManager } from './websocket/enhanced-websocket-manager';

// Import telemetry for unified orchestration monitoring
import {
  TelemetryPublisher,
  createTelemetryMiddleware
} from '@adverant/nexus-telemetry';
import { initializeTelemetryConsumer, stopTelemetryConsumer } from './services/telemetry-consumer-service';

/**
 * Health check cache to reduce database queries
 * K8s probes run every 5-10 seconds, we don't need to query DB that often
 */
interface HealthCheckCache {
  data: any;
  timestamp: number;
  ttl: number;
}

const healthCheckCache: HealthCheckCache = {
  data: null,
  timestamp: 0,
  ttl: 5000 // 5 seconds cache
};

async function startMageAgentWithWebSocket() {
  try {
    logger.info('Starting MageAgent service with WebSocket streaming...');
    logger.info('Real-time orchestration updates via Socket.IO');

    // Memory configuration
    const maxOldSpaceMB = parseInt(process.env.MAX_OLD_SPACE_SIZE || '4096');
    const memoryConfig = {
      maxOldSpace: `${maxOldSpaceMB} MB`,
      nodeOptions: process.env.NODE_OPTIONS || 'Not set',
      heapStatistics: process.memoryUsage(),
      warningThreshold: `${Math.floor(maxOldSpaceMB * 0.8)} MB (80%)`
    };
    logger.info('Memory configuration', memoryConfig);

    // Memory monitoring with dynamic threshold (80% of max heap)
    const warningThresholdMB = maxOldSpaceMB * 0.8;
    setInterval(() => {
      const usage = process.memoryUsage();
      const heapUsedMB = usage.heapUsed / 1024 / 1024;
      const heapTotalMB = usage.heapTotal / 1024 / 1024;
      const usagePercent = (heapUsedMB / maxOldSpaceMB) * 100;

      if (heapUsedMB > warningThresholdMB) {
        logger.warn('High memory usage detected', {
          heapUsed: `${heapUsedMB.toFixed(2)} MB`,
          heapTotal: `${heapTotalMB.toFixed(2)} MB`,
          maxConfigured: `${maxOldSpaceMB} MB`,
          usagePercent: `${usagePercent.toFixed(1)}%`,
          threshold: `${warningThresholdMB.toFixed(0)} MB (80%)`,
          action: 'Triggering garbage collection'
        });

        if (global.gc) {
          global.gc();
          logger.info('Forced garbage collection completed');
        } else {
          logger.warn('Garbage collection not available (missing --expose-gc flag)');
        }
      }
    }, 30000);

    // Initialize database connections
    await databaseManager.initialize();
    logger.info('Connected to local databases');

    // Initialize TaskManager with Redis for async job queue
    const redisConfig = config.databases.redis;
    const redisUrl = `redis://${redisConfig.host}:${redisConfig.port}`;

    // CRITICAL FIX: Initialize Redis Task Repository for persistent task storage
    // Feature flag: USE_REDIS_TASK_REGISTRY (default: true for production)
    const useRedisTaskRegistry = process.env.USE_REDIS_TASK_REGISTRY !== 'false';
    let taskRepository = null;
    let recoveryStrategy = null;
    let repositoryRedis: Redis | null = null;

    if (useRedisTaskRegistry) {
      // Initialize Redis client for task repository
      repositoryRedis = new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
        enableOfflineQueue: true,
        maxRetriesPerRequest: 3
      });

      // Create Redis-backed repository with 24-hour TTL
      taskRepository = new RedisTaskRepository(repositoryRedis, {
        ttl: 86400, // 24 hours
        keyPrefix: 'nexus:tasks',
        maxRetries: 3,
        retryDelay: 100
      });

      // Create recovery strategy (rebuild tasks from Bull jobs on desync)
      recoveryStrategy = TaskRecoveryStrategyFactory.create('rebuild', taskRepository);

      logger.info('Redis Task Repository enabled (production mode)', {
        ttl: '24 hours',
        keyPrefix: 'nexus:tasks',
        recoveryStrategy: recoveryStrategy.name
      });
    } else {
      logger.warn('Redis Task Repository DISABLED - using ephemeral in-memory storage', {
        warning: 'Tasks will be lost on service restart',
        recommendation: 'Set USE_REDIS_TASK_REGISTRY=true for production'
      });
    }

    const taskManager = initializeTaskManager({
      redisUrl,
      defaultTimeout: 300000,  // 5 minutes
      maxTimeout: 600000,      // 10 minutes
      concurrency: 5,
      removeOnComplete: false,
      removeOnFail: false,
      // NEW: Inject repository and recovery strategy (Dependency Injection)
      repository: taskRepository || undefined,
      recoveryStrategy: recoveryStrategy || undefined,
      // PHASE 1 TASK 1.4: Pass Redis client for distributed locking and state reconciliation
      redisClient: useRedisTaskRegistry ? repositoryRedis : undefined
    });
    logger.info('TaskManager initialized with Redis job queue', {
      host: redisConfig.host,
      port: redisConfig.port,
      persistentTaskRegistry: useRedisTaskRegistry
    });

    // Initialize GraphRAG client
    const graphRAGClient = createGraphRAGClient();

    // Initialize MemoryStorageQueue for decoupled memory operations
    const memoryStorageQueue = new MemoryStorageQueue({
      redisUrl,
      concurrency: 3,
      retryStrategy: {
        maxRetries: 5,
        initialDelay: 1000,
        maxDelay: 60000,
        backoffMultiplier: 2,
        retryableStatusCodes: [408, 429, 500, 502, 503, 504]
      },
      deadLetterQueueEnabled: true,
      circuitBreaker: {
        failureThreshold: 5,
        resetTimeout: 60000,
        halfOpenRetries: 2
      }
    });
    memoryStorageQueue.setGraphRAGClient(graphRAGClient);
    logger.info('MemoryStorageQueue initialized with circuit breaker protection');

    // Initialize Redis client for WAL-based synthesis checkpoint service
    const redisClient = new Redis({
      host: redisConfig.host,
      port: redisConfig.port,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        logger.debug(`Redis connection retry attempt ${times}, delay: ${delay}ms`);
        return delay;
      },
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false
    });

    redisClient.on('connect', () => {
      logger.info('Redis client connected successfully for synthesis checkpoints');
    });

    redisClient.on('error', (err: Error) => {
      logger.error('Redis client error (synthesis checkpoints)', {
        error: err.message
      });
    });

    logger.info('Redis client initialized for synthesis WAL checkpoints', {
      host: redisConfig.host,
      port: redisConfig.port
    });

    // =========================================================================
    // GOD-MODE Tools Initialization
    // Initialize Planning Tool, Human Input Tool, and Vision Analyzer
    // These enable visible execution plans, human-in-the-loop approvals,
    // and browser automation with tier-based quotas
    // =========================================================================

    // Initialize Planning Tool with Redis persistence for visible execution plans
    const planningTool = initializePlanningTool(redisClient, {
      keyPrefix: 'nexus:plans',
      activePlanTTL: 7 * 24 * 60 * 60,  // 7 days for active plans
      completedPlanTTL: 24 * 60 * 60,   // 24 hours for completed plans
      maxActivePlansPerUser: 10,
    });
    logger.info('GOD-MODE: PlanningTool initialized with Redis persistence', {
      keyPrefix: 'nexus:plans',
      activePlanTTL: '7 days',
      completedPlanTTL: '24 hours',
    });

    // Initialize Human Input Tool for human-in-the-loop approvals
    // WebSocket events are emitted via the callback for real-time approval requests
    let humanInputTool: HumanInputTool | null = null;
    // We'll set up the WebSocket callback after wsManager is initialized

    // Vision Analyzer uses singleton pattern - already initialized on import
    const visionAnalyzer = getVisionAnalyzer();
    logger.info('GOD-MODE: VisionAnalyzer singleton ready', {
      features: ['screenshot analysis', 'element identification', 'action suggestion'],
      quotaEnforcement: 'tier-based daily limits',
    });

    // Initialize OpenRouter client with comprehensive validation
    // CRITICAL: Free models are filtered out by default
    // REFACTORING FIX: Set maxTimeout to align with TaskManager (30 min)
    // This ensures HTTP requests don't timeout before async jobs complete
    const openRouterClient = new OpenRouterClient(
      config.openRouter.apiKey,
      config.openRouter.baseUrl,
      {
        filterFreeModels: true, // Always filter free models
        maxTimeout: 1800000     // 30 minutes - aligned with TaskManager.maxTimeout for extreme complexity tasks
      }
    );

    // Verify OpenRouter connection with strict timeout
    let models: any[] = [];
    try {
      logger.info('Testing OpenRouter connection...');
      const connectionValid = await Promise.race([
        openRouterClient.testConnection(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000))
      ]);

      if (!connectionValid) {
        throw new Error(
          'OpenRouter connection test failed or timed out after 10 seconds\n' +
          'API Key Status: ' + (config.openRouter.apiKey ? 'Configured' : 'Missing') + '\n' +
          'Endpoint: ' + config.openRouter.baseUrl
        );
      }

      // Load models with timeout
      models = await Promise.race([
        openRouterClient.listAvailableModels(),
        new Promise<any[]>((_, reject) =>
          setTimeout(() => reject(new Error('Model listing timed out after 10 seconds')), 10000)
        )
      ]);

      logger.info(`Connected to OpenRouter - ${models.length} models available`);

      // Validate at least some expected models are available
      const expectedModels = ['anthropic/claude', 'openai/gpt', 'google/gemini'];
      const hasExpectedModel = models.some(m =>
        expectedModels.some(expected => m.id.toLowerCase().includes(expected))
      );

      if (!hasExpectedModel) {
        logger.warn(
          'WARNING: No standard models found. Available models may be limited.\n' +
          'Found models: ' + models.slice(0, 5).map(m => m.id).join(', ')
        );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('CRITICAL: OpenRouter initialization failed', { error: errorMessage });

      throw new Error(
        '\n========================================\n' +
        'FATAL: OpenRouter Service Initialization Failed\n' +
        '========================================\n' +
        errorMessage + '\n' +
        '\nTroubleshooting Steps:\n' +
        '1. Verify OPENROUTER_API_KEY environment variable is set\n' +
        '2. Check API key validity at https://openrouter.ai/keys\n' +
        '3. Ensure account has credits at https://openrouter.ai/credits\n' +
        '4. Test network connectivity to openrouter.ai\n' +
        '5. Check rate limits at https://openrouter.ai/activity\n' +
        '\nCurrent Configuration:\n' +
        'API Key: ' + (config.openRouter.apiKey ? config.openRouter.apiKey.substring(0, 20) + '...' : 'NOT SET') + '\n' +
        'Base URL: ' + config.openRouter.baseUrl + '\n' +
        '========================================\n'
      );
    }

    // Test GraphRAG connection
    let graphRAGHealthy = false;
    for (let i = 0; i < 3; i++) {
      graphRAGHealthy = await graphRAGClient.checkHealth();
      if (graphRAGHealthy) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    if (!graphRAGHealthy) {
      logger.warn('GraphRAG service is not healthy, operating in degraded mode');
    } else {
      logger.info('Connected to GraphRAG service');

      // Log GraphRAG WebSocket info
      try {
        const wsInfoResponse = await fetch('http://graphrag:8090/api/websocket/info');
        if (wsInfoResponse.ok) {
          const wsInfo = await wsInfoResponse.json() as { url?: string; namespaces?: string[] };
          logger.info('GraphRAG WebSocket available at:', wsInfo.url || 'N/A');
          logger.info('GraphRAG WebSocket namespaces:', wsInfo.namespaces || []);
        }
      } catch (e) {
        logger.debug('Could not fetch GraphRAG WebSocket info');
      }
    }

    // Create orchestrator with Redis client for WAL-based crash recovery
    const orchestrator = new Orchestrator({
      openRouterClient,
      graphRAGClient,
      databaseManager,
      config: config.orchestration,
      memoryStorageQueue,
      redisClient
    });

    // Wire orchestrator to TaskManager for agent event forwarding to GraphRAG WebSocket
    taskManager.wireOrchestrator(orchestrator);

    // Register TaskManager processors with progress event propagation
    // PHASE 39: Added tenantContext to processor signature for multi-tenant context propagation
    // PHASE 60: Added job reference to context for progress updates
    taskManager.registerProcessor('orchestrate', async (params: any, context?: { jobId: string; tenantContext?: any; job?: any }) => {
      // Forward orchestrator events to TaskManager for progress tracking
      const onAgentProgress = (event: any) => {
        if (event.agentId) {
          const progressValue = event.progress || 50;

          // PHASE 60 FIX: Call Bull's job.progress() to trigger queue progress event
          // This ensures progress updates reach the repository via the queue 'progress' handler
          if (context?.job) {
            try {
              context.job.progress(progressValue);
            } catch (err: any) {
              logger.warn('[PROGRESS-JOB] Failed to call job.progress', {
                taskId: context?.jobId,
                error: err.message
              });
            }
          }

          taskManager.emit('task:progress', {
            taskId: context?.jobId || params.taskId || event.taskId,
            progress: progressValue,
            message: `Agent ${event.agentId}: ${event.status || 'working'}`,
            metadata: event
          });
        }
      };

      // Forward orchestrator progress events to TaskManager
      const onOrchestratorProgress = (event: any) => {
        taskManager.emit('task:progress', event);
      };

      // Forward retry events for real-time WebSocket streaming
      const onRetryAttempt = (event: any) => {
        taskManager.emit('retry:attempt', event);
      };
      const onRetryAnalysis = (event: any) => {
        taskManager.emit('retry:analysis', event);
      };
      const onRetryBackoff = (event: any) => {
        taskManager.emit('retry:backoff', event);
      };
      const onRetrySuccess = (event: any) => {
        taskManager.emit('retry:success', event);
      };
      const onRetryExhausted = (event: any) => {
        taskManager.emit('retry:exhausted', event);
      };

      orchestrator.on('agent:started', onAgentProgress);
      orchestrator.on('agent:completed', onAgentProgress);
      orchestrator.on('agent:progress', onAgentProgress);
      orchestrator.on('orchestrator:progress', onOrchestratorProgress);
      orchestrator.on('retry:attempt', onRetryAttempt);
      orchestrator.on('retry:analysis', onRetryAnalysis);
      orchestrator.on('retry:backoff', onRetryBackoff);
      orchestrator.on('retry:success', onRetrySuccess);
      orchestrator.on('retry:exhausted', onRetryExhausted);

      try {
        // Pass taskId from job context to orchestrator so progress emissions use the correct ID
        // PHASE 39: Include tenantContext for multi-tenant isolation across async queue boundary
        const orchestrationOptions = {
          ...(params.options || {}),
          taskId: context?.jobId, // CRITICAL: Pass TaskManager's task ID to orchestrator
          tenantContext: context?.tenantContext // PHASE 39: Propagate tenant context to orchestrator
        };
        const result = await orchestrator.orchestrateTask(params.task, orchestrationOptions);

        // Cleanup listeners
        orchestrator.off('agent:started', onAgentProgress);
        orchestrator.off('agent:completed', onAgentProgress);
        orchestrator.off('agent:progress', onAgentProgress);
        orchestrator.off('orchestrator:progress', onOrchestratorProgress);
        orchestrator.off('retry:attempt', onRetryAttempt);
        orchestrator.off('retry:analysis', onRetryAnalysis);
        orchestrator.off('retry:backoff', onRetryBackoff);
        orchestrator.off('retry:success', onRetrySuccess);
        orchestrator.off('retry:exhausted', onRetryExhausted);

        return result;
      } catch (error) {
        orchestrator.off('agent:started', onAgentProgress);
        orchestrator.off('agent:completed', onAgentProgress);
        orchestrator.off('agent:progress', onAgentProgress);
        orchestrator.off('orchestrator:progress', onOrchestratorProgress);
        orchestrator.off('retry:attempt', onRetryAttempt);
        orchestrator.off('retry:analysis', onRetryAnalysis);
        orchestrator.off('retry:backoff', onRetryBackoff);
        orchestrator.off('retry:success', onRetrySuccess);
        orchestrator.off('retry:exhausted', onRetryExhausted);
        throw error;
      }
    });

    taskManager.registerProcessor('collaborate', async (params: any) => {
      return await orchestrator.orchestrateTask(params.objective, {
        type: 'collaboration',
        agents: params.agents,
        iterations: params.iterations,
        timeout: params.timeout,
        collaborationMode: true
      });
    });

    taskManager.registerProcessor('compete', async (params: any) => {
      // Forward competition progress events
      const onCompetitionProgress = (event: any) => {
        taskManager.emit('task:progress', {
          taskId: params.competitionId || event.competitionId,
          progress: event.progress || 50,
          message: `Competition: ${event.status || 'running'}`,
          metadata: event
        });
      };

      orchestrator.on('competition:started', onCompetitionProgress);
      orchestrator.on('competition:agent:completed', onCompetitionProgress);
      orchestrator.on('competition:evaluating', onCompetitionProgress);

      try {
        const result = await orchestrator.runCompetition(params);

        orchestrator.off('competition:started', onCompetitionProgress);
        orchestrator.off('competition:agent:completed', onCompetitionProgress);
        orchestrator.off('competition:evaluating', onCompetitionProgress);

        return result;
      } catch (error) {
        orchestrator.off('competition:started', onCompetitionProgress);
        orchestrator.off('competition:agent:completed', onCompetitionProgress);
        orchestrator.off('competition:evaluating', onCompetitionProgress);
        throw error;
      }
    });

    taskManager.registerProcessor('analyze', async (params: any) => {
      return await orchestrator.orchestrateTask(params.topic, {
        type: 'analysis',
        depth: params.depth,
        includeMemory: params.includeMemory,
        timeout: params.timeout
      });
    });

    taskManager.registerProcessor('synthesize', async (params: any) => {
      return await orchestrator.orchestrateTask(JSON.stringify(params.sources), {
        type: 'synthesis',
        format: params.format,
        objective: params.objective,
        timeout: params.timeout
      });
    });

    taskManager.registerProcessor('vision_ocr', async (params: any) => {
      // Import VisionService dynamically
      const { visionService } = await import('./services/vision-service.js');

      // Emit progress event at start
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 10,
        message: 'Starting OCR processing',
        metadata: {
          preferAccuracy: params.preferAccuracy,
          language: params.language,
          format: params.format
        }
      });

      // Execute OCR
      const result = await visionService.extractText({
        image: params.image,
        format: params.format || 'base64',
        preferAccuracy: params.preferAccuracy || false,
        language: params.language,
        metadata: params.metadata,
        jobId: params.jobId
      });

      // Emit progress event at completion
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 90,
        message: 'OCR processing completed',
        metadata: {
          textLength: result.text.length,
          modelUsed: result.modelUsed,
          confidence: result.confidence
        }
      });

      return result;
    });

    // Register vision_analysis processor (Phase 1: VideoAgent Integration)
    taskManager.registerProcessor('vision_analysis', async (params: any) => {
      // Import VisionService dynamically
      const { visionService } = await import('./services/vision-service.js');

      // Emit progress event at start
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 10,
        message: 'Starting image analysis',
        metadata: {
          format: params.format,
          detail_level: params.detail_level
        }
      });

      // Validate input
      if (!params.image) {
        throw new Error('Missing required parameter: image');
      }

      // Execute image analysis
      const result = await visionService.analyzeImage({
        image: params.image,
        format: params.format || 'base64',
        detail_level: params.detail_level || 'standard',
        metadata: params.metadata
      });

      // Emit progress event at completion
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 90,
        message: 'Image analysis completed',
        metadata: {
          description: result.description?.substring(0, 100),
          objectsDetected: result.objects?.length || 0,
          modelUsed: result.modelUsed,
          confidence: result.confidence
        }
      });

      return result;
    });

    taskManager.registerProcessor('layout_analysis', async (params: any) => {
      // Import VisionService dynamically
      const { visionService } = await import('./services/vision-service.js');

      // Emit progress event at start
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 10,
        message: 'Starting layout analysis',
        metadata: {
          language: params.language,
          format: params.format,
          targetElementTypes: 11,
          targetAccuracy: '99.2%'
        }
      });

      // Execute layout analysis
      const result = await visionService.analyzeLayout({
        image: params.image,
        format: params.format || 'base64',
        language: params.language || 'en',
        metadata: params.metadata,
        jobId: params.jobId
      });

      // Emit progress event at completion
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 90,
        message: 'Layout analysis completed',
        metadata: {
          totalElements: result.elements.length,
          modelUsed: result.modelUsed,
          confidence: result.confidence,
          elementTypes: [...new Set(result.elements.map(e => e.type))]
        }
      });

      return result;
    });

    // Register table_extraction processor (Phase 2.3)
    taskManager.registerProcessor('table_extraction', async (params: any) => {
      // Import VisionService dynamically
      const { visionService } = await import('./services/vision-service.js');

      // Emit progress event at start
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 10,
        message: 'Starting table extraction',
        metadata: {
          language: params.language,
          format: params.format,
          targetAccuracy: '97.9%'
        }
      });

      // Execute table extraction
      const result = await visionService.extractTable({
        image: params.image,
        format: params.format || 'base64',
        language: params.language || 'en',
        metadata: params.metadata,
        jobId: params.jobId
      });

      // Emit progress event at completion
      taskManager.emit('task:progress', {
        taskId: params.taskId || params.jobId,
        progress: 90,
        message: 'Table extraction completed',
        metadata: {
          totalRows: result.rows.length,
          totalColumns: result.columns,
          modelUsed: result.modelUsed,
          confidence: result.confidence
        }
      });

      return result;
    });

    // Geospatial Prediction Processor
    taskManager.registerProcessor('geospatial_prediction', async (params: any) => {
      // Import GeospatialPredictionService dynamically
      const { GeospatialPredictionService } = await import('./services/geospatial-prediction.js');

      const service = new GeospatialPredictionService();
      const predictionRequest = params.predictionRequest;

      // Emit progress event at start
      taskManager.emit('task:progress', {
        taskId: params.taskId || predictionRequest.jobId,
        progress: 10,
        message: `Starting ${predictionRequest.operation} prediction`,
        metadata: {
          operation: predictionRequest.operation,
          location: predictionRequest.params.location?.name
        }
      });

      // Execute prediction
      const result = await service.predict(predictionRequest);

      // Emit progress event at completion
      taskManager.emit('task:progress', {
        taskId: params.taskId || predictionRequest.jobId,
        progress: 90,
        message: 'Prediction complete',
        metadata: {
          operation: predictionRequest.operation,
          modelUsed: result.modelUsed,
          confidence: result.confidence
        }
      });

      return result;
    });

    logger.info('Registered 10 TaskManager processors with progress event forwarding');
    logger.info('Progress events will be emitted via TaskManager for real-time monitoring');

    // REFACTORED: NEW - Start TaskManager worker AFTER all processors registered
    await taskManager.startWorker();
    logger.info('TaskManager worker started - ready to process tasks');

    // Create Express app
    const app = express();

    // Initialize telemetry publisher for unified orchestration monitoring
    const telemetryPublisher = new TelemetryPublisher({
      redisUrl: redisUrl,
      serviceName: 'nexus-mageagent',
      instanceId: process.env.HOSTNAME || `mageagent-${Date.now()}`,
      enableMetrics: true
    });
    logger.info('TelemetryPublisher initialized for unified orchestration monitoring');

    // Start telemetry consumer for orchestration decisions
    // This consumes events from all services and makes routing/scanning decisions
    // Pass OpenRouterClient to enable LLM-powered intelligent decisions (Claude 4.5 / Gemini 2.0)
    try {
      await initializeTelemetryConsumer(openRouterClient);
      logger.info('TelemetryConsumer started with LLM-powered decision engine', {
        primaryModel: 'anthropic/claude-opus-4.6',
        fallbackModel: 'google/gemini-2.0-flash-001',
        mode: 'intelligent-orchestration'
      });
    } catch (err) {
      logger.warn('Failed to start TelemetryConsumer, operating without orchestration monitoring', {
        error: err instanceof Error ? err.message : 'Unknown error'
      });
    }

    /**
     * CRITICAL: Health check endpoints MUST be registered BEFORE rate limiter
     * to ensure Kubernetes probes never hit rate limits
     */
    app.get('/health', async (_req, res) => {
      const now = Date.now();

      // Use cached health data if available and fresh (within TTL)
      if (healthCheckCache.data && (now - healthCheckCache.timestamp) < healthCheckCache.ttl) {
        return res.json(healthCheckCache.data);
      }

      try {
        // Perform actual health check with 4s timeout to prevent probe failures
        // K8s liveness probe timeout is 10s, so 4s gives us safety margin
        const dbHealth = await Promise.race([
          databaseManager.healthCheck(),
          new Promise<any>((_, reject) =>
            setTimeout(() => reject(new Error('Database health check timeout (4s)')), 4000)
          )
        ]).catch(err => ({
          postgres: false,
          redis: false,
          neo4j: false,
          qdrant: false,
          error: err.message
        }));
        const memory = process.memoryUsage();

        const healthData = {
          status: 'healthy',
          service: 'MageAgent-Simplified',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: {
            heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
            heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
            rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`,
            external: `${(memory.external / 1024 / 1024).toFixed(2)} MB`
          },
          databases: dbHealth,
          graphRAG: graphRAGHealthy,
          orchestrator: orchestrator ? 'running' : 'not initialized',
          models: {
            available: models.length,
            status: models.length > 0 ? 'connected' : 'degraded'
          }
        };

        // Update cache
        healthCheckCache.data = healthData;
        healthCheckCache.timestamp = now;

        return res.json(healthData);
      } catch (error) {
        // Even if health check fails, return 200 with error details
        // This prevents unnecessary pod restarts
        const errorData = {
          status: 'degraded',
          service: 'MageAgent-Simplified',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Health check failed',
          uptime: process.uptime()
        };

        // Don't cache errors
        return res.status(200).json(errorData);
      }
    });

    // Additional health check variants for Kubernetes probes
    app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
    app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
    app.get('/liveness', (_req, res) => res.json({ status: 'alive' }));

    // Simple ping endpoint (no DB queries, instant response)
    app.get('/ping', (_req, res) => res.send('pong'));

    // Compatibility alias for internal services (FileProcessAgent Worker)
    // Worker expects /api/health, primary endpoint is /health
    app.get('/api/health', (_req, res, next) => {
      _req.url = '/health';
      return app._router.handle(_req, res, next);
    });

    /**
     * CRITICAL: Body parsing MUST be registered BEFORE mounting routes
     * Otherwise req.body will be undefined in route handlers
     */
    app.use(express.json({ limit: requestSizeLimiter.json }));
    app.use(express.urlencoded(requestSizeLimiter.urlencoded));

    // Debug middleware to verify body parsing
    app.use((req, _res, next) => {
      if (req.method === 'POST' && req.path.includes('orchestrate')) {
        logger.info('[DEBUG] POST request to orchestrate', {
          path: req.path,
          hasBody: !!req.body,
          bodyKeys: req.body ? Object.keys(req.body) : [],
          contentType: req.headers['content-type']
        });
      }
      next();
    });

    /**
     * Initialize autonomous execution modules for Manus.ai-style goal tracking
     * These modules provide:
     * - Goal definition and tracking (GoalTracker)
     * - Execution planning (TaskDecompositionAgent)
     * - Reflection and self-assessment (ReflectionEngine)
     * - Pattern learning and reuse (PatternLearner)
     */
    const goalTracker = createGoalTracker(
      openRouterClient,
      graphRAGClient,
      redisClient,
      {
        evaluationModel: 'anthropic/claude-opus-4.6',
        defaultMaxAttempts: 5,
        goalTTL: 86400, // 24 hours
      }
    );

    const reflectionEngine = createReflectionEngine(
      openRouterClient,
      graphRAGClient,
      {
        reflectionModel: 'anthropic/claude-opus-4.6',
        maxConsecutiveFailures: 3,
        confidenceThreshold: 0.5,
        deviationThreshold: 2,
      }
    );

    const patternLearner = createPatternLearner(
      openRouterClient,
      graphRAGClient,
      redisClient,
      {
        learningModel: 'anthropic/claude-opus-4.6',
        minSimilarityThreshold: 0.6,
        maxPatternsToReturn: 5,
        patternTTL: 604800, // 7 days
      }
    );

    const taskDecomposer = new TaskDecompositionAgent(
      'task-decomposer',
      'anthropic/claude-opus-4.6',
      {
        openRouterClient,
        databaseManager,
        graphRAGClient,
      }
    );

    // Wire up autonomous routes with the initialized modules
    // GOD-MODE tools will be passed after WebSocket manager is initialized
    initializeAutonomousRoutes({
      goalTracker,
      reflectionEngine,
      patternLearner,
      taskDecomposer,
      // GOD-MODE tools - Note: These are initialized early but passed here for route access
      planningTool,
      humanInputTool: null, // Will be set after WebSocket initialization
      visionAnalyzer,
    });

    logger.info('Autonomous execution modules initialized', {
      goalTracker: 'enabled',
      reflectionEngine: 'enabled',
      patternLearner: 'enabled',
      taskDecomposer: 'enabled',
      endpoints: [
        '/api/autonomous/define-goal',
        '/api/autonomous/create-plan',
        '/api/autonomous/reflect',
        '/api/autonomous/replan',
        '/api/autonomous/evaluate',
      ],
    });

    /**
     * Internal microservice routes - MUST be mounted BEFORE rate limiter
     * These endpoints bypass MageAgent's rate limiter to enable high-throughput
     * internal communication between trusted services (LearningAgent, GraphRAG, etc.)
     *
     * Security: Should only be accessible on internal Docker network
     * Enterprise Pattern: /mageagent/api/* for service-level namespace isolation
     *
     * Phase 60a: Dual mount for compatibility with FileProcessAgent Worker
     * - Primary: /mageagent/api/internal (full path with service prefix)
     * - Compatibility: /api/internal (for internal mesh traffic bypassing Istio rewrite)
     */
    const internalRoutes = initializeInternalRoutes(orchestrator, taskManager);
    app.use('/mageagent/api/internal', internalRoutes);
    app.use('/api/internal', internalRoutes); // Compatibility mount for internal services

    logger.info('[Internal Routes] Dual-mounted for internal service compatibility', {
      primaryPath: '/mageagent/api/internal',
      compatibilityPath: '/api/internal',
      rateLimiting: 'NONE (bypassed)',
      security: 'Docker network isolation only',
      fixedIssue: 'FileProcessAgent Worker 404 errors (Phase 60a)'
    });

    /**
     * Autonomous execution routes - Compatibility mount at /api/autonomous
     * Called by nexus-gateway's autonomous-bridge.ts for Manus.ai-style autonomous execution
     * Must be mounted BEFORE rate limiter to allow internal service communication
     */
    app.use('/api/autonomous', autonomousRouter);

    logger.info('[Autonomous Routes] Compatibility mount at /api/autonomous', {
      primaryPath: '/mageagent/api/autonomous (via apiRoutes)',
      compatibilityPath: '/api/autonomous',
      rateLimiting: 'NONE (bypassed for internal services)',
      calledBy: 'nexus-gateway autonomous-bridge.ts',
      endpoints: [
        'POST /api/autonomous/define-goal',
        'POST /api/autonomous/create-plan',
        'POST /api/autonomous/reflect',
        'POST /api/autonomous/replan',
        'POST /api/autonomous/evaluate',
      ],
    });

    /**
     * Security middleware - Applied AFTER health checks, body parsing, and internal routes
     * This ensures health checks and internal microservice endpoints are never rate-limited
     */
    app.use(securityHeaders);
    app.use(ipBlocker);
    app.use(securityMiddleware);
    app.use(globalRateLimiter);  // Now safe because health checks and internal routes are already handled
    app.use(cors(configureCors()));

    // Telemetry middleware for unified orchestration monitoring
    // Publishes all HTTP requests to Redis Streams for orchestrator consumption
    app.use(createTelemetryMiddleware(telemetryPublisher, {
      skipPaths: ['/health', '/healthz', '/ready', '/liveness', '/metrics', '/ping', '/api/health']
    }));

    // Usage tracking middleware - reports API usage to nexus-auth for billing/analytics
    // Tracks tokens, operations, and costs per API key/user
    app.use(usageTrackingMiddleware);
    logger.info('[Usage Tracking] Middleware enabled - reporting to nexus-auth');

    // Request logging (excluding health checks to reduce noise)
    app.use((req, _res, next) => {
      // Don't log health check spam
      if (!['/health', '/healthz', '/ready', '/liveness', '/ping'].includes(req.path)) {
        logger.info(`${req.method} ${req.path}`, {
          query: req.query,
          ip: req.ip
        });
      }
      next();
    });

    // Setup REST API routes with TaskManager support
    // Enterprise Pattern: /mageagent/api/* for service-level namespace isolation
    const apiRoutes = initializeRoutes(orchestrator, taskManager);
    app.use('/mageagent/api', apiRoutes);

    // Setup WebSocket streaming routes for long-running operations
    const streamingRoutes = initializeStreamingRoutes(orchestrator);
    app.use('/mageagent/api/streaming', streamingRoutes);

    logger.info('[Streaming Routes] Mounted at /mageagent/api/streaming', {
      endpoints: [
        'POST /mageagent/api/streaming/orchestrate (with streamProgress support)',
        'GET /mageagent/api/streaming/info (streaming configuration)'
      ],
      websocketUrl: 'Connect to GraphRAG WebSocket for real-time events',
      events: ['task:start', 'agent:spawned', 'agent:progress', 'agent:complete', 'task:complete']
    });

    // Setup Google Geospatial AI routes (Phase 5)
    app.use('/mageagent/api/google', googleGeospatialRouter);

    logger.info('[Google Geospatial Routes] Mounted at /mageagent/api/google', {
      endpoints: [
        'POST /mageagent/api/google/earth-engine (satellite imagery analysis)',
        'POST /mageagent/api/google/vertex-ai (geospatial ML predictions)',
        'POST /mageagent/api/google/bigquery (large-scale spatial analytics)',
        'GET /mageagent/api/google/health (service health check)'
      ],
      services: ['Earth Engine', 'Vertex AI', 'BigQuery GIS'],
      integration: 'Hybrid geospatial reasoning with PostGIS + Google Cloud'
    });

    // Setup Geospatial Prediction routes (LLM-based via OpenRouter)
    app.use('/mageagent/api/predictions', geospatialPredictionsRouter);

    logger.info('[Geospatial Prediction Routes] Mounted at /mageagent/api/predictions', {
      endpoints: [
        'POST /mageagent/api/predictions (dynamic operation-based predictions)',
        'GET /mageagent/api/predictions/:jobId (check prediction status)',
        'GET /mageagent/api/predictions (service information and examples)'
      ],
      dynamicCapability: '✅ FULLY DYNAMIC - Accepts ANY operation name without code changes',
      exampleOperations: [
        'land_use_classification',
        'solar_potential_analysis',
        'earthquake_risk_assessment',
        'air_quality_prediction',
        'ANY_GEOSPATIAL_OPERATION'
      ],
      backend: 'OpenRouter LLMs (Claude Opus 4, Claude Opus 4.6, GPT-4o)',
      streaming: 'WebSocket support for real-time prediction updates',
      notes: [
        'Zero hardcoded operations - service adapts to ANY geospatial prediction request',
        'LLM intelligence automatically generates appropriate prompts from operation names',
        'No code changes required for new operations'
      ]
    });

    // Setup Intelligent Retry Analytics routes
    const retryAnalyticsRouter = createRetryAnalyticsRoutes(databaseManager);
    app.use('/mageagent/api/retry', retryAnalyticsRouter);

    logger.info('[Intelligent Retry Analytics] Mounted at /mageagent/api/retry', {
      endpoints: [
        'GET /mageagent/api/retry/patterns (list error patterns with success rates)',
        'GET /mageagent/api/retry/patterns/:id (detailed pattern information)',
        'GET /mageagent/api/retry/attempts (query retry attempts with filtering)',
        'GET /mageagent/api/retry/analytics (aggregated metrics and effectiveness)',
        'GET /mageagent/api/retry/recommendation (get ML-based retry strategy)',
        'POST /mageagent/api/retry/cleanup (trigger cleanup of old attempts)'
      ],
      features: [
        'ML-based pattern recognition (85-90% accuracy)',
        'Adaptive learning from retry outcomes',
        '<50ms cached analysis latency',
        'Real-time WebSocket event streaming',
        'Production-grade PostgreSQL storage'
      ],
      database: 'PostgreSQL schema: retry_intelligence',
      integration: 'Fully integrated with OrchestrationAgent'
    });

    // Setup LLM routes for VPS Admin Dashboard
    const llmRouter = initializeLLMRoutes(openRouterClient);
    app.use('/mageagent/api/llm', llmRouter);

    logger.info('[LLM Routes] Mounted at /mageagent/api/llm', {
      endpoints: [
        'GET /mageagent/api/llm/models (list available models with search/filter)',
        'POST /mageagent/api/llm/chat (chat completions with model selection)',
        'GET /mageagent/api/llm/health (check OpenRouter configuration)'
      ],
      features: [
        'Secure backend proxy (API key hidden from browser)',
        'Model search and filtering by context length, modality, provider',
        'Rate limiting: 20 requests/minute (external), 100 requests/minute (internal)',
        'Circuit breaker protection with 30-minute timeout',
        'Automatic retry with exponential backoff'
      ],
      integration: 'VPS Admin Dashboard AI troubleshooting assistant',
      model: 'Claude Opus 4.6 (default) + 100+ OpenRouter models'
    });

    // Root endpoint - simplified
    app.get('/', (_req, res) => {
      res.json({
        service: 'MageAgent',
        version: '2.0.2-enterprise-routing',
        role: 'Orchestration Layer',
        status: 'running',
        routing: 'Enterprise pattern - /mageagent/api/* namespace',
        endpoints: {
          health: '/health (cached, Kubernetes-optimized)',
          healthz: '/healthz (instant response)',
          ready: '/readiness',
          liveness: '/liveness',
          ping: '/ping',
          api: '/mageagent/api/*'
        },
        dependencies: {
          openRouter: `${models.length} models available`,
          graphRAG: graphRAGHealthy ? 'healthy' : 'degraded'
        },
        websocket: {
          status: 'Moved to GraphRAG service',
          info: 'Connect to ws://graphrag:8090/graphrag for real-time updates'
        },
        architecture: {
          note: 'MageAgent is now purely an orchestration layer',
          dataOperations: 'All memory/RAG operations handled by GraphRAG service',
          separation: 'Clean separation of concerns achieved',
          healthChecks: 'Optimized with caching and rate limit exemption'
        }
      });
    });

    // GraphRAG WebSocket proxy info (just informational)
    app.get('/api/graphrag-websocket', (_req, res) => {
      res.json({
        message: 'WebSocket functionality has been moved to GraphRAG service',
        graphragWebSocket: {
          url: 'ws://graphrag:8090/graphrag',
          namespaces: [
            '/graphrag - Main namespace',
            '/graphrag/memory - Memory operations',
            '/graphrag/documents - Document operations',
            '/graphrag/search - Search operations'
          ],
          instructions: 'Connect directly to GraphRAG WebSocket for real-time updates'
        }
      });
    });

    // 404 handler - Use proper middleware
    app.use(notFoundHandler);

    // Global error handler - Use proper error handler middleware
    // This properly formats AppError instances with full context
    app.use(globalErrorHandler);

    // Create HTTP server with Socket.IO WebSocket support
    const server = createServer(app);

    // Configure server timeouts for long-running agent orchestration tasks
    // Default Node.js timeout is 2 minutes which is insufficient for complex multi-agent tasks
    server.timeout = 1800000; // 30 minutes - matches OpenRouter client timeout
    server.keepAliveTimeout = 1800000; // Keep connections alive for long tasks
    server.headersTimeout = 1810000; // Slightly longer than keepAlive to prevent race conditions

    // Initialize WebSocketManager for real-time streaming
    const wsManager = new WebSocketManager(server);
    logger.info('WebSocketManager initialized with Socket.IO support');

    // =========================================================================
    // GOD-MODE: Initialize Human Input Tool with WebSocket callback
    // Now that wsManager is available, we can set up the approval event emitter
    // =========================================================================
    humanInputTool = createHumanInputTool(
      redisClient,
      (event, userId) => {
        // Emit approval events to connected clients in user's room
        wsManager.io.to(userId).emit('approval:event', event);
        // Also broadcast globally for admin monitoring
        wsManager.io.emit('godmode:approval', {
          userId,
          event,
          timestamp: new Date().toISOString(),
        });
        logger.debug('GOD-MODE: Emitted approval event', {
          eventType: event.type,
          userId,
          requestId: event.requestId,
        });
      },
      {
        defaultTimeout: 300000,  // 5 minutes for user response
        maxPendingPerUser: 10,
        defaultApprovalMode: 'risky_only',
      }
    );
    setHumanInputTool(humanInputTool);
    logger.info('GOD-MODE: HumanInputTool initialized with WebSocket event emitter', {
      defaultTimeout: '5 minutes',
      maxPendingPerUser: 10,
      defaultApprovalMode: 'risky_only',
    });

    // Update autonomous routes with the now-initialized HumanInputTool
    updateGodModeTools({ humanInputTool });
    logger.info('GOD-MODE: Updated autonomous routes with HumanInputTool');

    // =========================================================================
    // GOD-MODE: Wire Planning Tool events to WebSocket broadcasts
    // These events enable real-time plan visibility in the frontend dashboard
    // =========================================================================
    planningTool.on('plan:created', (event) => {
      wsManager.io.emit('autonomous:plan_created', {
        ...event,
        timestamp: new Date().toISOString(),
      });
      logger.info('GOD-MODE: Emitted plan:created event', {
        planId: event.planId,
        userId: event.userId,
        stepsCount: event.steps?.length,
      });
    });

    planningTool.on('plan:progress', (event) => {
      wsManager.io.emit('autonomous:plan_progress', {
        ...event,
        timestamp: new Date().toISOString(),
      });
    });

    planningTool.on('plan:completed', (event) => {
      wsManager.io.emit('autonomous:plan_completed', {
        ...event,
        timestamp: new Date().toISOString(),
      });
      logger.info('GOD-MODE: Emitted plan:completed event', {
        planId: event.planId,
        success: event.success,
      });
    });

    planningTool.on('step:updated', (event) => {
      wsManager.io.emit('autonomous:step_updated', {
        ...event,
        timestamp: new Date().toISOString(),
      });
    });

    logger.info('GOD-MODE: Planning Tool events wired to WebSocket broadcasts');

    // CRITICAL FIX: Initialize EnhancedWebSocketManager for streaming-orchestrator
    // This singleton is required by streaming-routes.ts and streaming-orchestrator.ts
    // Previously missing, causing "Enhanced WebSocket Manager not initialized" errors
    initializeEnhancedWebSocketManager(server);
    logger.info('EnhancedWebSocketManager initialized for streaming orchestration');

    // Wire TaskManager events to WebSocket broadcasts with CORRECT event names for frontend
    // Frontend expects: agent:spawned, agent:progress, agent:complete, tool:executing, task:start

    taskManager.on('task:progress', (event: any) => {
      // Emit generic orchestration update for task progress
      wsManager.broadcastOrchestrationUpdate({
        agentId: event.metadata?.agentId,
        message: event.message || 'Task progress update',
        metadata: event
      });
    });

    taskManager.on('agent:started', (event: any) => {
      // CRITICAL: Frontend expects 'agent:spawned' event, not 'agent_stream'
      if (event.agentId) {
        wsManager.io.emit('agent:spawned', {
          agentId: event.agentId,
          name: event.name || event.agentId,
          model: event.model || 'unknown',
          status: 'spawned',
          timestamp: new Date().toISOString(),
          ...event
        });
        logger.info('Emitted agent:spawned event', { agentId: event.agentId });
      }
    });

    taskManager.on('agent:completed', (event: any) => {
      // CRITICAL: Frontend expects 'agent:complete' event
      if (event.agentId) {
        wsManager.io.emit('agent:complete', {
          agentId: event.agentId,
          status: 'complete',
          result: event.result,
          timestamp: new Date().toISOString(),
          ...event
        });
        logger.info('Emitted agent:complete event', { agentId: event.agentId });
      }
    });

    taskManager.on('agent:progress', (event: any) => {
      // CRITICAL: Frontend expects 'agent:progress' event with progress field
      if (event.agentId) {
        wsManager.io.emit('agent:progress', {
          agentId: event.agentId,
          progress: event.progress || 0,
          status: event.status || 'in progress',
          timestamp: new Date().toISOString(),
          ...event
        });
      }
    });

    // FUTURE: Add tool execution events when TaskManager emits them
    // taskManager.on('tool:started', (event: any) => {
    //   wsManager.io.emit('tool:executing', {
    //     toolName: event.toolName,
    //     description: event.description,
    //     agentId: event.agentId,
    //     timestamp: new Date().toISOString()
    //   });
    // });

    logger.info('TaskManager events wired to WebSocket broadcasts with correct event names');

    // Start server
    const PORT = config.port || 8080;
    server.listen(PORT, () => {
      logger.info(`MageAgent server with WebSocket streaming listening on port ${PORT}`);
      logger.info('Role: AI Orchestration with Real-Time Updates');
      logger.info('Health Checks: Optimized with caching and rate limit exemption');
      logger.info('WebSocket: Socket.IO enabled at /socket.io/ for real-time streaming');
      logger.info('Socket.IO Path: /mageagent/socket.io/ (custom path for VirtualService routing)');
      logger.info('Architecture: Orchestration + Real-Time WebSocket Streaming');
    });

    // Graceful shutdown with comprehensive cleanup
    const gracefulShutdown = async () => {
      logger.info('Shutdown signal received, closing server gracefully...');

      server.close(() => {
        logger.info('HTTP server closed');
        logger.info('Cleaning up all resources...');

        // PRODUCTION-GRADE CLEANUP: WAL checkpoints + all resources
        Promise.all([
          // CRITICAL: Recover any pending synthesis checkpoints before shutdown
          orchestrator.recoverPendingCheckpoints().catch(err => {
            logger.error('Failed to recover pending checkpoints during shutdown', {
              error: err instanceof Error ? err.message : String(err)
            });
          }),
          // Database and queue cleanup
          databaseManager.cleanup(),
          memoryStorageQueue.shutdown(),
          taskManager.shutdown(),
          // HTTP client cleanup
          openRouterClient.cleanup(),
          graphRAGClient.cleanup(),
          // Google Cloud clients cleanup (Phase 5)
          cleanupGoogleClients().catch(err => {
            logger.warn('Google Cloud clients cleanup failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err)
            });
          }),
          // Redis client cleanup for synthesis checkpoints
          redisClient.quit().catch(err => {
            logger.warn('Redis client quit failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err)
            });
          }),
          // Adaptive timeout manager disposal (EventEmitter cleanup)
          Promise.resolve().then(() => {
            adaptiveTimeoutManager.dispose();
          }),
          // Telemetry consumer cleanup for unified orchestration
          stopTelemetryConsumer().catch(err => {
            logger.warn('Telemetry consumer cleanup failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err)
            });
          }),
          // Telemetry publisher cleanup
          Promise.resolve().then(() => {
            telemetryPublisher.close().catch(() => {});
          }),
          // Flush pending usage reports
          flushPendingReports().catch(() => {}),
          // GOD-MODE: Planning Tool cleanup
          destroyPlanningTool().catch(err => {
            logger.warn('Planning Tool cleanup failed (non-fatal)', {
              error: err instanceof Error ? err.message : String(err)
            });
          })
        ]).then(() => {
          logger.info('All connections closed, exiting', {
            cleanupCompleted: [
              'HTTP server with Socket.IO',
              'Synthesis checkpoints recovered',
              'Database connections',
              'Memory storage queue',
              'Task manager',
              'OpenRouter client',
              'GraphRAG client',
              'Google Cloud clients (Earth Engine, Vertex AI, BigQuery)',
              'Redis checkpoint client',
              'Adaptive timeout manager',
              'Telemetry consumer (orchestration)',
              'Telemetry publisher',
              'Usage tracking reports',
              'GOD-MODE Planning Tool'
            ]
          });
          process.exit(0);
        }).catch(err => {
          logger.error('Error during shutdown', {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
          });
          process.exit(1);
        });
      });

      // Force exit after 10 seconds if graceful shutdown fails
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    promise
  });
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Start the MageAgent server with WebSocket streaming
if (require.main === module) {
  startMageAgentWithWebSocket().catch((error) => {
    logger.error('Server startup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
}

export { startMageAgentWithWebSocket };