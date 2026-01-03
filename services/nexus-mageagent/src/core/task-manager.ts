/**
 * Task Manager - Async Job Queue for Long-Running Agent Operations
 *
 * Implements Command Pattern + Observer Pattern with BullMQ/Redis
 * Eliminates timeout errors by returning task IDs immediately and processing jobs asynchronously
 */

import Bull, { Queue, Job, JobOptions } from 'bull';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import axios, { type AxiosInstance } from 'axios';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { createLogger } from '../utils/logger';
import type { ITaskRepository } from './task-repository.interface';
import type { ITaskRecoveryStrategy } from './task-recovery-strategy';
import { DistributedLockManager } from './distributed-lock';
import { StateReconciler } from './state-reconciler';
import { WorkerWatchdog } from './worker-watchdog';
import { WorkerHealthMonitor } from '../monitoring/worker-health';
import { ServiceUnavailableError, ConflictError, StateDesynchronizationError } from '../utils/errors';
// PHASE 31: Import TenantContext for multi-tenant context propagation
import type { TenantContext } from '../clients/graphrag-client';

const logger = createLogger('TaskManager');

export type TaskType = 'orchestrate' | 'analyze' | 'synthesize' | 'collaborate' | 'compete' |
  'vision_ocr' | 'layout_analysis' | 'table_extraction' | 'vision_analysis' |
  'text_classification' | 'sentiment_analysis' | 'topic_extraction' | 'audio_transcription' |
  'validateCode' | 'validateCommand' | 'geospatial_prediction' |
  // PHASE: Universal Request Orchestrator task types
  'workflow' | 'file_process' | 'security_scan' | 'code_execute';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  params: Record<string, any>;
  result?: any;
  error?: string;
  progress?: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  metadata?: Record<string, any>;
  agents?: any[]; // Optional agents array for orchestration tasks
  version: number; // Optimistic locking version for two-phase commit
  // PHASE 31: Tenant context for multi-tenant isolation across async boundaries
  tenantContext?: TenantContext;
}

export interface TaskManagerConfig {
  redisUrl: string;
  defaultTimeout?: number;
  maxTimeout?: number;
  concurrency?: number;
  removeOnComplete?: boolean;
  removeOnFail?: boolean;
  graphragUrl?: string; // GraphRAG base URL for WebSocket event forwarding
  enableWebSocketStreaming?: boolean; // Enable WebSocket progress streaming
  // NEW: Dependency injection for Repository Pattern (SOLID DIP)
  repository?: ITaskRepository; // Optional - falls back to in-memory Map if not provided
  recoveryStrategy?: ITaskRecoveryStrategy; // Optional - determines behavior on registry miss
  // NEW: Orchestrator for agent event forwarding
  orchestrator?: EventEmitter; // Optional - for forwarding agent:spawned, agent:progress, agent:complete events
  // NEW: Redis client for distributed locking and state reconciliation
  redisClient?: any; // Optional Redis client for distributed locks (typed as 'any' to avoid ioredis import)
}

export class TaskManager extends EventEmitter {
  private queue: Queue;
  private tasks: Map<string, Task> = new Map(); // Fallback in-memory cache
  private config: TaskManagerConfig & {
    defaultTimeout: number;
    maxTimeout: number;
    concurrency: number;
    removeOnComplete: boolean;
    removeOnFail: boolean;
  };
  private processors: Map<TaskType, (job: Job) => Promise<any>> = new Map();
  private graphragClient: AxiosInstance | null = null;
  private workerStarted: boolean = false;
  // Task state synchronization mutex to prevent race conditions
  private taskStateLocks: Map<string, Promise<void>> = new Map();
  // PHASE 3 FIX: Keep references to HTTP agents for proper cleanup
  private httpAgent: HttpAgent | null = null;
  private httpsAgent: HttpsAgent | null = null;
  // PHASE 4 FIX: Initialization mutex to prevent race conditions
  private initializationLock: Promise<void> | null = null;
  private isInitializing = false;
  // NEW: Repository Pattern for persistent task storage (SOLID DIP)
  private repository: ITaskRepository | null = null;
  private recoveryStrategy: ITaskRecoveryStrategy | null = null;
  private useRepository: boolean = false; // Feature flag
  // PHASE 1 TASK 1.4: Two-Phase Commit Dependencies
  private lockManager: DistributedLockManager | null = null;
  private stateReconciler: StateReconciler | null = null;
  // PHASE 2 TASK 2.4: Worker Watchdog with External Timeout
  private workerWatchdog: WorkerWatchdog | null = null;
  private workerHealthMonitor: WorkerHealthMonitor | null = null;

  constructor(config: TaskManagerConfig) {
    super();

    this.config = {
      redisUrl: config.redisUrl,
      defaultTimeout: config.defaultTimeout || 300000,  // 5 minutes default
      maxTimeout: config.maxTimeout || 1800000,         // 30 minutes max (increased from 10 min for extreme complexity tasks)
      concurrency: config.concurrency || 5,
      removeOnComplete: config.removeOnComplete ?? false,
      removeOnFail: config.removeOnFail ?? false,
      graphragUrl: config.graphragUrl || process.env.GRAPHRAG_URL || 'http://nexus-graphrag:8090',
      enableWebSocketStreaming: config.enableWebSocketStreaming ?? true
    };

    // NEW: Initialize repository if provided (Dependency Injection)
    if (config.repository) {
      this.repository = config.repository;
      this.recoveryStrategy = config.recoveryStrategy || null;
      this.useRepository = true;

      logger.info('TaskManager using persistent Redis repository', {
        repositoryType: config.repository.constructor.name,
        recoveryStrategy: config.recoveryStrategy?.name || 'none'
      });

      // PHASE 1 TASK 1.4: Initialize Two-Phase Commit dependencies
      if (config.redisClient) {
        // Initialize Distributed Lock Manager
        this.lockManager = new DistributedLockManager(
          config.redisClient,
          'nexus:task-locks'
        );

        // Initialize State Reconciler
        this.stateReconciler = new StateReconciler(config.repository, {
          strategy: 'version-based',
          autoReconcile: true,
          reconciliationIntervalMs: 60000,
          maxRetries: 3
        });

        logger.info('Two-Phase Commit system initialized', {
          lockManager: 'DistributedLockManager',
          stateReconciler: 'StateReconciler',
          strategy: 'version-based'
        });
      } else {
        logger.warn('Redis client not provided - distributed locking disabled', {
          warning: 'Two-phase commit will use simple mutex (not distributed)'
        });
      }
    } else {
      logger.info('TaskManager using in-memory task storage (ephemeral)', {
        warning: 'Tasks will be lost on service restart'
      });
    }

    // PHASE 2 TASK 2.4: Initialize Worker Watchdog and Health Monitoring
    this.workerWatchdog = new WorkerWatchdog(logger, this, {
      gracePeriod: 30000, // 30 seconds grace period
      enableForceKill: true,
      enableMetrics: true
    });

    this.workerHealthMonitor = new WorkerHealthMonitor(logger, {
      degradedErrorRate: 5,
      unhealthyErrorRate: 10,
      degradedConsecutiveErrors: 3,
      unhealthyConsecutiveErrors: 5,
      unhealthyConsecutiveTimeouts: 2,
      degradedProcessingRate: 1
    });

    // Listen for health state changes
    this.workerHealthMonitor.on('healthStateChanged', (event) => {
      logger.warn('Worker health state changed', event);
      this.emit('workerHealthChanged', event);
    });

    logger.info('Worker Watchdog and Health Monitoring initialized', {
      watchdogGracePeriod: 30000,
      healthMonitoring: 'enabled'
    });

    // Initialize BullMQ queue
    // PHASE 23 FIX: Set lockDuration in Queue settings (NOT in process() call)
    // Bull v4 API: settings.lockDuration prevents job stalling for long-running processors
    this.queue = new Bull('mageagent-tasks', this.config.redisUrl, {
      settings: {
        lockDuration: 600000,        // 10 minutes - prevents job watchdog timeout
        stalledInterval: 30000,      // Check for stalled jobs every 30s
        maxStalledCount: 2           // Mark as failed after 2 stalled checks
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        removeOnComplete: this.config.removeOnComplete,
        removeOnFail: this.config.removeOnFail
      }
    });

    // PHASE 23: Log Bull configuration for verification
    logger.info('[BULL-INIT] Task queue initialized with extended lock duration', {
      queueName: 'mageagent-tasks',
      settings: {
        lockDuration: 600000,
        stalledInterval: 30000,
        maxStalledCount: 2
      },
      concurrency: this.config.concurrency,
      redisConnected: true
    });

    // Initialize GraphRAG client for WebSocket event forwarding
    if (this.config.enableWebSocketStreaming && this.config.graphragUrl) {
      // PHASE 3 FIX: Create HTTP/HTTPS agents with proper connection pooling
      this.httpAgent = new HttpAgent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 20,
        maxFreeSockets: 5,
        timeout: 5000,
        scheduling: 'fifo'
      });

      this.httpsAgent = new HttpsAgent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 20,
        maxFreeSockets: 5,
        timeout: 5000,
        scheduling: 'fifo'
      });

      this.graphragClient = axios.create({
        baseURL: this.config.graphragUrl,
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'x-source': 'mageagent-taskmanager'
        },
        httpAgent: this.httpAgent, // PHASE 3: Use custom agents
        httpsAgent: this.httpsAgent
      });

      logger.info('GraphRAG WebSocket streaming enabled', {
        graphragUrl: this.config.graphragUrl
      });
    }

    // Wire orchestrator events to forward agent orchestration events to GraphRAG
    if (config.orchestrator) {
      config.orchestrator.on('agent:spawned', (data: any) => {
        this.forwardAgentEventToGraphRAG(data.taskId, 'spawned', data);
      });

      config.orchestrator.on('agent:progress', (data: any) => {
        this.forwardAgentEventToGraphRAG(data.taskId, 'progress', data);
      });

      config.orchestrator.on('agent:complete', (data: any) => {
        this.forwardAgentEventToGraphRAG(data.taskId, 'complete', data);
      });

      logger.info('Orchestrator event forwarding enabled', {
        events: ['agent:spawned', 'agent:progress', 'agent:complete']
      });
    }

    this.setupEventListeners();
    logger.info('TaskManager initialized', {
      redisUrl: this.config.redisUrl,
      defaultTimeout: this.config.defaultTimeout,
      maxTimeout: this.config.maxTimeout,
      concurrency: this.config.concurrency,
      webSocketStreaming: this.config.enableWebSocketStreaming
    });
  }

  /**
   * Wire orchestrator to forward agent events to GraphRAG WebSocket
   * This allows wiring the orchestrator after TaskManager initialization
   * when orchestrator is created later in the dependency chain
   */
  wireOrchestrator(orchestrator: EventEmitter): void {
    orchestrator.on('agent:spawned', (data: any) => {
      this.forwardAgentEventToGraphRAG(data.taskId, 'spawned', data);
    });

    orchestrator.on('agent:progress', (data: any) => {
      this.forwardAgentEventToGraphRAG(data.taskId, 'progress', data);
    });

    orchestrator.on('agent:complete', (data: any) => {
      this.forwardAgentEventToGraphRAG(data.taskId, 'complete', data);
    });

    logger.info('Orchestrator wired for agent event forwarding', {
      events: ['agent:spawned', 'agent:progress', 'agent:complete']
    });
  }

  /**
   * REFACTORED: Register a processor function for a specific task type
   * Does NOT call queue.process() - that happens in startWorker()
   * PHASE 4 FIX: Added initialization lock check
   * PHASE 33: Updated signature to include tenantContext for multi-tenant isolation
   */
  registerProcessor(type: TaskType, processor: (params: any, context?: { jobId: string; tenantContext?: TenantContext }) => Promise<any>): void {
    // Wait for any ongoing initialization
    if (this.initializationLock) {
      throw new Error(
        `Cannot register processor while initialization is in progress.\n` +
        `Type: ${type}\n` +
        `Please wait for initialization to complete.`
      );
    }

    if (this.workerStarted) {
      throw new Error(
        `Cannot register processor '${type}' after worker has started.\n` +
        `All processors must be registered before calling startWorker().\n` +
        `Current state: Worker running with ${this.processors.size} processors.`
      );
    }

    // Set initialization flag
    this.isInitializing = true;

    this.processors.set(type, async (job: Job) => {
      const taskId = job.data.taskId;

      // PHASE 29e FIX: Check in-memory first (should be populated by createTask)
      // If not in memory but in repository, populate memory for two-phase commit
      let task: Task | null = this.tasks.get(taskId) || null;

      // If not in memory, try repository and populate memory
      if (!task && this.useRepository && this.repository) {
        try {
          task = await this.repository.findById(taskId);
          if (task) {
            // Populate in-memory cache for two-phase commit working copy
            this.tasks.set(taskId, task);
            logger.debug('Task loaded from repository into memory', {
              taskId,
              type,
              status: task.status,
              version: task.version
            });
          }
        } catch (repoError: any) {
          logger.error('[PROCESSOR] Repository lookup failed', {
            taskId,
            type,
            error: repoError.message
          });
          // Continue to fallback recovery below
        }
      }

      // PHASE 57: Recovery fallback - reconstruct task from Bull job metadata
      // This handles orphaned jobs from before Phase 57 fix (repository save failures)
      if (!task) {
        logger.warn('[PROCESSOR-RECOVERY] Task not in registry, attempting reconstruction from job', {
          taskId,
          jobId: job.id,
          jobName: job.name,
          hasJobData: !!job.data
        });

        try {
          // Reconstruct minimal task from Bull job metadata
          const reconstructedTask: Task = {
            id: taskId,
            type: type as TaskType,
            status: 'pending',
            params: job.data.params || {},
            createdAt: new Date(job.timestamp),
            progress: 0,
            version: 1,
            metadata: job.data.metadata || { timeout: this.config.defaultTimeout, priority: 0 },
            tenantContext: job.data.tenantContext
          };

          // Save reconstructed task to both memory and repository
          this.tasks.set(taskId, reconstructedTask);
          task = reconstructedTask;

          if (this.useRepository && this.repository) {
            try {
              await this.repository.save(reconstructedTask);
              logger.info('[PROCESSOR-RECOVERY] Reconstructed task saved to repository', {
                taskId,
                type,
                reconstructedFrom: 'bull-job-metadata'
              });
            } catch (saveError: any) {
              logger.warn('[PROCESSOR-RECOVERY] Could not save reconstructed task to repository', {
                taskId,
                error: saveError.message
              });
              // Continue with in-memory only for this execution
            }
          }

          logger.info('[PROCESSOR-RECOVERY] Task reconstructed successfully from job metadata', {
            taskId,
            type,
            jobId: job.id,
            reconstructedAt: new Date().toISOString()
          });
        } catch (reconstructError: any) {
          logger.error('[PROCESSOR-RECOVERY] Task reconstruction failed', {
            taskId,
            jobId: job.id,
            error: reconstructError.message
          });
          // Fall through to error below
        }
      }

      if (!task) {
        throw new Error(
          `Task ${taskId} not found in task registry and reconstruction failed.\n` +
          `Job ID: ${job.id}\n` +
          `Job Type: ${type}\n` +
          `This indicates severe desynchronization between job queue and task repository.\n` +
          `Possible causes: Repository failure during task creation, or corrupted job data.`
        );
      }

      // Atomic task state transition to 'running'
      // PHASE 29e FIX: Removed duplicate repository update from inside updateFn
      // The updateTaskStateAtomic() function handles repository writes in two-phase commit
      await this.updateTaskStateAtomic(taskId, async () => {
        task!.status = 'running';
        task!.startedAt = new Date();
        // Note: Repository update is handled by updateTaskStateAtomic's two-phase commit
      });

      this.emit('task:started', task);

      // Forward task started event to GraphRAG WebSocket
      await this.forwardTaskEventToGraphRAG(taskId, 'started', {
        task: {
          id: task.id,
          type: task.type,
          status: task.status,
          startedAt: task.startedAt
        }
      });

      // NEW: Emit queue:started event for this specific task
      await this.forwardQueueEventToGraphRAG(taskId, 'started', {
        startedAt: task.startedAt
      });

      // REMOVED: Self-listening pattern that caused infinite recursion
      // The orchestrator will emit progress events directly to TaskManager
      // which will be picked up by the SSE endpoint without re-emission

      try {
        // REFACTORED: Enforce timeout with Promise.race() pattern
        const timeout = task.metadata?.timeout || this.config.defaultTimeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(
              `Task execution timeout after ${timeout}ms.\n` +
              `Task ID: ${taskId}\n` +
              `Task Type: ${type}\n` +
              `Started: ${task.startedAt?.toISOString()}\n` +
              `Timeout Configuration: ${timeout}ms\n` +
              `This task exceeded the maximum allowed execution time.`
            ));
          }, timeout);
        });

        // PHASE 33: Extract tenantContext from job.data for multi-tenant isolation
        const tenantContext = job.data.tenantContext;

        // Execute processor with timeout enforcement, job context, tenant context, and job reference
        // PHASE 60 FIX: Pass job reference so processors can call job.progress()
        const result = await Promise.race([
          processor(job.data.params, { jobId: String(job.id), tenantContext, job }),
          timeoutPromise
        ]);

        // No cleanup needed - self-listening pattern removed

        // PHASE 26 DIAGNOSTIC: Log before completion update
        logger.info('[PHASE26-DIAG] Task processing COMPLETED - updating status', {
          taskId,
          type,
          hasResult: !!result,
          useRepository: this.useRepository,
          repositoryInitialized: this.repository !== null
        });

        // Atomic task state transition to 'completed'
        // PHASE 30 FIX: Removed duplicate repository.update() from inside updateFn
        // The updateTaskStateAtomic() function handles repository writes in two-phase commit
        // Calling repository.update() inside the callback ALSO causes a version increment,
        // leading to "version conflict" errors when the outer two-phase commit tries to write.
        await this.updateTaskStateAtomic(taskId, async () => {
          task!.status = 'completed';
          task!.result = result;
          task!.completedAt = new Date();
          task!.progress = 100;

          logger.info('[PHASE30] In-memory task updated to completed (repository write handled by two-phase commit)', {
            taskId,
            status: task!.status,
            completedAt: task!.completedAt
          });
          // Note: Repository update is handled by updateTaskStateAtomic's two-phase commit
        });

        logger.info('[PHASE26-DIAG] ✅ Task completion update FINISHED', {
          taskId,
          finalStatus: task?.status,
          stored: this.tasks.has(taskId)
        });

        this.emit('task:completed', task);

        // REFACTORED: Store result in BOTH Redis (via BullMQ returnvalue) AND GraphRAG
        // Redis provides short-term retrieval, GraphRAG provides long-term persistence
        const completedAt = task.completedAt!; // Set above in atomic update
        const duration = completedAt.getTime() - task.startedAt!.getTime();

        await Promise.all([
          // Forward completion event to GraphRAG WebSocket for real-time updates
          this.forwardTaskEventToGraphRAG(taskId, 'completed', {
            result,
            completedAt,
            duration
          }),
          // Store full result as document in GraphRAG for semantic search
          this.storeTaskResultInGraphRAG(taskId, type, result)
        ]);

        // NEW: Emit queue position updates for waiting tasks
        // This notifies all queued tasks that they moved up in the queue
        await this.emitQueuePositionUpdates();

        logger.info('Task completed successfully', {
          taskId,
          type,
          duration
        });

        return result;
      } catch (error: any) {
        // Atomic task state transition to 'failed' or 'timeout'
        // PHASE 30 FIX: Removed duplicate repository.update() from inside updateFn
        // The updateTaskStateAtomic() function handles repository writes in two-phase commit
        await this.updateTaskStateAtomic(taskId, async () => {
          task!.status = error.message.includes('timeout') ? 'timeout' : 'failed';
          task!.error = error.message;
          task!.completedAt = new Date();
          // Note: Repository update is handled by updateTaskStateAtomic's two-phase commit
        });

        this.emit('task:failed', task);

        // Forward failure event to GraphRAG WebSocket
        await this.forwardTaskEventToGraphRAG(taskId, 'failed', {
          error: error.message,
          stack: error.stack,
          completedAt: task.completedAt
        });

        logger.error('Task failed', { taskId, type, error: error.message, stack: error.stack });

        throw error;
      }
    });

    // REFACTORED: Do NOT call queue.process() here
    // Worker initialization happens in startWorker() method
    this.isInitializing = false;

    logger.info('Registered processor (worker not started yet)', {
      type,
      totalProcessors: this.processors.size
    });
  }

  /**
   * PHASE 27 REFACTORED: Unified worker with internal routing
   * Fixes Phase 26 regression by maintaining full task lifecycle management
   *
   * Critical changes from Phase 26:
   * 1. Single worker with internal routing instead of multiple workers
   * 2. Maintains processor wrapper that handles task state management
   * 3. Preserves repository updates and event emissions
   * 4. Ensures processor signature compatibility (params, context)
   *
   * This method MUST be called after all processors are registered
   * and BEFORE any tasks are created.
   */
  async startWorker(): Promise<void> {
    // Create initialization lock
    if (this.initializationLock) {
      logger.warn('[PHASE27] Worker initialization already in progress, waiting...');
      await this.initializationLock;
      return;
    }

    if (this.workerStarted) {
      logger.warn('[PHASE27] Worker already started, ignoring duplicate startWorker() call');
      return;
    }

    // Wait for any ongoing processor registration
    if (this.isInitializing) {
      await new Promise<void>(resolve => {
        const checkInterval = setInterval(() => {
          if (!this.isInitializing) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);
      });
    }

    // Create and store initialization promise
    this.initializationLock = (async () => {
      try {
        if (this.processors.size === 0) {
          throw new Error(
            'Cannot start worker with zero registered processors.\n' +
            'Call registerProcessor() for each task type before startWorker().'
          );
        }

        logger.info('[PHASE29-WORKER-INIT] Starting Bull worker registration per job type', {
          totalProcessors: this.processors.size,
          processorTypes: Array.from(this.processors.keys()),
          concurrency: this.config.concurrency,
          architecture: 'Named handlers per task type',
          phase: 29,
          note: 'CRITICAL FIX: Bull v4 requires queue.process(jobName, callback) for named jobs'
        });

        // PHASE 29 FIX: Register a NAMED process handler for EACH task type
        // Bull v4 (classic bull library) REQUIRES matching job names:
        //   - queue.add('orchestrate', data) creates a NAMED job
        //   - queue.process(callback) only handles UNNAMED jobs
        //   - queue.process('orchestrate', callback) handles 'orchestrate' jobs
        // The Phase 27 comment was INCORRECT - Bull v4 does NOT process all job types
        // with an unnamed handler when jobs are added with names.

        // Create shared processor function to avoid code duplication
        const createJobProcessor = (taskType: TaskType) => async (job: Job) => {
          const taskId = job.data.taskId;

          logger.info('[PHASE29-WORKER] ✅ Job picked up by named handler', {
            taskType,
            jobId: job.id,
            jobName: job.name,
            taskId,
            timestamp: new Date().toISOString()
          });

          // Get the processor wrapper function (includes full task lifecycle management)
          const processorWrapper = this.processors.get(taskType);
          if (!processorWrapper) {
            logger.error('[PHASE29-WORKER] No processor registered for task type', {
              taskType,
              jobName: job.name,
              availableProcessors: Array.from(this.processors.keys())
            });
            throw new Error(
              `No processor registered for task type '${taskType}'.\n` +
              `Available processors: ${Array.from(this.processors.keys()).join(', ')}\n` +
              `Job ID: ${job.id}\n` +
              `Task ID: ${taskId}`
            );
          }

          // PHASE 2 TASK 2.4: Get timeout for watchdog monitoring
          const timeout = job.data.metadata?.timeout || this.config.defaultTimeout;

          logger.info('[PHASE29-WORKER] Executing processor wrapper with task lifecycle and watchdog', {
            taskType,
            taskId,
            timeout,
            hasWrapper: true,
            hasWatchdog: true,
            note: 'Wrapper handles task state transitions, watchdog prevents infinite hangs'
          });

          // Update health monitor heartbeat
          this.workerHealthMonitor?.heartbeat();

          const startTime = Date.now();

          try {
            // PHASE 2 TASK 2.4: Wrap processor execution in WorkerWatchdog
            // Watchdog provides external timeout that force-kills stalled tasks
            const result = await this.workerWatchdog!.monitor(
              taskId,
              taskType,
              timeout,
              () => processorWrapper(job)
            );

            // Record successful task completion
            const duration = Date.now() - startTime;
            this.workerHealthMonitor?.recordSuccess(duration);

            logger.info('[WATCHDOG] Task completed successfully', {
              taskId,
              taskType,
              duration
            });

            return result;

          } catch (error: any) {
            // Record task error
            const duration = Date.now() - startTime;
            this.workerHealthMonitor?.recordError(duration);

            // Check if this was a watchdog timeout
            if (error.code === 'WORKER_WATCHDOG_TIMEOUT') {
              this.workerHealthMonitor?.recordWatchdogTimeout();
              logger.error('[WATCHDOG] Task exceeded watchdog timeout', {
                taskId,
                taskType,
                duration,
                error: error.message
              });
            }

            // Re-throw error for Bull to handle (triggers retry or DLQ)
            throw error;
          }
        };

        // PHASE 58m: REVERTED - Promise.all() causes startup hang in production
        // Bull queue workers ARE functioning correctly (verified by log evidence)
        // Real issue was missing tenant context (fixed in Phase 58n)
        for (const taskType of this.processors.keys()) {
          logger.info('[PHASE29-WORKER-INIT] Registering named handler', {
            taskType,
            concurrency: this.config.concurrency
          });

          // Bull v4 API: queue.process(name, concurrency, processor)
          this.queue.process(taskType, this.config.concurrency, createJobProcessor(taskType));
        }

        // PHASE 59q: Wait for bclient (blocking client) to be created
        // CRITICAL ROOT CAUSE FIX: Bull v4 requires bclient for BRPOPLPUSH operations
        // to move jobs from wait queue to active queue. bclient is created asynchronously
        // when queue.process() is called, but the Promise from queue.process() only resolves
        // when the worker STOPS (not when it STARTS). This has been the recurring issue
        // since Phase 26 that has caused 5+ failed fix attempts.
        //
        // Previous Failed Approaches:
        // - Phase 26-27: Ignored bclient initialization entirely
        // - Phase 58m: Tried await Promise.all() on process() → SERVER HANG
        //
        // Correct Approach (Phase 59q):
        // Poll for bclient existence with timeout instead of awaiting unresolvable promises
        logger.info('[PHASE59q] Polling for bclient initialization...');

        const maxWaitMs = 5000; // 5 second timeout
        const pollIntervalMs = 100; // Poll every 100ms
        const startTime = Date.now();
        let bclientExists = false;

        while (Date.now() - startTime < maxWaitMs) {
          // Check if bclient exists on the queue instance
          // Bull creates this as a private property when process() is called
          if ((this.queue as any)['bclient']) {
            const waitTime = Date.now() - startTime;
            logger.info('[PHASE59q] ✅ bclient initialized successfully', {
              waitTime: `${waitTime}ms`,
              bclientExists: true,
              redisConnectionState: 'connected',
              workersReady: true,
              note: 'Workers can now pull jobs from wait queue using BRPOPLPUSH'
            });
            bclientExists = true;
            break;
          }

          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        // FAIL FAST: If bclient doesn't exist after timeout, throw error
        // This prevents the service from appearing healthy when workers can't process jobs
        if (!bclientExists) {
          const errorDetails = {
            timeoutMs: maxWaitMs,
            queueName: 'mageagent-tasks',
            registeredProcessors: Array.from(this.processors.keys()),
            processorCount: this.processors.size,
            redisConnected: this.queue.client?.status === 'ready',
            suggestion: 'Check Redis connection and Bull queue configuration. ' +
                       'bclient is required for Bull to use BRPOPLPUSH to pull jobs from wait queue.'
          };

          logger.error('[PHASE59q] ❌ bclient failed to initialize within timeout', errorDetails);

          throw new Error(
            `CRITICAL: Bull bclient failed to initialize within ${maxWaitMs}ms timeout.\n` +
            `Workers will NOT be able to process jobs.\n` +
            `Queue: ${errorDetails.queueName}\n` +
            `Registered Processors: ${errorDetails.processorCount}\n` +
            `Redis Connected: ${errorDetails.redisConnected}\n\n` +
            `Root Cause: Bull v4 requires bclient (blocking Redis client) for BRPOPLPUSH operations.\n` +
            `Without bclient, jobs remain stuck in wait queue and workers never pick them up.\n\n` +
            `Troubleshooting:\n` +
            `1. Check Redis connection health\n` +
            `2. Verify Bull queue configuration\n` +
            `3. Check Bull library version (requires v4.x)\n` +
            `4. Review Redis client connection logs\n\n` +
            `This error prevents silent failures where the service appears healthy but doesn't process jobs.`
          );
        }

        this.workerStarted = true;
      } finally {
        this.initializationLock = null;
      }
    })();

    await this.initializationLock;
  }

  /**
   * PHASE 1 TASK 1.4: Two-Phase Commit for Task State Updates
   *
   * Implements production-grade two-phase commit pattern to eliminate state divergence:
   *
   * ALGORITHM:
   * ┌─────────────────────────────────────────────────────────────────┐
   * │ PHASE 1: PREPARE (Repository Health + Lock Acquisition)        │
   * ├─────────────────────────────────────────────────────────────────┤
   * │ 1. Check repository health (fail-fast if unavailable)           │
   * │ 2. Acquire distributed lock (prevents concurrent modifications) │
   * └─────────────────────────────────────────────────────────────────┘
   *
   * ┌─────────────────────────────────────────────────────────────────┐
   * │ PHASE 2: COMMIT (Repository-First Write Pattern)               │
   * ├─────────────────────────────────────────────────────────────────┤
   * │ 1. Fetch current task from repository (authoritative source)    │
   * │ 2. Execute update function (in-memory state change)             │
   * │ 3. Write to repository WITH version check (atomic)              │
   * │ 4. Update in-memory ONLY after repository success               │
   * └─────────────────────────────────────────────────────────────────┘
   *
   * ┌─────────────────────────────────────────────────────────────────┐
   * │ PHASE 3: CLEANUP (Lock Release + Reconciliation)               │
   * ├─────────────────────────────────────────────────────────────────┤
   * │ 1. Release distributed lock (always, even on error)             │
   * │ 2. Reconcile state if divergence detected                       │
   * └─────────────────────────────────────────────────────────────────┘
   *
   * ERROR HANDLING:
   * - ServiceUnavailableError: Repository health check failed
   * - ConflictError: Version mismatch (concurrent modification detected)
   * - StateDesynchronizationError: State reconciliation failed
   * - OperationError: Lock acquisition timeout
   *
   * METRICS:
   * - Lock acquisition time
   * - Repository write latency
   * - Version conflicts
   * - State reconciliations
   *
   * @param taskId - Task ID to update
   * @param updateFn - Update function that modifies task state
   * @throws {ServiceUnavailableError} if repository unavailable
   * @throws {ConflictError} if version conflict detected
   * @throws {StateDesynchronizationError} if reconciliation fails
   */
  private async updateTaskStateAtomic(
    taskId: string,
    updateFn: () => Promise<void> | void
  ): Promise<void> {
    const startTime = Date.now();
    let lockToken: string | undefined;

    // PHASE 0: Fast path for non-repository mode (legacy behavior)
    if (!this.useRepository || !this.repository) {
      // Simple in-memory update with mutex (no distributed lock needed)
      const existingLock = this.taskStateLocks.get(taskId);
      if (existingLock) {
        await existingLock;
      }

      const updatePromise = (async () => {
        try {
          await updateFn();
        } finally {
          this.taskStateLocks.delete(taskId);
        }
      })();

      this.taskStateLocks.set(taskId, updatePromise);
      await updatePromise;
      return;
    }

    // PHASE 1: PREPARE - Health Check + Lock Acquisition
    try {
      // Step 1.1: Check repository health (fail-fast)
      const isHealthy = await this.repository.healthCheck();
      if (!isHealthy) {
        throw new ServiceUnavailableError(
          'Task repository unavailable - cannot guarantee state consistency',
          {
            service: 'RedisTaskRepository',
            suggestion: 'Check Redis health and network connectivity'
          }
        );
      }

      // Step 1.2: Acquire distributed lock
      if (this.lockManager) {
        const lockResult = await this.lockManager.acquire(`task-state:${taskId}`, {
          ttlMs: 10000, // 10 second lock
          retryCount: 3,
          retryDelayMs: 100,
          retryBackoffMultiplier: 2
        });

        if (!lockResult.acquired) {
          throw new ConflictError(
            `Could not acquire lock for task ${taskId} - concurrent modification in progress`,
            {
              context: { taskId, lockTimeout: '10s' },
              suggestion: 'Retry the operation after a short delay'
            }
          );
        }

        lockToken = lockResult.token;
        logger.debug('Distributed lock acquired', {
          taskId,
          lockToken,
          expiresAt: lockResult.expiresAt
        });
      } else {
        // Fallback to simple mutex if distributed lock unavailable
        const existingLock = this.taskStateLocks.get(taskId);
        if (existingLock) {
          await existingLock;
        }
      }

      // PHASE 2: COMMIT - Repository-First Write Pattern
      try {
        // Step 2.1: Fetch current task from repository (authoritative source)
        const repositoryTask = await this.repository.findById(taskId);

        if (!repositoryTask) {
          logger.warn('Task not found in repository during update', {
            taskId,
            warning: 'Possible race condition or task deleted'
          });
          throw new ConflictError(
            `Task ${taskId} not found in repository`,
            {
              context: { taskId },
              suggestion: 'Verify task exists before attempting update'
            }
          );
        }

        const currentVersion = repositoryTask.version;

        // Step 2.2: Execute update function (modifies in-memory state)
        await updateFn();

        // Step 2.3: Get updated task from memory
        const memoryTask = this.tasks.get(taskId);
        if (!memoryTask) {
          throw new StateDesynchronizationError(
            `Task ${taskId} disappeared from memory during update`,
            {
              context: { taskId, phase: 'post-updateFn' },
              suggestion: 'Check for memory leaks or accidental task deletion'
            }
          );
        }

        // Step 2.4: Write to repository WITH version check (atomic)
        // This will throw ConflictError if version mismatch detected
        const updatePayload = {
          status: memoryTask.status,
          result: memoryTask.result,
          error: memoryTask.error,
          progress: memoryTask.progress,
          startedAt: memoryTask.startedAt,
          completedAt: memoryTask.completedAt,
          metadata: memoryTask.metadata
        };

        // DIAGNOSTIC: Log exactly what we're writing to repository
        logger.info('[TWO-PHASE-DIAG] About to write to repository', {
          taskId,
          expectedVersion: currentVersion,
          updatePayload: {
            status: updatePayload.status,
            progress: updatePayload.progress,
            hasResult: updatePayload.result !== undefined,
            hasError: !!updatePayload.error,
            completedAt: updatePayload.completedAt?.toISOString()
          }
        });

        const updateSuccess = await this.repository.update(
          taskId,
          updatePayload,
          {
            expectedVersion: currentVersion // Optimistic locking
          }
        );

        if (!updateSuccess) {
          throw new ConflictError(
            `Failed to update task ${taskId} in repository`,
            {
              context: { taskId, expectedVersion: currentVersion },
              suggestion: 'Version conflict or concurrent modification detected'
            }
          );
        }

        // Step 2.5: Sync version in memory (repository auto-incremented it)
        memoryTask.version = currentVersion + 1;

        const duration = Date.now() - startTime;
        logger.debug('Two-phase commit completed successfully', {
          taskId,
          duration,
          oldVersion: currentVersion,
          newVersion: memoryTask.version,
          status: memoryTask.status
        });
      } catch (error) {
        // Repository write failed - attempt state reconciliation
        if (this.stateReconciler) {
          logger.warn('Repository update failed, attempting state reconciliation', {
            taskId,
            error: error instanceof Error ? error.message : String(error)
          });

          try {
            const memoryTask = this.tasks.get(taskId) || null;
            const reconciliationResult = await this.stateReconciler.reconcile(taskId, memoryTask);

            logger.info('State reconciliation completed', {
              taskId,
              diverged: reconciliationResult.diverged,
              reconciled: reconciliationResult.reconciled,
              authoritativeSource: reconciliationResult.authoritativeSource,
              action: reconciliationResult.action
            });

            // Update memory if repository was authoritative
            if (reconciliationResult.action === 'memory_updated' && reconciliationResult.authoritativeSource === 'repository') {
              // Note: Caller should handle memory update based on reconciliation
              logger.debug('Memory should be updated from repository', { taskId });
            }
          } catch (reconciliationError) {
            logger.error('State reconciliation failed', {
              taskId,
              error: reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError)
            });
          }
        }

        // Re-throw original error
        throw error;
      }
    } finally {
      // PHASE 3: CLEANUP - Release lock (always, even on error)
      if (lockToken && this.lockManager) {
        const released = await this.lockManager.release(`task-state:${taskId}`, lockToken);
        logger.debug('Distributed lock released', { taskId, lockToken, released });
      }

      // Clean up in-memory mutex
      this.taskStateLocks.delete(taskId);
    }
  }

  /**
   * Create a new task and add it to the job queue
   * REFACTORED: Save to repository FIRST (persistent), then enqueue (ephemeral)
   * PHASE 28: Enhanced error handling and diagnostic logging
   * PHASE 31: Added tenantContext option for multi-tenant context propagation
   *
   * @param type - Task type (orchestrate, analyze, etc.)
   * @param params - Task parameters
   * @param options - Task options including timeout, priority, metadata, and tenantContext
   * @returns Task ID
   */
  async createTask(
    type: TaskType,
    params: any,
    options?: {
      timeout?: number;
      priority?: number;
      metadata?: any;
      // PHASE 31: Tenant context for propagation through async Bull queue
      tenantContext?: TenantContext;
    }
  ): Promise<string> {
    // PHASE 28: Add comprehensive entry logging
    logger.info('[PHASE28-CREATE-TASK] Starting task creation', {
      type,
      workerStarted: this.workerStarted,
      processorCount: this.processors.size,
      hasQueue: !!this.queue,
      registeredProcessors: Array.from(this.processors.keys()),
      options
    });

    if (!this.workerStarted) {
      logger.error('[PHASE28-CREATE-TASK] Worker not started - cannot create task', {
        type,
        processorCount: this.processors.size,
        workerStarted: this.workerStarted
      });
      throw new Error(
        'Cannot create tasks before worker is started.\n' +
        'Call startWorker() after registering all processors.\n' +
        `Current state: ${this.processors.size} processors registered, worker not started.`
      );
    }

    // PHASE 28: Check queue availability
    if (!this.queue) {
      logger.error('[PHASE28-CREATE-TASK] Queue not initialized', { type });
      throw new Error('Task queue not initialized. Cannot create tasks.');
    }

    const taskId = uuidv4();
    const timeout = Math.min(options?.timeout || this.config.defaultTimeout, this.config.maxTimeout);

    logger.debug('[PHASE28-CREATE-TASK] Creating task object', {
      taskId,
      type,
      timeout,
      priority: options?.priority || 0
    });

    const task: Task = {
      id: taskId,
      type,
      status: 'pending',
      params,
      createdAt: new Date(),
      progress: 0,
      version: 1, // Initialize version for optimistic locking
      metadata: {
        timeout,
        priority: options?.priority || 0,
        ...options?.metadata
      },
      // PHASE 31: Store tenant context in task for async propagation
      tenantContext: options?.tenantContext
    };

    // PHASE 29e FIX: ALWAYS populate in-memory Map for two-phase commit working copy
    // The updateTaskStateAtomic() function requires task in memory for the commit phase.
    // When useRepository=true: Save to repository (persistent) AND memory (working copy)
    // When useRepository=false: Save to memory only (ephemeral)
    this.tasks.set(taskId, task);

    // PHASE 57: Repository save is MANDATORY for task creation when repository is enabled
    // Failing silently leads to job/task desynchronization on pod restart
    if (this.useRepository && this.repository) {
      try {
        await this.repository.save(task);
        logger.debug('Task saved to persistent repository AND in-memory', { taskId, type });

        // PHASE 57: Verify task is readable from repository before proceeding
        // This prevents race conditions where save appears to succeed but task isn't findable
        const verifiedTask = await this.repository.findById(taskId);
        if (!verifiedTask) {
          // Cleanup and fail - task didn't persist correctly
          this.tasks.delete(taskId);
          throw new Error(
            `Task verification failed: Task ${taskId} saved but not readable from repository. ` +
            `This indicates a Redis persistence issue.`
          );
        }
        logger.debug('Task verified in repository', { taskId, type });
      } catch (error: any) {
        // PHASE 57 FIX: ABORT task creation if repository save fails
        // This prevents job/task desynchronization that causes "Task not found" errors
        this.tasks.delete(taskId);

        logger.error('[CRITICAL] Task creation ABORTED - repository save failed', {
          taskId,
          type,
          error: error.message,
          action: 'Cleaned up in-memory task, will NOT queue job',
          severity: 'CRITICAL'
        });

        // Propagate error to caller - do NOT proceed to queue.add()
        throw new Error(
          `Task creation failed: Cannot persist task to repository.\n` +
          `Task ID: ${taskId}\n` +
          `Error: ${error.message}\n` +
          `Without persistent storage, task would be lost on pod restart.`
        );
      }
    }

    // Then enqueue job in Bull/Redis
    const jobOptions: JobOptions = {
      timeout,
      priority: options?.priority,
      jobId: taskId
    };

    // PHASE 28: Add try-catch around queue.add with detailed error logging
    try {
      logger.debug('[PHASE28-CREATE-TASK] Adding job to Bull queue', {
        taskId,
        type,
        jobOptions,
        queueName: this.queue.name
      });

      // PHASE 31: Include tenantContext in job.data for async propagation through Bull queue
      const job = await this.queue.add(type, {
        taskId,
        params,
        tenantContext: options?.tenantContext,
        metadata: {
          timeout,
          priority: options?.priority || 0,
          ...options?.metadata
        }
      }, jobOptions);

      logger.info('[PHASE28-CREATE-TASK] Job successfully added to queue', {
        taskId,
        type,
        jobId: job.id,
        jobName: job.name,
        timeout,
        persistent: this.useRepository,
        // PHASE 31: Log tenant context presence for debugging
        hasTenantContext: !!options?.tenantContext,
        tenantCompanyId: options?.tenantContext?.companyId
      });

      this.emit('task:created', task);

      return taskId;
    } catch (error: any) {
      logger.error('[PHASE28-CREATE-TASK] Failed to add job to queue', {
        taskId,
        type,
        error: error.message,
        stack: error.stack,
        queueState: {
          name: this.queue.name,
          isPaused: await this.queue.isPaused(),
          workerCount: await this.queue.getWorkerCount()
        }
      });

      // Clean up task from repository/memory if queue add fails
      if (this.useRepository && this.repository) {
        try {
          await this.repository.delete(taskId);
        } catch (cleanupError: any) {
          logger.warn('[PHASE28-CREATE-TASK] Failed to cleanup task after queue error', {
            taskId,
            error: cleanupError.message
          });
        }
      } else {
        this.tasks.delete(taskId);
      }

      throw new Error(`Failed to create task: ${error.message}`);
    }
  }

  /**
   * Get current status of a task
   * REFACTORED: Repository-first, with intelligent fallback chain
   *
   * Lookup chain:
   * 1. Repository (persistent) - if enabled
   * 2. BullMQ Job (Redis) - reconstruct task from job metadata
   * 3. GraphRAG (long-term) - completed tasks only
   * 4. Recovery strategy - if job exists but task doesn't
   */
  async getTaskStatus(taskId: string): Promise<Task | null> {
    // PHASE 26 DIAGNOSTIC: Log entry point with configuration state
    logger.info('[PHASE26-DIAG] getTaskStatus() called', {
      taskId,
      useRepository: this.useRepository,
      repositoryInitialized: this.repository !== null,
      repositoryType: this.repository?.constructor?.name || 'none',
      inMemoryCacheSize: this.tasks.size,
      hasTaskInMemory: this.tasks.has(taskId)
    });

    // NEW PRIORITY 1: Check persistent repository first (survives restarts)
    if (this.useRepository && this.repository) {
      logger.info('[PHASE26-DIAG] Using repository path (useRepository=true)', {
        taskId,
        repositoryType: this.repository.constructor.name
      });

      try {
        const task = await this.repository.findById(taskId);
        if (task) {
          logger.info('[PHASE26-DIAG] ✅ Task FOUND in repository', {
            taskId,
            status: task.status,
            progress: task.progress,
            hasResult: !!task.result,
            completedAt: task.completedAt
          });
          // Cache in memory for performance
          this.tasks.set(taskId, task);
          return task;
        } else {
          logger.warn('[PHASE26-DIAG] ❌ Task NOT FOUND in repository - falling back', {
            taskId
          });
        }
      } catch (error: any) {
        logger.error('[PHASE26-DIAG] ❌ Repository lookup ERROR - falling back', {
          taskId,
          error: error.message,
          errorStack: error.stack
        });
      }
    } else {
      logger.info('[PHASE26-DIAG] Using in-memory path (useRepository=false)', {
        taskId,
        inMemoryCacheSize: this.tasks.size,
        hasTaskInMemory: this.tasks.has(taskId)
      });

      // Legacy: Check in-memory cache (ephemeral)
      const memoryTask = this.tasks.get(taskId);
      if (memoryTask) {
        logger.info('[PHASE26-DIAG] ✅ Task FOUND in in-memory cache', {
          taskId,
          status: memoryTask.status,
          progress: memoryTask.progress,
          hasResult: !!memoryTask.result
        });
        return memoryTask;
      } else {
        logger.warn('[PHASE26-DIAG] ❌ Task NOT FOUND in in-memory cache - falling back', {
          taskId
        });
      }
    }

    // PRIORITY 2: Check BullMQ Job in Redis (may exist even if task registry missing)
    logger.info('[PHASE26-DIAG] Falling back to Bull queue reconstruction', { taskId });

    try {
      const job = await this.queue.getJob(taskId);

      if (!job) {
        logger.warn('[PHASE26-DIAG] ❌ Bull job NOT FOUND - final fallback to GraphRAG', { taskId });
        // PRIORITY 3: Fallback to GraphRAG document storage
        return await this.getTaskResultFromGraphRAG(taskId);
      }

      const bullJobState = await job.getState();
      logger.info('[PHASE26-DIAG] ✅ Bull job FOUND - reconstructing task', {
        taskId,
        jobId: job.id,
        jobName: job.name,
        bullJobState,
        hasReturnValue: !!job.returnvalue,
        hasFailedReason: !!job.failedReason,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn
      });

      // Job exists - attempt recovery using strategy
      if (this.useRepository && this.recoveryStrategy) {
        logger.warn('Task missing from repository but job exists - attempting recovery', {
          taskId,
          jobId: job.id,
          jobName: job.name,
          recoveryStrategy: this.recoveryStrategy.name
        });

        try {
          // Use recovery strategy to rebuild task
          const recoveredTask = await this.recoveryStrategy.recover(taskId, job);
          logger.info('Task successfully recovered', {
            taskId,
            strategy: this.recoveryStrategy.name,
            status: recoveredTask.status
          });
          return recoveredTask;
        } catch (recoveryError: any) {
          logger.error('Task recovery failed', {
            taskId,
            strategy: this.recoveryStrategy.name,
            error: recoveryError.message
          });
          // Continue to fallback chain
        }
      }

      // Fallback: Reconstruct Task object from BullMQ Job (legacy behavior)
      const jobProgress = job.progress;
      const mappedStatus = this.mapJobStateToTaskStatus(bullJobState);

      logger.info('[PHASE26-DIAG] Mapping Bull job state to task status', {
        taskId,
        bullJobState,
        mappedStatus,
        jobProgress
      });

      const task: Task = {
        id: job.id as string,
        type: job.name as TaskType,
        status: mappedStatus,
        params: job.data.params || {},
        createdAt: new Date(job.timestamp),
        startedAt: job.processedOn ? new Date(job.processedOn) : undefined,
        completedAt: job.finishedOn ? new Date(job.finishedOn) : undefined,
        result: job.returnvalue,
        error: job.failedReason,
        progress: typeof jobProgress === 'number' ? jobProgress : 0,
        metadata: job.data.metadata || {},
        version: 1 // Default version for reconstructed tasks
      };

      // Cache in memory AND repository if available
      this.tasks.set(taskId, task);
      if (this.useRepository && this.repository) {
        try {
          await this.repository.save(task);
          logger.debug('Reconstructed task saved to repository', { taskId });
        } catch (saveError: any) {
          logger.warn('Failed to save reconstructed task to repository', {
            taskId,
            error: saveError.message
          });
        }
      }

      logger.info('[PHASE26-DIAG] ⚠️ RETURNING RECONSTRUCTED TASK FROM BULL', {
        taskId,
        status: task.status,
        progress: task.progress,
        hasResult: !!task.result,
        warning: 'Task not found in primary storage, reconstructed from Bull job'
      });

      return task;
    } catch (error: any) {
      logger.error('Failed to retrieve task from Bull queue', {
        taskId,
        error: error.message,
        stack: error.stack
      });

      // Final fallback: Try GraphRAG with timeout
      return await Promise.race([
        this.getTaskResultFromGraphRAG(taskId),
        new Promise<null>((resolve) =>
          setTimeout(() => {
            logger.warn('GraphRAG fallback timeout, returning null', { taskId });
            resolve(null);
          }, 5000) // 5 second timeout
        )
      ]);
    }
  }

  /**
   * REFACTORED: NEW - Retrieve task result from GraphRAG document storage
   * Fallback when Redis (BullMQ) doesn't have the task
   */
  private async getTaskResultFromGraphRAG(taskId: string): Promise<Task | null> {
    if (!this.graphragClient) {
      return null;
    }

    try {
      // Search for task result document by taskId tag
      // PHASE 37: Fix endpoint path - must include /graphrag prefix
      const response = await this.graphragClient.post('/graphrag/api/search', {
        query: `taskId:${taskId}`,
        limit: 1,
        filters: {
          tags: ['task_result']
        }
      });

      const documents = response.data?.documents || [];

      if (documents.length === 0) {
        logger.debug('Task not found in GraphRAG', { taskId });
        return null;
      }

      const doc = documents[0];

      // Reconstruct basic Task object from GraphRAG document
      const task: Task = {
        id: taskId,
        type: doc.metadata?.taskType || 'orchestrate',
        status: 'completed', // Only completed tasks stored in GraphRAG
        params: {},
        createdAt: new Date(doc.metadata?.timestamp || doc.created_at),
        completedAt: new Date(doc.metadata?.timestamp || doc.created_at),
        result: doc.content, // Full result stored as document content
        progress: 100,
        metadata: doc.metadata || {},
        version: 1 // Default version for GraphRAG-retrieved tasks
      };

      logger.info('Retrieved task result from GraphRAG fallback', {
        taskId,
        contentLength: doc.content?.length || 0
      });

      // Cache in memory
      this.tasks.set(taskId, task);

      return task;
    } catch (error: any) {
      logger.warn('Failed to retrieve task from GraphRAG fallback', {
        taskId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * REFACTORED: NEW - Map BullMQ job state to Task status
   */
  private mapJobStateToTaskStatus(jobState: string): TaskStatus {
    switch (jobState) {
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      case 'active':
        return 'running';
      case 'waiting':
      case 'delayed':
        return 'pending';
      default:
        return 'pending';
    }
  }

  /**
   * Wait for a task to complete with timeout
   * Returns task result or throws if timeout exceeded
   */
  async waitForTask(taskId: string, timeout: number = 30000): Promise<Task> {
    const task = this.tasks.get(taskId);

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    if (task.status === 'completed') {
      return task;
    }

    if (task.status === 'failed') {
      throw new Error(`Task failed: ${task.error}`);
    }

    // Wait for task completion with timeout
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        cleanup();
        resolve(task); // Return task in current state (running)
      }, timeout);

      const onCompleted = (completedTask: Task) => {
        if (completedTask.id === taskId) {
          cleanup();
          resolve(completedTask);
        }
      };

      const onFailed = (failedTask: Task) => {
        if (failedTask.id === taskId) {
          cleanup();
          reject(new Error(`Task failed: ${failedTask.error}`));
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        this.off('task:completed', onCompleted);
        this.off('task:failed', onFailed);
      };

      this.on('task:completed', onCompleted);
      this.on('task:failed', onFailed);
    });
  }

  /**
   * Cancel a task (if still pending)
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);

    if (!task || task.status !== 'pending') {
      return false;
    }

    const job = await this.queue.getJob(taskId);

    if (job) {
      await job.remove();
      task.status = 'failed';
      task.error = 'Task cancelled by user';
      task.completedAt = new Date();

      this.emit('task:cancelled', task);
      logger.info('Task cancelled', { taskId });

      return true;
    }

    return false;
  }

  /**
   * Force fail a task (used by Worker Watchdog on timeout)
   *
   * **Purpose**: Immediately mark a task as failed, regardless of current state.
   * Used when external watchdog detects task has exceeded maximum execution time.
   *
   * @param taskId - Task ID to force fail
   * @param reason - Reason for force failure
   * @returns true if task was force-failed, false if task not found
   */
  async forceFailTask(taskId: string, reason: string): Promise<boolean> {
    const task = this.tasks.get(taskId);

    if (!task) {
      logger.warn('Cannot force-fail task: not found', { taskId });
      return false;
    }

    logger.error('Force-failing task', {
      taskId,
      currentStatus: task.status,
      reason
    });

    // Update task state to failed
    await this.updateTaskStateAtomic(taskId, async () => {
      const taskToUpdate = this.tasks.get(taskId);
      if (taskToUpdate) {
        taskToUpdate.status = 'failed';
        taskToUpdate.error = reason;
        taskToUpdate.completedAt = new Date();
      }
    });

    // Try to remove job from queue (best effort)
    try {
      const job = await this.queue.getJob(taskId);
      if (job) {
        await job.remove();
        logger.info('Removed job from queue after force-fail', { taskId });
      }
    } catch (error: any) {
      logger.warn('Could not remove job from queue after force-fail', {
        taskId,
        error: error.message
      });
    }

    // Emit event
    this.emit('task:forceFailed', {
      taskId,
      reason,
      task: this.tasks.get(taskId)
    });

    return true;
  }

  /**
   * Get worker health status (includes watchdog and health monitor metrics)
   *
   * **Purpose**: Provides comprehensive worker health data for monitoring
   * and health check endpoints.
   *
   * @returns Worker health status including watchdog metrics
   */
  getWorkerHealthStatus(): {
    health: any;
    watchdog: any;
  } {
    return {
      health: this.workerHealthMonitor?.getHealthStatus() || {
        status: 'unknown',
        uptime: 0,
        metrics: {}
      },
      watchdog: this.workerWatchdog?.getMetrics() || {
        totalMonitored: 0,
        totalTimeouts: 0,
        totalSuccess: 0,
        totalErrors: 0,
        averageExecutionTime: 0
      }
    };
  }

  /**
   * Get queue statistics
   */
  async getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount()
    ]);

    // Update worker health monitor queue depth
    this.workerHealthMonitor?.updateQueueDepth(waiting + active + delayed);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: this.tasks.size,
      workerStarted: this.workerStarted,
      registeredProcessors: Array.from(this.processors.keys()),
      health: this.workerHealthMonitor?.getState() || 'unknown'
    };
  }

  /**
   * NEW: Get queue position for a specific task
   * Returns the position in queue (0-indexed) or -1 if not in queue
   */
  async getQueuePosition(taskId: string): Promise<number> {
    try {
      // Get all waiting jobs
      const waitingJobs = await this.queue.getWaiting();

      // Find the position of this task in the queue
      const position = waitingJobs.findIndex(job => job.id === taskId);

      return position; // Returns -1 if not found (task is running or completed)
    } catch (error: any) {
      logger.error('Failed to get queue position', {
        taskId,
        error: error.message
      });
      return -1;
    }
  }

  /**
   * NEW: Calculate estimated wait time for a task
   * Based on average processing time and queue position
   */
  async calculateEstimatedWaitTime(taskId: string): Promise<number> {
    try {
      const position = await this.getQueuePosition(taskId);

      // If not in queue (running or completed), return 0
      if (position < 0) {
        return 0;
      }

      // Get average processing time from completed jobs
      const completedJobs = await this.queue.getCompleted(0, 100); // Last 100 completed jobs

      if (completedJobs.length === 0) {
        // No historical data - use default estimate
        return position * 45000; // 45 seconds per task default
      }

      // Calculate average processing time
      const totalTime = completedJobs.reduce((sum, job) => {
        const processingTime = job.finishedOn && job.processedOn
          ? job.finishedOn - job.processedOn
          : 45000; // Default 45s if no data
        return sum + processingTime;
      }, 0);

      const avgTime = totalTime / completedJobs.length;

      // Estimate: position in queue * average processing time
      return Math.round(position * avgTime);
    } catch (error: any) {
      logger.error('Failed to calculate estimated wait time', {
        taskId,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * NEW: Get list of all queued and processing tasks
   * Returns tasks with queue position and estimated wait time
   */
  async getQueueList(): Promise<{
    queue: Array<{
      taskId: string;
      status: TaskStatus;
      queuePosition: number;
      submittedAt: string;
      startedAt?: string;
      estimatedWaitTime?: number;
      type: TaskType;
    }>;
    metrics: {
      totalQueued: number;
      totalProcessing: number;
      averageProcessingTime: number;
    };
  }> {
    try {
      const [waitingJobs, activeJobs, completedJobs] = await Promise.all([
        this.queue.getWaiting(),
        this.queue.getActive(),
        this.queue.getCompleted(0, 100) // Last 100 for average calculation
      ]);

      // Calculate average processing time
      const totalTime = completedJobs.reduce((sum, job) => {
        const processingTime = job.finishedOn && job.processedOn
          ? job.finishedOn - job.processedOn
          : 45000;
        return sum + processingTime;
      }, 0);
      const avgProcessingTime = completedJobs.length > 0
        ? totalTime / completedJobs.length
        : 45000;

      // Build queue list
      const queue: Array<any> = [];

      // Add active (processing) tasks
      for (const job of activeJobs) {
        queue.push({
          taskId: job.id as string,
          status: 'running' as TaskStatus,
          queuePosition: 0, // Currently processing
          submittedAt: new Date(job.timestamp).toISOString(),
          startedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
          type: job.name as TaskType
        });
      }

      // Add waiting (queued) tasks
      for (let i = 0; i < waitingJobs.length; i++) {
        const job = waitingJobs[i];
        const queuePosition = i + 1; // 1-indexed for display
        const estimatedWaitTime = Math.round(queuePosition * avgProcessingTime);

        queue.push({
          taskId: job.id as string,
          status: 'pending' as TaskStatus,
          queuePosition,
          submittedAt: new Date(job.timestamp).toISOString(),
          estimatedWaitTime,
          type: job.name as TaskType
        });
      }

      return {
        queue,
        metrics: {
          totalQueued: waitingJobs.length,
          totalProcessing: activeJobs.length,
          averageProcessingTime: Math.round(avgProcessingTime)
        }
      };
    } catch (error: any) {
      logger.error('Failed to get queue list', {
        error: error.message
      });
      return {
        queue: [],
        metrics: {
          totalQueued: 0,
          totalProcessing: 0,
          averageProcessingTime: 45000
        }
      };
    }
  }

  /**
   * NEW: Emit queue position update events for all waiting tasks
   * Called after a task completes to notify waiting tasks of their new position
   * Also called after a task is cancelled to update remaining tasks
   * PUBLIC to allow route handlers to trigger updates after cancellation
   */
  async emitQueuePositionUpdates(): Promise<void> {
    try {
      const waitingJobs = await this.queue.getWaiting();

      // Calculate average processing time for estimates
      const completedJobs = await this.queue.getCompleted(0, 100);
      const totalTime = completedJobs.reduce((sum, job) => {
        const processingTime = job.finishedOn && job.processedOn
          ? job.finishedOn - job.processedOn
          : 45000;
        return sum + processingTime;
      }, 0);
      const avgProcessingTime = completedJobs.length > 0
        ? totalTime / completedJobs.length
        : 45000;

      // Emit position update for each waiting task
      for (let i = 0; i < waitingJobs.length; i++) {
        const job = waitingJobs[i];
        const taskId = job.id as string;
        const queuePosition = i + 1; // 1-indexed
        const estimatedWaitTime = Math.round(queuePosition * avgProcessingTime / 1000); // Convert to seconds

        // Emit local event
        this.emit('queue:position-update', {
          taskId,
          queuePosition,
          estimatedWaitTime
        });

        // Forward to GraphRAG WebSocket
        await this.forwardQueueEventToGraphRAG(taskId, 'position-update', {
          queuePosition,
          estimatedWaitTime
        });
      }

      logger.debug('Queue position updates emitted', {
        waitingTasks: waitingJobs.length
      });
    } catch (error: any) {
      logger.error('Failed to emit queue position updates', {
        error: error.message
      });
    }
  }

  /**
   * NEW: Forward queue-specific events to GraphRAG WebSocket
   */
  private async forwardQueueEventToGraphRAG(
    taskId: string,
    event: 'position-update' | 'started',
    data: any
  ): Promise<void> {
    if (!this.graphragClient || !this.config.enableWebSocketStreaming) {
      return;
    }

    try {
      // PHASE 37: Fix endpoint path - must include /graphrag prefix
      await this.graphragClient.post('/graphrag/api/websocket/emit', {
        room: `task:${taskId}`,
        event: `queue:${event}`,
        data: {
          taskId,
          event: `queue:${event}`,
          ...data,
          timestamp: new Date().toISOString()
        }
      });

      logger.debug('Forwarded queue event to GraphRAG WebSocket', {
        taskId,
        event,
        room: `task:${taskId}`
      });
    } catch (error: any) {
      logger.warn('Failed to forward queue event to GraphRAG', {
        taskId,
        event,
        error: error.message
      });
    }
  }

  /**
   * Clean up old completed/failed tasks
   */
  async cleanupOldTasks(olderThanMs: number = 3600000): Promise<number> {
    const cutoffTime = Date.now() - olderThanMs;
    let removed = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (
        (task.status === 'completed' || task.status === 'failed') &&
        task.completedAt &&
        task.completedAt.getTime() < cutoffTime
      ) {
        this.tasks.delete(taskId);
        removed++;
      }
    }

    // Also clean up queue
    await this.queue.clean(olderThanMs, 'completed');
    await this.queue.clean(olderThanMs, 'failed');

    logger.info('Cleaned up old tasks', { removed, cutoffMs: olderThanMs });
    return removed;
  }

  /**
   * PHASE 34 REMEDIATION: Complete Bull Queue Event Coverage
   *
   * ROOT CAUSE: Missing 'failed' and 'completed' event listeners caused worker
   * to enter zombie state when tasks timed out. Bull emitted unhandled 'failed'
   * event, Node.js threw error, uncaughtException handler prevented crash but
   * left worker in broken state.
   *
   * SOLUTION: Implement comprehensive event listeners for ALL Bull queue events
   * with defensive error handling, health monitoring, and automatic recovery.
   */
  private setupEventListeners(): void {
    // ========================================================================
    // EXISTING LISTENERS (Enhanced with better logging)
    // ========================================================================

    // Global queue errors (connection issues, Redis failures)
    this.queue.on('error', (error: Error) => {
      logger.error('[QUEUE-ERROR] Bull queue error detected', {
        component: 'TaskManager',
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        queueName: 'mageagent-tasks',
        severity: 'CRITICAL'
      });
      this.emit('queue:error', error);

      // Update health monitor
      if (this.workerHealthMonitor) {
        this.workerHealthMonitor.recordError(0);
      }
    });

    this.queue.on('waiting', (jobId) => {
      logger.debug('[QUEUE-WAITING] Job added to queue', {
        component: 'TaskManager',
        jobId,
        timestamp: new Date().toISOString()
      });
    });

    this.queue.on('active', (job) => {
      logger.info('[QUEUE-ACTIVE] Job processing started', {
        component: 'TaskManager',
        jobId: job.id,
        jobName: job.name,
        timestamp: new Date().toISOString(),
        attemptsMade: job.attemptsMade
      });

      // Track concurrency metrics - heartbeat indicates worker is active
      // PHASE 29 FIX: recordJobStart doesn't exist on WorkerHealthMonitor, use heartbeat()
      if (this.workerHealthMonitor) {
        this.workerHealthMonitor.heartbeat();
      }
    });

    this.queue.on('stalled', (job) => {
      logger.warn('[QUEUE-STALLED] Job stalled - will be retried', {
        component: 'TaskManager',
        jobId: job.id,
        jobName: job.name,
        timestamp: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        stalledDuration: Date.now() - (job.processedOn || 0),
        severity: 'WARNING'
      });

      // Force-fail the stalled task using TaskManager's forceFailTask
      // PHASE 29 FIX: WorkerWatchdog doesn't have forceKillTask, call TaskManager directly
      const taskId = job.data?.taskId;
      if (taskId) {
        this.forceFailTask(taskId, 'Job stalled - exceeded lock duration')
          .catch((err: Error) => logger.error('[STALLED-FORCE-FAIL-ERROR]', { error: err.message, taskId }));
      }
    });

    // PHASE 60 FIX: Persist progress to repository for status polling
    this.queue.on('progress', async (job, progress) => {
      const taskId = job.data.taskId;
      const task = this.tasks.get(taskId);

      if (task) {
        task.progress = progress;
        this.emit('task:progress', task);

        // CRITICAL FIX: Persist progress to repository so getTaskStatus() sees it
        if (this.repository && this.useRepository) {
          try {
            await this.repository.update(taskId, { progress });
            logger.debug('[PROGRESS-PERSIST] Progress saved to repository', {
              component: 'TaskManager',
              taskId,
              progress
            });
          } catch (error: any) {
            logger.warn('[PROGRESS-PERSIST] Failed to persist progress', {
              component: 'TaskManager',
              taskId,
              progress,
              error: error.message
            });
          }
        }
      }

      logger.debug('[QUEUE-PROGRESS] Job progress update', {
        component: 'TaskManager',
        jobId: job.id,
        taskId,
        progress,
        timestamp: new Date().toISOString()
      });
    });

    // ========================================================================
    // PHASE 34: NEW CRITICAL LISTENERS (Fix for Worker Zombie State)
    // ========================================================================

    /**
     * CRITICAL: 'failed' event listener
     *
     * This was the PRIMARY ROOT CAUSE of worker zombie state. When tasks timed out,
     * the processor threw an error, Bull emitted 'failed', but no listener existed.
     * Node.js EventEmitter behavior: unhandled event → Error thrown → uncaughtException
     * → Worker survives but in broken state.
     */
    this.queue.on('failed', async (job: Job, error: Error) => {
      const taskId = job.data?.taskId;
      const failureContext = {
        component: 'TaskManager',
        jobId: job.id,
        jobName: job.name,
        taskId,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.constructor.name
        },
        timestamp: new Date().toISOString(),
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts || 1,
        attemptsRemaining: (job.opts.attempts || 1) - job.attemptsMade,
        processingDuration: job.finishedOn ? job.finishedOn - (job.processedOn || 0) : null,
        severity: 'ERROR'
      };

      logger.error('[QUEUE-FAILED] ✅ Job processing failed (event handler active)', failureContext);

      try {
        // 1. Update worker health monitor
        if (this.workerHealthMonitor) {
          const duration = failureContext.processingDuration || 0;
          this.workerHealthMonitor.recordError(duration);
        }

        // 2. Update task state defensively (processor should have done this, but ensure it's done)
        if (taskId && this.useRepository && this.repository) {
          try {
            const task = await this.repository.findById(taskId);
            if (task && (task.status === 'pending' || task.status === 'running')) {
              await this.repository.update(taskId, {
                status: error.message.includes('timeout') ? 'timeout' : 'failed',
                error: error.message,
                completedAt: new Date()
              });
              logger.info('[QUEUE-FAILED] Defensive task state update completed', {
                taskId,
                newStatus: error.message.includes('timeout') ? 'timeout' : 'failed'
              });
            }
          } catch (updateError: any) {
            logger.warn('[QUEUE-FAILED] Failed to update task state defensively', {
              taskId,
              error: updateError.message
            });
          }
        } else if (taskId && this.tasks.has(taskId)) {
          const task = this.tasks.get(taskId);
          if (task && (task.status === 'pending' || task.status === 'running')) {
            task.status = error.message.includes('timeout') ? 'timeout' : 'failed';
            task.error = error.message;
            task.completedAt = new Date();
          }
        }

        // 3. Emit failed event for local listeners
        this.emit('task:failed', { taskId, error: error.message });

      } catch (handlerError: any) {
        // CRITICAL: Never let event handler errors propagate
        logger.error('[QUEUE-FAILED-HANDLER-ERROR] Error in failed event handler', {
          component: 'TaskManager',
          originalError: error.message,
          handlerError: handlerError.message,
          jobId: job.id,
          taskId,
          severity: 'CRITICAL'
        });
      }
    });

    /**
     * CRITICAL: 'completed' event listener
     *
     * While not directly causing the zombie state, this was also missing and
     * prevented proper success tracking, metrics collection, and resource cleanup.
     */
    this.queue.on('completed', async (job: Job, result: any) => {
      const taskId = job.data?.taskId;
      const completionContext = {
        component: 'TaskManager',
        jobId: job.id,
        jobName: job.name,
        taskId,
        timestamp: new Date().toISOString(),
        processingDuration: job.finishedOn! - (job.processedOn || 0),
        attemptsMade: job.attemptsMade,
        resultSize: JSON.stringify(result || {}).length,
        severity: 'INFO'
      };

      logger.info('[QUEUE-COMPLETED] ✅ Job processing completed successfully', completionContext);

      try {
        // 1. Update worker health monitor (success improves health score)
        if (this.workerHealthMonitor) {
          this.workerHealthMonitor.recordSuccess(completionContext.processingDuration);
        }

        // 2. Emit completion event for local listeners
        this.emit('task:completed', { taskId, result });

        // 3. Cleanup: Remove job from Redis after successful completion
        await job.remove().catch(err => {
          logger.warn('[QUEUE-CLEANUP-ERROR] Failed to remove completed job', {
            jobId: job.id,
            error: err.message
          });
        });

      } catch (handlerError: any) {
        // CRITICAL: Never let event handler errors propagate
        logger.error('[QUEUE-COMPLETED-HANDLER-ERROR] Error in completed event handler', {
          component: 'TaskManager',
          handlerError: handlerError.message,
          jobId: job.id,
          taskId,
          severity: 'WARNING'
        });
      }
    });

    /**
     * NEW: 'removed' event listener (audit trail)
     */
    this.queue.on('removed', (job: Job) => {
      logger.info('[QUEUE-REMOVED] Job removed from queue', {
        component: 'TaskManager',
        jobId: job.id,
        jobName: job.name,
        taskId: job.data?.taskId,
        timestamp: new Date().toISOString()
      });
    });

    /**
     * NEW: 'cleaned' event listener (GDPR compliance audit)
     */
    this.queue.on('cleaned', (jobs: Job[], type: string) => {
      logger.info('[QUEUE-CLEANED] Bulk job cleanup executed', {
        component: 'TaskManager',
        jobsRemoved: jobs.length,
        cleanupType: type,
        timestamp: new Date().toISOString()
      });
    });

    // Final initialization log
    logger.info('[PHASE34-EVENT-LISTENERS] ✅ Complete Bull queue event coverage initialized', {
      component: 'TaskManager',
      listeners: ['error', 'waiting', 'active', 'stalled', 'progress', 'failed', 'completed', 'removed', 'cleaned'],
      timestamp: new Date().toISOString(),
      fix: 'Worker zombie state remediated - failed/completed events now handled'
    });
  }

  /**
   * Forward task progress events to GraphRAG WebSocket server
   * This enables real-time streaming of task progress to subscribed clients
   */
  private async forwardTaskEventToGraphRAG(
    taskId: string,
    status: 'started' | 'progress' | 'completed' | 'failed',
    data: any
  ): Promise<void> {
    if (!this.graphragClient || !this.config.enableWebSocketStreaming) {
      return;
    }

    try {
      // Send event to GraphRAG WebSocket emit endpoint
      // GraphRAG will broadcast this to all clients subscribed to task:${taskId}
      await this.graphragClient.post('/graphrag/api/websocket/emit', {
        room: `task:${taskId}`,
        event: `task:${taskId}`,
        data: {
          taskId,
          status,
          ...data,
          timestamp: new Date().toISOString()
        }
      });

      logger.debug('Forwarded task event to GraphRAG WebSocket', {
        taskId,
        status,
        room: `task:${taskId}`
      });
    } catch (error: any) {
      // Don't throw - WebSocket forwarding is best-effort
      logger.warn('Failed to forward task event to GraphRAG', {
        taskId,
        status,
        error: error.message
      });
    }
  }

  /**
   * Forward agent orchestration events to GraphRAG WebSocket server
   * Broadcasts agent:spawned, agent:progress, agent:complete events to subscribed clients
   * Enables real-time visibility of multi-agent orchestration in frontend
   */
  private async forwardAgentEventToGraphRAG(
    taskId: string | undefined,
    status: 'spawned' | 'progress' | 'complete',
    data: any
  ): Promise<void> {
    if (!taskId || !this.graphragClient || !this.config.enableWebSocketStreaming) {
      return;
    }

    try {
      // Send event to GraphRAG WebSocket emit endpoint
      // GraphRAG will broadcast this to all clients subscribed to task:${taskId}
      await this.graphragClient.post('/graphrag/api/websocket/emit', {
        room: `task:${taskId}`,
        event: `agent:${status}`, // Frontend-compatible event names
        data: {
          ...data,
          timestamp: new Date().toISOString()
        }
      });

      logger.debug('Forwarded agent event to GraphRAG WebSocket', {
        taskId,
        event: `agent:${status}`,
        room: `task:${taskId}`,
        agentId: data.agentId
      });
    } catch (error: any) {
      // Don't throw - WebSocket forwarding is best-effort
      logger.warn('Failed to forward agent event to GraphRAG', {
        taskId,
        status,
        agentId: data.agentId,
        error: error.message
      });
    }
  }

  /**
   * REFACTORED: NEW - Store task result as document in GraphRAG for long-term persistence
   * Enables semantic search and knowledge building from orchestration results
   */
  private async storeTaskResultInGraphRAG(
    taskId: string,
    taskType: TaskType,
    result: any
  ): Promise<void> {
    if (!this.graphragClient) {
      return;
    }

    try {
      // Prepare document content
      const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      const title = `${taskType} Task Result: ${taskId}`;

      // Store as document in GraphRAG with intelligent chunking
      // PHASE 37: Fix endpoint path - must include /graphrag prefix
      await this.graphragClient.post('/graphrag/api/documents', {
        title,
        content,
        metadata: {
          type: 'markdown', // Most orchestration results are markdown
          category: 'task_result',
          tags: ['mageagent', 'orchestration', taskType, 'task_result'],
          taskId,
          taskType,
          timestamp: new Date().toISOString(),
          source: 'mageagent-task-manager'
        }
      });

      logger.info('Stored task result in GraphRAG', {
        taskId,
        taskType,
        contentLength: content.length
      });
    } catch (error: any) {
      // Don't throw - GraphRAG storage is best-effort for redundancy
      logger.warn('Failed to store task result in GraphRAG', {
        taskId,
        taskType,
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Graceful shutdown with comprehensive cleanup
   * PHASE 34 ENHANCED: Remove ALL Bull queue event listeners including new ones
   */
  async shutdown(): Promise<void> {
    logger.info('[PHASE34-SHUTDOWN] Shutting down TaskManager...');

    // PHASE 34: Remove ALL Bull queue event listeners BEFORE closing
    // This prevents memory leaks from orphaned event handlers
    this.queue.removeAllListeners('error');
    this.queue.removeAllListeners('waiting');
    this.queue.removeAllListeners('active');
    this.queue.removeAllListeners('stalled');
    this.queue.removeAllListeners('progress');
    this.queue.removeAllListeners('completed'); // PHASE 34: Added
    this.queue.removeAllListeners('failed');    // PHASE 34: Added
    this.queue.removeAllListeners('removed');   // PHASE 34: Added
    this.queue.removeAllListeners('cleaned');   // PHASE 34: Added

    logger.debug('[PHASE34-SHUTDOWN] Removed all Bull queue event listeners', {
      listenersRemoved: ['error', 'waiting', 'active', 'stalled', 'progress', 'completed', 'failed', 'removed', 'cleaned']
    });

    // Close Bull queue (disconnects from Redis)
    await this.queue.close();

    // Clear in-memory task cache
    this.tasks.clear();

    // Clear task state locks to prevent memory retention
    this.taskStateLocks.clear();

    // Remove all TaskManager event listeners (EventEmitter cleanup)
    this.removeAllListeners();

    // PHASE 3: Destroy HTTP agents to close GraphRAG client connections
    if (this.httpAgent) {
      this.httpAgent.destroy();
      this.httpAgent = null;
    }
    if (this.httpsAgent) {
      this.httpsAgent.destroy();
      this.httpsAgent = null;
    }

    logger.info('[PHASE34-SHUTDOWN] ✅ TaskManager shutdown complete', {
      tasksCleared: true,
      queueClosed: true,
      listenersRemoved: true,
      httpAgentsDestroyed: true
    });
  }
}

/**
 * Singleton instance
 */
let instance: TaskManager | null = null;

export function initializeTaskManager(config: TaskManagerConfig): TaskManager {
  if (instance) {
    logger.warn('TaskManager already initialized, returning existing instance');
    return instance;
  }

  instance = new TaskManager(config);
  return instance;
}

export function getTaskManager(): TaskManager {
  if (!instance) {
    throw new Error('TaskManager not initialized. Call initializeTaskManager() first.');
  }

  return instance;
}

// PHASE 31: Re-export TenantContext for convenience
export type { TenantContext } from '../clients/graphrag-client.js';
