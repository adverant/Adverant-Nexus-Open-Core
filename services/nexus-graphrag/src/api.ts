import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GraphRAGWebSocketServer } from './websocket/graphrag-websocket-server';
import { rateLimit } from 'express-rate-limit';
import { GraphRAGStorageEngine } from './storage/storage-engine';
import { SmartRetrievalEngine } from './retrieval/retrieval-engine';
import { UnifiedStorageEngine } from './storage/unified-storage-engine';
import { VoyageAIClient } from './clients/voyage-ai-unified-client';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as neo4j from 'neo4j-driver';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { logger } from './utils/logger';
import { toPostgresArray } from './utils/postgres-helpers';
import { config } from './config';
import { DatabaseInitializer } from './database/init-db';
import { QdrantOptimizer } from './utils/qdrant-optimizer';
import {
  StoreDocumentRequest,
  DocumentMetadata,
  RetrievalOptions
} from './types';
import { GraphitiService } from './episodic/graphiti-service';
import { UnifiedMemoryEngine } from './episodic/unified-memory-engine';
import {
  UnifiedMemoryRouter,
  initializeUnifiedMemoryRouter,
  UnifiedStoreRequest,
  UnifiedStoreResult
} from './storage/unified-memory-router';
import {
  EnhancedRetrievalRequest,
  GraphitiConfig,
  IGraphitiService
} from './episodic/types';
import { EntityManager } from './entities/entity-manager';
import {
  CreateUniversalEntityRequest,
  UpdateUniversalEntityRequest,
  CreateEntityRelationshipRequest,
  UniversalEntityQuery,
  CrossDomainQuery
} from './entities/universal-entity';
import { HybridSearchEngine } from './retrieval/hybrid-search';
import { IngestionOrchestrator } from './ingestion/ingestion-orchestrator';
import { GoogleOAuthManager } from './auth/google-oauth-manager';
import { createAuthRoutes } from './routes/auth-routes';
import { createGDPRRoutes } from './api/gdpr-routes';
import { createBillingRoutes } from './api/billing-routes';
import { createCollaborativeMemoryRoutes } from './api/collaborative-memory-routes';
import { createDataExplorerRoutes } from './api/data-explorer-routes';
import { createRelevanceRoutes } from './api/relevance-routes';
import { createServiceCatalogRoutes } from './api/service-catalog-routes';
import { createDiscoveryAgent, getServiceCatalogRepository, ServiceDiscoveryAgent } from './services/service-catalog/index';
import { extractTenantContext } from './middleware/tenant-context';
import {
  isGraphRAGException,
  getCorrelationId
} from './exceptions';
import { AdvancedSemanticSearchEngine } from './retrieval/advanced-semantic-search';
import { RecommendationsEngine } from './services/recommendations-engine';
import { v4 as uuidv4 } from 'uuid';
import { ingestionMetrics } from './metrics/ingestion-metrics';
import { AdvancedDocumentProcessor } from './processors/advanced/document-processor';
import preprocessDocument from './middleware/document-preprocessor';

// Initialize API
export class GraphRAGAPI {
  private app: express.Application;
  private server: any;
  private wss!: WebSocketServer;
  private graphragWS!: GraphRAGWebSocketServer;
  private storageEngine!: GraphRAGStorageEngine;
  private unifiedStorageEngine!: UnifiedStorageEngine;
  private retrievalEngine!: SmartRetrievalEngine;
  private hybridSearchEngine!: HybridSearchEngine;
  private voyageClient!: VoyageAIClient;
  private qdrantClient!: QdrantClient;
  private neo4jDriver!: neo4j.Driver;
  private redisClient!: Redis;
  private postgresPool!: Pool;
  private graphitiService!: GraphitiService;
  private unifiedMemoryEngine!: UnifiedMemoryEngine;
  private unifiedMemoryRouter!: UnifiedMemoryRouter;
  private entityManager!: EntityManager;
  private advancedSearchEngine!: AdvancedSemanticSearchEngine;
  private recommendationsEngine!: RecommendationsEngine;
  private googleOAuthManager?: GoogleOAuthManager;
  private ingestionOrchestrator!: IngestionOrchestrator;
  private oauthRoutesPlaceholder?: express.Router;
  private gdprRoutesPlaceholder?: express.Router;
  private billingRoutesPlaceholder?: express.Router;
  private collaborativeMemoryRoutesPlaceholder?: express.Router;
  private dataExplorerRoutesPlaceholder?: express.Router;
  private relevanceRoutesPlaceholder?: express.Router;
  private serviceCatalogRoutesPlaceholder?: express.Router;
  private discoveryAgent?: ServiceDiscoveryAgent;
  private advancedProcessor?: AdvancedDocumentProcessor;
  private mageAgentHealthy: boolean = false;

  constructor() {
    this.app = express();
    this.setupMiddleware();
    // Note: initializeServices() is async and will be called in start()
    this.setupRoutes();
    this.setupWebSocket();
  }

  /**
   * Check MageAgent health with exponential backoff retry logic
   * Fixes race condition where GraphRAG starts before MageAgent is ready
   */
  private async checkMageAgentHealthWithRetry(): Promise<boolean> {
    const maxAttempts = 3;
    const delays = [0, 2000, 5000]; // 0s, 2s, 5s exponential backoff

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`Retrying MageAgent health check (attempt ${attempt + 1}/${maxAttempts})...`);
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }

        const mageResponse = await fetch('http://nexus-mageagent:8080/health', {
          signal: AbortSignal.timeout(5000)
        });

        if (mageResponse.ok) {
          logger.info('MageAgent health check successful', {
            attempt: attempt + 1,
            status: mageResponse.status,
            message: 'Orchestration features enabled'
          });
          return true;
        }

        logger.warn(`MageAgent health check returned non-OK status`, {
          attempt: attempt + 1,
          status: mageResponse.status,
          statusText: mageResponse.statusText
        });

      } catch (error: any) {
        logger.warn(`MageAgent health check failed`, {
          attempt: attempt + 1,
          maxAttempts,
          error: error.message,
          willRetry: attempt < maxAttempts - 1
        });
      }
    }

    logger.warn(
      'MageAgent service unavailable after 3 attempts - orchestration features will be disabled.\n' +
      'GraphRAG will continue operating normally. Orchestration features will auto-enable when MageAgent becomes healthy.'
    );
    return false;
  }

  /**
   * Start periodic health check to re-enable proxy if MageAgent becomes healthy
   * Checks every 60 seconds to recover from initialization race conditions
   */
  private startPeriodicMageAgentHealthCheck(): void {
    setInterval(async () => {
      // Only check if currently unhealthy (avoid unnecessary calls)
      if (!this.mageAgentHealthy) {
        try {
          const mageResponse = await fetch('http://nexus-mageagent:8080/health', {
            signal: AbortSignal.timeout(3000)
          });

          if (mageResponse.ok && !this.mageAgentHealthy) {
            this.mageAgentHealthy = true;
            logger.info('MageAgent service recovered - orchestration features now enabled');
          }
        } catch (error: any) {
          // Silent failure - we'll try again in 60s
          logger.debug('Periodic MageAgent health check failed (will retry)', {
            error: error.message
          });
        }
      }
    }, 60000); // Check every 60 seconds
  }

  /**
   * Map database errors to HTTP responses with appropriate status codes
   *
   * Provides comprehensive error handling following REST API best practices:
   * - 400 Bad Request: Validation errors
   * - 404 Not Found: Entity not found
   * - 409 Conflict: Constraint violations (UNIQUE, FK, CHECK)
   * - 503 Service Unavailable: Connection errors
   * - 500 Internal Server Error: Generic database errors
   *
   * @param error - Database error from entity-manager or storage layer
   * @param res - Express response object
   * @param defaultMessage - Fallback error message
   */
  private handleDatabaseError(error: any, res: Response, defaultMessage: string) {
    // InsufficientChunksError → 400 Bad Request with helpful suggestions
    if (error.name === 'InsufficientChunksError' || error.code === 'INSUFFICIENT_CHUNKS') {
      return res.status(400).json({
        error: {
          message: 'Document chunking failed',
          code: 'CHUNKING_FAILED',
          details: error.message,
          suggestion: 'For better preprocessing and chunking, use nexus_store_document MCP tool',
          alternatives: [
            'Use nexus_store_document MCP tool for automatic format detection and preprocessing',
            'Split content into smaller sections (< 10KB each)',
            'Break content at natural boundaries (headers, paragraphs)',
            'For PDFs/DOCX: Use nexus_store_document which handles these formats natively',
            'For large documents: Use POST /api/documents/ingest-url with file-based ingestion'
          ],
          documentInfo: {
            documentId: error.documentId,
            chunksProduced: error.chunkCount,
            minimumRequired: error.minimumRequired
          }
        }
      });
      return;
    }

    // ValidationError → 400 Bad Request
    // Check both error.name and error.code for reliability
    if (error.name === 'ValidationError' || error.code === 'VALIDATION_ERROR') {
      return res.status(400).json({
        error: {
          message: error.message,
          code: error.code || 'VALIDATION_ERROR',
          details: error.details
        }
      });
      return;
    }

    // EntityNotFoundError → 404 Not Found
    if (error.name === 'EntityNotFoundError' || error.code === 'ENTITY_NOT_FOUND') {
      return res.status(404).json({
        error: {
          message: error.message,
          code: error.code || 'ENTITY_NOT_FOUND',
          details: error.details
        }
      });
      return;
    }

    // ConstraintViolationError → 409 Conflict
    if (error.name === 'ConstraintViolationError' || error.code === 'CONSTRAINT_VIOLATION') {
      return res.status(409).json({
        error: {
          message: error.message,
          code: error.code || 'CONSTRAINT_VIOLATION',
          constraint: error.constraint,
          column: error.column,
          value: error.value,
          details: error.details
        }
      });
      return;
    }

    // ConnectionError → 503 Service Unavailable
    if (error.name === 'ConnectionError' || error.code === 'CONNECTION_ERROR') {
      return res.status(503).json({
        error: {
          message: error.message,
          code: error.code || 'CONNECTION_ERROR',
          details: error.details
        }
      });
      return;
    }

    // Generic DatabaseError or unknown error → 500 Internal Server Error
    logger.error(defaultMessage, { error, code: error.code, details: error.details });
    return res.status(500).json({
      error: {
        message: error.message || defaultMessage,
        code: error.code || 'DATABASE_ERROR',
        details: error.details
      }
    });
  }

  private setupMiddleware() {
    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: false, // Allow VS Code extension connections
      crossOriginEmbedderPolicy: false
    }));

    // CORS configuration for VS Code extension
    this.app.use(cors({
      origin: config.corsOrigins || [
        'vscode-webview://*',
        'http://localhost:*',
        'https://localhost:*',
        'https://dashboard.adverant.ai',
        'https://adverant.ai',
        /^vscode-resource:/
      ],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Company-ID', 'X-App-ID', 'X-User-ID']
    }));

    // Body parsing
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // Compression
    this.app.use(compression());

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info('Request processed', {
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration
        });
      });
      return next();
    });

    // Rate limiting with JSON response format
    const limiter = rateLimit({
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 2000, // limit each IP to 2000 requests per minute (increased for testing)

      // Custom handler to return JSON instead of plain text
      handler: (req: Request, res: Response) => {
        return res.status(429).json({
          error: {
            message: 'Too many requests',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: Math.ceil((req.rateLimit?.resetTime?.getTime() ?? Date.now()) / 1000),
            limit: req.rateLimit?.limit,
            current: req.rateLimit?.current,
            remaining: req.rateLimit?.remaining
          }
        });
      },

      // Skip rate limiting for health check endpoints and localhost testing
      skip: (req: Request) => {
        const isHealthCheck = req.path === '/health' || req.path === '/graphrag/api/health';
        const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
        return isHealthCheck || isLocalhost;
      },

      standardHeaders: true, // Return rate limit info in headers
      legacyHeaders: false // Disable X-RateLimit-* headers
    });
    this.app.use('/graphrag/api/', limiter);

    // Response transformation middleware - Add camelCase aliases for MCP compatibility
    // This ensures both snake_case (GraphRAG convention) and camelCase (MCP/JavaScript convention) are available
    this.app.use((_req, res, next) => {
      const originalJson = res.json.bind(res);

      res.json = function(data: any) {
        // Add camelCase aliases to common snake_case fields
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          // Episode IDs
          if (data.episode_id && !data.episodeId) {
            data.episodeId = data.episode_id;
          }
          // Entity IDs
          if (data.entity_id && !data.entityId) {
            data.entityId = data.entity_id;
          }
          // Document IDs
          if (data.document_id && !data.documentId) {
            data.documentId = data.document_id;
          }
          // Memory IDs
          if (data.memory_id && !data.memoryId) {
            data.memoryId = data.memory_id;
          }
          // Add 'results' alias if response has 'content' or 'chunks'
          if (!data.results && (data.content || data.chunks)) {
            data.results = data.content || data.chunks;
          }
          // Add 'memories' alias if response has 'results' array of memory-type items
          if (!data.memories && Array.isArray(data.results) && data.results.some((r: any) => r.type === 'memory')) {
            data.memories = data.results;
          }
        }

        return originalJson(data);
      };

      return next();
    });

    // Error handling middleware
    this.app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
      logger.error('Unhandled error', {
        error: err,
        url: req.url,
        method: req.method,
        body: req.body
      });

      return res.status(err.status || 500).json({
        error: {
          message: err.message || 'Internal server error',
          code: err.code || 'INTERNAL_ERROR',
          details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }
      });
    });
  }

  private async initializeServices() {
    // Initialize clients - VoyageAI is required for core functionality
    if (!config.voyageAI.apiKey) {
      throw new Error('VoyageAI API key is required for GraphRAG service');
    }

    this.voyageClient = new VoyageAIClient(config.voyageAI.apiKey);

    // PHASE 2.1: Runtime API key verification
    // Verify API key works and discover available models before service accepts traffic
    logger.info('[PHASE2.1-STARTUP] Verifying Voyage AI API key and discovering models...');
    try {
      const connectionResults = await this.voyageClient.testConnection();
      const workingModels = Object.entries(connectionResults)
        .filter(([_, works]) => works)
        .map(([modelId]) => modelId);
      const failedModels = Object.entries(connectionResults)
        .filter(([_, works]) => !works)
        .map(([modelId]) => modelId);

      if (workingModels.length === 0) {
        throw new Error(
          'Voyage AI API key verification failed: No models accessible. ' +
          'Check API key validity and network connectivity to Voyage AI.'
        );
      }

      logger.info('[PHASE2.1-STARTUP] ✅ Voyage AI connection verified', {
        workingModels,
        failedModels: failedModels.length > 0 ? failedModels : undefined,
        totalModels: Object.keys(connectionResults).length,
        timestamp: new Date().toISOString()
      });
    } catch (error: any) {
      logger.error('[PHASE2.1-STARTUP] ❌ Voyage AI connection test failed', {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw new Error(
        `Failed to verify Voyage AI connection: ${error.message}. ` +
        'GraphRAG cannot start without working embeddings. ' +
        'Verify VOYAGE_API_KEY is valid and https://api.voyageai.com is accessible.'
      );
    }

    this.qdrantClient = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey
    });

    // Only create Neo4j driver if not skipped
    if (process.env.SKIP_NEO4J !== 'true') {
      this.neo4jDriver = neo4j.driver(
        config.neo4j.uri,
        neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
      );
    } else {
      this.neo4jDriver = null as any; // Skip Neo4j initialization
      logger.warn('Neo4j driver skipped - episodic memory features disabled');
    }

    this.redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      retryStrategy: (times) => Math.min(times * 50, 2000)
    });

    this.postgresPool = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: 20
    });

    // Initialize engines
    this.storageEngine = new GraphRAGStorageEngine();
    
    this.unifiedStorageEngine = new UnifiedStorageEngine({
      voyageClient: this.voyageClient,
      qdrantClient: this.qdrantClient,
      neo4jDriver: this.neo4jDriver,
      postgresPool: this.postgresPool,
      redisCache: this.redisClient
    });
    
    this.retrievalEngine = new SmartRetrievalEngine({
      voyageClient: this.voyageClient,
      qdrantClient: this.qdrantClient,
      neo4jDriver: this.neo4jDriver,
      redisCache: this.redisClient,
      postgresPool: this.postgresPool
    } as any);

    // Initialize hybrid search engine for /api/search endpoint
    this.hybridSearchEngine = new HybridSearchEngine({
      voyageClient: this.voyageClient,
      qdrantClient: this.qdrantClient,
      postgresPool: this.postgresPool,
      redisCache: this.redisClient
    });

    // Initialize Phase 4: Advanced Features
    // Advanced semantic search with query expansion and re-ranking
    this.advancedSearchEngine = new AdvancedSemanticSearchEngine(
      this.postgresPool,
      this.qdrantClient,
      this.redisClient,
      this.voyageClient,
      this.hybridSearchEngine
    );

    // Recommendations engine for personalized content suggestions
    this.recommendationsEngine = new RecommendationsEngine(
      this.postgresPool,
      this.qdrantClient,
      this.redisClient
    );

    // Initialize Graphiti episodic memory services
    const graphitiConfig: GraphitiConfig = {
      enabled: process.env.GRAPHITI_ENABLED === 'true',
      neo4j: {
        uri: config.neo4j.uri,
        username: config.neo4j.user,
        password: config.neo4j.password,
        database: config.neo4j.database || 'neo4j'
      },
      embedding: {
        model: 'voyage-3',
        dimensions: 1024,
        api_key: config.voyageAI.apiKey
      },
      memory: {
        max_episodes: parseInt(process.env.MAX_EPISODES || '10000'),
        decay_interval_hours: parseInt(process.env.DECAY_INTERVAL_HOURS || '24'),
        importance_threshold: parseFloat(process.env.IMPORTANCE_THRESHOLD || '0.3'),
        auto_consolidation: process.env.AUTO_CONSOLIDATION === 'true'
      },
      entity_resolution: {
        similarity_threshold: parseFloat(process.env.ENTITY_SIMILARITY_THRESHOLD || '0.85'),
        merge_strategy: (process.env.ENTITY_MERGE_STRATEGY || 'conservative') as 'conservative' | 'aggressive' | 'manual'
      }
    };

    // Pass Redis client to enable embedding cache (saves ~150ms per duplicate content)
    this.graphitiService = new GraphitiService(graphitiConfig, this.voyageClient, this.redisClient);

    this.unifiedMemoryEngine = new UnifiedMemoryEngine(
      this.graphitiService as IGraphitiService,
      this.unifiedStorageEngine,
      {
        episodic_weight: parseFloat(process.env.EPISODIC_WEIGHT || '0.5'),
        temporal_decay: process.env.TEMPORAL_DECAY === 'true',
        max_context_tokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '4000'),
        auto_store_interactions: process.env.AUTO_STORE_INTERACTIONS === 'true',
        consolidation_interval_hours: parseInt(process.env.CONSOLIDATION_INTERVAL_HOURS || '24')
      }
    );

    // Initialize Unified Memory Router - THE SINGLE ENTRY POINT for all memory storage
    // This bridges UnifiedStorageEngine and GraphitiService with intelligent triage
    this.unifiedMemoryRouter = initializeUnifiedMemoryRouter(
      this.unifiedStorageEngine,
      this.graphitiService,
      process.env.ANTHROPIC_API_KEY
    );
    logger.info('UnifiedMemoryRouter initialized - all memory storage now goes through unified pipeline');

    // Initialize Entity Manager for universal entity system
    this.entityManager = new EntityManager(this.postgresPool);

    // Initialize Google OAuth Manager if Google Drive is enabled
    if (config.googleDrive?.enabled) {
      this.googleOAuthManager = new GoogleOAuthManager({
        clientId: config.googleDrive.clientId,
        clientSecret: config.googleDrive.clientSecret,
        redirectUri: config.googleDrive.redirectUri,
        redisClient: this.redisClient,
        pgPool: this.postgresPool // Add PostgreSQL pool for permanent token storage
      });

      logger.info('Google OAuth Manager initialized');
    }

    // Initialize URL Ingestion Orchestrator
    this.ingestionOrchestrator = new IngestionOrchestrator({
      redisConnection: this.redisClient,
      storageEngine: this.storageEngine,
      googleDriveConfig: config.googleDrive?.enabled ? {
        clientId: config.googleDrive.clientId,
        clientSecret: config.googleDrive.clientSecret,
        redirectUri: config.googleDrive.redirectUri,
        apiKey: config.googleDrive.apiKey
      } : undefined,
      googleOAuthManager: this.googleOAuthManager, // Pass OAuth manager for authenticated Google Drive access
      httpProviderConfig: {
        timeout: 30000,
        maxFileSize: 100 * 1024 * 1024, // 100MB
        maxRetries: 3
      },
      websocketServerUrl: `http://localhost:${config.port || 8090}`
    });

    logger.info('Ingestion orchestrator initialized');

    // Initialize AdvancedDocumentProcessor for Docling and OCR cascade
    try {
      this.advancedProcessor = new AdvancedDocumentProcessor(
        this.storageEngine,
        process.env.OPENROUTER_API_KEY,
        config.voyageAI.apiKey
      );
      logger.info('Advanced document processor initialized with Docling and OCR cascade');
    } catch (error) {
      logger.warn('Advanced document processor initialization failed - advanced features disabled', { error });
      // Continue without advanced processing - basic document processing still works
    }

    // Check MageAgent service availability with retry logic
    // CRITICAL FIX: Implement exponential backoff to handle initialization race condition
    this.mageAgentHealthy = await this.checkMageAgentHealthWithRetry();

    // Start periodic health check to re-enable proxy if MageAgent becomes healthy
    this.startPeriodicMageAgentHealthCheck();

    // Optimize Qdrant collections for proper indexing
    try {
      const qdrantOptimizer = new QdrantOptimizer(this.qdrantClient);

      // Optimize the unified_content collection
      await qdrantOptimizer.optimizeCollection('unified_content', {
        forceIndexing: true,
        indexingThreshold: 100,  // Index with as few as 100 vectors
        fullScanThreshold: 100,  // Use index for searches above 100 vectors
        segmentNumber: 1,        // Single segment for small collections
        recreateIfNeeded: false  // Don't recreate, just optimize
      });

      // Get diagnostics to verify indexing
      const diagnostics = await qdrantOptimizer.getCollectionDiagnostics('unified_content');
      logger.info('Qdrant collection optimized', {
        collection: 'unified_content',
        points: diagnostics.points_count,
        indexed: diagnostics.indexed_vectors_count,
        indexing_ratio: diagnostics.indexing_ratio,
        status: diagnostics.status
      });

    } catch (error) {
      // Don't fail initialization if optimization fails, just log the error
      logger.error('Failed to optimize Qdrant collection', { error });
      logger.warn('Vector search may not function properly until collection is properly indexed');
    }

    logger.info('All services initialized including Graphiti episodic memory');
  }

  private setupRoutes() {
    // Tenant + User context validation for all /graphrag/api routes (Phase 2)
    // This is Layer 1 of our defense-in-depth security architecture
    this.app.use('/graphrag/api/*', (req: Request, res: Response, next: NextFunction) => {
      // Skip for health, metrics, and diagnostics endpoints
      // NOTE: req.path is relative to the mount point, so it doesn't include '/graphrag/api' prefix
      if (req.path === '/health' ||
          req.path.startsWith('/health/') ||
          req.path.startsWith('/metrics/') ||
          req.path.startsWith('/diagnostics/')) {
        return next();
      }

      // Apply tenant context validation middleware
      return extractTenantContext(req, res, next);
    });

    // Tenant context validation for /api/* routes (for external gateway access)
    // This handles requests that come through Istio without the /graphrag prefix
    this.app.use('/api/*', (req: Request, res: Response, next: NextFunction) => {
      // Skip for health endpoints
      if (req.path === '/health' || req.path.startsWith('/health/')) {
        return next();
      }

      // Apply tenant context validation middleware
      return extractTenantContext(req, res, next);
    });

    // Health check - Fixed path and structure
    this.app.get('/health', async (_req: Request, res: Response) => {
      try {
        // Check all services (Neo4j is optional)
        const serviceChecks = [
          this.postgresPool.query('SELECT 1'),
          this.redisClient.ping(),
          this.neo4jDriver ? this.neo4jDriver.verifyConnectivity() : Promise.resolve(null),
          this.qdrantClient.getCollections()
        ];

        const checks = await Promise.allSettled(serviceChecks);

        // PHASE 5.1: Include Voyage AI health check
        let voyageStatus = { status: 'unknown' as const, message: 'Not checked' };
        try {
          const { getVoyageHealthChecker } = await import('./health/voyage-health.js');
          const checker = getVoyageHealthChecker();
          voyageStatus = await checker.quickCheck();
        } catch (error) {
          voyageStatus = { status: 'error', message: error instanceof Error ? error.message : 'Failed to check' };
        }

        const allHealthy = checks.every(c => c.status === 'fulfilled') && voyageStatus.status === 'ok';
        const anyFailed = checks.some(c => c.status === 'rejected') || voyageStatus.status === 'error';

        const health = {
          status: allHealthy ? 'healthy' : (anyFailed ? 'degraded' : 'degraded'),
          timestamp: new Date().toISOString(),
          services: {
            api: true, // Added required api field
            PostgreSQL: checks[0].status === 'fulfilled',
            Redis: checks[1].status === 'fulfilled',
            Neo4j: this.neo4jDriver ? checks[2].status === 'fulfilled' : false,
            Qdrant: checks[3].status === 'fulfilled',
            VoyageAI: voyageStatus.status === 'ok',
            postgres: checks[0].status === 'fulfilled',
            redis: checks[1].status === 'fulfilled',
            neo4j: this.neo4jDriver ? checks[2].status === 'fulfilled' : false,
            qdrant: checks[3].status === 'fulfilled',
            voyageAI: voyageStatus.status === 'ok'
          },
          features: {
            documents: true,
            memories: true,
            unifiedSearch: true,
            embeddings: voyageStatus.status === 'ok'
          }
        };

        return res.status(health.status === 'healthy' ? 200 : 503).json(health);
      } catch (error) {
        return res.status(503).json({
          status: 'unhealthy',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Add /api/health endpoint (duplicate for compatibility)
    this.app.get('/graphrag/api/health', async (_req: Request, res: Response) => {
      try {
        const serviceChecks = [
          this.postgresPool.query('SELECT 1'),
          this.redisClient.ping(),
          this.neo4jDriver ? this.neo4jDriver.verifyConnectivity() : Promise.resolve(null),
          this.qdrantClient.getCollections()
        ];

        const checks = await Promise.allSettled(serviceChecks);

        const health = {
          status: checks.every(c => c.status === 'fulfilled') ? 'healthy' : 'degraded',
          timestamp: new Date().toISOString(),
          services: {
            api: true,
            PostgreSQL: checks[0].status === 'fulfilled',
            Redis: checks[1].status === 'fulfilled',
            Neo4j: this.neo4jDriver ? checks[2].status === 'fulfilled' : false,
            Qdrant: checks[3].status === 'fulfilled'
          }
        };

        return res.status(health.status === 'healthy' ? 200 : 503).json(health);
      } catch (error) {
        return res.status(503).json({
          status: 'unhealthy',
          services: {
            api: false,
            PostgreSQL: false,
            Redis: false,
            Neo4j: false,
            Qdrant: false
          },
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // ========== VOYAGE AI HEALTH ENDPOINTS ==========

    /**
     * Voyage AI Quick Health Check
     * GET /graphrag/api/health/voyage
     *
     * Fast health check for Voyage AI integration.
     * Returns minimal status with circuit breaker state.
     */
    this.app.get('/graphrag/api/health/voyage', async (_req: Request, res: Response) => {
      try {
        const { getVoyageHealthChecker } = await import('./health/voyage-health.js');
        const checker = getVoyageHealthChecker();
        const result = await checker.quickCheck();

        return res.status(result.status === 'ok' ? 200 : 503).json({
          service: 'voyage-ai',
          ...result,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('[PHASE5.1-HEALTH] Voyage AI quick health check failed', { error });
        return res.status(503).json({
          service: 'voyage-ai',
          status: 'error',
          message: error instanceof Error ? error.message : 'Health check failed',
          timestamp: new Date().toISOString()
        });
      }
    });

    /**
     * Voyage AI Comprehensive Health Check
     * GET /graphrag/api/health/voyage/detailed
     *
     * Comprehensive health check with detailed status:
     * - API connectivity and latency
     * - Circuit breaker state and stats
     * - Model availability
     * - Configuration validation
     * - Metrics summary
     *
     * Query params:
     * - testModels: boolean - Include individual model tests (slower)
     * - timeout: number - Timeout in milliseconds (default: 10000)
     */
    this.app.get('/graphrag/api/health/voyage/detailed', async (req: Request, res: Response) => {
      try {
        const { getVoyageHealthChecker } = await import('./health/voyage-health.js');
        const checker = getVoyageHealthChecker();

        const includeModelTest = req.query.testModels === 'true';
        const timeout = parseInt(req.query.timeout as string) || 10000;

        const result = await checker.check({
          includeModelTest,
          timeout: Math.min(timeout, 30000) // Cap at 30 seconds
        });

        const statusCode = result.status === 'healthy' ? 200 : (result.status === 'degraded' ? 200 : 503);

        return res.status(statusCode).json(result);
      } catch (error) {
        logger.error('[PHASE5.1-HEALTH] Voyage AI detailed health check failed', { error });
        return res.status(503).json({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          responseTimeMs: 0,
          details: {
            apiConnectivity: {
              status: 'error',
              error: error instanceof Error ? error.message : 'Health check failed'
            }
          }
        });
      }
    });

    /**
     * Voyage AI Metrics Endpoint
     * GET /graphrag/api/metrics/voyage
     *
     * Returns Prometheus-formatted metrics for Voyage AI integration.
     */
    this.app.get('/graphrag/api/metrics/voyage', async (_req: Request, res: Response) => {
      try {
        const { getVoyageMetrics } = await import('./metrics/voyage-metrics.js');
        const metrics = getVoyageMetrics();
        const metricsText = await metrics.getMetrics();

        res.set('Content-Type', 'text/plain; charset=utf-8');
        return res.status(200).send(metricsText);
      } catch (error) {
        logger.error('[PHASE5.1-HEALTH] Voyage AI metrics endpoint failed', { error });
        return res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to get metrics'
        });
      }
    });

    // ========== DIAGNOSTICS ENDPOINTS ==========

    /**
     * Quick Health Check
     * GET /api/diagnostics/quick
     *
     * Fast health check with minimal overhead.
     * Returns essential service status.
     */
    this.app.get('/graphrag/api/diagnostics/quick', async (_req: Request, res: Response) => {
      try {
        const { SystemVerifier } = await import('./diagnostics/system-verifier.js');
        const verifier = new SystemVerifier({
          postgresPool: this.postgresPool,
          qdrantClient: this.qdrantClient,
          neo4jDriver: this.neo4jDriver,
          redisClient: this.redisClient
        });

        const result = await verifier.quickHealthCheck();
        const statusCode = result.status === 'healthy' ? 200 : (result.status === 'degraded' ? 503 : 503);

        return res.status(statusCode).json(result);
      } catch (error) {
        logger.error('Quick health check failed', { error: (error as Error).message });
        return res.status(500).json({
          status: 'unhealthy',
          error: (error as Error).message
        });
      }
    });

    /**
     * Full System Diagnostics
     * GET /api/diagnostics/full
     *
     * Comprehensive system verification report.
     * Checks all databases, storage systems, vector indexes, and relationships.
     *
     * Returns:
     * - Overall system health status
     * - Database connection status
     * - Document/memory/entity storage metrics
     * - Neo4j relationship counts
     * - Vector index health
     * - Ingestion pipeline metrics
     * - Detected issues and recommendations
     */
    this.app.get('/graphrag/api/diagnostics/full', async (_req: Request, res: Response) => {
      try {
        logger.info('Running full system diagnostics');

        const { SystemVerifier } = await import('./diagnostics/system-verifier.js');
        const verifier = new SystemVerifier({
          postgresPool: this.postgresPool,
          qdrantClient: this.qdrantClient,
          neo4jDriver: this.neo4jDriver,
          redisClient: this.redisClient
        });

        const report = await verifier.runFullDiagnostics();

        const statusCode = report.overallStatus === 'healthy' ? 200 :
                          (report.overallStatus === 'degraded' ? 200 : 503);

        return res.status(statusCode).json(report);
      } catch (error) {
        logger.error('Full diagnostics failed', {
          error: (error as Error).message,
          stack: (error as Error).stack
        });

        return res.status(500).json({
          error: {
            message: 'Diagnostics failed: ' + (error as Error).message,
            code: 'DIAGNOSTICS_ERROR'
          }
        });
      }
    });

    /**
     * Storage Metrics Endpoint
     * GET /api/diagnostics/storage
     *
     * Returns detailed storage metrics for documents, memories, and entities.
     */
    this.app.get('/graphrag/api/diagnostics/storage', async (_req: Request, res: Response) => {
      try {
        const { SystemVerifier } = await import('./diagnostics/system-verifier.js');
        const verifier = new SystemVerifier({
          postgresPool: this.postgresPool,
          qdrantClient: this.qdrantClient,
          neo4jDriver: this.neo4jDriver,
          redisClient: this.redisClient
        });

        const fullReport = await verifier.runFullDiagnostics();

        return res.json({
          timestamp: fullReport.timestamp,
          storage: fullReport.storage
        });
      } catch (error) {
        logger.error('Storage metrics failed', { error: (error as Error).message });
        return res.status(500).json({
          error: {
            message: (error as Error).message,
            code: 'STORAGE_METRICS_ERROR'
          }
        });
      }
    });

    /**
     * Vector Index Health Endpoint
     * GET /api/diagnostics/vectors
     *
     * Returns health status of all Qdrant vector collections.
     */
    this.app.get('/graphrag/api/diagnostics/vectors', async (_req: Request, res: Response) => {
      try {
        const { SystemVerifier } = await import('./diagnostics/system-verifier.js');
        const verifier = new SystemVerifier({
          postgresPool: this.postgresPool,
          qdrantClient: this.qdrantClient,
          neo4jDriver: this.neo4jDriver,
          redisClient: this.redisClient
        });

        const fullReport = await verifier.runFullDiagnostics();

        return res.json({
          timestamp: fullReport.timestamp,
          vectorIndexes: fullReport.vectorIndexes
        });
      } catch (error) {
        logger.error('Vector index health check failed', { error: (error as Error).message });
        return res.status(500).json({
          error: {
            message: (error as Error).message,
            code: 'VECTOR_HEALTH_ERROR'
          }
        });
      }
    });

    // ========== MEMORY ENDPOINTS - ALL LEGACY REMOVED ==========
    // REMOVED: All legacy memory endpoints - use /api/v2/memory and /api/retrieve/enhanced ONLY
    // Deleted: POST /graphrag/api/memory (use /api/v2/memory)
    // Deleted: GET/POST /graphrag/api/memory/list (use /api/retrieve/enhanced)
    // Deleted: GET /graphrag/api/memory/stats
    // Deleted: GET /graphrag/api/memory/:id
    // Deleted: GET /graphrag/api/memory
    // Deleted: POST /graphrag/api/memory/recall (use /api/retrieve/enhanced)

    // ========== DOCUMENT ENDPOINTS (original GraphRAG) ==========

    // DEPRECATED: Legacy endpoint - redirect to proper API path
    // This endpoint had middleware conflicts causing JSON parsing errors
    // All document operations should use /graphrag/api/documents
    this.app.post('/documents',
      async (_req: Request, res: Response, _next: NextFunction) => {
        // Redirect to the correct endpoint
        return res.status(301).json({
          error: 'ENDPOINT_MOVED',
          message: 'This endpoint has been deprecated. Please use POST /graphrag/api/documents instead',
          newEndpoint: '/graphrag/api/documents'
        });
      }
    );

    // REMOVED: Legacy document upload with conflicting middleware
    // The code below caused JSON parsing errors due to express.raw() middleware conflict
    // Functionality moved to /graphrag/api/documents endpoint
    /*
    this.app.post('/documents-legacy-removed',
      express.raw({ type: 'application/octet-stream', limit: '50mb' }), // Get raw buffer - THIS CAUSED THE CONFLICT
      async (req: Request, res: Response, _next: NextFunction) => {
        try {
          const tenantContext = req.tenantContext!;
          const contentType = req.headers['content-type'] || '';
          let content: string;
          let metadata: any = {};

          // Parse based on content type
          if (contentType.includes('application/json')) {
            // Parse JSON from buffer or object
            let parsed: any;
            if (typeof req.body === 'string') {
              parsed = JSON.parse(req.body);
            } else if (Buffer.isBuffer(req.body)) {
              const bodyStr = req.body.toString('utf-8');
              parsed = JSON.parse(bodyStr);
            } else {
              // Already parsed by body-parser middleware
              parsed = req.body;
            }
            content = parsed.content;
            metadata = parsed.metadata || {};
          } else {
            // Treat as plain text
            content = req.body.toString('utf-8');
            metadata = {
              title: `Document ${Date.now()}`,
              type: 'text',
              format: 'plain'
            };
          }

          if (!content) {
            return res.status(400).json({ error: 'Content is required' });
          }

          // Auto-generate title if not provided
          if (!metadata.title) {
            const firstLine = content.split('\n')[0];
            metadata.title = firstLine.length > 50
              ? firstLine.substring(0, 47) + '...'
              : firstLine || 'Untitled Document';
          }

          // Validate title is present
          if (!metadata.title) {
            return res.status(400).json({ error: 'Title is required in metadata' });
          }

          const result = await this.storageEngine.storeDocument(content, metadata);

          // Create chunks immediately after storing
          await this.createDocumentChunks(result.documentId, content);

          return res.status(201).json({
            success: true,
            documentId: result.documentId,
            message: 'Document stored successfully'
          });
        } catch (error) {
          return _next(error);
        }
      }
    );
    */

    // List documents with pagination and filtering
    this.app.get('/documents', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const tags = req.query.tags ? (req.query.tags as string).split(',') : null;
        const offset = (page - 1) * limit;

        const client = await this.postgresPool.connect();
        try {
          let query = `
            SELECT d.*
            FROM graphrag.documents d
          `;

          const params: any[] = [];
          let whereConditions: string[] = [];

          if (tags && tags.length > 0) {
            whereConditions.push(`d.tags && $${params.length + 1}::text[]`);
            params.push(toPostgresArray(tags)); // Convert JS array for PostgreSQL array overlap operator
          }

          if (whereConditions.length > 0) {
            query += ' WHERE ' + whereConditions.join(' AND ');
          }

          query += ` ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
          params.push(limit, offset);

          const result = await client.query(query, params);

          const countQuery = `SELECT COUNT(*) as total FROM graphrag.documents d ${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}`;
          const countResult = await client.query(countQuery, tags ? [toPostgresArray(tags)] : []);
          const total = parseInt(countResult.rows[0].total);

          return res.json({
            documents: result.rows,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
          });
        } finally {
          client.release();
        }
      } catch (error) {
        return _next(error);
      }
    });

    // Batch upload endpoint
    this.app.post('/documents/batch', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        req.tenantContext!;
        const { documents } = req.body;

        if (!Array.isArray(documents)) {
          return res.status(400).json({ error: 'Documents array is required' });
        }

        const results = [];
        let uploaded = 0;

        for (const doc of documents) {
          try {
            // Ensure metadata has required fields
            const metadata = doc.metadata || {};
            if (!metadata.title) {
              // Auto-generate title from content if missing
              const firstLine = doc.content.split('\n')[0];
              metadata.title = firstLine.length > 50
                ? firstLine.substring(0, 47) + '...'
                : firstLine || 'Untitled Document';
            }

            const result = await this.storageEngine.storeDocument(doc.content, metadata);
            await this.createDocumentChunks(result.documentId, doc.content);
            results.push({ documentId: result.documentId, success: true });
            uploaded++;
          } catch (error) {
            results.push({ error: error instanceof Error ? error.message : 'Unknown error', success: false });
          }
        }

        return res.json({
          success: true,
          uploaded,
          total: documents.length,
          results
        });
      } catch (error) {
        return _next(error);
      }
    });

    /**
     * GET /documents/:id/chunks
     *
     * Retrieve all chunks for a specific document from Qdrant.
     * Returns chunk text, metadata, and embeddings.
     *
     * Use cases:
     * - Viewing document breakdown/structure
     * - Debugging chunk quality
     * - Analyzing how a document was chunked
     *
     * For semantic search across all documents, use POST /api/retrieve instead.
     */
    this.app.get('/documents/:id/chunks', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;
        const { includeEmbeddings = false } = req.query;

        // Query Qdrant directly via HTTP to bypass client library issues
        const axios = (await import('axios')).default;
        const qdrantResponse = await axios.post(`${config.qdrant.url}/collections/chunks/points/scroll`, {
          filter: {
            must: [
              {
                key: 'document_id',
                match: { value: id }
              }
            ]
          },
          limit: 1000,
          with_payload: true,
          with_vector: includeEmbeddings === 'true'
        });

        const result = { points: qdrantResponse.data.result.points };

        const chunks = result.points.map((point: any) => {
          const payload = point.payload || {};
          return {
            id: point.id,
            document_id: payload.document_id,
            position: payload.position,
            content: payload.content,
            tokens: payload.tokens,
            type: payload.type,
            summary: payload.summary,
            metadata: payload.metadata,
            embedding: includeEmbeddings === 'true' ? point.vector : undefined
          };
        });

        // Sort by position
        chunks.sort((a: any, b: any) => (a.position?.start || 0) - (b.position?.start || 0));

        return res.json({
          documentId: id,
          chunks,
          count: chunks.length,
          totalTokens: chunks.reduce((sum: number, c: any) => sum + (c.tokens || 0), 0)
        });
      } catch (error) {
        logger.error('Failed to retrieve document chunks', {
          documentId: req.params.id,
          error: (error as Error).message
        });
        return _next(error);
      }
    });

    /**
     * GET /chunks/:chunkId
     *
     * Retrieve a single chunk by ID from Qdrant.
     * Returns chunk content, metadata, and optionally the embedding vector.
     *
     * Query params:
     * - includeEmbedding: Set to 'true' to include the 1024-dimensional vector
     *
     * Use cases:
     * - Inspecting specific chunk content
     * - Debugging retrieval results
     * - Analyzing chunk quality
     */
    this.app.get('/chunks/:chunkId', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { chunkId } = req.params;
        const { includeEmbedding = false } = req.query;

        // Retrieve chunk from Qdrant via HTTP for consistency with document chunks endpoint
        const axios = (await import('axios')).default;
        const qdrantResponse = await axios.post(`${config.qdrant.url}/collections/chunks/points`, {
          ids: [chunkId],
          with_payload: true,
          with_vector: includeEmbedding === 'true'
        });

        const points = qdrantResponse.data.result;

        if (!points || points.length === 0) {
          return res.status(404).json({
            error: {
              message: 'Chunk not found',
              code: 'CHUNK_NOT_FOUND',
              chunkId
            }
          });
        }

        const point = points[0];
        const payload = point.payload || {};

        return res.json({
          id: point.id,
          document_id: payload.document_id,
          position: payload.position,
          content: payload.content,
          tokens: payload.tokens,
          type: payload.type,
          summary: payload.summary,
          metadata: payload.metadata,
          embedding: includeEmbedding === 'true' ? point.vector : undefined
        });
      } catch (error) {
        logger.error('Failed to retrieve chunk', {
          chunkId: req.params.chunkId,
          error: (error as Error).message
        });
        return _next(error);
      }
    });

    // Custom chunking strategy
    this.app.post('/documents/:id/chunk', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;
        const { strategy = 'default', chunkSize = 1000, overlap = 200 } = req.body;

        const client = await this.postgresPool.connect();
        try {
          const docResult = await client.query(`
            SELECT content FROM graphrag.document_content
            WHERE document_id = $1
          `, [id]);

          if (docResult.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
          }

          const content = docResult.rows[0].content;
          const chunks = await this.createCustomChunks(id, content, { strategy, chunkSize, overlap });

          return res.json({
            success: true,
            documentId: id,
            chunks: chunks.length,
            strategy
          });
        } finally {
          client.release();
        }
      } catch (error) {
        return _next(error);
      }
    });

    // Document storage endpoint (original)
    this.app.post('/graphrag/api/documents', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        req.tenantContext!;
        const { content } = req.body as StoreDocumentRequest;
        let { metadata } = req.body as StoreDocumentRequest;

        if (!content) {
          return res.status(400).json({
            error: {
              message: 'Content is required',
              code: 'MISSING_CONTENT'
            }
          });
        }

        // Initialize metadata with required fields if not provided
        if (!metadata) {
          const contentStr = typeof content === 'string' ? content : content.toString('utf-8');
          const firstLine = contentStr.split('\n')[0];
          metadata = {
            title: firstLine.length > 50
              ? firstLine.substring(0, 47) + '...'
              : firstLine || 'Untitled Document',
            type: 'text',
            format: 'text',
            size: 0,
            hash: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: 1,
            tags: [],
            source: 'api',
            custom: {}
          };
        } else if (!metadata.title) {
          // Auto-generate title if not provided
          const contentStr = typeof content === 'string' ? content : content.toString('utf-8');
          const firstLine = contentStr.split('\n')[0];
          metadata.title = firstLine.length > 50
            ? firstLine.substring(0, 47) + '...'
            : firstLine || 'Untitled Document';
        }

        // Store document (with improved chunking tolerance)
        const result = await this.storageEngine.storeDocument(content, metadata as DocumentMetadata);

        // Build response with any preprocessing warnings
        const response: any = {
          success: result.success,
          documentId: result.documentId,
          chunkCount: result.chunksCreated || 0,  // Include chunk count in response
          message: result.message || 'Document stored successfully',
          metadata: result.metadata
        };

        // Add preprocessing warnings if they exist
        if (req.body._preprocessingWarnings) {
          response.warnings = req.body._preprocessingWarnings;
        }

        return res.status(result.duplicate ? 200 : 201).json(response);

      } catch (error) {
        // Use database error handler for better error messages
        if (error instanceof Error) {
          return this.handleDatabaseError(error, res, 'Document storage failed');
        } else {
          return _next(error);
        }
      }
    });

    // Vector search endpoint with metadata filtering
    this.app.post('/search', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { query, filters, limit = 10 } = req.body;

        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }

        let results: Array<{ id: string | number; score: number; content: string; metadata?: any }> = [];

        // Try vector search first if VoyageAI is available
        if (this.voyageClient) {
          try {
            const embeddingResult = await this.voyageClient.generateEmbedding(query, {
              inputType: 'query'
            });
            const embedding = embeddingResult.embedding;

            // Build Qdrant filter from metadata filters
            const qdrantFilter = filters ? {
              must: Object.entries(filters).map(([key, value]) => ({
                key,
                match: { value }
              }))
            } : undefined;

            const searchResult = await this.qdrantClient.search('documents', {
              vector: embedding,
              limit,
              filter: qdrantFilter,
              with_payload: true
            });

            results = searchResult.map(r => ({
              id: r.id,
              score: r.score,
              content: String(r.payload?.content || ''),
              metadata: r.payload?.metadata || {}
            }));
          } catch (error) {
            logger.warn('Vector search failed, falling back to text search', error);
          }
        }

        // Fallback to PostgreSQL text search if no results or vector search unavailable
        if (results.length === 0) {
          const client = await this.postgresPool.connect();
          try {
            const result = await client.query(`
              SELECT d.id, dc.content, d.title,
                     ts_rank(to_tsvector('english', dc.content), plainto_tsquery('english', $1)) as score
              FROM graphrag.documents d
              JOIN graphrag.document_content dc ON d.id = dc.document_id
              WHERE to_tsvector('english', dc.content) @@ plainto_tsquery('english', $1)
              ORDER BY score DESC
              LIMIT $2
            `, [query, limit]);

            results = result.rows.map(r => ({
              id: r.id,
              score: r.score,
              content: r.content,
              metadata: { title: r.title }
            }));
          } finally {
            client.release();
          }
        }

        return res.json({
          query,
          results,
          count: results.length
        });
      } catch (error) {
        return _next(error);
      }
    });

    // Graph endpoints
    this.app.get('/graph/documents/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;
        const session = this.neo4jDriver.session();

        try {
          // Try to get existing graph
          const result = await session.run(`
            MATCH (d:Document {id: $id})
            OPTIONAL MATCH (d)-[r]-(n)
            RETURN d, collect(DISTINCT n) as nodes, collect(DISTINCT r) as edges
          `, { id });

          if (result.records.length === 0 || !result.records[0].get('d')) {
            // Create graph for document if it doesn't exist
            await this.buildDocumentGraph(id);

            // Retry query
            const retryResult = await session.run(`
              MATCH (d:Document {id: $id})
              OPTIONAL MATCH (d)-[r]-(n)
              RETURN d, collect(DISTINCT n) as nodes, collect(DISTINCT r) as edges
            `, { id });

            if (retryResult.records.length > 0) {
              const record = retryResult.records[0];
              return res.json({
                documentId: id,
                nodes: record.get('nodes').map((n: any) => n ? n.properties : null).filter((n: any) => n),
                edges: record.get('edges').map((e: any) => e ? {
                  type: e.type,
                  properties: e.properties
                } : null).filter((e: any) => e)
              });
            } else {
              return res.json({
                documentId: id,
                nodes: [],
                edges: []
              });
            }
          } else {
            const record = result.records[0];
            return res.json({
              documentId: id,
              nodes: record.get('nodes').map((n: any) => n ? n.properties : null).filter((n: any) => n),
              edges: record.get('edges').map((e: any) => e ? {
                type: e.type,
                properties: e.properties
              } : null).filter((e: any) => e)
            });
          }
        } finally {
          await session.close();
        }
      } catch (error) {
        return _next(error);
      }
    });

    // Execute Cypher query
    this.app.post('/graph/query', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { query } = req.body;

        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }

        const session = this.neo4jDriver.session();
        try {
          const result = await session.run(query);

          return res.json({
            results: result.records.map(record => {
              const obj: Record<string, any> = {};
              record.keys.forEach((key: string | symbol) => {
                if (typeof key === 'string') {
                  const value = record.get(key);
                  obj[key] = value ? (value.properties || value) : null;
                }
              });
              return obj;
            }),
            summary: {
              counters: result.summary.counters,
              resultAvailableAfter: result.summary.resultAvailableAfter,
              resultConsumedAfter: result.summary.resultConsumedAfter
            }
          });
        } catch (error) {
          return res.status(400).json({
            error: 'Graph query failed',
            message: error instanceof Error ? error.message : 'Unknown error',
            details: 'Neo4j may be unavailable or query syntax is invalid'
          });
        } finally {
          await session.close();
        }
      } catch (error) {
        return _next(error);
      }
    });

    // Memory-specific endpoints
    this.app.get('/memories/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;
        const memory = await this.getMemoryById(id);

        if (!memory) {
          return res.status(404).json({ error: 'Memory not found' });
        }

        return res.json(memory);
      } catch (error) {
        return _next(error);
      }
    });

    this.app.get('/memories', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const limit = parseInt(req.query.limit as string) || 100;
        const offset = parseInt(req.query.offset as string) || 0;

        const memories = await this.listMemories({ limit, offset });

        return res.json({
          memories: memories.items,
          total: memories.total,
          limit,
          offset
        });
      } catch (error) {
        return _next(error);
      }
    });

    // MCP-compatible memories list endpoint
    this.app.get('/graphrag/api/memories', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = parseInt(req.query.offset as string) || 0;

        const results = await this.unifiedStorageEngine.listMemories(tenantContext, {
          limit,
          offset
        });

        return res.json({
          success: true,
          memories: results.items,
          pagination: {
            total: results.total,
            limit,
            offset,
            hasMore: offset + limit < results.total
          }
        });
      } catch (error) {
        return _next(error);
      }
    });

    // ========== UNIFIED ENDPOINTS ==========

    // Unified retrieval endpoint (with strategy support)
    this.app.post('/graphrag/api/retrieve', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { query, strategy = 'semantic_chunks', limit = 10, rerank = false, options } = req.body;

        if (!query) {
          return res.status(400).json({
            error: {
              message: 'Query is required',
              code: 'MISSING_QUERY'
            }
          });
        }

        // Validate strategy
        const validStrategies = ['semantic_chunks', 'graph_traversal', 'hybrid', 'adaptive'];
        if (!validStrategies.includes(strategy)) {
          return res.status(400).json({
            error: {
              message: `Invalid strategy. Must be one of: ${validStrategies.join(', ')}`,
              code: 'INVALID_STRATEGY',
              valid_strategies: validStrategies
            }
          });
        }

        // Enhanced retrieval options to support both memories and documents
        const enhancedOptions: RetrievalOptions = {
          ...options,
          strategy,
          limit,
          rerank,
          contentTypes: options?.contentTypes || ['all']
        };

        const result = await this.retrievalEngine.retrieve(query, enhancedOptions);

        return res.json({
          success: true,
          strategy_used: strategy,
          content: result.content,
          metadata: result.metadata,
          relevanceScore: result.relevanceScore,
          usage: {
            promptTokens: this.estimateTokens(query),
            completionTokens: result.metadata.tokens,
            totalTokens: this.estimateTokens(query) + result.metadata.tokens
          }
        });

      } catch (error) {
        return _next(error);
      }
    });

    // Rerank endpoint - Uses VoyageAI rerank-2.5 for semantic reranking
    // This enables GraphRAG Enhanced and other services to leverage reranking
    this.app.post('/graphrag/api/rerank', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { query, documents, topK = 10 } = req.body;

        if (!query) {
          return res.status(400).json({
            error: {
              message: 'Query is required for reranking',
              code: 'MISSING_QUERY'
            }
          });
        }

        if (!documents || !Array.isArray(documents) || documents.length === 0) {
          return res.status(400).json({
            error: {
              message: 'Documents array is required and must not be empty',
              code: 'MISSING_DOCUMENTS'
            }
          });
        }

        // Extract content strings from documents (support both string[] and {id, content}[])
        const contentStrings: string[] = documents.map((doc: string | { content: string }) =>
          typeof doc === 'string' ? doc : doc.content
        );

        // Use VoyageAI rerank-2.5 (best quality) with fallback
        const startTime = Date.now();
        const rerankedResults = await this.voyageClient.rerank(query, contentStrings, topK);
        const latency = Date.now() - startTime;

        // Map results back to original documents with scores
        const results = rerankedResults.map((result) => {
          const originalDoc = documents[result.index];
          return {
            id: typeof originalDoc === 'object' ? originalDoc.id : undefined,
            content: typeof originalDoc === 'string' ? originalDoc : originalDoc.content,
            score: result.score,
            index: result.index
          };
        });

        logger.info('Rerank completed', {
          query: query.substring(0, 100),
          documentCount: documents.length,
          topK,
          resultCount: results.length,
          latencyMs: latency
        });

        return res.json({
          success: true,
          results,
          metadata: {
            model: 'rerank-2.5',
            documentCount: documents.length,
            returnedCount: results.length,
            latencyMs: latency
          }
        });

      } catch (error) {
        logger.error('Rerank failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        return _next(error);
      }
    });

    // Unified search endpoint
    this.app.post('/graphrag/api/unified/search', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { query, contentTypes = ['all'], limit = 20, options } = req.body;

        if (!query) {
          return res.status(400).json({
            error: {
              message: 'Search query is required',
              code: 'MISSING_QUERY'
            }
          });
        }

        const results = await this.unifiedStorageEngine.unifiedSearch({
          query,
          contentTypes,
          limit,
          options
        }, tenantContext);

        return res.json({
          results: results.items,
          metadata: {
            totalMemories: results.memoriesCount,
            totalDocuments: results.documentsCount,
            contentTypes: results.contentTypes
          }
        });

      } catch (error) {
        return _next(error);
      }
    });

    // Get full document by ID (existing endpoint)
    this.app.get('/graphrag/api/documents/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;

        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
          return res.status(400).json({
            error: {
              message: 'Invalid document ID format',
              code: 'INVALID_ID'
            }
          });
        }

        const client = await this.postgresPool.connect();
        try {
          // Get document metadata
          const metadataResult = await client.query(`
            SELECT d.*, dc.content
            FROM graphrag.documents d
            JOIN graphrag.document_content dc ON d.id = dc.document_id
            WHERE d.id = $1
          `, [id]);

          if (metadataResult.rows.length === 0) {
            return res.status(404).json({
              error: {
                message: 'Document not found',
                code: 'NOT_FOUND'
              }
            });
          }

          const document = metadataResult.rows[0];
          
          return res.json({
            id: document.id,
            content: document.content,
            metadata: {
              title: document.title,
              type: document.type,
              format: document.format,
              size: document.size,
              hash: document.hash,
              created_at: document.created_at,
              updated_at: document.updated_at,
              version: document.version,
              tags: document.tags,
              source: document.source,
              custom: document.metadata
            }
          });

        } finally {
          client.release();
        }

      } catch (error) {
        return _next(error);
      }
    });

    // Get document context - retrieve chunk content and surrounding chunks for navigation
    // Used by memory recall results to view full context around a matched chunk
    this.app.get('/graphrag/api/documents/:id/context', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;
        const { chunkId, pageNumber, contextSize = '500' } = req.query;

        // Validate document ID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
          return res.status(400).json({
            error: {
              message: 'Invalid document ID format',
              code: 'INVALID_ID'
            }
          });
        }

        const client = await this.postgresPool.connect();
        try {
          // Get document metadata first
          const docResult = await client.query(`
            SELECT d.id, d.title, d.type, d.format, d.size, d.created_at
            FROM graphrag.documents d
            WHERE d.id = $1
          `, [id]);

          if (docResult.rows.length === 0) {
            return res.status(404).json({
              error: {
                message: 'Document not found',
                code: 'NOT_FOUND'
              }
            });
          }

          const document = docResult.rows[0];

          // Get all chunks for this document from Qdrant
          const chunkResults = await this.qdrantClient.scroll('chunks', {
            limit: 1000,  // Get all chunks
            with_payload: true,
            filter: {
              must: [
                { key: 'document_id', match: { value: id } }
              ]
            }
          });

          const allChunks = (chunkResults.points || [])
            .map((point: any) => ({
              id: point.id,
              content: point.payload?.content || '',
              position: point.payload?.position || { start: 0, end: 0 },
              type: point.payload?.type || 'paragraph',
              pageNumber: point.payload?.metadata?.pageNumber,
              tokens: point.payload?.tokens || 0
            }))
            .sort((a: any, b: any) => a.position.start - b.position.start);  // Sort by position

          if (allChunks.length === 0) {
            return res.status(404).json({
              error: {
                message: 'No chunks found for document',
                code: 'NO_CHUNKS'
              }
            });
          }

          // Find the target chunk
          let targetChunkIndex = 0;
          if (chunkId) {
            targetChunkIndex = allChunks.findIndex((c: any) => c.id === chunkId);
            if (targetChunkIndex === -1) {
              // Fallback to first chunk if chunkId not found
              targetChunkIndex = 0;
            }
          } else if (pageNumber) {
            // Find first chunk on the specified page
            targetChunkIndex = allChunks.findIndex((c: any) => c.pageNumber === parseInt(pageNumber as string));
            if (targetChunkIndex === -1) {
              targetChunkIndex = 0;
            }
          }

          const targetChunk = allChunks[targetChunkIndex];
          const previousChunk = targetChunkIndex > 0 ? allChunks[targetChunkIndex - 1] : null;
          const nextChunk = targetChunkIndex < allChunks.length - 1 ? allChunks[targetChunkIndex + 1] : null;

          return res.json({
            document: {
              id: document.id,
              title: document.title,
              type: document.type,
              format: document.format,
              size: document.size,
              createdAt: document.created_at
            },
            chunk: {
              id: targetChunk.id,
              content: targetChunk.content,
              position: targetChunk.position,
              type: targetChunk.type,
              pageNumber: targetChunk.pageNumber,
              tokens: targetChunk.tokens,
              index: targetChunkIndex
            },
            context: {
              previousChunk: previousChunk ? {
                id: previousChunk.id,
                content: previousChunk.content.substring(0, parseInt(contextSize as string)),
                position: previousChunk.position,
                pageNumber: previousChunk.pageNumber
              } : null,
              nextChunk: nextChunk ? {
                id: nextChunk.id,
                content: nextChunk.content.substring(0, parseInt(contextSize as string)),
                position: nextChunk.position,
                pageNumber: nextChunk.pageNumber
              } : null
            },
            navigation: {
              totalChunks: allChunks.length,
              currentIndex: targetChunkIndex,
              hasPrevious: targetChunkIndex > 0,
              hasNext: targetChunkIndex < allChunks.length - 1,
              firstChunkId: allChunks[0].id,
              lastChunkId: allChunks[allChunks.length - 1].id
            }
          });

        } finally {
          client.release();
        }

      } catch (error) {
        logger.error('Failed to get document context', { error, documentId: req.params.id });
        return _next(error);
      }
    });

    // Update document (existing endpoint)
    this.app.put('/graphrag/api/documents/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        req.tenantContext!;
        const { id } = req.params;
        const { content, metadata } = req.body;

        if (!content && !metadata) {
          return res.status(400).json({
            error: {
              message: 'Either content or metadata must be provided',
              code: 'MISSING_UPDATE_DATA'
            }
          });
        }

        // Update document with versioning
        const client = await this.postgresPool.connect();
        try {
          await client.query('BEGIN');

          // Get current version
          const versionResult = await client.query(
            'SELECT version FROM graphrag.documents WHERE id = $1 FOR UPDATE',
            [id]
          );

          if (versionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
              error: {
                message: 'Document not found',
                code: 'NOT_FOUND'
              }
            });
          }

          const currentVersion = versionResult.rows[0].version;
          const newVersion = currentVersion + 1;

          // Update metadata if provided
          if (metadata) {
            await client.query(`
              UPDATE documents
              SET title = COALESCE($2, title),
                  tags = COALESCE($3, tags),
                  metadata = COALESCE($4, metadata),
                  version = $5,
                  updated_at = NOW()
              WHERE id = $1
            `, [
              id,
              metadata.title,
              toPostgresArray(metadata.tags), // Convert JS array to PostgreSQL array format
              JSON.stringify(metadata.custom || {}),
              newVersion
            ]);
          }

          // Update content if provided
          if (content) {
            // Re-process document through chunking
            const fullMetadata = await this.getDocumentMetadata(id);
            await this.storageEngine.storeDocument(content, {
              ...fullMetadata,
              version: newVersion
            });
          }

          await client.query('COMMIT');

          return res.json({
            success: true,
            documentId: id,
            version: newVersion,
            message: 'Document updated successfully'
          });

        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

      } catch (error) {
        return _next(error);
      }
    });

    // Delete document (existing endpoint)
    this.app.delete('/graphrag/api/documents/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;

        // Delete document and all associated data
        const client = await this.postgresPool.connect();
        try {
          await client.query('BEGIN');

          // Check if document exists
          const existsResult = await client.query(
            'SELECT id FROM graphrag.documents WHERE id = $1',
            [id]
          );

          if (existsResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
              error: {
                message: 'Document not found',
                code: 'NOT_FOUND'
              }
            });
          }

          // Delete from all tables in correct order
          // CRITICAL: Delete audit records FIRST, then disable audit trigger to avoid FK constraint violation
          // The AFTER DELETE trigger on documents tries to INSERT into document_audit,
          // which fails because the FK constraint expects the document to exist

          // 1. Delete existing audit records
          await client.query('DELETE FROM graphrag.document_audit WHERE document_id = $1', [id]);

          // 2. Temporarily disable the audit trigger to prevent FK violation
          await client.query('ALTER TABLE graphrag.documents DISABLE TRIGGER tg_documents_audit');

          // 3. Delete dependent records
          await client.query('DELETE FROM graphrag.document_chunks WHERE document_id = $1', [id]);
          await client.query('DELETE FROM graphrag.document_content WHERE document_id = $1', [id]);
          await client.query('DELETE FROM graphrag.document_summaries WHERE document_id = $1', [id]);
          await client.query('DELETE FROM graphrag.document_outlines WHERE document_id = $1', [id]);
          await client.query('DELETE FROM graphrag.search_index WHERE document_id = $1', [id]);

          // 4. Delete the document itself
          await client.query('DELETE FROM graphrag.documents WHERE id = $1', [id]);

          // 5. Re-enable the audit trigger
          await client.query('ALTER TABLE graphrag.documents ENABLE TRIGGER tg_documents_audit');

          // Delete from vector stores
          await this.qdrantClient.delete('chunks', {
            filter: {
              must: [{
                key: 'document_id',
                match: { value: id }
              }]
            }
          });

          await this.qdrantClient.delete('document_summaries', {
            filter: {
              must: [{
                key: 'document_id',
                match: { value: id }
              }]
            }
          });

          // Delete from graph
          const session = this.neo4jDriver.session();
          try {
            await session.run(`
              MATCH (d:Document {id: $id})
              OPTIONAL MATCH (d)-[r]->(c:Chunk)
              DETACH DELETE d, c
            `, { id });
          } finally {
            await session.close();
          }

          // Clear caches
          const cachePattern = `*:${id}:*`;
          const keys = await this.redisClient.keys(cachePattern);
          if (keys.length > 0) {
            await this.redisClient.del(...keys);
          }

          await client.query('COMMIT');

          return res.json({
            success: true,
            message: 'Document deleted successfully',
            documentId: id
          });

        } catch (error: any) {
          await client.query('ROLLBACK');
          logger.error('Document deletion failed', {
            documentId: id,
            error: error.message,
            stack: error.stack,
            code: error.code
          });
          throw error;
        } finally {
          client.release();
        }

      } catch (error: any) {
        logger.error('Document deletion endpoint error', {
          documentId: req.params.id,
          error: error.message,
          errorCode: error.code
        });

        // Provide verbose error response
        const errorResponse: any = {
          error: {
            message: 'Failed to delete document',
            code: 'DELETION_FAILED',
            details: error.message,
            documentId: req.params.id
          }
        };

        // Add specific error context based on error type
        if (error.code === '23503') {
          errorResponse.error.message = 'Cannot delete document due to foreign key constraint';
          errorResponse.error.hint = 'Ensure all related records are deleted first';
        } else if (error.code === '23505') {
          errorResponse.error.message = 'Duplicate key violation during deletion';
        }

        return res.status(500).json(errorResponse);
      }
    });

    // ========== MISSING ENDPOINTS IMPLEMENTATION ==========

    // List documents endpoint (missing /api/documents)
    this.app.get('/graphrag/api/documents', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const tags = req.query.tags ? (req.query.tags as string).split(',') : null;
        const offset = (page - 1) * limit;

        const client = await this.postgresPool.connect();
        try {
          let query = `
            SELECT d.id, d.title, d.type, d.format, d.tags, d.source, d.created_at, d.updated_at
            FROM graphrag.documents d
          `;

          const params: any[] = [];
          let whereConditions: string[] = [];

          if (tags && tags.length > 0) {
            whereConditions.push(`d.tags && $${params.length + 1}::text[]`);
            params.push(toPostgresArray(tags)); // Convert JS array for PostgreSQL array overlap operator
          }

          if (whereConditions.length > 0) {
            query += ' WHERE ' + whereConditions.join(' AND ');
          }

          query += ` ORDER BY d.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
          params.push(limit, offset);

          const result = await client.query(query, params);

          // Get total count
          const countQuery = `SELECT COUNT(*) as total FROM graphrag.documents d ${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}`;
          const countResult = await client.query(countQuery, tags ? [toPostgresArray(tags)] : []);
          const total = parseInt(countResult.rows[0].total);

          return res.json({
            documents: result.rows,
            pagination: {
              page,
              limit,
              total,
              totalPages: Math.ceil(total / limit),
              hasMore: offset + limit < total
            }
          });
        } finally {
          client.release();
        }
      } catch (error) {
        return _next(error);
      }
    });

    // POST version for MCP client compatibility
    this.app.post('/graphrag/api/documents/list', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { limit = 20, offset = 0 } = req.body;
        const parsedLimit = parseInt(String(limit));
        const parsedOffset = parseInt(String(offset));

        const client = await this.postgresPool.connect();
        try {
          const query = `
            SELECT d.id, d.title, d.type, d.format, d.tags, d.source, d.created_at, d.updated_at
            FROM graphrag.documents d
            ORDER BY d.created_at DESC
            LIMIT $1 OFFSET $2
          `;

          const result = await client.query(query, [parsedLimit, parsedOffset]);

          // Get total count
          const countResult = await client.query('SELECT COUNT(*) as total FROM graphrag.documents');
          const total = parseInt(countResult.rows[0].total);

          return res.json({
            documents: result.rows,
            pagination: {
              limit: parsedLimit,
              offset: parsedOffset,
              total,
              hasMore: parsedOffset + parsedLimit < total
            }
          });
        } finally {
          client.release();
        }
      } catch (error) {
        return _next(error);
      }
    });

    // ========== URL INGESTION ENDPOINTS ==========

    /**
     * POST /api/documents/ingest-url
     * Initiate document ingestion from URL (single file or folder)
     *
     * Supports:
     * - HTTP/HTTPS file downloads
     * - Google Drive files and folders (recursive)
     * - Automatic resource type detection
     * - User confirmation for large folder operations
     */
    this.app.post('/graphrag/api/documents/ingest-url', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const {
          url,
          discoveryOptions = {},
          ingestionOptions = {},
          userId,
          sessionId,
          skipConfirmation = false
        } = req.body;

        // Validate URL
        if (!url) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'URL is required',
              code: 'MISSING_URL'
            }
          });
        }

        // Initiate ingestion (returns immediately or with confirmation request)
        const result = await this.ingestionOrchestrator.ingest({
          url,
          discoveryOptions,
          ingestionOptions,
          userId,
          sessionId,
          skipConfirmation
        });

        // Check if confirmation required
        if (result.requiresConfirmation) {
          return res.status(200).json({
            success: true,
            requiresConfirmation: true,
            message: result.message,
            validation: result.validation,
            files: result.files,
            estimatedProcessingTime: result.estimatedProcessingTime,
            fileCount: result.files?.length || 0
          });
        }

        // Job started
        return res.status(202).json({
          success: true,
          jobId: result.jobId,
          message: result.message,
          validation: result.validation,
          fileCount: result.files?.length || 1,
          estimatedProcessingTime: result.estimatedProcessingTime
        });
      } catch (error) {
        logger.error('URL ingestion initiation failed', {
          error: (error as Error).message,
          stack: (error as Error).stack
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'INGESTION_FAILED'
          }
        });
      }
    });

    /**
     * POST /api/documents/ingest-url/confirm
     * Confirm and proceed with URL ingestion after user confirmation
     *
     * Called after user confirms recursive folder ingestion.
     * Submits job to queue and returns job ID for monitoring.
     */
    this.app.post('/graphrag/api/documents/ingest-url/confirm', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { files, options = {} } = req.body;

        // Validate files
        if (!files || !Array.isArray(files) || files.length === 0) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Files array is required',
              code: 'MISSING_FILES'
            }
          });
        }

        // Confirm and ingest
        const jobId = await this.ingestionOrchestrator.confirmAndIngest(files, options);

        return res.status(202).json({
          success: true,
          jobId,
          message: `Ingestion job started: ${jobId}`,
          fileCount: files.length
        });
      } catch (error) {
        logger.error('URL ingestion confirmation failed', {
          error: (error as Error).message,
          stack: (error as Error).stack
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'CONFIRMATION_FAILED'
          }
        });
      }
    });

    /**
     * POST /api/documents/validate-url
     * Validate URL accessibility and type before ingestion
     */
    this.app.post('/graphrag/api/documents/validate-url', async (req: Request, res: Response) => {
      try {
        const { url } = req.body;

        if (!url) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'URL is required',
              code: 'MISSING_URL'
            }
          });
        }

        // Simple URL format validation
        let parsedUrl;
        try {
          parsedUrl = new URL(url);
        } catch {
          return res.json({
            valid: false,
            url,
            error: 'Invalid URL format'
          });
        }

        // Check protocol
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return res.json({
            valid: false,
            url,
            error: 'Only HTTP/HTTPS URLs are supported'
          });
        }

        // Basic validation passed
        return res.json({
          valid: true,
          url,
          protocol: parsedUrl.protocol,
          hostname: parsedUrl.hostname,
          type: parsedUrl.hostname.includes('drive.google.com') ? 'google_drive' : 'http'
        });
      } catch (error) {
        logger.error('URL validation failed', { error: (error as Error).message });
        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'VALIDATION_ERROR'
          }
        });
      }
    });

    /**
     * GET /api/documents/ingestion-jobs/:jobId
     * Get ingestion job status and result
     *
     * Returns:
     * - Job state (waiting, active, completed, failed)
     * - Progress percentage
     * - File counts (success, failure, total)
     * - Detailed file results (when completed)
     */
    this.app.get('/graphrag/api/documents/ingestion-jobs/:jobId', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { jobId } = req.params;

        if (!jobId) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Job ID is required',
              code: 'MISSING_JOB_ID'
            }
          });
        }

        // Get job status
        const status = await this.ingestionOrchestrator.getJobStatus(jobId);

        if (!status) {
          return res.status(404).json({
            success: false,
            error: {
              message: 'Job not found',
              code: 'JOB_NOT_FOUND'
            }
          });
        }

        return res.status(200).json({
          success: true,
          jobId,
          state: status.state,
          progress: status.progress || 0,
          data: status.data,
          result: status.result,
          failedReason: status.failedReason,
          finishedOn: status.finishedOn,
          processedOn: status.processedOn
        });
      } catch (error) {
        logger.error('Job status retrieval failed', {
          jobId: req.params.jobId,
          error: (error as Error).message
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'STATUS_RETRIEVAL_FAILED'
          }
        });
      }
    });

    /**
     * POST /api/documents/ingestion-jobs/:jobId/cancel
     * Cancel a running or pending ingestion job
     *
     * Returns:
     * - success: whether cancellation was successful
     * - message: cancellation status message
     */
    this.app.post('/graphrag/api/documents/ingestion-jobs/:jobId/cancel', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { jobId } = req.params;

        if (!jobId) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Job ID is required',
              code: 'MISSING_JOB_ID'
            }
          });
        }

        // Cancel job
        const cancelled = await this.ingestionOrchestrator.cancelJob(jobId);

        if (!cancelled) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Job cannot be cancelled (already completed or not found)',
              code: 'CANCELLATION_FAILED'
            }
          });
        }

        return res.status(200).json({
          success: true,
          jobId,
          message: 'Job cancelled successfully'
        });
      } catch (error) {
        logger.error('Job cancellation failed', {
          jobId: req.params.jobId,
          error: (error as Error).message
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'CANCELLATION_ERROR'
          }
        });
      }
    });

    /**
     * ========================================
     * Route Aliases for Nexus MCP Compatibility
     * ========================================
     * These aliases support the nexus-routing layer's expected paths
     * without breaking existing /api/documents/* integrations
     */

    /**
     * POST /api/ingest/url (ALIAS)
     * Delegates to POST /api/documents/ingest-url
     */
    this.app.post('/graphrag/api/ingest/url', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const {
          url,
          discoveryOptions = {},
          ingestionOptions = {},
          userId,
          sessionId,
          skipConfirmation = false
        } = req.body;

        // Validate URL
        if (!url) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'URL is required',
              code: 'MISSING_URL'
            }
          });
        }

        // Initiate ingestion (returns immediately or with confirmation request)
        const result = await this.ingestionOrchestrator.ingest({
          url,
          discoveryOptions,
          ingestionOptions,
          userId,
          sessionId,
          skipConfirmation
        });

        // Check if confirmation required
        if (result.requiresConfirmation) {
          return res.status(200).json({
            success: true,
            requiresConfirmation: true,
            message: result.message,
            validation: result.validation,
            files: result.files,
            estimatedProcessingTime: result.estimatedProcessingTime,
            fileCount: result.files?.length || 0
          });
        }

        // Job started
        return res.status(202).json({
          success: true,
          jobId: result.jobId,
          message: result.message,
          validation: result.validation,
          fileCount: result.files?.length || 1,
          estimatedProcessingTime: result.estimatedProcessingTime
        });
      } catch (error) {
        logger.error('URL ingestion initiation failed (alias endpoint)', {
          error: (error as Error).message,
          stack: (error as Error).stack
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'INGESTION_FAILED'
          }
        });
      }
    });

    /**
     * POST /api/ingest/url/confirm (ALIAS)
     * Delegates to POST /api/documents/ingest-url/confirm
     */
    this.app.post('/graphrag/api/ingest/url/confirm', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { files, options = {} } = req.body;

        // Validate files
        if (!files || !Array.isArray(files) || files.length === 0) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Files array is required',
              code: 'MISSING_FILES'
            }
          });
        }

        // Confirm and ingest
        const jobId = await this.ingestionOrchestrator.confirmAndIngest(files, options);

        return res.status(202).json({
          success: true,
          jobId,
          message: `Ingestion job started: ${jobId}`,
          fileCount: files.length
        });
      } catch (error) {
        logger.error('URL ingestion confirmation failed (alias endpoint)', {
          error: (error as Error).message,
          stack: (error as Error).stack
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'CONFIRMATION_FAILED'
          }
        });
      }
    });

    /**
     * GET /api/ingest/jobs/:jobId (ALIAS)
     * Delegates to GET /api/documents/ingestion-jobs/:jobId
     */
    this.app.get('/graphrag/api/ingest/jobs/:jobId', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { jobId } = req.params;

        if (!jobId) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Job ID is required',
              code: 'MISSING_JOB_ID'
            }
          });
        }

        // Get job status
        const status = await this.ingestionOrchestrator.getJobStatus(jobId);

        if (!status) {
          return res.status(404).json({
            success: false,
            error: {
              message: 'Job not found',
              code: 'JOB_NOT_FOUND'
            }
          });
        }

        return res.status(200).json({
          success: true,
          jobId,
          state: status.state,
          progress: status.progress || 0,
          data: status.data,
          result: status.result,
          failedReason: status.failedReason,
          finishedOn: status.finishedOn,
          processedOn: status.processedOn
        });
      } catch (error) {
        logger.error('Job status retrieval failed (alias endpoint)', {
          jobId: req.params.jobId,
          error: (error as Error).message
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'STATUS_RETRIEVAL_FAILED'
          }
        });
      }
    });

    /**
     * Repository Ingestion Endpoint
     * POST /api/documents/ingest-repository
     *
     * Scans a local directory and ingests all files into GraphRAG.
     *
     * Request body:
     * - repositoryPath: absolute path to directory
     * - options: scan options (extensions, ignorePatterns, maxFileSize, maxDepth)
     *
     * Returns:
     * - jobId: ingestion job ID for tracking
     * - filesDiscovered: number of files found
     * - estimatedSize: total size of files in bytes
     */
    this.app.post('/graphrag/api/documents/ingest-repository', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        req.tenantContext!;
        const { repositoryPath, options = {} } = req.body;

        // Validate repository path
        if (!repositoryPath) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'repositoryPath is required',
              code: 'MISSING_REPOSITORY_PATH'
            }
          });
        }

        logger.info('Repository ingestion requested', {
          repositoryPath,
          options
        });

        // Dynamically import RepositoryScanner
        const { RepositoryScanner } = await import('./ingestion/repository-scanner.js');

        // Create scanner instance
        const scanner = new RepositoryScanner({
          rootPath: repositoryPath,
          extensions: options.extensions || ['ts', 'tsx', 'js', 'jsx', 'md', 'json', 'yaml', 'yml'],
          ignorePatterns: options.ignorePatterns || [],
          maxFileSize: options.maxFileSize || 10 * 1024 * 1024, // 10MB
          maxDepth: options.maxDepth
        });

        // Get scan estimate first
        const estimate = await scanner.estimateScan();

        logger.info('Repository scan estimate', {
          repositoryPath,
          estimatedFiles: estimate.estimatedFiles,
          estimatedSize: estimate.estimatedSize
        });

        // If user wants estimate only, return it
        if (options.estimateOnly) {
          return res.status(200).json({
            success: true,
            estimate: {
              filesDiscovered: estimate.estimatedFiles,
              totalSize: estimate.estimatedSize,
              humanReadableSize: this.formatBytes(estimate.estimatedSize)
            }
          });
        }

        // Perform actual scan
        const scanResult = await scanner.scan();

        logger.info('Repository scan completed', {
          totalFiles: scanResult.totalFiles,
          skippedFiles: scanResult.skippedFiles,
          totalSize: scanResult.totalSize,
          scanDuration: scanResult.scanDuration
        });

        // Start async ingestion process
        const jobId = uuidv4();

        // Process files asynchronously
        setImmediate(async () => {
          const { promises: fsPromises } = await import('fs');
          const path = await import('path');

          let successCount = 0;
          let failureCount = 0;
          const errors: Array<{ file: string; error: string }> = [];

          const startTime = Date.now();

          for (const fileDesc of scanResult.files) {
            try {
              // Read file content
              const filePath = fileDesc.url;
              const content = await fsPromises.readFile(filePath, 'utf-8');

              // Infer document type from extension
              const ext = path.extname(fileDesc.filename).toLowerCase().substring(1);
              let docType: 'code' | 'markdown' | 'text' | 'structured' | 'multimodal' = 'text';

              if (['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'cpp', 'c'].includes(ext)) {
                docType = 'code';
              } else if (['md', 'markdown'].includes(ext)) {
                docType = 'markdown';
              } else if (['json', 'yaml', 'yml', 'xml'].includes(ext)) {
                docType = 'structured';
              }

              // Store document
              await this.storageEngine.storeDocument(content, {
                title: fileDesc.filename,
                source: `file://${filePath}`,
                type: docType,
                format: ext || 'txt',
                tags: options.tags || [],
                custom: {
                  repositoryPath,
                  parentPath: fileDesc.parentPath,
                  depth: fileDesc.depth,
                  ingestionJobId: jobId,
                  ...fileDesc.metadata
                },
                size: fileDesc.size || Buffer.byteLength(content, 'utf-8'),
                hash: '',
                created_at: fileDesc.lastModified || new Date().toISOString(),
                updated_at: new Date().toISOString(),
                version: 1
              });

              successCount++;

              logger.debug('File ingested', {
                jobId,
                file: fileDesc.filename,
                progress: `${successCount + failureCount}/${scanResult.totalFiles}`
              });

            } catch (error) {
              failureCount++;
              const errorMsg = (error as Error).message;

              errors.push({
                file: fileDesc.filename,
                error: errorMsg
              });

              logger.error('File ingestion failed', {
                jobId,
                file: fileDesc.filename,
                error: errorMsg
              });

              if (!options.continueOnError) {
                break;
              }
            }
          }

          const processingTime = Date.now() - startTime;

          logger.info('Repository ingestion completed', {
            jobId,
            successCount,
            failureCount,
            totalFiles: scanResult.totalFiles,
            processingTime: `${processingTime}ms`
          });

          // Store completion status in Redis for retrieval
          await this.redisClient.setex(
            `repo-ingestion:${jobId}`,
            3600, // 1 hour TTL
            JSON.stringify({
              jobId,
              status: failureCount === 0 ? 'completed' : successCount > 0 ? 'partial' : 'failed',
              filesProcessed: successCount + failureCount,
              successCount,
              failureCount,
              totalFiles: scanResult.totalFiles,
              errors: errors.slice(0, 10), // Store first 10 errors
              processingTime,
              completedAt: new Date().toISOString()
            })
          );
        });

        // Return immediately with job ID
        logger.info('Repository ingestion job started', {
          jobId,
          filesDiscovered: scanResult.totalFiles,
          repositoryPath
        });

        return res.status(202).json({
          success: true,
          jobId,
          filesDiscovered: scanResult.totalFiles,
          filesSkipped: scanResult.skippedFiles,
          totalSize: scanResult.totalSize,
          humanReadableSize: this.formatBytes(scanResult.totalSize),
          scanDuration: scanResult.scanDuration,
          message: 'Repository ingestion started. Use GET /api/documents/repository-jobs/:jobId to track progress.'
        });

      } catch (error) {
        logger.error('Repository ingestion failed', {
          repositoryPath: req.body.repositoryPath,
          error: (error as Error).message,
          stack: (error as Error).stack
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'REPOSITORY_INGESTION_ERROR'
          }
        });
      }
    });

    /**
     * GET /api/documents/repository-jobs/:jobId
     * Get status of a repository ingestion job
     *
     * Returns:
     * - status: job status (in_progress, completed, partial, failed)
     * - filesProcessed: number of files processed so far
     * - successCount: number of successfully ingested files
     * - failureCount: number of failed files
     * - errors: sample of errors (first 10)
     */
    this.app.get('/graphrag/api/documents/repository-jobs/:jobId', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { jobId } = req.params;

        if (!jobId) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Job ID is required',
              code: 'MISSING_JOB_ID'
            }
          });
        }

        // Retrieve job status from Redis
        const statusJson = await this.redisClient.get(`repo-ingestion:${jobId}`);

        if (!statusJson) {
          return res.status(404).json({
            success: false,
            error: {
              message: 'Job not found or expired',
              code: 'JOB_NOT_FOUND'
            }
          });
        }

        const status = JSON.parse(statusJson);

        return res.status(200).json({
          success: true,
          ...status
        });

      } catch (error) {
        logger.error('Repository job status retrieval failed', {
          jobId: req.params.jobId,
          error: (error as Error).message
        });

        return res.status(500).json({
          success: false,
          error: {
            message: (error as Error).message,
            code: 'STATUS_RETRIEVAL_FAILED'
          }
        });
      }
    });

    /**
     * POST /api/documents/process-advanced
     *
     * Advanced document processing with Docling, OCR cascade, and Document DNA
     *
     * Features:
     * - Docling integration for 97.9% table extraction accuracy
     * - 3-tier OCR cascade (Tesseract -> GPT-4o -> Qwen-VL)
     * - Document DNA triple-layer storage
     * - Layout preservation and structural understanding
     */
    this.app.post('/graphrag/api/documents/process-advanced',
      preprocessDocument, // Use existing middleware for size checks
      async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { content, options = {} } = req.body;

        if (!content) {
          return res.status(400).json({
            error: {
              message: 'Content is required',
              code: 'MISSING_CONTENT'
            }
          });
        }

        // Initialize advanced processor if not already done
        if (!this.advancedProcessor) {
          const { AdvancedDocumentProcessor } = await import('./processors/advanced/document-processor');
          this.advancedProcessor = new AdvancedDocumentProcessor(
            this.storageEngine,
            process.env.OPENROUTER_API_KEY,
            process.env.VOYAGE_API_KEY
          );
        }

        // Process with advanced features
        const result = await this.advancedProcessor.processDocument(content, {
          ...options,
          enableDocling: options.enableDocling !== false,
          enableOCR: options.enableOCR !== false,
          enableDocumentDNA: options.enableDocumentDNA !== false,
          sessionId: req.headers['x-session-id'] as string,
          userId: req.headers['x-user-id'] as string
        });

        return res.status(201).json({
          success: true,
          documentId: result.documentId,
          processingTime: result.processingTime,
          processingMethod: result.metadata.processingMethod,
          hasLayout: !!result.layout,
          hasDNA: !!result.dna,
          tables: result.tables?.length || 0,
          figures: result.figures?.length || 0,
          confidence: result.metadata.confidence
        });

      } catch (error) {
        logger.error('Advanced document processing failed', {
          error: (error as Error).message,
          stack: (error as Error).stack
        });
        return _next(error);
      }
    });

    /**
     * POST /api/documents/ocr
     *
     * Direct OCR endpoint for image processing
     * Supports 3-tier cascade with automatic quality escalation
     */
    this.app.post('/graphrag/api/documents/ocr', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { image, tier = 'auto', preserveLayout = false } = req.body;

        if (!image) {
          return res.status(400).json({
            error: {
              message: 'Image content is required',
              code: 'MISSING_IMAGE'
            }
          });
        }

        // Initialize OCR cascade
        const { OCRCascade } = await import('./processors/ocr/ocr-cascade');
        const { OpenRouterModelSelector } = await import('./clients/openrouter-model-selector');

        const openRouterSelector = new OpenRouterModelSelector(
          process.env.OPENROUTER_API_KEY!
        );

        const ocrCascade = new OCRCascade(openRouterSelector);

        // Process OCR
        const result = await ocrCascade.process(image, {
          tier,
          preserveLayout
        });

        return res.json({
          success: true,
          text: result.text,
          confidence: result.confidence,
          tier: result.tier,
          layout: result.layout,
          metadata: result.metadata
        });

      } catch (error) {
        logger.error('OCR processing failed', {
          error: (error as Error).message
        });
        return _next(error);
      }
    });

    /**
     * GET /api/documents/:id/dna
     *
     * Retrieve Document DNA for a specific document
     * Returns the triple-layer preservation data
     */
    this.app.get('/graphrag/api/documents/:id/dna', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { id } = req.params;

        if (!id) {
          return res.status(400).json({
            error: {
              message: 'Document ID is required',
              code: 'MISSING_DOCUMENT_ID'
            }
          });
        }

        const dna = await this.storageEngine.getDocumentDNA(id);

        if (!dna) {
          return res.status(404).json({
            error: {
              message: 'Document DNA not found',
              code: 'DNA_NOT_FOUND'
            }
          });
        }

        return res.json({
          success: true,
          dna: {
            id: dna.id,
            documentId: dna.documentId,
            hasSemanticLayer: !!dna.layers.semantic,
            hasStructuralLayer: !!dna.layers.structural,
            hasOriginalLayer: !!dna.layers.original,
            version: dna.version,
            createdAt: dna.createdAt,
            updatedAt: dna.updatedAt
          }
        });

      } catch (error) {
        logger.error('Document DNA retrieval failed', {
          documentId: req.params.id,
          error: (error as Error).message
        });
        return _next(error);
      }
    });

    /**
     * POST /api/documents/batch-process
     *
     * Batch process multiple documents with advanced features
     * Useful for migrating existing documents to use new capabilities
     */
    this.app.post('/graphrag/api/documents/batch-process', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { documents, options = {} } = req.body;

        if (!Array.isArray(documents) || documents.length === 0) {
          return res.status(400).json({
            error: {
              message: 'Documents array is required and must not be empty',
              code: 'INVALID_DOCUMENTS'
            }
          });
        }

        // Initialize advanced processor
        if (!this.advancedProcessor) {
          const { AdvancedDocumentProcessor } = await import('./processors/advanced/document-processor');
          this.advancedProcessor = new AdvancedDocumentProcessor(
            this.storageEngine,
            process.env.OPENROUTER_API_KEY,
            process.env.VOYAGE_API_KEY
          );
        }

        const jobId = uuidv4();
        const results: any[] = [];
        let successCount = 0;
        let failureCount = 0;

        // Process documents asynchronously
        setImmediate(async () => {
          for (const doc of documents) {
            try {
              const result = await this.advancedProcessor.processDocument(doc.content, {
                ...options,
                ...(doc.options || {}),
                documentId: doc.id
              });

              results.push({
                documentId: result.documentId,
                success: true
              });
              successCount++;

            } catch (error) {
              results.push({
                documentId: doc.id,
                success: false,
                error: (error as Error).message
              });
              failureCount++;
            }

            // Store progress in Redis
            await this.redisClient.setex(
              `batch-process:${jobId}`,
              3600, // 1 hour TTL
              JSON.stringify({
                jobId,
                status: 'in_progress',
                total: documents.length,
                processed: successCount + failureCount,
                successCount,
                failureCount
              })
            );
          }

          // Store final status
          await this.redisClient.setex(
            `batch-process:${jobId}`,
            3600,
            JSON.stringify({
              jobId,
              status: 'completed',
              total: documents.length,
              processed: documents.length,
              successCount,
              failureCount,
              results
            })
          );
        });

        return res.status(202).json({
          success: true,
          jobId,
          message: 'Batch processing started. Use GET /api/documents/batch-jobs/:jobId to track progress.',
          documentsQueued: documents.length
        });

      } catch (error) {
        logger.error('Batch processing failed', {
          error: (error as Error).message
        });
        return _next(error);
      }
    });

    /**
     * GET /api/documents/batch-jobs/:jobId
     *
     * Get status of batch processing job
     */
    this.app.get('/graphrag/api/documents/batch-jobs/:jobId', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { jobId } = req.params;

        const statusJson = await this.redisClient.get(`batch-process:${jobId}`);

        if (!statusJson) {
          return res.status(404).json({
            error: {
              message: 'Job not found or expired',
              code: 'JOB_NOT_FOUND'
            }
          });
        }

        const status = JSON.parse(statusJson);

        return res.json({
          success: true,
          ...status
        });

      } catch (error) {
        logger.error('Batch job status retrieval failed', {
          jobId: req.params.jobId,
          error: (error as Error).message
        });
        return _next(error);
      }
    });

    // ========== EMBEDDING GENERATION ENDPOINT ==========

    /**
     * POST /api/embeddings/generate
     *
     * Generate VoyageAI embeddings for text content (reused by other services).
     *
     * This endpoint provides centralized embedding generation for all microservices,
     * reusing the production-grade VoyageAI client with circuit breaker, retry logic,
     * and validation.
     *
     * Request Body:
     * {
     *   "content": "Text to generate embedding for",
     *   "inputType": "document" | "query" (default: "document"),
     *   "contentType": "text" | "code" | "general" | "finance" | "law" | "multimodal" (default: "general")
     * }
     *
     * Response:
     * {
     *   "success": true,
     *   "embedding": [0.123, 0.456, ...],  // 1024-D vector (voyage-3)
     *   "dimensions": 1024,
     *   "model": "voyage-3",
     *   "endpoint": "embeddings"
     * }
     *
     * Used by:
     * - VideoAgent worker (video scene embeddings)
     * - Future services requiring embeddings
     */
    this.app.post('/api/embeddings/generate', async (req: Request, res: Response) => {
      try {
        const { content, inputType, contentType } = req.body;

        // Validate input
        if (!content || typeof content !== 'string') {
          return res.status(400).json({
            success: false,
            error: 'Invalid request: content is required and must be a string'
          });
        }

        logger.info('Generating embedding via VoyageAI', {
          contentLength: content.length,
          inputType: inputType || 'document',
          contentType: contentType || 'general'
        });

        // Use existing VoyageAI client (already initialized with circuit breaker)
        const result = await this.voyageClient.generateEmbedding(content, {
          inputType: inputType || 'document',
          contentType: contentType || 'general'
        });

        logger.info('Embedding generated successfully', {
          dimensions: result.dimensions,
          model: result.model
        });

        return res.json({
          success: true,
          embedding: result.embedding,
          dimensions: result.dimensions,
          model: result.model,
          endpoint: result.endpoint
        });

      } catch (error: any) {
        logger.error('Embedding generation failed', {
          error: error.message,
          stack: error.stack
        });

        return res.status(500).json({
          success: false,
          error: 'Failed to generate embedding',
          details: error.message
        });
      }
    });

    // =============================================================================
    // UNIFIED MEMORY STORAGE ENDPOINT - THE ONLY ENDPOINT FOR STORING MEMORIES
    // =============================================================================
    // This replaces ALL old memory storage endpoints:
    // - /api/memory/store (DELETED)
    // - /api/episodes/store (DELETED)
    // - /api/memory (DELETED)
    //
    // This unified endpoint:
    // 1. ALWAYS stores in PostgreSQL + Qdrant (vector search)
    // 2. Uses LLM triage to determine if entity extraction is needed
    // 3. Extracts entities via semantic classification when appropriate
    // 4. Stores episodic data in Neo4j with relationships
    // =============================================================================
    // Register both paths for compatibility with different routing configurations
    // /graphrag/api/v2/memory - for direct access
    // /api/v2/memory - for when Istio strips the /graphrag prefix
    const unifiedMemoryHandler = async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // Get tenant context - may be undefined if middleware wasn't applied to this route
        const tenantContext = req.tenantContext;
        const {
          content,
          userId,
          companyId,
          sessionId,
          appId,
          tags,
          metadata,
          forceEntityExtraction,
          forceEpisodicStorage,
          preIdentifiedEntities,
          episodeType,
          importance
        } = req.body;

        // Validate required fields
        if (!content) {
          return res.status(400).json({
            error: {
              message: 'Content is required',
              code: 'MISSING_CONTENT'
            }
          });
        }

        // Require either tenant context or explicit companyId in body
        const effectiveCompanyId = companyId || tenantContext?.companyId;
        if (!effectiveCompanyId) {
          return res.status(400).json({
            error: {
              message: 'Company ID is required - provide either X-Company-ID header or companyId in body',
              code: 'MISSING_COMPANY_ID'
            }
          });
        }

        // Use tenant context for userId/companyId if not provided
        const storeRequest: UnifiedStoreRequest = {
          content,
          userId: userId || tenantContext?.userId || 'anonymous',
          companyId: effectiveCompanyId,
          sessionId: sessionId || tenantContext?.sessionId,
          appId: appId || tenantContext?.appId,
          tags: tags || [],
          metadata: metadata || {},
          forceEntityExtraction,
          forceEpisodicStorage,
          preIdentifiedEntities,
          episodeType,
          importance
        };

        // Create effective tenant context from headers or body
        const effectiveTenantContext = tenantContext || {
          companyId: effectiveCompanyId,
          userId: storeRequest.userId,
          sessionId: storeRequest.sessionId,
          appId: storeRequest.appId || 'unified-api',
          tenantId: `${effectiveCompanyId}:${storeRequest.appId || 'unified-api'}`,
          requestId: `req-${Date.now()}`,
          timestamp: new Date().toISOString(),
          source: 'headers' as const
        };

        const result: UnifiedStoreResult = await this.unifiedMemoryRouter.storeMemory(
          storeRequest,
          effectiveTenantContext
        );

        return res.status(201).json({
          success: true,
          data: {
            memoryId: result.memoryId,
            episodeId: result.episodeId,
            entities: result.entities,
            facts: result.facts,
            storagePaths: result.storagePaths,
            triageDecision: result.triageDecision,
            duplicate: result.duplicate,
            latencyMs: result.latencyMs
          },
          message: 'Memory stored successfully via unified pipeline',
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        return _next(error);
      }
    };

    // Register the unified memory endpoint at BOTH paths:
    // - /graphrag/api/v2/memory: Direct access path (for internal services)
    // - /api/v2/memory: Path after Istio strips the /graphrag prefix (for public gateway)
    this.app.post('/graphrag/api/v2/memory', unifiedMemoryHandler);
    this.app.post('/api/v2/memory', unifiedMemoryHandler);

    // =============================================================================
    // ASYNC-FIRST MEMORY STORAGE ENDPOINT (Target: <200ms response time)
    // =============================================================================
    // This endpoint returns immediately after storing to PostgreSQL + Qdrant.
    // Entity extraction and Neo4j storage happen in background via BullMQ.
    // Use this endpoint when latency is critical.
    const asyncMemoryHandler = async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const body = req.body;

        // Build store request
        const storeRequest: UnifiedStoreRequest = {
          content: body.content,
          userId: body.userId || tenantContext.userId || 'anonymous',
          companyId: tenantContext.companyId,
          sessionId: body.sessionId || tenantContext.sessionId,
          appId: body.appId || tenantContext.appId,
          metadata: body.metadata,
          tags: body.tags,
          forceEntityExtraction: body.forceEntityExtraction,
          forceEpisodicStorage: body.forceEpisodicStorage,
          preIdentifiedEntities: body.preIdentifiedEntities,
          episodeType: body.episodeType,
          importance: body.importance
        };

        // Use same effective tenant context as the synchronous endpoint
        const effectiveTenantContext: EnhancedTenantContext = {
          ...tenantContext,
          companyId: tenantContext.companyId,
          appId: body.appId || tenantContext.appId,
          userId: body.userId || tenantContext.userId,
          source: 'headers' as const
        };

        // Call async-first storage (target: <200ms)
        const result = await this.unifiedMemoryRouter.storeMemoryAsync(
          storeRequest,
          effectiveTenantContext
        );

        return res.status(202).json({
          success: true,
          memoryId: result.memoryId,
          status: result.status,
          enrichment: result.enrichment,
          storagePaths: result.storagePaths,
          contentHash: result.contentHash,
          latencyMs: result.latencyMs,
          _note: 'Memory accepted. Entity/fact extraction in background.'
        });
      } catch (error) {
        return _next(error);
      }
    };

    // Register async endpoint at BOTH paths
    this.app.post('/graphrag/api/v2/memory/async', asyncMemoryHandler);
    this.app.post('/api/v2/memory/async', asyncMemoryHandler);

    // REMOVED: /api/memory/store - use /api/v2/memory instead
    // All memory storage now goes through the unified endpoint

    // Enhanced retrieval endpoint (alias for /api/enhanced-retrieve)
    this.app.post('/graphrag/api/retrieve/enhanced', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const enhancedRequest = req.body as EnhancedRetrievalRequest;

        if (!enhancedRequest.query) {
          return res.status(400).json({
            error: {
              message: 'Query is required',
              code: 'MISSING_QUERY'
            }
          });
        }

        // Set defaults
        enhancedRequest.include_episodic = enhancedRequest.include_episodic !== false;
        enhancedRequest.include_documents = enhancedRequest.include_documents !== false;
        enhancedRequest.max_tokens = enhancedRequest.max_tokens || 4000;

        const tenantContext = req.tenantContext!;

        // Add timeout protection to prevent hanging requests (30 seconds max)
        const RETRIEVAL_TIMEOUT_MS = 30000;
        const result = await Promise.race([
          this.unifiedMemoryEngine.retrieve(enhancedRequest, tenantContext),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Retrieval timeout: operation exceeded 30 seconds')), RETRIEVAL_TIMEOUT_MS)
          )
        ]);

        return res.json({
          success: true,
          unified_memories: result.unified_memories,
          episodic_context: result.episodic_context,
          document_context: result.document_context,
          entities_mentioned: result.entities_mentioned,
          relevant_facts: result.relevant_facts,
          suggested_followups: result.suggested_followups,
          metadata: {
            query: enhancedRequest.query,
            timestamp: new Date().toISOString(),
            episodic_enabled: enhancedRequest.include_episodic,
            documents_enabled: enhancedRequest.include_documents
          }
        });

      } catch (error) {
        return _next(error);
      }
    });

    // REMOVED: All legacy episode endpoints deleted - use /api/v2/memory and /api/retrieve/enhanced only
    // Deleted: POST /graphrag/api/episodes/recall, GET /graphrag/api/episodes/:id

    // Search documents (hybrid search: vector + metadata + full-text)
    // Fixes "manus.ai" search failure by using vector similarity + metadata matching
    this.app.post('/graphrag/api/search', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { query, filters = {}, limit = 20, offset = 0, includeMetadata = true } = req.body;

        if (!query) {
          return res.status(400).json({
            error: {
              message: 'Search query is required',
              code: 'MISSING_QUERY'
            }
          });
        }

        logger.info('Hybrid search request', { query, filters, limit, offset });

        // Use hybrid search engine
        const searchResult = await this.hybridSearchEngine.search(query, {
          filters,
          limit,
          offset,
          includeMetadata
        });

        // Format response for backwards compatibility
        const response = {
          // Group by type for backwards compatibility
          documents: searchResult.byType.documents.map(item => ({
            id: item.id,
            title: item.title || '',
            type: item.type,
            format: item.metadata?.format || 'unknown',
            tags: item.tags || [],
            source: item.source || '',
            created_at: item.created_at,
            relevance: item.score,
            matchSources: item.sources // ['vector', 'metadata', 'fts']
          })),
          memories: searchResult.byType.memories.map(item => ({
            id: item.id,
            content: item.content,
            tags: item.tags || [],
            timestamp: item.created_at,
            relevance: item.score
          })),
          episodes: searchResult.byType.episodes.map(item => ({
            id: item.id,
            content: item.content,
            type: item.type,
            timestamp: item.created_at,
            relevance: item.score
          })),
          entities: searchResult.byType.entities.map(item => ({
            id: item.id,
            content: item.content,
            domain: item.metadata?.domain || 'unknown',
            entityType: item.metadata?.entityType || 'unknown',
            relevance: item.score
          })),
          pagination: searchResult.pagination,
          performance: searchResult.performance
        };

        return res.json(response);

      } catch (error: any) {
        logger.error('Hybrid search failed', {
          error: error.message,
          stack: error.stack,
          query: req.body.query
        });
        return _next(error);
      }
    });

    // REMOVED: POST /graphrag/api/memory/search - use /api/retrieve/enhanced instead

    // ========== PHASE 4: ADVANCED SEARCH & RECOMMENDATIONS ==========

    // Advanced semantic search with query expansion and re-ranking
    this.app.post('/graphrag/api/search/advanced', extractTenantContext, async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { query, filters = {}, limit = 20, options = {} } = req.body;

        if (!query) {
          return res.status(400).json({
            error: {
              message: 'Search query is required',
              code: 'MISSING_QUERY'
            }
          });
        }

        logger.info('Advanced semantic search request', { query, filters, limit });

        const result = await this.advancedSearchEngine.search(query, tenantContext, {
          filters,
          limit,
          ...options
        });

        return res.json({
          success: true,
          results: result.results,
          clusters: result.clusters,
          queryInsights: result.queryInsights,
          performance: result.performance
        });

      } catch (error: any) {
        logger.error('Advanced search failed', {
          error: error.message,
          stack: error.stack,
          query: req.body.query
        });
        return _next(error);
      }
    });

    // Get personalized recommendations
    this.app.post('/graphrag/api/recommendations', extractTenantContext, async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { basedOn, filters, limit = 10 } = req.body;

        logger.info('Recommendations request', { basedOn, filters, limit });

        const result = await this.recommendationsEngine.getRecommendations({
          tenantContext,
          basedOn,
          filters,
          limit
        });

        return res.json({
          success: true,
          recommendations: result.recommendations,
          reasons: result.reasons
        });

      } catch (error: any) {
        logger.error('Recommendations failed', {
          error: error.message,
          stack: error.stack
        });
        return _next(error);
      }
    });

    // Get related entities for content
    this.app.get('/graphrag/api/content/:contentId/entities', extractTenantContext, async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { contentId } = req.params;
        const limit = parseInt(req.query.limit as string) || 5;

        const entities = await this.recommendationsEngine.getRelatedEntities(
          contentId,
          tenantContext,
          limit
        );

        return res.json({
          success: true,
          entities
        });

      } catch (error: any) {
        logger.error('Get related entities failed', {
          error: error.message,
          contentId: req.params.contentId
        });
        return _next(error);
      }
    });

    // ========== EPISODIC MEMORY ENDPOINTS (Graphiti) - ALL REMOVED ==========
    // REMOVED: All legacy episode endpoints - use /api/v2/memory and /api/retrieve/enhanced instead
    // Deleted: POST /graphrag/api/episodes (use /api/v2/memory with forceEpisodicStorage: true)
    // Deleted: POST /graphrag/api/episodes/recall (use /api/retrieve/enhanced)
    // Deleted: GET /graphrag/api/episodes/:id
    // Deleted: POST /graphrag/api/enhanced-retrieve (use /api/retrieve/enhanced)
    // Deleted: POST /graphrag/api/episodes/response (use /api/v2/memory)

    // REMOVED: Duplicate GET /api/entities/:id endpoint that used Graphiti service
    // This was conflicting with the Universal Entity System endpoint at line 3200
    // which uses EntityManager (PostgreSQL). Entities created via POST /api/entities
    // are stored in PostgreSQL, not Graphiti/Neo4j, so this endpoint always returned 404.
    //
    // The correct endpoint is now at line 3200 using entityManager.getById()

    // Get entity history (hybrid: PostgreSQL entity + Neo4j episodes)
    // Uses Universal Entity System for entity lookup, Graphiti for episode history
    this.app.get('/graphrag/api/entities/:id/history', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { id } = req.params;
        parseInt(req.query.limit as string) || 20;

        // First, verify entity exists in Universal Entity System (PostgreSQL)
        const entity = await this.entityManager.getById(id);

        if (!entity) {
          return res.status(404).json({
            error: {
              message: `Entity not found: ${id}`,
              code: 'ENTITY_NOT_FOUND',
              suggestion: 'Verify the entity ID is correct. Use POST /api/entities/query to search for entities.'
            }
          });
        }

        // Get episode history from Graphiti using entity ID
        let episodes: any[] = [];

        try {
          episodes = await this.graphitiService.getEntityHistory(id, tenantContext);

          logger.debug('Entity history retrieved', {
            entityId: id,
            episodeCount: episodes.length
          });

        } catch (graphitiError: any) {
          // Graceful degradation: if Graphiti unavailable, return empty episodes with warning
          logger.warn('Graphiti unavailable for entity history', {
            entityId: id,
            error: graphitiError.message
          });

          episodes = [];
        }

        return res.json({
          success: true,
          entity_id: id,
          entity: {
            id: entity.id,
            domain: entity.domain,
            entityType: entity.entityType,
            textContent: entity.textContent?.substring(0, 200),
            created_at: entity.createdAt
          },
          data: {
            episodes,
            count: episodes.length
          },
          metadata: {
            query_method: 'hybrid',
            entity_source: 'postgresql',
            episodes_source: 'graphiti',
            timestamp: new Date().toISOString()
          }
        });

      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to get entity history');
      }
    });

    // Get facts about a subject/object
    this.app.get('/graphrag/api/facts', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { subject } = req.query;

        if (!subject) {
          return res.status(400).json({
            error: {
              message: 'Subject parameter is required',
              code: 'MISSING_SUBJECT'
            }
          });
        }

        const facts = await this.graphitiService.getFacts(subject as string, tenantContext);

        return res.json({
          subject,
          facts,
          count: facts.length
        });

      } catch (error) {
        return _next(error);
      }
    });

    // POST version of facts endpoint (for MCP compatibility)
    this.app.post('/graphrag/api/facts', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { subject } = req.body;

        if (!subject) {
          return res.status(400).json({
            error: {
              message: 'Subject is required',
              code: 'MISSING_SUBJECT'
            }
          });
        }

        const facts = await this.graphitiService.getFacts(subject, tenantContext);

        return res.json({
          success: true,
          subject,
          facts,
          count: facts.length
        });

      } catch (error) {
        return _next(error);
      }
    });

    // POST version with /entities prefix (for MCP tool nexus_get_facts compatibility)
    this.app.post('/graphrag/api/entities/facts', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { subject } = req.body;

        if (!subject) {
          return res.status(400).json({
            error: {
              message: 'Subject is required',
              code: 'MISSING_SUBJECT'
            }
          });
        }

        const facts = await this.graphitiService.getFacts(subject, tenantContext);

        return res.json({
          success: true,
          subject,
          facts,
          count: facts.length
        });

      } catch (error) {
        return _next(error);
      }
    });

    // Clear session context
    this.app.delete('/graphrag/api/sessions/:id/context', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { id } = req.params;
        this.unifiedMemoryEngine.clearSessionContext(id);

        return res.json({
          success: true,
          message: 'Session context cleared'
        });

      } catch (error) {
        return _next(error);
      }
    });

    // ============ Universal Entity System Endpoints ============

    // Store entity (universal entity system)
    this.app.post('/graphrag/api/entities', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const entityRequest = req.body as CreateUniversalEntityRequest;

        if (!entityRequest.domain || !entityRequest.entityType) {
          return res.status(400).json({
            error: {
              message: 'Domain and entityType are required',
              code: 'MISSING_REQUIRED_FIELDS'
            }
          });
        }

        const entity = await this.entityManager.create(entityRequest);

        return res.status(201).json({
          success: true,
          entity_id: entity.id,
          domain: entity.domain,
          entity_type: entity.entityType,
          hierarchy_level: entity.hierarchyLevel,
          message: 'Entity stored successfully'
        });

      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to store entity');
      }
    });

    // Get entity by ID
    this.app.get('/graphrag/api/entities/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { id } = req.params;

        const entity = await this.entityManager.getById(id);

        if (!entity) {
          return res.status(404).json({
            error: {
              message: 'Entity not found',
              code: 'NOT_FOUND'
            }
          });
        }

        return res.json({
          success: true,
          entity,
          entityId: entity.id
        });

      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to get entity');
      }
    });

    // Update entity by ID
    this.app.patch('/graphrag/api/entities/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { id } = req.params;
        const updates = req.body;

        const entity = await this.entityManager.update({ id, ...updates });

        if (!entity) {
          return res.status(404).json({
            error: {
              message: 'Entity not found',
              code: 'NOT_FOUND'
            }
          });
        }

        return res.json({
          success: true,
          entity,
          entityId: entity.id,
          message: 'Entity updated successfully'
        });

      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to update entity');
      }
    });

    // Query entities
    this.app.post('/graphrag/api/entities/query', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const query = req.body as UniversalEntityQuery;

        const result = await this.entityManager.query(query);

        return res.json({
          success: true,
          entities: result.entities,
          total_count: result.totalCount,
          hierarchy: result.hierarchy,
          metadata: {
            domain: query.domain,
            entity_type: query.entityType,
            search_text: query.searchText,
            timestamp: new Date().toISOString()
          }
        });

      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to query entities');
      }
    });

    // Cross-domain entity query
    this.app.post('/graphrag/api/entities/cross-domain', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const query = req.body as CrossDomainQuery;

        if (!query.domains || query.domains.length === 0 || !query.query) {
          return res.status(400).json({
            error: {
              message: 'Domains array and query are required',
              code: 'MISSING_REQUIRED_FIELDS'
            }
          });
        }

        const result = await this.entityManager.crossDomainQuery(query);

        return res.json({
          success: true,
          results: result.results,
          patterns: result.patterns,
          metadata: {
            domains: query.domains,
            query: query.query,
            max_results: query.maxResults,
            timestamp: new Date().toISOString()
          }
        });

      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to execute cross-domain query');
      }
    });

    // Update entity
    this.app.put('/graphrag/api/entities/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { id } = req.params;

        if (!id) {
          return res.status(400).json({
            error: { message: 'Entity ID is required', code: 'MISSING_ENTITY_ID' }
          });
        }

        // Transform API request to EntityManager format (Adapter Pattern)
        // EntityManager.update() expects UpdateUniversalEntityRequest with id as property
        const updateRequestWithId: UpdateUniversalEntityRequest = {
          id: id,
          ...req.body
        };

        const entity = await this.entityManager.update(updateRequestWithId);
        return res.json({ success: true, entity });
      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Entity update failed');
      }
    });

    // Get universal entity by ID (separate from Graphiti entities)
    this.app.get('/graphrag/api/entities/universal/:id', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { id } = req.params;

        const entity = await this.entityManager.getById(id);

        if (!entity) {
          return res.status(404).json({
            error: {
              message: `Universal entity not found: ${id}`,
              code: 'ENTITY_NOT_FOUND',
              hint: 'Use GET /api/entities/:id for Graphiti entities, or POST /api/entities/query to search universal entities'
            }
          });
        }

        return res.json({ success: true, entity, source: 'universal' });
      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Failed to retrieve universal entity');
      }
    });

    // Get entity hierarchy
    this.app.get('/graphrag/api/entities/:id/hierarchy', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const { id } = req.params;

        const hierarchy = await this.entityManager.getWithHierarchy(id);
        return res.json({ success: true, hierarchy });
      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Hierarchy query failed');
      }
    });

    // Create entity relationship
    this.app.post('/graphrag/api/entities/relationships', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const relationshipRequest = req.body;

        if (!relationshipRequest.source_entity_id || !relationshipRequest.target_entity_id) {
          return res.status(400).json({
            error: {
              message: 'Source and target entity IDs are required',
              code: 'MISSING_ENTITIES'
            }
          });
        }

        if (!relationshipRequest.relationship_type) {
          return res.status(400).json({
            error: {
              message: 'Relationship type is required',
              code: 'MISSING_RELATIONSHIP_TYPE'
            }
          });
        }

        // Transform snake_case (HTTP) to camelCase (TypeScript) - Decorator Pattern
        const transformedRequest: CreateEntityRelationshipRequest = {
          sourceEntityId: relationshipRequest.source_entity_id,
          targetEntityId: relationshipRequest.target_entity_id,
          relationshipType: relationshipRequest.relationship_type,
          weight: relationshipRequest.weight,
          directionality: relationshipRequest.directionality,
          metadata: relationshipRequest.metadata,
          reasoning: relationshipRequest.reasoning,
          createdBy: relationshipRequest.created_by
        };

        // Validate entities exist (Fail Fast principle)
        const [sourceExists, targetExists] = await Promise.all([
          this.entityManager.getById(transformedRequest.sourceEntityId),
          this.entityManager.getById(transformedRequest.targetEntityId)
        ]);

        if (!sourceExists) {
          return res.status(404).json({
            error: {
              message: `Source entity not found: ${transformedRequest.sourceEntityId}`,
              code: 'SOURCE_ENTITY_NOT_FOUND',
              entityId: transformedRequest.sourceEntityId
            }
          });
        }

        if (!targetExists) {
          return res.status(404).json({
            error: {
              message: `Target entity not found: ${transformedRequest.targetEntityId}`,
              code: 'TARGET_ENTITY_NOT_FOUND',
              entityId: transformedRequest.targetEntityId
            }
          });
        }

        const relationship = await this.entityManager.createRelationship(transformedRequest);
        return res.status(201).json({
          success: true,
          relationship,
          relationshipId: relationship.id  // Add relationshipId field for MCP client compatibility
        });
      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Relationship creation failed');
      }
    });

    // Query entity relationships
    this.app.get('/graphrag/api/entities/:id/relationships', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const tenantContext = req.tenantContext!;
        const { id } = req.params;
        const { direction = 'both' } = req.query;

        const relationships = await this.entityManager.queryRelationships(id, tenantContext, direction as any);
        return res.json({ success: true, relationships, count: relationships.length });
      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Relationship query failed');
      }
    });

    // Bulk create entities
    this.app.post('/graphrag/api/entities/bulk', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const bulkRequest = req.body;

        if (!bulkRequest.entities || !Array.isArray(bulkRequest.entities)) {
          return res.status(400).json({
            error: {
              message: 'Entities array is required',
              code: 'INVALID_BULK_REQUEST'
            }
          });
        }

        if (bulkRequest.entities.length === 0) {
          return res.status(400).json({
            error: {
              message: 'Entities array cannot be empty',
              code: 'EMPTY_ENTITIES_ARRAY'
            }
          });
        }

        const result = await this.entityManager.bulkCreate(bulkRequest);
        return res.status(201).json({
          success: true,
          created_count: result.created_count,
          failed_count: result.failed_count,
          entities: result.entities,
          errors: result.errors
        });
      } catch (error: any) {
        return this.handleDatabaseError(error, res, 'Bulk create failed');
      }
    });

    // ============ Route Aliases for MCP Tool Compatibility ============
    // NOTE: Route aliases removed - MCP tools should use canonical endpoints:
    // - POST /graphrag/api/documents (not /documents/store)
    // - GET /graphrag/api/documents (not /documents/list)
    // - POST /graphrag/api/entities (not /entities/store)
    // - GET /graphrag/api/health/voyage (not /voyage/health)

    // ============ System Stats and Management Endpoints ============

    // Consolidated statistics endpoint
    this.app.get('/graphrag/api/stats', async (_req: Request, res: Response, _next: NextFunction) => {
      try {
        // tenantContext available via req.tenantContext (set by middleware)
        const memoryStats = await this.unifiedMemoryEngine.getStats();

        // Get Qdrant stats
        const qdrantCollections = await this.qdrantClient.getCollections();
        const qdrantStats = {
          collections: qdrantCollections.collections.map(c => c.name),
          total_collections: qdrantCollections.collections.length
        };

        // Get database stats
        const dbStatsResult = await this.postgresPool.query(`
          SELECT
            (SELECT COUNT(*) FROM graphrag.unified_content WHERE content_type = 'memory') as memory_count,
            (SELECT COUNT(*) FROM graphrag.unified_content WHERE content_type = 'document') as document_count,
            (SELECT COUNT(*) FROM graphrag.unified_content WHERE content_type = 'episode') as episode_count,
            (SELECT COUNT(*) FROM graphrag.universal_entities) as entity_count
        `);

        const dbStats = dbStatsResult.rows[0];

        return res.json({
          success: true,
          statistics: {
            memory: {
              episodic: memoryStats.episodic,
              documents: memoryStats.documents,
              sessions: memoryStats.sessions,
              health: memoryStats.combined_health
            },
            database: {
              memories: parseInt(dbStats.memory_count),
              documents: parseInt(dbStats.document_count),
              episodes: parseInt(dbStats.episode_count),
              entities: parseInt(dbStats.entity_count)
            },
            qdrant: qdrantStats
          },
          timestamp: new Date().toISOString()
        });

      } catch (error: any) {
        logger.error('Failed to get statistics', { error });
        return res.status(500).json({
          error: {
            message: 'Failed to get statistics',
            code: 'STATS_RETRIEVAL_FAILED',
            details: error.message
          }
        });
      }
    });

    /**
     * GET /api/metrics/ingestion
     * Get ingestion quality metrics
     */
    this.app.get('/graphrag/api/metrics/ingestion', async (req: Request, res: Response) => {
      try {
        const hoursBack = parseInt(req.query.hours as string) || 24;

        // Get overall summary
        const summary = ingestionMetrics.getSummary(hoursBack);

        // Get performance percentiles
        const performance = ingestionMetrics.getPerformancePercentiles();

        // Get breakdown by operation
        const byOperation = ingestionMetrics.getMetricsByOperation();

        // Get recent failures for debugging
        const recentFailures = ingestionMetrics.getRecentFailures(5);

        // Get recent duplicates
        const recentDuplicates = ingestionMetrics.getRecentDuplicates(5);

        return res.json({
          success: true,
          summary,
          performance,
          byOperation,
          recentFailures: recentFailures.map(f => ({
            timestamp: f.timestamp,
            operation: f.operation,
            error: f.error,
            processingTime: f.processingTime
          })),
          recentDuplicates: recentDuplicates.map(d => ({
            timestamp: d.timestamp,
            operation: d.operation,
            documentSize: d.documentSize,
            processingTime: d.processingTime
          })),
          timestamp: new Date().toISOString()
        });

      } catch (error: any) {
        logger.error('Failed to get ingestion metrics', { error });
        return res.status(500).json({
          error: {
            message: 'Failed to get ingestion metrics',
            code: 'METRICS_RETRIEVAL_FAILED',
            details: error.message
          }
        });
      }
    });

    // Clear data endpoint
    this.app.post('/graphrag/api/data/clear', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { type, confirm } = req.body;

        if (!confirm || confirm !== true) {
          return res.status(400).json({
            error: {
              message: 'Confirmation required. Set confirm=true to proceed.',
              code: 'CONFIRMATION_REQUIRED'
            }
          });
        }

        if (!['memories', 'documents', 'episodes', 'entities', 'all'].includes(type)) {
          return res.status(400).json({
            error: {
              message: 'Invalid type. Must be one of: memories, documents, episodes, entities, all',
              code: 'INVALID_TYPE'
            }
          });
        }

        let deletedCount = 0;

        switch (type) {
          case 'memories':
            const memResult = await this.postgresPool.query(
              "DELETE FROM graphrag.unified_content WHERE content_type = 'memory'"
            );
            deletedCount = memResult.rowCount || 0;
            break;

          case 'documents':
            const docResult = await this.postgresPool.query(
              "DELETE FROM graphrag.unified_content WHERE content_type = 'document'"
            );
            deletedCount = docResult.rowCount || 0;
            break;

          case 'episodes':
            const epResult = await this.postgresPool.query(
              "DELETE FROM graphrag.unified_content WHERE content_type = 'episode'"
            );
            deletedCount = epResult.rowCount || 0;
            break;

          case 'entities':
            const entResult = await this.postgresPool.query(
              "DELETE FROM graphrag.universal_entities"
            );
            deletedCount = entResult.rowCount || 0;
            break;

          case 'all':
            const allContentResult = await this.postgresPool.query(
              "DELETE FROM graphrag.unified_content"
            );
            const allEntResult = await this.postgresPool.query(
              "DELETE FROM graphrag.universal_entities"
            );
            deletedCount = (allContentResult.rowCount || 0) + (allEntResult.rowCount || 0);

            // Also clear Qdrant collections
            try {
              await this.qdrantClient.delete('unified_content', {
                filter: {} // Delete all points
              });
            } catch (qdrantError) {
              logger.warn('Failed to clear Qdrant collection', { error: qdrantError });
            }
            break;
        }

        logger.warn('Data cleared', { type, deletedCount });

        return res.json({
          success: true,
          type,
          deleted_count: deletedCount,
          message: `Successfully cleared ${type}`,
          timestamp: new Date().toISOString()
        });

      } catch (error: any) {
        logger.error('Failed to clear data', { error, request: req.body });
        return res.status(500).json({
          error: {
            message: 'Failed to clear data',
            code: 'DATA_CLEAR_FAILED',
            details: error.message
          }
        });
      }
    });

    // ============ Orchestration & Agent System Endpoints ============
    // These endpoints proxy to MageAgent service for advanced AI orchestration

    // Execute orchestration task
    this.app.post('/graphrag/api/orchestration/execute', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: {
            message: 'MageAgent service is starting up or unavailable',
            code: 'SERVICE_UNAVAILABLE',
            details: 'Orchestration features are temporarily disabled while MageAgent initializes.',
            workaround: 'You can call MageAgent directly at http://nexus-mageagent:8080/api/orchestrate',
            retry_after: 30,
            auto_recovery: 'Service will auto-enable when MageAgent becomes healthy (checks every 60s)'
          }
        });
      }

      try {
        const { task, maxAgents = 3, timeout = 60000, context } = req.body;

        if (!task) {
          return res.status(400).json({
            error: { message: 'Task is required', code: 'MISSING_TASK' }
          });
        }

        const mageResponse = await fetch('http://nexus-mageagent:8080/api/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, maxAgents, timeout, context }),
          signal: AbortSignal.timeout(timeout + 5000)
        });

        if (!mageResponse.ok) {
          throw new Error(`MageAgent returned ${mageResponse.status}: ${await mageResponse.text()}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Orchestration execution failed', { error: error.message, task: req.body?.task });
        return res.status(500).json({
          error: {
            message: 'Orchestration execution failed',
            code: 'ORCHESTRATION_FAILED',
            details: error.message
          }
        });
      }
    });

    // Agent competition
    this.app.post('/graphrag/api/orchestration/competition', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { challenge, competitorCount = 3, evaluationCriteria, timeout = 90000 } = req.body;

        if (!challenge) {
          return res.status(400).json({
            error: { message: 'Challenge is required', code: 'MISSING_CHALLENGE' }
          });
        }

        const mageResponse = await fetch('http://nexus-mageagent:8080/api/competition', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge, competitorCount, evaluationCriteria, timeout }),
          signal: AbortSignal.timeout(timeout + 5000)
        });

        if (!mageResponse.ok) {
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Agent competition failed', { error: error.message });
        return res.status(500).json({
          error: { message: 'Agent competition failed', code: 'COMPETITION_FAILED', details: error.message }
        });
      }
    });

    // Agent collaboration - uses orchestrate with collaboration task
    this.app.post('/graphrag/api/orchestration/collaborate', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { objective, agents, iterations = 2 } = req.body;

        if (!objective) {
          return res.status(400).json({
            error: { message: 'Objective is required', code: 'MISSING_OBJECTIVE' }
          });
        }

        // Convert to orchestrate task format
        const task = `Collaborate on this objective with ${iterations} iterations: ${objective}`;
        const context = { agents, iterations, collaboration: true };

        const mageResponse = await fetch('http://nexus-mageagent:8080/api/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, maxAgents: agents?.length || 3, timeout: 120000, context }),
          signal: AbortSignal.timeout(125000)
        });

        if (!mageResponse.ok) {
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Agent collaboration failed', { error: error.message });
        return res.status(500).json({
          error: { message: 'Collaboration failed', code: 'COLLABORATION_FAILED', details: error.message }
        });
      }
    });

    // Analyze topic - uses orchestrate with analysis task
    this.app.post('/graphrag/api/orchestration/analyze', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { topic, depth = 'standard', includeMemory = true } = req.body;

        if (!topic) {
          return res.status(400).json({
            error: { message: 'Topic is required', code: 'MISSING_TOPIC' }
          });
        }

        // Convert to orchestrate task format
        const task = `Perform ${depth} depth analysis on topic: ${topic}${includeMemory ? ' (include memory context)' : ''}`;
        const context = { topic, depth, includeMemory, analysis: true };
        const maxAgents = depth === 'deep' ? 5 : depth === 'standard' ? 3 : 1;

        const mageResponse = await fetch('http://nexus-mageagent:8080/api/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, maxAgents, timeout: 120000, context }),
          signal: AbortSignal.timeout(125000)
        });

        if (!mageResponse.ok) {
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Topic analysis failed', { error: error.message });
        return res.status(500).json({
          error: { message: 'Analysis failed', code: 'ANALYSIS_FAILED', details: error.message }
        });
      }
    });

    // Synthesize sources - uses orchestrate with synthesis task
    this.app.post('/graphrag/api/orchestration/synthesize', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { sources, format = 'summary', objective } = req.body;

        if (!sources || !Array.isArray(sources) || sources.length === 0) {
          return res.status(400).json({
            error: { message: 'Sources array is required', code: 'MISSING_SOURCES' }
          });
        }

        // Convert to orchestrate task format
        const sourcesText = sources.join('\n\n---\n\n');
        const task = `Synthesize these ${sources.length} sources into a ${format}${objective ? ` for: ${objective}` : ''}:\n\n${sourcesText}`;
        const context = { sources, format, objective, synthesis: true };

        const mageResponse = await fetch('http://nexus-mageagent:8080/api/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, maxAgents: 2, timeout: 90000, context }),
          signal: AbortSignal.timeout(95000)
        });

        if (!mageResponse.ok) {
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Source synthesis failed', { error: error.message });
        return res.status(500).json({
          error: { message: 'Synthesis failed', code: 'SYNTHESIS_FAILED', details: error.message }
        });
      }
    });

    // Store pattern
    this.app.post('/graphrag/api/orchestration/patterns/store', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { pattern, context, confidence, tags } = req.body;

        if (!pattern || !context) {
          return res.status(400).json({
            error: { message: 'Pattern and context are required', code: 'MISSING_REQUIRED_FIELDS' }
          });
        }

        const mageResponse = await fetch('http://nexus-mageagent:8080/api/patterns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern, context, confidence, tags }),
          signal: AbortSignal.timeout(30000)
        });

        if (!mageResponse.ok) {
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Pattern storage failed', { error: error.message });
        return res.status(500).json({
          error: { message: 'Pattern storage failed', code: 'PATTERN_STORAGE_FAILED', details: error.message }
        });
      }
    });

    // Get task status
    this.app.get('/graphrag/api/tasks/:taskId/status', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { taskId } = req.params;

        const mageResponse = await fetch(`http://nexus-mageagent:8080/api/tasks/${taskId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000)
        });

        if (!mageResponse.ok) {
          if (mageResponse.status === 404) {
            return res.status(404).json({
              error: { message: 'Task not found', code: 'TASK_NOT_FOUND' }
            });
          }
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Task status retrieval failed', { error: error.message, taskId: req.params.taskId });
        return res.status(500).json({
          error: { message: 'Task status retrieval failed', code: 'STATUS_RETRIEVAL_FAILED', details: error.message }
        });
      }
    });

    // Get agent details
    this.app.get('/graphrag/api/agents/:agentId/details', async (req: Request, res: Response, _next: NextFunction) => {
      if (!this.mageAgentHealthy) {
        return res.status(503).json({
          error: { message: 'MageAgent service unavailable', code: 'SERVICE_UNAVAILABLE' }
        });
      }

      try {
        const { agentId } = req.params;

        const mageResponse = await fetch(`http://nexus-mageagent:8080/api/agents/${agentId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000)
        });

        if (!mageResponse.ok) {
          if (mageResponse.status === 404) {
            return res.status(404).json({
              error: { message: 'Agent not found', code: 'AGENT_NOT_FOUND' }
            });
          }
          throw new Error(`MageAgent returned ${mageResponse.status}`);
        }

        const result = await mageResponse.json();
        return res.json(result);
      } catch (error: any) {
        logger.error('Agent details retrieval failed', { error: error.message, agentId: req.params.agentId });
        return res.status(500).json({
          error: { message: 'Agent details retrieval failed', code: 'AGENT_DETAILS_FAILED', details: error.message }
        });
      }
    });

    // WebSocket endpoint info (enhanced)
    this.app.get('/graphrag/api/websocket', (req: Request, res: Response) => {
      return res.json({
        url: `ws://${req.get('host')}/ws`,
        protocol: 'graphrag-streaming',
        version: '2.0.0',
        features: ['documents', 'memories', 'unified-search', 'episodic']
      });
    });

    // WebSocket emit endpoint - allows external services to broadcast events to rooms
    // Used by MageAgent TaskManager to stream task progress to subscribed clients
    this.app.post('/graphrag/api/websocket/emit', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const { room, event, data } = req.body;

        // Validate required fields
        if (!room || !event || !data) {
          return res.status(400).json({
            success: false,
            error: {
              message: 'Missing required fields: room, event, and data are required',
              code: 'MISSING_REQUIRED_FIELDS'
            }
          });
        }

        // Emit to the specified room via GraphRAG WebSocket server
        this.graphragWS.emitToRoom(room, event, data);

        // Get subscriber count for the room
        const subscriberCount = this.graphragWS.getRoomSubscriberCount(room);

        return res.json({
          success: true,
          room,
          event,
          subscribers: subscriberCount,
          message: 'Event emitted to room successfully',
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        logger.error('WebSocket emit failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
          body: req.body
        });

        return res.status(500).json({
          success: false,
          error: {
            message: 'Failed to emit WebSocket event',
            code: 'WEBSOCKET_EMIT_FAILED',
            details: error instanceof Error ? error.message : 'Unknown error'
          }
        });
      }
    });

    // WebSocket stats endpoint - get active rooms and subscribers
    this.app.get('/graphrag/api/websocket/stats', async (_req: Request, res: Response, _next: NextFunction) => {
      try {
        const stats = this.graphragWS.getStats();
        const activeRooms = this.graphragWS.getActiveRooms();

        return res.json({
          success: true,
          stats,
          activeRooms,
          roomCount: activeRooms.length,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        logger.error('WebSocket stats retrieval failed', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        return res.status(500).json({
          success: false,
          error: {
            message: 'Failed to retrieve WebSocket stats',
            code: 'WEBSOCKET_STATS_FAILED'
          }
        });
      }
    });

    // WebSocket info endpoint - comprehensive connection information
    this.app.get('/api/websocket/info', async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const stats = this.graphragWS.getStats();
        const activeRooms = this.graphragWS.getActiveRooms();
        const host = req.get('host') || 'localhost:8090';

        return res.json({
          success: true,
          websocket: {
            url: `ws://${host}/graphrag`,
            internalUrl: 'ws://nexus-graphrag:8091/graphrag',
            protocol: 'socket.io',
            version: '4.x',
            namespace: '/graphrag',
            transports: ['websocket', 'polling']
          },
          health: {
            connected: stats.connected || 0,
            healthy: true,
            uptime: process.uptime()
          },
          features: {
            multiAgentOrchestration: true,
            realTimeProgress: true,
            taskSubscription: true,
            nexusMemoryIntegration: true
          },
          rooms: {
            active: activeRooms,
            count: activeRooms.length
          },
          usage: {
            totalConnections: stats.totalConnections || 0,
            activeConnections: stats.connected || 0,
            messagesProcessed: stats.messagesProcessed || 0
          },
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        logger.error('WebSocket info retrieval failed', {
          error: error instanceof Error ? error.message : 'Unknown error'
        });

        return res.status(500).json({
          success: false,
          error: {
            message: 'Failed to retrieve WebSocket info',
            code: 'WEBSOCKET_INFO_FAILED'
          }
        });
      }
    });

    // OAuth routes placeholder - will be populated during start() after OAuth manager is initialized
    // This middleware checks if OAuth routes are available and forwards requests to them
    this.app.use('/auth', (req: Request, res: Response, next: NextFunction) => {
      logger.info('OAuth middleware hit', {
        path: req.path,
        hasPlaceholder: !!this.oauthRoutesPlaceholder
      });

      if (this.oauthRoutesPlaceholder) {
        // Call the router as middleware
        return this.oauthRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('OAuth routes not initialized');
        return res.status(503).json({
          error: {
            message: 'OAuth authentication not initialized',
            code: 'AUTH_NOT_INITIALIZED'
          }
        });
      }
    });

    // GDPR routes placeholder - will be populated during start() after services are initialized
    // This middleware handles GDPR data export/deletion requests
    this.app.use('/api/user', (req: Request, res: Response, next: NextFunction) => {
      if (this.gdprRoutesPlaceholder) {
        // Call the router as middleware
        return this.gdprRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('GDPR routes not initialized');
        return res.status(503).json({
          error: {
            message: 'GDPR service not initialized',
            code: 'GDPR_NOT_INITIALIZED'
          }
        });
      }
    });

    // Billing routes placeholder (Phase 3: Billing & Quota Enforcement)
    // This middleware handles subscription, usage, and quota endpoints
    this.app.use('/api/billing', (req: Request, res: Response, next: NextFunction) => {
      if (this.billingRoutesPlaceholder) {
        return this.billingRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('Billing routes not initialized');
        return res.status(503).json({
          error: {
            message: 'Billing service not initialized',
            code: 'BILLING_NOT_INITIALIZED'
          }
        });
      }
    });

    // Collaborative memory routes placeholder (Phase 4: Advanced Features)
    // This middleware handles memory sharing, versioning, and collaboration
    this.app.use('/api/memory', (req: Request, res: Response, next: NextFunction) => {
      if (this.collaborativeMemoryRoutesPlaceholder) {
        return this.collaborativeMemoryRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('Collaborative memory routes not initialized');
        return res.status(503).json({
          error: {
            message: 'Collaborative memory service not initialized',
            code: 'COLLABORATIVE_MEMORY_NOT_INITIALIZED'
          }
        });
      }
    });

    // Memory Lens Relevance routes (Nexus Memory Lens feature)
    // This middleware handles relevance-based retrieval, decay scoring, and access tracking
    this.app.use('/api/relevance', (req: Request, res: Response, next: NextFunction) => {
      if (this.relevanceRoutesPlaceholder) {
        return this.relevanceRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('Relevance routes not initialized');
        return res.status(503).json({
          error: {
            message: 'Memory Lens Relevance service not initialized',
            code: 'RELEVANCE_NOT_INITIALIZED'
          }
        });
      }
    });

    // Service Catalog routes (Living Service Knowledge Graph)
    // This middleware handles service registration, capability matching, and performance metrics
    this.app.use('/api/v1/service-catalog', (req: Request, res: Response, next: NextFunction) => {
      if (this.serviceCatalogRoutesPlaceholder) {
        return this.serviceCatalogRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('Service Catalog routes not initialized');
        return res.status(503).json({
          error: {
            message: 'Service Catalog not initialized',
            code: 'SERVICE_CATALOG_NOT_INITIALIZED'
          }
        });
      }
    });

    // Data Explorer routes (Dashboard Data Explorer feature)
    // This middleware handles graph visualization, entity exploration, geo mapping, and admin stats
    this.app.use('/api/v1/data-explorer', (req: Request, res: Response, next: NextFunction) => {
      if (this.dataExplorerRoutesPlaceholder) {
        return this.dataExplorerRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('Data Explorer routes not initialized');
        return res.status(503).json({
          error: {
            message: 'Data Explorer service not initialized',
            code: 'DATA_EXPLORER_NOT_INITIALIZED'
          }
        });
      }
    });

    // Admin routes (part of Data Explorer feature)
    this.app.use('/api/v1/admin', (req: Request, res: Response, next: NextFunction) => {
      if (this.dataExplorerRoutesPlaceholder) {
        return this.dataExplorerRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('Admin routes not initialized');
        return res.status(503).json({
          error: {
            message: 'Admin service not initialized',
            code: 'ADMIN_NOT_INITIALIZED'
          }
        });
      }
    });

    // GraphRAG API routes (frontend compatibility)
    // Frontend calls /graphrag/api/entities/query, /graphrag/api/graph/export, etc.
    // Istio preserves /graphrag/ prefix when routing to this service (no rewrite)
    this.app.use('/graphrag/api', (req: Request, res: Response, next: NextFunction) => {
      if (this.dataExplorerRoutesPlaceholder) {
        return this.dataExplorerRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('GraphRAG API routes not initialized');
        return res.status(503).json({
          error: {
            message: 'GraphRAG API not initialized',
            code: 'GRAPHRAG_API_NOT_INITIALIZED'
          }
        });
      }
    });

    // API routes (Istio rewrite compatibility)
    // Istio nexus-api-routes VirtualService rewrites /graphrag/ to /
    // So /graphrag/api/entities/query becomes /api/entities/query
    this.app.use('/api', (req: Request, res: Response, next: NextFunction) => {
      if (this.dataExplorerRoutesPlaceholder) {
        return this.dataExplorerRoutesPlaceholder(req, res, next);
      } else {
        logger.warn('API routes not initialized');
        return res.status(503).json({
          error: {
            message: 'API not initialized',
            code: 'API_NOT_INITIALIZED'
          }
        });
      }
    });

    // 404 handler - MUST be last
    this.app.use((req: Request, res: Response) => {
      return res.status(404).json({
        error: {
          message: 'Endpoint not found',
          code: 'NOT_FOUND',
          path: req.path
        }
      });
    });
  }

  private setupWebSocket() {
    this.server = createServer(this.app);

    // Initialize the GraphRAG WebSocket server with Socket.io
    this.graphragWS = new GraphRAGWebSocketServer(this.server);
    this.graphragWS.start();

    // Also create standard WebSocket for backwards compatibility
    const wsServer = createServer();
    this.wss = new WebSocketServer({
      server: wsServer,
      path: '/ws'
    });

    // Start WebSocket server on port 8091
    wsServer.listen(8091, () => {
      logger.info('Standard WebSocket server started on port 8091 at /ws');
      logger.info('GraphRAG Socket.io WebSocket available at:');
      logger.info('  - Main namespace: ws://graphrag:8090/graphrag');
      logger.info('  - Memory namespace: ws://graphrag:8090/graphrag/memory');
      logger.info('  - Documents namespace: ws://graphrag:8090/graphrag/documents');
      logger.info('  - Search namespace: ws://graphrag:8090/graphrag/search');
    });

    this.wss.on('connection', (ws, req) => {
      logger.info('WebSocket connection established', { url: req.url });

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          
          switch (data.type) {
            case 'subscribe':
              await this.handleSubscribe(ws, data);
              break;
            case 'unsubscribe':
              await this.handleUnsubscribe(ws, data);
              break;
            case 'stream_retrieval':
              await this.handleStreamRetrieval(ws, data);
              break;
            case 'stream_memory_updates':
              await this.handleStreamMemoryUpdates(ws, data);
              break;
            default:
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Unknown message type'
              }));
          }
        } catch (error) {
          logger.error('WebSocket message error', { error });
          ws.send(JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
      });

      ws.on('close', () => {
        logger.info('WebSocket connection closed');
      });

      ws.on('error', (error) => {
        logger.error('WebSocket error', { error });
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to Unified GraphRAG WebSocket',
        features: ['documents', 'memories', 'streaming']
      }));
    });
  }

  private async handleSubscribe(ws: any, data: any) {
    // Subscribe to document updates, chunk processing, etc.
    ws.subscriptions = ws.subscriptions || new Set();
    ws.subscriptions.add(data.channel);
    
    ws.send(JSON.stringify({
      type: 'subscribed',
      channel: data.channel
    }));
  }

  private async handleUnsubscribe(ws: any, data: any) {
    if (ws.subscriptions) {
      ws.subscriptions.delete(data.channel);
    }
    
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      channel: data.channel
    }));
  }

  private async handleStreamRetrieval(ws: any, data: any) {
    // Stream retrieval results chunk by chunk
    const { query, options } = data;

    // Default tenant context if not provided (for backward compatibility)
    // Context: tenantContext || { userId: 'anonymous', tenantId: 'default', sessionId: 'ws-session' }

    try {
      // Start retrieval
      ws.send(JSON.stringify({
        type: 'stream_start',
        query
      }));

      // Perform retrieval (simplified - in real implementation, stream chunks)
      const result = await this.retrievalEngine.retrieve(query, options);
      
      // Send chunks
      const chunks = result.chunks || [];
      for (const chunk of chunks) {
        ws.send(JSON.stringify({
          type: 'stream_chunk',
          chunk: {
            id: chunk.id,
            content: chunk.content,
            metadata: chunk.metadata
          }
        }));
        
        // Small delay to simulate streaming
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Send completion
      ws.send(JSON.stringify({
        type: 'stream_complete',
        metadata: result.metadata,
        relevanceScore: result.relevanceScore
      }));

    } catch (error) {
      ws.send(JSON.stringify({
        type: 'stream_error',
        error: error instanceof Error ? error.message : 'Unknown error'
      }));
    }
  }

  private async handleStreamMemoryUpdates(ws: any, data: any) {
    // Stream memory updates in real-time
    const { sessionId } = data;
    
    ws.send(JSON.stringify({
      type: 'memory_stream_started',
      sessionId
    }));

    // Subscribe to Redis pubsub for real-time memory updates
    const subscriber = this.redisClient.duplicate();
    await subscriber.subscribe(`memory:updates:${sessionId}`);
    
    subscriber.on('message', (_channel, message) => {
      ws.send(JSON.stringify({
        type: 'memory_update',
        data: JSON.parse(message)
      }));
    });

    ws.on('close', () => {
      subscriber.unsubscribe();
      subscriber.disconnect();
    });
  }

  // Helper methods for document processing
  private async getDocumentChunks(documentId: string): Promise<any[]> {
    const client = await this.postgresPool.connect();
    try {
      const result = await client.query(
        'SELECT id, content, chunk_index, metadata FROM graphrag.document_chunks WHERE document_id = $1 ORDER BY chunk_index',
        [documentId]
      );
      return result.rows.map(row => ({
        id: row.id,
        content: row.content,
        chunk_index: row.chunk_index,
        metadata: row.metadata
      }));
    } finally {
      client.release();
    }
  }

  private async createDocumentChunks(documentId: string, content: string): Promise<any[]> {
    const chunkSize = 1000;
    const overlap = 200;
    const chunks = [];

    for (let i = 0; i < content.length; i += chunkSize - overlap) {
      const chunk = content.slice(i, i + chunkSize);
      chunks.push({
        id: `${documentId}_chunk_${i}`,
        documentId,
        content: chunk,
        index: Math.floor(i / (chunkSize - overlap)),
        metadata: {
          start: i,
          end: Math.min(i + chunkSize, content.length)
        }
      });
    }

    // Store chunks in database
    const client = await this.postgresPool.connect();
    try {
      await client.query('BEGIN');

      // Ensure chunks table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS graphrag.document_chunks (
          id TEXT PRIMARY KEY,
          document_id UUID REFERENCES graphrag.documents(id) ON DELETE CASCADE,
          chunk_index INTEGER,
          content TEXT,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Delete existing chunks
      await client.query('DELETE FROM graphrag.document_chunks WHERE document_id = $1', [documentId]);

      // Insert new chunks
      for (const chunk of chunks) {
        await client.query(`
          INSERT INTO graphrag.document_chunks (id, document_id, chunk_index, content, metadata)
          VALUES ($1, $2, $3, $4, $5)
        `, [chunk.id, chunk.documentId, chunk.index, chunk.content, JSON.stringify(chunk.metadata)]);
      }

      await client.query('COMMIT');

      // Generate embeddings if VoyageAI is available
      if (this.voyageClient) {
        try {
          for (const chunk of chunks) {
            const embedding = await this.voyageClient.generateEmbedding(chunk.content, {
              inputType: 'document'
            });

            await this.qdrantClient.upsert('documents', {
              points: [{
                id: chunk.id,
                vector: embedding.embedding,
                payload: {
                  documentId: chunk.documentId,
                  content: chunk.content,
                  metadata: chunk.metadata
                }
              }]
            });
          }
        } catch (error) {
          logger.warn('Failed to generate embeddings for chunks', error);
        }
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return chunks;
  }

  // Legacy methods removed - chunks are now queried directly from Qdrant
  // See GET /documents/:id/chunks and GET /chunks/:chunkId endpoints above

  private async createCustomChunks(documentId: string, content: string, options: any): Promise<any[]> {
    const { strategy, chunkSize, overlap } = options;
    const chunks = [];

    // Implement different chunking strategies
    if (strategy === 'sentence') {
      // Split by sentences
      const sentences = content.match(/[^.!?]+[.!?]+/g) || [];
      let currentChunk = '';
      let chunkIndex = 0;

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length <= chunkSize) {
          currentChunk += sentence;
        } else {
          if (currentChunk) {
            chunks.push({
              id: `${documentId}_chunk_${chunkIndex}`,
              documentId,
              content: currentChunk,
              index: chunkIndex++
            });
          }
          currentChunk = sentence;
        }
      }

      if (currentChunk) {
        chunks.push({
          id: `${documentId}_chunk_${chunkIndex}`,
          documentId,
          content: currentChunk,
          index: chunkIndex
        });
      }
    } else {
      // Default sliding window strategy
      for (let i = 0; i < content.length; i += chunkSize - overlap) {
        const chunk = content.slice(i, i + chunkSize);
        chunks.push({
          id: `${documentId}_chunk_${i}`,
          documentId,
          content: chunk,
          index: Math.floor(i / (chunkSize - overlap))
        });
      }
    }

    // Store chunks
    const client = await this.postgresPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM graphrag.document_chunks WHERE document_id = $1', [documentId]);

      for (const chunk of chunks) {
        await client.query(`
          INSERT INTO graphrag.document_chunks (id, document_id, chunk_index, content, metadata)
          VALUES ($1, $2, $3, $4, $5)
        `, [chunk.id, chunk.documentId, chunk.index, chunk.content, JSON.stringify({ strategy })]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return chunks;
  }

  private async buildDocumentGraph(documentId: string): Promise<void> {
    const session = this.neo4jDriver.session();
    try {
      // Get document content
      const client = await this.postgresPool.connect();
      let content;
      try {
        const result = await client.query(`
          SELECT dc.content, d.title
          FROM graphrag.document_content dc
          JOIN graphrag.documents d ON d.id = dc.document_id
          WHERE dc.document_id = $1
        `, [documentId]);

        if (result.rows.length === 0) {
          throw new Error('Document not found');
        }

        content = result.rows[0].content;
        const title = result.rows[0].title;

        // Create document node
        await session.run(`
          MERGE (d:Document {id: $id})
          SET d.title = $title, d.created = timestamp()
        `, { id: documentId, title });

        // Extract entities (simplified - in production, use NLP service)
        const entities = this.extractEntities(content);

        // Create entity nodes and relationships
        for (const entity of entities) {
          await session.run(`
            MERGE (e:Entity {name: $name, type: $type})
            MERGE (d:Document {id: $docId})
            MERGE (d)-[:CONTAINS]->(e)
          `, { name: entity.name, type: entity.type, docId: documentId });
        }

        // Create chunk nodes
        const chunks = await this.getDocumentChunks(documentId);
        for (const chunk of chunks) {
          await session.run(`
            MERGE (c:Chunk {id: $id})
            SET c.content = $content, c.index = $index
            MERGE (d:Document {id: $docId})
            MERGE (d)-[:HAS_CHUNK]->(c)
          `, {
            id: chunk.id,
            content: chunk.content.substring(0, 500),
            index: chunk.chunk_index,
            docId: documentId
          });
        }
      } finally {
        client.release();
      }
    } finally {
      await session.close();
    }
  }

  private extractEntities(content: string): any[] {
    // Simplified entity extraction - in production, use NLP libraries
    const entities = [];

    // Extract potential person names (capitalized words)
    const personPattern = /\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g;
    const matches = content.match(personPattern) || [];

    for (const match of matches.slice(0, 10)) {
      entities.push({ name: match, type: 'Person' });
    }

    // Extract organizations (words with Inc, Corp, etc.)
    const orgPattern = /\b([A-Z][\w]+ (?:Inc|Corp|LLC|Ltd|Company))\b/g;
    const orgMatches = content.match(orgPattern) || [];

    for (const match of orgMatches.slice(0, 10)) {
      entities.push({ name: match, type: 'Organization' });
    }

    return entities;
  }

  private async getMemoryById(id: string): Promise<any> {
    const client = await this.postgresPool.connect();
    try {
      // Ensure memories table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS graphrag.memories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content TEXT NOT NULL,
          tags TEXT[],
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const result = await client.query(`
        SELECT * FROM graphrag.memories WHERE id = $1
      `, [id]);

      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  private async listMemories(options: any): Promise<any> {
    const client = await this.postgresPool.connect();
    try {
      // Ensure memories table exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS graphrag.memories (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content TEXT NOT NULL,
          tags TEXT[],
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      const result = await client.query(`
        SELECT * FROM graphrag.memories
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [options.limit, options.offset]);

      const countResult = await client.query('SELECT COUNT(*) as total FROM graphrag.memories');

      return {
        items: result.rows,
        total: parseInt(countResult.rows[0].total)
      };
    } finally {
      client.release();
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async getDocumentMetadata(id: string): Promise<DocumentMetadata> {
    const client = await this.postgresPool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM graphrag.documents WHERE id = $1',
        [id]
      );
      
      if (result.rows.length === 0) {
        throw new Error('Document not found');
      }

      const doc = result.rows[0];
      return {
        id: doc.id,
        title: doc.title,
        type: doc.type,
        format: doc.format,
        size: doc.size,
        hash: doc.hash,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        version: doc.version,
        tags: doc.tags,
        source: doc.source,
        language: doc.language,
        encoding: doc.encoding,
        custom: doc.metadata
      };
    } finally {
      client.release();
    }
  }

  async start() {
    // Initialize all services first
    await this.initializeServices();
    logger.info('All services initialized');

    // Set OAuth authentication routes
    // These will be available through the middleware registered in setupRoutes()
    if (this.googleOAuthManager) {
      this.oauthRoutesPlaceholder = createAuthRoutes(this.googleOAuthManager);
      logger.info('OAuth authentication routes initialized at /auth');
    }

    // Initialize GDPR routes with database connections
    this.gdprRoutesPlaceholder = createGDPRRoutes(
      this.postgresPool,
      this.qdrantClient,
      this.neo4jDriver
    );
    logger.info('GDPR compliance routes initialized at /api/user');

    // Initialize billing routes (Phase 3)
    this.billingRoutesPlaceholder = createBillingRoutes(this.postgresPool);
    logger.info('Billing & subscription routes initialized at /api/billing');

    // Initialize collaborative memory routes (Phase 4)
    this.collaborativeMemoryRoutesPlaceholder = createCollaborativeMemoryRoutes(this.postgresPool);
    logger.info('Collaborative memory routes initialized at /api/memory');

    // Initialize Data Explorer routes (Dashboard Data Explorer feature)
    this.dataExplorerRoutesPlaceholder = createDataExplorerRoutes(
      this.postgresPool,
      this.qdrantClient,
      this.neo4jDriver,
      this.voyageClient,
      process.env.OPENROUTER_API_KEY
    );
    logger.info('Data Explorer routes initialized at /api/v1/data-explorer and /api/v1/admin');

    // Initialize Memory Lens Relevance routes (Nexus Memory Lens feature)
    this.relevanceRoutesPlaceholder = createRelevanceRoutes(this.postgresPool);
    logger.info('Memory Lens Relevance routes initialized at /api/relevance');

    // Initialize Service Catalog routes (Living Service Knowledge Graph)
    this.serviceCatalogRoutesPlaceholder = createServiceCatalogRoutes(
      this.postgresPool,
      config.qdrant?.url
    );
    logger.info('Service Catalog routes initialized at /api/v1/service-catalog');

    // Start Service Discovery Agent (auto-discovers and registers Nexus services)
    try {
      const serviceCatalogRepository = getServiceCatalogRepository(this.postgresPool);
      this.discoveryAgent = await createDiscoveryAgent(serviceCatalogRepository, {
        pollIntervalMs: 60000, // Check every minute
        healthCheckTimeoutMs: 5000, // 5 second timeout
        maxConcurrentChecks: 10,
      });
      logger.info('Service Discovery Agent started - auto-registering Nexus services');
    } catch (error: any) {
      logger.warn('Service Discovery Agent failed to start (non-critical):', error.message);
    }

    // Initialize database schema
    const dbInitializer = new DatabaseInitializer(this.postgresPool);
    await dbInitializer.initialize();
    logger.info('Database schema initialized');

    // Initialize Qdrant collections
    await this.initializeQdrantCollections();

    const port = config.port || 8090;

    this.server.listen(port, () => {
      logger.info('Unified GraphRAG API server started', { port });
      logger.info('Features enabled: Documents, Memories, Unified Search');
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully');
      this.server.close(() => {
        logger.info('HTTP server closed');
      });

      // Stop Discovery Agent
      if (this.discoveryAgent) {
        this.discoveryAgent.stop();
        logger.info('Service Discovery Agent stopped');
      }

      await this.storageEngine.shutdown();
      await this.neo4jDriver.close();
      await this.postgresPool.end();
      await this.redisClient.quit();

      process.exit(0);
    });
  }

  private async initializeQdrantCollections() {
    try {
      const collections = ['documents', 'memories', 'document_summaries'];

      for (const collectionName of collections) {
        try {
          await this.qdrantClient.getCollection(collectionName);
          logger.info(`Collection ${collectionName} already exists`);
        } catch (error) {
          // Collection doesn't exist, create it with optimized settings
          await this.qdrantClient.createCollection(collectionName, {
            vectors: {
              size: 1024, // Voyage-2 embedding size
              distance: 'Cosine'
            },
            optimizers_config: {
              deleted_threshold: 0.2,
              vacuum_min_vector_number: 100,
              default_segment_number: 1,
              indexing_threshold: 100,  // Index with as few as 100 vectors
              flush_interval_sec: 1,
              max_optimization_threads: 2
            },
            hnsw_config: {
              m: 16,
              ef_construct: 100,
              full_scan_threshold: 100,  // Use index for all searches
              on_disk: false  // Keep in memory for small collections
            },
            wal_config: {
              wal_capacity_mb: 32,
              wal_segments_ahead: 0
            }
          });
          logger.info(`Created collection ${collectionName} with optimized settings`);

          // Immediately optimize the collection after creation
          const qdrantOptimizer = new QdrantOptimizer(this.qdrantClient);
          await qdrantOptimizer.optimizeCollection(collectionName, {
            forceIndexing: true,
            indexingThreshold: 100,
            fullScanThreshold: 100
          });
        }
      }
    } catch (error) {
      logger.warn('Qdrant collections initialization failed (Qdrant may be unavailable)', error);
    }
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Start the server if this file is run directly
if (require.main === module) {
  const api = new GraphRAGAPI();
  api.start().catch(error => {
    logger.error('Failed to start server', { error });
    process.exit(1);
  });
}
