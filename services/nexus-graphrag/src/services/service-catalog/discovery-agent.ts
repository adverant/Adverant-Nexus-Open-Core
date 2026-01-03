/**
 * Service Discovery Agent
 *
 * Automatically discovers and registers services in the Living Service Knowledge Graph.
 * Runs on a schedule to keep the catalog up-to-date with:
 * - Service availability (health checks)
 * - New service registrations
 * - Service deregistrations
 * - Performance metrics
 */

import { Pool } from 'pg';
import {
  ServiceStatus,
  ServiceRegistrationRequest,
  HealthCheckResult,
  KnownServiceDefinition,
} from './types.js';
import { ServiceCatalogRepository } from './service-catalog-repository.js';

// ============================================================================
// KNOWN SERVICE DEFINITIONS
// ============================================================================

/**
 * Pre-defined service definitions for the Nexus ecosystem.
 * These provide rich metadata about each service's capabilities.
 */
const KNOWN_SERVICES: KnownServiceDefinition[] = [
  // -------------------------------------------------------------------------
  // AI/ML Orchestration Services
  // -------------------------------------------------------------------------
  {
    name: 'nexus-gateway',
    version: '1.0.0',
    description: 'API Gateway and WebSocket entry point for the Nexus platform. Handles routing, authentication passthrough, and real-time chat orchestration.',
    baseUrl: process.env.GATEWAY_URL || 'http://nexus-gateway:9080',
    healthEndpoint: '/health',
    protocols: ['rest', 'websocket'],
    authRequired: true,
    capabilities: [
      {
        name: 'chat_orchestration',
        description: 'Orchestrates complex chat workflows across multiple services with intelligent routing',
        queryPatterns: ['chat', 'message', 'conversation', 'talk to', 'ask'],
        inputTypes: ['text', 'document_reference', 'image_reference'],
        outputTypes: ['text', 'streaming_text', 'artifact'],
        endpoint: '/api/chat/messages',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 500, avgMs: 3000, maxMs: 30000 },
      },
      {
        name: 'websocket_streaming',
        description: 'Real-time bidirectional communication for streaming responses',
        queryPatterns: ['stream', 'real-time', 'live'],
        inputTypes: ['websocket_message'],
        outputTypes: ['streaming_text', 'events'],
        endpoint: '/ws',
        method: 'WEBSOCKET',
        costTier: 'standard',
        estimatedDuration: { minMs: 100, avgMs: 500, maxMs: 5000 },
      },
    ],
    tags: ['gateway', 'orchestration', 'websocket', 'core'],
  },

  {
    name: 'nexus-graphrag',
    version: '2.0.0',
    description: 'Graph-based Retrieval Augmented Generation service. Provides knowledge storage, semantic search, entity management, and the Living Service Catalog.',
    baseUrl: process.env.GRAPHRAG_URL || 'http://nexus-graphrag:9050',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'semantic_search',
        description: 'Search knowledge base using natural language queries with vector similarity',
        queryPatterns: ['search', 'find', 'look up', 'what do you know about', 'recall'],
        inputTypes: ['text', 'query'],
        outputTypes: ['search_results', 'entities'],
        endpoint: '/api/v1/search',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 100, avgMs: 500, maxMs: 2000 },
      },
      {
        name: 'knowledge_ingest',
        description: 'Ingest and index documents, entities, and relationships into the knowledge graph',
        queryPatterns: ['store', 'remember', 'save', 'index', 'learn'],
        inputTypes: ['text', 'document', 'entity'],
        outputTypes: ['entity_id', 'confirmation'],
        endpoint: '/api/v1/entities',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 200, avgMs: 1000, maxMs: 5000 },
      },
      {
        name: 'graph_query',
        description: 'Query relationships and patterns in the knowledge graph',
        queryPatterns: ['related to', 'connected', 'relationship', 'graph', 'link'],
        inputTypes: ['cypher_query', 'entity_id'],
        outputTypes: ['graph_results', 'entities'],
        endpoint: '/api/v1/graph/query',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 50, avgMs: 300, maxMs: 2000 },
      },
      {
        name: 'service_catalog',
        description: 'Living Service Knowledge Graph - query available services and their capabilities',
        queryPatterns: ['what services', 'available capabilities', 'how to use'],
        inputTypes: ['text', 'capability_query'],
        outputTypes: ['service_list', 'capability_match'],
        endpoint: '/api/v1/service-catalog/query',
        method: 'POST',
        costTier: 'free',
        estimatedDuration: { minMs: 20, avgMs: 100, maxMs: 500 },
      },
    ],
    tags: ['rag', 'knowledge', 'search', 'graph', 'core'],
  },

  {
    name: 'nexus-mageagent',
    version: '1.0.0',
    description: 'Multi-agent orchestration system with 50+ specialized AI agents. Supports consensus-based decision making and parallel agent execution.',
    baseUrl: process.env.MAGEAGENT_URL || 'http://nexus-mageagent:9060',
    healthEndpoint: '/health',
    protocols: ['rest', 'websocket'],
    authRequired: true,
    capabilities: [
      {
        name: 'multi_agent_task',
        description: 'Execute complex tasks using multiple specialized AI agents with consensus',
        queryPatterns: ['analyze', 'research', 'investigate', 'comprehensive', 'expert'],
        inputTypes: ['text', 'task_definition'],
        outputTypes: ['analysis_report', 'consensus_result'],
        endpoint: '/api/v1/agents/execute',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 5000, avgMs: 30000, maxMs: 180000 },
      },
      {
        name: 'workflow_routing',
        description: 'Parse natural language into structured workflow steps and service calls',
        queryPatterns: ['plan', 'workflow', 'steps', 'process'],
        inputTypes: ['text', 'workflow_request'],
        outputTypes: ['workflow_plan', 'execution_steps'],
        endpoint: '/api/v1/workflow/parse',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 1000, avgMs: 3000, maxMs: 10000 },
      },
    ],
    tags: ['agents', 'orchestration', 'ai', 'workflow'],
  },

  {
    name: 'nexus-sandbox',
    version: '1.0.0',
    description: 'Secure code execution environment with 37+ templates. Supports Python, Node.js, and GPU workloads with <150ms cold start.',
    baseUrl: process.env.SANDBOX_URL || 'http://nexus-sandbox:9070',
    healthEndpoint: '/health',
    protocols: ['rest', 'websocket'],
    authRequired: true,
    capabilities: [
      {
        name: 'code_execution',
        description: 'Execute code in isolated sandbox environments with multiple language support',
        queryPatterns: ['run code', 'execute', 'python', 'javascript', 'compute', 'calculate'],
        inputTypes: ['code', 'script', 'notebook'],
        outputTypes: ['execution_result', 'stdout', 'files'],
        endpoint: '/api/v1/sandbox/execute',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 150, avgMs: 2000, maxMs: 60000 },
      },
      {
        name: 'app_generation',
        description: 'Generate and deploy web applications from natural language descriptions',
        queryPatterns: ['build app', 'create application', 'generate website', 'make dashboard'],
        inputTypes: ['text', 'specification'],
        outputTypes: ['application_url', 'source_code'],
        endpoint: '/api/v1/sandbox/generate',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 10000, avgMs: 60000, maxMs: 300000 },
      },
    ],
    tags: ['sandbox', 'code', 'execution', 'compute'],
  },

  {
    name: 'nexus-learningagent',
    version: '1.0.0',
    description: 'Parallel search and research agent with 25+ specialized sub-agents for web research, discovery, and knowledge synthesis.',
    baseUrl: process.env.LEARNINGAGENT_URL || 'http://nexus-learningagent:9085',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'web_research',
        description: 'Perform comprehensive web research using parallel search agents',
        queryPatterns: ['research', 'search the web', 'find information', 'look up online', 'google'],
        inputTypes: ['text', 'research_query'],
        outputTypes: ['research_report', 'sources'],
        endpoint: '/api/v1/research',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 5000, avgMs: 30000, maxMs: 120000 },
      },
      {
        name: 'knowledge_discovery',
        description: 'Discover and synthesize knowledge from multiple sources',
        queryPatterns: ['discover', 'explore', 'learn about', 'deep dive'],
        inputTypes: ['text', 'topic'],
        outputTypes: ['knowledge_graph', 'summary'],
        endpoint: '/api/v1/discover',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 10000, avgMs: 60000, maxMs: 300000 },
      },
    ],
    tags: ['research', 'search', 'learning', 'discovery'],
  },

  // -------------------------------------------------------------------------
  // Document/Media Processing Services
  // -------------------------------------------------------------------------
  {
    name: 'nexus-fileprocess',
    version: '1.0.0',
    description: '8-step document processing pipeline supporting 1GB+ files with multi-tier OCR, table extraction, and intelligent chunking.',
    baseUrl: process.env.FILEPROCESS_URL || 'http://nexus-fileprocess:9075',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'document_extraction',
        description: 'Extract text, tables, and structured data from documents (PDF, DOCX, XLSX, etc.)',
        queryPatterns: ['extract', 'parse document', 'read pdf', 'process file', 'ocr'],
        inputTypes: ['pdf', 'docx', 'xlsx', 'pptx', 'image'],
        outputTypes: ['text', 'structured_data', 'tables'],
        endpoint: '/api/v1/process',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 1000, avgMs: 10000, maxMs: 120000 },
      },
      {
        name: 'large_file_upload',
        description: 'Handle large file uploads (1GB+) with chunked transfer and Google Drive integration',
        queryPatterns: ['upload large file', 'big document', 'bulk upload'],
        inputTypes: ['file_chunk', 'file_reference'],
        outputTypes: ['upload_status', 'file_id'],
        endpoint: '/api/v1/upload',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 5000, avgMs: 60000, maxMs: 600000 },
      },
    ],
    tags: ['document', 'processing', 'ocr', 'extraction'],
  },

  {
    name: 'nexus-videoagent',
    version: '1.0.0',
    description: 'Video processing service with YouTube download, transcription, scene detection, and content analysis.',
    baseUrl: process.env.VIDEOAGENT_URL || 'http://nexus-videoagent:9095',
    healthEndpoint: '/health',
    protocols: ['rest', 'websocket'],
    authRequired: true,
    capabilities: [
      {
        name: 'youtube_download',
        description: 'Download videos from YouTube with quality selection and format conversion',
        queryPatterns: ['download youtube', 'get video', 'youtube url', 'fetch video'],
        inputTypes: ['youtube_url'],
        outputTypes: ['video_file', 'audio_file', 'metadata'],
        endpoint: '/api/v1/youtube/download',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 5000, avgMs: 30000, maxMs: 300000 },
      },
      {
        name: 'video_transcription',
        description: 'Transcribe video/audio content with timestamps and speaker detection',
        queryPatterns: ['transcribe', 'transcript', 'subtitles', 'captions', 'speech to text'],
        inputTypes: ['video_file', 'audio_file', 'youtube_url'],
        outputTypes: ['transcript', 'vtt', 'srt'],
        endpoint: '/api/v1/transcribe',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 10000, avgMs: 60000, maxMs: 600000 },
      },
      {
        name: 'scene_detection',
        description: 'Detect and analyze scenes in video content with visual descriptions',
        queryPatterns: ['scene detection', 'video analysis', 'what happens in video'],
        inputTypes: ['video_file', 'youtube_url'],
        outputTypes: ['scenes', 'thumbnails', 'timeline'],
        endpoint: '/api/v1/analyze/scenes',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 30000, avgMs: 120000, maxMs: 600000 },
      },
    ],
    tags: ['video', 'audio', 'transcription', 'youtube'],
  },

  // -------------------------------------------------------------------------
  // Specialized Domain Services
  // -------------------------------------------------------------------------
  {
    name: 'nexus-geoagent',
    version: '1.0.0',
    description: 'Geospatial processing service with PostGIS, H3, LiDAR, SAR, thermal imaging, and Google Earth Engine integration.',
    baseUrl: process.env.GEOAGENT_URL || 'http://nexus-geoagent:9090',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'lidar_processing',
        description: 'Process LiDAR point clouds for DEM/DSM/CHM generation, building extraction, and vegetation analysis',
        queryPatterns: ['lidar', 'point cloud', 'las file', 'elevation model', '3d terrain'],
        inputTypes: ['las', 'laz', 'point_cloud'],
        outputTypes: ['dem', 'dsm', 'chm', 'geotiff', 'mesh'],
        endpoint: '/api/v1/lidar/process',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 30000, avgMs: 300000, maxMs: 1800000 },
      },
      {
        name: 'satellite_imagery',
        description: 'Access and analyze satellite imagery via Google Earth Engine',
        queryPatterns: ['satellite', 'earth engine', 'imagery', 'remote sensing', 'aerial'],
        inputTypes: ['coordinates', 'region', 'date_range'],
        outputTypes: ['geotiff', 'analysis_result', 'time_series'],
        endpoint: '/api/v1/satellite/analyze',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 10000, avgMs: 60000, maxMs: 300000 },
      },
      {
        name: 'geospatial_analysis',
        description: 'Perform spatial analysis with PostGIS and H3 hexagonal indexing',
        queryPatterns: ['spatial analysis', 'geography', 'mapping', 'h3', 'location'],
        inputTypes: ['geojson', 'coordinates', 'shapefile'],
        outputTypes: ['geojson', 'analysis_result', 'h3_indices'],
        endpoint: '/api/v1/spatial/analyze',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 1000, avgMs: 5000, maxMs: 60000 },
      },
    ],
    tags: ['geospatial', 'lidar', 'satellite', 'gis', 'mapping'],
  },

  {
    name: 'nexus-cyberagent',
    version: '1.0.0',
    description: 'Security analysis service with vulnerability scanning, malware detection, secret detection, and compliance checking.',
    baseUrl: process.env.CYBERAGENT_URL || 'http://nexus-cyberagent:9092',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'vulnerability_scan',
        description: 'Scan code and dependencies for security vulnerabilities (SAST/DAST)',
        queryPatterns: ['security scan', 'vulnerability', 'cve', 'security audit', 'sast'],
        inputTypes: ['code', 'repository_url', 'dependencies'],
        outputTypes: ['vulnerability_report', 'remediation_steps'],
        endpoint: '/api/v1/scan/vulnerabilities',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 10000, avgMs: 60000, maxMs: 300000 },
      },
      {
        name: 'secret_detection',
        description: 'Detect exposed secrets, API keys, and credentials in code',
        queryPatterns: ['find secrets', 'api keys', 'credentials', 'exposed passwords'],
        inputTypes: ['code', 'repository_url'],
        outputTypes: ['secrets_report', 'locations'],
        endpoint: '/api/v1/scan/secrets',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 5000, avgMs: 30000, maxMs: 120000 },
      },
    ],
    tags: ['security', 'vulnerability', 'compliance', 'scanning'],
  },

  {
    name: 'nexus-law',
    version: '1.0.0',
    description: 'Legal document analysis service with contract review, risk assessment, clause identification, and regulatory compliance.',
    baseUrl: process.env.LAW_URL || 'http://nexus-law:9093',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'contract_review',
        description: 'Review legal contracts for risks, unusual clauses, and compliance issues',
        queryPatterns: ['review contract', 'legal analysis', 'contract risk', 'clause review'],
        inputTypes: ['pdf', 'docx', 'text'],
        outputTypes: ['risk_assessment', 'clause_analysis', 'recommendations'],
        endpoint: '/api/v1/contracts/review',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 10000, avgMs: 60000, maxMs: 300000 },
      },
      {
        name: 'compliance_check',
        description: 'Check documents against regulatory compliance requirements (GDPR, HIPAA, etc.)',
        queryPatterns: ['compliance', 'gdpr', 'hipaa', 'regulatory', 'legal compliance'],
        inputTypes: ['document', 'text'],
        outputTypes: ['compliance_report', 'violations', 'remediation'],
        endpoint: '/api/v1/compliance/check',
        method: 'POST',
        costTier: 'premium',
        estimatedDuration: { minMs: 5000, avgMs: 30000, maxMs: 120000 },
      },
    ],
    tags: ['legal', 'contracts', 'compliance', 'risk'],
  },

  {
    name: 'nexus-computer-vision',
    version: '1.0.0',
    description: 'Computer vision service with object detection, OCR, image analysis, and visual classification.',
    baseUrl: process.env.COMPUTER_VISION_URL || 'http://nexus-computer-vision:9094',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'object_detection',
        description: 'Detect and classify objects in images with bounding boxes',
        queryPatterns: ['detect objects', 'what is in image', 'identify', 'classify image'],
        inputTypes: ['image', 'video_frame'],
        outputTypes: ['detections', 'bounding_boxes', 'classifications'],
        endpoint: '/api/v1/detect',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 500, avgMs: 2000, maxMs: 10000 },
      },
      {
        name: 'image_ocr',
        description: 'Extract text from images with layout preservation',
        queryPatterns: ['read image', 'image text', 'ocr', 'extract from image'],
        inputTypes: ['image'],
        outputTypes: ['text', 'structured_text', 'layout'],
        endpoint: '/api/v1/ocr',
        method: 'POST',
        costTier: 'standard',
        estimatedDuration: { minMs: 1000, avgMs: 3000, maxMs: 15000 },
      },
    ],
    tags: ['vision', 'image', 'detection', 'ocr'],
  },

  // -------------------------------------------------------------------------
  // Core Infrastructure Services
  // -------------------------------------------------------------------------
  {
    name: 'nexus-auth',
    version: '1.0.0',
    description: 'Authentication and authorization service with OAuth2, JWT, API keys, and tenant isolation.',
    baseUrl: process.env.AUTH_URL || 'http://nexus-auth:9010',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: false,
    capabilities: [
      {
        name: 'authentication',
        description: 'Authenticate users via OAuth2, API keys, or JWT tokens',
        queryPatterns: ['login', 'authenticate', 'sign in', 'api key'],
        inputTypes: ['credentials', 'oauth_token', 'api_key'],
        outputTypes: ['jwt_token', 'session', 'user_info'],
        endpoint: '/api/v1/auth/login',
        method: 'POST',
        costTier: 'free',
        estimatedDuration: { minMs: 50, avgMs: 200, maxMs: 1000 },
      },
    ],
    tags: ['auth', 'security', 'oauth', 'core'],
  },

  {
    name: 'nexus-billing',
    version: '1.0.0',
    description: 'Usage tracking, metering, and cost allocation service.',
    baseUrl: process.env.BILLING_URL || 'http://nexus-billing:9011',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'usage_tracking',
        description: 'Track and meter API usage for billing purposes',
        queryPatterns: ['usage', 'billing', 'cost', 'consumption'],
        inputTypes: ['usage_event'],
        outputTypes: ['usage_summary', 'cost_breakdown'],
        endpoint: '/api/v1/usage/track',
        method: 'POST',
        costTier: 'free',
        estimatedDuration: { minMs: 10, avgMs: 50, maxMs: 200 },
      },
    ],
    tags: ['billing', 'usage', 'metering', 'core'],
  },

  {
    name: 'nexus-analytics',
    version: '1.0.0',
    description: 'Event tracking, metrics collection, and analytics dashboards.',
    baseUrl: process.env.ANALYTICS_URL || 'http://nexus-analytics:9012',
    healthEndpoint: '/health',
    protocols: ['rest'],
    authRequired: true,
    capabilities: [
      {
        name: 'event_tracking',
        description: 'Track custom events for analytics and monitoring',
        queryPatterns: ['track event', 'analytics', 'metrics', 'monitoring'],
        inputTypes: ['event'],
        outputTypes: ['confirmation'],
        endpoint: '/api/v1/events',
        method: 'POST',
        costTier: 'free',
        estimatedDuration: { minMs: 5, avgMs: 20, maxMs: 100 },
      },
    ],
    tags: ['analytics', 'events', 'metrics', 'core'],
  },
];

// ============================================================================
// DISCOVERY AGENT
// ============================================================================

export interface DiscoveryAgentConfig {
  pollIntervalMs: number;
  healthCheckTimeoutMs: number;
  maxConcurrentChecks: number;
  enableKubernetesDiscovery: boolean;
}

const DEFAULT_CONFIG: DiscoveryAgentConfig = {
  pollIntervalMs: 60000, // 1 minute
  healthCheckTimeoutMs: 5000, // 5 seconds
  maxConcurrentChecks: 10,
  enableKubernetesDiscovery: process.env.KUBERNETES_SERVICE_HOST !== undefined,
};

/**
 * Service Discovery Agent
 *
 * Automatically discovers and registers services in the Living Service Catalog.
 */
export class ServiceDiscoveryAgent {
  private repository: ServiceCatalogRepository;
  private config: DiscoveryAgentConfig;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  // Track registered services
  private registeredServices: Map<string, string> = new Map(); // name -> id

  constructor(repository: ServiceCatalogRepository, config?: Partial<DiscoveryAgentConfig>) {
    this.repository = repository;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the discovery agent
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[DiscoveryAgent] Already running');
      return;
    }

    console.log('[DiscoveryAgent] Starting service discovery...');
    this.isRunning = true;

    // Run initial discovery
    await this.runDiscovery();

    // Schedule periodic discovery
    this.pollTimer = setInterval(
      () => this.runDiscovery().catch(console.error),
      this.config.pollIntervalMs
    );

    console.log(`[DiscoveryAgent] Running with ${this.config.pollIntervalMs}ms poll interval`);
  }

  /**
   * Stop the discovery agent
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    console.log('[DiscoveryAgent] Stopped');
  }

  /**
   * Run a full discovery cycle
   */
  async runDiscovery(): Promise<void> {
    console.log('[DiscoveryAgent] Running discovery cycle...');

    // 1. Register known services
    await this.registerKnownServices();

    // 2. Health check all registered services
    await this.healthCheckServices();

    // 3. If K8s discovery enabled, discover additional services
    if (this.config.enableKubernetesDiscovery) {
      await this.discoverKubernetesServices();
    }

    console.log(`[DiscoveryAgent] Discovery complete. ${this.registeredServices.size} services tracked.`);
  }

  /**
   * Register all known service definitions
   */
  private async registerKnownServices(): Promise<void> {
    const batchSize = this.config.maxConcurrentChecks;

    for (let i = 0; i < KNOWN_SERVICES.length; i += batchSize) {
      const batch = KNOWN_SERVICES.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (serviceDef) => {
          try {
            await this.registerService(serviceDef);
          } catch (error) {
            console.error(`[DiscoveryAgent] Failed to register ${serviceDef.name}:`, error);
          }
        })
      );
    }
  }

  /**
   * Register a single service
   */
  private async registerService(serviceDef: KnownServiceDefinition): Promise<void> {
    // Check if already registered
    const existing = await this.repository.getServiceByName(serviceDef.name);

    if (existing) {
      this.registeredServices.set(serviceDef.name, existing.id);
      return;
    }

    // Build registration request
    const request: ServiceRegistrationRequest = {
      name: serviceDef.name,
      version: serviceDef.version,
      description: serviceDef.description,
      endpoints: {
        base: serviceDef.baseUrl,
        health: serviceDef.healthEndpoint,
        websocket: serviceDef.websocketEndpoint,
      },
      capabilities: serviceDef.capabilities,
      protocols: serviceDef.protocols,
      authRequired: serviceDef.authRequired,
      rateLimits: serviceDef.rateLimits,
      dependencies: serviceDef.dependencies,
      tags: serviceDef.tags,
    };

    // Register service
    const service = await this.repository.registerService(request);
    this.registeredServices.set(serviceDef.name, service.id);

    console.log(`[DiscoveryAgent] Registered service: ${serviceDef.name}`);
  }

  /**
   * Health check all registered services
   */
  private async healthCheckServices(): Promise<void> {
    const serviceNames = Array.from(this.registeredServices.keys());
    const batchSize = this.config.maxConcurrentChecks;

    for (let i = 0; i < serviceNames.length; i += batchSize) {
      const batch = serviceNames.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (serviceName) => {
          try {
            await this.healthCheckService(serviceName);
          } catch (error) {
            console.error(`[DiscoveryAgent] Health check failed for ${serviceName}:`, error);
          }
        })
      );
    }
  }

  /**
   * Health check a single service
   */
  private async healthCheckService(serviceName: string): Promise<HealthCheckResult> {
    const serviceDef = KNOWN_SERVICES.find(s => s.name === serviceName);
    if (!serviceDef) {
      return { healthy: false, status: 'offline', latencyMs: 0 };
    }

    const serviceId = this.registeredServices.get(serviceName);
    if (!serviceId) {
      return { healthy: false, status: 'offline', latencyMs: 0 };
    }

    const healthUrl = `${serviceDef.baseUrl}${serviceDef.healthEndpoint}`;
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.healthCheckTimeoutMs
      );

      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const latencyMs = Date.now() - startTime;
      const healthy = response.ok;
      const status: ServiceStatus = healthy ? 'active' : 'degraded';

      // Update service status in repository
      await this.repository.updateServiceStatus(serviceId, status);

      return { healthy, status, latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;

      // Mark service as offline
      await this.repository.updateServiceStatus(serviceId, 'offline');

      return { healthy: false, status: 'offline', latencyMs };
    }
  }

  /**
   * Discover services from Kubernetes API
   */
  private async discoverKubernetesServices(): Promise<void> {
    // Only run if in Kubernetes environment
    if (!process.env.KUBERNETES_SERVICE_HOST) {
      return;
    }

    try {
      // Use Kubernetes service account token for authentication
      const token = await this.getKubernetesToken();
      const namespace = process.env.POD_NAMESPACE || 'nexus';
      const k8sApiUrl = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;

      const response = await fetch(
        `${k8sApiUrl}/api/v1/namespaces/${namespace}/services`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        console.warn('[DiscoveryAgent] Failed to query Kubernetes API:', response.statusText);
        return;
      }

      const data = await response.json() as { items: Array<{ metadata: { name: string }; spec: { ports: Array<{ port: number }> } }> };

      // Look for services not in our known list
      for (const svc of data.items) {
        const serviceName = svc.metadata.name;

        // Skip if already known
        if (KNOWN_SERVICES.some(ks => ks.name === serviceName)) {
          continue;
        }

        // Skip non-nexus services
        if (!serviceName.startsWith('nexus-')) {
          continue;
        }

        console.log(`[DiscoveryAgent] Found unknown K8s service: ${serviceName}`);

        // Could auto-register with basic capabilities
        // For now, just log it
      }
    } catch (error) {
      console.warn('[DiscoveryAgent] Kubernetes discovery failed:', error);
    }
  }

  /**
   * Get Kubernetes service account token
   */
  private async getKubernetesToken(): Promise<string> {
    try {
      // Read token from mounted secret
      const fs = await import('fs/promises');
      const token = await fs.readFile(
        '/var/run/secrets/kubernetes.io/serviceaccount/token',
        'utf-8'
      );
      return token.trim();
    } catch {
      throw new Error('Could not read Kubernetes service account token');
    }
  }

  /**
   * Manually trigger a service health check
   */
  async checkService(serviceName: string): Promise<HealthCheckResult> {
    return this.healthCheckService(serviceName);
  }

  /**
   * Get all tracked services
   */
  getTrackedServices(): Map<string, string> {
    return new Map(this.registeredServices);
  }

  /**
   * Get known service definitions
   */
  static getKnownServices(): KnownServiceDefinition[] {
    return [...KNOWN_SERVICES];
  }
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create and start a discovery agent
 */
export async function createDiscoveryAgent(
  repository: ServiceCatalogRepository,
  config?: Partial<DiscoveryAgentConfig>
): Promise<ServiceDiscoveryAgent> {
  const agent = new ServiceDiscoveryAgent(repository, config);
  await agent.start();
  return agent;
}
