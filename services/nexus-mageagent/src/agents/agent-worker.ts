import { EventEmitter } from 'events';
import { logger as rootLogger } from '../utils/logger';
import { WorkerPool } from '../orchestration/worker-pool';

export interface AgentWorkerOptions {
  id: string;
  workerPool: WorkerPool;
  logger: typeof rootLogger;
}

export interface AgentTask {
  id: string;
  type: string;
  agentId: string;
  payload: any;
  timeout?: number;
}

export class AgentWorker extends EventEmitter {
  public readonly id: string;
  private workerPool: WorkerPool;
  private logger: typeof rootLogger;
  private isRunning = false;
  private currentTask: AgentTask | null = null;

  constructor(options: AgentWorkerOptions) {
    super();
    this.id = options.id;
    this.workerPool = options.workerPool;
    this.logger = options.logger.child({ worker: this.id });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error(`Worker ${this.id} is already running`);
    }

    this.isRunning = true;
    this.logger.info(`Worker ${this.id} started`);

    // Register with worker pool
    await this.workerPool.registerWorker(this);

    // Start processing tasks
    this.processNextTask();
  }

  async stop(): Promise<void> {
    this.logger.info(`Stopping worker ${this.id}`);
    this.isRunning = false;

    // Wait for current task to complete
    if (this.currentTask) {
      this.logger.info(`Waiting for current task ${this.currentTask.id} to complete`);
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!this.currentTask) {
            clearInterval(checkInterval);
            resolve(undefined);
          }
        }, 100);
      });
    }

    // Unregister from worker pool
    await this.workerPool.unregisterWorker(this);
    this.logger.info(`Worker ${this.id} stopped`);
  }

  private async processNextTask(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Get next task from pool
      const task = await this.workerPool.getNextTask();
      
      if (!task) {
        // No tasks available, wait and retry
        setTimeout(() => this.processNextTask(), 1000);
        return;
      }

      this.currentTask = task;
      this.logger.info(`Processing task ${task.id} of type ${task.type}`);

      // Execute task
      const result = await this.executeTask(task);

      // Report completion
      await this.workerPool.reportTaskCompletion(task.id, result);
      
      this.logger.info(`Task ${task.id} completed successfully`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`Error processing task:`, {
        taskId: this.currentTask?.id,
        error: errorMessage,
        stack: errorStack
      });

      // Report failure
      if (this.currentTask) {
        await this.workerPool.reportTaskFailure(this.currentTask.id, error as Error);
      }
    } finally {
      this.currentTask = null;
      // Process next task
      setImmediate(() => this.processNextTask());
    }
  }

  private async executeTask(task: AgentTask): Promise<any> {
    const { type, payload } = task;

    switch (type) {
      case 'generate':
        return await this.handleGenerate(payload);
      case 'analyze':
        return await this.handleAnalyze(payload);
      case 'review':
        return await this.handleReview(payload);
      case 'synthesize':
        return await this.handleSynthesize(payload);
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
  }

  private async handleGenerate(payload: any): Promise<any> {
    // Actual implementation would call the appropriate agent
    this.logger.debug('Handling generate task', { payload });
    return {
      content: 'Generated content',
      metadata: { processedBy: this.id }
    };
  }

  private async handleAnalyze(payload: any): Promise<any> {
    this.logger.debug('Handling analyze task', { payload });
    return {
      analysis: 'Analysis results',
      metadata: { processedBy: this.id }
    };
  }

  private async handleReview(payload: any): Promise<any> {
    this.logger.debug('Handling review task', { payload });
    return {
      review: 'Review results',
      metadata: { processedBy: this.id }
    };
  }

  private async handleSynthesize(payload: any): Promise<any> {
    this.logger.debug('Handling synthesize task', { payload });
    return {
      synthesis: 'Synthesis results',
      metadata: { processedBy: this.id }
    };
  }
}
