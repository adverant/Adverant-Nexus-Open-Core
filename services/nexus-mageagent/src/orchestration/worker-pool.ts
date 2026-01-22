import { EventEmitter } from 'events';
import * as Bull from 'bull';
import { logger } from '../utils/logger';
import { AgentWorker, AgentTask } from '../agents/agent-worker';
import { OpenRouterClient } from '../clients/openrouter-client';
import { GraphRAGClient } from '../clients/graphrag-client';

export interface WorkerPoolOptions {
  openRouterClient: OpenRouterClient;
  graphRAGClient: GraphRAGClient;
  maxWorkers: number;
  redisUrl?: string;
}

export class WorkerPool extends EventEmitter {
  private workers = new Map<string, AgentWorker>();
  private taskQueue: Bull.Queue;
  // private _openRouterClient: OpenRouterClient;
  // private _graphRAGClient: GraphRAGClient;
  private maxWorkers: number;
  private isRunning = false;

  constructor(options: WorkerPoolOptions) {
    super();
    // this._openRouterClient = options.openRouterClient;
    // this._graphRAGClient = options.graphRAGClient;
    this.maxWorkers = options.maxWorkers;
    
    // Initialize Bull queue
    this.taskQueue = new Bull.default('mageagent-tasks', {
      redis: options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379'
    });

    this.setupQueueHandlers();
  }

  private setupQueueHandlers() {
    this.taskQueue.on('completed', (job, result) => {
      logger.info(`Task ${job.id} completed`, { 
        taskId: job.id, 
        resultSize: JSON.stringify(result).length 
      });
    });

    this.taskQueue.on('failed', (job, err) => {
      logger.error(`Task ${job.id} failed`, { 
        taskId: job.id, 
        error: err.message,
        stack: err.stack 
      });
    });

    this.taskQueue.on('stalled', (job) => {
      logger.warn(`Task ${job.id} stalled`, { taskId: job.id });
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Worker pool is already running');
    }

    this.isRunning = true;
    logger.info('Worker pool started', { maxWorkers: this.maxWorkers });
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    // Stop all workers
    const stopPromises = Array.from(this.workers.values()).map(worker => worker.stop());
    await Promise.all(stopPromises);
    
    // Close queue
    await this.taskQueue.close();
    
    logger.info('Worker pool stopped');
  }

  async registerWorker(worker: AgentWorker): Promise<void> {
    if (this.workers.size >= this.maxWorkers) {
      throw new Error(`Worker pool is at capacity (${this.maxWorkers})`);
    }

    this.workers.set(worker.id, worker);
    logger.info(`Worker registered`, { 
      workerId: worker.id, 
      totalWorkers: this.workers.size 
    });
  }

  async unregisterWorker(worker: AgentWorker): Promise<void> {
    this.workers.delete(worker.id);
    logger.info(`Worker unregistered`, { 
      workerId: worker.id, 
      totalWorkers: this.workers.size 
    });
  }

  async getNextTask(): Promise<AgentTask | null> {
    try {
      const job = await this.taskQueue.getNextJob();
      
      if (!job) {
        return null;
      }

      return {
        id: job.id.toString(),
        type: job.data.type,
        agentId: job.data.agentId,
        payload: job.data.payload,
        timeout: job.opts.timeout
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Error getting next task', { error: errorMessage });
      return null;
    }
  }

  async addTask(task: Omit<AgentTask, 'id'>): Promise<string> {
    const job = await this.taskQueue.add(task.type, {
      type: task.type,
      agentId: task.agentId,
      payload: task.payload
    }, {
      timeout: task.timeout || 300000, // 5 minutes default
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000
      },
      removeOnComplete: true,
      removeOnFail: false
    });

    return job.id.toString();
  }

  async reportTaskCompletion(taskId: string, result: any): Promise<void> {
    const job = await this.taskQueue.getJob(taskId);
    
    if (!job) {
      logger.warn(`Job ${taskId} not found for completion report`);
      return;
    }

    await job.moveToCompleted(result, true);
  }

  async reportTaskFailure(taskId: string, error: Error): Promise<void> {
    const job = await this.taskQueue.getJob(taskId);
    
    if (!job) {
      logger.warn(`Job ${taskId} not found for failure report`);
      return;
    }

    await job.moveToFailed(error, true);
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  async getQueueMetrics(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.taskQueue.getWaitingCount(),
      this.taskQueue.getActiveCount(),
      this.taskQueue.getCompletedCount(),
      this.taskQueue.getFailedCount(),
      this.taskQueue.getDelayedCount()
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  async clearQueue(): Promise<void> {
    await this.taskQueue.empty();
    await this.taskQueue.clean(0, 'completed');
    await this.taskQueue.clean(0, 'failed');
    logger.info('Task queue cleared');
  }

  // Utility method for health checks
  async isHealthy(): Promise<boolean> {
    try {
      // Check if queue is accessible
      await this.taskQueue.isReady();
      
      // Check if we have workers
      if (this.workers.size === 0 && this.isRunning) {
        logger.warn('No workers available in running pool');
        return false;
      }

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Worker pool health check failed', { error: errorMessage });
      return false;
    }
  }
}
