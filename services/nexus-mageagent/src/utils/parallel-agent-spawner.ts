import { logger } from './logger';
import { Agent } from '../agents/base-agent';

export interface ParallelSpawnOptions {
  maxConcurrency?: number;
  timeout?: number;
  retryOnFailure?: boolean;
  batchSize?: number;
}

export interface SpawnRequest<T = any> {
  id: string;
  spawner: () => Promise<T>;
  metadata?: any;
}

export interface SpawnResult<T = any> {
  id: string;
  status: 'fulfilled' | 'rejected';
  value?: T;
  reason?: Error;
  duration: number;
  metadata?: any;
}

export class ParallelAgentSpawner {
  private activeSpawns = new Map<string, Promise<any>>();

  /**
   * Spawn multiple agents in true parallel with controlled concurrency
   * This ensures agents are created simultaneously, not sequentially
   */
  async spawnParallel<T = Agent>(
    requests: SpawnRequest<T>[],
    options: ParallelSpawnOptions = {}
  ): Promise<SpawnResult<T>[]> {
    const {
      maxConcurrency = Infinity,
      timeout = 300000, // 5 minutes default for complex tasks
      retryOnFailure = false,
      batchSize = 10
    } = options;

    logger.info('Starting parallel agent spawn', {
      requestCount: requests.length,
      maxConcurrency,
      timeout,
      batchSize
    });

    const results: SpawnResult<T>[] = [];
    const startTime = Date.now();

    // Process in batches for memory efficiency
    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, Math.min(i + batchSize, requests.length));

      // Create spawn promises with proper timeout handling
      const batchPromises = batch.map(request => this.spawnWithTimeout(
        request,
        timeout,
        retryOnFailure
      ));

      // Wait for batch to complete
      const batchResults = await Promise.allSettled(batchPromises);

      // Process results
      batchResults.forEach((result, index) => {
        const request = batch[index];
        const duration = Date.now() - startTime;

        if (result.status === 'fulfilled') {
          results.push({
            id: request.id,
            status: 'fulfilled',
            value: result.value,
            duration,
            metadata: request.metadata
          });
        } else {
          logger.error('Agent spawn failed', {
            id: request.id,
            error: result.reason,
            duration
          });

          results.push({
            id: request.id,
            status: 'rejected',
            reason: result.reason,
            duration,
            metadata: request.metadata
          });
        }
      });

      // Clean up memory after each batch
      if (global.gc && i % (batchSize * 2) === 0) {
        global.gc();
      }
    }

    logger.info('Parallel spawn complete', {
      totalDuration: Date.now() - startTime,
      successCount: results.filter(r => r.status === 'fulfilled').length,
      failureCount: results.filter(r => r.status === 'rejected').length
    });

    return results;
  }

  /**
   * Spawn with timeout and optional retry
   */
  private async spawnWithTimeout<T>(
    request: SpawnRequest<T>,
    timeout: number,
    retry: boolean
  ): Promise<T> {
    const spawner = async (): Promise<T> => {
      // Track active spawn
      const spawnPromise = request.spawner();
      this.activeSpawns.set(request.id, spawnPromise);

      try {
        // Race between spawn and timeout
        const result = await Promise.race([
          spawnPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Spawn timeout after ${timeout}ms`)), timeout)
          )
        ]);

        return result;
      } finally {
        // Clean up tracking
        this.activeSpawns.delete(request.id);
      }
    };

    // Execute with retry if configured
    if (retry) {
      try {
        return await spawner();
      } catch (firstError) {
        logger.warn('Retrying failed spawn', { id: request.id, error: firstError });

        // Wait briefly before retry
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          return await spawner();
        } catch (secondError) {
          throw new Error(`Spawn failed after retry: ${secondError}`);
        }
      }
    }

    return spawner();
  }

  /**
   * Create spawn requests for concurrent execution
   */
  createSpawnRequests<T>(
    spawners: Array<{ id: string; spawner: () => Promise<T>; metadata?: any }>
  ): SpawnRequest<T>[] {
    return spawners.map(({ id, spawner, metadata }) => ({
      id,
      spawner,
      metadata
    }));
  }

  /**
   * Cancel all active spawns
   */
  cancelAll(): void {
    logger.warn('Cancelling all active spawns', { count: this.activeSpawns.size });
    this.activeSpawns.clear();
  }

  /**
   * Get count of active spawns
   */
  getActiveCount(): number {
    return this.activeSpawns.size;
  }
}

// Singleton instance
export const parallelAgentSpawner = new ParallelAgentSpawner();