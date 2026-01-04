/**
 * FileProcessAgent API Gateway Server
 *
 * Express + Socket.IO server for document processing orchestration.
 *
 * Architecture:
 * - Express REST API for job submission and management
 * - Socket.IO WebSocket server for real-time progress updates
 * - BullMQ queue integration for async processing
 * - Integration with GraphRAG and MageAgent services
 * - Enterprise routing pattern: /fileprocess/api/*
 *
 * Endpoints:
 * - POST /fileprocess/api/process - Submit file for processing
 * - POST /fileprocess/api/process/url - Submit URL for processing
 * - GET /fileprocess/api/jobs/:id - Get job status
 * - DELETE /fileprocess/api/jobs/:id - Cancel job
 * - GET /fileprocess/api/jobs - List jobs
 * - GET /fileprocess/api/queue/stats - Queue statistics
 * - GET /health - Health check
 * - GET /health/ready - Readiness check
 * - GET /health/detailed - Detailed health status
 *
 * WebSocket Events:
 * - job:status - Real-time job status updates
 * - job:progress - Processing progress updates
 * - job:completed - Job completion notification
 * - job:failed - Job failure notification
 */

import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { logger } from './utils/logger';

// Import metrics and tracing
import { metricsMiddleware, metricsHandler } from './utils/metrics';
import { initTracing } from './utils/tracing';

// Import usage tracking middleware
import { usageTrackingMiddleware, flushPendingReports } from './middleware/usage-tracking';

// Import telemetry for unified orchestration monitoring
import {
  TelemetryPublisher,
  createTelemetryMiddleware
} from '@adverant/nexus-telemetry';

// Import routes
import processRoutes from './routes/process.routes';
import jobsRoutes from './routes/jobs.routes';
import healthRoutes from './routes/health.routes';
import artifactRoutes from './routes/artifacts.routes';

// Import queue producer for initialization
// NOTE: BullMQ not used - Worker uses simple Redis LIST queue (RedisQueue)
// import { getQueueProducer } from './queue/bullmq-producer';

// Import PostgreSQL client for initialization
import { initPostgresClient, getPostgresClient } from './clients/postgres.client';

// Import DatabaseMigrator for automatic schema migrations
import { DatabaseMigrator } from './database/migrator';

// Import JobRepository for initialization (REFACTORED)
import { initJobRepository } from './repositories/JobRepository';
import IORedis from 'ioredis';

// Import MinIO and ArtifactRepository for universal file storage
import { initializeMinIO } from './storage/minio-client';
import { initArtifactRepository } from './repositories/ArtifactRepository';

// Telemetry publisher singleton for the FileProcess service
let telemetryPublisher: TelemetryPublisher | null = null;

/**
 * Get or create telemetry publisher
 */
function getTelemetryPublisher(): TelemetryPublisher {
  if (!telemetryPublisher) {
    telemetryPublisher = new TelemetryPublisher({
      redisUrl: config.redisUrl,
      serviceName: 'nexus-fileprocess',
      instanceId: process.env.HOSTNAME || `fileprocess-${Date.now()}`,
      enableMetrics: true
    });
    logger.info('TelemetryPublisher initialized for unified orchestration monitoring');
  }
  return telemetryPublisher;
}

/**
 * Initialize Express application with middleware
 */
function createExpressApp(): Application {
  const app = express();

  // Initialize telemetry publisher for orchestration monitoring
  const telemetryPub = getTelemetryPublisher();

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }));

  // CORS configuration
  app.use(cors({
    origin: config.nodeEnv === 'production'
      ? ['https://nexus.example.com'] // TODO: Configure actual domain
      : '*',
    credentials: true,
  }));

  // Body parsing middleware (5GB limit for large file metadata)
  app.use(express.json({ limit: '5gb' }));
  app.use(express.urlencoded({ extended: true, limit: '5gb' }));

  // Prometheus metrics middleware (before routes)
  app.use(metricsMiddleware);

  // Usage tracking middleware for billing and analytics
  app.use(usageTrackingMiddleware);

  // Telemetry middleware for unified orchestration monitoring
  // Publishes all HTTP requests to Redis Streams for orchestrator consumption
  app.use(createTelemetryMiddleware(telemetryPub, {
    skipPaths: ['/health', '/healthz', '/ready', '/metrics', '/ping']
  }));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Log request
    logger.debug('Incoming request', {
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip,
    });

    // Log response
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.info('Request completed', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: `${duration}ms`,
      });
    });

    next();
  });

  // Metrics endpoint (Prometheus scraping)
  app.get('/metrics', metricsHandler);

  // Mount routes - Enterprise Pattern: /fileprocess/api/* for service-level namespace isolation
  app.use('/fileprocess/api', processRoutes);
  app.use('/fileprocess/api', jobsRoutes);
  app.use('/fileprocess/api', artifactRoutes); // Universal file storage API
  app.use('/', healthRoutes);

  // Root endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      service: 'FileProcessAgent',
      version: '1.0.1-enterprise-routing',
      status: 'running',
      routing: 'Enterprise pattern - /fileprocess/api/* namespace',
      endpoints: {
        process: {
          upload: 'POST /fileprocess/api/process',
          url: 'POST /fileprocess/api/process/url',
        },
        jobs: {
          status: 'GET /fileprocess/api/jobs/:id',
          cancel: 'DELETE /fileprocess/api/jobs/:id',
          list: 'GET /fileprocess/api/jobs?state=waiting',
        },
        queue: {
          stats: 'GET /fileprocess/api/queue/stats',
        },
        health: {
          basic: 'GET /health',
          ready: 'GET /health/ready',
          detailed: 'GET /health/detailed',
        },
      },
      websocket: {
        url: `ws://localhost:${config.wsPort}`,
        events: [
          'job:status',
          'job:progress',
          'job:completed',
          'job:failed',
        ],
      },
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: 'Not found',
      message: `Endpoint ${req.method} ${req.path} not found`,
    });
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack,
      method: req.method,
      path: req.path,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: config.nodeEnv === 'development' ? err.message : 'An unexpected error occurred',
    });
  });

  return app;
}

/**
 * Initialize Socket.IO server for real-time updates
 */
function createSocketIOServer(httpServer: HTTPServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.nodeEnv === 'production'
        ? ['https://nexus.example.com'] // TODO: Configure actual domain
        : '*',
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Socket.IO connection handler
  io.on('connection', (socket) => {
    logger.info('WebSocket client connected', {
      socketId: socket.id,
      ip: socket.handshake.address,
    });

    // Subscribe to job updates
    socket.on('subscribe:job', (jobId: string) => {
      if (!jobId || typeof jobId !== 'string') {
        socket.emit('error', { message: 'Invalid job ID' });
        return;
      }

      socket.join(`job:${jobId}`);
      logger.debug('Client subscribed to job updates', {
        socketId: socket.id,
        jobId,
      });

      socket.emit('subscribed', { jobId });
    });

    // Unsubscribe from job updates
    socket.on('unsubscribe:job', (jobId: string) => {
      if (!jobId || typeof jobId !== 'string') {
        return;
      }

      socket.leave(`job:${jobId}`);
      logger.debug('Client unsubscribed from job updates', {
        socketId: socket.id,
        jobId,
      });

      socket.emit('unsubscribed', { jobId });
    });

    // Disconnect handler
    socket.on('disconnect', (reason) => {
      logger.info('WebSocket client disconnected', {
        socketId: socket.id,
        reason,
      });
    });

    // Error handler
    socket.on('error', (error) => {
      logger.error('WebSocket error', {
        socketId: socket.id,
        error: error.message,
      });
    });
  });

  logger.info('Socket.IO server initialized', {
    path: '/socket.io',
  });

  return io;
}

/**
 * Graceful shutdown handler
 */
function setupGracefulShutdown(
  httpServer: HTTPServer,
  io: SocketIOServer
): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    // Flush pending usage tracking reports
    try {
      await flushPendingReports();
      logger.info('Usage tracking reports flushed');
    } catch (error) {
      logger.error('Error flushing usage tracking reports', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Stop accepting new connections
    httpServer.close(() => {
      logger.info('HTTP server closed');
    });

    // Close WebSocket connections
    io.close(() => {
      logger.info('Socket.IO server closed');
    });

    // Close PostgreSQL client
    try {
      const postgresClient = getPostgresClient();
      await postgresClient.close();
      logger.info('PostgreSQL client closed');
    } catch (error) {
      logger.error('Error closing PostgreSQL client', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Queue cleanup handled by routes (RedisQueue instances will be garbage collected)
    logger.info('Queue connections will be closed automatically');

    // Give ongoing operations 10 seconds to complete
    setTimeout(() => {
      logger.warn('Forcing shutdown after timeout');
      process.exit(0);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Main server initialization
 */
async function main() {
  try {
    logger.info('Starting FileProcessAgent API Gateway...', {
      nodeEnv: config.nodeEnv,
      port: config.port,
      wsPort: config.wsPort,
    });

    // Initialize OpenTelemetry tracing (optional - requires @opentelemetry packages)
    try {
      initTracing();
      logger.info('OpenTelemetry tracing initialized');
    } catch (error) {
      logger.warn('OpenTelemetry tracing disabled (optional dependency not installed)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Initialize PostgreSQL client (connects to database)
    logger.info('Initializing PostgreSQL client...');
    await initPostgresClient();
    const postgresClient = getPostgresClient();
    logger.info('PostgreSQL client initialized');

    // Run database migrations (CRITICAL: Creates fileprocess.processing_jobs table)
    logger.info('Running database migrations...');
    const migrator = new DatabaseMigrator((postgresClient as any).pool);
    await migrator.runMigrations();

    // Verify schema health
    const schemaHealthy = await migrator.verifySchema();
    if (!schemaHealthy) {
      throw new Error('Database schema verification failed - missing required tables');
    }

    const currentVersion = await migrator.getCurrentVersion();
    logger.info(`Database schema ready (version: ${currentVersion || 'initial'})`);

    // Initialize Redis client for JobRepository
    logger.info('Initializing Redis client...');
    const redis = new IORedis(config.redisUrl);
    await redis.ping();
    logger.info('Redis client initialized');

    // Initialize JobRepository (REFACTORED - Single Source of Truth)
    logger.info('Initializing JobRepository...');
    initJobRepository((postgresClient as any).pool, redis);
    logger.info('JobRepository initialized (PostgreSQL + RedisQueue)');

    // Initialize MinIO for universal artifact storage
    logger.info('Initializing MinIO client...');
    await initializeMinIO();
    logger.info('MinIO client initialized (bucket: nexus-artifacts)');

    // Initialize ArtifactRepository for universal file storage
    logger.info('Initializing ArtifactRepository...');
    initArtifactRepository((postgresClient as any).pool);
    logger.info('ArtifactRepository initialized (PostgreSQL + MinIO)');

    // Create Express app
    const app = createExpressApp();

    // Create HTTP server
    const httpServer = new HTTPServer(app);

    // Create Socket.IO server
    const io = createSocketIOServer(httpServer);

    // Make io instance available globally for route handlers
    (global as any).io = io;

    // Start HTTP server
    httpServer.listen(config.port, () => {
      logger.info(`FileProcessAgent API Gateway running`, {
        port: config.port,
        wsPort: config.wsPort,
        env: config.nodeEnv,
        endpoints: {
          rest: `http://localhost:${config.port}`,
          websocket: `ws://localhost:${config.wsPort}`,
          health: `http://localhost:${config.port}/health`,
        },
      });
    });

    // Setup graceful shutdown
    setupGracefulShutdown(httpServer, io);

  } catch (error) {
    logger.error('Failed to start FileProcessAgent API Gateway', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Start server
main();
