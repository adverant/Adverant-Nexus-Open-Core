/**
 * Disposable Resource Wrapper
 *
 * Implements RAII (Resource Acquisition Is Initialization) pattern for automatic cleanup.
 * Guarantees resource disposal even in error scenarios.
 *
 * Usage:
 * ```typescript
 * const disposable = new DisposableResource(agent, logger, 'agent-123');
 * try {
 *   await disposable.use(async (agent) => {
 *     return await agent.execute();
 *   });
 * } finally {
 *   await disposable.dispose();
 * }
 * ```
 *
 * @module disposable
 * @version 1.0.0
 */

import { logger as defaultLogger } from './logger';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Interface for disposable resources.
 */
export interface Disposable {
  dispose(): Promise<void>;
  isDisposed?(): boolean;
}

/**
 * Disposal options for fine-grained control.
 */
export interface DisposalOptions {
  /**
   * Force disposal even if resource claims to be disposed.
   * Default: false
   */
  force?: boolean;

  /**
   * Timeout for disposal operation (ms).
   * Default: 5000ms
   */
  timeout?: number;

  /**
   * Suppress disposal errors (log but don't throw).
   * Default: true (best-effort cleanup)
   */
  suppressErrors?: boolean;
}

/**
 * Disposal statistics for monitoring.
 */
export interface DisposalStats {
  totalDisposed: number;
  successfulDisposals: number;
  failedDisposals: number;
  avgDisposalTimeMs: number;
  undisposedResources: number;
}

// ============================================================================
// Disposable Resource Wrapper
// ============================================================================

/**
 * RAII wrapper for disposable resources.
 *
 * Guarantees disposal and provides:
 * - Automatic cleanup on scope exit
 * - Disposal timeout protection
 * - Error suppression for best-effort cleanup
 * - Disposal tracking and metrics
 */
export class DisposableResource<T extends Disposable> implements Disposable {
  private disposed = false;
  private disposalTime?: number;
  private createdAt: number;

  // Class-level statistics
  private static totalDisposed = 0;
  private static successfulDisposals = 0;
  private static failedDisposals = 0;
  private static totalDisposalTime = 0;
  private static activeResources = new Set<DisposableResource<any>>();

  constructor(
    private resource: T,
    private logger: typeof defaultLogger = defaultLogger,
    private name: string = 'unnamed-resource'
  ) {
    this.createdAt = Date.now();

    // Track active resource
    DisposableResource.activeResources.add(this);

    logger.debug('DisposableResource created', {
      name: this.name,
      component: 'disposable'
    });
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Use resource with automatic disposal.
   *
   * The resource will be disposed after the callback completes,
   * even if it throws an error.
   *
   * Example:
   * ```typescript
   * const result = await disposable.use(async (agent) => {
   *   return await agent.execute();
   * });
   * // agent is automatically disposed here
   * ```
   */
  async use<R>(fn: (resource: T) => Promise<R>): Promise<R> {
    if (this.disposed) {
      throw new Error(
        `Cannot use disposed resource: ${this.name}. ` +
        `Resource was already cleaned up and cannot be reused.`
      );
    }

    try {
      this.logger.debug('Using disposable resource', {
        name: this.name,
        component: 'disposable'
      });

      return await fn(this.resource);

    } finally {
      // CRITICAL: Always dispose, even on error
      await this.dispose();
    }
  }

  /**
   * Dispose resource immediately.
   *
   * Safe to call multiple times - subsequent calls are no-ops.
   * Best-effort cleanup - logs errors but doesn't throw by default.
   */
  async dispose(options: DisposalOptions = {}): Promise<void> {
    const {
      force = false,
      timeout = 5000,
      suppressErrors = true
    } = options;

    // Check if already disposed
    if (this.disposed && !force) {
      this.logger.debug('Resource already disposed', {
        name: this.name,
        component: 'disposable'
      });
      return;
    }

    // Mark as disposed FIRST to prevent re-entry
    this.disposed = true;

    const startTime = Date.now();

    try {
      // Wrap disposal in timeout to prevent hanging
      await this.withTimeout(
        this.resource.dispose(),
        timeout,
        `Disposal timeout for ${this.name}`
      );

      // Record successful disposal
      this.disposalTime = Date.now() - startTime;
      DisposableResource.totalDisposed++;
      DisposableResource.successfulDisposals++;
      DisposableResource.totalDisposalTime += this.disposalTime;

      // Remove from active resources
      DisposableResource.activeResources.delete(this);

      this.logger.debug('Resource disposed successfully', {
        name: this.name,
        disposalTimeMs: this.disposalTime,
        lifetimeMs: Date.now() - this.createdAt,
        component: 'disposable'
      });

    } catch (error) {
      // Record failed disposal
      DisposableResource.totalDisposed++;
      DisposableResource.failedDisposals++;

      this.logger.error('Resource disposal failed', {
        name: this.name,
        error: error instanceof Error ? error.message : String(error),
        lifetimeMs: Date.now() - this.createdAt,
        component: 'disposable'
      });

      // Emit metric for monitoring
      this.emitDisposalFailureMetric(error);

      if (!suppressErrors) {
        throw error;
      }
    }
  }

  /**
   * Check if resource is disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Get resource (use with caution - prefer `use()` method).
   *
   * Throws if resource is already disposed.
   */
  getResource(): T {
    if (this.disposed) {
      throw new Error(
        `Cannot access disposed resource: ${this.name}. ` +
        `Resource was already cleaned up.`
      );
    }

    return this.resource;
  }

  /**
   * Get resource name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get resource lifetime in milliseconds.
   */
  getLifetimeMs(): number {
    return Date.now() - this.createdAt;
  }

  /**
   * Get disposal time in milliseconds (if disposed).
   */
  getDisposalTimeMs(): number | undefined {
    return this.disposalTime;
  }

  // ==========================================================================
  // Static Methods for Monitoring
  // ==========================================================================

  /**
   * Get global disposal statistics.
   */
  static getStats(): DisposalStats {
    return {
      totalDisposed: DisposableResource.totalDisposed,
      successfulDisposals: DisposableResource.successfulDisposals,
      failedDisposals: DisposableResource.failedDisposals,
      avgDisposalTimeMs: DisposableResource.totalDisposed > 0
        ? DisposableResource.totalDisposalTime / DisposableResource.totalDisposed
        : 0,
      undisposedResources: DisposableResource.activeResources.size
    };
  }

  /**
   * Get list of active (undisposed) resources.
   *
   * Useful for leak detection.
   */
  static getActiveResources(): Array<{
    name: string;
    lifetimeMs: number;
    createdAt: Date;
  }> {
    return Array.from(DisposableResource.activeResources).map(resource => ({
      name: resource.name,
      lifetimeMs: resource.getLifetimeMs(),
      createdAt: new Date(resource.createdAt)
    }));
  }

  /**
   * Reset global statistics (for testing).
   */
  static resetStats(): void {
    DisposableResource.totalDisposed = 0;
    DisposableResource.successfulDisposals = 0;
    DisposableResource.failedDisposals = 0;
    DisposableResource.totalDisposalTime = 0;
    DisposableResource.activeResources.clear();
  }

  /**
   * Dispose all active resources (emergency cleanup).
   *
   * Use with caution - for shutdown scenarios only.
   */
  static async disposeAll(options?: DisposalOptions): Promise<number> {
    const resources = Array.from(DisposableResource.activeResources);
    const startTime = Date.now();

    defaultLogger.warn('Disposing all active resources', {
      count: resources.length,
      component: 'disposable'
    });

    // Dispose all resources in parallel
    const results = await Promise.allSettled(
      resources.map(resource => resource.dispose(options))
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failureCount = results.filter(r => r.status === 'rejected').length;

    defaultLogger.info('Disposed all active resources', {
      total: resources.length,
      successful: successCount,
      failed: failureCount,
      durationMs: Date.now() - startTime,
      component: 'disposable'
    });

    return successCount;
  }

  // ==========================================================================
  // Private Helper Methods
  // ==========================================================================

  /**
   * Wrap promise in timeout.
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      )
    ]);
  }

  /**
   * Emit disposal failure metric for monitoring.
   */
  private emitDisposalFailureMetric(error: unknown): void {
    // TODO: Integrate with metrics system (Prometheus, CloudWatch, etc.)
    this.logger.warn('METRIC: disposal_failure', {
      name: this.name,
      error: error instanceof Error ? error.message : String(error),
      lifetimeMs: this.getLifetimeMs(),
      totalFailures: DisposableResource.failedDisposals,
      failureRate: DisposableResource.failedDisposals / DisposableResource.totalDisposed,
      component: 'disposable'
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create and use a disposable resource in one call.
 *
 * Convenience function for simple use cases.
 *
 * Example:
 * ```typescript
 * const result = await useDisposable(agent, async (agent) => {
 *   return await agent.execute();
 * });
 * ```
 */
export async function useDisposable<T extends Disposable, R>(
  resource: T,
  fn: (resource: T) => Promise<R>,
  name?: string
): Promise<R> {
  const disposable = new DisposableResource(resource, defaultLogger, name);
  return disposable.use(fn);
}

/**
 * Batch dispose multiple resources.
 *
 * Disposes all resources in parallel and returns success count.
 */
export async function disposeAll<T extends Disposable>(
  resources: T[],
  options?: DisposalOptions
): Promise<number> {
  const disposables = resources.map(
    (resource, index) => new DisposableResource(resource, defaultLogger, `batch-${index}`)
  );

  const results = await Promise.allSettled(
    disposables.map(d => d.dispose(options))
  );

  return results.filter(r => r.status === 'fulfilled').length;
}
