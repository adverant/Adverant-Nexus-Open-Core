import { EventEmitter } from 'events';
import { logger } from './logger';

interface QueuedTask {
  id: string;
  fn: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  addedAt: Date;
  timeout: number;
}

export class TaskQueue extends EventEmitter {
  private queue: QueuedTask[] = [];
  private readonly maxConcurrent: number;
  private readonly defaultTimeout: number;
  private activeCount = 0;

  constructor(maxConcurrent = 1, defaultTimeout = 60000) {
    super();
    this.maxConcurrent = maxConcurrent;
    this.defaultTimeout = defaultTimeout;

    // Monitor queue health
    setInterval(() => this.healthCheck(), 10000);
  }

  async add<T>(fn: () => Promise<T>, timeout?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        id: `task-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        fn,
        resolve,
        reject,
        addedAt: new Date(),
        timeout: timeout || this.defaultTimeout
      };

      // Check memory before adding
      if (this.isMemoryPressure()) {
        reject(new Error('System under memory pressure, task rejected'));
        return;
      }

      this.queue.push(task);
      logger.debug('Task added to queue', {
        taskId: task.id,
        queueLength: this.queue.length,
        activeCount: this.activeCount
      });

      this.emit('taskAdded', task.id);
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent) {
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.activeCount++;

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Task timeout after ${task.timeout}ms`)), task.timeout);
    });

    try {
      logger.debug('Processing task', {
        taskId: task.id,
        queueLength: this.queue.length,
        activeCount: this.activeCount
      });

      const result = await Promise.race([task.fn(), timeoutPromise]);
      task.resolve(result);
      this.emit('taskCompleted', task.id);
    } catch (error) {
      logger.error('Task failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      task.reject(error);
      this.emit('taskFailed', task.id);
    } finally {
      this.activeCount--;

      // Force garbage collection if available
      if (global.gc && this.isMemoryPressure()) {
        global.gc();
      }

      // Process next task
      setImmediate(() => this.process());
    }
  }

  private isMemoryPressure(): boolean {
    const used = process.memoryUsage();
    const heapUsedMB = used.heapUsed / 1024 / 1024;

    // Check absolute memory usage instead of percentage
    // Node.js starts with small heap and grows as needed
    // Only consider memory pressure if we're using > 1200MB (out of 1536MB)
    return heapUsedMB > 1200;
  }

  private healthCheck(): void {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
    const heapTotalMB = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
    const heapPercent = ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(2);

    // Clean old tasks from queue (older than 5 minutes)
    const now = Date.now();
    const oldTaskCount = this.queue.length;
    this.queue = this.queue.filter(task => {
      const age = now - task.addedAt.getTime();
      if (age > 300000) { // 5 minutes
        task.reject(new Error('Task expired in queue'));
        return false;
      }
      return true;
    });

    if (oldTaskCount !== this.queue.length) {
      logger.info('Cleaned expired tasks from queue', {
        removed: oldTaskCount - this.queue.length,
        remaining: this.queue.length
      });
    }

    // Log health status - only warn if using > 1200MB
    if (parseFloat(heapUsedMB) > 1200) {
      logger.warn('Task queue memory pressure', {
        heapUsedMB,
        heapTotalMB,
        heapPercent: `${heapPercent}%`,
        queueLength: this.queue.length,
        activeCount: this.activeCount
      });
    }
  }

  getMetrics() {
    const memoryUsage = process.memoryUsage();
    return {
      queueLength: this.queue.length,
      activeCount: this.activeCount,
      maxConcurrent: this.maxConcurrent,
      memoryUsage: {
        heapUsed: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2) + ' MB',
        heapTotal: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2) + ' MB',
        heapPercent: ((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100).toFixed(2) + '%'
      }
    };
  }

  clear(): void {
    this.queue.forEach(task => {
      task.reject(new Error('Queue cleared'));
    });
    this.queue = [];
    logger.info('Task queue cleared');
  }
}

// Singleton instance
export const orchestrationQueue = new TaskQueue(1, 60000);