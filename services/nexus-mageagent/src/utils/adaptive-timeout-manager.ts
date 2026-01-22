import { EventEmitter } from 'events';
import { logger } from './logger';

export interface TaskMetrics {
  taskId: string;
  model: string;
  startTime: number;
  lastActivityTime: number;
  bytesReceived: number;
  chunksReceived: number;
  stallCount: number;
  estimatedComplexity: 'simple' | 'medium' | 'complex' | 'extreme';
}

export interface TimeoutConfig {
  // Stall detection - timeout only if no activity
  maxStallDuration: number; // Default: 60 seconds of no activity

  // Grace periods based on complexity
  complexityMultipliers: {
    simple: number;   // 1x
    medium: number;   // 2x
    complex: number;  // 4x
    extreme: number;  // 10x
  };

  // Adaptive learning from historical data
  useHistoricalData: boolean;

  // Minimum activity to consider task alive (bytes per second)
  minActivityThreshold: number;
}

export class AdaptiveTimeoutManager extends EventEmitter {
  private activeTasks: Map<string, TaskMetrics> = new Map();
  private historicalPerformance: Map<string, number[]> = new Map();
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();

  private readonly defaultConfig: TimeoutConfig = {
    maxStallDuration: 60000, // 60 seconds of no activity
    complexityMultipliers: {
      simple: 1,
      medium: 2,
      complex: 4,
      extreme: 10
    },
    useHistoricalData: true,
    minActivityThreshold: 10 // 10 bytes per second minimum
  };

  constructor(private config: Partial<TimeoutConfig> = {}) {
    super();
    this.config = { ...this.defaultConfig, ...config };

    // CRITICAL FIX: Set max listeners to support high-concurrency scenarios
    // Prevents MaxListenersExceededWarning in production environments
    // Safe to set to 0 (unlimited) because we use proper cleanup patterns
    this.setMaxListeners(0);

    logger.debug('AdaptiveTimeoutManager initialized', {
      maxStallDuration: this.config.maxStallDuration,
      useHistoricalData: this.config.useHistoricalData,
      maxListeners: 'unlimited',
      pattern: 'Map-based monitoring with cleanup'
    });
  }

  /**
   * Start monitoring a task - NO HARDCODED TIMEOUT
   */
  startMonitoring(
    taskId: string,
    model: string,
    estimatedComplexity: TaskMetrics['estimatedComplexity'] = 'medium'
  ): void {
    const metrics: TaskMetrics = {
      taskId,
      model,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      bytesReceived: 0,
      chunksReceived: 0,
      stallCount: 0,
      estimatedComplexity
    };

    this.activeTasks.set(taskId, metrics);

    // Start stall detection monitoring
    const interval = setInterval(() => {
      this.checkForStalls(taskId);
    }, 5000); // Check every 5 seconds

    this.monitoringIntervals.set(taskId, interval);

    logger.info('Started adaptive monitoring for task', {
      taskId,
      model,
      complexity: estimatedComplexity,
      stallThreshold: this.getStallThreshold(estimatedComplexity)
    });
  }

  /**
   * Update task progress - keeps task alive
   */
  updateProgress(
    taskId: string,
    bytesReceived: number,
    chunksReceived: number
  ): void {
    const metrics = this.activeTasks.get(taskId);
    if (!metrics) return;

    metrics.lastActivityTime = Date.now();
    metrics.bytesReceived += bytesReceived;
    metrics.chunksReceived += chunksReceived;

    // Reset stall count on activity
    if (bytesReceived > 0) {
      metrics.stallCount = 0;
    }

    // Calculate throughput
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    const throughput = metrics.bytesReceived / elapsed;

    // Emit progress event
    this.emit('progress', {
      taskId,
      metrics,
      throughput,
      elapsed
    });

    // Log significant milestones
    if (metrics.chunksReceived % 100 === 0) {
      logger.debug('Task progress milestone', {
        taskId,
        chunks: metrics.chunksReceived,
        bytes: metrics.bytesReceived,
        throughput: `${Math.round(throughput)} bytes/sec`,
        elapsed: `${elapsed.toFixed(1)}s`
      });
    }
  }

  /**
   * Check for stalled tasks
   */
  private checkForStalls(taskId: string): void {
    const metrics = this.activeTasks.get(taskId);
    if (!metrics) return;

    const timeSinceLastActivity = Date.now() - metrics.lastActivityTime;
    const stallThreshold = this.getStallThreshold(metrics.estimatedComplexity);

    if (timeSinceLastActivity > stallThreshold) {
      metrics.stallCount++;

      logger.warn('Task stall detected', {
        taskId,
        model: metrics.model,
        stallCount: metrics.stallCount,
        timeSinceLastActivity: `${(timeSinceLastActivity / 1000).toFixed(1)}s`,
        totalElapsed: `${((Date.now() - metrics.startTime) / 1000).toFixed(1)}s`
      });

      // Emit stall event for handling
      this.emit('stall', {
        taskId,
        metrics,
        timeSinceLastActivity,
        recommendation: this.getStallRecommendation(metrics)
      });

      // After 3 stalls, consider the task hung
      if (metrics.stallCount >= 3) {
        this.handleHungTask(taskId);
      }
    }
  }

  /**
   * Get dynamic stall threshold based on complexity
   */
  private getStallThreshold(complexity: TaskMetrics['estimatedComplexity']): number {
    const baseThreshold = this.config.maxStallDuration || 60000;
    const multiplier = this.config.complexityMultipliers?.[complexity] || 1;
    return baseThreshold * multiplier;
  }

  /**
   * Get recommendation for handling stalled task
   */
  private getStallRecommendation(metrics: TaskMetrics): string {
    if (metrics.stallCount === 1) {
      return 'Wait - model may be processing complex content';
    } else if (metrics.stallCount === 2) {
      return 'Consider switching to a faster model';
    } else {
      return 'Abort task or switch to simpler approach';
    }
  }

  /**
   * Handle hung task
   */
  private handleHungTask(taskId: string): void {
    const metrics = this.activeTasks.get(taskId);
    if (!metrics) return;

    logger.error('Task appears to be hung', {
      taskId,
      model: metrics.model,
      totalTime: `${((Date.now() - metrics.startTime) / 1000).toFixed(1)}s`,
      bytesReceived: metrics.bytesReceived,
      lastActivity: `${((Date.now() - metrics.lastActivityTime) / 1000).toFixed(1)}s ago`
    });

    // Emit hung event for orchestrator to handle
    this.emit('hung', {
      taskId,
      metrics,
      suggestions: [
        'Switch to a different model',
        'Reduce task complexity',
        'Split into smaller subtasks',
        'Abort and retry with different approach'
      ]
    });

    // Stop monitoring this task
    this.stopMonitoring(taskId);
  }

  /**
   * Complete task monitoring
   */
  completeTask(taskId: string): void {
    const metrics = this.activeTasks.get(taskId);
    if (!metrics) return;

    const duration = Date.now() - metrics.startTime;

    // Store historical performance for learning
    if (this.config.useHistoricalData) {
      const modelHistory = this.historicalPerformance.get(metrics.model) || [];
      modelHistory.push(duration);

      // Keep last 100 data points
      if (modelHistory.length > 100) {
        modelHistory.shift();
      }

      this.historicalPerformance.set(metrics.model, modelHistory);
    }

    logger.info('Task completed successfully', {
      taskId,
      model: metrics.model,
      duration: `${(duration / 1000).toFixed(1)}s`,
      bytes: metrics.bytesReceived,
      chunks: metrics.chunksReceived,
      throughput: `${Math.round(metrics.bytesReceived / (duration / 1000))} bytes/sec`
    });

    this.stopMonitoring(taskId);
  }

  /**
   * Stop monitoring a task
   */
  stopMonitoring(taskId: string): void {
    const interval = this.monitoringIntervals.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(taskId);
    }

    this.activeTasks.delete(taskId);
  }

  /**
   * Get estimated completion time based on historical data
   */
  getEstimatedCompletionTime(
    model: string,
    complexity: TaskMetrics['estimatedComplexity']
  ): number | null {
    if (!this.config.useHistoricalData) return null;

    const history = this.historicalPerformance.get(model);
    if (!history || history.length === 0) return null;

    // Calculate average
    const avg = history.reduce((a, b) => a + b, 0) / history.length;

    // Apply complexity multiplier
    const multiplier = this.config.complexityMultipliers?.[complexity] || 1;

    return avg * multiplier;
  }

  /**
   * Get all active tasks
   */
  getActiveTasks(): TaskMetrics[] {
    return Array.from(this.activeTasks.values());
  }

  /**
   * Cleanup all monitoring
   */
  cleanup(): void {
    for (const taskId of this.monitoringIntervals.keys()) {
      this.stopMonitoring(taskId);
    }
  }

  /**
   * Complete disposal - cleanup + remove all listeners
   * Called during graceful shutdown to prevent memory leaks
   */
  dispose(): void {
    // Stop all task monitoring
    this.cleanup();

    // Clear all maps
    this.activeTasks.clear();
    this.historicalPerformance.clear();
    this.monitoringIntervals.clear();

    // Remove all event listeners to prevent leaks
    this.removeAllListeners();

    logger.info('AdaptiveTimeoutManager disposed', {
      pattern: 'Complete resource cleanup'
    });
  }
}

// Singleton instance
export const adaptiveTimeoutManager = new AdaptiveTimeoutManager();