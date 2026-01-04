/**
 * Health Routes for FileProcessAgent API (REFACTORED)
 *
 * CHANGES:
 * - Removed BullMQ dependency
 * - Uses JobRepository for queue stats (single source of truth)
 * - Actual PostgreSQL health check with timeout protection (2s)
 * - Actual Redis health check with timeout protection (2s)
 * - Graceful degradation: service operational even if dependencies fail
 *
 * Provides health check and readiness endpoints for monitoring and orchestration.
 *
 * Endpoints:
 * - GET /health - Basic health check (liveness probe)
 * - GET /health/ready - Readiness check (checks dependencies)
 * - GET /health/detailed - Detailed health status with dependency checks
 */

import { Router, Request, Response } from 'express';
import { getJobRepository } from '../repositories/JobRepository';
import { getPostgresClient } from '../clients/postgres.client';
import { getGraphRAGClient } from '../clients/GraphRAGClient';
import { logger } from '../utils/logger';
import { config } from '../config';
import Redis from 'ioredis';

const router = Router();

/**
 * Check PostgreSQL health with timeout protection
 */
async function checkPostgresHealth(timeout: number = 2000): Promise<{
  status: string;
  latency: string;
  error?: string;
}> {
  const startTime = Date.now();
  try {
    const postgresClient = getPostgresClient();
    await Promise.race([
      (postgresClient as any).pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), timeout)
      ),
    ]);

    return {
      status: 'ok',
      latency: `${Date.now() - startTime}ms`,
    };
  } catch (error) {
    return {
      status: 'error',
      latency: `${Date.now() - startTime}ms`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check Redis health with timeout protection
 */
async function checkRedisHealth(timeout: number = 2000): Promise<{
  status: string;
  latency: string;
  error?: string;
}> {
  const startTime = Date.now();
  let redis: Redis | null = null;

  try {
    redis = new Redis(config.redisUrl);

    await Promise.race([
      redis.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), timeout)
      ),
    ]);

    const latency = Date.now() - startTime;
    await redis.quit();

    return {
      status: 'ok',
      latency: `${latency}ms`,
    };
  } catch (error) {
    if (redis) {
      try {
        await redis.quit();
      } catch (quitError) {
        // Ignore quit errors
      }
    }

    return {
      status: 'error',
      latency: `${Date.now() - startTime}ms`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * GET /health
 *
 * Basic health check - returns 200 if service is alive.
 * Used for Kubernetes liveness probes.
 *
 * Response:
 * {
 *   "status": "ok",
 *   "service": "FileProcessAgent",
 *   "version": "1.0.0",
 *   "timestamp": "2025-10-22T..."
 * }
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'FileProcessAgent',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready
 *
 * Readiness check - returns 200 if service can handle requests.
 * Used for Kubernetes readiness probes.
 * Checks critical dependencies: PostgreSQL, Redis
 *
 * Response:
 * {
 *   "status": "ready",
 *   "service": "FileProcessAgent",
 *   "dependencies": {
 *     "postgres": { "status": "ok", "latency": "5ms" },
 *     "redis": { "status": "ok", "latency": "3ms" }
 *   },
 *   "timestamp": "2025-10-22T..."
 * }
 */
router.get('/health/ready', async (_req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Check critical dependencies with timeout protection
    const [postgresHealth, redisHealth] = await Promise.all([
      checkPostgresHealth(2000),
      checkRedisHealth(2000),
    ]);

    const duration = Date.now() - startTime;

    // Service is ready if both PostgreSQL and Redis are healthy
    const isReady = postgresHealth.status === 'ok' && redisHealth.status === 'ok';

    if (isReady) {
      const response = {
        status: 'ready',
        service: 'FileProcessAgent',
        dependencies: {
          postgres: {
            status: postgresHealth.status,
            latency: postgresHealth.latency,
          },
          redis: {
            status: redisHealth.status,
            latency: redisHealth.latency,
          },
        },
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
      };

      logger.debug('Readiness check passed', response);
      res.status(200).json(response);
    } else {
      // Not ready - return 503
      const response = {
        status: 'not ready',
        service: 'FileProcessAgent',
        dependencies: {
          postgres: {
            status: postgresHealth.status,
            latency: postgresHealth.latency,
            error: postgresHealth.error,
          },
          redis: {
            status: redisHealth.status,
            latency: redisHealth.latency,
            error: redisHealth.error,
          },
        },
        duration: `${duration}ms`,
        timestamp: new Date().toISOString(),
      };

      logger.warn('Readiness check failed', response);
      res.status(503).json(response);
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Readiness check error', {
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(503).json({
      status: 'not ready',
      service: 'FileProcessAgent',
      error: 'Health check failed',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /health/detailed
 *
 * Detailed health status with all dependency checks.
 * Useful for monitoring dashboards and debugging.
 *
 * Response:
 * {
 *   "status": "healthy",
 *   "service": "FileProcessAgent",
 *   "version": "1.0.0",
 *   "dependencies": {
 *     "postgres": { "status": "ok", "latency": "5ms" },
 *     "redis": { "status": "ok", "latency": "3ms" },
 *     "queue": { "status": "ok", "stats": { ... } },
 *     "graphrag": { "status": "ok", "circuitBreaker": "CLOSED" }
 *   },
 *   "config": {
 *     "maxFileSize": "5GB",
 *     "chunkSize": "64KB",
 *     "workerConcurrency": 10
 *   },
 *   "timestamp": "2025-10-22T..."
 * }
 */
router.get('/health/detailed', async (_req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    // Check all dependencies with timeout protection
    const [postgresHealth, redisHealth] = await Promise.all([
      checkPostgresHealth(2000),
      checkRedisHealth(2000),
    ]);

    // Get queue stats from JobRepository
    let queueStats: any = null;
    try {
      const jobRepository = getJobRepository();
      queueStats = await jobRepository.getQueueStats();
    } catch (statsError) {
      logger.warn('Failed to get queue stats', {
        error: statsError instanceof Error ? statsError.message : String(statsError),
      });
    }

    // Check GraphRAG health
    let graphRAGHealthy = false;
    let circuitBreakerState = 'UNKNOWN';
    try {
      const graphRAGClient = getGraphRAGClient();
      [graphRAGHealthy, circuitBreakerState] = await Promise.all([
        graphRAGClient.healthCheck().catch(() => false),
        Promise.resolve(graphRAGClient.getCircuitBreakerState()),
      ]);
    } catch (graphRAGError) {
      logger.warn('GraphRAG health check failed', {
        error: graphRAGError instanceof Error ? graphRAGError.message : String(graphRAGError),
      });
    }

    const duration = Date.now() - startTime;

    // Determine overall health status
    const criticalHealthy = postgresHealth.status === 'ok' && redisHealth.status === 'ok';
    const overallStatus = criticalHealthy
      ? graphRAGHealthy
        ? 'healthy'
        : 'degraded' // Critical systems OK, non-critical (GraphRAG) degraded
      : 'unhealthy'; // Critical systems failing

    const response = {
      status: overallStatus,
      service: 'FileProcessAgent',
      version: '1.0.0',
      dependencies: {
        postgres: {
          status: postgresHealth.status,
          latency: postgresHealth.latency,
          error: postgresHealth.error,
        },
        redis: {
          status: redisHealth.status,
          latency: redisHealth.latency,
          error: redisHealth.error,
        },
        queue: {
          status: queueStats ? 'ok' : 'unavailable',
          stats: queueStats,
        },
        graphrag: {
          status: graphRAGHealthy ? 'ok' : 'unavailable',
          circuitBreaker: circuitBreakerState,
        },
      },
      config: {
        maxFileSize: `${(config.maxFileSize / 1073741824).toFixed(2)}GB`,
        chunkSize: `${(config.chunkSize / 1024).toFixed(0)}KB`,
        processingTimeout: `${(config.processingTimeout / 1000).toFixed(0)}s`,
        workerConcurrency: config.workerConcurrency,
      },
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    };

    logger.debug('Detailed health check completed', response);

    // Return 200 for healthy/degraded (service operational), 503 for unhealthy
    const statusCode = overallStatus === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(response);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Detailed health check failed', {
      error: errorMessage,
      duration: `${duration}ms`,
    });

    res.status(503).json({
      status: 'unhealthy',
      service: 'FileProcessAgent',
      error: 'Health check failed',
      details: config.nodeEnv === 'development' ? errorMessage : undefined,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
