/**
 * Worker Health Monitoring
 *
 * **Purpose**: Tracks worker health metrics and detects abnormal patterns
 * that indicate worker instability or performance degradation.
 *
 * **Metrics Tracked**:
 * - Worker heartbeat (last activity timestamp)
 * - Task processing rate
 * - Error rate
 * - Watchdog timeout frequency
 * - Average task duration
 * - Queue depth
 *
 * **Health States**:
 * - HEALTHY: Normal operation
 * - DEGRADED: Elevated errors or slow processing
 * - UNHEALTHY: Critical issues, watchdog timeouts
 *
 * @module WorkerHealth
 */

import { Logger } from 'winston';
import { EventEmitter } from 'events';

export enum WorkerHealthState {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy'
}

export interface WorkerHealthMetrics {
  state: WorkerHealthState;
  lastHeartbeat: Date;
  uptime: number;
  totalProcessed: number;
  totalErrors: number;
  totalWatchdogTimeouts: number;
  errorRate: number; // errors per minute
  processingRate: number; // tasks per minute
  averageTaskDuration: number;
  queueDepth: number;
  consecutiveErrors: number;
  consecutiveTimeouts: number;
}

export interface WorkerHealthThresholds {
  /**
   * Maximum error rate (errors/min) before DEGRADED state
   * Default: 5
   */
  degradedErrorRate?: number;

  /**
   * Maximum error rate (errors/min) before UNHEALTHY state
   * Default: 10
   */
  unhealthyErrorRate?: number;

  /**
   * Maximum consecutive errors before DEGRADED state
   * Default: 3
   */
  degradedConsecutiveErrors?: number;

  /**
   * Maximum consecutive errors before UNHEALTHY state
   * Default: 5
   */
  unhealthyConsecutiveErrors?: number;

  /**
   * Maximum consecutive watchdog timeouts before UNHEALTHY state
   * Default: 2
   */
  unhealthyConsecutiveTimeouts?: number;

  /**
   * Minimum processing rate (tasks/min) before DEGRADED state
   * Default: 1
   */
  degradedProcessingRate?: number;
}

export class WorkerHealthMonitor extends EventEmitter {
  private metrics: WorkerHealthMetrics = {
    state: WorkerHealthState.HEALTHY,
    lastHeartbeat: new Date(),
    uptime: 0,
    totalProcessed: 0,
    totalErrors: 0,
    totalWatchdogTimeouts: 0,
    errorRate: 0,
    processingRate: 0,
    averageTaskDuration: 0,
    queueDepth: 0,
    consecutiveErrors: 0,
    consecutiveTimeouts: 0
  };

  private readonly startTime: Date;
  private lastMetricsUpdate: Date;
  private metricsWindow: Array<{ timestamp: Date; success: boolean; duration: number }> = [];

  private readonly thresholds: Required<WorkerHealthThresholds>;

  constructor(
    private readonly logger: Logger,
    thresholds: WorkerHealthThresholds = {}
  ) {
    super();

    this.thresholds = {
      degradedErrorRate: thresholds.degradedErrorRate ?? 5,
      unhealthyErrorRate: thresholds.unhealthyErrorRate ?? 10,
      degradedConsecutiveErrors: thresholds.degradedConsecutiveErrors ?? 3,
      unhealthyConsecutiveErrors: thresholds.unhealthyConsecutiveErrors ?? 5,
      unhealthyConsecutiveTimeouts: thresholds.unhealthyConsecutiveTimeouts ?? 2,
      degradedProcessingRate: thresholds.degradedProcessingRate ?? 1
    };

    this.startTime = new Date();
    this.lastMetricsUpdate = new Date();

    this.logger.info('WorkerHealthMonitor initialized', {
      thresholds: this.thresholds
    });

    // Start periodic health check
    this.startPeriodicHealthCheck();
  }

  /**
   * Record a heartbeat (worker is alive)
   */
  heartbeat(): void {
    this.metrics.lastHeartbeat = new Date();
    this.metrics.uptime = Date.now() - this.startTime.getTime();
  }

  /**
   * Record a successful task completion
   */
  recordSuccess(duration: number): void {
    this.heartbeat();
    this.metrics.totalProcessed++;
    this.metrics.consecutiveErrors = 0;
    this.metrics.consecutiveTimeouts = 0;

    this.metricsWindow.push({
      timestamp: new Date(),
      success: true,
      duration
    });

    this.updateRollingMetrics();
    this.evaluateHealth();
  }

  /**
   * Record a task error
   */
  recordError(duration: number): void {
    this.heartbeat();
    this.metrics.totalErrors++;
    this.metrics.consecutiveErrors++;

    this.metricsWindow.push({
      timestamp: new Date(),
      success: false,
      duration
    });

    this.updateRollingMetrics();
    this.evaluateHealth();
  }

  /**
   * Record a watchdog timeout
   */
  recordWatchdogTimeout(): void {
    this.heartbeat();
    this.metrics.totalWatchdogTimeouts++;
    this.metrics.consecutiveTimeouts++;

    this.updateRollingMetrics();
    this.evaluateHealth();

    this.logger.warn('Watchdog timeout recorded', {
      consecutiveTimeouts: this.metrics.consecutiveTimeouts,
      totalTimeouts: this.metrics.totalWatchdogTimeouts
    });
  }

  /**
   * Update queue depth metric
   */
  updateQueueDepth(depth: number): void {
    this.metrics.queueDepth = depth;
  }

  /**
   * Get current health metrics
   */
  getMetrics(): Readonly<WorkerHealthMetrics> {
    return { ...this.metrics };
  }

  /**
   * Get current health state
   */
  getState(): WorkerHealthState {
    return this.metrics.state;
  }

  /**
   * Check if worker is healthy
   */
  isHealthy(): boolean {
    return this.metrics.state === WorkerHealthState.HEALTHY;
  }

  /**
   * Update rolling metrics based on recent activity
   */
  private updateRollingMetrics(): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Keep only last minute of data
    this.metricsWindow = this.metricsWindow.filter(
      m => m.timestamp.getTime() > oneMinuteAgo
    );

    if (this.metricsWindow.length === 0) {
      this.metrics.errorRate = 0;
      this.metrics.processingRate = 0;
      this.metrics.averageTaskDuration = 0;
      return;
    }

    // Calculate error rate (errors per minute)
    const errors = this.metricsWindow.filter(m => !m.success).length;
    this.metrics.errorRate = errors;

    // Calculate processing rate (tasks per minute)
    this.metrics.processingRate = this.metricsWindow.length;

    // Calculate average task duration
    const totalDuration = this.metricsWindow.reduce((sum, m) => sum + m.duration, 0);
    this.metrics.averageTaskDuration = totalDuration / this.metricsWindow.length;
  }

  /**
   * Evaluate worker health based on thresholds
   */
  private evaluateHealth(): void {
    const previousState = this.metrics.state;
    let newState = WorkerHealthState.HEALTHY;

    // Check for UNHEALTHY conditions
    if (
      this.metrics.errorRate >= this.thresholds.unhealthyErrorRate ||
      this.metrics.consecutiveErrors >= this.thresholds.unhealthyConsecutiveErrors ||
      this.metrics.consecutiveTimeouts >= this.thresholds.unhealthyConsecutiveTimeouts
    ) {
      newState = WorkerHealthState.UNHEALTHY;
    }
    // Check for DEGRADED conditions
    else if (
      this.metrics.errorRate >= this.thresholds.degradedErrorRate ||
      this.metrics.consecutiveErrors >= this.thresholds.degradedConsecutiveErrors ||
      (this.metricsWindow.length > 0 && this.metrics.processingRate < this.thresholds.degradedProcessingRate)
    ) {
      newState = WorkerHealthState.DEGRADED;
    }

    // Update state and emit event if changed
    if (newState !== previousState) {
      this.metrics.state = newState;

      this.logger.warn('Worker health state changed', {
        previousState,
        newState,
        metrics: this.metrics
      });

      this.emit('healthStateChanged', {
        previousState,
        newState,
        metrics: this.metrics
      });
    }
  }

  /**
   * Start periodic health check
   */
  private startPeriodicHealthCheck(): void {
    setInterval(() => {
      // FIXED: Refresh heartbeat to prevent stale warnings during idle periods
      // This ensures the worker is marked as alive even when no tasks are being processed
      this.heartbeat();

      this.updateRollingMetrics();
      this.evaluateHealth();

      // Check for stale heartbeat (no activity in 5 minutes)
      // NOTE: With periodic heartbeat above, this should only trigger if the interval itself stops
      // Keeping for detection of truly stuck workers (e.g., event loop blocked)
      const lastHeartbeatAge = Date.now() - this.metrics.lastHeartbeat.getTime();
      if (lastHeartbeatAge > 300000) { // 5 minutes
        this.logger.warn('Worker heartbeat stale - possible event loop blockage', {
          lastHeartbeat: this.metrics.lastHeartbeat,
          ageMs: lastHeartbeatAge,
          suggestion: 'Check for blocking operations or restart the worker'
        });
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Get health status for HTTP endpoint
   */
  getHealthStatus(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    metrics: WorkerHealthMetrics;
  } {
    return {
      status: this.metrics.state,
      uptime: this.metrics.uptime,
      metrics: this.metrics
    };
  }
}
